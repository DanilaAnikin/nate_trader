"""The legacy paper-only options helper must never run in live mode."""

from __future__ import annotations

import pytest

import options_executor


def test_options_executor_refuses_live_mode_before_any_network_call(monkeypatch):
    monkeypatch.setenv("TRADING_MODE", "live")

    with pytest.raises(RuntimeError, match="paper-only"):
        options_executor.execute_options_hedge(dry_run=True)


def test_options_executor_keeps_paper_mode_path_available(monkeypatch):
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setattr(options_executor, "load_json", lambda _path: {})
    monkeypatch.setattr("strategy_config.get_market_regime", lambda: "BULL")
    monkeypatch.setattr("utils.get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        options_executor,
        "_existing_put",
        lambda: None,
    )
    monkeypatch.setattr(
        options_executor,
        "decide_action",
        lambda **kwargs: type("Decision", (), {"action": "HOLD", "reason": "test"})(),
    )

    result = options_executor.execute_options_hedge(dry_run=True)

    assert result == [{"action": "HOLD", "reason": "test"}]
