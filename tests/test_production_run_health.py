"""A broker reconciliation failure must not become a successful workflow."""

import pytest

import production_run
from broker_mode import resolve_broker_mode


@pytest.mark.parametrize(
    "action",
    [
        "ABORT",
        "ERROR",
        "ABORT_OPEN_ORDER_RECONCILIATION",
        "ABORT_INVALID_PENDING_PLAN",
        "ABORT_INVALID_RISK_OFF_LATCH",
        "ERROR_CANCEL_ORDER",
        " abort_invalid_pending_plan ",
    ],
)
def test_qualified_failures_degrade_the_summary(action):
    summary = production_run.summarize_execution({
        "entry_gate": {"allowed": True},
        "buys": [{"action": action, "symbol": "AAA", "reason": "private"}],
    })
    assert summary["status"] == "DEGRADED"
    assert summary["blocking_actions"] == [{"action": action, "symbol": "AAA"}]
    assert "private" not in str(summary)


@pytest.mark.parametrize(
    "action",
    ["ADAPTIVE_REBALANCE_COMPLETE", "REBALANCE_PENDING_CANCELLATIONS", "ADAPTIVE_BUY"],
)
def test_ordinary_actions_are_not_misclassified_as_errors(action):
    assert not production_run.is_blocking_action(action)


def test_prefixed_abort_makes_runner_exit_nonzero_and_persists_failure(monkeypatch):
    saved = []
    # No client construction or credential access is needed for this failure.
    monkeypatch.setattr(production_run, "require_trading_mode", lambda: resolve_broker_mode({}))
    monkeypatch.setattr(production_run, "run_execution", lambda **kw: {
        "buys": [{"action": "ABORT_OPEN_ORDER_RECONCILIATION"}],
    })
    monkeypatch.setattr(production_run, "save_positions_state", lambda: None)
    monkeypatch.setattr(production_run, "update_performance_state", lambda: None)
    monkeypatch.setattr(production_run, "save_json", lambda path, value: saved.append(value))
    assert production_run.main() == 1
    assert saved[-1]["status"] == "DEGRADED"
