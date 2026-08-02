"""Backtest performance metrics — Sharpe, alpha, drawdown, regime breakdown.

Takes the dict produced by engine.run_backtest() and returns a dict of
metrics ready for serialization + dashboard display.

Reference math:
  • Annualized return    : (1 + total_return) ^ (252 / N) − 1
  • Volatility (annual)  : stdev(daily_returns) × √252
  • Sharpe              : mean(portfolio − BIL) / stdev(portfolio − BIL) × √252
  • Max drawdown        : min((equity_t / running_max_t) − 1)
  • Excess CAGR         : portfolio_annual − spy_annual
  • Jensen alpha        : annualized CAPM intercept using BIL as rf proxy
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from backtest.data_provider import BarProvider  # noqa: E402

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


def _asset_baseline(
    provider: BarProvider,
    symbol: str,
    dates: list[str],
    starting_cash: float,
) -> tuple[list[float], int]:
    """Return an open-to-open, forward-filled baseline and observed-bar count.

    If the proxy starts late, its first observed open is rebased to the value
    carried up to that date.  Before then its return is explicitly zero.  This
    preserves one value per portfolio date instead of silently misaligning
    return rows when a symbol misses a session.
    """

    if not dates:
        return [], 0
    scale: float | None = None
    observed = 0
    out: list[float] = []
    last = starting_cash
    for d in dates:
        bar = provider.bar_at(symbol, d)
        if bar is not None:
            open_price = float(bar["open"])
            if open_price > 0:
                observed += 1
                if scale is None:
                    scale = last / open_price
                last = open_price * scale
        out.append(last)
    return out, observed


def _return_series(levels: list[float], dates: list[str]) -> pd.Series:
    """Create returns with an explicit pre-first-session capital observation."""

    index = ["__STARTING_CAPITAL__", *dates]
    return pd.Series(levels, index=index, dtype=float).pct_change().dropna()


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
    portfolio_levels = [starting_cash, *equity_series]

    # ────── core returns ──────
    total_return_pct = (final_equity - starting_cash) / starting_cash * 100
    # There are len(history)-1 elapsed open-to-open intervals.  The explicit
    # starting-capital observation below exists to capture first-fill costs,
    # but it does not add a day to the CAGR horizon.
    n_return_intervals = max(1, len(history) - 1)
    annual_return = _annualize(total_return_pct, n_return_intervals)

    # Daily returns include first-session fill friction relative to starting
    # cash. Sharpe is calculated after the risk-free proxy is aligned below.
    daily_pct = _return_series(portfolio_levels, dates)
    daily_vol = float(daily_pct.std(ddof=1)) if len(daily_pct) > 1 else 0.0
    annual_vol = daily_vol * (TRADING_DAYS_PER_YEAR ** 0.5) * 100

    # ────── drawdown ──────
    max_dd, dd_peak, dd_trough = _max_drawdown(portfolio_levels)

    # ────── SPY baseline + alpha ──────
    spy_line, spy_observed = _asset_baseline(provider, "SPY", dates, starting_cash)
    spy_total = (spy_line[-1] - starting_cash) / starting_cash * 100 if spy_line else 0
    spy_annual = _annualize(spy_total, n_return_intervals)
    alpha_annual = annual_return - spy_annual
    alpha_total = total_return_pct - spy_total

    # BIL is a liquid 1–3 month T-bill ETF and its adjusted bars include cash
    # distributions. If it is wholly unavailable, the fallback is explicitly
    # reported and the risk-free return is zero rather than silently guessed.
    risk_free_line, risk_free_observed = _asset_baseline(
        provider, "BIL", dates, starting_cash
    )
    risk_free_total = (
        (risk_free_line[-1] - starting_cash) / starting_cash * 100
        if risk_free_line
        else 0.0
    )
    risk_free_annual = _annualize(risk_free_total, n_return_intervals)

    # Daily benchmark-relative statistics use identical, date-indexed
    # open-to-open clocks. Jensen alpha is the arithmetic annualized CAPM
    # intercept: (Rp-Rf) = alpha + beta*(Rm-Rf).
    spy_daily = _return_series([starting_cash, *spy_line], dates)
    risk_free_daily = _return_series([starting_cash, *risk_free_line], dates)
    aligned = pd.concat(
        [daily_pct, spy_daily, risk_free_daily],
        axis=1,
    ).dropna()
    aligned.columns = ["portfolio", "spy", "risk_free"]
    beta = 0.0
    jensen_alpha = 0.0
    tracking_error = 0.0
    information_ratio = 0.0
    sharpe = 0.0
    if len(aligned) > 1:
        portfolio_excess = aligned["portfolio"] - aligned["risk_free"]
        market_excess = aligned["spy"] - aligned["risk_free"]
        benchmark_variance = float(market_excess.var(ddof=1))
        if benchmark_variance > 0:
            beta = float(portfolio_excess.cov(market_excess)) / benchmark_variance
        intercept_daily = float((portfolio_excess - beta * market_excess).mean())
        jensen_alpha = intercept_daily * TRADING_DAYS_PER_YEAR * 100.0
        active = aligned["portfolio"] - aligned["spy"]
        active_std = float(active.std(ddof=1))
        tracking_error = active_std * (TRADING_DAYS_PER_YEAR ** 0.5) * 100.0
        if active_std > 0:
            information_ratio = (
                float(active.mean()) / active_std
                * (TRADING_DAYS_PER_YEAR ** 0.5)
            )
        excess_std = float(portfolio_excess.std(ddof=1))
        if excess_std > 0:
            sharpe = (
                float(portfolio_excess.mean()) / excess_std
                * (TRADING_DAYS_PER_YEAR ** 0.5)
            )

    def drawdown_date(augmented_index: int) -> str | None:
        if not dates:
            return None
        return dates[max(0, augmented_index - 1)]

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
            "total_pnl_pct": (
                float((pd.Series(pnls).div(100.0).add(1.0).prod() - 1.0) * 100.0)
            ),
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
        "excess_cagr_pct": round(alpha_annual, 4),
        "jensen_alpha_annual_pct": round(jensen_alpha, 4),
        "beta_to_spy": round(beta, 4),
        "risk_free_proxy": "BIL",
        "risk_free_total_return_pct": round(risk_free_total, 4),
        "risk_free_annual_return_pct": round(risk_free_annual, 4),
        "risk_free_fallback_zero": risk_free_observed == 0,
        "risk_free_observed_sessions": risk_free_observed,
        "spy_observed_sessions": spy_observed,
        "tracking_error_annual_pct": round(tracking_error, 4),
        "information_ratio": round(information_ratio, 4),
        "annual_vol_pct": round(annual_vol, 4),
        "sharpe_ratio": round(sharpe, 4),
        "max_drawdown_pct": round(max_dd, 4),
        "max_drawdown_peak_date": drawdown_date(dd_peak),
        "max_drawdown_trough_date": drawdown_date(dd_trough),
        "n_trading_days": len(history),
        "n_return_intervals": n_return_intervals,
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
