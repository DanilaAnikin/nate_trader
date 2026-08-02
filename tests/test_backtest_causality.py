from __future__ import annotations

import json
from types import SimpleNamespace

from backtest.data_provider import BarProvider
from backtest import engine
from backtest.engine import (
    _completed_session_risk_tier,
    _execute_adaptive_momentum,
    _risk_tier,
)
from backtest.portfolio_sim import DailySnapshot, SimulatedPortfolio


def test_previous_trading_day_is_strictly_before_signal_fill_date(tmp_path):
    bars_dir = tmp_path / "bars"
    bars_dir.mkdir()
    (bars_dir / "SPY.json").write_text(
        json.dumps(
            {
                "bars": [
                    {
                        "date": date,
                        "open": 100,
                        "high": 101,
                        "low": 99,
                        "close": close,
                        "volume": 1_000_000,
                    }
                    for date, close in [
                        ("2025-01-02", 100),
                        ("2025-01-03", 101),
                        ("2025-01-06", 999),
                    ]
                ]
            }
        )
    )
    provider = BarProvider(bars_dir)

    signal_date = provider.previous_trading_day("SPY", "2025-01-06")

    assert signal_date == "2025-01-03"
    assert provider.bars_up_to("SPY", signal_date)["close"].tolist() == [100, 101]
    assert provider.previous_trading_day("SPY", "2025-01-02") is None


def test_indexed_exact_bar_lookup_preserves_values_and_returns_a_copy(tmp_path):
    bars_dir = tmp_path / "bars"
    bars_dir.mkdir()
    (bars_dir / "AAA.json").write_text(
        json.dumps(
            {
                "bars": [
                    {
                        "date": "2025-01-02",
                        "open": 100.25,
                        "high": 102.0,
                        "low": 99.5,
                        "close": 101.75,
                        "volume": 123_456,
                    }
                ]
            }
        )
    )
    provider = BarProvider(bars_dir)

    first = provider.bar_at("AAA", "2025-01-02")
    assert first == {
        "date": "2025-01-02",
        "open": 100.25,
        "high": 102.0,
        "low": 99.5,
        "close": 101.75,
        "volume": 123_456,
    }
    first["close"] = -1.0

    assert provider.bar_at("AAA", "2025-01-02")["close"] == 101.75
    assert provider.bar_at("AAA", "2025-01-03") is None


def _snapshot(equity: float) -> DailySnapshot:
    return DailySnapshot(
        date="2025-01-02",
        equity=equity,
        cash=equity,
        cash_pct=100.0,
        num_positions=0,
        pnl=0.0,
        pnl_pct=0.0,
        regime="BULL",
        risk_tier="NORMAL",
    )


def test_halt_is_one_session_but_deep_drawdown_remains_cautious():
    portfolio = SimulatedPortfolio(starting_cash=100.0)
    portfolio.daily_history = [_snapshot(100.0), _snapshot(90.0)]
    portfolio.cash = 80.0
    assert _risk_tier(portfolio) == "HALT"

    portfolio.daily_history.append(_snapshot(80.0))
    assert _risk_tier(portfolio) == "CAUTIOUS"


def test_opening_gap_cannot_trigger_same_open_adaptive_halt_exit(monkeypatch):
    """A D-open shock is observable for the first time at D, so exits D+1."""

    portfolio = SimulatedPortfolio(starting_cash=1_000.0)
    bullish_market = SimpleNamespace(above_sma200=True)
    target = SimpleNamespace(weights={"AAA": 0.90})
    monkeypatch.setattr(
        engine, "compute_market_state", lambda *args, **kwargs: bullish_market
    )
    monkeypatch.setattr(
        engine, "build_target_portfolio", lambda *args, **kwargs: target
    )

    # Normal monthly mechanics still create the position at the next open.
    entry_tier = _completed_session_risk_tier(portfolio)
    assert entry_tier == "NORMAL"
    _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["AAA"],
        signal_date="2025-01-31",
        today="2025-02-03",
        params={},
        opens={"AAA": 100.0},
        slippage_bps=7.0,
        risk_tier=entry_tier,
        prev_date="2025-01-31",
    )
    assert portfolio.has_position("AAA")
    portfolio.record_snapshot("2025-02-03", "BULL", entry_tier)

    # AAA gaps down at D open.  D's decision was already fixed from D-1, so
    # the position cannot be sold retroactively at that same opening print.
    decision_tier_d = _completed_session_risk_tier(portfolio)
    portfolio.mark_to_market({"AAA": 80.0})
    _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["AAA"],
        signal_date="2025-02-03",
        today="2025-02-04",
        params={},
        opens={"AAA": 80.0},
        slippage_bps=7.0,
        risk_tier=decision_tier_d,
        prev_date="2025-02-03",
    )
    assert decision_tier_d == "NORMAL"
    assert portfolio.has_position("AAA")
    assert portfolio.closed_trades == []
    portfolio.record_snapshot("2025-02-04", "BULL", decision_tier_d)

    # The completed D snapshot now contains the loss.  HALT may act at the
    # next session's open, never the already-observed shock open.
    decision_tier_next = _completed_session_risk_tier(portfolio)
    assert decision_tier_next == "HALT"
    portfolio.mark_to_market({"AAA": 79.0})
    _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["AAA"],
        signal_date="2025-02-04",
        today="2025-02-05",
        params={},
        opens={"AAA": 79.0},
        slippage_bps=7.0,
        risk_tier=decision_tier_next,
        prev_date="2025-02-04",
    )

    assert not portfolio.has_position("AAA")
    assert portfolio.closed_trades[-1].exit_date == "2025-02-05"
    assert portfolio.closed_trades[-1].reason == "adaptive_risk_off"


def test_adaptive_replacement_buy_waits_until_session_after_sell(monkeypatch):
    portfolio = SimulatedPortfolio(starting_cash=1_000.0)
    assert portfolio.open("OLD", 5, 100.0, "2025-01-02")
    bullish_market = SimpleNamespace(above_sma200=True)
    target = SimpleNamespace(weights={"NEW": 0.50})
    monkeypatch.setattr(
        engine, "compute_market_state", lambda *args, **kwargs: bullish_market
    )
    monkeypatch.setattr(
        engine, "build_target_portfolio", lambda *args, **kwargs: target
    )

    pending = _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["NEW", "OLD"],
        signal_date="2025-01-31",
        today="2025-02-03",
        params={},
        opens={"NEW": 100.0, "OLD": 100.0},
        slippage_bps=0.0,
        risk_tier="NORMAL",
        prev_date="2025-01-31",
    )

    assert not portfolio.has_position("OLD")
    assert not portfolio.has_position("NEW")
    assert pending is not None
    assert pending["buy_after_date"] == "2025-02-03"

    pending = _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["NEW", "OLD"],
        signal_date="2025-02-03",
        today="2025-02-04",
        params={},
        opens={"NEW": 100.0, "OLD": 100.0},
        slippage_bps=0.0,
        risk_tier="NORMAL",
        prev_date="2025-02-03",
        pending_plan=pending,
    )

    assert portfolio.has_position("NEW")
    assert portfolio.get_position("NEW").entry_date == "2025-02-04"
    assert pending is None


def test_recovery_reentry_bypasses_month_start_exactly_when_forced(monkeypatch):
    bullish_market = SimpleNamespace(above_sma200=True)
    target = SimpleNamespace(weights={"AAA": 0.90})
    monkeypatch.setattr(
        engine, "compute_market_state", lambda *args, **kwargs: bullish_market
    )
    monkeypatch.setattr(
        engine, "build_target_portfolio", lambda *args, **kwargs: target
    )

    waiting = SimulatedPortfolio(starting_cash=1_000.0)
    result = _execute_adaptive_momentum(
        portfolio=waiting,
        provider=object(),
        candidates=["AAA"],
        signal_date="2025-02-11",
        today="2025-02-12",
        params={},
        opens={"AAA": 100.0},
        slippage_bps=0.0,
        risk_tier="NORMAL",
        prev_date="2025-02-11",
    )
    assert result is None
    assert not waiting.has_position("AAA")

    reentering = SimulatedPortfolio(starting_cash=1_000.0)
    result = _execute_adaptive_momentum(
        portfolio=reentering,
        provider=object(),
        candidates=["AAA"],
        signal_date="2025-02-11",
        today="2025-02-12",
        params={},
        opens={"AAA": 100.0},
        slippage_bps=0.0,
        risk_tier="NORMAL",
        prev_date="2025-02-11",
        force_risk_on_reentry=True,
    )
    assert result is None
    assert reentering.has_position("AAA")


def test_cautious_escalation_rebuilds_pending_target_before_buy(monkeypatch):
    portfolio = SimulatedPortfolio(starting_cash=1_000.0)
    bullish_market = SimpleNamespace(above_sma200=True)

    def build(*args, **kwargs):
        gross = 0.45 if kwargs["risk_tier"] == "CAUTIOUS" else 0.90
        return SimpleNamespace(weights={"NEW": gross})

    monkeypatch.setattr(
        engine, "compute_market_state", lambda *args, **kwargs: bullish_market
    )
    monkeypatch.setattr(engine, "build_target_portfolio", build)
    pending = {
        "signal_date": "2025-01-31",
        "weights": {"NEW": 0.90},
        "construction_risk_tier": "NORMAL",
        "buy_after_date": "2025-02-03",
    }

    _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["NEW"],
        signal_date="2025-02-03",
        today="2025-02-04",
        params={},
        opens={"NEW": 10.0},
        slippage_bps=0.0,
        risk_tier="CAUTIOUS",
        prev_date="2025-02-03",
        pending_plan=pending,
    )

    assert portfolio.get_position("NEW").market_value == 450.0


def test_daily_risk_off_cancels_pending_target(monkeypatch):
    portfolio = SimulatedPortfolio(starting_cash=1_000.0)
    monkeypatch.setattr(
        engine,
        "compute_market_state",
        lambda *args, **kwargs: SimpleNamespace(above_sma200=True),
    )
    pending = {
        "signal_date": "2025-01-31",
        "weights": {"NEW": 0.90},
        "construction_risk_tier": "NORMAL",
        "buy_after_date": "2025-02-03",
    }

    result = _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["NEW"],
        signal_date="2025-02-03",
        today="2025-02-04",
        params={},
        opens={"NEW": 10.0},
        slippage_bps=0.0,
        risk_tier="HALT",
        prev_date="2025-02-03",
        pending_plan=pending,
    )

    assert result is None
    assert not portfolio.has_position("NEW")


def test_unpriced_risk_off_exit_remains_pending_after_gate_recovers(monkeypatch):
    portfolio = SimulatedPortfolio(starting_cash=1_000.0)
    assert portfolio.open("AAA", 5, 100.0, "2025-01-02")
    monkeypatch.setattr(
        engine,
        "compute_market_state",
        lambda *args, **kwargs: SimpleNamespace(above_sma200=True),
    )
    monkeypatch.setattr(
        engine,
        "build_target_portfolio",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("risk-off exit intent was replaced by a risk-on target")
        ),
    )

    pending = _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["AAA"],
        signal_date="2025-02-03",
        today="2025-02-04",
        params={},
        opens={},
        slippage_bps=0.0,
        risk_tier="HALT",
        prev_date="2025-02-03",
    )

    assert portfolio.has_position("AAA")
    assert pending is not None
    assert pending["risk_off"] is True
    assert pending["weights"] == {}

    pending = _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["AAA"],
        signal_date="2025-02-04",
        today="2025-02-05",
        params={},
        opens={"AAA": 99.0},
        slippage_bps=0.0,
        risk_tier="NORMAL",
        prev_date="2025-02-04",
        pending_plan=pending,
    )

    assert pending is None
    assert not portfolio.has_position("AAA")
    assert portfolio.closed_trades[-1].reason == "adaptive_risk_off"


def test_pending_target_is_replanned_when_new_rebalance_month_starts(monkeypatch):
    portfolio = SimulatedPortfolio(starting_cash=1_000.0)
    monkeypatch.setattr(
        engine,
        "compute_market_state",
        lambda *args, **kwargs: SimpleNamespace(above_sma200=True),
    )
    observed_signal_dates: list[str] = []

    def build(_provider, _candidates, as_of, **_kwargs):
        observed_signal_dates.append(as_of)
        return SimpleNamespace(weights={"FRESH": 0.50})

    monkeypatch.setattr(engine, "build_target_portfolio", build)
    stale = {
        "signal_date": "2024-12-31",
        "weights": {"STALE": 0.50},
        "construction_risk_tier": "NORMAL",
        "buy_after_date": "2025-01-02",
        "rebalance_month": "2025-01",
    }

    _execute_adaptive_momentum(
        portfolio=portfolio,
        provider=object(),
        candidates=["FRESH", "STALE"],
        signal_date="2025-01-31",
        today="2025-02-03",
        params={},
        opens={"FRESH": 10.0, "STALE": 10.0},
        slippage_bps=0.0,
        risk_tier="NORMAL",
        prev_date="2025-01-31",
        pending_plan=stale,
    )

    assert observed_signal_dates == ["2025-01-31"]
    assert portfolio.has_position("FRESH")
    assert not portfolio.has_position("STALE")
