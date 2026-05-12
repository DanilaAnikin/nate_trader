"""Heuristic proxies for news_score and perplexity_score during backtest.

The live engine uses two non-replayable signals:
  • news_score (0-35) from Alpaca News keyword scoring
  • perplexity_score (0-30) from Perplexity catalyst LLM

New approach: randomized baseline + momentum bonus. This avoids the old
problem of deriving both from price action (which double-counts the
momentum signal already captured by technicals).

News proxy  → random N(6, 2) clipped [2, 12] + bonus if yesterday was +3%
Perplexity proxy → random N(5, 3) clipped [0, 13], only for strong names

Both proxies are seeded per (symbol, date) for reproducibility across runs.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _rng_for(symbol: str, date: str) -> np.random.RandomState:
    """Deterministic RNG seeded by (symbol, date) for reproducibility."""
    seed = hash((symbol, date)) & 0xFFFFFFFF
    return np.random.RandomState(seed)


def news_proxy_score(bars: pd.DataFrame, symbol: str = "", date: str = "") -> int:
    """Approximate news score (0-12, matching new rescaled max).

    Base: random draw from N(6, 2) clipped to [2, 12].
    Bonus: +2 if yesterday's return > +3% (actual news cluster signal).
    """
    rng = _rng_for(symbol, date)
    base = int(np.clip(rng.normal(6, 2), 2, 12))

    # Momentum bonus — big single-day moves cluster around news events
    if bars is not None and len(bars) >= 2:
        closes = bars["close"]
        prev_ret = (float(closes.iloc[-1]) / float(closes.iloc[-2]) - 1) * 100
        if prev_ret >= 3.0:
            base = min(12, base + 2)

    return base


def perplexity_proxy_score(bars: pd.DataFrame, symbol: str = "", date: str = "") -> int:
    """Approximate perplexity score (0-13, matching new rescaled max).

    Only applied to symbols with 20d return > +5% (Perplexity would only
    be run on strong names in live). Others get 0.

    Base: random draw from N(5, 3) clipped to [0, 13].
    """
    if bars is None or len(bars) < 21:
        return 0

    closes = bars["close"]
    last = float(closes.iloc[-1])
    ret_20d = (last / float(closes.iloc[-21]) - 1) * 100

    # Only strong names get perplexity enhancement (matches live behavior)
    if ret_20d < 5.0:
        return 0

    rng = _rng_for(symbol, date)
    return int(np.clip(rng.normal(5, 3), 0, 13))
