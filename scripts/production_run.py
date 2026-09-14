"""Guarded V11 production runner with machine-readable health state.

Handles both the paper forward-validation cycle and, when the operator has
configured every live condition, a real-money cycle. The persisted record names
which one actually ran: a consumer must never have to infer from silence
whether real money moved.
"""

from __future__ import annotations

import json
import os
from collections import Counter
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

from broker_mode import BrokerMode
from execute_trades import require_trading_mode, run_execution
from portfolio import capture_portfolio_snapshot
from runtime_generation import (
    CYCLE_HEALTH,
    RuntimeGenerationError,
    capture_execution_context,
    cycle_outcome,
    load_recovery_snapshots,
    publish_runtime_generation,
    validate_cycle_outcome,
)
from utils import STATE_DIR

PRODUCTION_STATE = STATE_DIR / "production" / "last_run.json"
BLOCKING_ACTIONS = frozenset({"ABORT", "ERROR"})


def is_blocking_action(action: str) -> bool:
    """Execution's qualified failures are failures too (e.g. ABORT_INVALID_PLAN)."""

    name = action.strip().upper()
    return any(
        name == prefix or name.startswith(f"{prefix}_") for prefix in BLOCKING_ACTIONS
    )


def _release_sha() -> str:
    """Return the externally approved immutable release, never the trigger SHA."""

    return os.getenv("APPROVED_RELEASE_SHA", os.getenv("GITHUB_SHA", "local"))[:40]


def iter_action_records(value: Any) -> Iterator[dict[str, Any]]:
    """Yield nested execution records containing an action field."""

    if isinstance(value, dict):
        if isinstance(value.get("action"), str):
            yield value
        for child in value.values():
            yield from iter_action_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_action_records(child)


def summarize_execution(
    result: dict[str, Any], resolved: BrokerMode | None = None
) -> dict[str, Any]:
    """Build a compact, secret-free status suitable for persistence.

    ``paper_only`` stays in the record and stays truthful. The paper workflow
    refuses to restore an artifact whose ``paper_only`` is not ``True``, which
    is exactly the property that keeps a live cycle's state from ever being
    replayed into the paper lineage — so it is computed, never asserted.
    """

    records = list(iter_action_records(result))
    action_counts = Counter(str(record["action"]) for record in records)
    blocking = [
        {
            "action": str(record.get("action")),
            "symbol": str(record.get("symbol", "V11")),
        }
        for record in records
        if is_blocking_action(str(record.get("action", "")))
    ]
    entry_gate = result.get("entry_gate", {})
    try:
        outcome = validate_cycle_outcome(result.get("cycle_outcome"))
    except RuntimeGenerationError:
        outcome = cycle_outcome("blocked", "execution_incomplete")
    risk_tier = result.get("risk_tier")
    if outcome["state"] in {"completed", "idle", "pending"} and risk_tier not in {
        "NORMAL",
        "CAUTIOUS",
        "HALT",
    }:
        outcome = cycle_outcome("blocked", "execution_incomplete")
    if blocking:
        outcome = cycle_outcome("blocked", "execution_error")
    is_live = bool(resolved is not None and resolved.is_live)
    return {
        "schema_version": 1,
        "kind": "v11_live_production_run" if is_live else "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": _release_sha(),
        "strategy_version": "v11-adaptive-momentum",
        "status": CYCLE_HEALTH[outcome["state"]],
        "cycle_outcome": outcome,
        "paper_only": not is_live,
        "broker_mode": resolved.mode if resolved is not None else "unknown",
        "market_entry_allowed": bool(entry_gate.get("allowed", False)),
        "risk_tier": risk_tier,
        "action_counts": dict(sorted(action_counts.items())),
        "blocking_actions": blocking,
    }


def _failed_summary(
    exc: BaseException,
    resolved: BrokerMode | None = None,
    *,
    reason: str = "execution_exception",
) -> dict[str, Any]:
    is_live = bool(resolved is not None and resolved.is_live)
    return {
        "schema_version": 1,
        "kind": "v11_live_production_run" if is_live else "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": _release_sha(),
        "strategy_version": "v11-adaptive-momentum",
        "status": "FAIL",
        "cycle_outcome": cycle_outcome("failed", reason),
        "paper_only": not is_live,
        "broker_mode": resolved.mode if resolved is not None else "unknown",
        "failure_type": type(exc).__name__,
        "risk_tier": None,
        "market_entry_allowed": False,
        "action_counts": {},
        "blocking_actions": [],
    }


def main() -> int:
    """Execute once and commit a verifiable generation, including failed attempts."""

    resolved: BrokerMode | None = None
    execution_context = None
    try:
        execution_context = capture_execution_context(_release_sha())
        # Resolve first so a failure before the run still records which broker
        # was being asked for, and so a live run announces itself in the log
        # before it can place anything.
        resolved = require_trading_mode()
        if resolved.is_live:
            print(f"*** LIVE REAL-MONEY CYCLE *** {resolved.describe()}", flush=True)
        result = run_execution(dry_run=False, persist_portfolio=False)
        summary = summarize_execution(result, resolved)
    except BaseException as exc:  # noqa: BLE001 - preserve failed/cancelled execution intent
        summary = _failed_summary(exc, resolved)
    if execution_context is None:
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 1

    snapshot_status = "fresh"
    try:
        # A rejected broker configuration must not cause a new credential read.
        if resolved is None:
            raise RuntimeGenerationError("broker_configuration_unavailable")
        performance, positions = capture_portfolio_snapshot()
    except BaseException as exc:  # noqa: BLE001 - failed snapshot must become recovery-only
        summary = _failed_summary(exc, resolved, reason="snapshot_unavailable")
        snapshot_status = "recovery"
        try:
            performance, positions = load_recovery_snapshots(STATE_DIR)
        except BaseException:  # noqa: BLE001 - never replace unreadable intent with a seed
            # Do not relabel absent/corrupt state as a new successful generation.
            # The workflow's current-run publication check will refuse old files.
            print(json.dumps(summary, indent=2, sort_keys=True))
            return 1
    try:
        summary = publish_runtime_generation(
            STATE_DIR,
            performance,
            positions,
            summary,
            snapshot_status=snapshot_status,
            execution_context=execution_context,
        )
    except BaseException as exc:  # noqa: BLE001 - interruption during multi-file publication
        summary = _failed_summary(exc, resolved, reason="publication_failed")
        try:
            # An interrupted pair may contain the latest durable order intent.
            # Preserve it explicitly as recovery-only, never restore older plans.
            performance, positions = load_recovery_snapshots(STATE_DIR)
            summary = publish_runtime_generation(
                STATE_DIR,
                performance,
                positions,
                summary,
                snapshot_status="recovery",
                execution_context=execution_context,
            )
        except BaseException:  # noqa: BLE001 - preserve private failure without raw exception text
            summary["runtime_publication"] = "unavailable"
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
