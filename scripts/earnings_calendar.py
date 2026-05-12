"""Earnings calendar — block buys near reporting dates.

Earnings releases are binary risk events: stocks routinely move ±5-15%
overnight on a single number. The momentum engine has no edge over that
randomness, so we keep it out of fresh trades for the 5 days leading
up to a known earnings date.

Source of truth is Perplexity — once a week we ask for the next
earnings date of every watchlist + currently-held symbol. The result
is cached to state/earnings_calendar.json with a TTL of 8 days (one
week + grace). Gate-score logic reads from the cache; if a symbol's
date is unknown, no block (graceful degrade).

CLI:
    python3 scripts/earnings_calendar.py refresh        # Force re-fetch
    python3 scripts/earnings_calendar.py show           # Print cache contents
    python3 scripts/earnings_calendar.py risk SYMBOL    # Days until earnings
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    PROJECT_ROOT, STATE_DIR, PERPLEXITY_API_KEY,
    setup_logging, get_today_str, get_now_str, load_json, save_json,
    get_tradeable_symbols,
)

log = setup_logging("earnings_calendar")

CALENDAR_PATH = STATE_DIR / "earnings_calendar.json"
CACHE_TTL_DAYS = 8
EARNINGS_BLOCK_WINDOW_DAYS = 5  # block buys within this many days of earnings


# ─────────────────────────── Perplexity batch query ────────────────────────


def _ask_perplexity_for_earnings(symbols: list[str]) -> dict[str, str | None]:
    """Ask Perplexity for the next earnings date of each symbol.

    Returns dict {symbol: "YYYY-MM-DD" or None}. None means "unknown,
    don't block, don't bonus".
    """
    if not PERPLEXITY_API_KEY:
        log.warning("No Perplexity API key — returning unknown dates")
        return {s: None for s in symbols}

    import requests

    today_str = get_today_str()
    prompt = (
        f"For each of the following US stock tickers, find the date of "
        f"their NEXT scheduled quarterly earnings release after today "
        f"({today_str}). Return a JSON object mapping ticker → date "
        f"in YYYY-MM-DD format. If unknown, use null.\n\n"
        f"Tickers: {', '.join(symbols)}\n\n"
        f"Return ONLY the JSON object, no commentary. Example:\n"
        f'{{"AAPL": "2026-07-31", "NVDA": "2026-08-20", "FOO": null}}'
    )

    try:
        resp = requests.post(
            "https://api.perplexity.ai/chat/completions",
            headers={
                "Authorization": f"Bearer {PERPLEXITY_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "sonar",
                "messages": [
                    {"role": "system", "content": "You are a financial data assistant. Return only valid JSON."},
                    {"role": "user", "content": prompt},
                ],
                "max_tokens": 2048,
                "temperature": 0.1,
            },
            timeout=60,
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()

        # Strip code fences if present
        if "```" in content:
            content = re.sub(r"^```(?:json)?\s*", "", content)
            content = re.sub(r"\s*```\s*$", "", content)

        parsed = json.loads(content)
        if not isinstance(parsed, dict):
            log.warning(f"Perplexity returned non-dict: {type(parsed)}")
            return {s: None for s in symbols}

        # Sanitize: only accept YYYY-MM-DD strings or None
        out = {}
        for sym in symbols:
            v = parsed.get(sym) or parsed.get(sym.upper())
            if isinstance(v, str) and re.match(r"^\d{4}-\d{2}-\d{2}$", v):
                # Sanity check: date must be in the future and within next 6 months
                try:
                    d = datetime.strptime(v, "%Y-%m-%d").date()
                    today = date.today()
                    if today <= d <= today + timedelta(days=180):
                        out[sym] = v
                    else:
                        out[sym] = None
                except ValueError:
                    out[sym] = None
            else:
                out[sym] = None
        return out

    except Exception as e:
        log.error(f"Perplexity earnings query failed: {e}")
        return {s: None for s in symbols}


# ─────────────────────────────── public API ────────────────────────────────


def load_calendar() -> dict:
    return load_json(CALENDAR_PATH) or {"updated_at": None, "dates": {}}


def save_calendar(dates: dict[str, str | None]) -> None:
    save_json(CALENDAR_PATH, {
        "updated_at": get_now_str(),
        "dates": dates,
    })


def is_stale(calendar: dict | None = None) -> bool:
    """True if the cache is older than CACHE_TTL_DAYS or empty."""
    calendar = calendar or load_calendar()
    updated = calendar.get("updated_at")
    if not updated:
        return True
    try:
        last = datetime.strptime(updated, "%Y-%m-%d %H:%M:%S")
        return (datetime.now() - last) > timedelta(days=CACHE_TTL_DAYS)
    except ValueError:
        return True


def refresh_calendar(symbols: list[str] | None = None, force: bool = False) -> dict:
    """Re-fetch earnings dates for all tradeable watchlist symbols.

    No-op if not stale (unless force=True). Returns the calendar dict.
    """
    cal = load_calendar()
    if not force and not is_stale(cal):
        log.info(f"Calendar is fresh (updated {cal.get('updated_at')})")
        return cal

    if symbols is None:
        symbols = sorted(get_tradeable_symbols())

    # Batch in groups of 15 to stay under Perplexity context limits
    all_dates: dict[str, str | None] = {}
    BATCH = 15
    for i in range(0, len(symbols), BATCH):
        chunk = symbols[i:i + BATCH]
        log.info(f"Fetching earnings for {len(chunk)} symbols ({i+1}-{i+len(chunk)} of {len(symbols)})")
        chunk_dates = _ask_perplexity_for_earnings(chunk)
        all_dates.update(chunk_dates)

    save_calendar(all_dates)
    known = sum(1 for d in all_dates.values() if d)
    log.info(f"Calendar refreshed: {known}/{len(all_dates)} symbols have known dates")
    return load_calendar()


def days_until_earnings(symbol: str, calendar: dict | None = None,
                        today: date | None = None) -> Optional[int]:
    """Return days until next earnings, or None if unknown / past.

    Pure function — accepts injected `today` for deterministic tests.
    """
    calendar = calendar or load_calendar()
    dates = calendar.get("dates", {})
    raw = dates.get(symbol)
    if not raw:
        return None
    try:
        next_date = datetime.strptime(raw, "%Y-%m-%d").date()
    except ValueError:
        return None
    today = today or date.today()
    delta = (next_date - today).days
    return delta if delta >= 0 else None


def has_earnings_risk(symbol: str, window_days: int = EARNINGS_BLOCK_WINDOW_DAYS,
                     calendar: dict | None = None,
                     today: date | None = None) -> bool:
    """True if symbol has earnings within the next `window_days`.

    Unknown earnings → False (don't block on missing data).
    """
    days = days_until_earnings(symbol, calendar, today)
    return days is not None and 0 <= days <= window_days


# ──────────────────────────────── CLI ──────────────────────────────────────


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"

    if cmd == "refresh":
        force = "--force" in sys.argv
        cal = refresh_calendar(force=force)
        print(f"\nCalendar updated at: {cal.get('updated_at')}")
        known = [(s, d) for s, d in cal.get("dates", {}).items() if d]
        print(f"Known earnings dates: {len(known)}/{len(cal.get('dates', {}))}")
        for s, d in sorted(known, key=lambda x: x[1]):
            days = days_until_earnings(s, cal)
            print(f"  {s:<6}  {d}  ({days}d away)")

    elif cmd == "show":
        cal = load_calendar()
        print(f"Last updated: {cal.get('updated_at') or 'never'}")
        print(f"Stale: {is_stale(cal)}")
        for sym, d in sorted(cal.get("dates", {}).items()):
            risk = "🚨 RISK" if has_earnings_risk(sym, calendar=cal) else ""
            print(f"  {sym:<6}  {d or '(unknown)':<12}  {risk}")

    elif cmd == "risk" and len(sys.argv) > 2:
        sym = sys.argv[2].upper()
        d = days_until_earnings(sym)
        if d is None:
            print(f"{sym}: no known earnings date")
        else:
            risk = "BLOCK" if has_earnings_risk(sym) else "OK"
            print(f"{sym}: {d} days until earnings ({risk})")

    else:
        print("Usage: python3 scripts/earnings_calendar.py [refresh|show|risk SYMBOL]")


if __name__ == "__main__":
    main()
