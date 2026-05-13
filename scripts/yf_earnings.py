"""Free earnings calendar + EPS surprise data via yfinance.

Replaces Perplexity for the earnings gate in backtest (and is a free
fallback in live too). yfinance scrapes Yahoo Finance — no API key,
no rate limits we'll hit at 35 symbols × weekly cadence.

Two outputs:
  • state/earnings_calendar_yf.json  → next earnings date per symbol
  • state/earnings_history_yf.json   → last 8 quarters of EPS surprise
                                       per symbol (for PEAD)

CLI:
  python3 scripts/yf_earnings.py refresh         # both calendar + history
  python3 scripts/yf_earnings.py calendar        # just next dates
  python3 scripts/yf_earnings.py history SYMBOL
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    STATE_DIR, setup_logging, get_now_str, load_json, save_json,
    get_tradeable_symbols,
)

log = setup_logging("yf_earnings")

CALENDAR_PATH = STATE_DIR / "earnings_calendar_yf.json"
HISTORY_PATH = STATE_DIR / "earnings_history_yf.json"


def _ticker(symbol: str):
    try:
        import yfinance as yf
        return yf.Ticker(symbol)
    except ImportError:
        log.warning("yfinance not installed")
        return None


def fetch_next_earnings(symbol: str) -> str | None:
    """Return YYYY-MM-DD for next earnings, or None."""
    t = _ticker(symbol)
    if t is None:
        return None
    try:
        cal = t.calendar
        if cal is None:
            return None
        # Newer yfinance returns dict-like; older returns DataFrame
        if isinstance(cal, dict):
            er = cal.get("Earnings Date")
            if isinstance(er, list) and er:
                return er[0].strftime("%Y-%m-%d") if hasattr(er[0], "strftime") else str(er[0])[:10]
            if er:
                return er.strftime("%Y-%m-%d") if hasattr(er, "strftime") else str(er)[:10]
        else:
            try:
                er = cal.loc["Earnings Date"][0]
                return er.strftime("%Y-%m-%d") if hasattr(er, "strftime") else str(er)[:10]
            except (KeyError, IndexError):
                return None
    except Exception as e:
        log.warning(f"  {symbol}: earnings calendar fetch failed — {e}")
        return None


def fetch_eps_surprises(symbol: str) -> list[dict]:
    """Return list of {date, eps_actual, eps_estimate, surprise_pct}."""
    t = _ticker(symbol)
    if t is None:
        return []
    try:
        # Newer yfinance has `earnings_history` attribute (DataFrame)
        eh = getattr(t, "earnings_history", None)
        if eh is None:
            return []
        out = []
        for idx, row in eh.iterrows():
            try:
                actual = float(row.get("epsActual") or row.get("EPS Actual") or 0)
                est = float(row.get("epsEstimate") or row.get("EPS Estimate") or 0)
                if est == 0:
                    continue
                surprise_pct = (actual - est) / abs(est) * 100
                date_str = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)[:10]
                out.append({
                    "date": date_str,
                    "eps_actual": actual,
                    "eps_estimate": est,
                    "surprise_pct": round(surprise_pct, 2),
                })
            except (TypeError, ValueError):
                continue
        return out[-8:]  # last 8 quarters
    except Exception as e:
        log.warning(f"  {symbol}: EPS history fetch failed — {e}")
        return []


def refresh_calendar(symbols: list[str] | None = None) -> dict:
    symbols = symbols or sorted(get_tradeable_symbols())
    log.info(f"Refreshing yfinance earnings calendar for {len(symbols)} symbols")
    dates = {}
    for sym in symbols:
        d = fetch_next_earnings(sym)
        dates[sym] = d
        if d:
            log.info(f"  {sym}: next earnings {d}")
    out = {"updated_at": get_now_str(), "dates": dates}
    save_json(CALENDAR_PATH, out)
    return out


def refresh_history(symbols: list[str] | None = None) -> dict:
    symbols = symbols or sorted(get_tradeable_symbols())
    log.info(f"Refreshing EPS surprise history for {len(symbols)} symbols")
    history = {}
    for sym in symbols:
        surprises = fetch_eps_surprises(sym)
        if surprises:
            history[sym] = surprises
            log.info(f"  {sym}: {len(surprises)} quarters")
    out = {"updated_at": get_now_str(), "history": history}
    save_json(HISTORY_PATH, out)
    return out


def get_next_earnings_date(symbol: str) -> str | None:
    data = load_json(CALENDAR_PATH) or {}
    return data.get("dates", {}).get(symbol)


def get_recent_surprise(symbol: str, days_back: int = 30) -> dict | None:
    """Return the most recent EPS surprise within `days_back` days, or None."""
    data = load_json(HISTORY_PATH) or {}
    items = data.get("history", {}).get(symbol, [])
    if not items:
        return None
    today = datetime.now().date()
    for s in reversed(items):
        try:
            d = datetime.strptime(s["date"], "%Y-%m-%d").date()
        except (ValueError, KeyError):
            continue
        delta = (today - d).days
        if 0 <= delta <= days_back:
            return {**s, "days_since": delta}
    return None


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "calendar"

    if cmd == "refresh":
        refresh_calendar()
        refresh_history()

    elif cmd == "calendar":
        result = refresh_calendar()
        known = [(s, d) for s, d in result["dates"].items() if d]
        print(f"\nKnown earnings dates: {len(known)}/{len(result['dates'])}")
        for s, d in sorted(known, key=lambda x: x[1]):
            print(f"  {s:<6}  {d}")

    elif cmd == "history" and len(sys.argv) > 2:
        sym = sys.argv[2].upper()
        items = fetch_eps_surprises(sym)
        print(f"\n{sym} EPS history ({len(items)} quarters):")
        for s in items:
            print(f"  {s['date']}  actual ${s['eps_actual']:.2f}  est ${s['eps_estimate']:.2f}  surprise {s['surprise_pct']:+.2f}%")

    else:
        print("Usage: python3 scripts/yf_earnings.py [refresh|calendar|history SYMBOL]")
