"""Phase 7 (scaffold) — Multi-timeframe scoring overlay.

The engine scores everything on daily bars. That works for trend but
misses entry timing — a stock can be uptrending on daily yet rolling
over on 4h. Multi-timeframe scoring adds a confirmation/disagreement
bonus to detect those divergences.

Design (see IMPLEMENTATION_PLAN.md §3 phase 7):
  Compute technicals on 4h bars (last ~33 days = 200 4h bars)
  Compare with daily technicals:
    Both agree (RSI sweet spot, MACD bullish, > 20-SMA both) → +8 bonus
    Disagree heavily (RSI overbought daily but weak 4h) → −5 penalty
    Mixed / no 4h data → 0 adjustment

Implementation status: pure adjustment function below. Live integration
deferred until 4h bar provider is added to BarProvider (separate small
PR — needs Alpaca subscription tier confirmation for 4h coverage).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class TimeframeTechnicals:
    rsi_14: float | None = None
    macd_above_signal: bool = False
    price_above_sma20: bool = False


def compute_mtf_adjustment(daily: TimeframeTechnicals,
                           four_h: TimeframeTechnicals | None,
                           regime: str | None = "BULL") -> int:
    """Return points to add (positive) or subtract (negative) from score.

    Pure function — no I/O.
    """
    if four_h is None:
        return 0  # missing 4h data → no adjustment

    # Sweet spot bounds depend on regime, but use simple band here for the bonus
    if regime == "BULL":
        sweet_lo, sweet_hi = 55, 80
        oversold_4h = 40
    elif regime == "NEUTRAL":
        sweet_lo, sweet_hi = 50, 70
        oversold_4h = 35
    else:  # BEAR or unknown
        sweet_lo, sweet_hi = 35, 60
        oversold_4h = 30

    agreement_signals = 0
    if (daily.rsi_14 is not None and four_h.rsi_14 is not None and
            sweet_lo <= daily.rsi_14 <= sweet_hi and
            sweet_lo <= four_h.rsi_14 <= sweet_hi):
        agreement_signals += 1
    if daily.macd_above_signal and four_h.macd_above_signal:
        agreement_signals += 1
    if daily.price_above_sma20 and four_h.price_above_sma20:
        agreement_signals += 1

    if agreement_signals == 3:
        return 8
    if agreement_signals == 2:
        return 5
    if agreement_signals == 1:
        return 2

    # Disagreement: daily overbought but 4h weak → bearish divergence
    if (daily.rsi_14 is not None and four_h.rsi_14 is not None and
            daily.rsi_14 > sweet_hi and four_h.rsi_14 < oversold_4h):
        return -5

    return 0


# Live wiring deferred — needs 4h bar fetcher in BarProvider.
def compute_mtf_for_symbol(symbol: str, today: str) -> int:
    """Live scoring (not yet wired). Returns 0 until 4h provider lands."""
    return 0
