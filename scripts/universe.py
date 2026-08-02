"""Dynamic US-equity universe discovery and local fallback loading.

The Alpaca client is created only when :func:`discover_universe` or
:func:`refresh_universe` is called without an injected client.  Importing this
module and loading a cached universe are therefore local-only operations.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import argparse

from utils import (
    ALPACA_API_KEY,
    ALPACA_SECRET_KEY,
    POSITIONS_STATE,
    STATE_DIR,
    WATCHLIST_PATH,
    load_json,
    save_json,
)


# Version 2 narrows discovery to ordinary shares/ADRs. Version 1 allowed
# unlevered funds because Alpaca reports ETFs under ``us_equity`` too.
UNIVERSE_SCHEMA_VERSION = 2
UNIVERSE_STATE = STATE_DIR / "universe.json"
# A production Alpaca stock discovery normally contains thousands of names.
# One hundred is deliberately conservative enough to tolerate upstream
# filtering changes while still rejecting partial 1--8 symbol responses that
# would silently collapse a broad cross-sectional strategy.
MIN_UNIVERSE_SYMBOL_COUNT = 100
UNIVERSE_CACHE_MAX_AGE = timedelta(days=7)
UNIVERSE_CACHE_MAX_FUTURE_SKEW = timedelta(minutes=15)
UNIVERSE_SOURCE = "alpaca.get_all_assets"
UNIVERSE_ASSET_CLASS = "us_equity"

_client: Any | None = None

_US_EXCHANGES = frozenset({"AMEX", "ARCA", "BATS", "NASDAQ", "NYSE", "NYSEARCA"})
_SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z0-9]{1,3})?$")
_PUNCTUATED_SECURITY_SUFFIX_RE = re.compile(
    r"(?:[.-](?:W|WS|WT|WTS|R|RT|U|UN))$"
)

# A name is useful for detecting products that Alpaca otherwise reports under
# the same ``us_equity`` asset class as ordinary shares.
_FUND_MARKER_RE = re.compile(
    r"\b(?:ETF|ETN|FUND|TRUST|EXCHANGE[- ]TRADED|PROSHARES|DIREXION|"
    r"GRANITESHARES|MICROSECTORS|YIELDMAX|DEFIANCE|T-?REX|REX SHARES)\b",
    re.IGNORECASE,
)
_COMMON_EQUITY_MARKER_RE = re.compile(
    r"\b(?:COMMON (?:STOCK|SHARES?)|ORDINARY SHARES?|"
    r"AMERICAN DEPOSITARY (?:RECEIPTS?|SHARES?)|ADR|ADS)\b",
    re.IGNORECASE,
)
_LEVERAGE_RE = re.compile(
    r"(?:\b(?:LEVERAGED|INVERSE|ULTRA\s*PRO|ULTRA\s*SHORT)\b|"
    r"(?<![A-Z0-9])[-+]?(?:1(?:\.5)?|2|3|4)\s*[X×](?![A-Z0-9]))",
    re.IGNORECASE,
)
_DIRECTIONAL_FUND_RE = re.compile(
    r"\b(?:DAILY\s+)?(?:BULL|BEAR)\b|\bDAILY\s+(?:LONG|SHORT)\b",
    re.IGNORECASE,
)
_INVERSE_SHORT_RE = re.compile(
    r"\b(?:PROSHARES|DIREXION|GRANITESHARES|MICROSECTORS|T-?REX|REX SHARES)\b"
    r".*\bSHORT\b",
    re.IGNORECASE,
)
_VOLATILITY_RE = re.compile(r"\b(?:VIX|VOLATILITY)\b", re.IGNORECASE)
_SINGLE_STOCK_RE = re.compile(
    r"\bSINGLE[- ]STOCK\b|\bSINGLE SECURITY\b|"
    r"\b(?:OPTION INCOME|YIELD PREMIUM) STRATEGY (?:ETF|FUND)\b|"
    r"\bTARGET INCOME ETF\b|\bWEEKLYPAY ETF\b|\bDAILY TARGET\b",
    re.IGNORECASE,
)
_WARRANT_RIGHT_UNIT_NAME_RE = re.compile(
    r"\bWARRANTS?\b|\bSUBSCRIPTION RIGHTS?\b|\bRIGHTS TO PURCHASE\b|"
    r"\bRIGHTS?\b\s*[,;/]?$|\bUNITS?\b\s*[,;/]?$|"
    r"\bUNITS?, EACH\b|\bUNITS? CONSISTING\b",
    re.IGNORECASE,
)

# Name matching remains the primary, future-facing filter.  The explicit set
# protects discovery when an upstream asset happens to have a blank name.
_KNOWN_EXCLUDED_FUNDS = frozenset(
    {
        "AMDL", "AMDS", "AMZD", "AMZU", "AAPD", "AAPU", "BERZ", "BOIL",
        "BULZ", "CONL", "CURE", "DRIP", "DRV", "DUST", "ERX", "ERY",
        "FAS", "FAZ", "FNGD", "FNGU", "GUSH", "JDST", "JNUG", "KOLD",
        "LABD", "LABU", "MSFD", "MSFU", "NAIL", "NVDD", "NVDL", "NUGT",
        "SCO", "SDOW", "SOXL", "SOXS", "SPXL", "SPXS", "SPXU", "SQQQ",
        "SVXY", "TECL", "TECS", "TMF", "TMV", "TNA", "TQQQ", "TSLL",
        "TSLS", "TZA", "UCO", "UDOW", "UPRO", "UVXY", "VIXY", "VXX",
        "WEBL", "WEBS", "YANG", "YINN",
    }
)


class UniverseDiscoveryError(RuntimeError):
    """Raised when discovery cannot safely produce a cacheable universe."""


def _get_trading_client() -> Any:
    """Create the Alpaca trading client on first network-backed use only."""
    global _client
    if _client is None:
        from alpaca.trading.client import TradingClient

        _client = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)
    return _client


def _field(asset: Any, name: str, default: Any = None) -> Any:
    if isinstance(asset, Mapping):
        return asset.get(name, default)
    return getattr(asset, name, default)


def _enum_value(value: Any) -> str:
    return str(getattr(value, "value", value)).strip()


def _normalise_symbol(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    symbol = value.strip().upper()
    if not _SYMBOL_RE.fullmatch(symbol):
        return None
    if _PUNCTUATED_SECURITY_SUFFIX_RE.search(symbol):
        return None
    # A fifth trailing W/R/U is Nasdaq's issue-type convention.  Restricting
    # this rule to five characters avoids rejecting ordinary tickers such as
    # FOUR or HOUR.
    if len(symbol) == 5 and symbol[-1] in {"W", "R", "U"}:
        return None
    return symbol


def _is_disallowed_name(name: Any) -> bool:
    if not isinstance(name, str) or not name.strip():
        return False
    clean_name = " ".join(name.split())
    if _WARRANT_RIGHT_UNIT_NAME_RE.search(clean_name):
        return True
    if _SINGLE_STOCK_RE.search(clean_name):
        return True

    fund_match = _FUND_MARKER_RE.search(clean_name)
    if fund_match:
        # REIT/business trusts often include "Trust" in the issuer name but
        # explicitly identify their listed common shares. Preserve those;
        # reject ETFs, ETNs, mutual/closed-end funds and commodity trusts.
        trust_common_equity = (
            fund_match.group(0).upper() == "TRUST"
            and _COMMON_EQUITY_MARKER_RE.search(clean_name)
        )
        if not trust_common_equity:
            return True
    return False


def is_eligible_asset(asset: Any) -> bool:
    """Return whether an Alpaca asset is an eligible ordinary share or ADR.

    Server-side request filters are intentionally rechecked here so a partial
    or mocked API response cannot silently widen the trading universe.
    """
    if _enum_value(_field(asset, "status")).lower() != "active":
        return False
    if _enum_value(_field(asset, "asset_class")).lower() != "us_equity":
        return False
    if _field(asset, "tradable") is not True:
        return False
    if _enum_value(_field(asset, "exchange")).upper() not in _US_EXCHANGES:
        return False

    raw_symbol = _field(asset, "symbol")
    symbol = _normalise_symbol(raw_symbol)
    if symbol is None or raw_symbol != symbol:
        return False
    if symbol in _KNOWN_EXCLUDED_FUNDS:
        return False
    return not _is_disallowed_name(_field(asset, "name", ""))


def filter_assets(assets: Iterable[Any]) -> list[str]:
    """Filter and deterministically sort an iterable of Alpaca assets."""
    return sorted({_field(asset, "symbol") for asset in assets if is_eligible_asset(asset)})


def discover_universe(client: Any | None = None) -> list[str]:
    """Fetch and filter all active Alpaca US-equity assets.

    Supplying ``client`` is the supported test/offline seam; the default client
    is constructed lazily and is always configured for the paper endpoint.
    """
    from alpaca.trading.enums import AssetClass, AssetStatus
    from alpaca.trading.requests import GetAssetsRequest

    trading_client = client if client is not None else _get_trading_client()
    request = GetAssetsRequest(
        status=AssetStatus.ACTIVE,
        asset_class=AssetClass.US_EQUITY,
    )
    assets = trading_client.get_all_assets(request)
    if isinstance(assets, Mapping) or not isinstance(assets, Iterable):
        raise UniverseDiscoveryError("Alpaca returned an invalid asset collection")
    return filter_assets(assets)


def build_universe_payload(
    symbols: Iterable[str], *, generated_at: datetime | None = None
) -> dict[str, Any]:
    """Build the versioned payload stored at ``state/universe.json``."""
    clean_symbols = sorted(
        {symbol for value in symbols if (symbol := _normalise_symbol(value)) is not None}
    )
    timestamp = generated_at or datetime.now(timezone.utc)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    updated_at = timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "version": UNIVERSE_SCHEMA_VERSION,
        "schema_version": UNIVERSE_SCHEMA_VERSION,
        "updated_at": updated_at,
        "source": UNIVERSE_SOURCE,
        "asset_class": UNIVERSE_ASSET_CLASS,
        "symbol_count": len(clean_symbols),
        "symbols": clean_symbols,
    }


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_utc_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value or value != value.strip():
        return None
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if timestamp.tzinfo is None or timestamp.utcoffset() != timedelta(0):
        return None
    return timestamp.astimezone(timezone.utc)


def refresh_universe(
    *,
    client: Any | None = None,
    cache_path: Path = UNIVERSE_STATE,
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    """Discover and atomically cache the current eligible universe.

    A narrow/partial response is treated as an upstream failure and never
    overwrites a previously usable cache.
    """
    symbols = discover_universe(client)
    if not symbols:
        raise UniverseDiscoveryError("Discovery returned no eligible symbols")
    if len(symbols) < MIN_UNIVERSE_SYMBOL_COUNT:
        raise UniverseDiscoveryError(
            "Discovery returned too few eligible symbols "
            f"({len(symbols)} < {MIN_UNIVERSE_SYMBOL_COUNT})"
        )
    payload = build_universe_payload(symbols, generated_at=generated_at)
    if not valid_cached_universe_symbols(payload):
        raise UniverseDiscoveryError("Discovery produced an invalid cache payload")
    save_json(cache_path, payload)
    return payload


def _payload_symbols(payload: Any) -> set[str]:
    if not isinstance(payload, Mapping):
        return set()
    raw_symbols = payload.get("symbols", [])
    values = raw_symbols.keys() if isinstance(raw_symbols, Mapping) else raw_symbols
    if not isinstance(values, Iterable) or isinstance(values, (str, bytes)):
        return set()
    return {
        symbol
        for value in values
        if (symbol := _normalise_symbol(value)) is not None
    }


def valid_cached_universe_symbols(
    payload: Any, *, now: datetime | None = None
) -> set[str]:
    """Return symbols only when the entire cache provenance contract is valid."""

    if not isinstance(payload, Mapping):
        return set()
    if payload.get("source") != UNIVERSE_SOURCE:
        return set()
    if payload.get("asset_class") != UNIVERSE_ASSET_CLASS:
        return set()
    versions = [payload.get("version"), payload.get("schema_version")]
    if any(type(version) is not int for version in versions):
        return set()
    if any(version != UNIVERSE_SCHEMA_VERSION for version in versions):
        return set()

    updated_at = _parse_utc_timestamp(payload.get("updated_at"))
    if updated_at is None:
        return set()
    current = now or _utc_now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    current = current.astimezone(timezone.utc)
    if updated_at - current > UNIVERSE_CACHE_MAX_FUTURE_SKEW:
        return set()
    if current - updated_at > UNIVERSE_CACHE_MAX_AGE:
        return set()

    raw_symbols = payload.get("symbols")
    if not isinstance(raw_symbols, list):
        return set()
    if any(
        not isinstance(value, str) or _normalise_symbol(value) != value
        for value in raw_symbols
    ):
        return set()
    symbols = set(raw_symbols)
    if len(symbols) != len(raw_symbols):
        return set()
    symbol_count = payload.get("symbol_count")
    if type(symbol_count) is not int or symbol_count != len(raw_symbols):
        return set()
    if symbol_count < MIN_UNIVERSE_SYMBOL_COUNT:
        return set()
    return symbols


def _valid_cached_symbols(payload: Any) -> set[str]:
    """Backward-compatible private alias for older callers/tests."""

    return valid_cached_universe_symbols(payload)


def _watchlist_symbols(payload: Any) -> set[str]:
    if not isinstance(payload, Mapping):
        return set()
    raw_symbols = payload.get("symbols", {})
    if isinstance(raw_symbols, Mapping):
        values = (
            symbol
            for symbol, info in raw_symbols.items()
            if not isinstance(info, Mapping)
            or (
                info.get("tradeable", False)
                and not _is_disallowed_name(info.get("name") or info.get("notes", ""))
            )
        )
    elif isinstance(raw_symbols, Iterable) and not isinstance(raw_symbols, (str, bytes)):
        values = raw_symbols
    else:
        return set()
    return {
        symbol
        for value in values
        if (symbol := _normalise_symbol(value)) is not None
    }


def _held_symbols(payload: Any) -> set[str]:
    positions = payload.get("positions", []) if isinstance(payload, Mapping) else payload
    if isinstance(positions, Mapping):
        values = positions.keys()
    elif isinstance(positions, Iterable) and not isinstance(positions, (str, bytes)):
        values = (
            position if isinstance(position, str) else _field(position, "symbol")
            for position in positions
        )
    else:
        return set()
    return {
        symbol
        for value in values
        if (symbol := _normalise_symbol(value)) is not None
    }


def resolve_universe_symbols(
    cache_payload: Any,
    positions_payload: Any,
    watchlist_payload: Any,
) -> list[str]:
    """Purely resolve cache/watchlist fallback plus currently held symbols.

    A non-empty current-version cache wins over the static watchlist.  Held
    symbols are always included so risk management can still inspect positions
    that have since left, or are intentionally excluded from, discovery.
    """
    cached = valid_cached_universe_symbols(cache_payload)
    base = cached if cached else _watchlist_symbols(watchlist_payload)
    return sorted(base | _held_symbols(positions_payload))


def load_universe_symbols(
    *,
    cache_path: Path = UNIVERSE_STATE,
    positions_path: Path = POSITIONS_STATE,
    watchlist_path: Path = WATCHLIST_PATH,
    held_symbols: Iterable[str] | None = None,
) -> list[str]:
    """Load the best local universe without constructing a network client.

    ``held_symbols`` lets a caller supply a fresher broker snapshot.  When it
    is omitted, the committed/local ``positions.json`` snapshot is used.
    """
    positions = held_symbols if held_symbols is not None else load_json(positions_path)
    return resolve_universe_symbols(
        load_json(cache_path),
        positions,
        load_json(watchlist_path),
    )


__all__ = [
    "UNIVERSE_SCHEMA_VERSION",
    "UNIVERSE_STATE",
    "MIN_UNIVERSE_SYMBOL_COUNT",
    "UniverseDiscoveryError",
    "build_universe_payload",
    "discover_universe",
    "filter_assets",
    "is_eligible_asset",
    "load_universe_symbols",
    "refresh_universe",
    "resolve_universe_symbols",
    "valid_cached_universe_symbols",
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Nate Trader universe cache")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("refresh", help="refresh active Alpaca US equities")
    subparsers.add_parser("show", help="show the local cache/fallback summary")
    args = parser.parse_args(argv)

    if args.command == "refresh":
        payload = refresh_universe()
        print(
            f"Cached {payload['symbol_count']} symbols in {UNIVERSE_STATE} "
            f"at {payload['updated_at']}"
        )
        return 0

    symbols = load_universe_symbols()
    source = (
        "cache"
        if valid_cached_universe_symbols(load_json(UNIVERSE_STATE))
        else "watchlist fallback"
    )
    print(f"Universe: {len(symbols)} symbols ({source})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
