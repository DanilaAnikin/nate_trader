"""Monte Carlo robustness — bootstrap daily returns to estimate confidence intervals.

The single-run backtest gives one number for alpha, max drawdown, etc. But
historical returns are one realization of a random process — that single
number doesn't tell us whether the strategy's edge is robust or lucky.

Bootstrap approach (block size = 1 day for simplicity):
  1. Run the baseline backtest once.
  2. Extract daily returns of the portfolio (R_p) and SPY (R_b).
  3. For N simulations:
       a. Sample T daily returns with replacement from R_p (and SPY)
       b. Compound them into an equity curve
       c. Record final equity, max drawdown, total alpha
  4. Report median, 5th and 95th percentiles, and P(beat SPY).

This is a SIMPLE bootstrap — block bootstrapping or stationary bootstrap
would preserve autocorrelation better, but for swing trading with 2-10d
holds, daily-block resampling is adequate first-order robustness.

Total runtime ≈ N × 0 (no actual backtest re-run — we resample the
output). 200 simulations finish in well under a second.
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import setup_logging  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.engine import BacktestConfig, run_backtest  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402

log = setup_logging("backtest_monte_carlo")


def _percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * (p / 100)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] * (c - k) + s[c] * (k - f)


def _max_drawdown(series: list[float]) -> float:
    if not series:
        return 0.0
    peak = series[0]
    max_dd = 0.0
    for v in series:
        if v > peak:
            peak = v
        if peak > 0:
            dd = (v / peak - 1) * 100
            if dd < max_dd:
                max_dd = dd
    return max_dd


def run_monte_carlo(start_date: str, end_date: str, starting_cash: float = 1_000_000,
                    n_simulations: int = 200, seed: int = 42) -> dict:
    """Run baseline + N bootstrap simulations on the resulting daily returns."""
    log.info(f"Monte Carlo: baseline backtest first")
    cfg = BacktestConfig(start_date=start_date, end_date=end_date, starting_cash=starting_cash)
    baseline = run_backtest(cfg)
    provider = BarProvider()
    baseline_metrics = compute_metrics(baseline, provider)

    history = baseline["daily_history"]
    if len(history) < 10:
        return {"error": "Not enough history"}

    # Portfolio daily returns
    equity_series = [h["equity"] for h in history]
    daily_returns = []
    for i in range(1, len(equity_series)):
        prev, cur = equity_series[i - 1], equity_series[i]
        daily_returns.append((cur / prev - 1) if prev > 0 else 0.0)

    # SPY daily returns over the same span
    dates = [h["date"] for h in history]
    spy_baseline = baseline_metrics.get("spy_baseline_equity", [])
    spy_returns = []
    for i in range(1, len(spy_baseline)):
        prev, cur = spy_baseline[i - 1], spy_baseline[i]
        spy_returns.append((cur / prev - 1) if prev > 0 else 0.0)

    if not daily_returns or not spy_returns:
        return {"error": "No daily returns extracted"}

    log.info(f"Bootstrapping {n_simulations} simulations from {len(daily_returns)} daily returns")
    rng = random.Random(seed)
    final_equities, final_spys, alphas, max_dds = [], [], [], []
    n = len(daily_returns)

    for sim in range(n_simulations):
        # Resample with replacement (joint draw to preserve same-day pairing)
        portfolio_eq = starting_cash
        spy_eq = starting_cash
        port_series = [starting_cash]
        for _ in range(n):
            j = rng.randrange(n)
            portfolio_eq *= (1 + daily_returns[j])
            spy_eq *= (1 + spy_returns[min(j, len(spy_returns) - 1)])
            port_series.append(portfolio_eq)
        final_equities.append(portfolio_eq)
        final_spys.append(spy_eq)
        port_total = (portfolio_eq / starting_cash - 1) * 100
        spy_total = (spy_eq / starting_cash - 1) * 100
        alphas.append(port_total - spy_total)
        max_dds.append(_max_drawdown(port_series))

    beat_count = sum(1 for a in alphas if a > 0)

    return {
        "baseline_metrics": baseline_metrics,
        "median_equity": round(_percentile(final_equities, 50), 2),
        "p5_equity": round(_percentile(final_equities, 5), 2),
        "p95_equity": round(_percentile(final_equities, 95), 2),
        "median_spy_equity": round(_percentile(final_spys, 50), 2),
        "median_alpha_pct": round(_percentile(alphas, 50), 4),
        "p5_alpha_pct": round(_percentile(alphas, 5), 4),
        "p95_alpha_pct": round(_percentile(alphas, 95), 4),
        "prob_beat_spy_pct": round(beat_count / n_simulations * 100, 2),
        "median_max_dd_pct": round(_percentile(max_dds, 50), 4),
        "p5_max_dd_pct": round(_percentile(max_dds, 5), 4),
        "p95_max_dd_pct": round(_percentile(max_dds, 95), 4),
        "n_simulations": n_simulations,
        "n_days_per_sim": n,
    }
