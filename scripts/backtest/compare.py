"""Comparison mode — run two backtests side-by-side, save both equity curves.

Default comparison: live-defaults vs best-sweep-params. Read the latest
sweep result, find the param combination with highest annual alpha, and
re-run the backtest with both default and tuned params on the same
period. Output goes to state/backtest/comparison_result.json — the
dashboard renders two overlaid equity curves.

Alternative invocation: provide two explicit override sets and compare
those. Currently exposed only via the high-level "compare" CLI command.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, setup_logging  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.engine import BacktestConfig, run_backtest  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402

log = setup_logging("backtest_compare")

SWEEP_RESULT_PATH = PROJECT_ROOT / "state" / "backtest" / "sweep_result.json"


def _read_best_from_sweep() -> dict | None:
    """Best sweep cell by annual alpha — None if sweep wasn't run yet."""
    if not SWEEP_RESULT_PATH.exists():
        return None
    data = json.loads(SWEEP_RESULT_PATH.read_text())
    rows = data.get("results", [])
    valid = [r for r in rows if r.get("metrics", {}).get("alpha_annual_pct") is not None]
    if not valid:
        return None
    best = max(valid, key=lambda r: r["metrics"]["alpha_annual_pct"])
    return best


def _build_overrides(params: dict | None) -> dict | None:
    """Convert a sweep `params` dict into engine override format."""
    if not params:
        return None
    return {
        "*": {
            "_threshold_delta": params.get("score_threshold_delta", 0),
            "risk_per_trade_pct": params.get("risk_per_trade_pct", 1.0),
            "trailing_stop_pct": params.get("trailing_stop_pct", 8.0),
        }
    }


def run_compare(start: str, end: str, starting_cash: float = 1_000_000,
                challenger_params: dict | None = None) -> dict:
    """Run baseline vs challenger. If challenger_params is None, use best sweep."""
    provider = BarProvider()

    if challenger_params is None:
        best = _read_best_from_sweep()
        if not best:
            return {"error": "No sweep result found and no challenger params provided. "
                              "Run sweep first or pass params explicitly."}
        challenger_params = best["params"]
        log.info(f"Challenger params from best sweep: {challenger_params}")

    log.info("Running BASELINE (live default params)...")
    baseline_cfg = BacktestConfig(start_date=start, end_date=end,
                                   starting_cash=starting_cash)
    baseline_result = run_backtest(baseline_cfg)
    baseline_metrics = compute_metrics(baseline_result, provider)

    log.info("Running CHALLENGER (sweep-best params)...")
    challenger_cfg = BacktestConfig(
        start_date=start, end_date=end, starting_cash=starting_cash,
        param_overrides=_build_overrides(challenger_params),
    )
    challenger_result = run_backtest(challenger_cfg)
    challenger_metrics = compute_metrics(challenger_result, provider)

    # Slim daily history to (date, equity) only — saves significant bytes
    # in the committed JSON
    def _slim(daily):
        return [{"date": d["date"], "equity": d["equity"]} for d in daily]

    return {
        "start_date": start,
        "end_date": end,
        "starting_cash": starting_cash,
        "baseline": {
            "label": "Live defaults",
            "params": "default (strategy_config.py)",
            "metrics": baseline_metrics,
            "daily_history": _slim(baseline_result["daily_history"]),
        },
        "challenger": {
            "label": "Sweep-best",
            "params": challenger_params,
            "metrics": challenger_metrics,
            "daily_history": _slim(challenger_result["daily_history"]),
        },
        "spy_baseline_equity": baseline_metrics.get("spy_baseline_equity", []),
        "delta": {
            "alpha_annual_pp": round(
                (challenger_metrics.get("alpha_annual_pct", 0)
                 - baseline_metrics.get("alpha_annual_pct", 0)), 4),
            "sharpe": round(
                challenger_metrics.get("sharpe_ratio", 0)
                - baseline_metrics.get("sharpe_ratio", 0), 4),
            "max_dd_pp": round(
                challenger_metrics.get("max_drawdown_pct", 0)
                - baseline_metrics.get("max_drawdown_pct", 0), 4),
        },
    }
