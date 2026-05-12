"""Phase 5 (scaffold) — Pre-market gap scanner.

Some of the biggest single-day moves come from overnight gaps on news
(earnings, M&A, FDA, macro). The current engine runs once at 9:45 ET,
5 minutes after open — too late to catch the very first leg. This
module is a pre-9:45 hook that scores overnight gap candidates.

Design (see IMPLEMENTATION_PLAN.md §3 phase 5):
  Trigger at market open + 5 min:
    For each watchlist + screener symbol:
      overnight_gap = (today_open − yesterday_close) / yesterday_close

      Gap-up (+3% or more) WITH news → momentum continuation candidate
        Bonus +5 score on top of normal scoring
      Gap-down (−3% or more) AND oversold signs → MR candidate
        Bonus +3 on MR score

Filters: liquidity (spread < 1%), first-5min volume > 1.5× pre-market avg,
no earnings today (Phase 1 already filters).

Implementation status: pure scoring helpers below; live workflow hook
(new gap-scanner job at 9:35 ET) deferred until Phase 3 is validated.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional


GapKind = Literal["GAP_UP", "GAP_DOWN", "NONE"]


@dataclass
class GapSignal:
    symbol: str
    kind: GapKind
    gap_pct: float
    bonus_points: int
    rationale: str


# Tunables
GAP_THRESHOLD_PCT = 3.0
GAP_UP_BONUS = 5
GAP_DOWN_BONUS = 3   # for MR sleeve only
MIN_VOLUME_RATIO = 1.5
MAX_SPREAD_PCT = 1.0


def classify_gap(prior_close: float, today_open: float,
                 first_5min_volume: float, avg_premarket_volume: float,
                 bid: float | None = None, ask: float | None = None,
                 has_news_catalyst: bool = False,
                 oversold_signal: bool = False) -> Optional[GapSignal]:
    """Pure gap classification.

    Returns a GapSignal (with bonus_points) if criteria pass, else None.
    """
    if prior_close <= 0 or today_open <= 0:
        return None

    # Liquidity check
    if bid is not None and ask is not None and ask > 0:
        spread_pct = (ask - bid) / ask * 100
        if spread_pct > MAX_SPREAD_PCT:
            return None

    # Volume check
    if avg_premarket_volume > 0:
        ratio = first_5min_volume / avg_premarket_volume
        if ratio < MIN_VOLUME_RATIO:
            return None

    gap_pct = (today_open - prior_close) / prior_close * 100

    if gap_pct >= GAP_THRESHOLD_PCT and has_news_catalyst:
        return GapSignal(
            symbol="", kind="GAP_UP", gap_pct=gap_pct,
            bonus_points=GAP_UP_BONUS,
            rationale=f"Gap-up {gap_pct:+.1f}% with news",
        )

    if gap_pct <= -GAP_THRESHOLD_PCT and oversold_signal:
        return GapSignal(
            symbol="", kind="GAP_DOWN", gap_pct=gap_pct,
            bonus_points=GAP_DOWN_BONUS,
            rationale=f"Gap-down {gap_pct:+.1f}% with oversold signs",
        )

    return None


# Live wiring deferred — needs new workflow job at 9:35 ET. Stub below.
def run_gap_scan() -> list[GapSignal]:
    """Live scan (not yet wired). Returns empty list until implementation lands."""
    return []
