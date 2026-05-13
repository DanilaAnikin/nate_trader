"""Retail sentiment from Reddit — free signal layer via PRAW.

Counts daily mentions of each watchlist symbol across r/wallstreetbets,
r/stocks, r/investing, r/StockMarket and applies bullish/bearish
keyword scoring to titles + comments.

Output: state/sentiment.json with per-symbol normalized score (−10..+10).
Used by compute_confidence_score as an additional ±3 adjustment.

PRAW needs `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (free signup).
Missing creds → module returns empty sentiment (graceful degrade).

CLI:
  python3 scripts/sentiment.py refresh        # nightly scrape
  python3 scripts/sentiment.py show
  python3 scripts/sentiment.py score SYMBOL
"""

from __future__ import annotations

import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    STATE_DIR, setup_logging, get_now_str, load_json, save_json,
    get_tradeable_symbols,
)

log = setup_logging("sentiment")

SENTIMENT_PATH = STATE_DIR / "sentiment.json"
CACHE_TTL_HOURS = 24

REDDIT_SUBS = ["wallstreetbets", "stocks", "investing", "StockMarket"]

# Sentiment keywords — coarse but effective for retail sentiment
BULLISH_WORDS = {
    "moon", "buy", "calls", "long", "rocket", "🚀", "yolo", "tendies",
    "bull", "bullish", "rally", "breakout", "squeeze", "diamond",
    "diamondhands", "hold", "hodl", "winner", "win", "lambo", "rich",
    "100x", "10x", "growth", "strong", "beat", "earnings beat",
    "bullrun", "moonshot", "send it",
}
BEARISH_WORDS = {
    "puts", "short", "sell", "bear", "bearish", "crash", "dump",
    "tank", "drill", "drop", "fall", "loser", "lose", "trash",
    "garbage", "scam", "bag", "bagholder", "rip", "dead",
    "shit", "fuck", "down", "decline", "miss", "earnings miss",
    "fraud", "investigation", "lawsuit",
}


def _get_reddit():
    """Initialize PRAW client. Returns None if creds missing."""
    client_id = os.getenv("REDDIT_CLIENT_ID")
    client_secret = os.getenv("REDDIT_CLIENT_SECRET")
    user_agent = os.getenv("REDDIT_USER_AGENT", "nate-trader/1.0")
    if not client_id or not client_secret:
        log.warning("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET missing — sentiment skipped")
        return None
    try:
        import praw
        return praw.Reddit(
            client_id=client_id,
            client_secret=client_secret,
            user_agent=user_agent,
            check_for_async=False,
        )
    except ImportError:
        log.warning("praw not installed — sentiment skipped")
        return None
    except Exception as e:
        log.error(f"Reddit init failed: {e}")
        return None


def _score_text(text: str, symbol: str) -> tuple[int, int]:
    """Return (bullish_count, bearish_count) for text containing symbol mention."""
    lower = text.lower()
    sym_lower = symbol.lower()
    # Require ticker context to avoid counting unrelated chatter
    if f"${sym_lower}" not in lower and f" {sym_lower} " not in f" {lower} ":
        return 0, 0
    b = sum(1 for w in BULLISH_WORDS if w in lower)
    s = sum(1 for w in BEARISH_WORDS if w in lower)
    return b, s


def refresh_sentiment(symbols: list[str] | None = None,
                     lookback_hours: int = 24,
                     per_sub_limit: int = 200) -> dict:
    """Scrape recent posts/comments, score per-symbol."""
    reddit = _get_reddit()
    if reddit is None:
        return {"updated_at": get_now_str(), "scores": {},
                "error": "Reddit creds missing"}

    symbols = symbols or sorted(get_tradeable_symbols())
    cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)

    mentions = defaultdict(int)
    bullish = defaultdict(int)
    bearish = defaultdict(int)

    for sub in REDDIT_SUBS:
        try:
            for post in reddit.subreddit(sub).new(limit=per_sub_limit):
                created = datetime.fromtimestamp(post.created_utc, tz=timezone.utc)
                if created < cutoff:
                    continue
                title_body = f"{post.title} {post.selftext or ''}"
                for sym in symbols:
                    b, s = _score_text(title_body, sym)
                    if b or s:
                        mentions[sym] += 1
                        bullish[sym] += b
                        bearish[sym] += s
        except Exception as e:
            log.warning(f"sub {sub} failed: {e}")
            continue

    # Normalize to −10..+10
    scores = {}
    for sym in symbols:
        m = mentions.get(sym, 0)
        if m == 0:
            scores[sym] = 0
            continue
        b = bullish[sym]
        s = bearish[sym]
        total = b + s
        if total == 0:
            scores[sym] = 0
            continue
        # Score: net bullish / total, scaled to −10..+10, weighted by mentions
        net = (b - s) / total
        confidence = min(1.0, m / 5.0)  # 5+ mentions = full confidence
        scores[sym] = int(round(net * confidence * 10))

    result = {
        "updated_at": get_now_str(),
        "lookback_hours": lookback_hours,
        "n_subs_scanned": len(REDDIT_SUBS),
        "scores": scores,
        "mentions": dict(mentions),
        "bullish_counts": dict(bullish),
        "bearish_counts": dict(bearish),
    }
    save_json(SENTIMENT_PATH, result)
    nonzero = sum(1 for v in scores.values() if v != 0)
    log.info(f"Sentiment refreshed: {nonzero}/{len(scores)} symbols have nonzero score")
    return result


def get_sentiment_score(symbol: str) -> int:
    """Read cached sentiment for a symbol. Returns 0 if missing/stale."""
    data = load_json(SENTIMENT_PATH) or {}
    return int(data.get("scores", {}).get(symbol, 0))


def sentiment_to_adjustment(score: int) -> int:
    """Map −10..+10 sentiment → ±3 score points (small but real signal)."""
    if score >= 7:
        return 3
    if score >= 4:
        return 2
    if score >= 2:
        return 1
    if score <= -7:
        return -3
    if score <= -4:
        return -2
    if score <= -2:
        return -1
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"

    if cmd == "refresh":
        result = refresh_sentiment()
        print(f"Updated at: {result.get('updated_at')}")
        scores = result.get("scores", {})
        nonzero = sorted([(s, v) for s, v in scores.items() if v != 0],
                         key=lambda x: abs(x[1]), reverse=True)
        for s, v in nonzero[:15]:
            print(f"  {s:<6} sentiment={v:+d}  mentions={result['mentions'].get(s, 0)}")

    elif cmd == "show":
        data = load_json(SENTIMENT_PATH)
        if not data:
            print("No sentiment data yet — run `refresh`")
        else:
            print(f"Last updated: {data.get('updated_at')}")
            for s, v in sorted(data.get("scores", {}).items()):
                if v != 0:
                    print(f"  {s:<6} {v:+d}")

    elif cmd == "score" and len(sys.argv) > 2:
        sym = sys.argv[2].upper()
        s = get_sentiment_score(sym)
        adj = sentiment_to_adjustment(s)
        print(f"{sym}: sentiment={s:+d}  → score adjustment {adj:+d}")

    else:
        print("Usage: python3 scripts/sentiment.py [refresh|show|score SYMBOL]")
