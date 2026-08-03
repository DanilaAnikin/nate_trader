"""Frozen, research-only OHLCV strategy candidates.

This module deliberately sits below :mod:`scripts` production entry points.
It provides point-in-time rankings and constrained target portfolios for the
strategy tournament, but it is not imported by live trading code and cannot
place orders.  Candidate definitions are constants: changing a formula or a
portfolio rule creates a different experiment and must be reviewed as such.

Every stock candidate (apart from the delegated V11 control) shares one
eligibility screen: 253 contiguous adjusted daily bars ending exactly on the
signal date, price >= $10, 60-session median dollar volume >= $25m, a known
sector, close above SMA200, and positive 12-1 momentum.  Signals formed at D
are intended for execution no earlier than D+1.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import math
from types import MappingProxyType
from typing import Callable, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

import adaptive_momentum


LOOKBACK_DAYS = 252
SKIP_RECENT_DAYS = 21
MEDIUM_LOOKBACK_DAYS = 126
TREND_DAYS = 200
LIQUIDITY_DAYS = 60
MIN_PRICE_USD = 10.0
MIN_MEDIAN_DOLLAR_VOLUME_USD = 25_000_000.0
MAX_GROSS_WEIGHT = 0.90
MAX_STOCK_WEIGHT = 0.09
MAX_STOCK_SECTOR_WEIGHT = 0.20
LOW_VOL_MAX_STOCK_WEIGHT = 0.045

SECTOR_ETFS = (
    "XLK",
    "XLF",
    "XLV",
    "XLI",
    "XLY",
    "XLP",
    "XLE",
    "XLB",
    "XLU",
    "XLRE",
    "XLC",
)


@dataclass(frozen=True)
class CandidateSpec:
    """One immutable tournament entrant."""

    name: str
    description: str
    asset_scope: str
    rebalance_cadence: str
    ranking_formula: str
    top_n: int
    weighting: str
    max_position_weight: float
    max_sector_weight: float
    negative_control: bool = False
    delegated_control: bool = False
    research_only: bool = True


CANDIDATE_SPECS = (
    CandidateSpec(
        name="v11_incumbent",
        description="Frozen production V11 breadth-scaled 12-1 control",
        asset_scope="stocks",
        rebalance_cadence="monthly",
        ranking_formula="12-1 momentum; delegated to adaptive_momentum",
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
        delegated_control=True,
    ),
    CandidateSpec(
        name="risk_adjusted_momentum",
        description="Multi-horizon momentum scaled by 252-session volatility",
        asset_scope="stocks",
        rebalance_cadence="monthly",
        ranking_formula=(
            "equal percentile ranks of 12-1/252d-vol and 6-1/252d-vol"
        ),
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="market_residual_momentum",
        description="Momentum left after an OLS market-model projection",
        asset_scope="stocks",
        rebalance_cadence="monthly",
        ranking_formula=(
            "(stock 12-1 - beta * SPY 12-1) / residual daily volatility"
        ),
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="fip_momentum",
        description="Momentum combined with continuous information arrival",
        asset_scope="stocks",
        rebalance_cadence="monthly",
        ranking_formula=(
            "equal percentile ranks of 12-1 and inverse information discreteness"
        ),
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="high_52_week",
        description="Trend-qualified stocks closest to their 52-week high",
        asset_scope="stocks",
        rebalance_cadence="monthly",
        ranking_formula="latest adjusted close / latest 252-session high",
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="sector_neutral_momentum",
        description="12-1 momentum ranked within each known sector",
        asset_scope="stocks",
        rebalance_cadence="monthly",
        ranking_formula="within-sector percentile rank of 12-1 momentum",
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="low_vol_trend",
        description="Low-volatility stocks that already pass the trend screen",
        asset_scope="stocks",
        rebalance_cadence="quarterly",
        ranking_formula="ascending 252-session annualized volatility",
        top_n=20,
        weighting="inverse_volatility",
        max_position_weight=LOW_VOL_MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="momentum_low_vol_ensemble",
        description="Equal blend of momentum strength and low volatility",
        asset_scope="stocks",
        rebalance_cadence="monthly",
        ranking_formula=(
            "equal percentile ranks of 12-1 momentum and inverse 252d-vol"
        ),
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="core_satellite",
        description="50% SPY core plus 40% canonical stock-momentum satellite",
        asset_scope="core_satellite",
        rebalance_cadence="monthly",
        ranking_formula="50% SPY plus 40% top-ten canonical 12-1 stocks",
        top_n=10,
        weighting="core_satellite",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
    ),
    CandidateSpec(
        name="sector_etf_momentum",
        description="Trend-filtered momentum rotation across unlevered sectors",
        asset_scope="sector_etfs",
        rebalance_cadence="monthly",
        ranking_formula="positive 12-1 + 6-1 momentum, above SMA200",
        top_n=3,
        weighting="inverse_volatility",
        max_position_weight=MAX_GROSS_WEIGHT,
        max_sector_weight=MAX_GROSS_WEIGHT,
    ),
    CandidateSpec(
        name="short_term_reversal_negative_control",
        description="Weekly five-session reversal negative control",
        asset_scope="stocks",
        rebalance_cadence="weekly",
        ranking_formula="ascending five-session return",
        top_n=10,
        weighting="equal",
        max_position_weight=MAX_STOCK_WEIGHT,
        max_sector_weight=MAX_STOCK_SECTOR_WEIGHT,
        negative_control=True,
    ),
)

CANDIDATE_BY_NAME: Mapping[str, CandidateSpec] = MappingProxyType(
    {spec.name: spec for spec in CANDIDATE_SPECS}
)


@dataclass(frozen=True)
class FactorSnapshot:
    """All OHLCV factors for one symbol at one completed session."""

    symbol: str
    as_of: str
    sector: str
    price: float
    momentum_12_1_pct: float
    momentum_6_1_pct: float
    annual_volatility_pct: float
    median_dollar_volume_usd: float
    sma200: float
    above_sma200: bool
    high_52_week_ratio: float
    five_session_return_pct: float
    information_discreteness: float
    market_beta: float | None
    residual_daily_volatility_pct: float | None
    residual_momentum_score: float | None
    eligible: bool
    rejection_reasons: tuple[str, ...] = ()

    def as_candidate_signal(self) -> adaptive_momentum.CandidateSignal:
        """Adapt the research factors to the audited portfolio allocators."""

        return adaptive_momentum.CandidateSignal(
            symbol=self.symbol,
            as_of=self.as_of,
            price=self.price,
            momentum_12_1_pct=self.momentum_12_1_pct,
            momentum_6_1_pct=self.momentum_6_1_pct,
            annual_volatility_pct=self.annual_volatility_pct,
            median_dollar_volume_usd=self.median_dollar_volume_usd,
            above_sma200=self.above_sma200,
            sector=self.sector,
            eligible=self.eligible,
            rejection_reasons=self.rejection_reasons,
        )


@dataclass(frozen=True)
class FactorSet:
    """Cached result for an exact provider/date/universe request."""

    as_of: str
    universe: tuple[str, ...]
    factors: tuple[FactorSnapshot, ...]
    market_state: adaptive_momentum.MarketState | None

    @property
    def eligible(self) -> tuple[FactorSnapshot, ...]:
        return tuple(factor for factor in self.factors if factor.eligible)


@dataclass(frozen=True)
class ScoredCandidate:
    """A deterministic rank row with auditable score components."""

    factor: FactorSnapshot
    score: float
    components: Mapping[str, float] = field(default_factory=dict)

    @property
    def symbol(self) -> str:
        return self.factor.symbol


def _normalise_symbols(symbols: Iterable[str]) -> tuple[str, ...]:
    return tuple(
        sorted({str(symbol).upper().strip() for symbol in symbols if symbol})
    )


def _known_sector(value: str | None) -> bool:
    return bool(value and value.strip() and value.strip().casefold() != "unknown")


def _causal_window(provider, symbol: str, as_of: str) -> pd.DataFrame | None:
    """Return exactly 253 valid sessions and physically discard future rows."""

    # The provider contract already returns rows sorted by session.  Asking it
    # to slice from the right before copying/converting the frame is materially
    # cheaper for a broad-universe tournament and is identical to taking the
    # same trailing window below.
    bars = provider.bars_up_to(
        symbol,
        as_of,
        lookback_days=LOOKBACK_DAYS + 1,
    )
    if bars is None or len(bars) < LOOKBACK_DAYS + 1:
        return None
    if not {"close", "volume"}.issubset(bars.columns):
        return None
    frame = bars.loc[:, ["close", "volume"]]
    try:
        dates = np.asarray(frame.index, dtype="datetime64[D]")
        cutoff = np.datetime64(as_of, "D")
    except (TypeError, ValueError):
        return None
    if np.any(np.isnat(dates)) or np.unique(dates).size != dates.size:
        return None

    order = np.argsort(dates, kind="stable")
    if not np.array_equal(order, np.arange(dates.size)):
        frame = frame.iloc[order]
        dates = dates[order]
    if dates.size and dates[-1] > cutoff:
        eligible_rows = np.flatnonzero(dates <= cutoff)
        frame = frame.iloc[eligible_rows]
        dates = dates[eligible_rows]
    frame = frame.iloc[-(LOOKBACK_DAYS + 1) :]
    dates = dates[-(LOOKBACK_DAYS + 1) :]
    if len(frame) != LOOKBACK_DAYS + 1:
        return None
    if dates[-1] != cutoff:
        return None
    gaps = np.diff(dates).astype("timedelta64[D]").astype(np.int64)
    if np.any(gaps > 10):
        return None

    try:
        closes = frame["close"].to_numpy(dtype=float, copy=False)
        volumes = frame["volume"].to_numpy(dtype=float, copy=False)
    except (TypeError, ValueError):
        return None
    if not np.all(np.isfinite(closes) & (closes > 0.0)):
        return None
    if not np.all(np.isfinite(volumes) & (volumes >= 0.0)):
        return None
    # Normalize only the tiny returned index. The numeric columns remain
    # read-only views/copies supplied by the causal provider.
    frame.index = pd.Index(np.datetime_as_string(dates, unit="D"))
    return frame


def _residual_factors(
    stock_closes: pd.Series,
    spy_closes: pd.Series | None,
) -> tuple[float | None, float | None, float | None]:
    """Return beta, daily residual vol, and the frozen residual-momentum score."""

    if spy_closes is None:
        return None, None, None
    if len(stock_closes) != LOOKBACK_DAYS + 1 or not stock_closes.index.equals(
        spy_closes.index
    ):
        return None, None, None
    try:
        stock_prices = stock_closes.to_numpy(dtype=float, copy=False)
        market_prices = spy_closes.to_numpy(dtype=float, copy=False)
        stock = stock_prices[1:] / stock_prices[:-1] - 1.0
        market = market_prices[1:] / market_prices[:-1] - 1.0
    except (FloatingPointError, TypeError, ValueError):
        return None, None, None
    if not np.all(np.isfinite(stock)) or not np.all(np.isfinite(market)):
        return None, None, None

    market_mean = float(np.mean(market))
    stock_mean = float(np.mean(stock))
    market_variance = float(np.sum((market - market_mean) ** 2))
    if not math.isfinite(market_variance) or market_variance <= 1e-18:
        return None, None, None
    beta = float(np.sum((market - market_mean) * (stock - stock_mean))) / (
        market_variance
    )
    alpha = stock_mean - beta * market_mean
    residuals = stock - (alpha + beta * market)
    residual_std = float(np.std(residuals, ddof=1))
    if not math.isfinite(residual_std) or residual_std <= 0:
        return None, None, None

    stock_momentum = (
        stock_prices[-(SKIP_RECENT_DAYS + 1)] / stock_prices[0] - 1.0
    ) * 100.0
    spy_momentum = (
        market_prices[-(SKIP_RECENT_DAYS + 1)] / market_prices[0] - 1.0
    ) * 100.0
    daily_vol_pct = residual_std * 100.0
    score = (stock_momentum - beta * spy_momentum) / daily_vol_pct
    if not all(math.isfinite(value) for value in (beta, daily_vol_pct, score)):
        return None, None, None
    return beta, daily_vol_pct, score


def _analyze_factor(
    provider,
    symbol: str,
    as_of: str,
    *,
    sector: str,
    spy_closes: pd.Series | None,
) -> FactorSnapshot | None:
    frame = _causal_window(provider, symbol, as_of)
    if frame is None:
        return None
    closes = frame["close"]
    try:
        close_values = closes.to_numpy(dtype=float, copy=False)
        volume_values = frame["volume"].to_numpy(dtype=float, copy=False)
        daily_returns = close_values[1:] / close_values[:-1] - 1.0
    except (FloatingPointError, TypeError, ValueError):
        return None
    if (
        len(close_values) != LOOKBACK_DAYS + 1
        or not np.all(np.isfinite(close_values) & (close_values > 0.0))
        or not np.all(np.isfinite(volume_values) & (volume_values >= 0.0))
        or not np.all(np.isfinite(daily_returns))
    ):
        return None

    momentum_long = (
        close_values[-(SKIP_RECENT_DAYS + 1)] / close_values[0] - 1.0
    ) * 100.0
    momentum_medium = (
        close_values[-(SKIP_RECENT_DAYS + 1)]
        / close_values[-(MEDIUM_LOOKBACK_DAYS + 1)]
        - 1.0
    ) * 100.0
    annual_volatility = float(np.std(daily_returns, ddof=1)) * math.sqrt(252.0) * 100.0
    if not math.isfinite(annual_volatility) or annual_volatility <= 0.0:
        return None

    price = float(close_values[-1])
    sma200 = float(np.mean(close_values[-TREND_DAYS:]))
    median_dollar_volume = float(
        np.median((close_values * volume_values)[-LIQUIDITY_DAYS:])
    )
    high = float(np.max(close_values[-LOOKBACK_DAYS:]))
    high_ratio = price / high
    five_session_return = (price / float(close_values[-6]) - 1.0) * 100.0
    formation_returns = (
        close_values[1:-SKIP_RECENT_DAYS]
        / close_values[: -(SKIP_RECENT_DAYS + 1)]
        - 1.0
    )
    positive_days = int(np.count_nonzero(formation_returns > 0.0))
    negative_days = int(np.count_nonzero(formation_returns < 0.0))
    sign = 1.0 if momentum_long > 0 else -1.0 if momentum_long < 0 else 0.0
    information_discreteness = sign * (
        (negative_days - positive_days) / len(formation_returns)
    )
    market_beta, residual_volatility, residual_score = _residual_factors(
        closes, spy_closes
    )

    reasons: list[str] = []
    if price < MIN_PRICE_USD:
        reasons.append("price")
    if (
        not math.isfinite(median_dollar_volume)
        or median_dollar_volume < MIN_MEDIAN_DOLLAR_VOLUME_USD
    ):
        reasons.append("liquidity")
    if not _known_sector(sector):
        reasons.append("sector")
    above_sma200 = price > sma200
    if not above_sma200:
        reasons.append("trend")
    if momentum_long <= 0:
        reasons.append("absolute_momentum")

    values = (
        price,
        momentum_long,
        momentum_medium,
        annual_volatility,
        median_dollar_volume,
        sma200,
        high_ratio,
        five_session_return,
        information_discreteness,
    )
    if not all(math.isfinite(value) for value in values):
        return None
    return FactorSnapshot(
        symbol=symbol,
        as_of=as_of,
        sector=sector.strip() if _known_sector(sector) else "Unknown",
        price=price,
        momentum_12_1_pct=momentum_long,
        momentum_6_1_pct=momentum_medium,
        annual_volatility_pct=annual_volatility,
        median_dollar_volume_usd=median_dollar_volume,
        sma200=sma200,
        above_sma200=above_sma200,
        high_52_week_ratio=high_ratio,
        five_session_return_pct=five_session_return,
        information_discreteness=information_discreteness,
        market_beta=market_beta,
        residual_daily_volatility_pct=residual_volatility,
        residual_momentum_score=residual_score,
        eligible=not reasons,
        rejection_reasons=tuple(reasons),
    )


class PointInTimeFactorCache:
    """Memoize only an exact provider/date/universe/sector snapshot.

    The provider identity and the normalized sector mapping are part of the
    cache key.  A different date or one-symbol universe change is therefore a
    mandatory miss; no nearby-date or subset reuse can leak unavailable data.
    """

    def __init__(self) -> None:
        self._cache: dict[tuple[object, ...], FactorSet] = {}
        self._providers: dict[int, object] = {}
        self.hits = 0
        self.misses = 0

    def clear(self) -> None:
        self._cache.clear()
        self._providers.clear()
        self.hits = 0
        self.misses = 0

    def get(
        self,
        provider,
        universe: Iterable[str],
        as_of: str,
        *,
        sector_lookup: Callable[[str], str] | None = None,
    ) -> FactorSet:
        symbols = _normalise_symbols(universe)
        lookup = sector_lookup or (lambda _symbol: "Unknown")
        sectors: list[tuple[str, str]] = []
        for symbol in symbols:
            try:
                sector = str(lookup(symbol) or "Unknown").strip() or "Unknown"
            except Exception:
                sector = "Unknown"
            sectors.append((symbol, sector))

        declared_identity = getattr(provider, "cache_identity", None)
        if isinstance(declared_identity, int):
            provider_key: object = ("declared", declared_identity)
        else:
            provider_id = id(provider)
            known_provider = self._providers.get(provider_id)
            if known_provider is not None and known_provider is not provider:
                self.clear()  # defensive against Python object-id reuse
            self._providers[provider_id] = provider
            provider_key = ("object", provider_id)
        key = (provider_key, str(as_of), symbols, tuple(sectors))
        cached = self._cache.get(key)
        if cached is not None:
            self.hits += 1
            return cached

        self.misses += 1
        spy_frame = _causal_window(provider, "SPY", as_of)
        spy_closes = spy_frame["close"] if spy_frame is not None else None
        factors: list[FactorSnapshot] = []
        sector_map = dict(sectors)
        for symbol in symbols:
            factor = _analyze_factor(
                provider,
                symbol,
                as_of,
                sector=sector_map[symbol],
                spy_closes=spy_closes,
            )
            if factor is not None:
                factors.append(factor)

        market_state: adaptive_momentum.MarketState | None = None
        if spy_frame is not None:
            spy_closes = spy_frame["close"]
            spy_volatility = adaptive_momentum._annualized_volatility_pct(  # noqa: SLF001
                spy_closes, LOOKBACK_DAYS
            )
            spy_price = float(spy_closes.iloc[-1])
            spy_sma200 = float(spy_closes.iloc[-TREND_DAYS:].mean())
            if (
                spy_volatility is not None
                and all(
                    math.isfinite(value) and value > 0
                    for value in (spy_price, spy_sma200, spy_volatility)
                )
            ):
                market_state = adaptive_momentum.MarketState(
                    as_of=as_of,
                    price=spy_price,
                    sma200=spy_sma200,
                    above_sma200=spy_price > spy_sma200,
                    annual_volatility_pct=spy_volatility,
                )
        result = FactorSet(
            as_of=as_of,
            universe=symbols,
            factors=tuple(factors),
            market_state=market_state,
        )
        self._cache[key] = result
        return result


# Short alias for callers that do not need the implementation detail in a name.
FactorSnapshotCache = PointInTimeFactorCache


def _resolve_spec(spec_or_name: CandidateSpec | str) -> CandidateSpec:
    if isinstance(spec_or_name, CandidateSpec):
        registered = CANDIDATE_BY_NAME.get(spec_or_name.name)
        if registered != spec_or_name:
            raise ValueError(f"Candidate spec is not frozen: {spec_or_name.name}")
        return spec_or_name
    try:
        return CANDIDATE_BY_NAME[str(spec_or_name)]
    except KeyError as exc:
        raise ValueError(f"Unknown candidate: {spec_or_name}") from exc


def _percentile_scores(
    values: Mapping[str, float],
    *,
    higher_is_better: bool = True,
) -> dict[str, float]:
    """Average-tie percentile ranks; final symbol ordering breaks score ties."""

    finite = {
        symbol: float(value)
        for symbol, value in values.items()
        if math.isfinite(float(value))
    }
    if not finite:
        return {}
    series = pd.Series(finite, dtype=float)
    ranks = series.rank(method="average", pct=True, ascending=higher_is_better)
    return {str(symbol): float(value) for symbol, value in ranks.items()}


def _score_rows(
    spec: CandidateSpec,
    factors: Sequence[FactorSnapshot],
) -> list[ScoredCandidate]:
    eligible = [factor for factor in factors if factor.eligible]
    by_symbol = {factor.symbol: factor for factor in eligible}
    components: dict[str, dict[str, float]] = {symbol: {} for symbol in by_symbol}

    if spec.name == "v11_incumbent":
        for factor in eligible:
            components[factor.symbol] = {"momentum_12_1": factor.momentum_12_1_pct}
    elif spec.name == "risk_adjusted_momentum":
        long_raw = {
            factor.symbol: factor.momentum_12_1_pct / factor.annual_volatility_pct
            for factor in eligible
            if factor.annual_volatility_pct > 0
        }
        medium_raw = {
            factor.symbol: factor.momentum_6_1_pct / factor.annual_volatility_pct
            for factor in eligible
            if factor.annual_volatility_pct > 0
        }
        long_pct = _percentile_scores(long_raw)
        medium_pct = _percentile_scores(medium_raw)
        components = {
            symbol: {
                "momentum_12_1_over_vol_percentile": long_pct[symbol],
                "momentum_6_1_over_vol_percentile": medium_pct[symbol],
            }
            for symbol in sorted(set(long_pct) & set(medium_pct))
        }
    elif spec.name == "market_residual_momentum":
        components = {
            factor.symbol: {"residual_cumulative_over_vol": float(score)}
            for factor in eligible
            if (score := factor.residual_momentum_score) is not None
            and math.isfinite(score)
        }
    elif spec.name == "fip_momentum":
        momentum_pct = _percentile_scores(
            {factor.symbol: factor.momentum_12_1_pct for factor in eligible}
        )
        continuous_pct = _percentile_scores(
            {factor.symbol: factor.information_discreteness for factor in eligible},
            higher_is_better=False,
        )
        components = {
            symbol: {
                "momentum_percentile": momentum_pct[symbol],
                "continuous_information_percentile": continuous_pct[symbol],
            }
            for symbol in sorted(set(momentum_pct) & set(continuous_pct))
        }
    elif spec.name == "high_52_week":
        components = {
            factor.symbol: {"high_52_week_ratio": factor.high_52_week_ratio}
            for factor in eligible
        }
    elif spec.name == "sector_neutral_momentum":
        components = {}
        sectors = sorted({factor.sector for factor in eligible})
        for sector in sectors:
            sector_scores = _percentile_scores(
                {
                    factor.symbol: factor.momentum_12_1_pct
                    for factor in eligible
                    if factor.sector == sector
                }
            )
            for symbol, score in sector_scores.items():
                components[symbol] = {"within_sector_momentum_percentile": score}
    elif spec.name == "low_vol_trend":
        components = {
            factor.symbol: {"inverse_annual_volatility": -factor.annual_volatility_pct}
            for factor in eligible
            if factor.annual_volatility_pct > 0
        }
    elif spec.name == "momentum_low_vol_ensemble":
        momentum_pct = _percentile_scores(
            {factor.symbol: factor.momentum_12_1_pct for factor in eligible}
        )
        low_vol_pct = _percentile_scores(
            {
                factor.symbol: factor.annual_volatility_pct
                for factor in eligible
                if factor.annual_volatility_pct > 0
            },
            higher_is_better=False,
        )
        components = {
            symbol: {
                "momentum_percentile": momentum_pct[symbol],
                "low_vol_percentile": low_vol_pct[symbol],
            }
            for symbol in sorted(set(momentum_pct) & set(low_vol_pct))
        }
    elif spec.name == "core_satellite":
        components = {
            factor.symbol: {"momentum_12_1": factor.momentum_12_1_pct}
            for factor in eligible
        }
    elif spec.name == "short_term_reversal_negative_control":
        components = {
            factor.symbol: {"inverse_five_session_return": -factor.five_session_return_pct}
            for factor in eligible
        }
    elif spec.name == "sector_etf_momentum":
        eligible_etfs = [
            factor
            for factor in factors
            if factor.above_sma200
            and factor.momentum_12_1_pct > 0
            and factor.momentum_6_1_pct > 0
            and factor.annual_volatility_pct > 0
        ]
        long_pct = _percentile_scores(
            {factor.symbol: factor.momentum_12_1_pct for factor in eligible_etfs}
        )
        medium_pct = _percentile_scores(
            {factor.symbol: factor.momentum_6_1_pct for factor in eligible_etfs}
        )
        components = {
            symbol: {
                "momentum_12_1_percentile": long_pct[symbol],
                "momentum_6_1_percentile": medium_pct[symbol],
            }
            for symbol in sorted(set(long_pct) & set(medium_pct))
        }
        by_symbol = {factor.symbol: factor for factor in factors}
    else:  # pragma: no cover - every frozen spec is handled above
        raise ValueError(f"Unsupported candidate: {spec.name}")

    rows: list[ScoredCandidate] = []
    for symbol, row_components in components.items():
        if not row_components or symbol not in by_symbol:
            continue
        score = sum(row_components.values()) / len(row_components)
        if math.isfinite(score):
            rows.append(
                ScoredCandidate(
                    factor=by_symbol[symbol],
                    score=score,
                    components=MappingProxyType(dict(row_components)),
                )
            )
    if spec.name == "sector_neutral_momentum":
        return sorted(
            rows,
            key=lambda row: (
                -row.score,
                -row.factor.momentum_12_1_pct,
                row.symbol,
            ),
        )
    return sorted(rows, key=lambda row: (-row.score, row.symbol))


def rank_candidates(
    spec_or_name: CandidateSpec | str,
    provider,
    universe: Iterable[str],
    as_of: str,
    *,
    sector_lookup: Callable[[str], str] | None = None,
    factor_cache: PointInTimeFactorCache | None = None,
) -> tuple[ScoredCandidate, ...]:
    """Return the complete deterministic ranking for one frozen candidate."""

    spec = _resolve_spec(spec_or_name)
    cache = factor_cache or PointInTimeFactorCache()
    if spec.asset_scope == "sector_etfs":
        factor_set = cache.get(
            provider,
            SECTOR_ETFS,
            as_of,
            sector_lookup=lambda symbol: f"ETF:{symbol}",
        )
    else:
        factor_set = cache.get(
            provider,
            universe,
            as_of,
            sector_lookup=sector_lookup,
        )
    return tuple(_score_rows(spec, factor_set.factors))


def _risk_scaler(risk_tier: str) -> float:
    return {"NORMAL": 1.0, "CAUTIOUS": 0.5, "HALT": 0.0}.get(
        str(risk_tier).upper(), 0.0
    )


def _stock_breadth_pct(factors: Sequence[FactorSnapshot]) -> float | None:
    """Match V11 breadth over the liquid/price-qualified stock population."""

    liquid = [
        factor
        for factor in factors
        if "price" not in factor.rejection_reasons
        and "liquidity" not in factor.rejection_reasons
    ]
    if not liquid:
        return None
    return sum(factor.above_sma200 for factor in liquid) / len(liquid) * 100.0


def _select(
    rows: Sequence[ScoredCandidate],
    spec: CandidateSpec,
    *,
    incumbent_symbols: Iterable[str],
) -> list[adaptive_momentum.CandidateSignal]:
    signals = [row.factor.as_candidate_signal() for row in rows]
    return adaptive_momentum.select_diversified(
        signals,
        top_n=spec.top_n,
        hold_rank_n=spec.top_n,
        incumbent_symbols=incumbent_symbols,
        target_gross_weight=MAX_GROSS_WEIGHT,
        max_position_pct=spec.max_position_weight * 100.0,
        max_sector_pct=spec.max_sector_weight * 100.0,
    )


def _allocate_proportional(
    desired: Mapping[str, float],
    factors: Mapping[str, FactorSnapshot],
    *,
    target_gross: float,
    max_position: float,
    max_sector: float,
) -> dict[str, float]:
    """Project positive desired weights into transparent name/sector caps."""

    raw = {
        symbol: float(weight)
        for symbol, weight in desired.items()
        if symbol in factors and math.isfinite(float(weight)) and weight > 0
    }
    if not raw or target_gross <= 0:
        return {}
    weights = {symbol: 0.0 for symbol in raw}
    for _ in range(100):
        remaining = target_gross - sum(weights.values())
        if remaining <= 1e-10:
            break
        sector_used: dict[str, float] = {}
        for symbol, weight in weights.items():
            sector = factors[symbol].sector
            sector_used[sector] = sector_used.get(sector, 0.0) + weight
        active = [
            symbol
            for symbol in sorted(raw)
            if weights[symbol] < max_position - 1e-10
            and sector_used.get(factors[symbol].sector, 0.0) < max_sector - 1e-10
        ]
        if not active:
            break
        raw_total = sum(raw[symbol] for symbol in active)
        if raw_total <= 0:
            break
        proposed = {
            symbol: min(
                remaining * raw[symbol] / raw_total,
                max_position - weights[symbol],
            )
            for symbol in active
        }
        proposed_by_sector: dict[str, float] = {}
        for symbol, amount in proposed.items():
            sector = factors[symbol].sector
            proposed_by_sector[sector] = proposed_by_sector.get(sector, 0.0) + amount
        added = 0.0
        for symbol in active:
            sector = factors[symbol].sector
            room = max_sector - sector_used.get(sector, 0.0)
            proposed_sector = proposed_by_sector[sector]
            scale = min(1.0, room / proposed_sector) if proposed_sector > 0 else 0.0
            amount = max(0.0, proposed[symbol] * scale)
            weights[symbol] += amount
            added += amount
        if added <= 1e-10:
            break
    return {symbol: weight for symbol, weight in weights.items() if weight > 1e-8}


def _core_satellite_weights(
    factors: Sequence[FactorSnapshot],
    *,
    risk_scaler: float,
) -> dict[str, float]:
    spec = CANDIDATE_BY_NAME["core_satellite"]
    satellite_rows = _score_rows(spec, factors)
    satellite_signals = _select(satellite_rows, spec, incumbent_symbols=())
    satellite = adaptive_momentum.allocate_equal_weight(
        satellite_signals,
        0.40 * risk_scaler,
        max_position_pct=MAX_STOCK_WEIGHT * 100.0,
        max_sector_pct=MAX_STOCK_SECTOR_WEIGHT * 100.0,
    )
    return {"SPY": 0.50 * risk_scaler, **satellite}


def _validate_weights(
    weights: Mapping[str, float],
    factors: Mapping[str, FactorSnapshot],
    *,
    stock_caps: bool,
) -> None:
    if any(
        not math.isfinite(weight) or weight < 0 or weight > MAX_GROSS_WEIGHT + 1e-10
        for weight in weights.values()
    ):
        raise AssertionError("candidate produced an invalid weight")
    if sum(weights.values()) > MAX_GROSS_WEIGHT + 1e-10:
        raise AssertionError("candidate exceeded the 90% gross cap")
    if not stock_caps:
        return
    stock_weights = {
        symbol: weight for symbol, weight in weights.items() if symbol in factors
    }
    if any(weight > MAX_STOCK_WEIGHT + 1e-10 for weight in stock_weights.values()):
        raise AssertionError("stock candidate exceeded the 9% name cap")
    sectors: dict[str, float] = {}
    for symbol, weight in stock_weights.items():
        sector = factors[symbol].sector
        sectors[sector] = sectors.get(sector, 0.0) + weight
    if any(weight > MAX_STOCK_SECTOR_WEIGHT + 1e-10 for weight in sectors.values()):
        raise AssertionError("stock candidate exceeded the 20% sector cap")


def build_target_portfolio(
    spec_or_name: CandidateSpec | str,
    provider,
    universe: Iterable[str],
    as_of: str,
    *,
    sector_lookup: Callable[[str], str] | None = None,
    incumbent_symbols: Iterable[str] = (),
    risk_tier: str = "NORMAL",
    factor_cache: PointInTimeFactorCache | None = None,
) -> adaptive_momentum.TargetPortfolio:
    """Build a research target; this function has no broker side effects."""

    spec = _resolve_spec(spec_or_name)
    if spec.delegated_control:
        config = replace(
            adaptive_momentum.AdaptiveMomentumConfig(),
            use_breadth_scaling=True,
            risk_on_reentry_confirmation_days=1,
        )
        return adaptive_momentum.build_target_portfolio(
            provider,
            universe,
            as_of,
            sector_lookup=sector_lookup,
            incumbent_symbols=incumbent_symbols,
            risk_tier=risk_tier,
            config=config,
        )

    cache = factor_cache or PointInTimeFactorCache()
    if spec.asset_scope == "sector_etfs":
        factor_set = cache.get(
            provider,
            SECTOR_ETFS,
            as_of,
            sector_lookup=lambda symbol: f"ETF:{symbol}",
        )
        # The preregistered common contract applies the V11 SPY and broad-stock
        # exposure gates to every candidate unless its own clause says
        # otherwise. Sector ETFs are ranked on their own bars, but their gross
        # exposure therefore uses the same causal stock breadth snapshot.
        gate_factor_set = cache.get(
            provider,
            universe,
            as_of,
            sector_lookup=sector_lookup,
        )
    else:
        factor_set = cache.get(
            provider,
            universe,
            as_of,
            sector_lookup=sector_lookup,
        )
        gate_factor_set = factor_set
    rows = _score_rows(spec, factor_set.factors)
    risk_scaler = _risk_scaler(risk_tier)
    breadth_pct = _stock_breadth_pct(gate_factor_set.factors)
    if spec.asset_scope in {"stocks", "core_satellite", "sector_etfs"}:
        if (
            gate_factor_set.market_state is None
            or not gate_factor_set.market_state.above_sma200
        ):
            risk_scaler = 0.0
    if spec.asset_scope in {"stocks", "sector_etfs"}:
        risk_scaler *= adaptive_momentum._breadth_scaler(breadth_pct)  # noqa: SLF001
    target_gross = MAX_GROSS_WEIGHT * risk_scaler

    if spec.name == "core_satellite":
        weights = _core_satellite_weights(
            factor_set.factors,
            risk_scaler=risk_scaler,
        )
    else:
        selected = _select(rows, spec, incumbent_symbols=incumbent_symbols)
        if spec.weighting == "inverse_volatility":
            weights = adaptive_momentum.allocate_inverse_volatility(
                selected,
                target_gross,
                max_position_pct=spec.max_position_weight * 100.0,
                max_sector_pct=spec.max_sector_weight * 100.0,
            )
        elif spec.weighting == "equal":
            weights = adaptive_momentum.allocate_equal_weight(
                selected,
                target_gross,
                max_position_pct=spec.max_position_weight * 100.0,
                max_sector_pct=spec.max_sector_weight * 100.0,
            )
        else:  # pragma: no cover - core/satellite is handled above
            raise ValueError(f"Unsupported weighting: {spec.weighting}")

    factor_map = {factor.symbol: factor for factor in factor_set.factors}
    _validate_weights(
        weights,
        factor_map,
        stock_caps=spec.asset_scope in {"stocks", "core_satellite"},
    )
    invested = min(MAX_GROSS_WEIGHT, sum(weights.values()))
    return adaptive_momentum.TargetPortfolio(
        as_of=as_of,
        weights=weights,
        cash_weight=max(0.0, 1.0 - invested),
        target_gross_weight=target_gross,
        market_state=gate_factor_set.market_state,
        breadth_pct=breadth_pct,
        eligible_count=len(rows),
        diagnostics={
            "strategy_candidate": spec.name,
            "research_only": True,
            "rebalance_cadence": spec.rebalance_cadence,
            "negative_control": spec.negative_control,
            "evaluated_count": len(factor_set.factors),
            "selected_count": len(weights),
            "risk_tier": str(risk_tier).upper(),
        },
    )


def candidate_manifest() -> tuple[dict[str, object], ...]:
    """Return a serialization-friendly copy of the frozen candidate manifest."""

    return tuple(
        {
            "name": spec.name,
            "description": spec.description,
            "asset_scope": spec.asset_scope,
            "rebalance_cadence": spec.rebalance_cadence,
            "ranking_formula": spec.ranking_formula,
            "top_n": spec.top_n,
            "weighting": spec.weighting,
            "max_position_weight": spec.max_position_weight,
            "max_sector_weight": spec.max_sector_weight,
            "negative_control": spec.negative_control,
            "delegated_control": spec.delegated_control,
            "research_only": spec.research_only,
        }
        for spec in CANDIDATE_SPECS
    )


__all__ = [
    "CANDIDATE_SPECS",
    "CANDIDATE_BY_NAME",
    "SECTOR_ETFS",
    "CandidateSpec",
    "FactorSnapshot",
    "FactorSet",
    "ScoredCandidate",
    "PointInTimeFactorCache",
    "FactorSnapshotCache",
    "candidate_manifest",
    "rank_candidates",
    "build_target_portfolio",
]
