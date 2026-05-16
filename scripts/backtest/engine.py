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
from pathlib import Path
from typing import Optional

import pandas as pd
import ta

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import setup_logging, get_tradeable_symbols, get_symbol_info  # noqa: E402
from strategy_config import (  # noqa: E402
    get_strategy_params, get_bear_hedge_target_pct,
)
from research import compute_confidence_score, compute_technicals  # noqa: E402
from momentum_picker import (  # noqa: E402
    rank_universe, select_top_n, spy_12m_return, is_month_start,
)

from backtest.data_provider import BarProvider
from backtest.news_proxy import news_proxy_score, perplexity_proxy_score
from backtest.portfolio_sim import SimulatedPortfolio

log = setup_logging("backtest_engine")

SLIPPAGE_BPS = 5  # 0.05% each side, conservative for SPY/AAPL-class liquidity
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
    """Mirror portfolio.update_performance_state() risk-tier logic."""
    history = portfolio.daily_history
    if len(history) < 2:
        return "NORMAL"

    # Weekly: last 5 entries
    week = history[-5:] if len(history) >= 5 else history
    week_start = week[0].equity
    week_pct = (portfolio.equity() - week_start) / week_start * 100 if week_start > 0 else 0.0

    # Monthly: last 22 entries
    month = history[-22:] if len(history) >= 22 else history
    month_start = month[0].equity
    month_pct = (portfolio.equity() - month_start) / month_start * 100 if month_start > 0 else 0.0

    # Mirror portfolio.update_performance_state thresholds:
    # tightened to catch drawdown faster (was −2% weekly).
    daily_pct = history[-1].pnl_pct if history else 0.0
    if month_pct <= -5.0:
        return "HALT"
    if week_pct <= -1.5 or daily_pct <= -2.0:
        return "CAUTIOUS"
    return "NORMAL"


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
                    atr: float | None = None) -> int:
    """Mirror trade.calculate_position_size — v3 vol-targeted with cap."""
    max_pct = params["max_position_pct"] / 100.0
    risk_pct = params["risk_per_trade_pct"] / 100.0
    alloc_shares = int((equity * max_pct) / entry_price)

    if atr and atr > 0:
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
TQQQ_SYMBOL = "TQQQ"  # v5: leveraged BULL beta (3× QQQ)
BASE_REBALANCE_THRESHOLD_PCT = 2.0  # only rebalance when drift > 2% of equity


def _spy_above_sma50_and_sma200(provider: BarProvider, today: str) -> bool:
    """v5 — TQQQ confirmation gate. Both lines must be cleared to risk leverage.

    Why both: SMA50 catches the medium-term trend, SMA200 catches the
    structural cycle. Either alone is too noisy (mid-2022 had a 50-day
    cross above 200 briefly during the bear-market rally).
    """
    bars = provider.bars_up_to("SPY", today, lookback_days=210)
    if bars is None or len(bars) < 200:
        return False  # not enough history → don't risk leverage
    closes = bars["close"].astype(float)
    last = float(closes.iloc[-1])
    sma50 = float(closes.rolling(window=50).mean().iloc[-1])
    sma200 = float(closes.rolling(window=200).mean().iloc[-1])
    return last > sma50 and last > sma200


def _manage_spy_base(portfolio: SimulatedPortfolio, provider: BarProvider,
                     date: str, params: dict, slippage_bps: float) -> None:
    """v4 — maintain a SPY core position at `spy_base_pct` of equity.

    SPY base captures market beta we'd otherwise miss when 100 % in stock
    picks. Mirrors `_manage_hedge` but for the long side.
    """
    target_pct = params.get("spy_base_pct", 0.0)
    equity = portfolio.equity()
    if equity <= 0:
        return

    bar = provider.bar_at(SPY_BASE_SYMBOL, date)
    if bar is None:
        return
    spy_open = bar["open"]

    current_value = portfolio.base_value()
    target_value = equity * (target_pct / 100)
    delta = target_value - current_value
    delta_pct = abs(delta) / equity * 100 if equity > 0 else 0.0

    # Exit entirely if target is 0 and we still hold a SPY base
    if target_pct == 0.0:
        p = portfolio.get_position(SPY_BASE_SYMBOL)
        if p is not None and p.is_base:
            fill = _sell_fill(spy_open, slippage_bps)
            portfolio.close(SPY_BASE_SYMBOL, fill, date, reason="base_exit")
        return

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return

    if delta > 0:
        fill = _buy_fill(spy_open, slippage_bps)
        qty = int(delta / fill)
        if qty >= 1:
            portfolio.open(SPY_BASE_SYMBOL, qty, fill, date, is_base=True)
    else:
        p = portfolio.get_position(SPY_BASE_SYMBOL)
        if not p:
            return
        fill = _sell_fill(spy_open, slippage_bps)
        qty = int(abs(delta) / fill)
        qty = min(qty, p.qty - 1) if p.qty > 1 else p.qty
        if qty >= 1:
            if qty >= p.qty:
                portfolio.close(SPY_BASE_SYMBOL, fill, date, reason="base_exit")
            else:
                portfolio.partial_close(SPY_BASE_SYMBOL, qty, fill, date, reason="base_rebal")


def _manage_tqqq(portfolio: SimulatedPortfolio, provider: BarProvider,
                 date: str, params: dict, day_lows: dict[str, float],
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
    if target_pct > 0 and not _spy_above_sma50_and_sma200(provider, date):
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
                  date: str, regime: str, risk_tier: str,
                  slippage_bps: float) -> None:
    """Buy/trim/exit SH to match target % for regime + risk tier.

    v3: hedge target zeroed when SPY ≥ SMA200 (structural uptrend).
    """
    if not _spy_below_sma200(provider, date):
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

    # Rank survivors and pick the top-N (top_n=0 → empty set → pure SELL).
    ranked = rank_universe(provider, candidates, prev_day, spy_12m)
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
    equity = portfolio.equity()
    if equity <= 0:
        return
    max_pct = params["max_position_pct"] / 100.0
    target_value_per_slot = min(
        equity / max(top_n, 1) * 0.95,  # 5 % cushion for slippage / cash floor
        equity * max_pct,
    )
    min_cash = equity * (params.get("min_cash_pct", 5.0) / 100.0)

    for sym in select_top_n(ranked, top_n):
        if portfolio.non_hedge_position_count() >= top_n:
            break
        if portfolio.has_position(sym):
            continue
        if sym not in opens:
            continue
        fill_price = _buy_fill(opens[sym], slippage_bps)
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


def run_backtest(config: BacktestConfig) -> dict:
    """Run a full backtest. Returns a dict with daily history, trades, metrics."""
    provider = BarProvider()
    portfolio = SimulatedPortfolio(starting_cash=config.starting_cash)

    universe = config.universe or get_tradeable_symbols()
    # SPY is benchmark/regime; SH is hedge — neither is a directional candidate
    candidates = [s for s in universe if s not in ("SPY", "SH")]

    # Use SPY calendar to drive the loop
    all_days = provider.all_trading_days("SPY", start=config.start_date, end=config.end_date)
    if not all_days:
        raise RuntimeError(f"No SPY bars available between {config.start_date} and {config.end_date}")

    log.info(f"Backtest: {config.start_date} → {config.end_date} | {len(all_days)} trading days")
    log.info(f"Universe: {len(candidates)} candidates + SPY + SH")
    log.info(f"Starting cash: ${config.starting_cash:,.0f} | slippage: {config.slippage_bps} bps")

    last_progress = 0
    prev_regime = None  # v4: track for transition detection
    for idx, date in enumerate(all_days):
        # Build a snapshot of OHLC for all relevant symbols today
        opens, highs, lows, closes = {}, {}, {}, {}
        for sym in candidates + ["SPY", "SH", "TQQQ"]:
            bar = provider.bar_at(sym, date)
            if bar:
                opens[sym] = bar["open"]
                highs[sym] = bar["high"]
                lows[sym] = bar["low"]
                closes[sym] = bar["close"]

        # 1. Mark to market at today's OPEN before any trades fire
        portfolio.mark_to_market(opens)

        # v4: detect regime transition from yesterday's regime to today's
        regime_today = _spy_regime(provider, date)
        risk_today_for_trans = _risk_tier(portfolio)
        params_today = _resolve_params(regime_today, risk_today_for_trans,
                                       config.param_overrides)
        if (prev_regime == "BULL" and regime_today in ("NEUTRAL", "BEAR")
                and params_today.get("flatten_on_transition", False)):
            flushed = _flatten_on_transition(portfolio, opens, date, config.slippage_bps)
            if flushed:
                log.info(f"  {date}: flattened {flushed} directional positions "
                         f"(BULL→{regime_today} transition)")

        # 2-4. Stops, scale-outs, time stops (use highs/lows of TODAY)
        regime_for_stops = _spy_regime(provider, date)
        risk_for_stops = _risk_tier(portfolio)
        stop_params = _resolve_params(regime_for_stops, risk_for_stops, config.param_overrides)

        _check_trailing_stops(portfolio, lows, opens, date, stop_params, config.slippage_bps)
        _check_scale_outs(portfolio, highs, date, stop_params, config.slippage_bps)
        _check_time_stops(portfolio, opens, date, stop_params, config.slippage_bps, provider)

        # 5. Decide candidates / scores depending on strategy mode.
        prev_day = all_days[idx - 1] if idx > 0 else date
        regime = _spy_regime(provider, prev_day)
        _, spy_20d = _spy_returns(provider, prev_day)
        risk_tier = _risk_tier(portfolio)
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
        _manage_hedge(portfolio, provider, date, regime, risk_tier, config.slippage_bps)

        # 7b. v4: SPY base position — capture market beta during BULL regimes
        _manage_spy_base(portfolio, provider, date, params, config.slippage_bps)

        # 7c. v5: TQQQ leveraged BULL beta — gated by SMA50+SMA200 + hard stop
        _manage_tqqq(portfolio, provider, date, params, lows, config.slippage_bps)

        # 8-10. Stock-pick management — branch on strategy mode.
        block_buys = params.get("block_new_buys", False)
        if momentum_mode:
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
                    qty = _position_size(portfolio.equity(), fill_price, params, atr=atr)
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
        prev_regime = regime_today  # v4: feed tomorrow's transition detector

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
        },
        **portfolio.to_dict(),
    }
