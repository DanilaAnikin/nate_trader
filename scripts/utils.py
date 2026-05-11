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


# Sector fallback for screener-discovered tickers not in watchlist.
# Mapped to the project's sector taxonomy: Technology, Financial, Healthcare,
# Industrial, Consumer, Energy, Materials, Utilities, RealEstate, Communication.
# Sector cap (25%) groups Technology + Communication and Consumer + Cyclical/Staples.
SECTOR_FALLBACK_MAP = {
    # Technology (semis, hardware, software)
    "INTC": "Technology", "TSM": "Technology", "MU": "Technology",
    "QCOM": "Technology", "TXN": "Technology", "ADI": "Technology",
    "LRCX": "Technology", "AMAT": "Technology", "KLAC": "Technology",
    "MRVL": "Technology", "SMCI": "Technology", "ARM": "Technology",
    "IBM": "Technology", "DELL": "Technology", "HPQ": "Technology",
    "HPE": "Technology", "CSCO": "Technology", "NOW": "Technology",
    "ADBE": "Technology", "INTU": "Technology", "WDAY": "Technology",
    "PANW": "Technology", "CRWD": "Technology", "ZS": "Technology",
    "NET": "Technology", "DDOG": "Technology", "MDB": "Technology",
    "FTNT": "Technology", "S": "Technology", "OKTA": "Technology",
    "TEAM": "Technology", "SHOP": "Technology", "SQ": "Technology",
    "BLOCK": "Technology", "COIN": "Technology", "APP": "Technology",
    "ASML": "Technology", "AVGO": "Technology", "NVDA": "Technology",
    "AMD": "Technology", "AAPL": "Technology", "MSFT": "Technology",
    "ORCL": "Technology", "GOOGL": "Technology", "GOOG": "Technology",
    "META": "Technology", "PLTR": "Technology", "ANET": "Technology",
    "SNOW": "Technology", "CRM": "Technology", "QQQ": "Technology",
    "POET": "Technology", "RXT": "Technology", "IBM": "Technology",
    "DOCN": "Technology", "RBLX": "Technology", "U": "Technology",

    # Consumer (discretionary + staples + retail + media)
    "AMZN": "Consumer", "TSLA": "Consumer", "NFLX": "Consumer",
    "DIS": "Consumer", "WMT": "Consumer", "TGT": "Consumer",
    "COST": "Consumer", "HD": "Consumer", "LOW": "Consumer",
    "NKE": "Consumer", "SBUX": "Consumer", "MCD": "Consumer",
    "CMG": "Consumer", "YUM": "Consumer", "PG": "Consumer",
    "KO": "Consumer", "PEP": "Consumer", "MO": "Consumer",
    "PM": "Consumer", "EL": "Consumer", "CL": "Consumer",
    "KHC": "Consumer", "MDLZ": "Consumer", "LULU": "Consumer",
    "F": "Consumer", "GM": "Consumer", "STLA": "Consumer",
    "ABNB": "Consumer", "BKNG": "Consumer", "UBER": "Consumer",
    "LYFT": "Consumer", "DASH": "Consumer", "EBAY": "Consumer",
    "ETSY": "Consumer", "BBY": "Consumer", "DKS": "Consumer",
    "RH": "Consumer", "DECK": "Consumer", "CROX": "Consumer",
    "ULTA": "Consumer", "GME": "Consumer", "AMC": "Consumer",

    # Financial (banks, insurance, asset mgmt, payments, exchanges)
    "JPM": "Financial", "BAC": "Financial", "WFC": "Financial",
    "C": "Financial", "GS": "Financial", "MS": "Financial",
    "USB": "Financial", "PNC": "Financial", "TFC": "Financial",
    "SCHW": "Financial", "BLK": "Financial", "BX": "Financial",
    "KKR": "Financial", "APO": "Financial", "ARES": "Financial",
    "V": "Financial", "MA": "Financial", "AXP": "Financial",
    "PYPL": "Financial", "FI": "Financial", "FIS": "Financial",
    "ICE": "Financial", "CME": "Financial", "NDAQ": "Financial",
    "SPGI": "Financial", "MCO": "Financial", "AON": "Financial",
    "MMC": "Financial", "MET": "Financial", "PRU": "Financial",
    "AFL": "Financial", "ALL": "Financial", "PGR": "Financial",
    "TRV": "Financial", "AIG": "Financial", "HIG": "Financial",
    "EQH": "Financial", "BRK.B": "Financial", "BRK.A": "Financial",

    # Healthcare (pharma, biotech, devices, payers, services)
    "LLY": "Healthcare", "NVO": "Healthcare", "JNJ": "Healthcare",
    "PFE": "Healthcare", "MRK": "Healthcare", "ABBV": "Healthcare",
    "AZN": "Healthcare", "GSK": "Healthcare", "SNY": "Healthcare",
    "BMY": "Healthcare", "AMGN": "Healthcare", "GILD": "Healthcare",
    "REGN": "Healthcare", "VRTX": "Healthcare", "BIIB": "Healthcare",
    "MRNA": "Healthcare", "BNTX": "Healthcare", "NVAX": "Healthcare",
    "UNH": "Healthcare", "CVS": "Healthcare", "CI": "Healthcare",
    "HUM": "Healthcare", "ELV": "Healthcare", "CNC": "Healthcare",
    "ISRG": "Healthcare", "MDT": "Healthcare", "BSX": "Healthcare",
    "ABT": "Healthcare", "TMO": "Healthcare", "DHR": "Healthcare",
    "SYK": "Healthcare", "EW": "Healthcare", "ZBH": "Healthcare",
    "BDX": "Healthcare", "BAX": "Healthcare", "ALGN": "Healthcare",

    # Industrial (machinery, defense, transports, aerospace, services)
    "CAT": "Industrial", "DE": "Industrial", "AGCO": "Industrial",
    "GE": "Industrial", "RTX": "Industrial", "LMT": "Industrial",
    "NOC": "Industrial", "GD": "Industrial", "BA": "Industrial",
    "HON": "Industrial", "MMM": "Industrial", "ITW": "Industrial",
    "EMR": "Industrial", "ETN": "Industrial", "PH": "Industrial",
    "ROK": "Industrial", "DOV": "Industrial", "SWK": "Industrial",
    "AOS": "Industrial", "AAON": "Industrial", "TT": "Industrial",
    "CARR": "Industrial", "JCI": "Industrial", "LII": "Industrial",
    "UPS": "Industrial", "FDX": "Industrial", "ODFL": "Industrial",
    "CSX": "Industrial", "NSC": "Industrial", "UNP": "Industrial",
    "LUV": "Industrial", "DAL": "Industrial", "UAL": "Industrial",
    "AAL": "Industrial", "URI": "Industrial", "WM": "Industrial",
    "RSG": "Industrial", "PWR": "Industrial", "FWRD": "Industrial",
    "VRSK": "Industrial", "BAH": "Industrial",

    # Energy (oil & gas, services, renewables)
    "XOM": "Energy", "CVX": "Energy", "COP": "Energy",
    "EOG": "Energy", "OXY": "Energy", "PSX": "Energy",
    "VLO": "Energy", "MPC": "Energy", "SLB": "Energy",
    "HAL": "Energy", "BKR": "Energy", "FANG": "Energy",
    "DVN": "Energy", "PXD": "Energy", "MRO": "Energy",
    "APA": "Energy", "OKE": "Energy", "KMI": "Energy",
    "WMB": "Energy", "ENB": "Energy", "ET": "Energy",
    "TPL": "Energy", "AES": "Energy",

    # Materials
    "LIN": "Materials", "APD": "Materials", "SHW": "Materials",
    "ECL": "Materials", "DD": "Materials", "DOW": "Materials",
    "LYB": "Materials", "FCX": "Materials", "NEM": "Materials",
    "NUE": "Materials", "STLD": "Materials", "X": "Materials",
    "CLF": "Materials", "MOS": "Materials", "CF": "Materials",
    "ALB": "Materials",

    # Utilities
    "NEE": "Utilities", "DUK": "Utilities", "SO": "Utilities",
    "D": "Utilities", "EXC": "Utilities", "AEP": "Utilities",
    "SRE": "Utilities", "XEL": "Utilities", "ED": "Utilities",
    "WEC": "Utilities", "AWK": "Utilities", "PEG": "Utilities",
    "VST": "Utilities", "CEG": "Utilities",

    # Real Estate
    "AMT": "RealEstate", "PLD": "RealEstate", "CCI": "RealEstate",
    "EQIX": "RealEstate", "DLR": "RealEstate", "PSA": "RealEstate",
    "SPG": "RealEstate", "O": "RealEstate", "VICI": "RealEstate",
    "WELL": "RealEstate", "AVB": "RealEstate", "EQR": "RealEstate",

    # Hedge instruments — exempt from sector cap, used only by manage_bear_hedge
    "SH": "Hedge",      # ProShares Short S&P500 (1x inverse, non-leveraged)

    # Communication (separated for visibility, treated as Technology for cap)
    "T": "Communication", "VZ": "Communication", "TMUS": "Communication",
    "CMCSA": "Communication", "CHTR": "Communication", "DIS": "Communication",
    "PARA": "Communication", "WBD": "Communication", "EA": "Communication",
    "TTWO": "Communication", "ROKU": "Communication", "SPOT": "Communication",
}


def get_symbol_info(symbol: str) -> dict:
    """Get info for a symbol.

    Lookup order:
      1. watchlist.json — full info (sector, max_allocation, notes)
      2. SECTOR_FALLBACK_MAP — sector-only for screener-discovered tickers
      3. {} — sector cap won't apply (warning logged in validate_order)
    """
    wl = load_watchlist()
    info = wl.get("symbols", {}).get(symbol)
    if info:
        return info
    fallback_sector = SECTOR_FALLBACK_MAP.get(symbol)
    if fallback_sector:
        return {
            "sector": fallback_sector,
            "max_allocation_pct": 5,
            "tradeable": True,
            "notes": "Screener-discovered — sector from fallback map",
        }
    return {}


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
