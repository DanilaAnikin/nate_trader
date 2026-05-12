"""Pre-market gap scanner runner — scans watchlist + screener candidates
for overnight gaps and stores boosted scores in state/gap_signals.json.

Triggered by a new GitHub Actions job at 9:35 ET (5 min after open).
The result is consumed by execute_buys() — symbols with a gap signal
get a small score bonus when checked against the gate.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    ALPACA_API_KEY, ALPACA_SECRET_KEY, STATE_DIR,
    setup_logging, get_now_str, load_json, save_json,
    get_tradeable_symbols,
)
from gap_scanner import classify_gap, GAP_THRESHOLD_PCT  # noqa: E402

log = setup_logging("gap_scanner_run")

GAP_SIGNALS_PATH = STATE_DIR / "gap_signals.json"


def _fetch_prior_close_and_open(symbols: list[str]) -> dict[str, dict]:
    """Get yesterday's close and today's open for each symbol from Alpaca."""
    from alpaca.data.historical import StockHistoricalDataClient
    from alpaca.data.requests import StockBarsRequest, StockLatestQuoteRequest
    from alpaca.data.timeframe import TimeFrame
    from alpaca.data.enums import DataFeed

    client = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)

    end = datetime.now()
    start = end - timedelta(days=5)
    request = StockBarsRequest(
        symbol_or_symbols=symbols,
        timeframe=TimeFrame.Day,
        start=start, end=end,
        feed=DataFeed.IEX,
    )
    try:
        bars = client.get_stock_bars(request).df
    except Exception as e:
        log.error(f"Gap scanner bars fetch failed: {e}")
        return {}

    # For each symbol, take the last 2 closes — prior_close & today_open
    out: dict[str, dict] = {}
    for sym in symbols:
        try:
            sym_df = bars.xs(sym, level="symbol") if "symbol" in bars.index.names else bars
            if len(sym_df) < 2:
                continue
            prior_close = float(sym_df["close"].iloc[-2])
            today_open = float(sym_df["open"].iloc[-1])
            volume = float(sym_df["volume"].iloc[-1])
            avg_vol = float(sym_df["volume"].iloc[:-1].mean())
            out[sym] = {
                "prior_close": prior_close,
                "today_open": today_open,
                "volume": volume,
                "avg_volume": avg_vol,
            }
        except (KeyError, IndexError):
            continue
    return out


def _has_recent_news(symbol: str) -> bool:
    """Best-effort: True if Alpaca news in the last 24h."""
    try:
        from research import get_news
        news = get_news(symbol, limit=3)
        return len(news) > 0
    except Exception:
        return False


def scan() -> dict:
    symbols = sorted(get_tradeable_symbols())
    log.info(f"Gap scan over {len(symbols)} symbols")

    data = _fetch_prior_close_and_open(symbols)
    signals: list[dict] = []

    for sym, d in data.items():
        if d["avg_volume"] <= 0:
            continue
        # Quick oversold check from research state
        research = load_json(STATE_DIR / "research.json")
        tech = research.get("symbols", {}).get(sym, {}).get("technicals", {})
        rsi = tech.get("rsi_14")
        oversold = (rsi is not None and rsi < 35)
        has_news = _has_recent_news(sym)

        signal = classify_gap(
            prior_close=d["prior_close"],
            today_open=d["today_open"],
            first_5min_volume=d["volume"],
            avg_premarket_volume=d["avg_volume"],
            has_news_catalyst=has_news,
            oversold_signal=oversold,
        )
        if signal:
            signals.append({
                "symbol": sym,
                "kind": signal.kind,
                "gap_pct": signal.gap_pct,
                "bonus_points": signal.bonus_points,
                "rationale": signal.rationale,
            })

    result = {
        "updated_at": get_now_str(),
        "threshold_pct": GAP_THRESHOLD_PCT,
        "n_scanned": len(data),
        "signals": signals,
    }
    save_json(GAP_SIGNALS_PATH, result)
    log.info(f"Saved {len(signals)} gap signals to {GAP_SIGNALS_PATH}")
    for s in signals:
        log.info(f"  {s['kind']:<10} {s['symbol']:<6} {s['gap_pct']:+.2f}%  {s['rationale']}")
    return result


def get_gap_bonus(symbol: str) -> int:
    """Used by execute_buys: read gap_signals.json, return bonus for symbol."""
    data = load_json(GAP_SIGNALS_PATH) or {}
    for s in data.get("signals", []):
        if s.get("symbol") == symbol:
            return int(s.get("bonus_points", 0))
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "scan"
    if cmd == "scan":
        scan()
    elif cmd == "show":
        data = load_json(GAP_SIGNALS_PATH)
        if not data:
            print("No gap signals yet")
        else:
            print(f"Last scan: {data.get('updated_at')}")
            for s in data.get("signals", []):
                print(f"  {s['kind']:<10} {s['symbol']:<6} {s['gap_pct']:+.2f}%  bonus +{s['bonus_points']}")
    else:
        print("Usage: python3 scripts/run_gap_scanner.py [scan|show]")
