from __future__ import annotations

import math
from dataclasses import replace

import pandas as pd
import pytest

from adaptive_momentum import MarketState
from backtest.strategy_candidates import (
    CANDIDATE_BY_NAME,
    CANDIDATE_SPECS,
    MAX_STOCK_SECTOR_WEIGHT,
    MAX_STOCK_WEIGHT,
    SECTOR_ETFS,
    FactorSet,
    FactorSnapshot,
    PointInTimeFactorCache,
    _residual_factors,
    _score_rows,
    build_target_portfolio,
    candidate_manifest,
)


AS_OF = "2024-12-31"


class FrameProvider:
    """Test provider that intentionally ignores the requested cutoff."""

    def __init__(self, frames: dict[str, pd.DataFrame]):
        self.frames = frames
        self.calls: list[tuple[str, str, int | None]] = []

    def bars_up_to(self, symbol, date, lookback_days=None):
        self.calls.append((symbol, date, lookback_days))
        frame = self.frames.get(symbol)
        if frame is None:
            return pd.DataFrame()
        return frame.copy()


def _bars(
    *,
    end: str = AS_OF,
    periods: int = 253,
    start_price: float = 40.0,
    daily_return: float = 0.002,
    future_prices: tuple[float, ...] = (),
) -> pd.DataFrame:
    dates = pd.bdate_range(end=end, periods=periods)
    prices = [start_price * ((1.0 + daily_return) ** i) for i in range(periods)]
    frame = pd.DataFrame(
        {
            "close": prices,
            "volume": [5_000_000.0] * periods,
        },
        index=dates.strftime("%Y-%m-%d"),
    )
    if future_prices:
        future_dates = pd.bdate_range(start="2025-01-01", periods=len(future_prices))
        future = pd.DataFrame(
            {
                "close": list(future_prices),
                "volume": [5_000_000.0] * len(future_prices),
            },
            index=future_dates.strftime("%Y-%m-%d"),
        )
        frame = pd.concat([frame, future])
    return frame


def _factor(
    symbol: str,
    *,
    sector: str = "Technology",
    momentum_long: float = 20.0,
    momentum_medium: float = 10.0,
    volatility: float = 20.0,
    information_discreteness: float = -0.20,
    residual_score: float | None = 1.0,
    high_ratio: float = 0.95,
    five_day: float = -2.0,
    eligible: bool = True,
) -> FactorSnapshot:
    return FactorSnapshot(
        symbol=symbol,
        as_of=AS_OF,
        sector=sector,
        price=100.0,
        momentum_12_1_pct=momentum_long,
        momentum_6_1_pct=momentum_medium,
        annual_volatility_pct=volatility,
        median_dollar_volume_usd=100_000_000.0,
        sma200=90.0,
        above_sma200=True,
        high_52_week_ratio=high_ratio,
        five_session_return_pct=five_day,
        information_discreteness=information_discreteness,
        market_beta=1.0,
        residual_daily_volatility_pct=1.0,
        residual_momentum_score=residual_score,
        eligible=eligible,
    )


def _market() -> MarketState:
    return MarketState(
        as_of=AS_OF,
        price=500.0,
        sma200=450.0,
        above_sma200=True,
        annual_volatility_pct=15.0,
    )


def test_point_in_time_cache_physically_truncates_future_rows():
    historical = _bars(future_prices=(10_000.0, 20_000.0, 30_000.0))
    provider = FrameProvider({"AAA": historical, "SPY": _bars(daily_return=0.001)})
    cache = PointInTimeFactorCache()

    result = cache.get(
        provider,
        ["AAA"],
        AS_OF,
        sector_lookup=lambda _symbol: "Technology",
    )

    assert len(result.factors) == 1
    assert result.factors[0].price == pytest.approx(float(historical.loc[AS_OF, "close"]))
    assert result.factors[0].price < 1_000.0
    assert all(call[1] == AS_OF for call in provider.calls)


def test_cache_key_is_exact_provider_date_universe_and_sector_snapshot():
    frames = {
        "AAA": _bars(),
        "BBB": _bars(start_price=50.0),
        "SPY": _bars(daily_return=0.001),
    }
    provider = FrameProvider(frames)
    other_provider = FrameProvider(frames)
    cache = PointInTimeFactorCache()

    first = cache.get(
        provider,
        ["BBB", "AAA"],
        AS_OF,
        sector_lookup=lambda _symbol: "Technology",
    )
    reordered = cache.get(
        provider,
        ["AAA", "BBB"],
        AS_OF,
        sector_lookup=lambda _symbol: "Technology",
    )
    changed_universe = cache.get(
        provider,
        ["AAA"],
        AS_OF,
        sector_lookup=lambda _symbol: "Technology",
    )
    cache.get(
        other_provider,
        ["AAA"],
        AS_OF,
        sector_lookup=lambda _symbol: "Technology",
    )

    assert first is reordered
    assert changed_universe is not first
    assert cache.hits == 1
    assert cache.misses == 3


@pytest.mark.parametrize(
    "symbol_frame",
    [
        _bars(periods=252),
        _bars(end="2024-12-30"),
    ],
    ids=["missing_253rd_bar", "stale_latest_bar"],
)
def test_missing_or_stale_history_fails_closed(symbol_frame):
    provider = FrameProvider(
        {"AAA": symbol_frame, "SPY": _bars(daily_return=0.001)}
    )

    result = PointInTimeFactorCache().get(
        provider,
        ["AAA"],
        AS_OF,
        sector_lookup=lambda _symbol: "Technology",
    )

    assert result.factors == ()


def test_history_with_a_large_gap_fails_closed():
    frame = _bars()
    dates = list(frame.index)
    dates[120] = (pd.Timestamp(dates[119]) + pd.Timedelta(days=15)).strftime(
        "%Y-%m-%d"
    )
    frame.index = dates
    provider = FrameProvider({"AAA": frame, "SPY": _bars(daily_return=0.001)})

    result = PointInTimeFactorCache().get(
        provider,
        ["AAA"],
        AS_OF,
        sector_lookup=lambda _symbol: "Technology",
    )

    assert result.factors == ()


def test_common_stock_screen_rejects_unknown_sector_without_extra_filters():
    provider = FrameProvider({"AAA": _bars(), "SPY": _bars(daily_return=0.001)})

    factor = PointInTimeFactorCache().get(
        provider,
        ["AAA"],
        AS_OF,
        sector_lookup=lambda _symbol: "Unknown",
    ).factors[0]

    assert not factor.eligible
    assert factor.rejection_reasons == ("sector",)


def test_risk_adjusted_momentum_is_equal_percentile_rank_formula():
    factors = (
        _factor("AAA", momentum_long=30.0, momentum_medium=6.0, volatility=10.0),
        _factor("BBB", momentum_long=20.0, momentum_medium=30.0, volatility=20.0),
        _factor("CCC", momentum_long=10.0, momentum_medium=8.0, volatility=40.0),
    )

    rows = _score_rows(CANDIDATE_BY_NAME["risk_adjusted_momentum"], factors)
    by_symbol = {row.symbol: row for row in rows}

    assert [row.symbol for row in rows] == ["AAA", "BBB", "CCC"]
    assert by_symbol["AAA"].components[
        "momentum_12_1_over_vol_percentile"
    ] == pytest.approx(1.0)
    assert by_symbol["AAA"].components[
        "momentum_6_1_over_vol_percentile"
    ] == pytest.approx(2.0 / 3.0)
    assert by_symbol["AAA"].score == pytest.approx(5.0 / 6.0)


def test_residual_momentum_uses_frozen_beta_and_daily_residual_vol_formula():
    dates = pd.bdate_range(end=AS_OF, periods=253).strftime("%Y-%m-%d")
    market_returns = pd.Series(
        [0.001 + 0.0005 * math.sin(i / 4.0) for i in range(252)],
        index=dates[1:],
    )
    noise = pd.Series(
        [0.0003 * math.cos(i / 5.0) for i in range(252)],
        index=dates[1:],
    )
    stock_returns = 0.0002 + 1.4 * market_returns + noise
    spy_closes = pd.Series(
        [100.0] + list(100.0 * (1.0 + market_returns).cumprod()),
        index=dates,
    )
    stock_closes = pd.Series(
        [50.0] + list(50.0 * (1.0 + stock_returns).cumprod()),
        index=dates,
    )

    beta, daily_residual_vol_pct, score = _residual_factors(
        stock_closes, spy_closes
    )
    market_mean = float(market_returns.mean())
    stock_mean = float(stock_returns.mean())
    expected_beta = float(
        ((market_returns - market_mean) * (stock_returns - stock_mean)).sum()
        / ((market_returns - market_mean) ** 2).sum()
    )
    residual = stock_returns - (
        stock_mean - expected_beta * market_mean + expected_beta * market_returns
    )
    expected_daily_vol_pct = float(residual.std(ddof=1)) * 100.0
    stock_12_1 = (stock_closes.iloc[-22] / stock_closes.iloc[0] - 1.0) * 100.0
    spy_12_1 = (spy_closes.iloc[-22] / spy_closes.iloc[0] - 1.0) * 100.0
    expected_score = (
        stock_12_1 - expected_beta * spy_12_1
    ) / expected_daily_vol_pct

    assert beta == pytest.approx(expected_beta)
    assert daily_residual_vol_pct == pytest.approx(expected_daily_vol_pct)
    assert score == pytest.approx(expected_score)


def test_fip_and_low_vol_ensemble_are_exact_50_50_percentile_blends():
    factors = (
        _factor(
            "AAA",
            momentum_long=30.0,
            volatility=30.0,
            information_discreteness=-0.30,
        ),
        _factor(
            "BBB",
            momentum_long=20.0,
            volatility=10.0,
            information_discreteness=-0.10,
        ),
    )

    fip = {
        row.symbol: row for row in _score_rows(CANDIDATE_BY_NAME["fip_momentum"], factors)
    }
    ensemble = {
        row.symbol: row
        for row in _score_rows(
            CANDIDATE_BY_NAME["momentum_low_vol_ensemble"], factors
        )
    }

    assert fip["AAA"].score == pytest.approx(1.0)
    assert fip["BBB"].score == pytest.approx(0.5)
    assert ensemble["AAA"].score == pytest.approx(0.75)
    assert ensemble["BBB"].score == pytest.approx(0.75)


def test_sector_etf_momentum_uses_equal_percentile_blend_not_raw_sum():
    factors = (
        _factor("XLA", momentum_long=30.0, momentum_medium=5.0),
        _factor("XLB", momentum_long=10.0, momentum_medium=30.0),
    )

    rows = _score_rows(CANDIDATE_BY_NAME["sector_etf_momentum"], factors)
    by_symbol = {row.symbol: row for row in rows}

    assert by_symbol["XLA"].score == pytest.approx(0.75)
    assert by_symbol["XLB"].score == pytest.approx(0.75)
    assert [row.symbol for row in rows] == ["XLA", "XLB"]


def test_all_rank_ties_are_broken_by_symbol():
    factors = tuple(_factor(symbol) for symbol in ("CCC", "AAA", "BBB"))

    for name in (
        "high_52_week",
        "sector_neutral_momentum",
        "low_vol_trend",
        "short_term_reversal_negative_control",
    ):
        rows = _score_rows(CANDIDATE_BY_NAME[name], factors)
        assert [row.symbol for row in rows] == ["AAA", "BBB", "CCC"]


class StaticFactorCache:
    def __init__(self, stock_factors, etf_factors):
        self.stock_factors = tuple(stock_factors)
        self.etf_factors = tuple(etf_factors)

    def get(self, _provider, universe, as_of, *, sector_lookup=None):
        normalized = {str(symbol).upper() for symbol in universe}
        factors = (
            self.etf_factors
            if normalized == set(SECTOR_ETFS)
            else self.stock_factors
        )
        return FactorSet(
            as_of=as_of,
            universe=tuple(sorted(normalized)),
            factors=factors,
            market_state=_market(),
        )


def test_every_research_portfolio_respects_gross_name_and_sector_caps():
    sectors = ("Technology", "Financial", "Healthcare", "Industrial", "Energy")
    stocks = tuple(
        _factor(
            f"S{i:02d}",
            sector=sectors[i % len(sectors)],
            momentum_long=50.0 - i,
            momentum_medium=30.0 - i / 2.0,
            volatility=10.0 + i,
            residual_score=5.0 - i / 10.0,
            high_ratio=1.0 - i / 100.0,
            five_day=-float(i),
        )
        for i in range(30)
    )
    etfs = tuple(
        _factor(
            symbol,
            sector=f"ETF:{symbol}",
            momentum_long=30.0 - i,
            momentum_medium=20.0 - i,
            volatility=10.0 + i,
        )
        for i, symbol in enumerate(SECTOR_ETFS)
    )
    cache = StaticFactorCache(stocks, etfs)

    for spec in CANDIDATE_SPECS:
        if spec.delegated_control:
            continue
        target = build_target_portfolio(
            spec,
            object(),
            [factor.symbol for factor in stocks],
            AS_OF,
            sector_lookup=lambda symbol: next(
                factor.sector for factor in stocks if factor.symbol == symbol
            ),
            factor_cache=cache,
        )
        assert all(
            math.isfinite(weight) and weight >= 0
            for weight in target.weights.values()
        )
        assert sum(target.weights.values()) <= 0.90 + 1e-10
        if spec.asset_scope in {"stocks", "core_satellite"}:
            stock_weights = {
                symbol: weight
                for symbol, weight in target.weights.items()
                if symbol != "SPY"
            }
            assert max(stock_weights.values(), default=0.0) <= MAX_STOCK_WEIGHT + 1e-10
            by_sector: dict[str, float] = {}
            factor_map = {factor.symbol: factor for factor in stocks}
            for symbol, weight in stock_weights.items():
                sector = factor_map[symbol].sector
                by_sector[sector] = by_sector.get(sector, 0.0) + weight
            assert max(by_sector.values(), default=0.0) <= (
                MAX_STOCK_SECTOR_WEIGHT + 1e-10
            )
        if spec.name == "low_vol_trend":
            assert max(target.weights.values()) <= 0.045 + 1e-10
        if spec.name == "core_satellite":
            assert target.weights["SPY"] == pytest.approx(0.50)
            assert sum(
                weight
                for symbol, weight in target.weights.items()
                if symbol != "SPY"
            ) == pytest.approx(0.40)


def test_stock_candidates_apply_the_frozen_v11_breadth_scaler():
    sectors = ("Technology", "Financial", "Healthcare", "Industrial", "Energy")
    liquid = tuple(
        _factor(
            f"S{i:02d}",
            sector=sectors[i % len(sectors)],
            momentum_long=50.0 - i,
        )
        for i in range(20)
    )
    factors = tuple(
        factor
        if i < 10
        else replace(
            factor,
            above_sma200=False,
            eligible=False,
            rejection_reasons=("trend",),
        )
        for i, factor in enumerate(liquid)
    )
    cache = StaticFactorCache(factors, ())

    target = build_target_portfolio(
        "risk_adjusted_momentum",
        object(),
        [factor.symbol for factor in factors],
        AS_OF,
        sector_lookup=lambda symbol: next(
            factor.sector for factor in factors if factor.symbol == symbol
        ),
        factor_cache=cache,
    )

    assert target.breadth_pct == pytest.approx(50.0)
    assert target.target_gross_weight == pytest.approx(0.72)
    assert sum(target.weights.values()) == pytest.approx(0.72)


def test_sector_etf_candidate_uses_the_common_stock_breadth_gate():
    sectors = ("Technology", "Financial", "Healthcare", "Industrial", "Energy")
    stocks = tuple(
        _factor(
            f"S{i:02d}",
            sector=sectors[i % len(sectors)],
            momentum_long=50.0 - i,
        )
        for i in range(20)
    )
    stocks = tuple(
        factor
        if i < 10
        else replace(
            factor,
            above_sma200=False,
            eligible=False,
            rejection_reasons=("trend",),
        )
        for i, factor in enumerate(stocks)
    )
    etfs = tuple(
        _factor(
            symbol,
            sector=f"ETF:{symbol}",
            momentum_long=30.0 - i,
            momentum_medium=20.0 - i,
            volatility=10.0 + i,
        )
        for i, symbol in enumerate(SECTOR_ETFS)
    )

    target = build_target_portfolio(
        "sector_etf_momentum",
        object(),
        [factor.symbol for factor in stocks],
        AS_OF,
        sector_lookup=lambda symbol: next(
            factor.sector for factor in stocks if factor.symbol == symbol
        ),
        factor_cache=StaticFactorCache(stocks, etfs),
    )

    assert target.breadth_pct == pytest.approx(50.0)
    assert target.target_gross_weight == pytest.approx(0.72)
    assert sum(target.weights.values()) == pytest.approx(0.72)


def test_candidate_manifest_has_unique_locked_names_and_is_research_only():
    manifest = candidate_manifest()
    expected_names = {
        "v11_incumbent",
        "risk_adjusted_momentum",
        "market_residual_momentum",
        "fip_momentum",
        "high_52_week",
        "sector_neutral_momentum",
        "low_vol_trend",
        "momentum_low_vol_ensemble",
        "core_satellite",
        "sector_etf_momentum",
        "short_term_reversal_negative_control",
    }
    names = [entry["name"] for entry in manifest]

    assert set(names) == expected_names
    assert len(names) == len(set(names)) == len(CANDIDATE_SPECS)
    assert all(entry["research_only"] is True for entry in manifest)
    assert (
        CANDIDATE_BY_NAME["short_term_reversal_negative_control"].negative_control
        is True
    )
