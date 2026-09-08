"""Production preflight and runner regression tests."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import production_preflight
import production_run


class _PaperBroker:
    _base_url = SimpleNamespace(value="https://paper-api.alpaca.markets")

    def __init__(self, *, positions=None, orders=None):
        self.positions = list(positions or [])
        self.orders = list(orders or [])

    def get_account(self):
        return SimpleNamespace(
            status=SimpleNamespace(value="ACTIVE"),
            account_blocked=False,
            trading_blocked=False,
            trade_suspended_by_user=False,
        )

    def get_clock(self):
        return SimpleNamespace(
            timestamp=datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc),
            is_open=False,
        )

    def get_all_positions(self):
        return self.positions

    def get_orders(self, *, filter=None):
        return self.orders


def test_pinned_alpaca_sdk_has_supported_portfolio_history_api():
    from alpaca.trading.client import TradingClient

    assert callable(getattr(TradingClient, "get_portfolio_history", None))


def test_paper_workflow_pins_release_and_runtime_artifact_lineage():
    workflow = (
        Path(__file__).resolve().parents[1]
        / ".github"
        / "workflows"
        / "paper-production.yml"
    ).read_text(encoding="utf-8")

    assert "ref: ${{ vars.PRODUCTION_RELEASE_SHA }}" in workflow
    assert "paper-runtime-state-${APPROVED_RELEASE_SHA}" in workflow
    assert "paper-runtime-state-${{ vars.PRODUCTION_RELEASE_SHA }}" in workflow
    assert '"$runtime_dir/restored/performance.json"' in workflow
    assert 'last_run.get("release_sha") != approved_sha' in workflow


def test_production_summary_records_approved_release_sha(monkeypatch):
    approved = "a" * 40
    monkeypatch.setenv("APPROVED_RELEASE_SHA", approved)
    monkeypatch.setenv("GITHUB_SHA", "b" * 40)

    summary = production_run.summarize_execution({"entry_gate": {}})

    assert summary["release_sha"] == approved


def test_environment_refuses_an_incompletely_configured_live_run():
    """`TRADING_MODE=live` alone must never be enough.

    This test used to assert that live failed the *mode* check, because live
    did not exist. It now exists, so the refusal moved one check along: the
    mode is recognised, and the run is stopped by the live-configuration check
    instead. What must not change is that a half-configured live run is
    refused, and that the refusal names what is missing without echoing a
    credential.
    """
    checks = production_preflight.check_environment(
        {
            "TRADING_MODE": "live",
            "ALPACA_API_KEY": "top-secret-key",
            "ALPACA_SECRET_KEY": "top-secret-secret",
        }
    )

    by_name = {check["name"]: check for check in checks}
    assert by_name["live_configuration"]["passed"] is False
    assert not all(check["passed"] for check in checks)

    detail = by_name["live_configuration"]["detail"]
    assert "LIVE_TRADING_ENABLED" in detail
    assert "ALPACA_LIVE_API_KEY" in detail

    rendered = str(checks)
    assert "top-secret" not in rendered


def test_environment_requires_explicit_paper_mode_without_leaking_credentials():
    """An unset mode is inert, and the paper path is unchanged."""
    unset = production_preflight.check_environment(
        {"ALPACA_API_KEY": "top-secret-key", "ALPACA_SECRET_KEY": "top-secret-secret"}
    )
    assert unset[0]["passed"] is False
    assert "top-secret" not in str(unset)

    checks = production_preflight.check_environment(
        {
            "TRADING_MODE": "paper",
            "ALPACA_API_KEY": "top-secret-key",
            "ALPACA_SECRET_KEY": "top-secret-secret",
        }
    )

    assert checks[0]["passed"] is True
    assert checks[0]["detail"] == "paper"
    rendered = str(checks)
    assert "top-secret" not in rendered
    assert checks[1]["detail"] == "configured"
    assert checks[2]["detail"] == "configured"


def test_environment_accepts_a_fully_configured_live_run(tmp_path):
    """The positive control: the refusals above are conditions, not a ban."""
    checks = production_preflight.check_environment(
        {
            "TRADING_MODE": "live",
            "LIVE_TRADING_ENABLED": "yes",
            "ALPACA_LIVE_API_KEY": "top-secret-live-key",
            "ALPACA_LIVE_SECRET_KEY": "top-secret-live-secret",
            "ALPACA_API_KEY": "paper-key",
            "ALPACA_SECRET_KEY": "paper-secret",
            "LIVE_TRADING_ACCOUNT_NUMBER": "123456789",
            "LIVE_MAX_ORDER_NOTIONAL_USD": "5000",
            "LIVE_MAX_CYCLE_NOTIONAL_USD": "25000",
            "LIVE_TRADING_KILL_SWITCH_FILE": str(tmp_path / "absent"),
        }
    )

    assert all(check["passed"] for check in checks)
    rendered = str(checks)
    assert "top-secret" not in rendered
    # The account number is the operator's own out-of-band declaration, not a
    # credential, and naming it is how the log shows which book was traded.
    assert "123456789" in rendered


def test_runtime_check_binds_python_and_identity_packages(tmp_path):
    lock = tmp_path / "requirements.lock"
    lock.write_text(
        "alpaca-py==1.2.3\nnumpy==4.5.6\npandas==7.8.9\n",
        encoding="utf-8",
    )

    checks = production_preflight.check_runtime(
        python_version=production_preflight.EXPECTED_PYTHON,
        installed_versions={
            "alpaca-py": "1.2.3",
            "numpy": "4.5.6",
            "pandas": "7.8.9",
        },
        lock_path=lock,
    )

    assert all(check["passed"] for check in checks)


def test_broker_check_accepts_closed_but_fresh_paper_market():
    now = datetime(2026, 8, 2, 12, 0, 30, tzinfo=timezone.utc)
    checks, details = production_preflight.check_broker(
        broker=_PaperBroker(),
        risk_snapshot={"available": True, "tier": "NORMAL"},
        now=now,
    )

    assert all(check["passed"] for check in checks)
    assert details["market_open"] is False
    assert details["position_count"] == 0


def test_broker_check_rejects_short_position():
    position = SimpleNamespace(symbol="BAD", side="short", qty="-2")
    checks, details = production_preflight.check_broker(
        broker=_PaperBroker(positions=[position]),
        risk_snapshot={"available": True, "tier": "CAUTIOUS"},
        now=datetime(2026, 8, 2, 12, 0, 30, tzinfo=timezone.utc),
    )

    short_check = next(check for check in checks if check["name"] == "no_short_positions")
    assert short_check["passed"] is False
    assert details["short_count"] == 1


def test_production_summary_returns_degraded_for_nested_execution_error():
    summary = production_run.summarize_execution(
        {
            "risk_tier": "NORMAL",
            "entry_gate": {"allowed": True},
            "buys": [{"symbol": "AAA", "action": "ADAPTIVE_BUY"}],
            "sells": [{"symbol": "BBB", "action": "ERROR", "reason": "private"}],
        }
    )

    assert summary["status"] == "DEGRADED"
    assert summary["action_counts"] == {"ADAPTIVE_BUY": 1, "ERROR": 1}
    assert summary["blocking_actions"] == [{"action": "ERROR", "symbol": "BBB"}]
    assert "private" not in str(summary)
