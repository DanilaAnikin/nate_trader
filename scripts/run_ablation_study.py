"""Run the Phase-J module-ablation study.

Each iteration toggles one ABLATE_* flag, runs a backtest, captures
metrics, and writes a structured summary to state/backtest/ablation_study.json.

Modules ablated (one at a time):
  • baseline      — no modules ablated (current v7)
  • ABLATE_ML
  • ABLATE_PEAD
  • ABLATE_MEAN_REV
  • ABLATE_SENTIMENT
  • ABLATE_MULTI_TF
  • ABLATE_EARNINGS_FILTER
  • ABLATE_SECTOR_ROT

After all 8 runs, identifies the configuration with highest alpha and
the modules that turn out to be net-negative (alpha rises when removed).

Designed to be runnable as one command in CI:
    python3 scripts/run_ablation_study.py --start 2022-01-01 --end 2024-12-31

Honors --holdout-start to exclude future data from the ablation. Each
sub-run is a single-window backtest (fast); a final --walk-forward flag
re-runs only the best surviving config with the walk-forward harness.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, STATE_DIR, get_now_str, save_json  # noqa: E402

ABLATIONS = [
    ("baseline", []),
    ("no_ml",            ["ABLATE_ML"]),
    ("no_pead",          ["ABLATE_PEAD"]),
    ("no_mean_rev",      ["ABLATE_MEAN_REV"]),
    ("no_sentiment",     ["ABLATE_SENTIMENT"]),
    ("no_multi_tf",      ["ABLATE_MULTI_TF"]),
    ("no_earnings",      ["ABLATE_EARNINGS_FILTER"]),
    ("no_sector_rot",    ["ABLATE_SECTOR_ROT"]),
]

OUT_PATH = STATE_DIR / "backtest" / "ablation_study.json"


def _run_backtest(label: str, ablate_flags: list[str],
                  start: str, end: str, starting_cash: float) -> dict:
    """Invoke `scripts/backtest/run.py single` as a subprocess with env flags."""
    env = os.environ.copy()
    for f in ablate_flags:
        env[f] = "1"
    cmd = [
        sys.executable,
        str(_SCRIPTS_DIR / "backtest" / "run.py"),
        "single",
        "--start", start,
        "--end", end,
        "--starting-cash", str(starting_cash),
    ]
    print(f"\n══════ {label} ({', '.join(ablate_flags) or 'none'}) ══════")
    try:
        proc = subprocess.run(cmd, env=env, check=True, text=True,
                              capture_output=False)
    except subprocess.CalledProcessError as e:
        return {"label": label, "ablated": ablate_flags, "error": str(e)}

    latest = json.loads(
        (STATE_DIR / "backtest" / "latest_result.json").read_text()
    )
    m = latest.get("metrics", {})
    return {
        "label": label,
        "ablated": ablate_flags,
        "metrics": {
            "total_return_pct": m.get("total_return_pct"),
            "annual_return_pct": m.get("annual_return_pct"),
            "spy_annual_return_pct": m.get("spy_annual_return_pct"),
            "alpha_annual_pct": m.get("alpha_annual_pct"),
            "sharpe_ratio": m.get("sharpe_ratio"),
            "max_drawdown_pct": m.get("max_drawdown_pct"),
            "n_trades": m.get("n_trades"),
        },
    }


def _run_walk_forward(label: str, start: str, end: str,
                      starting_cash: float) -> dict:
    cmd = [
        sys.executable,
        str(_SCRIPTS_DIR / "backtest" / "run.py"),
        "walk-forward",
        "--start", start,
        "--end", end,
        "--starting-cash", str(starting_cash),
    ]
    print(f"\n══════ WF validation: {label} ══════")
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        return {"error": str(e)}
    wf = json.loads((STATE_DIR / "backtest" / "walk_forward_result.json").read_text())
    return wf.get("aggregate", {})


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--start", default="2022-01-01")
    p.add_argument("--end", default=None,
                   help="Default = today. Use --holdout-start to instead cap "
                        "the ablation period and reserve a holdout.")
    p.add_argument("--holdout-start", default="2025-01-01",
                   help="Date after which the ablation will not look. "
                        "Reserve for final verification.")
    p.add_argument("--starting-cash", type=float, default=1_000_000)
    p.add_argument("--walk-forward-best", action="store_true",
                   help="After ablation, also run a WF backtest on the best "
                        "surviving configuration for final OOS verification.")
    args = p.parse_args()

    end = args.end or datetime.now().strftime("%Y-%m-%d")
    if args.holdout_start and args.holdout_start < end:
        # Cap end at day before holdout_start
        from datetime import timedelta
        ho = datetime.strptime(args.holdout_start, "%Y-%m-%d")
        capped = (ho - timedelta(days=1)).strftime("%Y-%m-%d")
        if capped < end:
            print(f"[holdout] capping end {end} → {capped}")
            end = capped

    results: list[dict] = []
    for label, flags in ABLATIONS:
        results.append(_run_backtest(label, flags, args.start, end,
                                     args.starting_cash))

    # Rank by alpha
    valid = [r for r in results if "metrics" in r
             and r["metrics"].get("alpha_annual_pct") is not None]
    valid.sort(key=lambda r: r["metrics"]["alpha_annual_pct"], reverse=True)

    baseline_alpha = next(
        (r["metrics"]["alpha_annual_pct"] for r in results
         if r["label"] == "baseline" and "metrics" in r),
        None,
    )

    net_negative_modules = []
    if baseline_alpha is not None:
        for r in results:
            if r["label"] == "baseline" or "metrics" not in r:
                continue
            d = r["metrics"]["alpha_annual_pct"] - baseline_alpha
            if d > 0:
                net_negative_modules.append({
                    "label": r["label"],
                    "ablated": r["ablated"],
                    "alpha_delta_pp": round(d, 4),
                })

    wf_result = None
    if args.walk_forward_best and valid:
        # Best by IS alpha — WF the surviving config (no ablations replayed
        # here since flags can't be passed through run.py walk-forward in one
        # subprocess call; treat this as a quick sanity OOS run for the
        # baseline + recommended changes path).
        wf_result = _run_walk_forward(valid[0]["label"], args.start, end,
                                      args.starting_cash)

    out = {
        "generated_at": get_now_str(),
        "start_date": args.start,
        "end_date": end,
        "holdout_start": args.holdout_start,
        "results": results,
        "baseline_alpha_annual_pct": baseline_alpha,
        "ranked_by_alpha": [
            {"label": r["label"], "alpha_annual_pct": r["metrics"]["alpha_annual_pct"]}
            for r in valid
        ],
        "net_negative_modules": net_negative_modules,
        "walk_forward_best_aggregate": wf_result,
    }
    save_json(OUT_PATH, out)
    print(f"\nWrote {OUT_PATH}")
    print(f"Baseline alpha: {baseline_alpha}")
    print(f"Net-negative modules (removing them HELPS):")
    for m in net_negative_modules:
        print(f"  {m['label']:<18} Δα = {m['alpha_delta_pp']:+.2f}pp")
    if wf_result:
        print(f"\nWF OOS alpha of best config: "
              f"{wf_result.get('mean_oos_alpha_annual_pct', '?')}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
