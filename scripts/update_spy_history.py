"""Update state/spy_history.json — incremental daily fetch of SPY bars.

First run: full backfill from SPY_HISTORY_START (2020-01-01) to today.
Subsequent runs: only fetch bars after the last recorded date.

This file becomes the source of truth for the dashboard's historical
performance chart. The dashboard reads it from GitHub (via the existing
/api/spy-history route), so the page no longer depends on having Alpaca
credentials in the Vercel environment.

Run by .github/workflows/update-spy-history.yml at 16:45 ET on weekdays.
"""

import sys
from datetime import datetime, timedelta

import pandas as pd

from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.enums import DataFeed

from utils import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY, STATE_DIR,
    setup_logging, get_now_str, load_json, save_json,
)

log = setup_logging("spy_history")

SPY_HISTORY_PATH = STATE_DIR / "spy_history.json"
SPY_HISTORY_START = "2020-01-01"

data_client = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)


def fetch_bars(start_date: str, end_date: str) -> list[dict]:
    """Fetch SPY daily bars between dates from Alpaca (split/dividend adjusted)."""
    request = StockBarsRequest(
        symbol_or_symbols="SPY",
        timeframe=TimeFrame.Day,
        start=datetime.strptime(start_date, "%Y-%m-%d"),
        end=datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1),
        feed=DataFeed.IEX,
        adjustment="all",
    )
    bars = data_client.get_stock_bars(request)
    df = bars.df
    if df.empty:
        return []
    if df.index.nlevels > 1:
        df = df.droplevel("symbol")

    result = []
    for idx, row in df.iterrows():
        # idx is a pandas Timestamp; we want just YYYY-MM-DD
        date_str = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)[:10]
        result.append({
            "date": date_str,
            "close": round(float(row["close"]), 2),
        })
    return result


def update_spy_history() -> dict:
    existing = load_json(SPY_HISTORY_PATH)
    existing_bars = existing.get("bars", [])
    today = datetime.now().strftime("%Y-%m-%d")

    if not existing_bars:
        log.info(f"No existing data — full backfill from {SPY_HISTORY_START} to {today}")
        new_bars = fetch_bars(SPY_HISTORY_START, today)
        merged = new_bars
    else:
        last_date = existing_bars[-1]["date"]
        next_date = (
            datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)
        ).strftime("%Y-%m-%d")
        if next_date > today:
            log.info(f"Already up to date: last_date={last_date}")
            return existing
        log.info(f"Incremental update from {next_date} to {today}")
        try:
            new_bars = fetch_bars(next_date, today)
        except Exception as e:
            log.error(f"Fetch failed: {e}")
            return existing
        if not new_bars:
            log.info("No new bars (weekend/holiday/non-trading day)")
            return existing
        merged = existing_bars + new_bars

    # Dedupe by date (later entry wins — handles re-fetched bars)
    by_date: dict[str, dict] = {}
    for bar in merged:
        by_date[bar["date"]] = bar
    deduped = sorted(by_date.values(), key=lambda b: b["date"])

    result = {
        "updated_at": get_now_str(),
        "symbol": "SPY",
        "from": deduped[0]["date"],
        "to": deduped[-1]["date"],
        "count": len(deduped),
        "bars": deduped,
    }
    save_json(SPY_HISTORY_PATH, result)
    log.info(f"Saved {len(deduped)} SPY bars ({deduped[0]['date']} → {deduped[-1]['date']})")
    return result


if __name__ == "__main__":
    result = update_spy_history()
    print(f"SPY history: {result.get('count', 0)} bars from {result.get('from')} to {result.get('to')}")
