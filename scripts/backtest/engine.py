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
    """Mirror trade.calculate_position_size — regime-adaptive with ATR."""
    max_pct = params["max_position_pct"] / 100.0
    alloc_shares = int((equity * max_pct) / entry_price)
    risk_pct = params["risk_per_trade_pct"] / 100.0
    stop_pct = params["trailing_stop_pct"] / 100.0
    risk_shares = int((equity * risk_pct) / (entry_price * stop_pct))
    # ATR-based sizing — smaller positions in volatile names
    if atr and atr > 0:
        atr_shares = int((equity * risk_pct) / (atr * 2))
    else:
        atr_shares = alloc_shares
    return max(0, min(alloc_shares, risk_shares, atr_shares))


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
        if p.is_hedge:
            continue  # hedge exit is regime-driven, not stop-driven
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
        if p.is_hedge:
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
    """Close positions held > time_stop_days without time_stop_min_gain."""
    closed = 0
    max_days = params["time_stop_days"]
    min_gain = params["time_stop_min_gain"]

    for symbol in list(portfolio.positions.keys()):
        p = portfolio.positions[symbol]
        if p.is_hedge:
            continue
        if p.unrealized_plpc >= min_gain:
            continue
        # Count trading days held using SPY calendar
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
        if p.is_hedge:
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


def _manage_hedge(portfolio: SimulatedPortfolio, provider: BarProvider,
                  date: str, regime: str, risk_tier: str,
                  slippage_bps: float) -> None:
    """Buy/trim/exit SH to match target % for regime + risk tier."""
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
    for idx, date in enumerate(all_days):
        # Build a snapshot of OHLC for all relevant symbols today
        opens, highs, lows, closes = {}, {}, {}, {}
        for sym in candidates + ["SPY", "SH"]:
            bar = provider.bar_at(sym, date)
            if bar:
                opens[sym] = bar["open"]
                highs[sym] = bar["high"]
                lows[sym] = bar["low"]
                closes[sym] = bar["close"]

        # 1. Mark to market at today's OPEN before any trades fire
        portfolio.mark_to_market(opens)

        # 2-4. Stops, scale-outs, time stops (use highs/lows of TODAY)
        regime_for_stops = _spy_regime(provider, date)
        risk_for_stops = _risk_tier(portfolio)
        stop_params = _resolve_params(regime_for_stops, risk_for_stops, config.param_overrides)

        _check_trailing_stops(portfolio, lows, opens, date, stop_params, config.slippage_bps)
        _check_scale_outs(portfolio, highs, date, stop_params, config.slippage_bps)
        _check_time_stops(portfolio, opens, date, stop_params, config.slippage_bps, provider)

        # 5. Compute today's scores using bars UP TO YESTERDAY (no peeking)
        prev_day = all_days[idx - 1] if idx > 0 else date
        regime = _spy_regime(provider, prev_day)
        _, spy_20d = _spy_returns(provider, prev_day)
        sector_state = _historical_sector_state(provider, prev_day, spy_20d)
        risk_tier = _risk_tier(portfolio)
        params = _resolve_params(regime, risk_tier, config.param_overrides)

        scored: dict[str, dict] = {}
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

            # ML features — extracted once per (symbol, day), then attached
            # to the technicals dict via "_ml_features" so compute_
            # confidence_score can call predict_proba without re-fetching bars.
            try:
                from ml_signals import extract_features as _ml_extract
                ml_feat = _ml_extract(bars, regime=regime)
                if ml_feat:
                    tech["_ml_features"] = ml_feat
            except Exception:
                pass
            tech["_symbol"] = sym  # let sentiment lookup find it

            conf = compute_confidence_score(
                tech, news, px, regime=regime, risk_tier=risk_tier,
                spy_20d_return=spy_20d, sector=sec,
                sector_state=sector_state,
            )
            scored[sym] = {"technicals": tech, "confidence": conf}

        # 6. Catalyst flips (close existing positions whose score dropped below 40)
        _check_catalyst_flips(portfolio, scored, opens, date, config.slippage_bps)

        # 7. Hedge sizing — runs BEFORE buys so it claims cash first
        _manage_hedge(portfolio, provider, date, regime, risk_tier, config.slippage_bps)

        # 8-10. Score-sorted buys subject to gate score + caps + cash floor
        gate_min = params.get("gate_score_min", 0.65)
        if risk_tier != "HALT":
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

        # Progress logging every 5%
        progress = int(idx / len(all_days) * 100)
        if progress >= last_progress + 5:
            log.info(f"  [{progress:>3}%] {date} | equity=${portfolio.equity():,.0f} | "
                     f"cash={portfolio.cash_pct():.1f}% | pos={portfolio.non_hedge_position_count()} | "
                     f"regime={regime}/{risk_tier}")
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
