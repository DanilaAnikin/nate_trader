"""Walk-forward parameter optimization — robustness over single-period overfitting.

The naive sweep finds the parameter set that maximizes alpha over the
entire backtest window. That number is meaningless if those parameters
were over-fitted to a specific market regime that won't repeat.

Walk-forward fixes this:
  1. Slice the backtest window into N rolling segments
  2. For each segment, treat the first half as TRAIN: run a mini-sweep
     and pick the params that maximize annual alpha
  3. Apply those params to the second half (TEST) — a strict
     out-of-sample measurement
  4. Aggregate test-period metrics across segments — these reflect what
     the strategy would have done if you periodically re-optimized

Configuration (defaults aim for ~30 backtests total, runtime ~2h):
  • 3 segments: each 18 months total (12 train + 6 test)
  • Mini-sweep grid: 3 threshold deltas × 3 risk values = 9 backtests
  • Per segment: 9 train + 1 test = 10 backtests
  • Total: 3 × 10 = 30 backtests
"""

from __future__ import annotations

import calendar
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import setup_logging  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.engine import BacktestConfig, run_backtest  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402

log = setup_logging("backtest_walk_forward")

# Mini-sweep grid for in-sample optimization (kept tight to keep runtime
# tractable — full sweep is for global optimization, walk-forward is for
# robustness).
MINI_GRID = [
    (delta, risk)
    for delta in [-5, 0, 5]
    for risk in [0.7, 1.0, 1.3]
]


def _add_months(date_str: str, months: int) -> str:
    """Add `months` to a YYYY-MM-DD date, clamping day-of-month if needed."""
    d = datetime.strptime(date_str, "%Y-%m-%d")
    total_month = d.month - 1 + months
    new_year = d.year + total_month // 12
    new_month = total_month % 12 + 1
    last_day = calendar.monthrange(new_year, new_month)[1]
    new_day = min(d.day, last_day)
    return f"{new_year:04d}-{new_month:02d}-{new_day:02d}"


def _build_windows(start: str, end: str,
                   train_months: int = 12, test_months: int = 6,
                   max_windows: int = 3) -> list[tuple[str, str, str, str]]:
    """Generate (train_start, train_end, test_start, test_end) windows.

    Windows step forward by `test_months` so each test period is unique
    (no overlap). The walk-forward stops at the first window that would
    extend past `end`.
    """
    out = []
    cursor = start
    final = datetime.strptime(end, "%Y-%m-%d")
    while len(out) < max_windows:
        train_start = cursor
        train_end = _add_months(train_start, train_months)
        test_start = train_end
        test_end = _add_months(test_start, test_months)
        if datetime.strptime(test_end, "%Y-%m-%d") > final:
            break
        out.append((train_start, train_end, test_start, test_end))
        cursor = _add_months(cursor, test_months)
    return out


def _run_one(start: str, end: str, starting_cash: float,
             threshold_delta: int, risk_pct: float) -> dict:
    overrides = {
        "*": {
            "_threshold_delta": threshold_delta,
            "risk_per_trade_pct": risk_pct,
        }
    }
    cfg = BacktestConfig(
        start_date=start, end_date=end, starting_cash=starting_cash,
        param_overrides=overrides,
    )
    result = run_backtest(cfg)
    return result


def run_walk_forward(start: str, end: str, starting_cash: float = 1_000_000,
                     train_months: int = 12, test_months: int = 6,
                     max_windows: int = 3) -> dict:
    provider = BarProvider()
    windows = _build_windows(start, end, train_months, test_months, max_windows)
    if not windows:
        return {"error": f"No valid windows between {start} and {end} "
                          f"with train={train_months}m / test={test_months}m"}

    log.info(f"Walk-forward: {len(windows)} windows, "
             f"{len(MINI_GRID)} param combos per window, "
             f"{len(windows) * (len(MINI_GRID) + 1)} total backtests")

    segments = []
    for w_idx, (tr_start, tr_end, te_start, te_end) in enumerate(windows, 1):
        log.info(f"\n── Window {w_idx}/{len(windows)} ──")
        log.info(f"  Train: {tr_start} → {tr_end}")
        log.info(f"  Test:  {te_start} → {te_end}")

        # Train phase: mini-sweep
        train_results = []
        for i, (delta, risk) in enumerate(MINI_GRID, 1):
            log.info(f"  Train [{i}/{len(MINI_GRID)}] delta={delta:+d} risk={risk}%")
            try:
                r = _run_one(tr_start, tr_end, starting_cash, delta, risk)
                m = compute_metrics(r, provider)
                train_results.append({
                    "delta": delta, "risk": risk,
                    "alpha_annual_pct": m.get("alpha_annual_pct", 0),
                    "sharpe": m.get("sharpe_ratio", 0),
                    "total_return_pct": m.get("total_return_pct", 0),
                })
            except Exception as e:
                log.error(f"    train failed: {e}")
                train_results.append({"delta": delta, "risk": risk, "error": str(e)})

        # Pick best by annual alpha
        valid = [t for t in train_results if "error" not in t]
        if not valid:
            log.warning(f"  No valid train results — skipping test phase")
            continue
        best = max(valid, key=lambda t: t["alpha_annual_pct"])
        log.info(f"  Best train: delta={best['delta']:+d} risk={best['risk']}% "
                 f"α={best['alpha_annual_pct']:+.2f}% sharpe={best['sharpe']:.2f}")

        # Test phase: apply best on the test window
        log.info(f"  Test with best params...")
        test_result = _run_one(te_start, te_end, starting_cash,
                               best["delta"], best["risk"])
        test_metrics = compute_metrics(test_result, provider)

        segments.append({
            "window_index": w_idx,
            "train_start": tr_start,
            "train_end": tr_end,
            "test_start": te_start,
            "test_end": te_end,
            "best_params": {
                "threshold_delta": best["delta"],
                "risk_per_trade_pct": best["risk"],
            },
            "train_results": train_results,
            "test_metrics": {
                k: test_metrics.get(k)
                for k in (
                    "total_return_pct", "annual_return_pct",
                    "spy_total_return_pct", "alpha_total_pct",
                    "alpha_annual_pct", "sharpe_ratio",
                    "max_drawdown_pct", "n_trades", "win_rate_pct",
                )
            },
            "test_daily_history": [
                {"date": h["date"], "equity": h["equity"]}
                for h in test_result["daily_history"]
            ],
        })

    # Aggregate: average out-of-sample annual alpha + sharpe
    if not segments:
        return {"error": "No segments completed", "windows": windows}

    valid_test = [s["test_metrics"] for s in segments
                  if s["test_metrics"].get("alpha_annual_pct") is not None]
    avg_alpha = sum(t["alpha_annual_pct"] for t in valid_test) / len(valid_test) if valid_test else 0
    avg_sharpe = sum(t["sharpe_ratio"] for t in valid_test) / len(valid_test) if valid_test else 0
    avg_dd = sum(t["max_drawdown_pct"] for t in valid_test) / len(valid_test) if valid_test else 0

    log.info(f"\n── Walk-forward aggregate ──")
    log.info(f"  Mean OOS alpha:    {avg_alpha:+.2f}%/yr")
    log.info(f"  Mean OOS Sharpe:   {avg_sharpe:.2f}")
    log.info(f"  Mean OOS max DD:   {avg_dd:.2f}%")

    return {
        "config": {
            "start": start, "end": end, "starting_cash": starting_cash,
            "train_months": train_months, "test_months": test_months,
            "max_windows": max_windows,
            "mini_grid_size": len(MINI_GRID),
        },
        "segments": segments,
        "aggregate": {
            "mean_oos_alpha_annual_pct": round(avg_alpha, 4),
            "mean_oos_sharpe": round(avg_sharpe, 4),
            "mean_oos_max_drawdown_pct": round(avg_dd, 4),
            "n_windows": len(segments),
        },
    }
