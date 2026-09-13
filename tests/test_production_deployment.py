"""Production preflight and runner regression tests."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

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
    assert "paper-runtime-state-${{ vars.PRODUCTION_RELEASE_SHA }}" in workflow
    assert "python scripts/restore_paper_runtime.py" in workflow
    assert "PAPER_RUNTIME_HANDOFF_SHA256: ${{ vars.PAPER_RUNTIME_HANDOFF_SHA256 }}" in workflow
    assert "PAPER_RUNTIME_HANDOFF_MANIFEST: ${{ vars.PAPER_RUNTIME_HANDOFF_MANIFEST }}" in workflow
    assert "steps.restore_runtime.outcome == 'success'" in workflow
    assert "steps.execute.outcome == 'failure'" in workflow
    assert "steps.execute.outcome == 'cancelled'" in workflow
    assert "using the release seed" not in workflow
    assert "unzip" not in workflow
    assert "group: nate-trader-v11-paper-production" in workflow
    assert "Approved release has no verified runtime restore contract" in workflow


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
            "LIVE_CAPITAL_BUDGET_USD": "25000",
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


def test_runtime_check_reports_missing_identity_package(monkeypatch):
    def missing_version(name):
        raise production_preflight.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(production_preflight.metadata, "version", missing_version)
    checks = production_preflight.check_runtime()
    missing = [check for check in checks if check["name"].startswith("runtime_")]
    assert len(missing) == 3
    assert all(not check["passed"] for check in missing)
    assert all("actual=missing" in check["detail"] for check in missing)


@pytest.mark.parametrize("mode", ["paper", "live"])
def test_preflight_reports_the_broker_mode_it_checked(monkeypatch, tmp_path, mode):
    monkeypatch.setenv("TRADING_MODE", "paper" if mode == "live" else "live")
    values = {
        "TRADING_MODE": mode,
        "ALPACA_API_KEY": "fixture-paper-key",
        "ALPACA_SECRET_KEY": "fixture-paper-secret",
        "LIVE_TRADING_ENABLED": "yes",
        "ALPACA_LIVE_API_KEY": "fixture-live-key",
        "ALPACA_LIVE_SECRET_KEY": "fixture-live-secret",
        "LIVE_TRADING_ACCOUNT_NUMBER": "123456789",
        "LIVE_MAX_ORDER_NOTIONAL_USD": "5000",
        "LIVE_MAX_CYCLE_NOTIONAL_USD": "25000",
        "LIVE_CAPITAL_BUDGET_USD": "25000",
        "LIVE_TRADING_KILL_SWITCH_FILE": str(tmp_path / "absent"),
    }
    monkeypatch.setattr(production_preflight, "check_runtime", lambda: [])
    monkeypatch.setattr(production_preflight, "check_release", lambda: ([], {}))
    broker = _PaperBroker()
    broker._base_url = (
        production_preflight.EXPECTED_LIVE_URL
        if mode == "live" else production_preflight.EXPECTED_PAPER_URL
    )
    report = production_preflight.run_preflight(
        environ=values,
        broker=broker,
        risk_snapshot={"available": True, "tier": "NORMAL"},
        now=datetime(2026, 8, 2, 12, 0, 30, tzinfo=timezone.utc),
    )
    assert report["status"] == "PASS"
    assert report["kind"] == f"v11_{mode}_production_preflight"
    assert report["broker_mode"] == mode
    assert report["allowed_mode"] == mode
    assert any(check["name"] == f"{mode}_account" for check in report["checks"])
    assert "fixture-live-secret" not in str(report)
    assert "fixture-paper-secret" not in str(report)


def test_preflight_runtime_exception_still_returns_a_failed_report(monkeypatch):
    def broken_runtime():
        raise RuntimeError("internal runtime failure")

    monkeypatch.setattr(production_preflight, "check_runtime", broken_runtime)
    monkeypatch.setattr(production_preflight, "check_release", lambda: ([], {}))
    report = production_preflight.run_preflight(
        environ={"TRADING_MODE": "paper", "ALPACA_API_KEY": "k", "ALPACA_SECRET_KEY": "s"},
        broker=_PaperBroker(),
        risk_snapshot={"available": True, "tier": "NORMAL"},
        now=datetime(2026, 8, 2, 12, 0, 30, tzinfo=timezone.utc),
    )
    assert report["status"] == "FAIL"
    assert report["allowed_mode"] == "no-execution"
    assert {"name": "runtime_inspection", "passed": False, "detail": "RuntimeError"} in report["checks"]


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
