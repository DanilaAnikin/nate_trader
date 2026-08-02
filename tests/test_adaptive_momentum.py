from __future__ import annotations

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from adaptive_momentum import (
    AdaptiveMomentumConfig,
    CandidateSignal,
    FrameBarProvider,
    SECTOR_BENCHMARKS,
    allocate_equal_weight,
    allocate_inverse_volatility,
    analyze_symbol,
    build_target_portfolio,
    compute_market_state,
    infer_sector_from_returns,
    market_reentry_confirmed,
    select_diversified,
)


class FrameProvider:
    def __init__(self, frames: dict[str, pd.DataFrame]):
        self.frames = frames

    def bars_up_to(self, symbol: str, date: str, lookback_days: int | None = None):
        frame = self.frames.get(symbol)
        if frame is None:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        out = frame.loc[frame.index <= date]
        return out.iloc[-lookback_days:] if lookback_days else out


def _frame(prices, *, volume=1_000_000, start="2020-01-01"):
    prices = np.asarray(prices, dtype=float)
    dates = pd.bdate_range(start, periods=len(prices)).strftime("%Y-%m-%d")
    return pd.DataFrame(
        {
            "open": prices,
            "high": prices * 1.01,
            "low": prices * 0.99,
            "close": prices,
            "volume": np.full(len(prices), volume, dtype=float),
        },
        index=dates,
    )


def _signal(symbol: str, vol: float, sector: str) -> CandidateSignal:
    return CandidateSignal(
        symbol=symbol,
        as_of="2025-01-01",
        price=100.0,
        momentum_12_1_pct=20.0,
        momentum_6_1_pct=10.0,
        annual_volatility_pct=vol,
        median_dollar_volume_usd=100_000_000,
        above_sma200=True,
        sector=sector,
        eligible=True,
    )


def test_signal_is_true_12_minus_1_and_ignores_recent_reversal():
    old = np.linspace(100, 200, 232)
    recent_crash = np.linspace(200, 80, 21)
    prices = np.concatenate([old, recent_crash])
    frame = _frame(prices, volume=1_000_000)
    as_of = frame.index[-1]
    signal = analyze_symbol(
        FrameProvider({"AAA": frame}),
        "AAA",
        as_of,
        sector="Technology",
    )
    assert signal is not None
    assert signal.momentum_12_1_pct > 90
    assert signal.price == pytest.approx(80.0)


def test_signal_rejects_illiquid_and_below_trend_names():
    falling = _frame(np.linspace(200, 100, 253), volume=1_000)
    signal = analyze_symbol(
        FrameProvider({"BAD": falling}), "BAD", falling.index[-1]
    )
    assert signal is not None
    assert signal.eligible is False
    assert "liquidity" in signal.rejection_reasons
    assert "trend" in signal.rejection_reasons
    assert "absolute_momentum" in signal.rejection_reasons


@pytest.mark.parametrize("invalid_volume", [np.nan, np.inf, -1.0])
def test_signal_rejects_invalid_liquidity_window(invalid_volume):
    frame = _frame(np.linspace(50, 150, 253), volume=2_000_000)
    frame.loc[frame.index[-20], "volume"] = invalid_volume

    signal = analyze_symbol(
        FrameProvider({"BAD": frame}),
        "BAD",
        frame.index[-1],
        sector="Technology",
    )

    assert signal is None


@pytest.mark.parametrize("invalid_close", [np.nan, np.inf, -np.inf])
def test_signal_rejects_non_finite_close_inside_required_window(invalid_close):
    frame = _frame(np.linspace(50, 150, 253), volume=2_000_000)
    frame.loc[frame.index[-100], "close"] = invalid_close

    assert (
        analyze_symbol(
            FrameProvider({"BAD": frame}),
            "BAD",
            frame.index[-1],
            sector="Technology",
        )
        is None
    )


@pytest.mark.parametrize("invalid_close", [np.nan, np.inf, -np.inf])
def test_market_state_rejects_non_finite_latest_spy_close(invalid_close):
    spy = _frame(np.linspace(100, 200, 253), volume=10_000_000)
    spy.loc[spy.index[-1], "close"] = invalid_close

    assert compute_market_state(FrameProvider({"SPY": spy}), spy.index[-1]) is None


@pytest.mark.parametrize("invalid_close", [np.nan, np.inf, -np.inf])
def test_market_state_rejects_non_finite_interior_spy_close(invalid_close):
    spy = _frame(np.linspace(100, 200, 253), volume=10_000_000)
    spy.loc[spy.index[-20], "close"] = invalid_close

    assert compute_market_state(FrameProvider({"SPY": spy}), spy.index[-1]) is None


def test_stale_symbol_data_is_not_ranked_as_if_it_traded_today():
    frame = _frame(np.linspace(50, 150, 253), volume=2_000_000)
    provider = FrameProvider({"STALE": frame})

    assert analyze_symbol(provider, "STALE", "2030-01-01") is None


def test_signal_does_not_bridge_a_multi_year_ticker_epoch_gap():
    frame = _frame(np.linspace(50, 150, 253), volume=2_000_000)
    old_dates = pd.bdate_range("2021-01-04", periods=200).strftime("%Y-%m-%d")
    new_dates = pd.bdate_range("2025-02-13", periods=53).strftime("%Y-%m-%d")
    frame.index = old_dates.append(new_dates)

    assert (
        analyze_symbol(
            FrameProvider({"REIPO": frame}),
            "REIPO",
            frame.index[-1],
            sector="Technology",
        )
        is None
    )


def test_market_state_does_not_bridge_a_multi_year_spy_gap():
    spy = _frame(np.linspace(100, 200, 200), volume=10_000_000)
    old_dates = pd.bdate_range("2020-01-02", periods=100).strftime("%Y-%m-%d")
    new_dates = pd.bdate_range("2025-01-02", periods=100).strftime("%Y-%m-%d")
    spy.index = old_dates.append(new_dates)

    assert compute_market_state(
        FrameProvider({"SPY": spy}),
        spy.index[-1],
    ) is None


def test_market_reentry_requires_each_confirmation_close_above_rolling_sma():
    rising = _frame(np.linspace(100, 200, 205), volume=10_000_000)
    provider = FrameProvider({"SPY": rising})

    assert market_reentry_confirmed(
        provider,
        rising.index[-1],
        confirmation_days=3,
    )

    interrupted = rising.copy()
    interrupted.loc[interrupted.index[-2], "close"] = 50.0
    assert not market_reentry_confirmed(
        FrameProvider({"SPY": interrupted}),
        interrupted.index[-1],
        confirmation_days=3,
    )


def test_inverse_vol_allocator_obeys_position_sector_and_gross_caps():
    signals = [
        _signal(f"T{i}", 15 + i, "Technology") for i in range(8)
    ] + [
        _signal(f"H{i}", 20 + i, "Healthcare") for i in range(8)
    ] + [
        _signal(f"F{i}", 18 + i, "Financial") for i in range(8)
    ] + [
        _signal(f"I{i}", 22 + i, "Industrial") for i in range(8)
    ] + [
        _signal(f"C{i}", 19 + i, "Consumer") for i in range(8)
    ]
    weights = allocate_inverse_volatility(
        signals, 0.90, max_position_pct=6.0, max_sector_pct=20.0
    )
    assert sum(weights.values()) == pytest.approx(0.90, abs=1e-8)
    assert max(weights.values()) <= 0.06 + 1e-10
    for sector in {s.sector for s in signals}:
        total = sum(weights.get(s.symbol, 0.0) for s in signals if s.sector == sector)
        assert total <= 0.20 + 1e-10


def test_underfilled_equal_weight_basket_still_obeys_sector_cap():
    signals = [
        _signal("AAA", 20.0, "Technology"),
        _signal("BBB", 20.0, "Technology"),
    ]

    weights = allocate_equal_weight(
        signals,
        0.225,
        max_position_pct=20.0,
        max_sector_pct=20.0,
    )

    assert sum(weights.values()) == pytest.approx(0.20)
    assert all(weight == pytest.approx(0.10) for weight in weights.values())


def test_buy_hold_rank_spread_retains_incumbent_inside_hold_band():
    ranked = [
        replace(
            _signal(symbol, 20.0, sector),
            momentum_12_1_pct=float(100 - rank),
        )
        for rank, (symbol, sector) in enumerate(
            [
                ("AAA", "Technology"),
                ("BBB", "Healthcare"),
                ("CCC", "Financial"),
                ("DDD", "Industrial"),
            ],
            start=1,
        )
    ]

    selected = select_diversified(
        ranked,
        top_n=2,
        hold_rank_n=4,
        incumbent_symbols=["CCC"],
        target_gross_weight=0.20,
        max_position_pct=10.0,
        max_sector_pct=20.0,
    )

    assert [signal.symbol for signal in selected] == ["CCC", "AAA"]


def test_buy_hold_rank_spread_drops_incumbent_outside_hold_band():
    ranked = [
        replace(
            _signal(symbol, 20.0, sector),
            momentum_12_1_pct=float(100 - rank),
        )
        for rank, (symbol, sector) in enumerate(
            [
                ("AAA", "Technology"),
                ("BBB", "Healthcare"),
                ("CCC", "Financial"),
            ],
            start=1,
        )
    ]

    selected = select_diversified(
        ranked,
        top_n=2,
        hold_rank_n=2,
        incumbent_symbols=["CCC"],
        target_gross_weight=0.20,
        max_position_pct=10.0,
        max_sector_pct=20.0,
    )

    assert [signal.symbol for signal in selected] == ["AAA", "BBB"]


def test_disabled_buy_hold_spread_preserves_original_rank_priority():
    ranked = [
        replace(_signal("AAA", 20.0, "Technology"), momentum_12_1_pct=30.0),
        replace(_signal("BBB", 20.0, "Technology"), momentum_12_1_pct=20.0),
        replace(_signal("CCC", 20.0, "Healthcare"), momentum_12_1_pct=10.0),
    ]

    selected = select_diversified(
        ranked,
        top_n=2,
        hold_rank_n=2,
        incumbent_symbols=["BBB"],
        target_gross_weight=0.20,
        max_position_pct=10.0,
        max_sector_pct=10.0,
    )

    assert [signal.symbol for signal in selected] == ["AAA", "CCC"]


def test_below_spy_sma200_targets_cash_not_inverse_etf():
    stock = _frame(np.linspace(50, 150, 253), volume=2_000_000)
    spy = _frame(np.linspace(200, 100, 253), volume=10_000_000)
    provider = FrameProvider({"AAA": stock, "SPY": spy})
    plan = build_target_portfolio(
        provider,
        ["AAA"],
        stock.index[-1],
        sector_lookup=lambda _s: "Technology",
        config=AdaptiveMomentumConfig(min_positions=1),
    )
    assert plan.weights == {}
    assert plan.cash_weight == pytest.approx(1.0)
    assert plan.market_state is not None and not plan.market_state.above_sma200


def test_halt_is_zero_exposure_and_cautious_reduces_normal():
    frames = {"SPY": _frame(np.linspace(100, 200, 253), volume=10_000_000)}
    sectors = ["Technology", "Healthcare", "Financial", "Industrial", "Consumer"]
    symbols = []
    for i in range(20):
        symbol = f"S{i}"
        symbols.append(symbol)
        frames[symbol] = _frame(np.linspace(50 + i, 150 + i, 253), volume=2_000_000)
    provider = FrameProvider(frames)

    def lookup(symbol):
        return sectors[int(symbol[1:]) % len(sectors)]

    cfg = AdaptiveMomentumConfig(min_positions=1)
    normal = build_target_portfolio(
        provider, symbols, frames["SPY"].index[-1], sector_lookup=lookup, config=cfg
    )
    cautious = build_target_portfolio(
        provider,
        symbols,
        frames["SPY"].index[-1],
        sector_lookup=lookup,
        risk_tier="CAUTIOUS",
        config=cfg,
    )
    halted = build_target_portfolio(
        provider,
        symbols,
        frames["SPY"].index[-1],
        sector_lookup=lookup,
        risk_tier="HALT",
        config=cfg,
    )
    assert sum(normal.weights.values()) > 0
    assert cautious.target_gross_weight == pytest.approx(
        normal.target_gross_weight * 0.5, rel=1e-6
    )
    assert sum(cautious.weights.values()) < sum(normal.weights.values())
    assert halted.weights == {}
    assert halted.cash_weight == pytest.approx(1.0)


def test_breadth_scaling_reduces_target_gross_without_changing_rank_rule():
    frames = {"SPY": _frame(np.linspace(100, 200, 253), volume=10_000_000)}
    symbols = []
    for index in range(10):
        symbol = f"S{index}"
        symbols.append(symbol)
        prices = (
            np.linspace(50 + index, 150 + index, 253)
            if index < 4
            else np.linspace(150 + index, 50 + index, 253)
        )
        frames[symbol] = _frame(prices, volume=2_000_000)
    provider = FrameProvider(frames)
    common = AdaptiveMomentumConfig(
        top_n=4,
        min_positions=1,
        max_position_pct=25.0,
        max_sector_pct=100.0,
    )

    unscaled = build_target_portfolio(
        provider,
        symbols,
        frames["SPY"].index[-1],
        sector_lookup=lambda _symbol: "Technology",
        config=common,
    )
    scaled = build_target_portfolio(
        provider,
        symbols,
        frames["SPY"].index[-1],
        sector_lookup=lambda _symbol: "Technology",
        config=replace(common, use_breadth_scaling=True),
    )

    assert scaled.breadth_pct == pytest.approx(40.0)
    assert unscaled.target_gross_weight == pytest.approx(0.90)
    assert scaled.target_gross_weight == pytest.approx(0.90 * 0.55)
    assert list(scaled.weights) == list(unscaled.weights)


def test_frame_provider_excludes_unfinished_current_session():
    dates = pd.to_datetime(["2025-01-02", "2025-01-03", "2025-01-06"], utc=True)
    frame = pd.DataFrame(
        {"close": [100.0, 101.0, 999.0], "volume": [1_000_000] * 3},
        index=dates,
    )

    provider = FrameBarProvider({"AAA": frame}, before_date="2025-01-06")

    assert provider.latest_date("AAA") == "2025-01-03"
    assert provider.bars_up_to("AAA", "2025-01-06")["close"].tolist() == [
        100.0,
        101.0,
    ]


def test_unknown_sector_is_inferred_from_point_in_time_sector_returns():
    dates = pd.bdate_range("2025-01-01", periods=70).strftime("%Y-%m-%d")
    tech_returns = np.tile([0.01, -0.004, 0.008, 0.002, -0.003], 14)
    other_returns = np.tile([-0.006, 0.007, -0.004, 0.006, 0.001], 14)

    def from_returns(returns):
        prices = 100 * np.cumprod(1 + returns)
        return pd.DataFrame(
            {"close": prices, "volume": np.full(len(prices), 1_000_000)},
            index=dates,
        )

    frames = {"MYST": from_returns(tech_returns)}
    for sector, benchmark in SECTOR_BENCHMARKS.items():
        returns = tech_returns if sector == "Technology" else other_returns
        frames[benchmark] = from_returns(returns)

    assert (
        infer_sector_from_returns(
            FrameProvider(frames), "MYST", dates[-1], lookback_days=63
        )
        == "Technology"
    )


def test_sector_inference_does_not_forward_fill_non_finite_stock_close():
    dates = pd.bdate_range("2025-01-01", periods=70).strftime("%Y-%m-%d")
    returns = np.tile([0.01, -0.004, 0.008, 0.002, -0.003], 14)

    def from_returns(values):
        prices = 100 * np.cumprod(1 + values)
        return pd.DataFrame(
            {"close": prices, "volume": np.full(len(prices), 1_000_000)},
            index=dates,
        )

    stock = from_returns(returns)
    stock.loc[dates[-20], "close"] = np.nan
    frames = {"MYST": stock}
    for benchmark in SECTOR_BENCHMARKS.values():
        frames[benchmark] = from_returns(returns)

    assert (
        infer_sector_from_returns(
            FrameProvider(frames), "MYST", dates[-1], lookback_days=63
        )
        == "Unknown"
    )
