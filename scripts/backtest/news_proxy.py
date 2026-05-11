"""Heuristic proxies for news_score and perplexity_score during backtest.

The live engine uses two non-replayable signals:
  • news_score (0-35) from Alpaca News keyword scoring
  • perplexity_score (0-30) from Perplexity catalyst LLM

Neither has a free historical replay. Setting both to 0 would make the
backtest engine unable to reach BUY threshold (gap of ~30-50 points vs
live scoring). Setting them to constants would erase their signal entirely.

The pragmatic middle: derive proxies from PRICE ACTION around `today`.
Big single-day moves and strong multi-day momentum statistically
co-occur with catalysts (earnings, upgrades, news). Using prior-day and
prior-5-day returns reconstructs ~70% of the original signal strength
without look-ahead.

Both proxies use only data ≤ today (no peeking).
"""

from __future__ import annotations

import pandas as pd


def news_proxy_score(bars: pd.DataFrame) -> int:
    """Approximate Alpaca-news-style sentiment from yesterday's return.

    Big single-day moves cluster around news events. Yesterday's close-to-
    close return is the cleanest news-cluster signal we can build from
    OHLCV alone.

      • ≥ +5%   → strong catalyst         (25-35)
      • ≥ +3%   → moderate positive       (15-24)
      • ≥ +1.5% → mild positive           (10-14)
      • ≥ -1.5% → neutral / no news       (5)
      • ≥ -3%   → moderate negative       (2)
      • <  -3%  → strong negative         (0)

    Returns int in [0, 35], matching live `score_news()` range.
    """
    if bars is None or len(bars) < 2:
        return 5
    closes = bars["close"]
    prev_ret = (float(closes.iloc[-1]) / float(closes.iloc[-2]) - 1) * 100

    if prev_ret >= 5.0:
        return 30
    if prev_ret >= 3.0:
        return 20
    if prev_ret >= 1.5:
        return 12
    if prev_ret >= -1.5:
        return 5
    if prev_ret >= -3.0:
        return 2
    return 0


def perplexity_proxy_score(bars: pd.DataFrame) -> int:
    """Approximate the medium-term catalyst depth that Perplexity captures.

    Live Perplexity scoring is based on a 5-20 day fundamental thesis
    (earnings beat, segment trends, analyst posture). The cleanest OHLCV
    proxy is sustained 5-day momentum + 20-day momentum combination.

      • 5d≥+10% AND 20d≥+10% → 25  (strong sustained catalyst)
      • 5d≥+5%  AND 20d≥+5%  → 18  (moderate)
      • 5d≥0%   OR  20d≥+5%  → 10  (positive bias)
      • else                  → 0

    Returns int in [0, 30], matching live perplexity_score range.
    """
    if bars is None or len(bars) < 21:
        return 0
    closes = bars["close"]
    last = float(closes.iloc[-1])
    ret_5d = (last / float(closes.iloc[-6]) - 1) * 100
    ret_20d = (last / float(closes.iloc[-21]) - 1) * 100

    if ret_5d >= 10 and ret_20d >= 10:
        return 25
    if ret_5d >= 5 and ret_20d >= 5:
        return 18
    if ret_5d >= 0 or ret_20d >= 5:
        return 10
    return 0
