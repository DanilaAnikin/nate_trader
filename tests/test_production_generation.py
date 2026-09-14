"""Producer integration: preserve intents and never bless a failed state refresh."""

from __future__ import annotations

import copy
import json
from contextlib import nullcontext

import execute_trades
import portfolio
import production_run
import pytest
import runtime_generation as generation
import runtime_handoff
from broker_mode import resolve_broker_mode


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("APPROVED_RELEASE_SHA", "a" * 40)
    monkeypatch.setenv("GITHUB_RUN_ID", "123")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setattr(production_run, "STATE_DIR", tmp_path)
    monkeypatch.setattr(
        production_run,
        "require_trading_mode",
        lambda: resolve_broker_mode(
            {
                "TRADING_MODE": "paper",
                "ALPACA_API_KEY": "synthetic",
                "ALPACA_SECRET_KEY": "synthetic",
            }
        ),
    )
    performance = {
        "equity": 1000.0,
        "cash": 1000.0,
        "num_positions": 0,
        "updated_at": "2026-09-14 10:00:00",
        "daily_history": [],
        "adaptive_rebalance_pending": {
            "plan_id": "frozen",
            "order_attempts": {
                "first": {"status": "reserved", "client_order_id": "same-id"},
            },
        },
    }
    positions = {"updated_at": performance["updated_at"], "positions": []}
    for name, value in zip(
        generation.SNAPSHOT_FILES, (performance, positions), strict=True
    ):
        (tmp_path / name).write_text(json.dumps(value))
    monkeypatch.setattr(
        production_run,
        "capture_portfolio_snapshot",
        lambda: (
            json.loads((tmp_path / "performance.json").read_bytes()),
            copy.deepcopy(positions),
        ),
    )

    def execution(**kwargs):
        assert kwargs == {"dry_run": False, "persist_portfolio": False}
        return {
            "entry_gate": {"allowed": True},
            "risk_tier": "NORMAL",
            "cycle_outcome": generation.cycle_outcome("pending", "orders_pending"),
            "momentum_picks": [{"action": "ADAPTIVE_BUY"}],
        }

    monkeypatch.setattr(production_run, "run_execution", execution)
    return tmp_path


def read(state):
    return {
        name: (state / name).read_bytes()
        for name in (*generation.SNAPSHOT_FILES, generation.LAST_RUN_FILE)
    }


def test_submitted_order_is_healthy_pending_not_completed(runtime, capsys):
    assert production_run.main() == 0
    record = json.loads(capsys.readouterr().out)
    assert record["status"] == "PASS"
    assert record["cycle_outcome"] == generation.cycle_outcome(
        "pending", "orders_pending"
    )
    assert (
        generation.validate_runtime_generation(read(runtime), require_current_run=True)[
            "snapshot_status"
        ]
        == "fresh"
    )
    assert (
        json.loads((runtime / "performance.json").read_bytes())[
            "adaptive_rebalance_pending"
        ]["plan_id"]
        == "frozen"
    )


def test_snapshot_failure_publishes_recovery_failure_without_losing_intent(
    runtime, monkeypatch, capsys
):
    def failed_snapshot():
        raise OSError("private broker response")

    monkeypatch.setattr(production_run, "capture_portfolio_snapshot", failed_snapshot)
    assert production_run.main() == 1
    record = json.loads(capsys.readouterr().out)
    assert record["cycle_outcome"] == generation.cycle_outcome(
        "failed", "snapshot_unavailable"
    )
    assert (
        generation.validate_runtime_generation(read(runtime), require_current_run=True)[
            "snapshot_status"
        ]
        == "recovery"
    )
    assert "private broker response" not in str(record)
    assert (
        json.loads((runtime / "performance.json").read_bytes())[
            "adaptive_rebalance_pending"
        ]["order_attempts"]["first"]["client_order_id"]
        == "same-id"
    )


def test_ambiguous_submit_failure_keeps_newly_persisted_intent(
    runtime, monkeypatch, capsys
):
    def failed_execution(**kwargs):
        perf = json.loads((runtime / "performance.json").read_bytes())
        perf["adaptive_rebalance_pending"]["order_attempts"]["latest"] = {
            "status": "reserved",
            "client_order_id": "uncertain-submission",
        }
        (runtime / "performance.json").write_text(json.dumps(perf))
        raise TimeoutError("secret transport details")

    monkeypatch.setattr(production_run, "run_execution", failed_execution)
    assert production_run.main() == 1
    record = json.loads(capsys.readouterr().out)
    assert record["cycle_outcome"] == generation.cycle_outcome(
        "failed", "execution_exception"
    )
    generation.validate_runtime_generation(read(runtime), require_current_run=True)
    assert "uncertain-submission" in (runtime / "performance.json").read_text()
    assert "secret transport details" not in str(record)


def test_partial_publication_can_only_recover_as_failed(runtime, monkeypatch, capsys):
    original = generation.os.replace
    calls = 0

    def interrupt_once(source, destination):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated publication interruption")
        original(source, destination)

    monkeypatch.setattr(generation.os, "replace", interrupt_once)
    assert production_run.main() == 1
    record = json.loads(capsys.readouterr().out)
    assert record["cycle_outcome"] == generation.cycle_outcome(
        "failed", "publication_failed"
    )
    assert (
        generation.validate_runtime_generation(read(runtime), require_current_run=True)[
            "snapshot_status"
        ]
        == "recovery"
    )


def test_persistent_publication_failure_has_no_valid_commit_marker(
    runtime, monkeypatch, capsys
):
    def denied(*args):
        raise OSError("filesystem denied")

    monkeypatch.setattr(generation.os, "replace", denied)
    assert production_run.main() == 1
    record = json.loads(capsys.readouterr().out)
    assert record["status"] == "FAIL" and record["runtime_publication"] == "unavailable"
    assert not (runtime / generation.LAST_RUN_FILE).exists()


def test_snapshot_builder_uses_one_account_and_one_position_read_preserving_plan(
    runtime, monkeypatch
):
    calls = []
    monkeypatch.setattr(portfolio, "PERFORMANCE_STATE", runtime / "performance.json")
    monkeypatch.setattr(portfolio, "get_risk_tier", lambda: "NORMAL")

    def account():
        calls.append("account")
        return {
            "equity": 1000.0,
            "cash": 900.0,
            "cash_pct": 90.0,
            "daily_pnl": 0.0,
            "daily_pnl_pct": 0.0,
            "last_equity": 1000.0,
        }

    def positions():
        calls.append("positions")
        return [{"symbol": "SYNTHETIC", "qty": 1.0, "unrealized_pl": 0.0}]

    monkeypatch.setattr(portfolio, "get_account", account)
    monkeypatch.setattr(portfolio, "get_positions", positions)
    before = (runtime / "performance.json").read_bytes()
    perf, positions_snapshot = portfolio.capture_portfolio_snapshot()
    assert calls == ["account", "positions"]
    assert perf["num_positions"] == len(positions_snapshot["positions"]) == 1
    assert perf["updated_at"] == positions_snapshot["updated_at"]
    assert perf["adaptive_rebalance_pending"]["plan_id"] == "frozen"
    assert (runtime / "performance.json").read_bytes() == before


def test_execution_observation_is_explicit_scoped_and_persistence_option_propagates(
    monkeypatch,
):
    monkeypatch.setattr(execute_trades, "require_paper_trading_mode", lambda: None)
    monkeypatch.setattr(runtime_handoff, "paper_handoff_context", nullcontext)
    monkeypatch.setattr(
        execute_trades, "_capture_execution_risk_snapshot", lambda: {"tier": "NORMAL"}
    )

    def observed(**kwargs):
        assert kwargs["persist_portfolio"] is False
        execute_trades._record_cycle_outcome("idle", "no_rebalance_due")
        return {}

    monkeypatch.setattr(execute_trades, "_run_execution_with_risk_snapshot", observed)
    result = execute_trades.run_execution(dry_run=False, persist_portfolio=False)
    assert result["cycle_outcome"] == generation.cycle_outcome(
        "idle", "no_rebalance_due"
    )
    monkeypatch.setattr(
        execute_trades,
        "_run_execution_with_risk_snapshot",
        lambda **kw: {
            "momentum_picks": [{"action": "ADAPTIVE_REBALANCE_COMPLETE"}],
        },
    )
    result = execute_trades.run_execution(dry_run=False, persist_portfolio=False)
    assert result["cycle_outcome"] == generation.cycle_outcome(
        "blocked", "execution_incomplete"
    )


@pytest.mark.parametrize("corrupt", [True, False])
def test_snapshot_cannot_silently_discard_unreadable_intent(
    runtime, monkeypatch, corrupt
):
    monkeypatch.setattr(portfolio, "PERFORMANCE_STATE", runtime / "performance.json")
    monkeypatch.setattr(portfolio, "get_account", dict)
    monkeypatch.setattr(portfolio, "get_positions", list)
    monkeypatch.setattr(portfolio, "_portfolio_performance", lambda *args: {})
    path = runtime / "performance.json"
    if corrupt:
        path.write_text('{"adaptive_rebalance_pending":')
    else:
        path.unlink()
    with pytest.raises(ValueError, match="performance state unavailable"):
        portfolio.capture_portfolio_snapshot()
