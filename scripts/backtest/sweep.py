"""Parameter sweep — find the parameter set that maximizes annual alpha.

Grid search over three of the most-impactful regime knobs:

  • score_threshold_delta  ∈ {-10, -5, 0, +5, +10}   (5 values)
  • risk_per_trade_pct     ∈ {0.5, 0.7, 1.0, 1.3, 1.5}   (5 values)
  • trailing_stop_pct      ∈ {6, 8, 10}             (3 values)

= 75 backtest runs. On a few thousand trading days × 30+ symbols this takes
a few minutes per run, so ~30 min - 2h for the full sweep. The result is
saved to state/backtest/sweep_result.json and consumed by the dashboard.

Each delta is applied across ALL (regime, risk_tier) cells via the "*"
override key — so we're sweeping the SHAPE of the param table, not
individual cells. Cell-level sweeps would be 30^N which is impractical.
"""

from __future__ import annotations

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

log = setup_logging("backtest_sweep")

GRID = [
    # (threshold_delta, risk_per_trade_pct, trailing_stop_pct)
    (delta, risk, stop)
    for delta in [-10, -5, 0, 5, 10]
    for risk in [0.5, 0.7, 1.0, 1.3, 1.5]
    for stop in [6, 8, 10]
]


def _make_overrides(threshold_delta: int, risk_pct: float, stop_pct: float) -> dict:
    """Build a strategy_config override dict for one grid cell.

    The "*" key applies the same overrides to every (regime, risk_tier) cell.
    """
    # threshold_delta is added to the base threshold; risk + stop replace it
    return {
        "*": {
            "_threshold_delta": threshold_delta,  # marker; consumed in engine
            "risk_per_trade_pct": risk_pct,
            "trailing_stop_pct": stop_pct,
        }
    }


def run_sweep(start_date: str, end_date: str, starting_cash: float = 1_000_000) -> list[dict]:
    provider = BarProvider()
    results: list[dict] = []

    log.info(f"Sweep: {len(GRID)} parameter combinations")
    for i, (delta, risk, stop) in enumerate(GRID, 1):
        log.info(f"[{i:>2}/{len(GRID)}] delta={delta:+d} risk={risk}% stop={stop}%")

        # Build overrides — note we re-resolve threshold inside engine via marker
        # so the live threshold table stays intact and only delta is applied.
        overrides = {
            "*": {
                "risk_per_trade_pct": risk,
                "trailing_stop_pct": stop,
            }
        }
        # Apply threshold delta by mutating the param table at run-time:
        # we do this via a small wrapper that intercepts get_strategy_params.
        # Implemented inline as a config-level field.
        cfg = BacktestConfig(
            start_date=start_date,
            end_date=end_date,
            starting_cash=starting_cash,
            param_overrides=_inject_threshold_delta(overrides, delta),
            verbose=False,
        )
        try:
            result = run_backtest(cfg)
            metrics = compute_metrics(result, provider)
        except Exception as e:
            log.error(f"  failed: {e}")
            metrics = {"error": str(e)}

        results.append({
            "params": {
                "score_threshold_delta": delta,
                "risk_per_trade_pct": risk,
                "trailing_stop_pct": stop,
            },
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
        })

    return results


def _inject_threshold_delta(base: dict, delta: int) -> dict:
    """Add score_threshold delta to every regime cell of strategy_config.

    Engine looks for a "_threshold_delta" key alongside other overrides; if
    present, it offsets the resolved threshold by that amount at decision time.
    The override is keyed by "*" so it applies to every (regime, tier) cell.
    """
    out = dict(base)
    star = dict(out.get("*", {}))
    star["_threshold_delta"] = delta
    out["*"] = star
    return out
