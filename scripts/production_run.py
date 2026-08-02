"""Guarded V11 paper-production runner with machine-readable health state."""

from __future__ import annotations

import json
import os
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Iterator

from execute_trades import require_paper_trading_mode, run_execution
from portfolio import save_positions_state, update_performance_state
from utils import STATE_DIR, save_json


PRODUCTION_STATE = STATE_DIR / "production" / "last_run.json"
BLOCKING_ACTIONS = frozenset({"ABORT", "ERROR"})


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
        if str(record.get("action", "")).upper() in BLOCKING_ACTIONS
    ]
    entry_gate = result.get("entry_gate", {})
    return {
        "schema_version": 1,
        "kind": "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": os.getenv("GITHUB_SHA", "local")[:40],
        "strategy_version": "v11-adaptive-momentum",
        "status": "PASS" if not blocking else "DEGRADED",
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
        "release_sha": os.getenv("GITHUB_SHA", "local")[:40],
        "strategy_version": "v11-adaptive-momentum",
        "status": "FAIL",
        "paper_only": True,
        "failure_type": type(exc).__name__,
    }


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
        return 1

    save_json(PRODUCTION_STATE, summary)
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0 if summary["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
