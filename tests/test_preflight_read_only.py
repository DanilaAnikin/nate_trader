"""Manual handoff acceptance stays read-only even while the market is open."""

from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import execute_trades
import notify
import portfolio
import production_preflight
import pytest
import requests
import strategy_metadata
import trade

from tests.test_execution_safety import _patch_adaptive_runtime
from tests.test_runtime_handoff import transfer as transfer_fixture

transfer = transfer_fixture


@pytest.fixture
def readonly_runtime(monkeypatch, transfer):
    mutations = []
    manager_calls = []

    def forbidden(name):
        def call(*args, **kwargs):
            mutations.append(name)
            raise AssertionError(f"read-only preview attempted {name}")

        return call

    def configure(scenario):
        positions = []
        if scenario == "legacy_exits":
            positions = [
                {
                    "symbol": symbol,
                    "side": "long",
                    "qty": 1.0,
                    "current_price": 100.0,
                    "market_value": 100.0,
                }
                for symbol in ("SPY", "SSO", "SH", "TQQQ", "UPRO")
            ]
        elif scenario in {"trim", "halt_exit"}:
            positions = [
                {
                    "symbol": "AAA",
                    "side": "long",
                    "qty": 200.0,
                    "current_price": 100.0,
                    "market_value": 20_000.0,
                }
            ]
        risk_tier = "HALT" if scenario.startswith("halt_") else "NORMAL"
        _patch_adaptive_runtime(
            monkeypatch,
            perf=transfer.performance,
            positions=positions,
            risk_tier=risk_tier,
            account={
                "equity": 90_000.0 if risk_tier == "HALT" else 100_000.0,
                "last_equity": 100_000.0,
                "cash": 90_000.0,
            },
        )
        # File reads return independent objects. A HALT preview may construct
        # an in-memory zero target, but must never persist or activate it.
        monkeypatch.setattr(
            execute_trades, "load_json", lambda path: deepcopy(transfer.performance)
        )
        monkeypatch.setattr(
            execute_trades,
            "load_json_object_status",
            lambda path: (deepcopy(transfer.performance), None),
        )
        monkeypatch.setattr(
            portfolio, "get_recent_equity_history", lambda **kwargs: [100_000.0] * 22
        )
        original_canceled = scenario in {
            "retry_buy",
            "legacy_exits",
            "trim",
            "halt_exit",
        }
        if original_canceled:
            transfer.broker.orders[
                transfer.order["client_order_id"]
            ].status = "canceled"
        monkeypatch.setattr(
            trade,
            "list_open_orders",
            lambda: [] if original_canceled else [deepcopy(transfer.order)],
        )
        monkeypatch.setattr(
            transfer.broker,
            "get_all_positions",
            lambda: [SimpleNamespace(**position) for position in positions],
        )
        monkeypatch.setattr(
            transfer.broker,
            "get_clock",
            lambda: SimpleNamespace(is_open=True, timestamp=transfer.now),
            raising=False,
        )
        for module, names in (
            (
                trade,
                (
                    "place_limit_order",
                    "place_trailing_stop",
                    "cancel_all_orders",
                    "cancel_open_order",
                    "close_position",
                ),
            ),
            (
                notify,
                (
                    "send_trade_alert",
                    "send_clickup_task",
                    "send_daily_recap",
                    "send_weekly_report",
                ),
            ),
            (portfolio, ("save_positions_state", "update_performance_state")),
            (execute_trades, ("save_json",)),
            (strategy_metadata, ("save_metadata", "sync_with_positions")),
        ):
            for name in names:
                monkeypatch.setattr(
                    module, name, forbidden(f"{module.__name__}.{name}")
                )
        for name in (
            "submit_order",
            "replace_order_by_id",
            "cancel_order_by_id",
            "cancel_orders",
            "close_position",
            "close_all_positions",
        ):
            monkeypatch.setattr(
                transfer.broker, name, forbidden(f"broker.{name}"), raising=False
            )
        monkeypatch.setattr(requests.Session, "request", forbidden("external_http"))

        # Wrap the real managers so zero-target legacy exit previews are also
        # observable; the orchestrator intentionally omits some from its result.
        for name in (
            "manage_bear_hedge",
            "manage_spy_base",
            "manage_tqqq_position",
            "manage_upro_position",
        ):
            original = getattr(execute_trades, name)

            def observe(*args, _original=original, _name=name, **kwargs):
                result = _original(*args, **kwargs)
                manager_calls.append((_name, kwargs["dry_run"], result))
                return result

            monkeypatch.setattr(execute_trades, name, observe)

    return SimpleNamespace(
        configure=configure,
        mutations=mutations,
        manager_calls=manager_calls,
    )


@pytest.mark.parametrize(
    "scenario",
    ["pending_buy", "retry_buy", "halt_cancel", "legacy_exits", "trim", "halt_exit"],
)
def test_full_handoff_dry_run_never_mutates_even_with_open_market(
    transfer, readonly_runtime, scenario
):
    readonly_runtime.configure(scenario)
    before = {path: path.read_bytes() for path in transfer.state.rglob("*.json")}
    original_performance = deepcopy(transfer.performance)
    assert trade.get_market_entry_gate(now=transfer.now)["allowed"] is True

    result = execute_trades.run_execution(dry_run=True)

    assert result["dry_run"] is True
    assert result["entry_gate"]["risk_snapshot"]["available"] is True
    assert (
        "known_order" in transfer.broker.gets
    )  # Real handoff broker reconciliation ran.
    assert readonly_runtime.mutations == transfer.broker.mutations == []
    assert {
        path: path.read_bytes() for path in transfer.state.rglob("*.json")
    } == before
    assert transfer.performance == original_performance
    if scenario == "halt_cancel":
        assert result["risk_tier"] == "HALT"
        assert any(
            item["action"] == "DRY_RUN_CANCEL_OPEN_ORDER"
            for item in result["safety_preflight"]
        )
    else:
        assert result["entry_gate"]["allowed"] is True
        assert len(readonly_runtime.manager_calls) == 4
        assert all(dry_run for _, dry_run, _ in readonly_runtime.manager_calls)
        if scenario == "retry_buy":
            assert any(
                item["action"] == "DRY_RUN_ADAPTIVE_BUY"
                for item in result["momentum_picks"]
            )
        elif scenario == "pending_buy":
            assert any(
                item["action"] == "PENDING_BUY" for item in result["momentum_picks"]
            )
        elif scenario in {"trim", "halt_exit"}:
            expected = (
                "DRY_RUN_ADAPTIVE_TRIM"
                if scenario == "trim"
                else "DRY_RUN_ADAPTIVE_EXIT"
            )
            assert any(item["action"] == expected for item in result["momentum_picks"])
        else:
            actions = {
                item["action"]
                for _, _, result in readonly_runtime.manager_calls
                for item in result
            }
            assert actions == {
                "DRY_RUN_HEDGE_EXIT",
                "DRY_RUN_BASE_EXIT",
                "DRY_RUN_BASE_SWAP",
                "DRY_RUN_TQQQ_EXIT",
                "DRY_RUN_UPRO_EXIT",
            }


def test_actual_dry_run_cli_uses_read_only_handoff_path(
    transfer, readonly_runtime, capsys
):
    readonly_runtime.configure("retry_buy")

    assert execute_trades.main(["dry-run"]) == 0

    assert "Dry run" in capsys.readouterr().out
    assert "known_order" in transfer.broker.gets
    assert readonly_runtime.mutations == []


def test_production_broker_preflight_is_read_only_with_open_market(
    transfer, readonly_runtime, monkeypatch
):
    readonly_runtime.configure("pending_buy")
    # Offline validation is independently covered; exercise the real preflight
    # orchestration, all broker checks and fresh risk capture without network.
    monkeypatch.setattr(production_preflight, "check_runtime", list)
    monkeypatch.setattr(production_preflight, "check_release", lambda: ([], {}))

    report = production_preflight.run_preflight(
        environ={
            "TRADING_MODE": "paper",
            "ALPACA_API_KEY": "synthetic-key",
            "ALPACA_SECRET_KEY": "synthetic-secret",
        },
        broker=transfer.broker,
        now=transfer.now,
    )

    assert report["status"] == "PASS"
    assert report["details"]["market_open"] is True
    assert report["details"]["open_buy_count"] == 1
    assert report["details"]["risk_tier"] == "NORMAL"
    assert readonly_runtime.mutations == []


def test_manual_preflight_workflow_excludes_executor_and_incident_notifications():
    workflow = (
        Path(__file__).resolve().parents[1] / ".github/workflows/paper-production.yml"
    ).read_text()
    execute = workflow.split("- name: Execute one guarded paper cycle\n", 1)[1].split(
        "\n      - name:", 1
    )[0]
    incident = workflow.split("- name: Open one operational incident on failure\n", 1)[
        1
    ]
    preview = workflow.split("- name: Read-only strategy preview\n", 1)[1].split(
        "\n      - name:", 1
    )[0]

    def condition(block):
        return next(line.strip() for line in block.splitlines() if line.strip().startswith("if:"))

    # Compare the entire condition: a permissive suffix or misplaced grouping
    # must not let a preflight dispatch execute, or let cron bypass deduplication.
    assert condition(execute) == (
        "if: (github.event_name == 'schedule' || inputs.operation == 'execute') "
        "&& steps.cadence.outputs.allow_execution == 'true'"
    )
    assert condition(incident) == (
        "if: failure() && (github.event_name == 'schedule' || inputs.operation == 'execute')"
    )
    assert condition(preview) == (
        "if: github.event_name == 'workflow_dispatch' && "
        "(inputs.operation == 'preflight' || steps.cadence.outputs.allow_execution == 'true')"
    )
    assert "python scripts/execute_trades.py dry-run |" in preview
