"""Phase 8 (scaffold) — Post-Earnings Announcement Drift (PEAD).

Academic anomaly: stocks that beat earnings + open with a gap up
continue to drift higher for 5-10 days after the announcement. The
earnings gate (Phase 1) explicitly skips trades near earnings; PEAD
is the *opposite* — entries 1-2 days AFTER a beat.

Design (see IMPLEMENTATION_PLAN.md §3 phase 8):
  Daily post-market routine checks recently-reported watchlist names:
    Symbol had earnings 1-2 days ago AND:
      - EPS surprise > +5% (beat)
      - Next session opened with gap > +3%
      - Volume > 2× 20d average
    → BUY (PEAD candidate, separate sleeve 10-15% equity)

  Hold rules:
    Take profit: +8% gain
    Stop: −3% loss
    Time exit: 10 trading days

Implementation status: pure decision function below. Live integration
needs earnings calendar (Phase 1, already in place) + post-earnings
EPS surprise data (new Perplexity query). Deferred to Phase 8 sprint.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# Tunables
EPS_BEAT_MIN_PCT = 5.0
GAP_UP_MIN_PCT = 3.0
VOLUME_MIN_RATIO = 2.0
PEAD_PROFIT_TARGET_PCT = 8.0
PEAD_STOP_PCT = -3.0
PEAD_TIME_STOP_DAYS = 10
DAYS_AFTER_EARNINGS_WINDOW = (1, 2)  # only consider entries 1-2 days post-report


@dataclass
class PEADCandidate:
    symbol: str
    eps_surprise_pct: float
    gap_up_pct: float
    volume_ratio: float
    days_since_earnings: int
    score: float


def is_pead_setup(eps_surprise_pct: float | None,
                  gap_up_pct: float | None,
                  volume_ratio: float | None,
                  days_since_earnings: int | None) -> bool:
    """Pure check — does this symbol qualify for a PEAD entry today?"""
    if eps_surprise_pct is None or eps_surprise_pct < EPS_BEAT_MIN_PCT:
        return False
    if gap_up_pct is None or gap_up_pct < GAP_UP_MIN_PCT:
        return False
    if volume_ratio is None or volume_ratio < VOLUME_MIN_RATIO:
        return False
    if days_since_earnings is None:
        return False
    lo, hi = DAYS_AFTER_EARNINGS_WINDOW
    if not (lo <= days_since_earnings <= hi):
        return False
    return True


def score_pead(eps_surprise_pct: float, gap_up_pct: float,
               volume_ratio: float) -> float:
    """Strength score 0-1 for ranking PEAD candidates."""
    eps_score = min(1.0, eps_surprise_pct / 20.0)        # 20% surprise = max
    gap_score = min(1.0, gap_up_pct / 10.0)              # 10% gap = max
    vol_score = min(1.0, (volume_ratio - 1.0) / 4.0)     # 5× vol = max
    return 0.5 * eps_score + 0.3 * gap_score + 0.2 * vol_score


def should_exit_pead(position_pnl_pct: float, days_held: int) -> tuple[bool, str]:
    """Pure exit check for an active PEAD position."""
    if position_pnl_pct >= PEAD_PROFIT_TARGET_PCT:
        return True, f"PEAD_TARGET (+{position_pnl_pct:.2f}%)"
    if position_pnl_pct <= PEAD_STOP_PCT:
        return True, f"PEAD_STOP ({position_pnl_pct:.2f}%)"
    if days_held >= PEAD_TIME_STOP_DAYS:
        return True, f"PEAD_TIME_STOP ({days_held}d)"
    return False, ""


# Live wiring deferred — needs Perplexity earnings-surprise query +
# post-market workflow job. See IMPLEMENTATION_PLAN.md phase 8.
def find_pead_candidates() -> list[PEADCandidate]:
    """Live finder (not yet wired). Returns empty list until impl lands."""
    return []
