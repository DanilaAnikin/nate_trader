"""Causal, diversified cross-sectional momentum portfolio construction.

This module is deliberately broker-free.  It consumes a point-in-time bar
provider and produces target weights; execution is a separate concern.  The
signal follows the standard ``12-1`` convention: rank the prior twelve-month
return while excluding the most recent trading month.

All weights are decimal fractions (``0.05`` means five percent of equity).
Signals are formed from data available at ``as_of`` and are intended to be
filled no earlier than the next session.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
from typing import Callable, Iterable

import pandas as pd


SECTOR_BENCHMARKS = {
    "Technology": "XLK",
    "Financial": "XLF",
    "Healthcare": "XLV",
    "Industrial": "XLI",
    "Consumer": "XLY",
    "Energy": "XLE",
    "Materials": "XLB",
    "Utilities": "XLU",
    "RealEstate": "XLRE",
    "Communication": "XLC",
}


@dataclass(frozen=True)
class AdaptiveMomentumConfig:
    """Conservative production defaults chosen before holdout evaluation."""

    lookback_days: int = 252
    skip_recent_days: int = 21
    medium_lookback_days: int = 126
    trend_days: int = 200
    volatility_days: int = 63
    liquidity_days: int = 60
    min_price_usd: float = 10.0
    min_median_dollar_volume_usd: float = 25_000_000.0
    max_annual_volatility_pct: float = 80.0
    top_n: int = 10
    hold_rank_n: int = 10
    min_positions: int = 8
    max_position_pct: float = 9.0
    max_sector_pct: float = 20.0
    max_gross_exposure_pct: float = 90.0
    target_market_volatility_pct: float = 15.0
    min_volatility_scaler: float = 0.25
    weighting_scheme: str = "equal"
    use_market_volatility_scaling: bool = False
    use_breadth_scaling: bool = False
    risk_on_reentry_confirmation_days: int = 0
    # RESEARCH ONLY (default 0.0 = V11 unchanged). When > 0, the SPY-SMA200 gate
    # becomes graduated instead of all-or-nothing: below SMA200 the book keeps up
    # to this percent of gross (scaled by the same breadth/vol/diversification
    # scalers) rather than exiting fully to cash. Never set in the fixed V11
    # policy; usable only via a research override, so V11's identity is preserved.
    below_sma200_floor_pct: float = 0.0
    require_sector_classification: bool = True
    excluded_symbols: frozenset[str] = frozenset(
        {
            "SPY", "QQQ", "SH", "SSO", "TQQQ", "UPRO", "SQQQ", "SPXU",
            "SPXL", "SOXL", "SOXS", "UVXY", "VXX",
        }
    )


@dataclass(frozen=True)
class CandidateSignal:
    symbol: str
    as_of: str
    price: float
    momentum_12_1_pct: float
    momentum_6_1_pct: float
    annual_volatility_pct: float
    median_dollar_volume_usd: float
    above_sma200: bool
    sector: str
    eligible: bool
    rejection_reasons: tuple[str, ...] = ()

    @property
    def score(self) -> float:
        """Primary rank is canonical 12-1 return; 6-1 only breaks ties."""

        return self.momentum_12_1_pct


@dataclass(frozen=True)
class UniverseScan:
    signals: tuple[CandidateSignal, ...]
    ranked: tuple[CandidateSignal, ...]
    evaluated_count: int
    liquid_count: int
    breadth_pct: float | None


@dataclass(frozen=True)
class MarketState:
    as_of: str
    price: float
    sma200: float
    above_sma200: bool
    annual_volatility_pct: float


@dataclass(frozen=True)
class TargetPortfolio:
    as_of: str
    weights: dict[str, float]
    cash_weight: float
    target_gross_weight: float
    market_state: MarketState | None
    breadth_pct: float | None
    eligible_count: int
    diagnostics: dict[str, float | int | str | bool | None] = field(default_factory=dict)


class FrameBarProvider:
    """Point-in-time provider over already-fetched frames for live planning."""

    def __init__(self, frames: dict[str, pd.DataFrame], *, before_date: str | None = None):
        self.frames: dict[str, pd.DataFrame] = {}
        for symbol, original in frames.items():
            frame = original.copy()
            if isinstance(frame.index, pd.MultiIndex):
                frame = frame.droplevel(0)
            if not frame.empty:
                frame.index = pd.Index(
                    [
                        value.strftime("%Y-%m-%d")
                        if hasattr(value, "strftime")
                        else str(value)[:10]
                        for value in frame.index
                    ]
                )
                frame = frame[~frame.index.duplicated(keep="last")].sort_index()
                if before_date is not None:
                    frame = frame.loc[frame.index < before_date]
            self.frames[symbol.upper()] = frame

    def bars_up_to(
        self, symbol: str, date: str, lookback_days: int | None = None
    ) -> pd.DataFrame:
        frame = self.frames.get(symbol.upper())
        if frame is None or frame.empty:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        sliced = frame.loc[frame.index <= date]
        return sliced.iloc[-lookback_days:] if lookback_days else sliced

    def latest_date(self, symbol: str) -> str | None:
        frame = self.frames.get(symbol.upper())
        if frame is None or frame.empty:
            return None
        return str(frame.index[-1])


def config_from_params(params: dict) -> AdaptiveMomentumConfig:
    """Build one shared configuration for live and simulated execution."""

    top_n = int(params.get("momentum_top_n", 10))
    return AdaptiveMomentumConfig(
        min_price_usd=float(params.get("momentum_min_price_usd", 10.0)),
        min_median_dollar_volume_usd=float(
            params.get("momentum_min_dollar_volume_usd", 25_000_000.0)
        ),
        max_annual_volatility_pct=float(
            params.get("momentum_max_annual_vol_pct", 80.0)
        ),
        top_n=top_n,
        hold_rank_n=max(
            top_n,
            int(params.get("momentum_hold_rank_n", top_n)),
        ),
        min_positions=int(params.get("momentum_min_positions", 8)),
        max_position_pct=float(params.get("max_position_pct", 9.0)),
        max_sector_pct=float(params.get("momentum_max_sector_pct", 20.0)),
        max_gross_exposure_pct=max(
            0.0, 100.0 - float(params.get("min_cash_pct", 10.0))
        ),
        target_market_volatility_pct=float(
            params.get("momentum_target_market_vol_pct", 15.0)
        ),
        weighting_scheme=str(params.get("momentum_weighting_scheme", "equal")),
        use_market_volatility_scaling=bool(
            params.get("momentum_use_market_volatility_scaling", False)
        ),
        use_breadth_scaling=bool(
            params.get("momentum_use_breadth_scaling", False)
        ),
        risk_on_reentry_confirmation_days=max(
            0,
            int(params.get("momentum_risk_on_reentry_days", 0)),
        ),
        below_sma200_floor_pct=max(
            0.0, float(params.get("momentum_below_sma200_floor_pct", 0.0))
        ),
    )


def _has_contiguous_signal_epoch(
    index: pd.Index,
    *,
    max_calendar_gap_days: int = 10,
) -> bool:
    """Reject a lookback that silently bridges a halt, delisting, or relisting.

    Normal weekends and US market holidays fit comfortably inside ten calendar
    days. A larger gap requires a complete fresh lookback before the symbol can
    become eligible again, preventing returns from being joined across ticker
    identity epochs.
    """

    if len(index) < 2:
        return True
    try:
        dates = pd.DatetimeIndex(pd.to_datetime(index, errors="raise"))
    except (TypeError, ValueError):
        return False
    gaps = dates.to_series().diff().dropna().dt.days
    return bool((gaps <= max_calendar_gap_days).all())


def _period_return_pct(closes: pd.Series, lookback: int, skip_recent: int) -> float | None:
    """Return from ``lookback`` sessions ago to ``skip_recent`` sessions ago."""

    if lookback <= skip_recent or len(closes) < lookback + 1:
        return None
    window = pd.to_numeric(
        closes.iloc[-(lookback + 1) :], errors="coerce"
    ).astype(float)
    if not window.map(lambda value: math.isfinite(value) and value > 0).all():
        return None
    start = float(window.iloc[0])
    end = float(window.iloc[-(skip_recent + 1)])
    return (end / start - 1.0) * 100.0


def _annualized_volatility_pct(closes: pd.Series, days: int) -> float | None:
    if days <= 1 or len(closes) < days + 1:
        return None
    window = pd.to_numeric(
        closes.iloc[-(days + 1) :], errors="coerce"
    ).astype(float)
    if not window.map(lambda value: math.isfinite(value) and value > 0).all():
        return None
    returns = window.pct_change(fill_method=None).dropna()
    if len(returns) != days or not returns.map(math.isfinite).all():
        return None
    value = float(returns.std(ddof=1)) * math.sqrt(252.0) * 100.0
    return value if math.isfinite(value) and value > 0 else None


def analyze_symbol(
    provider,
    symbol: str,
    as_of: str,
    *,
    sector: str = "Unknown",
    config: AdaptiveMomentumConfig | None = None,
) -> CandidateSignal | None:
    """Compute one point-in-time signal, including explicit rejection reasons."""

    cfg = config or AdaptiveMomentumConfig()
    symbol = symbol.upper().strip()
    if not symbol or symbol in cfg.excluded_symbols:
        return None

    required = max(
        cfg.lookback_days + 1,
        cfg.trend_days,
        cfg.volatility_days + 1,
        cfg.liquidity_days,
    )
    bars = provider.bars_up_to(symbol, as_of, lookback_days=required + 5)
    if bars is None or len(bars) < required:
        return None
    if str(bars.index[-1])[:10] != as_of:
        return None  # stale/suspended/delisted data must never become a signal
    required_columns = {"close", "volume"}
    if not required_columns.issubset(bars.columns):
        return None

    closes = pd.to_numeric(bars["close"], errors="coerce").astype(float)
    volumes = pd.to_numeric(bars["volume"], errors="coerce").astype(float)
    required_closes = closes.iloc[-required:]
    if not required_closes.map(
        lambda value: math.isfinite(value) and value > 0
    ).all():
        return None
    if not _has_contiguous_signal_epoch(bars.index[-required:]):
        return None
    liquidity_volumes = volumes.iloc[-cfg.liquidity_days :]
    if not liquidity_volumes.map(
        lambda value: math.isfinite(value) and value >= 0
    ).all():
        return None
    price = float(closes.iloc[-1])
    momentum_long = _period_return_pct(closes, cfg.lookback_days, cfg.skip_recent_days)
    momentum_medium = _period_return_pct(
        closes, cfg.medium_lookback_days, cfg.skip_recent_days
    )
    annual_vol = _annualized_volatility_pct(closes, cfg.volatility_days)
    sma200 = float(closes.iloc[-cfg.trend_days :].mean())
    if not math.isfinite(sma200) or sma200 <= 0:
        return None
    above_sma200 = price > sma200
    dollar_volume = (closes * volumes).iloc[-cfg.liquidity_days :]
    median_dollar_volume = float(dollar_volume.median())

    if momentum_long is None or momentum_medium is None or annual_vol is None:
        return None

    reasons: list[str] = []
    if price < cfg.min_price_usd:
        reasons.append("price")
    if (
        not math.isfinite(median_dollar_volume)
        or median_dollar_volume <= 0
        or median_dollar_volume < cfg.min_median_dollar_volume_usd
    ):
        reasons.append("liquidity")
    if annual_vol > cfg.max_annual_volatility_pct:
        reasons.append("volatility")
    if cfg.require_sector_classification and (not sector or sector == "Unknown"):
        reasons.append("sector")
    if not above_sma200:
        reasons.append("trend")
    if momentum_long <= 0:
        reasons.append("absolute_momentum")

    return CandidateSignal(
        symbol=symbol,
        as_of=as_of,
        price=price,
        momentum_12_1_pct=momentum_long,
        momentum_6_1_pct=momentum_medium,
        annual_volatility_pct=annual_vol,
        median_dollar_volume_usd=median_dollar_volume,
        above_sma200=above_sma200,
        sector=sector or "Unknown",
        eligible=not reasons,
        rejection_reasons=tuple(reasons),
    )


def scan_universe(
    provider,
    candidates: Iterable[str],
    as_of: str,
    *,
    sector_lookup: Callable[[str], str] | None = None,
    config: AdaptiveMomentumConfig | None = None,
) -> UniverseScan:
    """Evaluate and rank a broad universe using only information at ``as_of``."""

    cfg = config or AdaptiveMomentumConfig()
    lookup = sector_lookup or (lambda _symbol: "Unknown")
    signals: list[CandidateSignal] = []
    for symbol in sorted({s.upper().strip() for s in candidates if s}):
        signal = analyze_symbol(
            provider,
            symbol,
            as_of,
            sector=lookup(symbol),
            config=cfg,
        )
        if signal is not None:
            signals.append(signal)

    ranked = sorted(
        (s for s in signals if s.eligible),
        key=lambda s: (-s.momentum_12_1_pct, -s.momentum_6_1_pct, s.symbol),
    )
    liquid = [
        s
        for s in signals
        if "price" not in s.rejection_reasons
        and "liquidity" not in s.rejection_reasons
    ]
    breadth = None
    if liquid:
        breadth = sum(1 for s in liquid if s.above_sma200) / len(liquid) * 100.0

    return UniverseScan(
        signals=tuple(signals),
        ranked=tuple(ranked),
        evaluated_count=len(signals),
        liquid_count=len(liquid),
        breadth_pct=breadth,
    )


def compute_market_state(
    provider,
    as_of: str,
    *,
    config: AdaptiveMomentumConfig | None = None,
) -> MarketState | None:
    cfg = config or AdaptiveMomentumConfig()
    required = max(cfg.trend_days, cfg.volatility_days + 1)
    bars = provider.bars_up_to("SPY", as_of, lookback_days=required + 5)
    if bars is None or len(bars) < required or "close" not in bars.columns:
        return None
    if str(bars.index[-1])[:10] != as_of:
        return None
    closes = pd.to_numeric(bars["close"], errors="coerce").astype(float)
    required_closes = closes.iloc[-required:]
    if not required_closes.map(
        lambda value: math.isfinite(value) and value > 0
    ).all():
        return None
    if not _has_contiguous_signal_epoch(bars.index[-required:]):
        return None
    price = float(closes.iloc[-1])
    sma200 = float(closes.iloc[-cfg.trend_days :].mean())
    annual_vol = _annualized_volatility_pct(closes, cfg.volatility_days)
    if (
        annual_vol is None
        or not math.isfinite(price)
        or price <= 0
        or not math.isfinite(sma200)
        or sma200 <= 0
    ):
        return None
    return MarketState(
        as_of=as_of,
        price=price,
        sma200=sma200,
        above_sma200=price > sma200,
        annual_volatility_pct=annual_vol,
    )


def market_reentry_confirmed(
    provider,
    as_of: str,
    *,
    confirmation_days: int,
    config: AdaptiveMomentumConfig | None = None,
) -> bool:
    """Return whether SPY closed above its rolling SMA for N sessions.

    This is used only for a one-shot recovery entry after a prior risk-off
    liquidation. Ordinary monthly rebalances continue to use the latest
    completed-session market state.
    """

    cfg = config or AdaptiveMomentumConfig()
    days = int(confirmation_days)
    if days <= 0:
        return False
    required = cfg.trend_days + days - 1
    bars = provider.bars_up_to("SPY", as_of, lookback_days=required + 5)
    if (
        bars is None
        or len(bars) < required
        or "close" not in bars.columns
        or str(bars.index[-1])[:10] != as_of
    ):
        return False
    bars = bars.iloc[-required:]
    if not _has_contiguous_signal_epoch(bars.index):
        return False
    closes = pd.to_numeric(bars["close"], errors="coerce").astype(float)
    if not closes.map(lambda value: math.isfinite(value) and value > 0).all():
        return False
    for offset in range(days):
        end = cfg.trend_days + offset
        window = closes.iloc[end - cfg.trend_days : end]
        sma = float(window.mean())
        if not math.isfinite(sma) or float(window.iloc[-1]) <= sma:
            return False
    return True


def infer_sector_from_returns(
    provider,
    symbol: str,
    as_of: str,
    *,
    lookback_days: int = 63,
) -> str:
    """Classify an unmapped symbol by its strongest sector-ETF correlation.

    This keeps dynamic-universe names inside the same point-in-time sector
    caps as static watchlist names. A weak or unavailable relationship remains
    ``Unknown`` instead of fabricating precision.
    """

    bars = provider.bars_up_to(symbol, as_of, lookback_days=lookback_days + 5)
    if bars is None or len(bars) < 40 or "close" not in bars.columns:
        return "Unknown"
    stock_closes = pd.to_numeric(bars["close"], errors="coerce").astype(float)
    stock_window = stock_closes.iloc[-(lookback_days + 1) :]
    if not stock_window.map(
        lambda value: math.isfinite(value) and value > 0
    ).all():
        return "Unknown"
    stock_returns = stock_window.pct_change(fill_method=None).dropna()
    if not stock_returns.map(math.isfinite).all():
        return "Unknown"
    best_sector = "Unknown"
    best_correlation = 0.20
    for sector, benchmark in SECTOR_BENCHMARKS.items():
        sector_bars = provider.bars_up_to(
            benchmark, as_of, lookback_days=lookback_days + 5
        )
        if sector_bars is None or len(sector_bars) < 40 or "close" not in sector_bars:
            continue
        sector_closes = pd.to_numeric(
            sector_bars["close"], errors="coerce"
        ).astype(float)
        sector_window = sector_closes.iloc[-(lookback_days + 1) :]
        if not sector_window.map(
            lambda value: math.isfinite(value) and value > 0
        ).all():
            continue
        sector_returns = sector_window.pct_change(fill_method=None).dropna()
        if not sector_returns.map(math.isfinite).all():
            continue
        aligned = pd.concat([stock_returns, sector_returns], axis=1).dropna().iloc[
            -lookback_days:
        ]
        if len(aligned) < 40:
            continue
        correlation = float(aligned.iloc[:, 0].corr(aligned.iloc[:, 1]))
        if math.isfinite(correlation) and correlation > best_correlation:
            best_sector = sector
            best_correlation = correlation
    return best_sector


def _breadth_scaler(breadth_pct: float | None) -> float:
    if breadth_pct is None:
        return 0.5  # fail defensive when broad-market confirmation is missing
    if breadth_pct >= 60.0:
        return 1.0
    if breadth_pct >= 45.0:
        return 0.80
    if breadth_pct >= 30.0:
        return 0.55
    return 0.25


def _risk_tier_scaler(risk_tier: str) -> float:
    return {"NORMAL": 1.0, "CAUTIOUS": 0.5, "HALT": 0.0}.get(
        risk_tier.upper(), 0.0
    )


def _target_gross_weight(
    market: MarketState | None,
    scan: UniverseScan,
    risk_tier: str,
    cfg: AdaptiveMomentumConfig,
) -> float:
    if market is None:
        return 0.0
    below = not market.above_sma200
    # V11 default: all-or-nothing exit below SMA200. The graduated floor only
    # engages when the research param is set (never in the fixed V11 policy).
    if below and cfg.below_sma200_floor_pct <= 0.0:
        return 0.0
    vol_scaler = 1.0
    if cfg.use_market_volatility_scaling:
        vol_scaler = min(
            1.0,
            max(
                cfg.min_volatility_scaler,
                cfg.target_market_volatility_pct / market.annual_volatility_pct,
            ),
        )
    breadth_scaler = (
        _breadth_scaler(scan.breadth_pct) if cfg.use_breadth_scaling else 1.0
    )
    diversification_scaler = min(
        1.0, len(scan.ranked) / max(1, cfg.min_positions)
    )
    gross = (
        cfg.max_gross_exposure_pct
        / 100.0
        * vol_scaler
        * breadth_scaler
        * diversification_scaler
        * _risk_tier_scaler(risk_tier)
    )
    cap = cfg.max_gross_exposure_pct / 100.0
    if below:
        # Graduated gate: below SMA200, cap gross at the research floor instead
        # of exiting fully. The floor is still scaled by the ordinary risk
        # scalers, so it de-risks — just not all the way to cash.
        cap = min(cap, cfg.below_sma200_floor_pct / 100.0)
        gross = min(gross, cap)
    return max(0.0, min(cap, gross))


def allocate_inverse_volatility(
    signals: Iterable[CandidateSignal],
    target_gross_weight: float,
    *,
    max_position_pct: float,
    max_sector_pct: float,
) -> dict[str, float]:
    """Allocate inverse-vol weights under hard position and sector caps.

    This is intentionally a transparent constrained allocator, not a claim of
    full covariance-based risk parity.  Unallocatable residual stays in cash.
    """

    selected = list(signals)
    if not selected or target_gross_weight <= 0:
        return {}
    max_position = max_position_pct / 100.0
    max_sector = max_sector_pct / 100.0
    raw = {
        s.symbol: 1.0 / max(s.annual_volatility_pct / 100.0, 1e-6)
        for s in selected
    }
    by_symbol = {s.symbol: s for s in selected}

    def sector_bucket(symbol: str) -> str:
        """Do not pretend that every unclassified company is one sector.

        A missing classification is still visible in diagnostics, but grouping
        all ``Unknown`` names together would accidentally cap the entire
        portfolio at one sector limit.  Liquidity, trend and single-name caps
        remain in force for these names.
        """

        sector = (by_symbol[symbol].sector or "Unknown").strip()
        return f"Unknown:{symbol}" if sector == "Unknown" else sector
    weights = {s.symbol: 0.0 for s in selected}

    for _ in range(100):
        remaining = target_gross_weight - sum(weights.values())
        if remaining <= 1e-10:
            break
        sector_used: dict[str, float] = {}
        for symbol, weight in weights.items():
            sector = sector_bucket(symbol)
            sector_used[sector] = sector_used.get(sector, 0.0) + weight

        active = [
            symbol
            for symbol in weights
            if max_position - weights[symbol] > 1e-10
            and max_sector - sector_used.get(sector_bucket(symbol), 0.0)
            > 1e-10
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
        sector_proposed: dict[str, float] = {}
        for symbol, amount in proposed.items():
            sector = sector_bucket(symbol)
            sector_proposed[sector] = sector_proposed.get(sector, 0.0) + amount

        added = 0.0
        for symbol in active:
            sector = sector_bucket(symbol)
            room = max_sector - sector_used.get(sector, 0.0)
            total_for_sector = sector_proposed.get(sector, 0.0)
            scale = min(1.0, room / total_for_sector) if total_for_sector > 0 else 0.0
            amount = max(0.0, proposed[symbol] * scale)
            weights[symbol] += amount
            added += amount
        if added <= 1e-10:
            break

    return {symbol: weight for symbol, weight in weights.items() if weight > 1e-8}


def _sector_bucket(signal: CandidateSignal) -> str:
    sector = (signal.sector or "Unknown").strip()
    return f"Unknown:{signal.symbol}" if sector == "Unknown" else sector


def select_diversified(
    ranked: Iterable[CandidateSignal],
    *,
    top_n: int,
    hold_rank_n: int | None = None,
    incumbent_symbols: Iterable[str] = (),
    target_gross_weight: float,
    max_position_pct: float,
    max_sector_pct: float,
) -> list[CandidateSignal]:
    """Take strong names under caps, optionally with a buy/hold rank spread.

    New names compete in ordinary rank order. Existing names are considered
    first while they remain inside ``hold_rank_n``. This creates an explicit
    inaction region around the entry cutoff, reducing churn without allowing a
    position whose signal has materially decayed to remain indefinitely.
    """

    if top_n <= 0 or target_gross_weight <= 0:
        return []
    ranked_list = list(ranked)
    retention_limit = max(top_n, hold_rank_n or top_n)
    incumbents = {
        str(symbol).upper().strip() for symbol in incumbent_symbols if symbol
    }
    if retention_limit > top_n:
        retained = [
            signal
            for signal in ranked_list[:retention_limit]
            if signal.symbol in incumbents
        ]
        retained_symbols = {signal.symbol for signal in retained}
        priority = retained + [
            signal
            for signal in ranked_list
            if signal.symbol not in retained_symbols
        ]
    else:
        priority = ranked_list

    slot = min(target_gross_weight / top_n, max_position_pct / 100.0)
    sector_cap = max_sector_pct / 100.0
    sector_used: dict[str, float] = {}
    selected: list[CandidateSignal] = []
    for signal in priority:
        bucket = _sector_bucket(signal)
        if sector_used.get(bucket, 0.0) + slot > sector_cap + 1e-12:
            continue
        selected.append(signal)
        sector_used[bucket] = sector_used.get(bucket, 0.0) + slot
        if len(selected) >= top_n:
            break
    return selected


def allocate_equal_weight(
    signals: Iterable[CandidateSignal],
    target_gross_weight: float,
    *,
    max_position_pct: float,
    max_sector_pct: float,
) -> dict[str, float]:
    """Equal weights under hard single-name, sector, and gross caps."""

    selected = list(signals)
    if not selected or target_gross_weight <= 0:
        return {}
    max_position = max_position_pct / 100.0
    max_sector = max_sector_pct / 100.0
    by_symbol = {signal.symbol: signal for signal in selected}
    weights = {signal.symbol: 0.0 for signal in selected}

    for _ in range(100):
        remaining = target_gross_weight - sum(weights.values())
        if remaining <= 1e-10:
            break
        sector_used: dict[str, float] = {}
        for symbol, weight in weights.items():
            bucket = _sector_bucket(by_symbol[symbol])
            sector_used[bucket] = sector_used.get(bucket, 0.0) + weight
        active = [
            symbol
            for symbol in weights
            if weights[symbol] < max_position - 1e-10
            and sector_used.get(_sector_bucket(by_symbol[symbol]), 0.0)
            < max_sector - 1e-10
        ]
        if not active:
            break
        equal_add = remaining / len(active)
        proposed = {
            symbol: min(equal_add, max_position - weights[symbol])
            for symbol in active
        }
        sector_proposed: dict[str, float] = {}
        for symbol, amount in proposed.items():
            bucket = _sector_bucket(by_symbol[symbol])
            sector_proposed[bucket] = sector_proposed.get(bucket, 0.0) + amount

        added = 0.0
        for symbol in active:
            bucket = _sector_bucket(by_symbol[symbol])
            room = max_sector - sector_used.get(bucket, 0.0)
            total_for_sector = sector_proposed[bucket]
            scale = min(1.0, room / total_for_sector)
            amount = max(0.0, proposed[symbol] * scale)
            weights[symbol] += amount
            added += amount
        if added <= 1e-10:
            break

    return {symbol: weight for symbol, weight in weights.items() if weight > 1e-8}


def build_target_portfolio(
    provider,
    candidates: Iterable[str],
    as_of: str,
    *,
    sector_lookup: Callable[[str], str] | None = None,
    incumbent_symbols: Iterable[str] = (),
    risk_tier: str = "NORMAL",
    config: AdaptiveMomentumConfig | None = None,
) -> TargetPortfolio:
    """Turn a point-in-time universe into a constrained target portfolio."""

    cfg = config or AdaptiveMomentumConfig()
    incumbents = tuple(
        str(symbol).upper().strip() for symbol in incumbent_symbols if symbol
    )
    incumbent_set = set(incumbents)
    scan = scan_universe(
        provider,
        candidates,
        as_of,
        sector_lookup=sector_lookup,
        config=cfg,
    )
    market = compute_market_state(provider, as_of, config=cfg)
    target_gross = _target_gross_weight(market, scan, risk_tier, cfg)
    selected = select_diversified(
        scan.ranked,
        top_n=cfg.top_n,
        hold_rank_n=cfg.hold_rank_n,
        incumbent_symbols=incumbents,
        # Keep the selected basket stable when the risk scaler changes; only
        # position sizes should shrink in CAUTIOUS mode.
        target_gross_weight=cfg.max_gross_exposure_pct / 100.0,
        max_position_pct=cfg.max_position_pct,
        max_sector_pct=cfg.max_sector_pct,
    )
    if cfg.weighting_scheme == "inverse_volatility":
        weights = allocate_inverse_volatility(
            selected,
            target_gross,
            max_position_pct=cfg.max_position_pct,
            max_sector_pct=cfg.max_sector_pct,
        )
    elif cfg.weighting_scheme == "equal":
        weights = allocate_equal_weight(
            selected,
            target_gross,
            max_position_pct=cfg.max_position_pct,
            max_sector_pct=cfg.max_sector_pct,
        )
    else:
        raise ValueError(f"Unsupported weighting scheme: {cfg.weighting_scheme}")
    invested = min(1.0, sum(weights.values()))
    return TargetPortfolio(
        as_of=as_of,
        weights=weights,
        cash_weight=max(0.0, 1.0 - invested),
        target_gross_weight=target_gross,
        market_state=market,
        breadth_pct=scan.breadth_pct,
        eligible_count=len(scan.ranked),
        diagnostics={
            "evaluated_count": scan.evaluated_count,
            "liquid_count": scan.liquid_count,
            "selected_count": len(weights),
            "hold_rank_n": cfg.hold_rank_n,
            "retained_incumbent_count": sum(
                1 for signal in selected if signal.symbol in incumbent_set
            ),
            "risk_tier": risk_tier,
            "market_above_sma200": market.above_sma200 if market else None,
            "market_volatility_pct": market.annual_volatility_pct if market else None,
        },
    )


__all__ = [
    "AdaptiveMomentumConfig",
    "CandidateSignal",
    "UniverseScan",
    "MarketState",
    "TargetPortfolio",
    "FrameBarProvider",
    "SECTOR_BENCHMARKS",
    "config_from_params",
    "analyze_symbol",
    "scan_universe",
    "compute_market_state",
    "market_reentry_confirmed",
    "infer_sector_from_returns",
    "allocate_inverse_volatility",
    "allocate_equal_weight",
    "select_diversified",
    "build_target_portfolio",
]
