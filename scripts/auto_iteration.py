"""Append latest backtest result to a tracking history file.

Called by the auto-iteration workflow after every nightly backtest.
Writes state/alpha_tracker.json — append-only history of:
  {date, alpha_annual, sharpe, max_dd, total_return, trades, model_auc, run_id}

Detects regressions: if today's alpha drops > 1pp vs 7-day moving average,
prints a warning (visible in GitHub Actions log) but doesn't block.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    PROJECT_ROOT, STATE_DIR,
    setup_logging, get_now_str, get_today_str, load_json, save_json,
)

log = setup_logging("auto_iteration")

TRACKER_PATH = STATE_DIR / "alpha_tracker.json"
LATEST_RESULT_PATH = PROJECT_ROOT / "state" / "backtest" / "latest_result.json"
ML_META_PATH = PROJECT_ROOT / "state" / "ml" / "metadata.json"


def track_latest() -> dict:
    """Read latest backtest + ML meta, append row to tracker."""
    latest = load_json(LATEST_RESULT_PATH)
    if not latest:
        log.warning("No latest_result.json — nothing to track")
        return {}
    m = latest.get("metrics", {})
    ml_meta = load_json(ML_META_PATH) or {}

    row = {
        "date": get_today_str(),
        "timestamp": get_now_str(),
        "run_id": latest.get("run_id"),
        "alpha_annual_pct": m.get("alpha_annual_pct"),
        "total_return_pct": m.get("total_return_pct"),
        "annual_return_pct": m.get("annual_return_pct"),
        "sharpe_ratio": m.get("sharpe_ratio"),
        "max_drawdown_pct": m.get("max_drawdown_pct"),
        "n_trades": m.get("n_trades"),
        "win_rate_pct": m.get("win_rate_pct"),
        "ml_test_auc": ml_meta.get("test_auc"),
        "ml_test_accuracy": ml_meta.get("test_accuracy"),
        "ml_trained_at": ml_meta.get("trained_at"),
    }

    tracker = load_json(TRACKER_PATH) or {"history": []}
    history = tracker.get("history", [])
    history.append(row)

    # Compute 7-day rolling alpha and flag regressions
    recent = [h for h in history[-7:] if h.get("alpha_annual_pct") is not None]
    if len(recent) >= 3:
        avg_alpha = sum(h["alpha_annual_pct"] for h in recent[:-1]) / max(1, len(recent) - 1)
        delta = row["alpha_annual_pct"] - avg_alpha if row.get("alpha_annual_pct") is not None else 0
        row["delta_vs_7d_avg"] = round(delta, 3)
        if delta < -1.0:
            row["regression_flagged"] = True
            log.warning(f"⚠ ALPHA REGRESSION: today {row['alpha_annual_pct']:+.2f}% vs "
                        f"7d avg {avg_alpha:+.2f}% (Δ {delta:+.2f}pp)")

    # Best-ever record
    best = tracker.get("best_run")
    if best is None or (row.get("alpha_annual_pct") or -999) > (best.get("alpha_annual_pct") or -999):
        tracker["best_run"] = row.copy()
        log.info(f"🏆 NEW BEST alpha {row['alpha_annual_pct']:+.2f}% (run {row['run_id']})")

    tracker["history"] = history
    tracker["last_updated"] = get_now_str()
    tracker["n_iterations"] = len(history)
    save_json(TRACKER_PATH, tracker)

    log.info(f"Tracked iteration #{len(history)}: alpha {row.get('alpha_annual_pct')}%")
    return row


def show_history(last_n: int = 14) -> None:
    tracker = load_json(TRACKER_PATH) or {"history": []}
    history = tracker.get("history", [])
    if not history:
        print("No history yet")
        return
    print(f"\nTotal iterations: {len(history)}")
    best = tracker.get("best_run", {})
    if best:
        print(f"Best alpha: {best.get('alpha_annual_pct'):+.2f}%  "
              f"(run {best.get('run_id')} on {best.get('date')})")
    print(f"\nLast {last_n} iterations:")
    print(f"{'Date':<12}{'Alpha':>10}{'Total':>10}{'Sharpe':>9}{'MaxDD':>10}{'Trades':>8}{'ML AUC':>10}{'Δ vs 7d':>10}")
    print("-" * 95)
    for h in history[-last_n:]:
        alpha = h.get("alpha_annual_pct")
        total = h.get("total_return_pct")
        sharpe = h.get("sharpe_ratio")
        dd = h.get("max_drawdown_pct")
        trades = h.get("n_trades", "?")
        auc = h.get("ml_test_auc")
        delta = h.get("delta_vs_7d_avg")
        print(
            f"{h.get('date',''):<12}"
            f"{(alpha or 0):>+9.2f}%"
            f"{(total or 0):>+9.2f}%"
            f"{(sharpe or 0):>8.2f}"
            f"{(dd or 0):>+9.2f}%"
            f"{str(trades):>8}"
            f"{(auc or 0):>10.3f}"
            f"{(delta or 0):>+9.2f}"
        )


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"
    if cmd == "track":
        track_latest()
    elif cmd == "show":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 14
        show_history(n)
    else:
        print("Usage: python3 scripts/auto_iteration.py [track|show [N]]")
