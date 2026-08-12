"""The producer's health summary must not call a stopped cycle a PASS.

`summarize_execution` classified a record as blocking only when its action was
exactly `ABORT` or exactly `ERROR`. The executor emits neither. Every real stop
carries a suffix — `ABORT_SHORT_RECONCILIATION` and friends — so the exact-set
test matched nothing, the summary said `PASS`, and the runner exited 0.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import production_run

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

# The executor and the broker layer are the only sources of action names that
# reach a production summary.
ACTION_SOURCES = ("execute_trades.py", "trade.py")


def emitted_blocking_actions() -> set[str]:
    """Every ABORT*/ERROR* action name literal the executor can emit.

    Read from source rather than hard-coded, so a newly added abort path shows
    up here on its own instead of quietly regaining PASS.
    """

    names: set[str] = set()
    for name in ACTION_SOURCES:
        text = (SCRIPTS / name).read_text(encoding="utf-8")
        names.update(re.findall(r'"((?:ABORT|ERROR)[A-Z_]*)"', text))
    return names


def test_executor_emits_only_prefixed_abort_actions():
    """Anchors the bug: not one emitted abort equals the bare string `ABORT`."""

    emitted = emitted_blocking_actions()
    assert emitted, "no ABORT_*/ERROR_* literals found — the scan is broken"
    suffixed = {name for name in emitted if name not in {"ABORT", "ERROR"}}
    assert suffixed >= {
        "ABORT_CANCELLATION_CONFIRMATION",
        "ABORT_INVALID_PENDING_PLAN",
        "ABORT_INVALID_RISK_OFF_LATCH",
        "ABORT_OPEN_ORDER_RECONCILIATION",
        "ABORT_SHORT_RECONCILIATION",
    }


@pytest.mark.parametrize("action", sorted(emitted_blocking_actions()))
def test_every_emitted_abort_action_blocks_and_fails_the_run(action):
    """Each real abort must be recorded as blocking and must not be a PASS."""

    summary = production_run.summarize_execution(
        {
            "risk_tier": "NORMAL",
            "entry_gate": {"allowed": True},
            "sells": [{"symbol": "AAA", "action": action, "reason": "private"}],
        }
    )

    assert production_run.is_blocking_action(action)
    assert summary["blocking_actions"] == [{"action": action, "symbol": "AAA"}]
    assert summary["status"] == "DEGRADED"
    assert "private" not in str(summary)


@pytest.mark.parametrize(
    "action",
    ["ABORT", "ERROR", "abort_short_reconciliation", " ERROR_FUTURE_CASE "],
)
def test_blocking_classification_is_case_and_prefix_insensitive(action):
    assert production_run.is_blocking_action(action)


@pytest.mark.parametrize(
    "action",
    ["ADAPTIVE_BUY", "HOLD", "SKIP", "ABORTED_BY_NOTHING", "ERRORLESS"],
)
def test_non_blocking_actions_are_not_misclassified(action):
    """The prefix rule matches a name boundary, not any string starting with it."""

    assert not production_run.is_blocking_action(action)


def test_pass_requires_a_positive_terminal_completion():
    """No blocker is not the same as finished."""

    stalled = production_run.summarize_execution(
        {
            "risk_tier": "NORMAL",
            "entry_gate": {"allowed": True},
            "buys": [{"symbol": "AAA", "action": "ADAPTIVE_BUY"}],
        }
    )
    assert stalled["status"] == "DEGRADED"
    assert stalled["terminal_actions"] == []

    completed = production_run.summarize_execution(
        {
            "risk_tier": "NORMAL",
            "entry_gate": {"allowed": True},
            "buys": [{"symbol": "AAA", "action": "ADAPTIVE_BUY"}],
            "summary": {"action": "ADAPTIVE_REBALANCE_COMPLETE"},
        }
    )
    assert completed["status"] == "PASS"
    assert completed["terminal_actions"] == ["ADAPTIVE_REBALANCE_COMPLETE"]


def test_pass_requires_exactly_one_terminal_occurrence():
    """A cycle finishes once. Two endings in one record is not one ending."""

    # The same terminal twice. `terminal` was a set of *names*, so this
    # satisfied "a terminal action is present" — a record claiming the cycle
    # completed, then completed again.
    duplicated = production_run.summarize_execution(
        {
            "risk_tier": "NORMAL",
            "entry_gate": {"allowed": True},
            "first": {"action": "ADAPTIVE_REBALANCE_COMPLETE"},
            "second": {"action": "ADAPTIVE_REBALANCE_COMPLETE"},
        }
    )
    assert duplicated["terminal_action_count"] == 2
    assert duplicated["status"] == "DEGRADED"

    # Two *different* terminals: mutually exclusive endings. The cycle either
    # rebalanced or deferred the plan; it cannot have done both.
    conflicting = production_run.summarize_execution(
        {
            "risk_tier": "NORMAL",
            "entry_gate": {"allowed": True},
            "first": {"action": "ADAPTIVE_REBALANCE_COMPLETE"},
            "second": {"action": "ADAPTIVE_PLAN_DEFERRED"},
        }
    )
    assert conflicting["terminal_action_count"] == 2
    assert sorted(conflicting["terminal_actions"]) == [
        "ADAPTIVE_PLAN_DEFERRED",
        "ADAPTIVE_REBALANCE_COMPLETE",
    ]
    assert conflicting["status"] == "DEGRADED"

    # Exactly one still passes, so the rule bites in one direction only.
    single = production_run.summarize_execution(
        {
            "risk_tier": "NORMAL",
            "entry_gate": {"allowed": True},
            "summary": {"action": "ADAPTIVE_REBALANCE_COMPLETE"},
        }
    )
    assert single["terminal_action_count"] == 1
    assert single["status"] == "PASS"


def test_terminal_action_does_not_override_a_blocking_action():
    summary = production_run.summarize_execution(
        {
            "entry_gate": {"allowed": True},
            "summary": {"action": "ADAPTIVE_REBALANCE_COMPLETE"},
            "shorts": [{"symbol": "BBB", "action": "ABORT_SHORT_RECONCILIATION"}],
        }
    )

    assert summary["status"] == "DEGRADED"


def test_abort_exits_non_zero_and_raises_a_workflow_incident(monkeypatch, tmp_path, capsys):
    """A stopped cycle must fail the job and be visible on the run page."""

    step_summary = tmp_path / "step_summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(step_summary))
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setattr(production_run, "require_paper_trading_mode", lambda: None)
    monkeypatch.setattr(
        production_run,
        "run_execution",
        lambda dry_run: {
            "entry_gate": {"allowed": True},
            "shorts": [
                {"symbol": "BBB", "action": "ABORT_SHORT_RECONCILIATION", "reason": "private"}
            ],
        },
    )
    monkeypatch.setattr(production_run, "save_positions_state", lambda: None)
    monkeypatch.setattr(production_run, "update_performance_state", lambda: None)
    written: dict[str, object] = {}
    monkeypatch.setattr(
        production_run,
        "save_json",
        lambda path, payload: written.update({"path": path, "payload": payload}),
    )

    exit_code = production_run.main()

    assert exit_code == 1
    assert written["payload"]["status"] == "DEGRADED"
    stdout = capsys.readouterr().out
    assert "::error title=V11 paper production incident::" in stdout
    assert "ABORT_SHORT_RECONCILIATION" in stdout
    assert "ABORT_SHORT_RECONCILIATION" in step_summary.read_text(encoding="utf-8")
    assert "private" not in step_summary.read_text(encoding="utf-8")
