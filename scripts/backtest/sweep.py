"""Parameter sweep — find the parameter set that maximizes annual alpha.

Two metrics are supported:

  • metric="is_alpha"   (default, legacy): optimize in-sample annual alpha
    over the full sweep window. Fast but prone to overfitting.

  • metric="wf_alpha"   (recommended): optimize mean out-of-sample alpha
    across N rolling windows. Each grid cell is evaluated on the same set
    of fixed OOS windows so cells are comparable apples-to-apples. This is
    the metric that survives the IS/OOS gap we measured (~5pp).

The holdout cutoff (--holdout-start) defines a date after which the sweep
WILL NOT touch the data. Use it to reserve a final verification window
that no parameter selection ever sees.

Grid (unchanged):
  • score_threshold_delta  ∈ {-10, -5, 0, +5, +10}    (5 values)
  • risk_per_trade_pct     ∈ {0.5, 0.7, 1.0, 1.3, 1.5}  (5 values)
  • trailing_stop_pct      ∈ {6, 8, 10}               (3 values)

= 75 backtest runs in is_alpha mode.
= 75 × N_windows runs in wf_alpha mode (typically 3 windows → 225 runs).
"""

from __future__ import annotations

import calendar
import sys
from datetime import datetime, timedelta
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import setup_logging  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.engine import BacktestConfig, run_backtest  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402

log = setup_logging("backtest_sweep")

GRID = [
    (delta, risk, stop)
    for delta in [-10, -5, 0, 5, 10]
    for risk in [0.5, 0.7, 1.0, 1.3, 1.5]
    for stop in [6, 8, 10]
]


def _add_months(date_str: str, months: int) -> str:
    d = datetime.strptime(date_str, "%Y-%m-%d")
    total_month = d.month - 1 + months
    new_year = d.year + total_month // 12
    new_month = total_month % 12 + 1
    last_day = calendar.monthrange(new_year, new_month)[1]
    new_day = min(d.day, last_day)
    return f"{new_year:04d}-{new_month:02d}-{new_day:02d}"


def _wf_windows(start: str, end: str, window_months: int = 12,
                step_months: int = 12) -> list[tuple[str, str]]:
    """Generate non-overlapping rolling OOS windows for sweep evaluation.

    Unlike walk_forward.py these are pure OOS slices — every grid cell is
    evaluated on the same windows with the same params, so cells are directly
    comparable.
    """
    out = []
    cursor = start
    final = datetime.strptime(end, "%Y-%m-%d")
    while True:
        win_start = cursor
        win_end = _add_months(cursor, window_months)
        if datetime.strptime(win_end, "%Y-%m-%d") > final:
            break
        out.append((win_start, win_end))
        cursor = _add_months(cursor, step_months)
    return out


def _inject_threshold_delta(base: dict, delta: int) -> dict:
    out = dict(base)
    star = dict(out.get("*", {}))
    star["_threshold_delta"] = delta
    out["*"] = star
    return out


def _run_one(start: str, end: str, starting_cash: float,
             delta: int, risk: float, stop: float) -> dict:
    overrides = _inject_threshold_delta({
        "*": {
            "risk_per_trade_pct": risk,
            "trailing_stop_pct": stop,
        }
    }, delta)
    cfg = BacktestConfig(
        start_date=start,
        end_date=end,
        starting_cash=starting_cash,
        param_overrides=overrides,
        verbose=False,
    )
    return run_backtest(cfg)


def _evaluate_cell(provider: BarProvider, start: str, end: str,
                   starting_cash: float, delta: int, risk: float, stop: float,
                   metric: str, wf_window_months: int,
                   wf_step_months: int) -> dict:
    """Run one grid cell and produce its scoring metric.

    Returns a dict with `params`, `metric_value` (the scalar used for ranking),
    `metric_name`, and `metrics` (full IS metrics; for WF, the averaged OOS
    metrics + per-window detail).
    """
    if metric == "wf_alpha":
        windows = _wf_windows(start, end, wf_window_months, wf_step_months)
        if not windows:
            return {"error": f"No WF windows in {start}..{end}"}
        per_window: list[dict] = []
        alphas = []
        sharpes = []
        dds = []
        for ws, we in windows:
            try:
                r = _run_one(ws, we, starting_cash, delta, risk, stop)
                m = compute_metrics(r, provider)
            except Exception as e:
                per_window.append({"window": [ws, we], "error": str(e)})
                continue
            per_window.append({
                "window": [ws, we],
                "alpha_annual_pct": m.get("alpha_annual_pct"),
                "sharpe_ratio": m.get("sharpe_ratio"),
                "max_drawdown_pct": m.get("max_drawdown_pct"),
                "n_trades": m.get("n_trades"),
            })
            if m.get("alpha_annual_pct") is not None:
                alphas.append(m["alpha_annual_pct"])
                sharpes.append(m["sharpe_ratio"] or 0)
                dds.append(m["max_drawdown_pct"] or 0)
        mean_alpha = sum(alphas) / len(alphas) if alphas else None
        mean_sharpe = sum(sharpes) / len(sharpes) if sharpes else None
        mean_dd = sum(dds) / len(dds) if dds else None
        return {
            "metric_value": mean_alpha if mean_alpha is not None else -999.0,
            "metric_name": "wf_alpha",
            "metrics": {
                "mean_oos_alpha_annual_pct": mean_alpha,
                "mean_oos_sharpe": mean_sharpe,
                "mean_oos_max_drawdown_pct": mean_dd,
                "n_windows": len(alphas),
                "per_window": per_window,
            },
        }

    # Default: in-sample alpha over the full window
    result = _run_one(start, end, starting_cash, delta, risk, stop)
    metrics = compute_metrics(result, provider)
    return {
        "metric_value": metrics.get("alpha_annual_pct", -999.0),
        "metric_name": "is_alpha",
        "metrics": {
            k: metrics.get(k)
            for k in (
                "total_return_pct", "annual_return_pct",
                "spy_total_return_pct", "spy_annual_return_pct",
                "alpha_total_pct", "alpha_annual_pct",
                "sharpe_ratio", "max_drawdown_pct",
                "n_trades", "win_rate_pct", "profit_factor",
            )
        },
    }


def run_sweep(start_date: str, end_date: str, starting_cash: float = 1_000_000,
              metric: str = "is_alpha", holdout_start: str | None = None,
              wf_window_months: int = 12, wf_step_months: int = 12) -> dict:
    """Run the sweep. Returns a dict with `results` list + sweep metadata.

    Args:
      metric: "is_alpha" or "wf_alpha". For wf_alpha, each grid cell is
        evaluated on rolling OOS windows and ranked by mean OOS alpha.
      holdout_start: if set, the sweep window is truncated to end the day
        before this date — the holdout set is reserved for final
        verification that the sweep never sees. Recommended for any new
        production parameter selection.
    """
    if holdout_start is not None:
        try:
            ho = datetime.strptime(holdout_start, "%Y-%m-%d")
            new_end = (ho - timedelta(days=1)).strftime("%Y-%m-%d")
            if new_end < end_date:
                log.info(f"Sweep window truncated by holdout: "
                         f"{start_date}..{new_end}  (holdout starts {holdout_start})")
                end_date = new_end
        except ValueError:
            log.error(f"Bad holdout_start={holdout_start} — ignoring")

    provider = BarProvider()
    results: list[dict] = []

    log.info(f"Sweep: {len(GRID)} combinations, metric={metric}, "
             f"window={start_date}..{end_date}")

    for i, (delta, risk, stop) in enumerate(GRID, 1):
        log.info(f"[{i:>2}/{len(GRID)}] delta={delta:+d} risk={risk}% stop={stop}%")
        try:
            cell = _evaluate_cell(provider, start_date, end_date, starting_cash,
                                  delta, risk, stop, metric,
                                  wf_window_months, wf_step_months)
        except Exception as e:
            log.error(f"  failed: {e}")
            cell = {"error": str(e), "metric_value": -999.0}

        results.append({
            "params": {
                "score_threshold_delta": delta,
                "risk_per_trade_pct": risk,
                "trailing_stop_pct": stop,
            },
            **cell,
        })

    # Identify best cell
    best = max(results, key=lambda r: r.get("metric_value", -999.0))
    log.info(f"Best params by {metric}: {best['params']} "
             f"→ {best.get('metric_value'):+.2f}")

    return {
        "metric": metric,
        "start_date": start_date,
        "end_date": end_date,
        "holdout_start": holdout_start,
        "wf_window_months": wf_window_months if metric == "wf_alpha" else None,
        "results": results,
        "best": best,
    }
