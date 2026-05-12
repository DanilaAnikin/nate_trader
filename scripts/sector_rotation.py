"""Sector rotation — boost / penalise symbols by their sector's relative strength.

Engines that score stocks in isolation pick momentum names inside
sectors that are quietly rotating down — and lose to symbols inside
the *winning* sector. Sector rotation reads SPDR sector ETF strength
vs SPY over 20 days and applies a ±5-point adjustment to symbol scores
based on whether their sector is in the top/bottom 3.

Sector ETFs (SPDR Select):
    XLK  Technology         XLF  Financial
    XLV  Healthcare         XLI  Industrial
    XLY  Consumer Disc.     XLE  Energy
    XLB  Materials          XLU  Utilities
    XLRE Real Estate        XLC  Communication

State: state/sector_strength.json (refreshed daily by pre-market routine)
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

# pandas is only needed inside _fetch_20d_returns(); imported lazily there so
# pure math (compute_sector_alpha / rank_sectors / compute_sector_adjustment)
# can run without pandas — important for tests in lightweight environments.

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    ALPACA_API_KEY, ALPACA_SECRET_KEY, STATE_DIR,
    setup_logging, get_now_str, load_json, save_json,
)

log = setup_logging("sector_rotation")

SECTOR_STRENGTH_PATH = STATE_DIR / "sector_strength.json"

# Map watchlist taxonomy → SPDR sector ETF. Communication is grouped
# with Technology for our internal classification but tracked via XLC
# externally — we treat it as a sub-category but score it separately.
SECTOR_ETF: dict[str, str] = {
    "Technology": "XLK",
    "Financial": "XLF",
    "Healthcare": "XLV",
    "Industrial": "XLI",
    "Consumer": "XLY",
    "Energy": "XLE",
    "Materials": "XLB",
    "Utilities": "XLU",
    "RealEstate": "XLRE",
    "Communication": "XLC",
}

# Tunables — see compute_sector_adjustment()
LOOKBACK_DAYS = 20
TOP_N_BONUS = 3
BOTTOM_N_PENALTY = 3
BONUS_POINTS = 5
PENALTY_POINTS = -5


# ────────────────────────────── data fetch ─────────────────────────────────


def _fetch_20d_returns(symbols: list[str]) -> dict[str, float | None]:
    """Pull 20-day returns for each ETF + SPY from Alpaca.

    Returns dict mapping ticker → percent return (None on failure).
    Skipped here at import time — only invoked from refresh().
    """
    from alpaca.data.historical import StockHistoricalDataClient
    from alpaca.data.requests import StockBarsRequest
    from alpaca.data.timeframe import TimeFrame
    from alpaca.data.enums import DataFeed

    client = StockHistoricalDataClient(ALPACA_API_KEY, ALPACA_SECRET_KEY)
    end = datetime.now()
    start = end - timedelta(days=LOOKBACK_DAYS + 30)  # buffer for weekends/holidays
    request = StockBarsRequest(
        symbol_or_symbols=symbols,
        timeframe=TimeFrame.Day,
        start=start,
        end=end,
        feed=DataFeed.IEX,
        adjustment="all",
    )
    try:
        bars = client.get_stock_bars(request)
        df = bars.df
    except Exception as e:
        log.error(f"Failed to fetch sector bars: {e}")
        return {s: None for s in symbols}

    out: dict[str, float | None] = {}
    for sym in symbols:
        try:
            sym_df = df.xs(sym, level="symbol") if "symbol" in df.index.names else df
            closes = sym_df["close"].astype(float).tail(LOOKBACK_DAYS + 1)
            if len(closes) < LOOKBACK_DAYS + 1:
                out[sym] = None
                continue
            ret = (float(closes.iloc[-1]) / float(closes.iloc[0]) - 1) * 100
            out[sym] = ret
        except (KeyError, IndexError) as e:
            log.warning(f"  {sym}: no bars — {e}")
            out[sym] = None
    return out


# ─────────────────────────── pure scoring API ──────────────────────────────


def compute_sector_alpha(returns: dict[str, float | None],
                         spy_return: float | None) -> dict[str, float | None]:
    """Per-sector alpha = sector_return − SPY return.

    Pure function — accepts injected returns dict for testability.
    """
    if spy_return is None:
        return {sec: None for sec in SECTOR_ETF}
    out: dict[str, float | None] = {}
    for sec, etf in SECTOR_ETF.items():
        r = returns.get(etf)
        out[sec] = (r - spy_return) if r is not None else None
    return out


def rank_sectors(alpha_by_sector: dict[str, float | None]) -> tuple[list[str], list[str]]:
    """Return (top_n, bottom_n) sector names by alpha. Drops nulls.

    Pure function — no I/O.
    """
    valid = [(sec, a) for sec, a in alpha_by_sector.items() if a is not None]
    valid.sort(key=lambda kv: kv[1], reverse=True)
    top = [s for s, _ in valid[:TOP_N_BONUS]]
    bottom = [s for s, _ in valid[-BOTTOM_N_PENALTY:]]
    return top, bottom


def compute_sector_adjustment(symbol_sector: str,
                              state: dict | None = None) -> int:
    """Return points to ADD to a symbol's score given its sector classification.

    Logic:
      • Sector in top-3 by 20d alpha → +5 bonus
      • Sector in bottom-3 by 20d alpha → −5 penalty
      • Otherwise (middle, or unknown sector, or no state) → 0
    """
    if state is None:
        state = load_json(SECTOR_STRENGTH_PATH) or {}
    if not symbol_sector or symbol_sector in ("Benchmark", "Hedge", "Unknown"):
        return 0
    top = state.get("top_sectors") or []
    bottom = state.get("bottom_sectors") or []
    if symbol_sector in top:
        return BONUS_POINTS
    if symbol_sector in bottom:
        return PENALTY_POINTS
    return 0


# ────────────────────────────── refresh ────────────────────────────────────


def refresh_sector_strength() -> dict:
    """Fetch ETF + SPY bars, compute alpha, persist."""
    symbols = ["SPY"] + list(SECTOR_ETF.values())
    log.info(f"Refreshing sector strength: {len(symbols)} tickers, {LOOKBACK_DAYS}d lookback")

    returns = _fetch_20d_returns(symbols)
    spy_return = returns.get("SPY")
    if spy_return is None:
        log.error("SPY return unavailable — sector adjustments disabled this cycle")

    alpha = compute_sector_alpha(returns, spy_return)
    top, bottom = rank_sectors(alpha)

    state = {
        "updated_at": get_now_str(),
        "lookback_days": LOOKBACK_DAYS,
        "spy_return": spy_return,
        "sector_returns": {sec: returns.get(etf) for sec, etf in SECTOR_ETF.items()},
        "sector_alpha": alpha,
        "top_sectors": top,
        "bottom_sectors": bottom,
    }
    save_json(SECTOR_STRENGTH_PATH, state)
    log.info(f"  Top 3:    {top}")
    log.info(f"  Bottom 3: {bottom}")
    return state


# ──────────────────────────────── CLI ──────────────────────────────────────


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "show"

    if cmd == "refresh":
        state = refresh_sector_strength()
        print(f"\nSector strength updated at {state['updated_at']}")
        print(f"SPY 20d return: {state['spy_return']:+.2f}%" if state['spy_return'] is not None else "SPY: n/a")
        print(f"\nSector alphas (sector return − SPY):")
        items = sorted(
            [(sec, a) for sec, a in state["sector_alpha"].items() if a is not None],
            key=lambda kv: kv[1], reverse=True,
        )
        for sec, a in items:
            tag = "✓ TOP" if sec in state["top_sectors"] else ("✗ BOT" if sec in state["bottom_sectors"] else "    ")
            print(f"  {tag}  {sec:<14}  {a:+.2f}pp")

    elif cmd == "show":
        state = load_json(SECTOR_STRENGTH_PATH)
        if not state:
            print("No sector strength data yet — run `refresh` first")
            return
        print(f"Last updated: {state.get('updated_at')}")
        print(f"SPY 20d return: {state.get('spy_return'):+.2f}%" if state.get('spy_return') is not None else "SPY: n/a")
        print(f"Top sectors:    {state.get('top_sectors')}")
        print(f"Bottom sectors: {state.get('bottom_sectors')}")

    elif cmd == "adj" and len(sys.argv) > 2:
        from utils import get_symbol_info
        sym = sys.argv[2].upper()
        info = get_symbol_info(sym)
        sector = info.get("sector", "Unknown")
        adj = compute_sector_adjustment(sector)
        print(f"{sym}: sector={sector}  adjustment={adj:+d}")

    else:
        print("Usage: python3 scripts/sector_rotation.py [refresh|show|adj SYMBOL]")


if __name__ == "__main__":
    main()
