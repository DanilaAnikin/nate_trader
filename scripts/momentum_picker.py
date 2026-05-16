"""Pure 12-month total-return momentum picker — v6 stock selection.

Implements the academically-validated dual momentum recipe:

  • **Absolute momentum** — a stock is only buyable when its 12-month total
    return is > 0 (no negative-momentum names; cash is preferable).
  • **Relative momentum** — among the survivors, rank by 12-month return and
    take the top N. Ties broken by 6-month return.

This replaces the v3/v4/v5 multi-component scoring (technicals + news +
perplexity + sector rotation + ML + sentiment), which has empirically
delivered negative alpha in our backtests. Pure 12-month momentum is the
single most-replicated alpha source in 50+ years of finance research:

  Jegadeesh & Titman (1993)   — 6/12-month momentum beats CAPM
  Asness, Moskowitz, Pedersen — "Value and Momentum Everywhere" (2013)
  Antonacci (2014)            — "Dual Momentum Investing"
  AQR factor library          — Momentum delivers ~3-5 pp/yr alpha 1927-2024

Module is intentionally tiny and pure. No I/O. No model loading. Just
math over the bar provider.
"""

from __future__ import annotations

from typing import Iterable, Optional

import pandas as pd  # noqa: F401 — kept for type clarity on bar frames


LOOKBACK_12M = 252   # ~12 trading months — the canonical Jegadeesh window
LOOKBACK_6M = 126    # ~6 trading months — tie-breaker
MIN_BARS_REQUIRED = 252  # need at least 12m of history to compute the signal


def _total_return_pct(closes, lookback: int) -> Optional[float]:
    """Compute total return % over `lookback` trading days.

    Returns None if not enough bars. Assumes `closes` is a price series with
    the most recent close at `iloc[-1]`.
    """
    if len(closes) < lookback + 1:
        return None
    end = float(closes.iloc[-1])
    start = float(closes.iloc[-(lookback + 1)])
    if start <= 0:
        return None
    return (end / start - 1) * 100


def compute_12m_return(provider, symbol: str, today: str) -> Optional[float]:
    """12-month total-return % for `symbol` as of `today` (exclusive lookahead).

    Reads bars up to (and including) `today` from the provider. Returns
    None when there isn't enough history — caller MUST skip such symbols
    instead of treating them as zero, otherwise the ranking is biased
    toward newly-listed names.
    """
    bars = provider.bars_up_to(symbol, today, lookback_days=LOOKBACK_12M + 20)
    if bars is None or len(bars) < MIN_BARS_REQUIRED:
        return None
    return _total_return_pct(bars["close"].astype(float), LOOKBACK_12M)


def compute_6m_return(provider, symbol: str, today: str) -> Optional[float]:
    """6-month total-return % — used as the ranking tie-breaker."""
    bars = provider.bars_up_to(symbol, today, lookback_days=LOOKBACK_6M + 20)
    if bars is None or len(bars) < LOOKBACK_6M + 1:
        return None
    return _total_return_pct(bars["close"].astype(float), LOOKBACK_6M)


def rank_universe(provider, candidates: Iterable[str], today: str,
                  spy_12m: float, min_abs_return: float = 0.0
                  ) -> list[tuple[str, float, float]]:
    """Rank `candidates` by 12-month momentum after dual-momentum filters.

    Filter rules (both must pass):
      1. 12-month return > `min_abs_return` (absolute momentum, default 0 %)
      2. 12-month return > `spy_12m` (relative momentum — must beat SPY)

    Returns a list of (symbol, 12m_return_pct, 6m_return_pct) sorted by
    `12m_return_pct` desc, with 6m as a tie-breaker (also desc).

    Pure function — no I/O outside the provider, no global state, no caching.
    Bias: skips symbols with insufficient history rather than penalising them.
    """
    rows: list[tuple[str, float, float]] = []
    for sym in candidates:
        r12 = compute_12m_return(provider, sym, today)
        if r12 is None:
            continue
        if r12 <= min_abs_return:
            continue
        if r12 <= spy_12m:
            continue
        r6 = compute_6m_return(provider, sym, today) or 0.0
        rows.append((sym, r12, r6))
    rows.sort(key=lambda r: (-r[1], -r[2]))  # primary 12m desc, tiebreaker 6m
    return rows


def select_top_n(ranked: list[tuple[str, float, float]], n: int) -> list[str]:
    """Pluck the top-N symbols from a ranked list. Caller handles n <= 0."""
    if n <= 0:
        return []
    return [r[0] for r in ranked[:n]]


def spy_12m_return(provider, today: str) -> Optional[float]:
    """Convenience: SPY's 12-month return as of `today`. None if no data."""
    return compute_12m_return(provider, "SPY", today)


def is_month_start(prev_date: str | None, today: str) -> bool:
    """True iff `today` is the first trading day of a new calendar month.

    Compares the year-month component of `prev_date` (yesterday's session)
    against today's. First iteration (prev_date is None) is treated as a
    rebalance day — gives the strategy a clean entry.
    """
    if prev_date is None:
        return True
    return prev_date[:7] != today[:7]


__all__ = [
    "LOOKBACK_12M",
    "LOOKBACK_6M",
    "MIN_BARS_REQUIRED",
    "compute_12m_return",
    "compute_6m_return",
    "rank_universe",
    "select_top_n",
    "spy_12m_return",
    "is_month_start",
]
