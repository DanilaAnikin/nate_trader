"""Production preflight and runner regression tests."""

from __future__ import annotations

from datetime import datetime, timezone
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


def test_environment_requires_explicit_paper_mode_without_leaking_credentials():
    checks = production_preflight.check_environment(
        {
            "TRADING_MODE": "live",
            "ALPACA_API_KEY": "top-secret-key",
            "ALPACA_SECRET_KEY": "top-secret-secret",
        }
    )

    assert checks[0]["passed"] is False
    rendered = str(checks)
    assert "top-secret" not in rendered
    assert checks[1]["detail"] == "configured"
    assert checks[2]["detail"] == "configured"


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
