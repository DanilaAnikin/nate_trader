"""Download daily OHLCV bars for the backtest universe and cache locally.

Universe = tradeable watchlist symbols + SPY (benchmark + regime) + SH (hedge).
Output: state/backtest/bars/{symbol}.json — one file per symbol, sorted by date.

Bars are split- and dividend-adjusted so daily closes compare correctly across
corporate actions. Alpaca's IEX feed is used (free tier, sufficient for daily).

CLI:
    python3 scripts/backtest/download_history.py                # full adjusted rebuild
    python3 scripts/backtest/download_history.py SPY AAPL       # subset
    python3 scripts/backtest/download_history.py --start 2018-01-01
    python3 scripts/backtest/download_history.py --incremental  # faster, not split-safe
"""

import sys
import json
import math
from datetime import datetime, timedelta
from pathlib import Path


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
    setup_logging, get_now_str, save_json,
)
from universe import load_universe_symbols  # noqa: E402

log = setup_logging("backtest_download")

BARS_DIR = PROJECT_ROOT / "state" / "backtest" / "bars"
DEFAULT_START = "2020-01-01"
MAX_REBUILD_END_GAP_DAYS = 7


def universe() -> list[str]:
    """Watchlist tradeable symbols + benchmarks/hedge + sector ETFs.

    Sector ETFs are required for the historical sector-rotation recompute
    inside the backtest engine. Without them the engine falls back to
    today's snapshot, which is a strong look-ahead bias.
    """
    base = set(load_universe_symbols())
    base.update({"SPY", "SH"})  # benchmark + hedge
    # Retain archived infrastructure symbols so old strategies can still be
    # audited and every carried position is marked to market correctly.
    base.update({"TQQQ", "UPRO", "SSO", "BIL"})
    base.update({"XLK", "XLF", "XLV", "XLI", "XLY", "XLE",
                 "XLB", "XLU", "XLRE", "XLC", "XLP"})  # SPDR sector ETFs
    return sorted(base)


def fetch_bars(symbol: str, start: str, end: str) -> list[dict]:
    """Daily OHLCV bars (split/div adjusted) between dates from Alpaca."""
    if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
        return fetch_bars_yfinance(symbol, start, end)
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


def fetch_bars_yfinance(symbol: str, start: str, end: str) -> list[dict]:
    """Credential-free adjusted fallback using the declared yfinance dependency."""

    import pandas as pd
    import yfinance as yf

    exclusive_end = (
        datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)
    ).strftime("%Y-%m-%d")
    frame = yf.download(
        symbol,
        start=start,
        end=exclusive_end,
        auto_adjust=True,
        actions=False,
        progress=False,
        threads=False,
    )
    if frame is None or frame.empty:
        return []
    if isinstance(frame.columns, pd.MultiIndex):
        if symbol in frame.columns.get_level_values(-1):
            frame = frame.xs(symbol, axis=1, level=-1)
        else:
            frame.columns = frame.columns.get_level_values(0)

    out: list[dict] = []
    for idx, row in frame.iterrows():
        values = {
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": float(row["Volume"]),
        }
        if not all(math.isfinite(value) for value in values.values()):
            continue
        out.append(
            {
                "date": idx.strftime("%Y-%m-%d"),
                "open": round(values["open"], 4),
                "high": round(values["high"], 4),
                "low": round(values["low"], 4),
                "close": round(values["close"], 4),
                "volume": int(values["volume"]),
            }
        )
    log.info(f"  {symbol}: yfinance adjusted fallback returned {len(out)} bars")
    return out


def download_symbol(symbol: str, start: str, end: str, *, rebuild: bool = False) -> int:
    """Download, extend, or replace one symbol's requested date interval.

    An existing cache may start later than ``start`` as well as end before
    ``end``.  The old incremental path only fetched after the final cached
    date, so asking for an earlier start silently did nothing.  Fetch the
    missing prefix and suffix separately in incremental mode. A rebuild
    verifies fresh boundary coverage and replaces (rather than upserts) all
    cached rows in the requested interval, writing only after validation.
    """
    BARS_DIR.mkdir(parents=True, exist_ok=True)
    path = BARS_DIR / f"{symbol}.json"

    existing: list[dict] = []
    if path.exists():
        try:
            data = json.loads(path.read_text())
            existing = data.get("bars", [])
            existing = [bar for bar in existing if isinstance(bar, dict) and bar.get("date")]
        except (json.JSONDecodeError, KeyError, TypeError):
            existing = []

    requested_start = datetime.strptime(start, "%Y-%m-%d")
    requested_end = datetime.strptime(end, "%Y-%m-%d")
    if requested_start > requested_end:
        raise ValueError(f"start {start} is after end {end}")

    fetch_ranges: list[tuple[str, str]] = []
    if rebuild or not existing:
        fetch_ranges.append((start, end))
    else:
        cached_dates = sorted(bar["date"] for bar in existing)
        first_cached = datetime.strptime(cached_dates[0], "%Y-%m-%d")
        last_cached = datetime.strptime(cached_dates[-1], "%Y-%m-%d")

        prefix_end = first_cached - timedelta(days=1)
        if requested_start <= prefix_end:
            fetch_ranges.append((start, min(requested_end, prefix_end).strftime("%Y-%m-%d")))

        suffix_start = last_cached + timedelta(days=1)
        if suffix_start <= requested_end:
            fetch_ranges.append((suffix_start.strftime("%Y-%m-%d"), end))

    if not fetch_ranges:
        first_date = min(bar["date"] for bar in existing)
        last_date = max(bar["date"] for bar in existing)
        log.info(
            f"  {symbol}: requested range cached "
            f"({len(existing)} bars, {first_date} → {last_date})"
        )
        return len(existing)

    new_bars: list[dict] = []
    fetch_errors: list[str] = []
    for fetch_start, fetch_end in fetch_ranges:
        try:
            new_bars.extend(fetch_bars(symbol, fetch_start, fetch_end))
        except Exception as e:
            fetch_errors.append(f"{fetch_start} → {fetch_end}: {e}")
            log.warning(
                f"  {symbol}: fetch {fetch_start} → {fetch_end} failed — {e}"
            )
    if fetch_errors:
        raise RuntimeError(
            f"{symbol}: incomplete refresh ({'; '.join(fetch_errors)})"
        )
    if rebuild:
        # A rebuild is a replacement of the requested interval, not an
        # upsert.  Validate the fresh response before touching the old cache;
        # otherwise an empty/truncated provider response could silently leave
        # stale adjusted bars in place and make the command appear successful.
        fetched_in_range: list[dict] = []
        fetched_dates: list[str] = []
        for bar in new_bars:
            if not isinstance(bar, dict) or not bar.get("date"):
                raise RuntimeError(f"{symbol}: rebuild returned a malformed bar")
            try:
                bar_date = datetime.strptime(str(bar["date"]), "%Y-%m-%d")
            except ValueError as exc:
                raise RuntimeError(
                    f"{symbol}: rebuild returned invalid date {bar.get('date')!r}"
                ) from exc
            if requested_start <= bar_date <= requested_end:
                fetched_in_range.append(bar)
                fetched_dates.append(str(bar["date"]))

        if not fetched_in_range:
            raise RuntimeError(f"{symbol}: full rebuild returned no in-range bars")
        if len(fetched_dates) != len(set(fetched_dates)):
            raise RuntimeError(f"{symbol}: rebuild returned duplicate session dates")

        fetched_first = min(fetched_dates)
        fetched_last = max(fetched_dates)
        old_in_range_dates = sorted(
            str(bar["date"])
            for bar in existing
            if start <= str(bar["date"]) <= end
        )
        if old_in_range_dates and (
            fetched_first > old_in_range_dates[0]
            or fetched_last < old_in_range_dates[-1]
        ):
            raise RuntimeError(
                f"{symbol}: incomplete rebuild coverage "
                f"({fetched_first} → {fetched_last}); prior cache covered "
                f"{old_in_range_dates[0]} → {old_in_range_dates[-1]}"
            )

        # The requested start can predate an IPO, so lack of an early prefix
        # is not itself an error.  The recent boundary must be present: this
        # downloader is fed an active/tradable universe and stale endpoint data
        # must not be accepted as a successful refresh.
        fetched_last_date = datetime.strptime(fetched_last, "%Y-%m-%d")
        end_gap_days = (requested_end - fetched_last_date).days
        if end_gap_days > MAX_REBUILD_END_GAP_DAYS:
            raise RuntimeError(
                f"{symbol}: incomplete rebuild endpoint; latest fetched "
                f"{fetched_last} is {end_gap_days} days before requested {end}"
            )
        new_bars = fetched_in_range

    # Incremental mode upserts fetched edges.  Rebuild mode first removes every
    # old row inside the requested interval, retaining only explicitly
    # out-of-range history before installing the verified fresh replacement.
    retained = (
        [bar for bar in existing if not (start <= str(bar["date"]) <= end)]
        if rebuild
        else existing
    )
    by_date = {b["date"]: b for b in retained}
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
    log.info(
        f"  {symbol}: {len(merged)} bars "
        f"({merged[0]['date']} → {merged[-1]['date']}, +{len(new_bars)} fetched)"
    )
    return len(merged)


def main(argv: list[str]) -> None:
    args = list(argv)
    start = DEFAULT_START
    # Full rebuild is the correctness default. Adjusted providers can revise
    # the entire prefix after a split/dividend; append-only refresh would then
    # splice two adjustment bases and create a false momentum jump.
    rebuild = "--incremental" not in args
    if "--incremental" in args:
        args.remove("--incremental")
    if "--rebuild" in args:
        args.remove("--rebuild")
    if "--start" in args:
        i = args.index("--start")
        start = args[i + 1]
        args = args[:i] + args[i + 2:]

    end = datetime.now().strftime("%Y-%m-%d")
    symbols = args if args else universe()

    mode = "full adjusted rebuild" if rebuild else "incremental refresh"
    log.info(f"Downloading {len(symbols)} symbols ({start} → {end}; {mode})")
    log.info(f"Output dir: {BARS_DIR}")
    total = 0
    failures: list[str] = []
    for symbol in symbols:
        try:
            total += download_symbol(symbol, start, end, rebuild=rebuild)
        except RuntimeError as exc:
            failures.append(symbol)
            log.error(str(exc))
    log.info(f"Done. Total bars cached: {total:,}")

    # A refresh fails ONLY when a symbol the strategy/validator universally needs
    # is missing (SPY market gate, BIL risk-free metric infra, the SPDR sector
    # auxiliaries used by the sector recompute — the "SPY/BIL/sector auxiliary"
    # the validation contract requires). A watchlist name that has delisted or
    # lost coverage is NOT a refresh failure: the fixed-parameter validator
    # independently rejects any candidate with missing/stale bars, so it — not
    # this fetcher — is the coverage authority. Exiting 1 on any single delisted
    # name previously masked-then-annotated successful runs and, worse, let a
    # future critical-symbol failure look the same as a benign one.
    critical = {"SPY", "BIL", "XLK", "XLF", "XLV", "XLI", "XLY", "XLE",
                "XLB", "XLU", "XLRE", "XLC", "XLP"}
    critical_failures = sorted(s for s in failures if s in critical)
    noncritical_failures = sorted(s for s in failures if s not in critical)
    if noncritical_failures:
        log.warning(
            f"{len(noncritical_failures)} non-critical symbol(s) had no fresh bars "
            f"(delisted / no coverage): {', '.join(noncritical_failures)}. "
            "The validator drops candidates missing bars; this does not fail the refresh."
        )
    if total == 0:
        log.error("No bars were cached at all — the refresh did not run.")
        raise SystemExit(1)
    if critical_failures:
        log.error(
            f"Refresh failed for {len(critical_failures)} CRITICAL symbol(s) "
            f"(SPY/BIL/sector auxiliary): {', '.join(critical_failures)}"
        )
        raise SystemExit(1)


if __name__ == "__main__":
    main(sys.argv[1:])
