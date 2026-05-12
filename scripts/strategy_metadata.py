"""Tag held positions with their originating strategy (momentum / mr / pead / hedge).

Alpaca doesn't store strategy metadata on positions, so we keep a small
local index at state/strategy_metadata.json. Every entry maps symbol →
{strategy, entry_date}. Used by:

  • Mean reversion (`mean_reversion.should_exit_mr`) — only exits MR
    positions on its own rules, leaves momentum positions alone
  • PEAD (`pead_strategy.should_exit_pead`) — same
  • Reporting / journal — per-strategy P&L attribution

The file is intentionally a small flat dict. Live trade open/close
hooks update it; if it ever desyncs from Alpaca positions we default
new entries to "momentum" (existing engine behavior).
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    STATE_DIR, get_today_str, load_json, save_json, setup_logging,
)

log = setup_logging("strategy_metadata")

METADATA_PATH = STATE_DIR / "strategy_metadata.json"

ValidStrategy = ("momentum", "mr", "pead", "hedge")


def load_metadata() -> dict:
    return load_json(METADATA_PATH) or {"strategies": {}}


def save_metadata(data: dict) -> None:
    save_json(METADATA_PATH, data)


def mark_position(symbol: str, strategy: str, entry_date: str | None = None) -> None:
    """Record symbol → strategy at entry time."""
    if strategy not in ValidStrategy:
        log.warning(f"Unknown strategy {strategy!r}; storing anyway")
    meta = load_metadata()
    meta.setdefault("strategies", {})[symbol] = {
        "strategy": strategy,
        "entry_date": entry_date or get_today_str(),
    }
    save_metadata(meta)


def unmark_position(symbol: str) -> None:
    """Drop the metadata entry — call on close/exit."""
    meta = load_metadata()
    meta.get("strategies", {}).pop(symbol, None)
    save_metadata(meta)


def get_strategy(symbol: str) -> str:
    """Return the strategy tag for symbol; defaults to 'momentum'."""
    meta = load_metadata()
    return meta.get("strategies", {}).get(symbol, {}).get("strategy", "momentum")


def get_entry_date(symbol: str) -> str | None:
    """Return the recorded entry date or None."""
    meta = load_metadata()
    return meta.get("strategies", {}).get(symbol, {}).get("entry_date")


def days_held(symbol: str, today: datetime | None = None) -> int | None:
    """Trading days held — uses calendar days as proxy (good enough for swing)."""
    entry_str = get_entry_date(symbol)
    if not entry_str:
        return None
    try:
        entry = datetime.strptime(entry_str, "%Y-%m-%d")
    except ValueError:
        return None
    today = today or datetime.now()
    return max(0, (today - entry).days)


def positions_by_strategy() -> dict[str, list[str]]:
    """Returns {strategy: [symbol, ...]} for all tracked positions."""
    meta = load_metadata()
    out: dict[str, list[str]] = {}
    for sym, info in meta.get("strategies", {}).items():
        out.setdefault(info.get("strategy", "momentum"), []).append(sym)
    return out


def sync_with_positions(current_symbols: set[str]) -> None:
    """Drop metadata entries for symbols we no longer hold.

    Defensive cleanup — if a position got closed externally (manual,
    Alpaca trailing stop) we still want metadata to track reality.
    """
    meta = load_metadata()
    strategies = meta.get("strategies", {})
    stale = [s for s in strategies if s not in current_symbols]
    for s in stale:
        log.info(f"Removing stale metadata for {s} (no longer held)")
        strategies.pop(s)
    if stale:
        save_metadata(meta)
