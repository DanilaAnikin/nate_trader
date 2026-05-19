"""Live-vs-backtest drift monitor — escalate when live alpha breaks down.

Phase F of ALPHA_PLAN.md. Background: live results often diverge from
backtest expectations because of regime shifts, slippage drift, signal
decay, or a silent bug. We want a daily, automated check that catches
this within a week instead of after a quarter.

What it does:
  1. Loads the last 30 trading days of equity from
     `state/performance.json` → daily_history.
  2. Loads SPY closes for the same period from `state/spy_history.json`.
  3. Computes realized 30d alpha = portfolio_return − spy_return.
  4. Loads the latest walk-forward result (state/backtest/walk_forward_result.json)
     to derive an expected alpha mean + std across its OOS windows.
  5. If realized < expected − 2σ on this run AND on each of the prior 4
     runs (5 consecutive escalations), opens a `[risk]` GH issue (best
     effort via `gh`) and sets risk_tier = CAUTIOUS in performance.json.

State: `state/drift_status.json` keeps a small ring of recent checks.

Run daily (e.g. as part of the End-of-Day Summary routine):
    python3 scripts/monitor_drift.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    PROJECT_ROOT, STATE_DIR, PERFORMANCE_STATE,
    load_json, save_json, setup_logging, get_now_str,
)

log = setup_logging("monitor_drift")

DRIFT_STATE = STATE_DIR / "drift_status.json"
SPY_HISTORY = STATE_DIR / "spy_history.json"
WF_RESULT = STATE_DIR / "backtest" / "walk_forward_result.json"

WINDOW_DAYS = 30                    # rolling window for live alpha
CONSEC_ESCALATIONS_TO_ALERT = 5     # daily checks below 2σ before alert
SIGMA_THRESHOLD = 2.0               # how many σ below expected counts as drift


def _portfolio_return_pct(daily_history: list[dict], window_days: int) -> float | None:
    """Return % change of portfolio equity over the last `window_days` entries."""
    if len(daily_history) < window_days + 1:
        return None
    start = float(daily_history[-window_days - 1]["equity"])
    end = float(daily_history[-1]["equity"])
    if start <= 0:
        return None
    return (end / start - 1) * 100


def _spy_return_pct(spy_bars: list[dict], from_date: str, to_date: str) -> float | None:
    """SPY close-to-close return between the given dates (inclusive ends)."""
    by_date = {b["date"]: float(b["close"]) for b in spy_bars}
    if from_date not in by_date or to_date not in by_date:
        # Fall back to nearest available dates
        sorted_dates = sorted(by_date.keys())
        def nearest(d):
            cands = [s for s in sorted_dates if s <= d]
            return cands[-1] if cands else None
        f = nearest(from_date)
        t = nearest(to_date)
        if f is None or t is None:
            return None
        from_date, to_date = f, t
    start = by_date[from_date]
    end = by_date[to_date]
    if start <= 0:
        return None
    return (end / start - 1) * 100


def _expected_alpha_30d() -> tuple[float, float] | None:
    """Pull (mean, std) of 30d alpha from the latest WF run.

    The WF result reports annualized OOS alphas. We scale to 30 trading days
    by dividing by ~8.4 (252/30) so the comparison is apples-to-apples with
    the rolling window.
    """
    wf = load_json(WF_RESULT) or {}
    segments = wf.get("segments") or []
    alphas_annual: list[float] = []
    for s in segments:
        a = (s.get("test_metrics") or {}).get("alpha_annual_pct")
        if a is not None:
            alphas_annual.append(float(a))
    if len(alphas_annual) < 2:
        return None
    mean = sum(alphas_annual) / len(alphas_annual)
    var = sum((a - mean) ** 2 for a in alphas_annual) / (len(alphas_annual) - 1)
    std = var ** 0.5
    # Scale annual → 30-trading-day
    scale = 30.0 / 252.0
    return (mean * scale, std * scale)


def _open_drift_issue(realized: float, expected: float, std: float) -> None:
    """Best-effort: open a [risk] GH issue. Silently no-op if gh CLI missing."""
    title = f"[risk] Live alpha drift — realized {realized:+.2f}% < expected {expected:+.2f}% − 2σ"
    body = (
        f"Drift monitor opened this issue automatically.\n\n"
        f"Window: trailing {WINDOW_DAYS} trading days\n"
        f"Realized alpha:  {realized:+.2f}%\n"
        f"Expected (WF):   {expected:+.2f}% ± {std:.2f}% (1σ)\n"
        f"Threshold:       expected − {SIGMA_THRESHOLD}σ = "
        f"{expected - SIGMA_THRESHOLD * std:+.2f}%\n\n"
        f"This has been below threshold for {CONSEC_ESCALATIONS_TO_ALERT} "
        f"consecutive daily checks. risk_tier auto-escalated to CAUTIOUS in "
        f"state/performance.json. Investigate before flipping back to NORMAL."
    )
    try:
        subprocess.run(
            ["gh", "issue", "create",
             "--repo", "DanilaAnikin/nate_trader",
             "--title", title,
             "--body", body,
             "--label", "risk,P1,claude-code"],
            check=True, capture_output=True, text=True,
        )
        log.info("Opened drift issue via gh")
    except Exception as e:
        log.warning(f"Could not open drift issue via gh: {e}")


def _set_cautious_tier() -> None:
    """Force performance.json risk_tier to CAUTIOUS, leaving other fields."""
    perf = load_json(PERFORMANCE_STATE) or {}
    if perf.get("risk_tier") == "CAUTIOUS":
        return
    perf["risk_tier"] = "CAUTIOUS"
    perf["risk_tier_updated"] = get_now_str()
    perf["risk_tier_reason"] = "drift monitor — 5 consecutive 2σ alpha shortfalls"
    save_json(PERFORMANCE_STATE, perf)
    log.info("risk_tier escalated to CAUTIOUS by drift monitor")


def check_drift() -> dict:
    perf = load_json(PERFORMANCE_STATE) or {}
    spy = load_json(SPY_HISTORY) or {}
    spy_bars = spy.get("bars") or []
    daily_history = perf.get("daily_history") or []

    realized = _portfolio_return_pct(daily_history, WINDOW_DAYS)
    if realized is None:
        return {"status": "insufficient_data",
                "reason": f"need ≥{WINDOW_DAYS + 1} daily_history entries, "
                          f"have {len(daily_history)}"}

    from_date = daily_history[-WINDOW_DAYS - 1]["date"]
    to_date = daily_history[-1]["date"]
    spy_ret = _spy_return_pct(spy_bars, from_date, to_date)
    if spy_ret is None:
        return {"status": "no_spy_data",
                "from_date": from_date, "to_date": to_date}

    realized_alpha = realized - spy_ret

    expected = _expected_alpha_30d()
    if expected is None:
        return {"status": "no_wf_baseline",
                "realized_alpha_pct": round(realized_alpha, 4)}
    exp_mean, exp_std = expected
    threshold = exp_mean - SIGMA_THRESHOLD * exp_std
    breached = realized_alpha < threshold

    history = (load_json(DRIFT_STATE) or {}).get("history", [])
    history.append({
        "date": to_date,
        "realized_alpha_pct": round(realized_alpha, 4),
        "expected_mean_pct": round(exp_mean, 4),
        "expected_std_pct": round(exp_std, 4),
        "threshold_pct": round(threshold, 4),
        "breached": breached,
    })
    # Keep only the last 30 entries
    history = history[-30:]

    consec = 0
    for h in reversed(history):
        if h["breached"]:
            consec += 1
        else:
            break

    out = {
        "status": "breached" if breached else "ok",
        "checked_at": get_now_str(),
        "window_from": from_date,
        "window_to": to_date,
        "realized_alpha_pct": round(realized_alpha, 4),
        "expected_mean_pct": round(exp_mean, 4),
        "expected_std_pct": round(exp_std, 4),
        "threshold_pct": round(threshold, 4),
        "consecutive_breaches": consec,
        "history": history,
    }

    if breached and consec >= CONSEC_ESCALATIONS_TO_ALERT:
        _set_cautious_tier()
        _open_drift_issue(realized_alpha, exp_mean, exp_std)
        out["escalated"] = True

    save_json(DRIFT_STATE, out)
    return out


def main() -> int:
    result = check_drift()
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
