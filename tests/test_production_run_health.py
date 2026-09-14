"""A broker reconciliation failure must not become a successful workflow."""

import production_run
import pytest
from broker_mode import resolve_broker_mode
from runtime_generation import cycle_outcome


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
    summary = production_run.summarize_execution(
        {
            "entry_gate": {"allowed": True},
            "buys": [{"action": action, "symbol": "AAA", "reason": "private"}],
        }
    )
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
    monkeypatch.setattr(
        production_run, "require_trading_mode", lambda: resolve_broker_mode({})
    )
    monkeypatch.setattr(
        production_run,
        "run_execution",
        lambda **kw: {
            "buys": [{"action": "ABORT_OPEN_ORDER_RECONCILIATION"}],
        },
    )
    monkeypatch.setattr(production_run, "capture_portfolio_snapshot", lambda: ({}, {}))

    def publish(path, performance, positions, value, **kwargs):
        saved.append(value)
        return value

    monkeypatch.setattr(production_run, "publish_runtime_generation", publish)
    assert production_run.main() == 1
    assert saved[-1]["status"] == "DEGRADED"


@pytest.mark.parametrize(
    "state,reason,health",
    [
        ("completed", "rebalance_complete", "PASS"),
        ("idle", "no_rebalance_due", "PASS"),
        ("pending", "orders_pending", "PASS"),
        ("pending", "cancellation_pending", "PASS"),
        ("blocked", "exposure_gate_closed", "DEGRADED"),
        ("failed", "execution_exception", "FAIL"),
    ],
)
def test_health_is_separate_from_explicit_cycle_outcome(state, reason, health):
    summary = production_run.summarize_execution(
        {
            "cycle_outcome": cycle_outcome(state, reason),
            "entry_gate": {"allowed": True},
            "risk_tier": "NORMAL",
        }
    )
    assert summary["status"] == health
    assert summary["cycle_outcome"] == cycle_outcome(state, reason)


@pytest.mark.parametrize(
    "actions",
    [
        [],
        [{"action": "ADAPTIVE_REBALANCE_COMPLETE"}],
        [{"action": "ADAPTIVE_REBALANCE_COMPLETE"}] * 2,
        [{"action": "ADAPTIVE_BUY"}],
    ],
)
def test_no_terminal_count_heuristic_can_manufacture_completion(actions):
    summary = production_run.summarize_execution({"momentum_picks": actions})
    assert summary["status"] == "DEGRADED"
    assert summary["cycle_outcome"] == cycle_outcome("blocked", "execution_incomplete")


def test_error_overrides_pending_outcome_without_exposing_exception_text():
    summary = production_run.summarize_execution(
        {
            "cycle_outcome": cycle_outcome("pending", "orders_pending"),
            "momentum_picks": [{"action": "ERROR_CANCEL", "reason": "private data"}],
        }
    )
    assert summary["status"] == "DEGRADED"
    assert summary["cycle_outcome"] == cycle_outcome("blocked", "execution_error")
    assert "private data" not in str(summary)
