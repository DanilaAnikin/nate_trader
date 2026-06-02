"""Rebuild state/performance.json -> daily_history from Alpaca Portfolio History.

The early daily_history entries were seeded with a constant placeholder equity
(975,507.36 for ~18 days while cash and positions actually changed), so the
dashboard's equity / "vs S&P 500" charts render a flat line that suddenly
spikes. Alpaca's Portfolio History is the authoritative retroactive daily
equity curve — this rewrites every entry's equity (and pnl) from it, mirroring
the dashboard's own backfill (dashboard/lib/accounts/equity-backfill.ts).

Existing cash / num_positions per day are preserved; only equity-derived fields
are corrected. Idempotent and safe: if Alpaca returns nothing, the file is left
untouched.

Usage:
    python3 scripts/rebuild_daily_history.py            # paper account
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import ALPACA_API_KEY, ALPACA_SECRET_KEY, PERFORMANCE_STATE  # noqa: E402

PORTFOLIO_HISTORY_URL = (
    "https://paper-api.alpaca.markets/v2/account/portfolio/history"
    "?period=all&timeframe=1D"
)

# Alpaca's daily timestamps land in the trading day's evening, which is the
# NEXT calendar day in UTC — labelling Friday's bar as Saturday and dropping
# Mondays. Convert in market time so dates line up with the ET-dated SPY
# history the chart plots against.
_ET = ZoneInfo("America/New_York")


def fetch_portfolio_history() -> dict:
    if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:
        raise SystemExit("ALPACA_API_KEY / ALPACA_SECRET_KEY not set")
    req = urllib.request.Request(
        PORTFOLIO_HISTORY_URL,
        headers={
            "APCA-API-KEY-ID": ALPACA_API_KEY,
            "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Alpaca portfolio history HTTP {e.code}: {e.read()[:200]!r}")


def main() -> int:
    hist = fetch_portfolio_history()
    ts = hist.get("timestamp") or []
    equity = hist.get("equity") or []
    pl = hist.get("profit_loss") or []
    plpc = hist.get("profit_loss_pct") or []

    # Last value per UTC date wins (matches the dashboard backfill).
    by_date: dict[str, dict] = {}
    for i, t in enumerate(ts):
        eq = equity[i] if i < len(equity) else None
        if eq is None or eq <= 0:
            continue
        day = datetime.fromtimestamp(t, tz=_ET).strftime("%Y-%m-%d")
        by_date[day] = {
            "equity": round(float(eq), 2),
            "pnl": round(float(pl[i]), 2) if i < len(pl) and pl[i] is not None else 0.0,
            "pnl_pct": round(float(plpc[i]) * 100, 4)
            if i < len(plpc) and plpc[i] is not None
            else 0.0,
        }

    if not by_date:
        print("Alpaca returned no equity points — leaving daily_history untouched.")
        return 0

    with open(PERFORMANCE_STATE) as f:
        perf = json.load(f)

    existing = {e.get("date"): e for e in perf.get("daily_history", [])}

    rebuilt = []
    corrected = 0
    for day in sorted(by_date):
        src = by_date[day]
        prev = existing.get(day, {})
        old_eq = prev.get("equity")
        entry = {
            "date": day,
            "pnl": src["pnl"],
            "pnl_pct": src["pnl_pct"],
            "equity": src["equity"],
            "cash": prev.get("cash", 0.0),
            "num_positions": prev.get("num_positions", 0),
        }
        if old_eq is None or abs(float(old_eq) - src["equity"]) > 0.005:
            corrected += 1
        rebuilt.append(entry)

    perf["daily_history"] = rebuilt
    with open(PERFORMANCE_STATE, "w") as f:
        json.dump(perf, f, indent=2, default=str)

    print(
        f"Rebuilt daily_history: {len(rebuilt)} days "
        f"({corrected} equity values corrected), "
        f"{rebuilt[0]['date']} → {rebuilt[-1]['date']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
