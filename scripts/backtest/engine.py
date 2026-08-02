"""Day-by-day backtest engine — replays run_execution() on historical bars.

The decision loop mirrors execute_trades.run_execution():

  For each trading day D:
    1. Mark all open positions to D's open price (entry/exit at next-day open
       is the realistic fill assumption for swing trading)
    2. Process trailing stops + tightened stops against D's low
    3. Process scale-outs / final targets against D's high
    4. Process time-stops (positions held > N trading days without gain)
    5. Compute SPY regime from bars up to D-1 (no peeking)
    6. Process catalyst flips (score < 40 → SELL)
    7. Adjust bear hedge target (manage SH)
    8. Score every watchlist symbol from bars up to D-1
    9. Filter through 5-question checklist
   10. Sort by score, fill positions until cap or no cash
   11. Snapshot equity/cash/positions

Slippage:    +0.05% on buys, -0.05% on sells (conservative for liquid stocks)
Fill price:  next day's OPEN (we decide today on yesterday's close, fill tomorrow)

Imports the LIVE scoring engine wherever possible so backtest stays in sync
with live decisions — particularly compute_confidence_score and the regime
parameter table in strategy_config.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import setup_logging, get_symbol_info  # noqa: E402
from strategy_config import (  # noqa: E402
    get_strategy_params, get_bear_hedge_target_pct,
)
from research import compute_confidence_score, compute_technicals  # noqa: E402
from momentum_picker import (  # noqa: E402
    rank_universe, select_top_n, spy_12m_return, is_month_start,
)
from adaptive_momentum import (  # noqa: E402
    build_target_portfolio,
    compute_market_state,
    config_from_params,
    infer_sector_from_returns,
    market_reentry_confirmed,
)
from risk_policy import assess_portfolio_risk  # noqa: E402

from backtest.data_provider import BarProvider  # noqa: E402
from backtest.news_proxy import news_proxy_score, perplexity_proxy_score  # noqa: E402
from backtest.portfolio_sim import SimulatedPortfolio  # noqa: E402
from universe import load_universe_symbols  # noqa: E402
from strategy_identity import hash_symbol_universe  # noqa: E402

log = setup_logging("backtest_engine")


@lru_cache(maxsize=None)
def _sector_for_symbol(symbol: str) -> str:
    """Avoid re-reading the static metadata file for every monthly scan."""

    return get_symbol_info(symbol).get("sector", "Unknown")

SLIPPAGE_BPS = 7  # v9: blended for mixed mid+small-cap universe.
# Realistic per-asset:
#   • ETFs (SPY, SSO, SH, XL*, TQQQ): 2-4 bps actual
#   • Mega-cap stocks (top 50 by mkt cap): 3-5 bps actual
#   • Mid-cap ($2B-$20B): 7-10 bps actual
#   • Small-cap (under $2B): 10-20 bps actual
# 7 bps is a single-value compromise that slightly over-pays for ETFs
# (acceptable) and slightly under-models true small-cap drag. Per-symbol
# slippage modelling is a future iteration.
HEDGE_SYMBOL = "SH"

# SPDR sector ETFs used to derive per-day historical sector strength.
# Must match the watchlist taxonomy in scripts/sector_rotation.py.
_SECTOR_ETFS = {
    "Technology": "XLK", "Financial": "XLF", "Healthcare": "XLV",
    "Industrial": "XLI", "Consumer": "XLY", "Energy": "XLE",
    "Materials": "XLB", "Utilities": "XLU", "RealEstate": "XLRE",
    "Communication": "XLC",
}


@dataclass
class BacktestConfig:
    start_date: str = "2021-01-01"
    end_date: str = "2026-05-11"
    starting_cash: float = 1_000_000.0
    universe: Optional[list[str]] = None  # default: watchlist tradeable
    slippage_bps: float = SLIPPAGE_BPS
    verbose: bool = False
    # Optional parameter overrides — used by parameter sweep. Maps
    # (regime, risk_tier) → partial dict of overrides applied on top of
    # strategy_config.get_strategy_params(). None means "use live defaults".
    param_overrides: Optional[dict] = None


# ─────────────────────────── slippage + fills ──────────────────────────────


def _buy_fill(open_price: float, slippage_bps: float) -> float:
    return open_price * (1 + slippage_bps / 10_000)


def _sell_fill(open_price: float, slippage_bps: float) -> float:
    return open_price * (1 - slippage_bps / 10_000)


# ─────────────────────────── regime detection ──────────────────────────────


def _spy_regime(provider: BarProvider, today: str) -> str:
    """BULL/BEAR/NEUTRAL based on SPY 20/50-SMA as of yesterday's close.

    Mirrors research.get_spy_benchmark() but reads from cached bars.
    """
    bars = provider.bars_up_to("SPY", today, lookback_days=80)
    if len(bars) < 50:
        return "NEUTRAL"
    closes = bars["close"].astype(float)
    sma20 = float(closes.rolling(20).mean().iloc[-1])
    sma50 = float(closes.rolling(50).mean().iloc[-1])
    price = float(closes.iloc[-1])
    if price > sma20 > sma50:
        return "BULL"
    if price < sma20 and sma20 < sma50:
        return "BEAR"
    return "NEUTRAL"


def _spy_returns(provider: BarProvider, today: str) -> tuple[float, float]:
    """Return (five_day_return, twenty_day_return) for SPY as of today."""
    bars = provider.bars_up_to("SPY", today, lookback_days=30)
    if len(bars) < 21:
        return (0.0, 0.0)
    closes = bars["close"].astype(float)
    last = float(closes.iloc[-1])
    five = (last / float(closes.iloc[-6]) - 1) * 100 if len(closes) >= 6 else 0.0
    twenty = (last / float(closes.iloc[-21]) - 1) * 100
    return (five, twenty)


def _historical_sector_state(provider: BarProvider, today: str,
                             spy_20d: float) -> dict:
    """Compute sector rotation state from bars up to `today`.

    Without this the backtest would read state/sector_strength.json which
    is today's snapshot — a serious look-ahead bias when replaying 2021.
    """
    from sector_rotation import (
        compute_sector_alpha, rank_sectors,
    )
    returns: dict[str, float | None] = {}
    for sec, etf in _SECTOR_ETFS.items():
        bars = provider.bars_up_to(etf, today, lookback_days=30)
        if len(bars) < 21:
            returns[etf] = None
            continue
        closes = bars["close"].astype(float)
        ret = (float(closes.iloc[-1]) / float(closes.iloc[-21]) - 1) * 100
        returns[etf] = ret

    alpha = compute_sector_alpha(returns, spy_return=spy_20d)
    top, bottom = rank_sectors(alpha)
    return {
        "lookback_days": 20,
        "spy_return": spy_20d,
        "sector_alpha": alpha,
        "top_sectors": top,
        "bottom_sectors": bottom,
    }


# ─────────────────────────── risk-tier escalation ──────────────────────────


def _risk_tier(portfolio: SimulatedPortfolio) -> str:
    """Shared 22-session drawdown guard plus one-session loss breakers."""
    history = portfolio.daily_history
    current = portfolio.equity()
    previous = history[-1].equity if history else portfolio.starting_cash
    prior = [portfolio.starting_cash, *(snap.equity for snap in history)]
    return assess_portfolio_risk(
        current,
        previous_equity=previous,
        prior_equities=prior,
    ).tier


def _completed_session_risk_tier(portfolio: SimulatedPortfolio) -> str:
    """Classify risk using only the latest completed portfolio snapshot.

    The backtest fills decisions at session ``D``'s open.  Marking positions
    to that same open before computing the breaker would let a ``D`` gap both
    trigger HALT and be sold at the already-observed ``D`` open.  The live
    equivalent cannot react before the price exists, so all decisions for
    ``D`` use the snapshot recorded on ``D-1``.  A gap observed at ``D`` can
    therefore affect fills no earlier than ``D+1``.
    """

    history = portfolio.daily_history
    if not history:
        return "NORMAL"
    current = history[-1].equity
    previous = history[-2].equity if len(history) >= 2 else portfolio.starting_cash
    prior = [portfolio.starting_cash, *(snap.equity for snap in history[:-1])]
    return assess_portfolio_risk(
        current,
        previous_equity=previous,
        prior_equities=prior,
    ).tier


# ──────────────────────── parameter overrides ──────────────────────────────


def _resolve_params(regime: str, risk_tier: str, overrides: Optional[dict]) -> dict:
    base = get_strategy_params(regime, risk_tier)
    if overrides:
        # overrides keyed by (regime, risk_tier) tuple, by regime name, or "*"
        for key in [(regime, risk_tier), regime, "*"]:
            patch = overrides.get(key)
            if not patch:
                continue
            # Special marker: shift score_threshold by N relative to base
            if "_threshold_delta" in patch:
                base["score_threshold"] = max(
                    40, base["score_threshold"] + patch["_threshold_delta"]
                )
                patch = {k: v for k, v in patch.items() if k != "_threshold_delta"}
            base.update(patch)
    return base


# ─────────────────────────── scoring + checklist ───────────────────────────


def _technicals_from_bars(bars: pd.DataFrame) -> Optional[dict]:
    """Replicate research.compute_technicals() on point-in-time bars.

    Wraps the live function — bars must be a pandas DataFrame with the
    same column names live ingests (close/high/low/volume).
    """
    if bars is None or len(bars) < 21:
        return None
    # compute_technicals expects a DataFrame; columns already align
    return compute_technicals(bars)


def _compute_gate_score(
    symbol: str,
    technicals: dict,
    confidence: dict,
    spy_20d: float,
    params: dict,
) -> tuple[float, list[tuple[str, float]]]:
    """Backtest version of execute_trades.compute_gate_score.

    Returns (gate_score: float 0.0-1.0, checks: list of (name, value) tuples).
    Weighted gate replaces the old 5-question AND-gate.
    """
    weights = {
        "trend": 0.30,
        "catalyst": 0.15,
        "volume": 0.15,
        "rs": 0.25,
        "confidence": 0.15,
    }
    checks = {}

    # 1. Trend
    above_20 = technicals.get("above_sma20", False)
    above_50 = technicals.get("above_sma50", False)
    trend_pass = bool(above_20 and above_50)
    checks["trend"] = 1.0 if trend_pass else (0.5 if above_20 else 0.0)

    # 2. Catalyst — news_score > 5 OR perplexity_score > 10 (proxies)
    news_pass = (confidence.get("news_score", 0) > 5
                 or confidence.get("perplexity_score", 0) > 10)
    checks["catalyst"] = 1.0 if news_pass else 0.0

    # 3. Volume — regime-adaptive ratio
    vol_ratio = technicals.get("volume_ratio")
    vol_min = params["volume_min_ratio"]
    vol_pass = vol_ratio is not None and vol_ratio >= vol_min
    checks["volume"] = 1.0 if vol_pass else 0.0

    # 4. Relative strength — 20-day return vs SPY
    stock_20d = technicals.get("twenty_day_return", 0)
    alpha_20d = stock_20d - spy_20d
    rs_pass = alpha_20d >= params["rs_alpha_min"]
    checks["rs"] = 1.0 if rs_pass else 0.0

    # 5. Confidence — adaptive threshold
    total = confidence.get("total", 0)
    conf_pass = total >= params["score_threshold"]
    checks["confidence"] = 1.0 if conf_pass else 0.0

    gate_score = sum(weights[k] * checks[k] for k in weights)
    results = [(k, checks[k]) for k in weights]
    return gate_score, results


# ─────────────────────────── position sizing ───────────────────────────────


def _position_size(equity: float, entry_price: float, params: dict,
                    atr: float | None = None,
                    vol_20d_pct: float | None = None) -> int:
    """Mirror trade.calculate_position_size — v3 vol-targeted with cap.

    Two modes:
      • Legacy (default): risk-budget sizing. Sets qty so a stop-out at the
        ATR or trailing-stop distance loses exactly `risk_per_trade_pct` of
        equity. Capped by `max_position_pct`.
      • vol_target (Phase D of ALPHA_PLAN.md): sets qty so each name's
        annualized 20d return-vol contributes `target_vol_per_position_pct`
        of equity-vol. Activated by setting that param in strategy_config.
        Falls back to legacy if vol data is missing.
    """
    max_pct = params["max_position_pct"] / 100.0
    risk_pct = params["risk_per_trade_pct"] / 100.0
    alloc_shares = int((equity * max_pct) / entry_price)

    target_vol = params.get("target_vol_per_position_pct")
    if target_vol and vol_20d_pct and vol_20d_pct > 0:
        # Vol-targeted: shares × price × stock_vol ≈ target_vol × equity
        # so shares = (target_vol_frac × equity) / (price × stock_vol_frac)
        target_frac = float(target_vol) / 100.0
        vol_frac = float(vol_20d_pct) / 100.0
        primary = int((equity * target_frac) / (entry_price * vol_frac))
    elif atr and atr > 0:
        k = params.get("atr_stop_multiple", 2.0)
        primary = int((equity * risk_pct) / (k * atr))
    else:
        stop_pct = params["trailing_stop_pct"] / 100.0
        primary = int((equity * risk_pct) / (entry_price * stop_pct))

    return max(0, min(primary, alloc_shares))


# ─────────────────────────── trade-day mechanics ───────────────────────────


def _check_trailing_stops(portfolio: SimulatedPortfolio, day_lows: dict[str, float],
                          day_opens: dict[str, float], date: str,
                          params: dict, slippage_bps: float) -> int:
    """Close positions whose intraday low triggers trailing/tightened stop."""
    closed = 0
    base_trail = params["trailing_stop_pct"] / 100
    tight_trail = params["tightened_stop_pct"] / 100

    for symbol in list(portfolio.positions.keys()):
        p = portfolio.positions[symbol]
        if p.is_hedge or p.is_base:
            continue  # hedge + base are regime-driven, not stop-driven
        if symbol not in day_lows:
            continue
        trail = tight_trail if p.tightened_stop else base_trail
        # Tighten stop on the fly if we've reached +5% gain
        if not p.tightened_stop and p.current_price >= p.avg_entry_price * 1.05:
            p.tightened_stop = True
            trail = tight_trail
        stop_price = p.high_since_entry * (1 - trail)
        if day_lows[symbol] <= stop_price:
            # Realistic fill: stop_price unless open gapped below (then open)
            open_price = day_opens.get(symbol, stop_price)
            fill = min(stop_price, open_price)
            fill = _sell_fill(fill, slippage_bps)
            portfolio.close(symbol, fill, date, reason="stop")
            closed += 1
    return closed


def _check_scale_outs(portfolio: SimulatedPortfolio, day_highs: dict[str, float],
                     date: str, params: dict, slippage_bps: float) -> int:
    """Process scale-out (+10%) and final target (+20%) exits."""
    scaled = 0
    scale_at = 1 + params["scale_out_at_gain"] / 100
    final_at = 1 + params["final_target_gain"] / 100

    for symbol in list(portfolio.positions.keys()):
        p = portfolio.positions[symbol]
        if p.is_hedge or p.is_base:
            continue
        if symbol not in day_highs:
            continue
        # Final target — close fully
        final_price = p.avg_entry_price * final_at
        if day_highs[symbol] >= final_price:
            fill = _sell_fill(final_price, slippage_bps)
            portfolio.close(symbol, fill, date, reason="final_target")
            scaled += 1
            continue
        # Scale-out — once
        if portfolio.has_scaled_out(symbol):
            continue
        scale_price = p.avg_entry_price * scale_at
        if day_highs[symbol] >= scale_price:
            half_qty = max(1, p.qty // 2)
            fill = _sell_fill(scale_price, slippage_bps)
            portfolio.partial_close(symbol, half_qty, fill, date, reason="scale_out")
            scaled += 1
    return scaled


def _check_time_stops(portfolio: SimulatedPortfolio, day_opens: dict[str, float],
                      date: str, params: dict, slippage_bps: float,
                      provider: BarProvider) -> int:
    """Close positions held > time_stop_days **and** currently in the red.

    v3: a flat/positive position at day 30 is *not* a failed momentum trade —
    it just hasn't broken out yet. Only stop out losers; let trailing stop
    handle winners.
    """
    closed = 0
    max_days = params["time_stop_days"]

    for symbol in list(portfolio.positions.keys()):
        p = portfolio.positions[symbol]
        if p.is_hedge or p.is_base:
            continue
        if p.unrealized_plpc >= 0:
            continue
        held_days = len(provider.all_trading_days("SPY", start=p.entry_date, end=date)) - 1
        if held_days < max_days:
            continue
        open_price = day_opens.get(symbol, p.current_price)
        fill = _sell_fill(open_price, slippage_bps)
        portfolio.close(symbol, fill, date, reason="time_stop")
        closed += 1
    return closed


def _check_catalyst_flips(portfolio: SimulatedPortfolio, scored: dict[str, dict],
                          day_opens: dict[str, float], date: str,
                          slippage_bps: float) -> int:
    """Close positions whose confidence action is SELL."""
    closed = 0
    for symbol in list(portfolio.positions.keys()):
        p = portfolio.positions[symbol]
        if p.is_hedge or p.is_base:
            continue
        s = scored.get(symbol)
        if not s:
            continue
        if s.get("confidence", {}).get("action") == "SELL":
            open_price = day_opens.get(symbol, p.current_price)
            fill = _sell_fill(open_price, slippage_bps)
            portfolio.close(symbol, fill, date, reason="catalyst_flip")
            closed += 1
    return closed


def _spy_below_sma200(provider: BarProvider, today: str) -> bool:
    """Backtest equivalent of strategy_config._spy_below_sma200.

    Reads bars up to `today`, compares the most recent close to its 200-SMA.
    Fail-safe: insufficient history → True (don't strip an existing hedge).
    """
    bars = provider.bars_up_to("SPY", today, lookback_days=210)
    if bars is None or len(bars) < 200:
        return True
    closes = bars["close"].astype(float)
    sma_200 = float(closes.rolling(window=200).mean().iloc[-1])
    return float(closes.iloc[-1]) < sma_200


SPY_BASE_SYMBOL = "SPY"
SSO_BASE_SYMBOL = "SSO"  # v7: 2× SPY ProShares — leveraged BULL base
TQQQ_SYMBOL = "TQQQ"  # v5: leveraged BULL beta (3× QQQ) — disabled in v6+
BASE_REBALANCE_THRESHOLD_PCT = 2.0  # only rebalance when drift > 2% of equity
# v7: symbols that may act as the structural base position. Used by
# _manage_base_position to close stale base instruments on regime change.
BASE_CANDIDATES = (SPY_BASE_SYMBOL, SSO_BASE_SYMBOL)

# v9 Phase 2 — sector rotation overlay. Universe is the same SPDR sector
# ETFs already used for historical sector-strength reads in the engine.
SECTOR_ETF_UNIVERSE = (
    "XLK",   # Technology
    "XLF",   # Financial
    "XLV",   # Healthcare
    "XLI",   # Industrial
    "XLY",   # Consumer Discretionary
    "XLP",   # Consumer Staples (may not be cached; will be skipped if missing)
    "XLE",   # Energy
    "XLB",   # Materials
    "XLU",   # Utilities
    "XLRE",  # Real Estate
    "XLC",   # Communication
)


def _spy_above_sma50_and_sma200(provider: BarProvider, today: str) -> bool:
    """v5 — TQQQ confirmation gate. Both lines must be cleared to risk leverage.

    Why both: SMA50 catches the medium-term trend, SMA200 catches the
    structural cycle. Either alone is too noisy (mid-2022 had a 50-day
    cross above 200 briefly during the bear-market rally).

    QQQ-RS gate was tried in v10d/e and regressed alpha (looser cutoffs
    blocked TQQQ during real BULL legs). Original SMA-only logic kept.
    """
    bars = provider.bars_up_to("SPY", today, lookback_days=210)
    if bars is None or len(bars) < 200:
        return False  # not enough history → don't risk leverage
    closes = bars["close"].astype(float)
    last = float(closes.iloc[-1])
    sma50 = float(closes.rolling(window=50).mean().iloc[-1])
    sma200 = float(closes.rolling(window=200).mean().iloc[-1])
    return last > sma50 and last > sma200


def _manage_base_position(portfolio: SimulatedPortfolio, provider: BarProvider,
                          date: str, params: dict, slippage_bps: float) -> None:
    """v7 — maintain the structural base position at `base_pct` of equity.

    The base instrument is `params["base_instrument"]` — either SPY (1× beta)
    or SSO (2× SPY beta, ProShares Ultra). Different regime cells specify
    different instruments, e.g.:
      • BULL/NORMAL    → SSO 60 % (effective 1.2× beta)
      • NEUTRAL/NORMAL → SPY 40 % (deleveraged)
      • BEAR           → 0 %     (full cash)

    On regime transitions that change the instrument (e.g. BULL→NEUTRAL
    swaps SSO for SPY), any existing base position in a non-target
    instrument is liquidated FIRST, then the target instrument is sized
    to the new target_pct. This keeps the design compatible with the
    portfolio_sim `is_base` flag.

    Falls back gracefully if `base_pct` / `base_instrument` are missing
    (legacy v4-v6 cells use spy_base_pct → defaults).
    """
    target_pct = params.get("base_pct", params.get("spy_base_pct", 0.0))
    target_sym = params.get("base_instrument", SPY_BASE_SYMBOL)
    equity = portfolio.equity()
    if equity <= 0:
        return

    # Step 1: close any base position that isn't the target instrument.
    # The freed cash funds the target instrument below.
    for sym in BASE_CANDIDATES:
        if sym == target_sym:
            continue
        p = portfolio.get_position(sym)
        if p is None or not p.is_base:
            continue
        bar = provider.bar_at(sym, date)
        if bar is None:
            continue  # can't sell what we can't price today; carry over
        fill = _sell_fill(bar["open"], slippage_bps)
        portfolio.close(sym, fill, date, reason="base_swap")

    # Step 2: size the target instrument.
    bar = provider.bar_at(target_sym, date)
    if bar is None:
        return
    target_open = bar["open"]

    current_value = portfolio.base_value()  # only counts is_base positions
    target_value = equity * (target_pct / 100)
    delta = target_value - current_value
    delta_pct = abs(delta) / equity * 100 if equity > 0 else 0.0

    # Exit entirely if target is 0 and we still hold a base in target_sym
    if target_pct == 0.0:
        p = portfolio.get_position(target_sym)
        if p is not None and p.is_base:
            fill = _sell_fill(target_open, slippage_bps)
            portfolio.close(target_sym, fill, date, reason="base_exit")
        return

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return

    if delta > 0:
        fill = _buy_fill(target_open, slippage_bps)
        qty = int(delta / fill)
        if qty >= 1:
            portfolio.open(target_sym, qty, fill, date, is_base=True)
    else:
        p = portfolio.get_position(target_sym)
        if not p:
            return
        fill = _sell_fill(target_open, slippage_bps)
        qty = int(abs(delta) / fill)
        qty = min(qty, p.qty - 1) if p.qty > 1 else p.qty
        if qty >= 1:
            if qty >= p.qty:
                portfolio.close(target_sym, fill, date, reason="base_exit")
            else:
                portfolio.partial_close(target_sym, qty, fill, date, reason="base_rebal")


# v6-compat alias — old call sites still work.
_manage_spy_base = _manage_base_position


def _manage_tqqq(portfolio: SimulatedPortfolio, provider: BarProvider,
                 date: str, signal_date: str, params: dict,
                 day_lows: dict[str, float],
                 slippage_bps: float) -> None:
    """v5 — leveraged BULL beta via TQQQ (3× QQQ).

    Three guards prevent the 2022-style TQQQ implosion (−79 %):
      1. Target is 0 unless `tqqq_pct` > 0 in current regime cell (BULL only).
      2. Even with target > 0, only opens when SPY > SMA50 AND SMA200.
      3. Hard intraday stop at entry × (1 − `tqqq_stop_pct`/100). If today's
         low pierces the line we exit at the stop price (slippage applied).
    """
    target_pct = params.get("tqqq_pct", 0.0)

    # Circuit breaker — hard −% stop on any existing TQQQ position
    p = portfolio.get_position(TQQQ_SYMBOL)
    if p is not None and p.is_base:
        stop_pct = params.get("tqqq_stop_pct", 20.0)
        stop_price = p.avg_entry_price * (1 - stop_pct / 100)
        today_low = day_lows.get(TQQQ_SYMBOL)
        if today_low is not None and today_low <= stop_price:
            fill = _sell_fill(min(stop_price, today_low), slippage_bps)
            portfolio.close(TQQQ_SYMBOL, fill, date, reason="tqqq_circuit_breaker")
            return  # stop fired — don't immediately re-enter the same day

    # Regime gate — leverage only when both SMA lines are cleared
    if target_pct > 0 and not _spy_above_sma50_and_sma200(provider, signal_date):
        target_pct = 0.0

    bar = provider.bar_at(TQQQ_SYMBOL, date)
    if bar is None:
        return
    tqqq_open = bar["open"]
    equity = portfolio.equity()
    if equity <= 0:
        return

    p = portfolio.get_position(TQQQ_SYMBOL)
    current_value = p.market_value if (p and p.is_base) else 0.0
    target_value = equity * (target_pct / 100)
    delta = target_value - current_value
    delta_pct = abs(delta) / equity * 100 if equity > 0 else 0.0

    # Exit entirely if target is 0
    if target_pct == 0.0:
        if p is not None and p.is_base:
            fill = _sell_fill(tqqq_open, slippage_bps)
            portfolio.close(TQQQ_SYMBOL, fill, date, reason="tqqq_exit")
        return

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return

    if delta > 0:
        fill = _buy_fill(tqqq_open, slippage_bps)
        qty = int(delta / fill)
        if qty >= 1:
            portfolio.open(TQQQ_SYMBOL, qty, fill, date, is_base=True)
    elif p is not None:
        fill = _sell_fill(tqqq_open, slippage_bps)
        qty = int(abs(delta) / fill)
        qty = min(qty, p.qty - 1) if p.qty > 1 else p.qty
        if qty >= 1:
            if qty >= p.qty:
                portfolio.close(TQQQ_SYMBOL, fill, date, reason="tqqq_exit")
            else:
                portfolio.partial_close(TQQQ_SYMBOL, qty, fill, date, reason="tqqq_rebal")


SGOV_SYMBOL = "BIL"  # v10e: T-bill ETF (1-3mo) for idle cash. Was SGOV
                      # but SGOV bars have 247 missing days from 2021 — BIL
                      # has near-complete coverage.


UPRO_SYMBOL = "UPRO"  # v10f: 3× SPY leveraged ETF, parallel to TQQQ.
                       # Adds broad-market leverage so the strategy isn't
                       # purely tech-biased.


def _manage_upro(portfolio: SimulatedPortfolio, provider: BarProvider,
                 date: str, signal_date: str, params: dict,
                 day_lows: dict[str, float],
                 slippage_bps: float) -> None:
    """v10f — UPRO (3× SPY) parallel leveraged sleeve, mirrors _manage_tqqq.

    Same SMA50+SMA200 gate as TQQQ — leverage only when the structural
    trend is intact. Same circuit breaker on entry × (1 − upro_stop_pct).

    Whereas TQQQ captures the QQQ-led leg, UPRO captures the broad-market
    leg. In 2021 (tech rotation out) UPRO would have continued running
    even as TQQQ lagged. Together they form a more robust leveraged sleeve.
    """
    target_pct = params.get("upro_pct", 0.0)

    # Circuit breaker
    p = portfolio.get_position(UPRO_SYMBOL)
    if p is not None and p.is_base:
        stop_pct = params.get("upro_stop_pct", 15.0)
        stop_price = p.avg_entry_price * (1 - stop_pct / 100)
        today_low = day_lows.get(UPRO_SYMBOL)
        if today_low is not None and today_low <= stop_price:
            fill = _sell_fill(min(stop_price, today_low), slippage_bps)
            portfolio.close(UPRO_SYMBOL, fill, date, reason="upro_circuit_breaker")
            return

    # SMA gate — share TQQQ's gate (both leveraged sleeves use same trigger)
    if target_pct > 0 and not _spy_above_sma50_and_sma200(provider, signal_date):
        target_pct = 0.0

    bar = provider.bar_at(UPRO_SYMBOL, date)
    if bar is None:
        return
    upro_open = bar["open"]
    equity = portfolio.equity()
    if equity <= 0:
        return

    p = portfolio.get_position(UPRO_SYMBOL)
    current_value = p.market_value if (p and p.is_base) else 0.0
    target_value = equity * (target_pct / 100)
    delta = target_value - current_value
    delta_pct = abs(delta) / equity * 100 if equity > 0 else 0.0

    if target_pct == 0.0:
        if p is not None and p.is_base:
            fill = _sell_fill(upro_open, slippage_bps)
            portfolio.close(UPRO_SYMBOL, fill, date, reason="upro_exit")
        return

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return

    if delta > 0:
        fill = _buy_fill(upro_open, slippage_bps)
        qty = int(delta / fill)
        if qty >= 1:
            portfolio.open(UPRO_SYMBOL, qty, fill, date, is_base=True)
    elif p is not None:
        fill = _sell_fill(upro_open, slippage_bps)
        qty = int(abs(delta) / fill)
        qty = min(qty, p.qty - 1) if p.qty > 1 else p.qty
        if qty >= 1:
            if qty >= p.qty:
                portfolio.close(UPRO_SYMBOL, fill, date, reason="upro_exit")
            else:
                portfolio.partial_close(UPRO_SYMBOL, qty, fill, date, reason="upro_rebal")


def _manage_cash_sleeve(portfolio: SimulatedPortfolio, provider: BarProvider,
                        date: str, params: dict, slippage_bps: float) -> None:
    """v10e — park idle cash in SGOV (T-bill ETF) to earn the risk-free rate.

    Sized to the *residual* cash after all other sleeves have claimed
    their targets. If params say tqqq_pct=80 + base_pct=20, the residual
    is 0 and SGOV stays empty. If params say tqqq_pct=0 + base_pct=0
    (e.g. BEAR), the residual is up to 100% minus the hedge target.

    Critically: SGOV exits IMMEDIATELY when leveraged sleeves need cash
    so the higher-priority sleeves are never starved.

    SGOV is treated as infrastructure (is_base=True) so it's exempt from
    stops, sector caps, and the HALT block.
    """
    # Only active in regimes designed to hold cash. In BULL/NORMAL and
    # NEUTRAL/NORMAL the strategy targets ~100% deployment via leveraged
    # ETFs; when their gate is temporarily off (e.g. early in the
    # backtest before SMA200 is computable), we don't want SGOV
    # hoarding the cash that will soon be claimed by TQQQ.
    cap_pct = float(params.get("cash_sleeve_pct", 0.0))
    if cap_pct <= 0:
        # Sleeve disabled — close any existing SGOV
        p = portfolio.get_position(SGOV_SYMBOL)
        if p is not None and p.is_base:
            bar = provider.bar_at(SGOV_SYMBOL, date)
            if bar is not None:
                fill = _sell_fill(bar["open"], slippage_bps)
                portfolio.close(SGOV_SYMBOL, fill, date, reason="cash_sleeve_off")
        return

    bar = provider.bar_at(SGOV_SYMBOL, date)
    if bar is None:
        return
    open_price = bar["open"]
    equity = portfolio.equity()
    if equity <= 0:
        return

    # Compute residual = 100% − (target % from other sleeves). Using TARGET
    # percentages (not current values) so SGOV doesn't hoard cash that
    # leveraged sleeves will claim once their gate (e.g. SMA200) opens.
    base_pct = float(params.get("base_pct", 0.0))
    tqqq_pct = float(params.get("tqqq_pct", 0.0))
    # Hedge target — only material in BEAR. Approximate inline (the live
    # function reads from research state which doesn't apply during backtest).
    hedge_pct = 0.0
    # Reserve for momentum stock picks
    stock_reserve_pct = 0.0
    if int(params.get("momentum_top_n", 0)) > 0:
        n = int(params["momentum_top_n"])
        mpct = float(params.get("max_position_pct", 10.0))
        stock_reserve_pct = min(100.0, n * mpct)

    residual_pct = max(0.0, 100.0 - base_pct - tqqq_pct - hedge_pct - stock_reserve_pct)
    # Target SGOV value = min(cap_pct, residual_pct) × equity
    target_value = equity * min(cap_pct, residual_pct) / 100.0

    p = portfolio.get_position(SGOV_SYMBOL)
    current_value = p.market_value if (p and p.is_base) else 0.0
    delta = target_value - current_value
    delta_pct = abs(delta) / equity * 100 if equity > 0 else 0.0

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return

    if delta > 0:
        max_buy = max(0.0, portfolio.cash - equity * 0.005)  # tiny liquidity buffer
        delta = min(delta, max_buy)
        if delta < equity * 0.005:
            return
        fill = _buy_fill(open_price, slippage_bps)
        qty = int(delta / fill)
        if qty >= 1:
            portfolio.open(SGOV_SYMBOL, qty, fill, date, is_base=True)
    elif p is not None:
        fill = _sell_fill(open_price, slippage_bps)
        qty = int(abs(delta) / fill)
        qty = min(qty, p.qty - 1) if p.qty > 1 else p.qty
        if qty >= 1:
            if qty >= p.qty:
                portfolio.close(SGOV_SYMBOL, fill, date, reason="cash_sleeve_trim")
            else:
                portfolio.partial_close(SGOV_SYMBOL, qty, fill, date, reason="cash_sleeve_rebal")


PEAD_PREFIX = "PEAD:"  # marker key in portfolio.positions metadata (unused —
                        # we use the strategy_metadata sm.mark_position pattern
                        # in live; backtest tracks via the entry_reason field)


def _scan_pead_candidates(provider: BarProvider, candidates: list[str],
                          prev_day: str, spy_12m: float = 0.0) -> list[tuple[str, float]]:
    """Quality-filtered PEAD scan: find gap-up + volume names that are ALSO
    in long-term uptrend (12m return > SPY's 12m return). Without earnings
    data the quality filter is what makes this an alpha source vs noise.

    Requirements:
      • Today's gap > 5% (was 3% — tightened)
      • Volume > 3× 20d avg (was 2× — tightened)
      • Today's close > today's open (no intraday reversal)
      • Name has positive 12m return AND beats SPY's 12m

    Returns list of (symbol, score) ranked by score descending.
    """
    from momentum_picker import compute_12m_return
    out: list[tuple[str, float]] = []
    for sym in candidates:
        bars = provider.bars_up_to(sym, prev_day, lookback_days=25)
        if len(bars) < 22:
            continue
        closes = bars["close"].astype(float)
        opens = bars["open"].astype(float)
        volumes = bars["volume"].astype(float)
        prev_close = float(closes.iloc[-2])
        today_open = float(opens.iloc[-1])
        today_close = float(closes.iloc[-1])
        if prev_close <= 0 or today_open <= 0:
            continue
        gap_pct = (today_open - prev_close) / prev_close * 100
        intraday_pct = (today_close - today_open) / today_open * 100
        if gap_pct < 5.0 or intraday_pct < 0.0:
            continue
        avg_vol = float(volumes.iloc[-21:-1].mean())
        today_vol = float(volumes.iloc[-1])
        if avg_vol <= 0 or today_vol / avg_vol < 3.0:
            continue
        # Quality: only strong momentum leaders (12m > SPY + 20pp)
        r12 = compute_12m_return(provider, sym, prev_day)
        if r12 is None or r12 < spy_12m + 20.0:
            continue
        score = min(1.0, gap_pct / 10.0) * 0.4 \
                + min(1.0, today_vol / avg_vol / 5.0) * 0.3 \
                + min(1.0, r12 / 100.0) * 0.3
        out.append((sym, score))
    out.sort(key=lambda r: -r[1])
    return out


def _manage_pead_sleeve(portfolio: SimulatedPortfolio, provider: BarProvider,
                        candidates: list[str], prev_day: str, today: str,
                        params: dict, opens: dict[str, float],
                        slippage_bps: float) -> None:
    """v10g — PEAD sleeve: buy gap-up + volume names, hold 10d max.

    Sleeve cap: `pead_sleeve_pct` of equity (default 15%).
    Per-position cap: `pead_position_pct` (default 3%).
    Exit: +8% target / −3% stop / 10-day time limit.

    Position-tracking: PEAD entries are tagged via a "_pead_<date>" marker
    in the position's `entry_reason` so we can exit on age + condition.
    """
    sleeve_pct = float(params.get("pead_sleeve_pct", 0.0))
    if sleeve_pct <= 0:
        return
    per_pos_pct = float(params.get("pead_position_pct", 3.0))
    target_pct = float(params.get("pead_profit_target_pct", 8.0))
    stop_pct = float(params.get("pead_stop_pct", -3.0))
    time_stop = int(params.get("pead_time_stop_days", 10))

    equity = portfolio.equity()
    if equity <= 0:
        return

    # First: exit any existing PEAD positions on target / stop / time
    for sym in list(portfolio.positions.keys()):
        p = portfolio.positions[sym]
        if p.is_hedge or p.is_base:
            continue
        if not str(p.entry_reason or "").startswith("pead_"):
            continue
        if sym not in opens:
            continue
        cur_pnl = (opens[sym] - p.avg_entry_price) / p.avg_entry_price * 100
        # Age in trading days
        try:
            held = max(0, len(provider.all_trading_days("SPY",
                                                        start=p.entry_date,
                                                        end=today)) - 1)
        except Exception:
            held = 0
        should_exit = False
        reason = ""
        if cur_pnl >= target_pct:
            should_exit, reason = True, f"pead_target+{cur_pnl:.1f}"
        elif cur_pnl <= stop_pct:
            should_exit, reason = True, f"pead_stop{cur_pnl:.1f}"
        elif held >= time_stop:
            should_exit, reason = True, f"pead_time_stop{held}d"
        if should_exit:
            fill = _sell_fill(opens[sym], slippage_bps)
            portfolio.close(sym, fill, today, reason=reason)

    # Compute headroom
    sleeve_value = sum(
        p.market_value for p in portfolio.positions.values()
        if str(p.entry_reason or "").startswith("pead_")
    )
    headroom = max(0.0, equity * sleeve_pct / 100.0 - sleeve_value)
    if headroom < equity * 0.005:  # < 0.5% headroom → skip
        return

    # Buy leg: scan and rank (quality-filtered by 12m return vs SPY)
    spy_12m_for_pead = spy_12m_return(provider, prev_day) or 0.0
    ranked = _scan_pead_candidates(provider, candidates, prev_day,
                                    spy_12m=spy_12m_for_pead)
    if not ranked:
        return
    per_pos_value = min(equity * per_pos_pct / 100.0, headroom)

    for sym, score in ranked[:5]:  # top-5 at most per day
        if portfolio.has_position(sym):
            continue
        if sym not in opens:
            continue
        if headroom < per_pos_value * 0.5:
            break
        fill_price = _buy_fill(opens[sym], slippage_bps)
        qty = int(per_pos_value / fill_price)
        if qty <= 0:
            continue
        if portfolio.cash < qty * fill_price:
            continue
        portfolio.open(sym, qty, fill_price, today)
        # Tag the position so exits can recognise it
        portfolio.positions[sym].entry_reason = f"pead_score{score:.2f}"
        headroom -= qty * fill_price


def _sector_etf_6m_returns(provider: BarProvider, today: str) -> list[tuple[str, float]]:
    """v9 Phase 2 — rank sector ETFs by 6-month total return as of `today`.

    Returns descending list of (symbol, 6m_return_pct). Skips ETFs without
    sufficient history. Used by `_manage_sector_rotation` to pick top-N.
    """
    from momentum_picker import compute_6m_return
    rows: list[tuple[str, float]] = []
    for sym in SECTOR_ETF_UNIVERSE:
        r = compute_6m_return(provider, sym, today)
        if r is None:
            continue
        rows.append((sym, r))
    rows.sort(key=lambda r: -r[1])
    return rows


def _manage_sector_rotation(portfolio: SimulatedPortfolio,
                            provider: BarProvider, date: str, params: dict,
                            opens: dict[str, float], slippage_bps: float,
                            prev_date: str | None) -> None:
    """v9 Phase 2 — overlay `sector_rotation_pct` into top-N sector ETFs.

    The overlay is intentionally simple:
      • Only acts on the first trading day of the month (in sync with the
        momentum rebalance).
      • Picks top-N XL* ETFs by 6-month total return.
      • Equal-weights them — each sized to
        `sector_rotation_pct / N` of equity.
      • Each ETF is opened with `is_base=True` so it's exempt from
        trail-stops, scale-outs, etc. (regime-driven infrastructure).
      • On the month-start rebalance, any non-top-N sector ETF currently
        held is closed; the surviving ones are trimmed/topped-up to target.

    Disabled when `sector_rotation_pct == 0` (NEUTRAL / BEAR cells).
    """
    from momentum_picker import is_month_start
    target_total = params.get("sector_rotation_pct", 0.0)
    top_n = int(params.get("sector_rotation_top_n", 0))
    if target_total <= 0 or top_n <= 0:
        # Disabled — but if we still hold sector ETFs from a previous BULL,
        # close them at the month-start (so transitions clean up).
        if is_month_start(prev_date, date):
            for sym in SECTOR_ETF_UNIVERSE:
                p = portfolio.get_position(sym)
                if p is None or not p.is_base:
                    continue
                if sym not in opens:
                    continue
                fill = _sell_fill(opens[sym], slippage_bps)
                portfolio.close(sym, fill, date, reason="sector_rotation_exit")
        return

    # Only rebalance on month start.
    if not is_month_start(prev_date, date):
        return

    ranked = _sector_etf_6m_returns(provider, date)
    if not ranked:
        return
    top = set(s for s, _r in ranked[:top_n])

    # Close ETFs no longer in top-N
    for sym in SECTOR_ETF_UNIVERSE:
        if sym in top:
            continue
        p = portfolio.get_position(sym)
        if p is None or not p.is_base:
            continue
        if sym not in opens:
            continue
        fill = _sell_fill(opens[sym], slippage_bps)
        portfolio.close(sym, fill, date, reason="sector_rotation_rebal")

    equity = portfolio.equity()
    if equity <= 0:
        return
    per_etf_value = equity * (target_total / 100.0) / top_n

    # Open / resize each ETF in top-N to its per-ETF target
    for sym in top:
        if sym not in opens:
            continue
        fill_buy = _buy_fill(opens[sym], slippage_bps)
        fill_sell = _sell_fill(opens[sym], slippage_bps)
        p = portfolio.get_position(sym)
        current = p.market_value if (p and p.is_base) else 0.0
        delta = per_etf_value - current
        delta_pct = abs(delta) / equity * 100.0
        if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
            continue
        if delta > 0:
            qty = int(delta / fill_buy)
            if qty >= 1:
                portfolio.open(sym, qty, fill_buy, date, is_base=True)
        elif p is not None:
            qty = int(abs(delta) / fill_sell)
            qty = min(qty, p.qty - 1) if p.qty > 1 else p.qty
            if qty >= 1:
                if qty >= p.qty:
                    portfolio.close(sym, fill_sell, date, reason="sector_rotation_trim")
                else:
                    portfolio.partial_close(sym, qty, fill_sell, date,
                                            reason="sector_rotation_trim")


def _flatten_on_transition(portfolio: SimulatedPortfolio, day_opens: dict[str, float],
                           date: str, slippage_bps: float) -> int:
    """v4 — close all DIRECTIONAL positions (non-hedge, non-base) at today's open.

    Triggered when regime transitions BULL → NEUTRAL/BEAR. SPY base is
    handled separately (target drops to 0). SH hedge is managed by
    `_manage_hedge`.

    Trades a small "could have recovered" optionality for ~zero NEUTRAL bleed.
    """
    closed = 0
    for symbol in list(portfolio.positions.keys()):
        p = portfolio.positions[symbol]
        if p.is_hedge or p.is_base:
            continue
        if symbol not in day_opens:
            continue
        fill = _sell_fill(day_opens[symbol], slippage_bps)
        portfolio.close(symbol, fill, date, reason="flatten_transition")
        closed += 1
    return closed


def _manage_hedge(portfolio: SimulatedPortfolio, provider: BarProvider,
                  date: str, signal_date: str, regime: str, risk_tier: str,
                  slippage_bps: float) -> None:
    """Buy/trim/exit SH to match target % for regime + risk tier.

    v3: hedge target zeroed when SPY ≥ SMA200 (structural uptrend).
    """
    if not _spy_below_sma200(provider, signal_date):
        target_pct = 0.0
    else:
        target_pct = get_bear_hedge_target_pct(regime, risk_tier)
    equity = portfolio.equity()
    if equity <= 0:
        return
    target_value = equity * (target_pct / 100)
    current_value = portfolio.hedge_value()
    delta = target_value - current_value
    delta_pct = abs(delta) / equity * 100

    sh_bar = provider.bar_at(HEDGE_SYMBOL, date)
    if sh_bar is None:
        return
    sh_open = sh_bar["open"]

    # Exit entirely if target is 0
    if target_pct == 0.0 and portfolio.has_position(HEDGE_SYMBOL):
        fill = _sell_fill(sh_open, slippage_bps)
        portfolio.close(HEDGE_SYMBOL, fill, date, reason="hedge_exit")
        return

    # Drift filter (no churn)
    if delta_pct < 2.0:
        return

    if delta > 0:
        fill = _buy_fill(sh_open, slippage_bps)
        qty = int(delta / fill)
        if qty >= 1:
            portfolio.open(HEDGE_SYMBOL, qty, fill, date, is_hedge=True)
    else:
        # Trim
        p = portfolio.get_position(HEDGE_SYMBOL)
        if not p:
            return
        fill = _sell_fill(sh_open, slippage_bps)
        qty = int(abs(delta) / fill)
        qty = min(qty, p.qty - 1) if p.qty > 1 else p.qty
        if qty >= 1:
            if qty >= p.qty:
                portfolio.close(HEDGE_SYMBOL, fill, date, reason="hedge_exit")
            else:
                portfolio.partial_close(HEDGE_SYMBOL, qty, fill, date, reason="hedge_trim")


# ──────────────────────── v6 momentum execution ────────────────────────


def _close_directional_positions(
    portfolio: SimulatedPortfolio,
    opens: dict[str, float],
    today: str,
    slippage_bps: float,
    *,
    reason: str,
) -> list[str]:
    """Liquidate priced stock risk and return symbols still unresolved."""

    unresolved: list[str] = []
    for symbol in list(portfolio.positions):
        position = portfolio.positions[symbol]
        if position.is_base or position.is_hedge:
            continue
        if symbol not in opens:
            unresolved.append(symbol)
            continue
        portfolio.close(
            symbol,
            _sell_fill(opens[symbol], slippage_bps),
            today,
            reason=reason,
        )
    return unresolved


def _execute_adaptive_momentum(
    *,
    portfolio: SimulatedPortfolio,
    provider: BarProvider,
    candidates: list[str],
    signal_date: str,
    today: str,
    params: dict,
    opens: dict[str, float],
    slippage_bps: float,
    risk_tier: str,
    prev_date: str | None,
    pending_plan: dict | None = None,
    force_risk_on_reentry: bool = False,
) -> dict | None:
    """Rebalance causal 12-1 targets formed at D and filled at D+1 open.

    Risk-off exits are evaluated every session. Risk-on target changes occur
    monthly, avoiding unnecessary turnover in a deliberately slow signal.
    When a rebalance requires any sell, its frozen buy leg is deferred until
    at least the next session, matching the live sell-confirmation boundary.
    """

    cfg = config_from_params(params)
    market = compute_market_state(provider, signal_date, config=cfg)
    risk_off_now = (
        risk_tier == "HALT" or market is None or not market.above_sma200
    )
    pending_risk_off = bool(
        pending_plan is not None and pending_plan.get("risk_off") is True
    )
    if risk_off_now or pending_risk_off:
        unresolved = _close_directional_positions(
            portfolio,
            opens,
            today,
            slippage_bps,
            reason="adaptive_risk_off",
        )
        if unresolved:
            # Match live execution's frozen zero-target convergence plan.  A
            # missing symbol open must not erase the exit intent merely because
            # the SPY/HALT gate recovers before that symbol trades again.
            return {
                "signal_date": (
                    pending_plan.get("signal_date")
                    if pending_risk_off
                    else signal_date
                ),
                "weights": {},
                "construction_risk_tier": "HALT",
                "buy_after_date": None,
                "rebalance_month": (
                    pending_plan.get("rebalance_month", today[:7])
                    if pending_risk_off
                    else today[:7]
                ),
                "risk_off": True,
            }
        return None

    risk_rank = {"NORMAL": 0, "CAUTIOUS": 1, "HALT": 2}
    rebalance_month = today[:7]
    stale_pending = bool(
        pending_plan is not None
        and pending_plan.get("rebalance_month", rebalance_month)
        != rebalance_month
    )
    if stale_pending:
        # A missing target bar must not keep an old frozen basket alive into a
        # later rebalance month. Match live execution by discarding the stale
        # no-order plan and constructing the new month's target.
        pending_plan = None

    if pending_plan is not None:
        target_signal_date = str(pending_plan["signal_date"])
        construction_risk_tier = str(
            pending_plan.get("construction_risk_tier", "HALT")
        )
        target_weights = {
            symbol: float(weight)
            for symbol, weight in pending_plan.get("weights", {}).items()
        }

        # Never execute yesterday's 90%-gross target after the completed
        # portfolio snapshot has escalated to CAUTIOUS. Rebuild from the same
        # frozen signal date with the stricter risk scaler; recovery to NORMAL
        # does not enlarge an already-conservative pending plan.
        if risk_rank.get(risk_tier, 2) > risk_rank.get(
            construction_risk_tier, 2
        ):
            stricter_plan = build_target_portfolio(
                provider,
                candidates,
                target_signal_date,
                sector_lookup=lambda symbol: (
                    _sector_for_symbol(symbol)
                    if _sector_for_symbol(symbol) != "Unknown"
                    else infer_sector_from_returns(
                        provider, symbol, target_signal_date
                    )
                ),
                incumbent_symbols=target_weights,
                risk_tier=risk_tier,
                config=cfg,
            )
            target_weights = dict(stricter_plan.weights)
            pending_plan = {
                **pending_plan,
                "weights": target_weights,
                "construction_risk_tier": risk_tier,
            }
    else:
        if (
            not stale_pending
            and not force_risk_on_reentry
            and not is_month_start(prev_date, today)
        ):
            return None

        plan = build_target_portfolio(
            provider,
            candidates,
            signal_date,
            sector_lookup=lambda symbol: (
                _sector_for_symbol(symbol)
                if _sector_for_symbol(symbol) != "Unknown"
                else infer_sector_from_returns(provider, symbol, signal_date)
            ),
            incumbent_symbols=(
                symbol
                for symbol, position in portfolio.positions.items()
                if not position.is_base and not position.is_hedge
            ),
            risk_tier=risk_tier,
            config=cfg,
        )
        target_signal_date = signal_date
        construction_risk_tier = risk_tier
        target_weights = dict(plan.weights)
        pending_plan = {
            "signal_date": target_signal_date,
            "weights": target_weights,
            "construction_risk_tier": construction_risk_tier,
            "buy_after_date": None,
            "rebalance_month": rebalance_month,
        }

    equity = portfolio.equity()
    if equity <= 0:
        return None
    drift_value = equity * 0.005

    # Raise cash first: remove dropped names and trim positions above target.
    sell_required = False
    for symbol in list(portfolio.positions):
        position = portfolio.positions[symbol]
        if position.is_base or position.is_hedge:
            continue
        target_value = equity * target_weights.get(symbol, 0.0)
        excess = position.market_value - target_value
        if symbol not in target_weights:
            sell_required = True
            if symbol not in opens:
                continue
            portfolio.close(
                symbol,
                _sell_fill(opens[symbol], slippage_bps),
                today,
                reason="adaptive_rebalance_exit",
            )
            continue
        if excess <= drift_value:
            continue
        if symbol not in opens:
            sell_required = True
            continue
        fill = _sell_fill(opens[symbol], slippage_bps)
        qty = min(position.qty, int(excess / fill))
        if qty <= 0:
            continue
        sell_required = True
        if qty >= position.qty:
            portfolio.close(symbol, fill, today, reason="adaptive_rebalance_trim")
        else:
            portfolio.partial_close(
                symbol, qty, fill, today, reason="adaptive_rebalance_trim"
            )

    # Crossing a session boundary after any required sell prevents proceeds
    # and replacement buys from sharing an official-open price. Missing sell
    # prices also keep the frozen plan pending until convergence is possible.
    if sell_required:
        return {**pending_plan, "buy_after_date": today}

    if pending_plan.get("buy_after_date") == today:
        return pending_plan

    # Then top up underweights. Residual cash is the deliberate cash target.
    equity = portfolio.equity()
    for symbol, target_weight in sorted(
        target_weights.items(), key=lambda item: (-item[1], item[0])
    ):
        if symbol not in opens:
            continue
        position = portfolio.get_position(symbol)
        current_value = position.market_value if position else 0.0
        shortfall = equity * target_weight - current_value
        if shortfall <= drift_value:
            continue
        fill = _buy_fill(opens[symbol], slippage_bps)
        qty = min(int(shortfall / fill), int(portfolio.cash / fill))
        if qty > 0:
            portfolio.open(symbol, qty, fill, today)

    # Preserve the frozen plan if a missing bar or integer/cash constraint
    # leaves a material underweight. The next session retries after the same
    # sell-first safety checks.
    equity = portfolio.equity()
    drift_value = equity * 0.005
    for symbol, target_weight in target_weights.items():
        position = portfolio.get_position(symbol)
        current_value = position.market_value if position else 0.0
        if equity * target_weight - current_value > drift_value:
            return pending_plan
    return None


def _execute_momentum_picks(*, portfolio: SimulatedPortfolio,
                            provider: BarProvider,
                            candidates: list[str],
                            prev_day: str,
                            today: str,
                            params: dict,
                            opens: dict[str, float],
                            slippage_bps: float,
                            risk_tier: str,
                            block_buys: bool,
                            prev_date: str | None) -> None:
    """v6 — monthly dual-momentum rebalance.

    Behaviour:
      • Rank `candidates` by 12-month return as of `prev_day`. Only stocks
        with positive 12m return AND beating SPY's 12m return survive.
      • On the first trading day of each new month (`prev_date`'s YYYY-MM
        differs from `today`'s), do a clean rebalance: sell positions no
        longer in the top-N, then buy any new top-N members not yet held.
      • Minimum hold of `momentum_min_hold_days` (default 21) before any
        momentum-driven exit. Trailing stops still fire normally.
      • Equal-weight sizing capped at `max_position_pct` of equity.
      • Standard 25 % sector cap and `min_cash_pct` floor enforced.
      • Skipped entirely when `block_buys=True` (NEUTRAL / BEAR) — but
        the SELL leg of the rebalance still runs so we don't accumulate
        dead-weight from prior regimes.

    Pure orchestration over the existing portfolio + provider; no I/O.
    """
    top_n = int(params.get("momentum_top_n", 10))
    min_hold = int(params.get("momentum_min_hold_days", 21))

    if risk_tier == "HALT":
        # HALT means no new entries, but the SELL leg of rebalance is fine.
        top_n = 0

    # On non-rebalance days, just hold. Stops, SPY base, hedge already ran.
    if not is_month_start(prev_date, today):
        return

    # Compute SPY 12-month return as the relative-momentum bar.
    spy_12m = spy_12m_return(provider, prev_day) or 0.0

    # v10c: quality filter (SMA200 + 6m/12m consistency + vol cap) is now
    # configurable per regime. Default OFF on legacy v7, but the v10 TQQQ
    # overlay lets us be choosier on the momentum sleeve without losing
    # beta exposure.
    quality = bool(params.get("momentum_quality_filter", False))
    min_abs = float(params.get("momentum_min_abs_return", 0.0))
    max_vol = float(params.get("momentum_max_annual_vol_pct", 80.0))

    # Rank survivors and pick the top-N (top_n=0 → empty set → pure SELL).
    ranked = rank_universe(provider, candidates, prev_day, spy_12m,
                            min_abs_return=min_abs,
                            apply_quality_filter=quality,
                            max_annual_vol_pct=max_vol)
    top_picks = set(select_top_n(ranked, top_n))

    # SELL leg — close any directional position no longer in top-N, provided
    # it has cleared the minimum hold. Infrastructure (SPY base / SH hedge)
    # is exempt; those are managed by their own functions.
    for held_sym in list(portfolio.positions.keys()):
        p = portfolio.positions[held_sym]
        if p.is_hedge or p.is_base:
            continue
        if held_sym in top_picks:
            continue
        held_days = max(
            0,
            len(provider.all_trading_days("SPY", start=p.entry_date, end=today)) - 1,
        )
        if held_days < min_hold:
            continue
        if held_sym not in opens:
            continue
        fill = _sell_fill(opens[held_sym], slippage_bps)
        portfolio.close(held_sym, fill, today, reason="momentum_rebal_exit")

    if block_buys or top_n <= 0:
        return  # no new entries in NEUTRAL / BEAR / HALT

    # BUY leg — equal-weight target per slot, capped by max_position_pct.
    # v10f: when target_vol_per_position_pct is set, size each name to
    # contribute equal portfolio variance instead — bigger size on calm
    # names, smaller on volatile names. Cap still applies.
    equity = portfolio.equity()
    if equity <= 0:
        return
    max_pct = params["max_position_pct"] / 100.0
    target_value_per_slot = min(
        equity / max(top_n, 1) * 0.95,  # 5 % cushion for slippage / cash floor
        equity * max_pct,
    )
    min_cash = equity * (params.get("min_cash_pct", 5.0) / 100.0)
    target_vol = float(params.get("target_vol_per_position_pct", 0.0))

    for sym in select_top_n(ranked, top_n):
        if portfolio.non_hedge_position_count() >= top_n:
            break
        if portfolio.has_position(sym):
            continue
        if sym not in opens:
            continue
        fill_price = _buy_fill(opens[sym], slippage_bps)
        # Vol-targeted sizing override
        if target_vol > 0:
            bars = provider.bars_up_to(sym, prev_day, lookback_days=30)
            if len(bars) >= 21:
                closes = bars["close"].astype(float)
                rets = closes.pct_change().dropna().iloc[-20:]
                if len(rets) >= 5 and rets.std() > 0:
                    vol_frac = float(rets.std()) * (252 ** 0.5)
                    if vol_frac > 0:
                        target_v = equity * (target_vol / 100.0) / vol_frac
                        target_value_per_slot_this_name = min(target_v, equity * max_pct)
                        qty = int(target_value_per_slot_this_name / fill_price)
                    else:
                        qty = int(target_value_per_slot / fill_price)
                else:
                    qty = int(target_value_per_slot / fill_price)
            else:
                qty = int(target_value_per_slot / fill_price)
        else:
            qty = int(target_value_per_slot / fill_price)
        if qty <= 0:
            continue
        cost = qty * fill_price
        if portfolio.cash - cost < min_cash:
            continue
        # 25 % sector cap (treat unknown sector as bypass — same as legacy).
        info = get_symbol_info(sym)
        sec = info.get("sector", "Unknown")
        if sec not in ("Hedge", "Unknown"):
            sector_value = cost
            for held_sym, held_p in portfolio.positions.items():
                if get_symbol_info(held_sym).get("sector") == sec:
                    sector_value += held_p.market_value
            if sector_value / equity > 0.25:
                continue
        portfolio.open(sym, qty, fill_price, today)


# ────────────────────────────── main loop ──────────────────────────────────


def run_backtest(
    config: BacktestConfig,
    *,
    provider: BarProvider | None = None,
) -> dict:
    """Run a full backtest. Returns a dict with daily history, trades, metrics."""
    provider = provider or BarProvider()
    portfolio = SimulatedPortfolio(starting_cash=config.starting_cash)

    if config.universe is not None:
        universe = config.universe
    else:
        available = set(provider.available_symbols())
        # A simulation starts from cash and must not inherit symbols from the
        # operator's live positions snapshot.  Held-only names exist solely so
        # live execution can liquidate them; admitting them to a historical
        # ranking would make results depend on unrelated broker state.
        universe = [
            s
            for s in load_universe_symbols(held_symbols=[])
            if s in available
        ]
    # Infrastructure may be retained solely to price/exit old positions; none
    # belongs in the cross-sectional stock ranking.
    infrastructure = {"SPY", "SH", "SSO", "TQQQ", "UPRO", "BIL"}
    candidates = [s for s in universe if s not in infrastructure]

    # Use SPY calendar to drive the loop
    all_days = provider.all_trading_days("SPY", start=config.start_date, end=config.end_date)
    if not all_days:
        raise RuntimeError(f"No SPY bars available between {config.start_date} and {config.end_date}")

    log.info(f"Backtest: {config.start_date} → {config.end_date} | {len(all_days)} trading days")
    log.info(f"Universe: {len(candidates)} candidates + SPY + SH")
    log.info(f"Starting cash: ${config.starting_cash:,.0f} | slippage: {config.slippage_bps} bps")

    last_progress = 0
    # v8: asymmetric regime confirmation.
    #   • entering BULL takes ENTRY days (default 1 → fast)
    #   • exiting BULL  takes EXIT  days (default 3 → cautious)
    # Walk-forward W2/W3 showed −16 pp/yr alpha from 3-day-delayed entry
    # into the BULL after the 2022 bottom + the 2023 H1 rally. The slow
    # exit prevents BULL↔NEUTRAL daily-flip churn that wrecked v6 iter 1.
    from strategy_config import (  # noqa: PLC0415
        REGIME_CONFIRMATION_DAYS_ENTRY,
        REGIME_CONFIRMATION_DAYS_EXIT,
    )
    # We carry max(ENTRY, EXIT) days of raw history so we can answer
    # both confirmations from one buffer.
    _REGIME_BUFFER = max(REGIME_CONFIRMATION_DAYS_ENTRY,
                         REGIME_CONFIRMATION_DAYS_EXIT)
    regime_history: list[str] = []
    confirmed_regime: str | None = None
    prev_confirmed_regime: str | None = None
    adaptive_pending_plan: dict | None = None
    adaptive_risk_off_latched = False
    for idx, date in enumerate(all_days):
        signal_date = provider.previous_trading_day("SPY", date)
        if signal_date is None:
            # There is no completed session from which a legal signal can be
            # formed. Keep cash and begin once a prior close exists.
            portfolio.record_snapshot(date, "NEUTRAL", "NORMAL")
            continue

        # Every order filled at today's open must use risk information that
        # was complete before that open.  Reuse one immutable tier throughout
        # the session; today's opening gap is captured in today's snapshot and
        # can influence tomorrow's decision only.
        decision_risk_tier = _completed_session_risk_tier(portfolio)

        # Build a snapshot of OHLC for all relevant symbols today
        opens, highs, lows, closes = {}, {}, {}, {}
        pricing_symbols = dict.fromkeys(
            candidates
            + ["SPY", "SH", "TQQQ", "UPRO", "SSO", "BIL", *SECTOR_ETF_UNIVERSE]
        )
        for sym in pricing_symbols:
            bar = provider.bar_at(sym, date)
            if bar:
                opens[sym] = bar["open"]
                highs[sym] = bar["high"]
                lows[sym] = bar["low"]
                closes[sym] = bar["close"]

        # 1. Mark to market at today's OPEN before any trades fire
        portfolio.mark_to_market(opens)

        # v8: asymmetric regime confirmation.
        raw_regime = _spy_regime(provider, signal_date)
        regime_history.append(raw_regime)
        if len(regime_history) > _REGIME_BUFFER:
            regime_history.pop(0)

        # Bootstrap: before the buffer fills, accept the raw regime.
        if confirmed_regime is None:
            confirmed_regime = raw_regime
        else:
            # Detect a candidate transition vs the current confirmed state.
            if raw_regime != confirmed_regime:
                # Different from current confirmed → check the appropriate
                # confirmation window.
                is_entering_bull = (raw_regime == "BULL")
                window = (REGIME_CONFIRMATION_DAYS_ENTRY if is_entering_bull
                          else REGIME_CONFIRMATION_DAYS_EXIT)
                recent = regime_history[-window:] if window > 0 else [raw_regime]
                if len(recent) >= window and all(r == raw_regime for r in recent):
                    confirmed_regime = raw_regime

        regime_today = confirmed_regime
        risk_today_for_trans = decision_risk_tier
        params_today = _resolve_params(regime_today, risk_today_for_trans,
                                       config.param_overrides)
        if (prev_confirmed_regime == "BULL"
                and regime_today in ("NEUTRAL", "BEAR")
                and params_today.get("flatten_on_transition", False)):
            flushed = _flatten_on_transition(portfolio, opens, date, config.slippage_bps)
            if flushed:
                log.info(f"  {date}: flattened {flushed} directional positions "
                         f"(confirmed BULL→{regime_today} transition)")

        # 2-4. Stops, scale-outs, time stops (use highs/lows of TODAY)
        # v7: use confirmed_regime so stop widths don't whipsaw on single-day flips.
        risk_for_stops = decision_risk_tier
        stop_params = _resolve_params(confirmed_regime, risk_for_stops, config.param_overrides)

        if not stop_params.get("adaptive_momentum", False):
            _check_trailing_stops(
                portfolio, lows, opens, date, stop_params, config.slippage_bps
            )
            _check_scale_outs(
                portfolio, highs, date, stop_params, config.slippage_bps
            )
            _check_time_stops(
                portfolio,
                opens,
                date,
                stop_params,
                config.slippage_bps,
                provider,
            )

        # 5. Decide candidates / scores depending on strategy mode.
        prev_day = signal_date
        # v7: use confirmed_regime for momentum / base / hedge sizing too.
        regime = confirmed_regime
        _, spy_20d = _spy_returns(provider, prev_day)
        risk_tier = decision_risk_tier
        params = _resolve_params(regime, risk_tier, config.param_overrides)

        # v6: momentum_mode bypasses the heavy compute_confidence_score path
        # (technicals + news + perplexity + sector + ML + sentiment) entirely.
        # Pure 12-month-momentum picking is faster AND produces measurably
        # better alpha in academic literature (Jegadeesh & Titman 1993,
        # Asness et al 2013, Antonacci 2014). Disable by setting
        # `momentum_mode: False` per regime cell to fall back to scoring.
        momentum_mode = params.get("momentum_mode", False)

        scored: dict[str, dict] = {}
        if not momentum_mode:
            sector_state = _historical_sector_state(provider, prev_day, spy_20d)
            for sym in candidates:
                bars = provider.bars_up_to(sym, prev_day, lookback_days=80)
                if len(bars) < 21:
                    continue
                tech = _technicals_from_bars(bars)
                if tech is None or "error" in tech:
                    continue
                news = news_proxy_score(bars, symbol=sym, date=prev_day)
                px = perplexity_proxy_score(bars, symbol=sym, date=prev_day)
                sec = get_symbol_info(sym).get("sector")
                try:
                    from ablation_flags import ABLATE_ML
                    if not ABLATE_ML:
                        from ml_signals import extract_features as _ml_extract
                        ml_feat = _ml_extract(bars, regime=regime)
                        if ml_feat:
                            tech["_ml_features"] = ml_feat
                except Exception:
                    pass
                tech["_symbol"] = sym
                conf = compute_confidence_score(
                    tech, news, px, regime=regime, risk_tier=risk_tier,
                    spy_20d_return=spy_20d, sector=sec,
                    sector_state=sector_state,
                )
                scored[sym] = {"technicals": tech, "confidence": conf}

            # 6. Catalyst flips (score-driven exits)
            _check_catalyst_flips(portfolio, scored, opens, date, config.slippage_bps)

        # 7. Hedge sizing — runs BEFORE buys so it claims cash first
        _manage_hedge(
            portfolio,
            provider,
            date,
            signal_date,
            regime,
            risk_tier,
            config.slippage_bps,
        )

        # 7b. v4: SPY base position — capture market beta during BULL regimes
        _manage_base_position(portfolio, provider, date, params, config.slippage_bps)

        # 7b'. v10e: SGOV cash sleeve — runs BEFORE TQQQ + base so that on
        # regime transitions (BEAR→BULL), SGOV liquidates first and frees
        # cash for the leveraged sleeves. Sizing uses regime TARGETS (not
        # current values) so it won't grab cash that TQQQ would want.
        _manage_cash_sleeve(portfolio, provider, date, params, config.slippage_bps)

        # 7c. v5: TQQQ leveraged BULL beta — gated by SMA50+SMA200 + hard stop
        _manage_tqqq(
            portfolio,
            provider,
            date,
            signal_date,
            params,
            lows,
            config.slippage_bps,
        )

        # 7c''. v10f: UPRO (3× SPY) parallel sleeve — same SMA gate as TQQQ.
        # Adds broad-market leverage so the strategy isn't purely tech-biased.
        _manage_upro(
            portfolio,
            provider,
            date,
            signal_date,
            params,
            lows,
            config.slippage_bps,
        )

        # 7c'''. v10g: PEAD sleeve — gap-up + volume continuation, 10d max hold.
        # Price-action proxy for post-earnings drift since historical EPS
        # data isn't cached. Caps at pead_sleeve_pct of equity.
        _manage_pead_sleeve(
            portfolio, provider, candidates, prev_day, date,
            params, opens, config.slippage_bps,
        )

        # 7d. v9 Phase 2: sector rotation overlay — top-N XL* by 6m return,
        # equal-weighted, rebalanced on month start. is_base=True so exempt
        # from per-stock mechanics (trail stops, scale-outs, time stops).
        _manage_sector_rotation(
            portfolio, provider, date, params, opens, config.slippage_bps,
            prev_date=(all_days[idx - 1] if idx > 0 else None),
        )

        # 8-10. Stock-pick management — branch on strategy mode.
        block_buys = params.get("block_new_buys", False)
        if params.get("adaptive_momentum", False):
            adaptive_cfg = config_from_params(params)
            adaptive_market = compute_market_state(
                provider,
                signal_date,
                config=adaptive_cfg,
            )
            adaptive_risk_off_now = bool(
                risk_tier == "HALT"
                or adaptive_market is None
                or not adaptive_market.above_sma200
            )
            if adaptive_risk_off_now:
                adaptive_risk_off_latched = True
            elif any(
                not position.is_base and not position.is_hedge
                for position in portfolio.positions.values()
            ) and not (
                adaptive_pending_plan is not None
                and adaptive_pending_plan.get("risk_off") is True
            ):
                # A normal month-start may have restored exposure before the
                # recovery confirmation completed. Do not fire a second
                # off-cycle rerank for the same risk-off episode.
                adaptive_risk_off_latched = False
            force_risk_on_reentry = bool(
                adaptive_risk_off_latched
                and not adaptive_risk_off_now
                and adaptive_cfg.risk_on_reentry_confirmation_days > 0
                and market_reentry_confirmed(
                    provider,
                    signal_date,
                    confirmation_days=(
                        adaptive_cfg.risk_on_reentry_confirmation_days
                    ),
                    config=adaptive_cfg,
                )
                and adaptive_pending_plan is None
            )
            adaptive_pending_plan = _execute_adaptive_momentum(
                portfolio=portfolio,
                provider=provider,
                candidates=candidates,
                signal_date=signal_date,
                today=date,
                params=params,
                opens=opens,
                slippage_bps=config.slippage_bps,
                risk_tier=risk_tier,
                prev_date=(all_days[idx - 1] if idx > 0 else None),
                pending_plan=adaptive_pending_plan,
                force_risk_on_reentry=force_risk_on_reentry,
            )
            if force_risk_on_reentry:
                # One fresh target is attempted per risk-off episode. Missing
                # target bars remain inside the frozen pending plan; an empty
                # eligible set waits for the next normal monthly rebalance.
                adaptive_risk_off_latched = False
        elif momentum_mode:
            adaptive_pending_plan = None
            _execute_momentum_picks(
                portfolio=portfolio,
                provider=provider,
                candidates=candidates,
                prev_day=prev_day,
                today=date,
                params=params,
                opens=opens,
                slippage_bps=config.slippage_bps,
                risk_tier=risk_tier,
                block_buys=block_buys,
                prev_date=(all_days[idx - 1] if idx > 0 else None),
            )
        else:
            adaptive_pending_plan = None
            # Legacy v3-v5 path: score-sorted gate-filtered buys.
            gate_min = params.get("gate_score_min", 0.65)
            if risk_tier != "HALT" and not block_buys:
                ranked = sorted(scored.items(),
                                key=lambda kv: kv[1]["confidence"]["total"],
                                reverse=True)
                for sym, data in ranked:
                    if portfolio.non_hedge_position_count() >= params["max_positions"]:
                        break
                    gate_score, _checks = _compute_gate_score(
                        sym, data["technicals"], data["confidence"], spy_20d, params,
                    )
                    if gate_score < gate_min:
                        continue
                    if portfolio.has_position(sym):
                        continue  # don't add to existing in backtest (matches live UX)

                    if sym not in opens:
                        continue  # no trading today
                    fill_price = _buy_fill(opens[sym], config.slippage_bps)
                    atr = data["technicals"].get("atr_14")
                    vol_20d = data["technicals"].get("vol_20d_annualized_pct")
                    qty = _position_size(portfolio.equity(), fill_price, params,
                                          atr=atr, vol_20d_pct=vol_20d)
                    if qty <= 0:
                        continue
                    cost = qty * fill_price
                    # Cash floor — never breach min_cash_pct
                    cash_after = portfolio.cash - cost
                    min_cash = portfolio.equity() * (params["min_cash_pct"] / 100)
                    if cash_after < min_cash:
                        continue
                    # Sector cap — skip if would breach 25%
                    info = get_symbol_info(sym)
                    sec = info.get("sector", "Unknown")
                    if sec != "Hedge" and sec != "Unknown":
                        sector_value = cost
                        for held_sym, p in portfolio.positions.items():
                            if get_symbol_info(held_sym).get("sector") == sec:
                                sector_value += p.market_value
                        if sector_value / portfolio.equity() > 0.25:
                            continue
                    portfolio.open(sym, qty, fill_price, date)

        # 11. Daily snapshot
        portfolio.record_snapshot(date, regime, risk_tier)
        prev_confirmed_regime = confirmed_regime  # v7: feed tomorrow's transition

        # Progress logging every 5%
        progress = int(idx / len(all_days) * 100)
        if progress >= last_progress + 5:
            base_pct = portfolio.base_value() / portfolio.equity() * 100 if portfolio.equity() > 0 else 0
            log.info(f"  [{progress:>3}%] {date} | equity=${portfolio.equity():,.0f} | "
                     f"cash={portfolio.cash_pct():.1f}% | pos={portfolio.non_hedge_position_count()} | "
                     f"spy_base={base_pct:.0f}% | regime={regime}/{risk_tier}")
            last_progress = progress

    final_equity = portfolio.equity()
    total_return = (final_equity - config.starting_cash) / config.starting_cash * 100
    log.info(f"\nFinal: equity=${final_equity:,.0f} | total return={total_return:+.2f}%")

    return {
        "config": {
            "start_date": config.start_date,
            "end_date": config.end_date,
            "starting_cash": config.starting_cash,
            "slippage_bps": config.slippage_bps,
            "universe_size": len(candidates),
            "ranking_universe_sha256": hash_symbol_universe(candidates),
            "strategy_version": "v11-adaptive-momentum",
            "signal_timing": "prior-close-to-next-open",
            "param_overrides": config.param_overrides,
        },
        **portfolio.to_dict(),
    }
