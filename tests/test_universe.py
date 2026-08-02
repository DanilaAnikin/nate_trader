"""Tests for dynamic universe discovery and fail-safe local fallback."""

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import universe


def asset(
    symbol: str,
    *,
    name: str = "Example Corporation Common Stock",
    status: str = "active",
    asset_class: str = "us_equity",
    tradable: bool = True,
    exchange: str = "NASDAQ",
):
    return SimpleNamespace(
        symbol=symbol,
        name=name,
        status=status,
        asset_class=asset_class,
        tradable=tradable,
        exchange=exchange,
    )


class FakeClient:
    def __init__(self, assets):
        self.assets = assets
        self.requests = []

    def get_all_assets(self, request):
        self.requests.append(request)
        return self.assets


def broad_symbols(*preferred: str) -> list[str]:
    symbols = list(preferred)
    symbols.extend(
        f"Z{index:04d}" for index in range(universe.MIN_UNIVERSE_SYMBOL_COUNT)
    )
    return sorted(set(symbols))


def current_cache(*preferred: str):
    return universe.build_universe_payload(
        broad_symbols(*preferred), generated_at=datetime.now(timezone.utc)
    )


def test_filter_assets_keeps_only_active_tradable_us_exchange_equities():
    assets = [
        asset("MSFT"),
        asset("BRK.B", exchange="NYSE"),
        asset("OTCM", exchange="OTC"),
        asset("HALT", status="inactive"),
        asset("BTCUSD", asset_class="crypto"),
        asset("NOPE", tradable=False),
        asset("BAD SYMBOL"),
        asset("lower"),
        asset("MSFT"),
    ]

    assert universe.filter_assets(assets) == ["BRK.B", "MSFT"]


@pytest.mark.parametrize(
    ("symbol", "name"),
    [
        ("ABCDW", "Acme Corporation Warrant"),
        ("ABCDR", "Acme Subscription Right"),
        ("ABCDU", "Acme Units, Each Consisting of One Share"),
        ("ABCR", "Acme Corporation Right"),
        ("ABCU", "Acme Corporation Unit"),
        ("ACME.WS", "Acme Warrant"),
        ("TQQQ", "ProShares UltraPro QQQ"),
        ("SPXS", "Direxion Daily S&P 500 Bear 3X Shares"),
        ("UVXY", "ProShares Ultra VIX Short-Term Futures ETF"),
        ("NVDL", "GraniteShares 2x Long NVDA Daily ETF"),
        ("TSLY", "YieldMax TSLA Option Income Strategy ETF"),
        ("TEST", "Example Single-Stock ETF"),
    ],
)
def test_filter_assets_rejects_non_common_and_high_risk_products(symbol, name):
    assert not universe.is_eligible_asset(asset(symbol, name=name))


def test_regular_unleveraged_etf_is_outside_the_stock_signal_universe():
    assert not universe.is_eligible_asset(
        asset("VOO", name="Vanguard S&P 500 ETF", exchange="ARCA")
    )


def test_listed_reit_trust_common_stock_remains_eligible():
    assert universe.is_eligible_asset(
        asset(
            "DLR",
            name="Digital Realty Trust, Inc. Common Stock",
            exchange="NYSE",
        )
    )


def test_ordinary_company_with_bear_in_name_is_not_misclassified_as_inverse():
    assert universe.is_eligible_asset(
        asset(
            "BBW",
            name="Build-A-Bear Workshop, Inc. Common Stock",
            exchange="NYSE",
        )
    )


def test_discovery_uses_server_side_active_us_equity_filters():
    client = FakeClient([asset("MSFT"), asset("AAPL")])

    assert universe.discover_universe(client) == ["AAPL", "MSFT"]
    assert len(client.requests) == 1
    request = client.requests[0]
    assert request.status.value == "active"
    assert request.asset_class.value == "us_equity"


def test_refresh_writes_a_deterministic_versioned_payload(tmp_path, monkeypatch):
    cache_path = tmp_path / "state" / "universe.json"
    generated_at = datetime(2026, 7, 30, 12, 30, tzinfo=timezone.utc)
    symbols = broad_symbols("MSFT", "AAPL")
    client = FakeClient([*(asset(symbol) for symbol in symbols), asset("MSFT")])
    monkeypatch.setattr(universe, "_utc_now", lambda: generated_at)

    payload = universe.refresh_universe(
        client=client,
        cache_path=cache_path,
        generated_at=generated_at,
    )

    assert payload == json.loads(cache_path.read_text())
    assert payload["version"] == universe.UNIVERSE_SCHEMA_VERSION
    assert payload["schema_version"] == universe.UNIVERSE_SCHEMA_VERSION
    assert payload["updated_at"] == "2026-07-30T12:30:00Z"
    assert payload["source"] == "alpaca.get_all_assets"
    assert payload["asset_class"] == "us_equity"
    assert payload["symbol_count"] == len(symbols)
    assert payload["symbols"] == symbols


def test_empty_discovery_never_overwrites_a_good_cache(tmp_path):
    cache_path = tmp_path / "universe.json"
    original = current_cache("AAPL")
    cache_path.write_text(json.dumps(original))

    with pytest.raises(universe.UniverseDiscoveryError, match="no eligible symbols"):
        universe.refresh_universe(client=FakeClient([]), cache_path=cache_path)

    assert json.loads(cache_path.read_text()) == original


def test_partial_tiny_discovery_never_overwrites_a_good_cache(tmp_path):
    cache_path = tmp_path / "universe.json"
    original = current_cache("AAPL")
    cache_path.write_text(json.dumps(original))
    partial = [asset(f"P{index}") for index in range(8)]

    with pytest.raises(universe.UniverseDiscoveryError, match="8 < 100"):
        universe.refresh_universe(client=FakeClient(partial), cache_path=cache_path)

    assert json.loads(cache_path.read_text()) == original


def test_resolver_prefers_current_cache_and_always_adds_held_symbols():
    cache = current_cache("MSFT", "AAPL")
    positions = {
        "positions": [
            {"symbol": "TQQQ"},
            {"symbol": "AAPL"},
        ]
    }
    watchlist = {
        "symbols": {
            "NVDA": {"tradeable": True},
            "SPY": {"tradeable": False},
        }
    }

    resolved = universe.resolve_universe_symbols(cache, positions, watchlist)

    assert set(resolved) == set(cache["symbols"]) | {"TQQQ"}
    assert "NVDA" not in resolved


@pytest.mark.parametrize(
    "cache",
    [
        {},
        {"version": 1, "schema_version": 1, "symbols": ["MSFT"]},
        {"version": 1, "schema_version": 2, "symbols": ["MSFT"]},
        {"symbols": ["MSFT"]},
        {"version": 1, "schema_version": 1, "symbols": []},
        universe.build_universe_payload(
            ["MSFT"], generated_at=datetime.now(timezone.utc)
        ),
    ],
)
def test_resolver_falls_back_to_tradeable_watchlist_for_unusable_cache(cache):
    positions = {"positions": [{"symbol": "UPRO"}]}
    watchlist = {
        "symbols": {
            "NVDA": {"tradeable": True},
            "AAPL": {"tradeable": True},
            "SPY": {"tradeable": False},
        }
    }

    assert universe.resolve_universe_symbols(cache, positions, watchlist) == [
        "AAPL",
        "NVDA",
        "UPRO",
    ]


def test_local_loader_never_constructs_an_alpaca_client(tmp_path, monkeypatch):
    cache_path = tmp_path / "universe.json"
    positions_path = tmp_path / "positions.json"
    watchlist_path = tmp_path / "watchlist.json"
    cache_payload = current_cache("AAPL")
    cache_path.write_text(json.dumps(cache_payload))
    positions_path.write_text(json.dumps({"positions": [{"symbol": "TQQQ"}]}))
    watchlist_path.write_text(json.dumps({"symbols": {}}))

    def fail_if_called():
        raise AssertionError("local fallback attempted to construct a network client")

    monkeypatch.setattr(universe, "_get_trading_client", fail_if_called)

    resolved = universe.load_universe_symbols(
        cache_path=cache_path,
        positions_path=positions_path,
        watchlist_path=watchlist_path,
    )

    assert set(resolved) == set(cache_payload["symbols"]) | {"TQQQ"}


def test_local_loader_can_use_a_fresh_held_symbol_snapshot(tmp_path):
    cache_path = tmp_path / "universe.json"
    positions_path = tmp_path / "positions.json"
    watchlist_path = tmp_path / "watchlist.json"
    cache_payload = current_cache("AAPL")
    cache_path.write_text(json.dumps(cache_payload))
    positions_path.write_text(json.dumps({"positions": [{"symbol": "STALE"}]}))
    watchlist_path.write_text(json.dumps({"symbols": {}}))

    resolved = universe.load_universe_symbols(
        cache_path=cache_path,
        positions_path=positions_path,
        watchlist_path=watchlist_path,
        held_symbols=["UPRO", "AAPL"],
    )

    assert set(resolved) == set(cache_payload["symbols"]) | {"UPRO"}


def test_cache_contract_accepts_only_fresh_broad_alpaca_us_equities():
    now = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)
    symbols = broad_symbols("AAPL")
    payload = universe.build_universe_payload(symbols, generated_at=now)

    assert universe.valid_cached_universe_symbols(payload, now=now) == set(symbols)


def test_cache_contract_rejects_spoofed_stale_or_inconsistent_payloads():
    now = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)

    def payload_with(**changes):
        payload = universe.build_universe_payload(
            broad_symbols("AAPL"), generated_at=now
        )
        payload.update(changes)
        return payload

    invalid_payloads = [
        payload_with(source="manual"),
        payload_with(asset_class="crypto"),
        payload_with(updated_at="2026-07-31T12:00:00"),
        payload_with(updated_at="2026-07-31T14:00:00+02:00"),
        payload_with(updated_at="not-a-date"),
        payload_with(updated_at=(now - timedelta(days=8)).isoformat()),
        payload_with(updated_at=(now + timedelta(minutes=16)).isoformat()),
        payload_with(symbol_count=1),
        payload_with(symbol_count=True),
        payload_with(symbols=["AAPL"]),
    ]

    for payload in invalid_payloads:
        assert universe.valid_cached_universe_symbols(payload, now=now) == set()


def test_invalid_current_version_cache_falls_back_to_watchlist():
    tiny = universe.build_universe_payload(
        [f"P{index}" for index in range(8)],
        generated_at=datetime.now(timezone.utc),
    )
    positions = {"positions": [{"symbol": "UPRO"}]}
    watchlist = {
        "symbols": {
            "NVDA": {"tradeable": True},
            "SPY": {"tradeable": False},
        }
    }

    assert universe.resolve_universe_symbols(tiny, positions, watchlist) == [
        "NVDA",
        "UPRO",
    ]


def test_import_does_not_create_an_alpaca_client():
    assert universe._client is None
