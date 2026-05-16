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


def _above_sma200(provider, symbol: str, today: str) -> bool | None:
    """True iff most recent close is above 200-day SMA. None on insufficient
    history. v9 Phase 3 — long-term trend filter; junk momentum (dead-cat
    bounce in a downtrend) fails this test."""
    bars = provider.bars_up_to(symbol, today, lookback_days=210)
    if bars is None or len(bars) < 200:
        return None
    closes = bars["close"].astype(float)
    sma200 = float(closes.rolling(window=200).mean().iloc[-1])
    return float(closes.iloc[-1]) > sma200


def _annualised_volatility(provider, symbol: str, today: str,
                            lookback: int = 63) -> float | None:
    """Annualised stdev of daily log returns over `lookback` (default 63 → ~3m).
    Used to reject extreme-vol junk caps. v9 Phase 3."""
    import math
    bars = provider.bars_up_to(symbol, today, lookback_days=lookback + 10)
    if bars is None or len(bars) < lookback + 1:
        return None
    closes = bars["close"].astype(float).iloc[-(lookback + 1):]
    # Daily log returns
    log_returns = (closes / closes.shift(1)).apply(lambda x: math.log(x) if x > 0 else 0).dropna()
    if len(log_returns) < 10:
        return None
    daily_std = float(log_returns.std())
    return daily_std * math.sqrt(252) * 100  # annualised %


def rank_universe(provider, candidates: Iterable[str], today: str,
                  spy_12m: float, min_abs_return: float = 0.0,
                  apply_quality_filter: bool = False,   # v9 default OFF — caused regression
                  max_annual_vol_pct: float = 80.0,
                  ) -> list[tuple[str, float, float]]:
    """Rank `candidates` by 12-month momentum after dual-momentum + quality
    filters.

    Filter rules (in order, all must pass):
      1. 12-month return > `min_abs_return` (absolute momentum, default 0 %)
      2. 12-month return > `spy_12m` (relative momentum — must beat SPY)
      3. **v9 quality**: close > 200-day SMA (long-term uptrend confirmation).
         Filters out bear-market dead-cat bounces and other "junk momentum"
         where 12m return is positive only because of one big rally on a
         broken downtrend.
      4. **v9 quality**: 6-month return > 0.5 × 12-month return.
         Catches names where momentum is concentrated in a single old spike
         (1-month return ≈ 12-month return) — those tend to mean-revert.
      5. **v9 quality**: annualised volatility (63-day) < `max_annual_vol_pct`.
         Rejects extreme-vol micro-caps that are momentum picks one month and
         50 % drawdown the next.

    Quality filters can be disabled by passing `apply_quality_filter=False`
    (used for legacy/large-cap-only universes).

    Returns a list of (symbol, 12m_return_pct, 6m_return_pct) sorted by
    `12m_return_pct` desc, with 6m as a tie-breaker.

    Pure function over the provider — no global state, no caching.
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

        if apply_quality_filter:
            # 3) Long-term trend confirmation
            trend_ok = _above_sma200(provider, sym, today)
            if trend_ok is False:
                continue  # below 200-SMA → junk momentum
            # 4) 6m must be reasonable fraction of 12m (consistency)
            #    Skip when 12m is small (avoid division noise)
            if r12 > 5.0 and r6 <= 0.5 * r12:
                continue
            # 5) Volatility cap
            vol = _annualised_volatility(provider, sym, today)
            if vol is not None and vol > max_annual_vol_pct:
                continue

        rows.append((sym, r12, r6))
    rows.sort(key=lambda r: (-r[1], -r[2]))
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
