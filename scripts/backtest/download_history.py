"""Download daily OHLCV bars for the backtest universe and cache locally.

Universe = tradeable watchlist symbols + SPY (benchmark + regime) + SH (hedge).
Output: state/backtest/bars/{symbol}.json — one file per symbol, sorted by date.

Bars are split- and dividend-adjusted so daily closes compare correctly across
corporate actions. Alpaca's IEX feed is used (free tier, sufficient for daily).

CLI:
    python3 scripts/backtest/download_history.py                # all symbols
    python3 scripts/backtest/download_history.py SPY AAPL       # subset
    python3 scripts/backtest/download_history.py --start 2018-01-01
"""

import sys
import json
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame
from alpaca.data.enums import DataFeed

# Make scripts/ imports work whether invoked as a module or a script.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    ALPACA_API_KEY, ALPACA_SECRET_KEY, PROJECT_ROOT,
    setup_logging, get_now_str, save_json, get_tradeable_symbols,
)

log = setup_logging("backtest_download")

BARS_DIR = PROJECT_ROOT / "state" / "backtest" / "bars"
DEFAULT_START = "2020-01-01"


def universe() -> list[str]:
    """Watchlist tradeable symbols + benchmarks/hedge + sector ETFs.

    Sector ETFs are required for the historical sector-rotation recompute
    inside the backtest engine. Without them the engine falls back to
    today's snapshot, which is a strong look-ahead bias.
    """
    base = set(get_tradeable_symbols())
    base.update({"SPY", "SH"})  # benchmark + hedge
    base.update({"TQQQ"})  # v5: leveraged BULL beta (3x QQQ) — disabled in v6+
    base.update({"SSO"})   # v7: 2x SPY leveraged base in BULL regime
    base.update({"XLK", "XLF", "XLV", "XLI", "XLY", "XLE",
                 "XLB", "XLU", "XLRE", "XLC", "XLP"})  # SPDR sector ETFs
    return sorted(base)


def fetch_bars(symbol: str, start: str, end: str) -> list[dict]:
    """Daily OHLCV bars (split/div adjusted) between dates from Alpaca."""
    client = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)
    request = StockBarsRequest(
        symbol_or_symbols=symbol,
        timeframe=TimeFrame.Day,
        start=datetime.strptime(start, "%Y-%m-%d"),
        end=datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1),
        feed=DataFeed.IEX,
        adjustment="all",
    )
    bars = client.get_stock_bars(request)
    df = bars.df
    if df is None or df.empty:
        return []
    if df.index.nlevels > 1:
        df = df.droplevel("symbol")

    out = []
    for idx, row in df.iterrows():
        date_str = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)[:10]
        out.append({
            "date": date_str,
            "open": round(float(row["open"]), 4),
            "high": round(float(row["high"]), 4),
            "low": round(float(row["low"]), 4),
            "close": round(float(row["close"]), 4),
            "volume": int(row["volume"]),
        })
    return out


def download_symbol(symbol: str, start: str, end: str) -> int:
    """Download (or refresh) one symbol; returns bar count."""
    BARS_DIR.mkdir(parents=True, exist_ok=True)
    path = BARS_DIR / f"{symbol}.json"

    # Incremental refresh: if file exists, fetch only after the last date
    existing: list[dict] = []
    fetch_start = start
    if path.exists():
        try:
            data = json.loads(path.read_text())
            existing = data.get("bars", [])
            if existing:
                last_date = existing[-1]["date"]
                fetch_start = (datetime.strptime(last_date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
                if fetch_start > end:
                    log.info(f"  {symbol}: up to date ({len(existing)} bars, last={last_date})")
                    return len(existing)
        except (json.JSONDecodeError, KeyError):
            existing = []

    try:
        new_bars = fetch_bars(symbol, fetch_start, end)
    except Exception as e:
        log.warning(f"  {symbol}: fetch failed — {e}")
        return len(existing)

    # Merge + dedupe by date (later wins)
    by_date = {b["date"]: b for b in existing}
    for b in new_bars:
        by_date[b["date"]] = b
    merged = sorted(by_date.values(), key=lambda b: b["date"])

    if not merged:
        log.warning(f"  {symbol}: no bars at all (delisted? no Alpaca coverage?)")
        return 0

    save_json(path, {
        "symbol": symbol,
        "updated_at": get_now_str(),
        "from": merged[0]["date"],
        "to": merged[-1]["date"],
        "count": len(merged),
        "bars": merged,
    })
    log.info(f"  {symbol}: {len(merged)} bars ({merged[0]['date']} → {merged[-1]['date']}, +{len(new_bars)} new)")
    return len(merged)


def main(argv: list[str]) -> None:
    args = list(argv)
    start = DEFAULT_START
    if "--start" in args:
        i = args.index("--start")
        start = args[i + 1]
        args = args[:i] + args[i + 2:]

    end = datetime.now().strftime("%Y-%m-%d")
    symbols = args if args else universe()

    log.info(f"Downloading {len(symbols)} symbols ({start} → {end})")
    log.info(f"Output dir: {BARS_DIR}")
    total = 0
    for symbol in symbols:
        total += download_symbol(symbol, start, end)
    log.info(f"Done. Total bars cached: {total:,}")


if __name__ == "__main__":
    main(sys.argv[1:])
