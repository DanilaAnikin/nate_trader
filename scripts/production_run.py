"""Guarded V11 paper-production runner with machine-readable health state."""

from __future__ import annotations

import json
import os
from collections import Counter
from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

from execute_trades import require_paper_trading_mode, run_execution
from portfolio import save_positions_state, update_performance_state
from utils import STATE_DIR, save_json

PRODUCTION_STATE = STATE_DIR / "production" / "last_run.json"

# Exact names that block. Kept for the two bare forms; the prefix rule below is
# what actually catches what the executor emits.
BLOCKING_ACTIONS = frozenset({"ABORT", "ERROR"})

# `execute_trades.py` does not emit a bare "ABORT". It emits
# ABORT_SHORT_RECONCILIATION, ABORT_OPEN_ORDER_RECONCILIATION,
# ABORT_CANCELLATION_CONFIRMATION, ABORT_INVALID_PENDING_PLAN and
# ABORT_INVALID_RISK_OFF_LATCH — none of which equals "ABORT", so the exact-set
# test matched none of them. A cycle that aborted on an unreconciled short
# therefore recorded `status: "PASS"` and exited 0, and the workflow reported a
# healthy run. `tests/test_production_run.py` enumerates every ABORT_* the
# executor can emit and requires each to block.
BLOCKING_ACTION_PREFIXES = ("ABORT", "ERROR")

# A V11 cycle that reached its own end says so. Without one of these the run
# stopped somewhere, whether or not it managed to name a reason, and "no
# blocking action was recorded" is not evidence that the work completed.
TERMINAL_SUCCESS_ACTIONS = frozenset(
    {
        "ADAPTIVE_REBALANCE_COMPLETE",
        "ADAPTIVE_PLAN_DEFERRED",
        "ADAPTIVE_DEFERRED_INFRASTRUCTURE_CANCELLATION",
    }
)


def is_blocking_action(action: str) -> bool:
    """True when an action name means the cycle stopped rather than finished."""

    name = action.strip().upper()
    if name in BLOCKING_ACTIONS:
        return True
    return any(
        name == prefix or name.startswith(f"{prefix}_")
        for prefix in BLOCKING_ACTION_PREFIXES
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


def summarize_execution(result: dict[str, Any]) -> dict[str, Any]:
    """Build a compact, secret-free status suitable for persistence."""

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
    # Occurrences, not names. `terminal` was a *set* of names, so a run that
    # recorded ADAPTIVE_REBALANCE_COMPLETE twice — or completed once and then
    # deferred as well — satisfied "a terminal action is present" with two
    # mutually exclusive endings in one record. A cycle finishes once.
    terminal = sorted(
        name for name in action_counts if name.upper() in TERMINAL_SUCCESS_ACTIONS
    )
    terminal_count = sum(
        count
        for name, count in action_counts.items()
        if name.upper() in TERMINAL_SUCCESS_ACTIONS
    )
    entry_gate = result.get("entry_gate", {})
    return {
        "schema_version": 1,
        "kind": "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": _release_sha(),
        "strategy_version": "v11-adaptive-momentum",
        # PASS requires both halves: nothing blocked, *and* the cycle reached
        # exactly one terminal state. Either alone is compatible with a run
        # that stopped silently part-way; two terminals is a record that says
        # the cycle ended twice.
        "status": "PASS" if not blocking and terminal_count == 1 else "DEGRADED",
        "terminal_actions": terminal,
        "terminal_action_count": terminal_count,
        "paper_only": True,
        "market_entry_allowed": bool(entry_gate.get("allowed", False)),
        "risk_tier": result.get("risk_tier"),
        "action_counts": dict(sorted(action_counts.items())),
        "blocking_actions": blocking,
    }


def _failed_summary(exc: BaseException) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "kind": "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": _release_sha(),
        "strategy_version": "v11-adaptive-momentum",
        "status": "FAIL",
        "paper_only": True,
        "failure_type": type(exc).__name__,
    }


def raise_workflow_incident(summary: dict[str, Any]) -> str:
    """Annotate the run and the job summary so a stopped cycle is visible.

    A non-zero exit already fails the job, but the reason is buried in stdout.
    The annotation puts the blocking actions on the run page itself, which is
    what an operator looks at first. Only action names and symbols are emitted;
    reasons stay in the private runtime state.
    """

    blocking = summary.get("blocking_actions") or []
    detail = ", ".join(
        f"{item.get('action')}({item.get('symbol')})" for item in blocking
    )
    headline = (
        f"V11 paper cycle did not complete: status={summary.get('status')}"
        f"{f'; blocked by {detail}' if detail else '; no single terminal completion recorded'}"
    )
    print(f"::error title=V11 paper production incident::{headline}")
    path = os.getenv("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"### V11 paper production incident\n\n{headline}\n")
    return headline


def main() -> int:
    """Execute once, persist broker-derived state, and expose partial failure."""

    try:
        require_paper_trading_mode()
        result = run_execution(dry_run=False)
        save_positions_state()
        update_performance_state()
        summary = summarize_execution(result)
    except BaseException as exc:
        summary = _failed_summary(exc)
        save_json(PRODUCTION_STATE, summary)
        print(json.dumps(summary, indent=2, sort_keys=True))
        raise_workflow_incident(summary)
        return 1

    save_json(PRODUCTION_STATE, summary)
    print(json.dumps(summary, indent=2, sort_keys=True))
    if summary["status"] == "PASS":
        return 0
    raise_workflow_incident(summary)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
