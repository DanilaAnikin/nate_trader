"""Backtest performance metrics — Sharpe, alpha, drawdown, regime breakdown.

Takes the dict produced by engine.run_backtest() and returns a dict of
metrics ready for serialization + dashboard display.

Reference math:
  • Annualized return    : (1 + total_return) ^ (252 / N) − 1
  • Volatility (annual)  : stdev(daily_returns) × √252
  • Sharpe              : (annual_return − rf) / annual_vol      (rf = 0)
  • Max drawdown        : min((equity_t / running_max_t) − 1)
  • Alpha (annualized)  : portfolio_annual − spy_annual
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from backtest.data_provider import BarProvider

TRADING_DAYS_PER_YEAR = 252


def _annualize(total_return_pct: float, n_days: int) -> float:
    """Compound annualized return from a total period return + day count."""
    if n_days <= 0:
        return 0.0
    years = n_days / TRADING_DAYS_PER_YEAR
    return ((1 + total_return_pct / 100) ** (1 / years) - 1) * 100 if years > 0 else 0.0


def _max_drawdown(equity_series: list[float]) -> tuple[float, int, int]:
    """Return (max_dd_pct, peak_index, trough_index)."""
    if not equity_series:
        return 0.0, 0, 0
    running_max = equity_series[0]
    peak_idx = 0
    max_dd = 0.0
    dd_peak_idx = 0
    dd_trough_idx = 0
    for i, e in enumerate(equity_series):
        if e > running_max:
            running_max = e
            peak_idx = i
        dd = (e / running_max - 1) * 100 if running_max > 0 else 0
        if dd < max_dd:
            max_dd = dd
            dd_peak_idx = peak_idx
            dd_trough_idx = i
    return max_dd, dd_peak_idx, dd_trough_idx


def _spy_baseline(provider: BarProvider, dates: list[str], starting_cash: float) -> list[float]:
    """Rebase SPY to starting_cash on the first date — gives a $-comparable benchmark line."""
    if not dates:
        return []
    spy_first = provider.bar_at("SPY", dates[0])
    if spy_first is None:
        return [starting_cash] * len(dates)
    scale = starting_cash / spy_first["close"]
    out = []
    last = starting_cash
    for d in dates:
        bar = provider.bar_at("SPY", d)
        if bar is not None:
            last = bar["close"] * scale
        out.append(last)
    return out


def compute_metrics(result: dict, provider: BarProvider | None = None) -> dict:
    history = result.get("daily_history", [])
    trades = result.get("closed_trades", [])
    starting_cash = result.get("starting_cash", 1_000_000)
    final_equity = result.get("final_equity", starting_cash)

    if not history:
        return {"error": "No daily history"}

    if provider is None:
        provider = BarProvider()

    dates = [h["date"] for h in history]
    equity_series = [h["equity"] for h in history]

    # ────── core returns ──────
    total_return_pct = (final_equity - starting_cash) / starting_cash * 100
    n_days = len(history)
    annual_return = _annualize(total_return_pct, n_days)

    # Daily returns for vol + Sharpe
    daily_pct = pd.Series(equity_series).pct_change().dropna()
    daily_vol = float(daily_pct.std()) if len(daily_pct) else 0.0
    annual_vol = daily_vol * (TRADING_DAYS_PER_YEAR ** 0.5) * 100
    sharpe = (annual_return / annual_vol) if annual_vol > 0 else 0.0

    # ────── drawdown ──────
    max_dd, dd_peak, dd_trough = _max_drawdown(equity_series)

    # ────── SPY baseline + alpha ──────
    spy_line = _spy_baseline(provider, dates, starting_cash)
    spy_total = (spy_line[-1] - starting_cash) / starting_cash * 100 if spy_line else 0
    spy_annual = _annualize(spy_total, n_days)
    alpha_annual = annual_return - spy_annual
    alpha_total = total_return_pct - spy_total

    # ────── trade stats ──────
    directional_trades = [t for t in trades if not t.get("is_hedge", False)]
    n_trades = len(directional_trades)
    wins = [t for t in directional_trades if t.get("pnl", 0) > 0]
    losses = [t for t in directional_trades if t.get("pnl", 0) <= 0]
    win_rate = len(wins) / n_trades * 100 if n_trades else 0
    avg_win = sum(t["pnl_pct"] for t in wins) / len(wins) if wins else 0
    avg_loss = sum(t["pnl_pct"] for t in losses) / len(losses) if losses else 0
    profit_factor = (sum(t["pnl"] for t in wins) /
                     abs(sum(t["pnl"] for t in losses))) if losses and sum(t["pnl"] for t in losses) < 0 else float("inf")

    best_trade = max(directional_trades, key=lambda t: t["pnl_pct"]) if directional_trades else None
    worst_trade = min(directional_trades, key=lambda t: t["pnl_pct"]) if directional_trades else None

    # ────── regime breakdown ──────
    regime_buckets: dict[str, list[float]] = {"BULL": [], "NEUTRAL": [], "BEAR": []}
    for h in history:
        regime_buckets.setdefault(h["regime"], []).append(h["pnl_pct"])
    regime_summary = {}
    for r, pnls in regime_buckets.items():
        if not pnls:
            continue
        regime_summary[r] = {
            "days": len(pnls),
            "pct_of_time": len(pnls) / len(history) * 100,
            "avg_daily_pnl_pct": sum(pnls) / len(pnls),
            "total_pnl_pct": sum(pnls),
        }

    # ────── per-symbol P&L ──────
    by_symbol: dict[str, dict] = {}
    for t in directional_trades:
        sym = t["symbol"]
        b = by_symbol.setdefault(sym, {"trades": 0, "wins": 0, "pnl_total": 0.0})
        b["trades"] += 1
        if t["pnl"] > 0:
            b["wins"] += 1
        b["pnl_total"] += t["pnl"]
    per_symbol_sorted = sorted(by_symbol.items(), key=lambda kv: kv[1]["pnl_total"], reverse=True)

    # ────── hedge contribution ──────
    hedge_trades = [t for t in trades if t.get("is_hedge", False)]
    hedge_pnl = sum(t["pnl"] for t in hedge_trades)

    return {
        "total_return_pct": round(total_return_pct, 4),
        "annual_return_pct": round(annual_return, 4),
        "spy_total_return_pct": round(spy_total, 4),
        "spy_annual_return_pct": round(spy_annual, 4),
        "alpha_total_pct": round(alpha_total, 4),
        "alpha_annual_pct": round(alpha_annual, 4),
        "annual_vol_pct": round(annual_vol, 4),
        "sharpe_ratio": round(sharpe, 4),
        "max_drawdown_pct": round(max_dd, 4),
        "max_drawdown_peak_date": dates[dd_peak] if dates else None,
        "max_drawdown_trough_date": dates[dd_trough] if dates else None,
        "n_trading_days": n_days,
        "n_trades": n_trades,
        "win_rate_pct": round(win_rate, 2),
        "avg_win_pct": round(avg_win, 4),
        "avg_loss_pct": round(avg_loss, 4),
        "profit_factor": round(profit_factor, 4) if profit_factor != float("inf") else None,
        "best_trade": best_trade,
        "worst_trade": worst_trade,
        "regime_breakdown": regime_summary,
        "per_symbol": [
            {"symbol": s, **b, "avg_pnl_per_trade": round(b["pnl_total"] / b["trades"], 2)}
            for s, b in per_symbol_sorted
        ],
        "hedge_trades": len(hedge_trades),
        "hedge_total_pnl": round(hedge_pnl, 2),
        "spy_baseline_equity": [round(v, 2) for v in spy_line],
    }
