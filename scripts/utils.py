"""Shared utilities for Nate Trader."""

import json
import logging
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

from dotenv import load_dotenv

# Project root (one level up from scripts/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

# API keys
ALPACA_API_KEY = os.getenv("ALPACA_API_KEY", "")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY", "")
PERPLEXITY_API_KEY = os.getenv("PERPLEXITY_API_KEY", "")
CLICKUP_API_KEY = os.getenv("CLICKUP_API_KEY", "")
CLICKUP_LIST_ID = os.getenv("CLICKUP_LIST_ID", "901217466513")

# Paths
STATE_DIR = PROJECT_ROOT / "state"
JOURNAL_DIR = PROJECT_ROOT / "journal"
MEMORY_DIR = PROJECT_ROOT / "memory"
STRATEGY_DIR = PROJECT_ROOT / "strategy"
WATCHLIST_PATH = PROJECT_ROOT / "watchlist.json"
RESEARCH_STATE = STATE_DIR / "research.json"
POSITIONS_STATE = STATE_DIR / "positions.json"
PERFORMANCE_STATE = STATE_DIR / "performance.json"
SCREENER_STATE = STATE_DIR / "screener.json"

# Timezone: approximate EDT (UTC-4)
EDT = timezone(timedelta(hours=-4))


def setup_logging(name: str = "nate_trader") -> logging.Logger:
    """Configure and return a logger."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    return logger


def get_today_str() -> str:
    """Return today's date as YYYY-MM-DD in EDT."""
    return datetime.now(EDT).strftime("%Y-%m-%d")


def get_now_str() -> str:
    """Return current datetime as YYYY-MM-DD HH:MM:SS in EDT."""
    return datetime.now(EDT).strftime("%Y-%m-%d %H:%M:%S")


def load_json(path: Path) -> dict:
    """Load a JSON file, returning empty dict if missing or invalid."""
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_json(path: Path, data: dict) -> None:
    """Save data to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)


def load_watchlist() -> dict:
    """Load watchlist.json and return the full structure."""
    return load_json(WATCHLIST_PATH)


def get_tradeable_symbols() -> list[str]:
    """Return list of tradeable symbols from watchlist."""
    wl = load_watchlist()
    symbols = wl.get("symbols", {})
    return [s for s, info in symbols.items() if info.get("tradeable", False)]


def get_all_symbols() -> list[str]:
    """Return all symbols from watchlist (including non-tradeable like SPY)."""
    wl = load_watchlist()
    return list(wl.get("symbols", {}).keys())


def get_symbol_info(symbol: str) -> dict:
    """Get info for a specific symbol from watchlist."""
    wl = load_watchlist()
    return wl.get("symbols", {}).get(symbol, {})


def append_to_journal(content: str, date_str: str = None) -> None:
    """Append content to today's journal file."""
    date_str = date_str or get_today_str()
    journal_path = JOURNAL_DIR / f"{date_str}.md"
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    with open(journal_path, "a") as f:
        f.write(content + "\n")


def read_journal(date_str: str = None) -> str:
    """Read today's journal file."""
    date_str = date_str or get_today_str()
    journal_path = JOURNAL_DIR / f"{date_str}.md"
    try:
        with open(journal_path, "r") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def get_risk_tier() -> str:
    """Get current risk tier from performance state."""
    perf = load_json(PERFORMANCE_STATE)
    return perf.get("risk_tier", "NORMAL")


def set_risk_tier(tier: str) -> None:
    """Update risk tier in performance state."""
    if tier not in ("NORMAL", "CAUTIOUS", "HALT"):
        raise ValueError(f"Invalid risk tier: {tier}")
    perf = load_json(PERFORMANCE_STATE)
    perf["risk_tier"] = tier
    perf["risk_tier_updated"] = get_now_str()
    save_json(PERFORMANCE_STATE, perf)


if __name__ == "__main__":
    log = setup_logging()
    log.info(f"Project root: {PROJECT_ROOT}")
    log.info(f"Today: {get_today_str()}")
    log.info(f"Now: {get_now_str()}")
    log.info(f"Alpaca key: {ALPACA_API_KEY[:8]}...")
    log.info(f"Perplexity key: {PERPLEXITY_API_KEY[:8]}...")
    log.info(f"ClickUp key: {CLICKUP_API_KEY[:8]}...")
    log.info(f"Tradeable symbols: {get_tradeable_symbols()}")
    log.info(f"Risk tier: {get_risk_tier()}")
