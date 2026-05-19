"""Generic experiment runner — pass arbitrary param overrides + label.

Usage:
    python3 scripts/experiment.py LABEL '{"*": {"flatten_on_transition": false}}'
    python3 scripts/experiment.py base_pct_45 '{"BULL": {"base_pct": 45}}'

Writes one summary line per experiment to state/backtest/experiments.jsonl
so we can compare runs without re-grepping.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import STATE_DIR, get_now_str  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.engine import BacktestConfig, run_backtest  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402


EXP_LOG = STATE_DIR / "backtest" / "experiments.jsonl"


def run_experiment(label: str, overrides: dict,
                   start: str = "2021-01-01", end: str = "2024-12-31",
                   starting_cash: float = 1_000_000) -> dict:
    cfg = BacktestConfig(
        start_date=start, end_date=end, starting_cash=starting_cash,
        param_overrides=overrides, verbose=False,
    )
    result = run_backtest(cfg)
    provider = BarProvider()
    m = compute_metrics(result, provider)
    summary = {
        "label": label,
        "ran_at": get_now_str(),
        "start": start, "end": end,
        "overrides": overrides,
        "total_return_pct": m["total_return_pct"],
        "annual_return_pct": m["annual_return_pct"],
        "spy_annual_return_pct": m["spy_annual_return_pct"],
        "alpha_annual_pct": m["alpha_annual_pct"],
        "sharpe_ratio": m["sharpe_ratio"],
        "max_drawdown_pct": m["max_drawdown_pct"],
        "n_trades": m["n_trades"],
        "win_rate_pct": m["win_rate_pct"],
        "profit_factor": m["profit_factor"],
        "regime_breakdown": m["regime_breakdown"],
    }
    EXP_LOG.parent.mkdir(parents=True, exist_ok=True)
    with EXP_LOG.open("a") as f:
        f.write(json.dumps(summary) + "\n")
    return summary


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: experiment.py LABEL OVERRIDES_JSON [start] [end]")
        return 1
    label = sys.argv[1]
    overrides = json.loads(sys.argv[2])
    start = sys.argv[3] if len(sys.argv) > 3 else "2021-01-01"
    end = sys.argv[4] if len(sys.argv) > 4 else "2024-12-31"
    s = run_experiment(label, overrides, start=start, end=end)
    print(f"\n{label}: α={s['alpha_annual_pct']:+.2f}%/yr  "
          f"return={s['annual_return_pct']:+.2f}%  "
          f"sharpe={s['sharpe_ratio']:.2f}  "
          f"DD={s['max_drawdown_pct']:.1f}%  "
          f"trades={s['n_trades']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
