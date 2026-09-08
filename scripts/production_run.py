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
from portfolio import save_positions_state, update_performance_state
from utils import STATE_DIR, save_json

PRODUCTION_STATE = STATE_DIR / "production" / "last_run.json"
BLOCKING_ACTIONS = frozenset({"ABORT", "ERROR"})


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
        if str(record.get("action", "")).upper() in BLOCKING_ACTIONS
    ]
    entry_gate = result.get("entry_gate", {})
    is_live = bool(resolved is not None and resolved.is_live)
    return {
        "schema_version": 1,
        "kind": "v11_live_production_run" if is_live else "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": _release_sha(),
        "strategy_version": "v11-adaptive-momentum",
        "status": "PASS" if not blocking else "DEGRADED",
        "paper_only": not is_live,
        "broker_mode": resolved.mode if resolved is not None else "unknown",
        "market_entry_allowed": bool(entry_gate.get("allowed", False)),
        "risk_tier": result.get("risk_tier"),
        "action_counts": dict(sorted(action_counts.items())),
        "blocking_actions": blocking,
    }


def _failed_summary(
    exc: BaseException, resolved: BrokerMode | None = None
) -> dict[str, Any]:
    is_live = bool(resolved is not None and resolved.is_live)
    return {
        "schema_version": 1,
        "kind": "v11_live_production_run" if is_live else "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": _release_sha(),
        "strategy_version": "v11-adaptive-momentum",
        "status": "FAIL",
        "paper_only": not is_live,
        "broker_mode": resolved.mode if resolved is not None else "unknown",
        "failure_type": type(exc).__name__,
    }


def main() -> int:
    """Execute once, persist broker-derived state, and expose partial failure."""

    resolved: BrokerMode | None = None
    try:
        # Resolve first so a failure before the run still records which broker
        # was being asked for, and so a live run announces itself in the log
        # before it can place anything.
        resolved = require_trading_mode()
        if resolved.is_live:
            print(f"*** LIVE REAL-MONEY CYCLE *** {resolved.describe()}", flush=True)
        result = run_execution(dry_run=False)
        save_positions_state()
        update_performance_state()
        summary = summarize_execution(result, resolved)
    except BaseException as exc:
        summary = _failed_summary(exc, resolved)
        save_json(PRODUCTION_STATE, summary)
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 1

    save_json(PRODUCTION_STATE, summary)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
