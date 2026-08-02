"""Regression tests for paper-execution safety boundaries."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pandas as pd
import pytest

import execute_trades
import strategy_config
import trade
from tests.v11_report_factory import canonical_validation_report


class _ReadOnlyBroker:
    """Tiny broker double that records every mutating method invocation."""

    def __init__(self, *, positions=None, orders=None, clock=None):
        self.positions = list(positions or [])
        self.orders = list(orders or [])
        self.clock = clock
        self.mutations: list[tuple[str, object]] = []

    def get_all_positions(self):
        return self.positions

    def get_orders(self, *, filter=None):
        return self.orders

    def get_clock(self):
        if isinstance(self.clock, Exception):
            raise self.clock
        return self.clock

    def submit_order(self, request):
        self.mutations.append(("submit_order", request))
        raise AssertionError("dry-run submitted an order")

    def cancel_order_by_id(self, order_id):
        self.mutations.append(("cancel_order_by_id", order_id))
        raise AssertionError("dry-run cancelled an order")

    def cancel_orders(self):
        self.mutations.append(("cancel_orders", None))
        raise AssertionError("dry-run cancelled orders")

    def close_position(self, symbol):
        self.mutations.append(("close_position", symbol))
        raise AssertionError("dry-run closed a position")


@pytest.mark.parametrize(
    ("is_open", "age_seconds", "allowed"),
    [
        (True, 5, True),
        (False, 5, False),
        (True, 121, False),
    ],
)
def test_market_entry_gate_requires_open_and_fresh_clock(
    monkeypatch, is_open, age_seconds, allowed
):
    now = datetime(2026, 7, 30, 15, 0, tzinfo=timezone.utc)
    broker = _ReadOnlyBroker(
        clock=SimpleNamespace(
            is_open=is_open,
            timestamp=now - timedelta(seconds=age_seconds),
        )
    )
    monkeypatch.setattr(trade, "_client", broker)

    gate = trade.get_market_entry_gate(now=now, max_age_seconds=120)

    assert gate["allowed"] is allowed
    assert gate["is_open"] is is_open
    assert gate["is_fresh"] is (age_seconds <= 120)
    assert broker.mutations == []


def test_market_entry_gate_fails_closed_when_clock_unavailable(monkeypatch):
    broker = _ReadOnlyBroker(clock=RuntimeError("clock API down"))
    monkeypatch.setattr(trade, "_client", broker)

    gate = trade.get_market_entry_gate()

    assert gate["allowed"] is False
    assert "unavailable" in gate["reason"]
    assert broker.mutations == []


def test_dry_run_stop_loss_and_stop_sync_make_zero_broker_mutations(monkeypatch):
    losing_position = SimpleNamespace(
        symbol="AAPL",
        qty="4",
        unrealized_plpc="-0.25",
    )
    broker = _ReadOnlyBroker(positions=[losing_position], orders=[])
    monkeypatch.setattr(trade, "_client", broker)
    monkeypatch.setattr(
        strategy_config,
        "get_strategy_params",
        lambda *args, **kwargs: {"trailing_stop_pct": 8.0},
    )

    losses = trade.execute_stop_losses(dry_run=True)
    synced = trade.sync_trailing_stops(dry_run=True)

    assert losses == [
        {
            "symbol": "AAPL",
            "action": "DRY_RUN_STOP_LOSS",
            "reason": "Stop-loss at -25.00%",
        }
    ]
    assert synced == [
        {
            "symbol": "AAPL",
            "qty": 4,
            "trail_pct": 8.0,
            "action": "DRY_RUN_SYNC_STOP",
        }
    ]
    assert broker.mutations == []


def test_limit_order_supports_optional_client_order_id(monkeypatch):
    submitted = []

    class Broker:
        def submit_order(self, request):
            submitted.append(request)
            return SimpleNamespace(
                id="order-1",
                symbol=request.symbol,
                side=request.side,
                qty=request.qty,
                limit_price=request.limit_price,
                status="accepted",
                created_at="2026-07-30T15:00:00Z",
            )

    monkeypatch.setattr(trade, "_client", Broker())

    trade.place_limit_order("AAPL", 2, "buy", 201.239)
    trade.place_limit_order(
        "MSFT", 3, "buy", 402.349, client_order_id="nt-momentum-msft-202607"
    )

    assert submitted[0].client_order_id is None
    assert submitted[1].client_order_id == "nt-momentum-msft-202607"
    assert float(submitted[0].limit_price) == 201.24


def test_client_order_id_builder_is_deterministic_and_bounded():
    first = trade.build_client_order_id("momentum", "AAPL", "buy", "2026-07")
    retry = trade.build_client_order_id("momentum", "AAPL", "buy", "2026-07")
    next_period = trade.build_client_order_id(
        "momentum", "AAPL", "buy", "2026-08"
    )

    assert first == retry
    assert first != next_period
    assert len(first) <= 48


@pytest.mark.parametrize(
    ("daily_return_pct", "valid"),
    [(-3.1, True), (-8.1, False)],
)
def test_order_daily_backstop_matches_shared_halt_threshold(
    monkeypatch, daily_return_pct, valid
):
    class Broker:
        @staticmethod
        def get_account():
            last_equity = 100_000.0
            return SimpleNamespace(
                equity=last_equity * (1.0 + daily_return_pct / 100.0),
                cash=100_000.0,
                last_equity=last_equity,
            )

        @staticmethod
        def get_all_positions():
            return []

        @staticmethod
        def get_asset(symbol):
            return SimpleNamespace(tradable=True, status="active")

    monkeypatch.setattr(trade, "_client", Broker())
    monkeypatch.setattr(trade, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        strategy_config,
        "get_strategy_params",
        lambda *a, **k: {
            "min_cash_pct": 10.0,
            "max_position_pct": 9.0,
            "max_positions": 10,
            "momentum_max_sector_pct": 20.0,
        },
    )

    result = trade.validate_order(
        "AAPL", 1, "buy", 100.0, sector_override="Technology"
    )

    assert result["valid"] is valid
    assert any("Daily HALT" in reason for reason in result["reasons"]) is (
        not valid
    )


def test_momentum_buy_leg_uses_post_earnings_veto_replacements(monkeypatch):
    """A vetoed raw top-N name must never leak back into the BUY loop."""
    import ablation_flags
    import earnings_calendar
    import portfolio
    import research
    import utils

    returns = {"SPY": 10.0, "AAA": 30.0, "BBB": 25.0, "CCC": 20.0}

    def bars(symbol, *, days):
        start = 100.0
        end = start * (1 + returns[symbol] / 100)
        return pd.DataFrame({"close": [start] * 251 + [end]})

    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        execute_trades,
        "get_strategy_params",
        lambda *args, **kwargs: {
            "momentum_mode": True,
            "momentum_top_n": 2,
            "momentum_min_hold_days": 21,
            "block_new_buys": False,
            "max_position_pct": 10.0,
        },
    )
    monkeypatch.setattr(execute_trades, "load_json", lambda path: {})
    monkeypatch.setattr(research, "get_bars", bars)
    monkeypatch.setattr(
        research,
        "get_latest_quote",
        lambda symbol: {"ask": 100.0, "mid": 100.0},
    )
    monkeypatch.setattr(utils, "get_tradeable_symbols", lambda: ["AAA", "BBB", "CCC"])
    monkeypatch.setattr(portfolio, "get_positions", lambda: [])
    monkeypatch.setattr(
        portfolio,
        "get_account",
        lambda: {"equity": 100_000.0, "cash": 100_000.0},
    )
    monkeypatch.setattr(trade, "validate_order", lambda *args: {"valid": True})
    monkeypatch.setattr(ablation_flags, "ABLATE_EARNINGS_FILTER", False)
    monkeypatch.setattr(
        earnings_calendar,
        "has_earnings_risk",
        lambda symbol: symbol == "AAA",
    )

    result = execute_trades.manage_momentum_picks(
        dry_run=True, allow_new_exposure=True
    )

    buys = {
        item["symbol"]
        for item in result
        if item.get("action") == "DRY_RUN_MOMENTUM_BUY"
    }
    assert buys == {"BBB", "CCC"}
    assert "AAA" not in buys


def test_adaptive_live_planner_dry_run_only_previews_target_orders(monkeypatch):
    import adaptive_momentum
    import earnings_calendar
    import notify
    import portfolio
    import research
    import universe

    class Provider:
        @staticmethod
        def latest_date(symbol):
            return "2026-07-29"

        @staticmethod
        def bars_up_to(symbol, date, lookback_days=None):
            count = lookback_days or 253
            return pd.DataFrame({"close": [100.0] * count})

    market = adaptive_momentum.MarketState(
        as_of="2026-07-29",
        price=600.0,
        sma200=550.0,
        above_sma200=True,
        annual_volatility_pct=15.0,
    )
    plan = adaptive_momentum.TargetPortfolio(
        as_of="2026-07-29",
        weights={"AAA": 0.09},
        cash_weight=0.91,
        target_gross_weight=0.09,
        market_state=market,
        breadth_pct=60.0,
        eligible_count=20,
        diagnostics={"evaluated_count": 1},
    )
    params = {
        **strategy_config.get_strategy_params("BULL", "NORMAL"),
        "adaptive_momentum": True,
    }

    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(execute_trades, "load_json", lambda path: {})
    monkeypatch.setattr(execute_trades, "_adaptive_live_frames", lambda symbols: Provider())
    monkeypatch.setattr(
        execute_trades, "_live_sector_lookup", lambda provider, date: lambda symbol: "Technology"
    )
    monkeypatch.setattr(adaptive_momentum, "compute_market_state", lambda *a, **k: market)
    monkeypatch.setattr(adaptive_momentum, "build_target_portfolio", lambda *a, **k: plan)
    monkeypatch.setattr(earnings_calendar, "load_calendar", lambda: {"dates": {}})
    monkeypatch.setattr(earnings_calendar, "has_earnings_risk", lambda *a, **k: False)
    monkeypatch.setattr(universe, "load_universe_symbols", lambda **k: ["AAA"])
    monkeypatch.setattr(portfolio, "get_positions", lambda: [])
    monkeypatch.setattr(
        portfolio,
        "get_account",
        lambda: {"equity": 100_000.0, "cash": 100_000.0},
    )
    monkeypatch.setattr(
        research,
        "get_latest_quote",
        lambda symbol: {"ask": 100.0, "bid": 99.9, "mid": 99.95},
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade, "validate_order", lambda *a, **k: {"valid": True, "reasons": []}
    )
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("dry run placed order")),
    )
    monkeypatch.setattr(notify, "send_trade_alert", lambda *a, **k: None)

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=True,
        allow_new_exposure=True,
    )

    assert result[0]["action"] == "ADAPTIVE_PLAN"
    buys = [item for item in result if item.get("action") == "DRY_RUN_ADAPTIVE_BUY"]
    assert buys == [
        {
            "symbol": "AAA",
            "action": "DRY_RUN_ADAPTIVE_BUY",
            "qty": 90,
            "price": 100.0,
            "target_weight": 0.09,
        }
    ]


def test_adaptive_recovery_latch_allows_one_off_cycle_fresh_plan(monkeypatch):
    import adaptive_momentum
    import universe

    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    perf = {
        "last_momentum_rebal_ym": current_month,
        execute_trades.ADAPTIVE_RISK_OFF_LATCH_KEY: True,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    params = {
        **strategy_config.get_strategy_params("BULL", "NORMAL"),
        "momentum_risk_on_reentry_days": 1,
    }
    market = _adaptive_market(above_sma200=True)
    target = adaptive_momentum.TargetPortfolio(
        as_of="2026-07-29",
        weights={"AAA": 0.09},
        cash_weight=0.91,
        target_gross_weight=0.09,
        market_state=market,
        breadth_pct=60.0,
        eligible_count=20,
        diagnostics={"evaluated_count": 1},
    )
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(universe, "load_universe_symbols", lambda **kwargs: ["AAA"])
    monkeypatch.setattr(
        execute_trades,
        "_live_sector_lookup",
        lambda provider, signal_date: lambda symbol: "Technology",
    )
    monkeypatch.setattr(
        adaptive_momentum,
        "market_reentry_confirmed",
        lambda *args, **kwargs: True,
    )
    monkeypatch.setattr(
        adaptive_momentum,
        "build_target_portfolio",
        lambda *args, **kwargs: target,
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=True,
        allow_new_exposure=True,
    )

    assert result[0]["action"] == "ADAPTIVE_PLAN"
    assert any(item.get("action") == "DRY_RUN_ADAPTIVE_BUY" for item in result)


def test_malformed_adaptive_recovery_latch_blocks_new_exposure(monkeypatch):
    perf = {execute_trades.ADAPTIVE_RISK_OFF_LATCH_KEY: "yes"}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False,
        allow_new_exposure=True,
    )

    assert result == [
        {
            "action": "ABORT_INVALID_RISK_OFF_LATCH",
            "reason": "adaptive risk-off latch must be boolean",
        }
    ]


def test_malformed_adaptive_recovery_latch_does_not_block_halt_exit(monkeypatch):
    position = {
        "symbol": "AAA",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    perf = {execute_trades.ADAPTIVE_RISK_OFF_LATCH_KEY: "yes"}
    _patch_adaptive_runtime(
        monkeypatch,
        perf=perf,
        positions=[position],
        risk_tier="HALT",
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=True,
        allow_new_exposure=True,
    )

    assert any(
        item.get("action") == "DRY_RUN_ADAPTIVE_EXIT"
        and item.get("symbol") == "AAA"
        for item in result
    )
    assert not any(
        item.get("action") == "ABORT_INVALID_RISK_OFF_LATCH"
        for item in result
    )


def _daily_frame(*dates: str) -> pd.DataFrame:
    index = pd.to_datetime(list(dates), utc=True)
    return pd.DataFrame(
        {
            "open": [100.0] * len(index),
            "high": [101.0] * len(index),
            "low": [99.0] * len(index),
            "close": [100.0] * len(index),
            "volume": [1_000_000] * len(index),
        },
        index=index,
    )


def test_adaptive_live_frames_allows_stale_ranking_stock(monkeypatch):
    import research

    frames = {
        "SPY": _daily_frame("2026-07-28", "2026-07-29"),
        "XLK": _daily_frame("2026-07-28", "2026-07-29"),
        "AAA": _daily_frame("2026-07-28"),
    }
    monkeypatch.setattr(research, "get_bars_batch", lambda *a, **k: frames)

    provider = execute_trades._adaptive_live_frames(
        ["AAA", "SPY", "XLK"],
        minimum_auxiliary_bars=2,
        current_date="2026-07-30",
    )

    assert provider.latest_date("SPY") == "2026-07-29"
    assert provider.latest_date("XLK") == "2026-07-29"
    assert provider.latest_date("AAA") == "2026-07-28"


def test_adaptive_live_frames_rejects_stale_sector_auxiliary(monkeypatch):
    import research

    frames = {
        "SPY": _daily_frame("2026-07-28", "2026-07-29"),
        "XLK": _daily_frame("2026-07-28"),
        "AAA": _daily_frame("2026-07-29"),
    }
    monkeypatch.setattr(research, "get_bars_batch", lambda *a, **k: frames)

    with pytest.raises(
        research.BarCoverageError,
        match=r"stale versus SPY=2026-07-29: XLK=2026-07-28",
    ):
        execute_trades._adaptive_live_frames(
            ["AAA", "SPY", "XLK"],
            minimum_auxiliary_bars=2,
            current_date="2026-07-30",
        )


@pytest.mark.parametrize("short_symbol", ["SPY", "XLK"])
def test_adaptive_live_frames_rejects_short_signal_auxiliary_history(
    monkeypatch, short_symbol
):
    import research

    dates = [
        timestamp.strftime("%Y-%m-%d")
        for timestamp in pd.bdate_range(end="2026-07-29", periods=253)
    ]
    frames = {
        "SPY": _daily_frame(*dates),
        "XLK": _daily_frame(*dates),
    }
    frames[short_symbol] = _daily_frame(*dates[-252:])
    monkeypatch.setattr(research, "get_bars_batch", lambda *a, **k: frames)

    with pytest.raises(
        research.BarCoverageError,
        match=rf"required 253 bars.*{short_symbol}=252",
    ):
        execute_trades._adaptive_live_frames(
            ["SPY", "XLK"],
            current_date="2026-07-30",
        )


def test_adaptive_live_frames_rejects_globally_stale_auxiliary_snapshot(
    monkeypatch,
):
    import research

    dates = [
        timestamp.strftime("%Y-%m-%d")
        for timestamp in pd.bdate_range(end="2025-01-31", periods=253)
    ]
    frames = {
        "SPY": _daily_frame(*dates),
        "XLK": _daily_frame(*dates),
    }
    monkeypatch.setattr(research, "get_bars_batch", lambda *a, **k: frames)

    with pytest.raises(
        research.BarCoverageError,
        match="SPY completed-session bars are stale",
    ):
        execute_trades._adaptive_live_frames(
            ["SPY", "XLK"],
            current_date="2026-07-30",
        )


def test_held_ranking_stock_must_be_current_before_risk_on_rebalance():
    class Provider:
        @staticmethod
        def latest_date(symbol):
            return {
                "AAA": "2026-07-28",
                "BBB": "2026-07-28",
                "SPY": "2026-07-29",
            }.get(symbol)

    stale = execute_trades._stale_held_ranking_symbols(
        Provider(),
        held_symbols=["AAA", "EXIT_ONLY"],
        ranking_universe=["AAA", "BBB"],
        signal_date="2026-07-29",
    )

    # AAA is protected because it is both held and rankable.  BBB may simply
    # become ineligible, while EXIT_ONLY must remain sellable after delisting.
    assert stale == {"AAA": "2026-07-28"}


def _adaptive_market(*, above_sma200: bool = True):
    import adaptive_momentum

    return adaptive_momentum.MarketState(
        as_of="2026-07-29",
        price=600.0 if above_sma200 else 500.0,
        sma200=550.0,
        above_sma200=above_sma200,
        annual_volatility_pct=15.0,
    )


def _pending_plan(weights: dict[str, float], *, risk_off: bool = False) -> dict:
    return execute_trades._new_adaptive_pending_plan(
        rebalance_month=datetime.now(timezone.utc).strftime("%Y-%m"),
        signal_date="2026-07-01",
        target_weights=weights,
        sector_by_symbol={symbol: "Technology" for symbol in weights},
        risk_off=risk_off,
        eligible_count=len(weights),
        construction_risk_tier="NORMAL",
    )


def _patch_adaptive_runtime(
    monkeypatch,
    *,
    perf: dict,
    positions: list[dict] | None = None,
    risk_tier: str = "NORMAL",
    above_sma200: bool = True,
    account: dict | None = None,
) -> None:
    import adaptive_momentum
    import notify
    import portfolio
    import research

    class Provider:
        @staticmethod
        def latest_date(symbol):
            return "2026-07-29"

        @staticmethod
        def bars_up_to(symbol, date, lookback_days=None):
            count = lookback_days or 253
            return pd.DataFrame({"close": [100.0] * count})

    params = {
        **strategy_config.get_strategy_params("BULL", risk_tier),
        "adaptive_momentum": True,
    }
    market = _adaptive_market(above_sma200=above_sma200)
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: risk_tier)
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(execute_trades, "load_json", lambda path: perf)
    monkeypatch.setattr(
        execute_trades,
        "load_json_object_status",
        lambda path: (perf, None),
    )
    monkeypatch.setattr(execute_trades, "save_json", lambda path, value: None)
    monkeypatch.setattr(
        execute_trades,
        "_v11_validation_gate",
        lambda: {
            "passed": True,
            "status": "PASS",
            "allowed_mode": "paper-validation-eligible",
            "reason": "test validation pass",
        },
    )
    monkeypatch.setattr(execute_trades, "_adaptive_live_frames", lambda symbols: Provider())
    monkeypatch.setattr(
        adaptive_momentum, "compute_market_state", lambda *a, **k: market
    )
    monkeypatch.setattr(portfolio, "get_positions", lambda: list(positions or []))
    monkeypatch.setattr(
        portfolio,
        "get_account",
        lambda: account
        or {
            "equity": 100_000.0,
            "cash": 100_000.0,
            "last_equity": 100_000.0,
            "daily_pnl_pct": 0.0,
        },
    )
    monkeypatch.setattr(
        research,
        "get_latest_quote",
        lambda symbol: {"ask": 100.0, "bid": 99.9, "mid": 99.95},
    )
    monkeypatch.setattr(notify, "send_trade_alert", lambda *a, **k: None)
    monkeypatch.setattr(
        trade, "validate_order", lambda *a, **k: {"valid": True, "reasons": []}
    )


def _open_order(
    *,
    order_id: str,
    symbol: str,
    side: str,
    quantity: float,
    filled: float = 0.0,
    order_type: str = "limit",
    tif: str = "day",
    status: str = "accepted",
) -> dict:
    return {
        "id": order_id,
        "client_order_id": f"client-{order_id}",
        "symbol": symbol,
        "side": side,
        "type": order_type,
        "time_in_force": tif,
        "qty": quantity,
        "filled_qty": filled,
        "remaining_qty": quantity - filled,
        "limit_price": 100.0,
        "status": status,
    }


def _bind_open_order_to_plan(
    plan: dict,
    order: dict,
    *,
    target_weight: float,
) -> None:
    """Record a broker order exactly as the adaptive lifecycle would."""

    symbol = str(order["symbol"])
    side = str(order["side"])
    quantity = float(order["qty"])
    intent_key = execute_trades._adaptive_intent_key(
        plan,
        symbol,
        side,
        quantity,
        target_weight,
    )
    client_order_id = execute_trades._execution_client_order_id(
        "adaptive",
        symbol,
        side,
        execution_key=plan["plan_id"],
        intent=f"{intent_key}|attempt=1",
    )
    order["client_order_id"] = client_order_id
    plan["order_attempts"][intent_key] = {
        "attempt": 1,
        "client_order_id": client_order_id,
        "order_id": order["id"],
        "status": "submitted",
        "symbol": symbol,
        "side": side,
        "quantity": quantity,
        "target_weight": target_weight,
    }
    assert execute_trades._adaptive_pending_plan_structure_valid(plan)


def test_open_order_view_includes_reconciliation_fields(monkeypatch):
    order = SimpleNamespace(
        id="order-1",
        client_order_id="intent-1",
        symbol="AAPL",
        side=SimpleNamespace(value="sell"),
        type=SimpleNamespace(value="trailing_stop"),
        time_in_force=SimpleNamespace(value="gtc"),
        qty="10",
        filled_qty="3.5",
        limit_price=None,
        status=SimpleNamespace(value="partially_filled"),
    )
    broker = _ReadOnlyBroker(orders=[order])
    monkeypatch.setattr(trade, "_client", broker)

    result = trade.list_open_orders()

    assert result[0]["type"] == "trailing_stop"
    assert result[0]["client_order_id"] == "intent-1"
    assert result[0]["remaining_qty"] == 6.5
    assert result[0]["time_in_force"] == "gtc"


def test_close_position_preserves_fractional_quantity_and_reconciles_orders(
    monkeypatch,
):
    import research

    submitted = []

    class Broker:
        @staticmethod
        def get_open_position(symbol):
            return SimpleNamespace(qty="3.5")

        @staticmethod
        def get_orders(filter=None):
            return []

        @staticmethod
        def submit_order(request):
            submitted.append(request)
            return SimpleNamespace(
                id="fractional-close",
                symbol=request.symbol,
                side=request.side,
                qty=request.qty,
                limit_price=request.limit_price,
                status="accepted",
                created_at="2026-07-30T15:00:00Z",
            )

    monkeypatch.setattr(trade, "_client", Broker())
    monkeypatch.setattr(
        research,
        "get_latest_quote",
        lambda symbol: {"bid": 100.0, "mid": 100.0},
    )

    result = trade.close_position(
        "AAA", client_order_id="fractional-close-intent"
    )

    assert result["status"] == "submitted"
    assert float(submitted[0].qty) == 3.5
    assert submitted[0].client_order_id == "fractional-close-intent"
    assert result["side"] == "sell"


def test_close_short_position_submits_fractional_buy_to_cover_at_ask(monkeypatch):
    import research

    submitted = []

    class Broker:
        @staticmethod
        def get_open_position(symbol):
            return SimpleNamespace(qty="-3.5")

        @staticmethod
        def get_orders(filter=None):
            return []

        @staticmethod
        def submit_order(request):
            submitted.append(request)
            return SimpleNamespace(
                id="short-cover",
                symbol=request.symbol,
                side=request.side,
                qty=request.qty,
                limit_price=request.limit_price,
                status="accepted",
                created_at="2026-07-30T15:00:00Z",
            )

    monkeypatch.setattr(trade, "_client", Broker())
    monkeypatch.setattr(
        research,
        "get_latest_quote",
        lambda symbol: {"ask": 100.0, "bid": 99.0, "mid": 99.5},
    )

    result = trade.close_position(
        "AAA", client_order_id="short-cover-intent"
    )

    assert result == {
        "symbol": "AAA",
        "status": "submitted",
        "order_id": "short-cover",
        "side": "buy",
        "qty": 3.5,
        "price": 100.1,
    }
    assert float(submitted[0].qty) == 3.5
    assert str(submitted[0].side).lower() in {"buy", "orderside.buy"}
    assert float(submitted[0].limit_price) == 100.1
    assert submitted[0].client_order_id == "short-cover-intent"


def test_close_short_position_respects_pending_buy_cover(monkeypatch):
    submitted = []
    pending = SimpleNamespace(
        id="existing-cover",
        client_order_id="cover-intent",
        symbol="AAA",
        side="buy",
        type="limit",
        time_in_force="day",
        qty="3.5",
        filled_qty="1.0",
        limit_price="100.1",
        status="partially_filled",
    )

    class Broker:
        @staticmethod
        def get_open_position(symbol):
            return SimpleNamespace(qty="-2.5")

        @staticmethod
        def get_orders(filter=None):
            return [pending]

        @staticmethod
        def submit_order(request):
            submitted.append(request)
            raise AssertionError("duplicate cover submitted")

    monkeypatch.setattr(trade, "_client", Broker())

    result = trade.close_position("AAA")

    assert result["status"] == "pending"
    assert result["side"] == "buy"
    assert result["pending_qty"] == 2.5
    assert submitted == []


def test_portfolio_rejects_nonfinite_position_valuation(monkeypatch):
    import portfolio

    position = SimpleNamespace(
        symbol="AAA",
        qty="1",
        avg_entry_price="100",
        current_price="nan",
        market_value="100",
        unrealized_pl="0",
        unrealized_plpc="0",
        side="long",
    )
    monkeypatch.setattr(
        portfolio,
        "_client",
        SimpleNamespace(get_all_positions=lambda: [position]),
    )

    with pytest.raises(ValueError, match="non-finite values"):
        portfolio.get_positions()


@pytest.mark.parametrize(
    ("manager", "symbol"),
    [
        (execute_trades.manage_tqqq_position, "TQQQ"),
        (execute_trades.manage_upro_position, "UPRO"),
    ],
)
def test_failed_legacy_leverage_close_is_never_labelled_as_exit_success(
    monkeypatch, manager, symbol
):
    import portfolio

    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        execute_trades,
        "get_strategy_params",
        lambda *a: {"tqqq_pct": 0.0, "upro_pct": 0.0},
    )
    monkeypatch.setattr(portfolio, "get_account", lambda: {"equity": 100_000.0})
    monkeypatch.setattr(
        portfolio,
        "get_positions",
        lambda: [
            {
                "symbol": symbol,
                "qty": 10.5,
                "market_value": 1_000.0,
                "current_price": 100.0,
            }
        ],
    )
    monkeypatch.setattr(
        trade,
        "close_position",
        lambda *a, **k: {"symbol": symbol, "status": "error", "error": "rejected"},
    )

    result = manager(dry_run=False, allow_new_exposure=False)

    assert result == [{"symbol": symbol, "action": "ERROR", "reason": "rejected"}]


def test_adaptive_open_order_api_failure_is_fail_closed(monkeypatch):
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: _pending_plan({"AAA": 0.09})}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    mutations = []
    monkeypatch.setattr(
        trade, "list_open_orders", lambda: (_ for _ in ()).throw(RuntimeError("API down"))
    )
    monkeypatch.setattr(
        trade, "place_limit_order", lambda *a, **k: mutations.append("submit")
    )
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda *a, **k: mutations.append("cancel")
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert result[0]["action"] == "ABORT_OPEN_ORDER_RECONCILIATION"
    assert mutations == []


def test_performance_state_read_failure_cancels_open_buy(monkeypatch):
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: _pending_plan({"AAA": 0.09})}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    orphan_buy = _open_order(
        order_id="orphan-buy",
        symbol="BBB",
        side="buy",
        quantity=5,
    )
    snapshots = iter([[orphan_buy], []])
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(
        execute_trades,
        "load_json_object_status",
        lambda path: ({}, "PermissionError: state denied"),
    )
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("BUY submitted")),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert cancelled == ["orphan-buy"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"


def test_wrong_type_performance_state_blocks_new_exposure(monkeypatch, tmp_path):
    import utils

    _patch_adaptive_runtime(monkeypatch, perf={})
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    invalid_state = tmp_path / "performance.json"
    invalid_state.write_text('["not", "object"]')
    monkeypatch.setattr(execute_trades, "PERFORMANCE_STATE", invalid_state)
    monkeypatch.setattr(
        execute_trades,
        "load_json_object_status",
        utils.load_json_object_status,
    )
    submissions = []
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: submissions.append((a, k)),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert result[0]["action"] == "ADAPTIVE_PLAN_DEFERRED"
    assert submissions == []


def test_pending_short_cover_precedes_unreadable_performance_state(monkeypatch):
    short = {
        "symbol": "AAA",
        "qty": -3.0,
        "current_price": 100.0,
        "market_value": -300.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf={}, positions=[short])
    cover = _open_order(
        order_id="cover",
        symbol="AAA",
        side="buy",
        quantity=3,
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [cover])
    monkeypatch.setattr(
        execute_trades,
        "load_json_object_status",
        lambda path: ({}, "PermissionError: state denied"),
    )
    cancelled = []
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert result[0]["action"] == "SHORT_COVER_PENDING"
    assert result[0]["order_id"] == "cover"
    assert cancelled == []


def test_direct_adaptive_short_position_only_previews_cover(monkeypatch):
    short = {
        "symbol": "AAA",
        "qty": -2.5,
        "current_price": 100.0,
        "market_value": -250.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf={}, positions=[short])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    submissions = []
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: submissions.append((a, k)),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=True, allow_new_exposure=True
    )

    assert result == [
        {
            "symbol": "AAA",
            "action": "DRY_RUN_SHORT_COVER",
            "side": "buy",
            "qty": 2.5,
            "reason": "all shorts must be flat before V11 trading",
        }
    ]
    assert submissions == []


def test_short_preflight_cancels_conflicting_orders_before_cover(monkeypatch):
    positions = [{"symbol": "AAA", "qty": -4.0}]
    short_sell = _open_order(
        order_id="deepen-short",
        symbol="AAA",
        side="sell",
        quantity=1,
    )
    unrelated_buy = _open_order(
        order_id="new-long",
        symbol="BBB",
        side="buy",
        quantity=1,
    )
    cancelled = []
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade,
        "close_position",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("cover submitted in cancellation invocation")
        ),
    )

    result = execute_trades._reconcile_v11_short_positions(
        dry_run=False,
        positions_snapshot=positions,
        open_orders_snapshot=[short_sell, unrelated_buy],
    )

    assert cancelled == ["deepen-short", "new-long"]
    assert result[-1]["action"] == (
        "SELL_CAPACITY_RECONCILIATION_PENDING_CANCELLATIONS"
    )


@pytest.mark.parametrize(
    "terminal_status",
    ["expired", "done_for_day", "replaced"],
)
def test_terminal_short_cover_advances_to_a_new_retry_id(
    monkeypatch, terminal_status
):
    queried = []

    def resolve(client_order_id):
        queried.append(client_order_id)
        return {"status": terminal_status} if len(queried) == 1 else None

    monkeypatch.setattr(trade, "get_order_by_client_order_id", resolve)
    submitted_ids = []
    monkeypatch.setattr(
        trade,
        "close_position",
        lambda symbol, *, client_order_id: submitted_ids.append(client_order_id)
        or {
            "symbol": symbol,
            "status": "submitted",
            "order_id": "retry-cover",
            "side": "buy",
            "qty": 4,
            "price": 100.0,
        },
    )

    result = execute_trades._reconcile_v11_short_positions(
        dry_run=False,
        positions_snapshot=[{"symbol": "AAA", "qty": -4.0}],
        open_orders_snapshot=[],
    )

    assert len(queried) == 2
    assert queried[0] != queried[1]
    assert submitted_ids == [queried[1]]
    assert result[0]["action"] == "SHORT_COVER_SUBMITTED"


def test_invalid_position_snapshot_cancels_known_buy_before_abort(monkeypatch):
    working_buy = _open_order(
        order_id="buy-on-invalid-position",
        symbol="BBB",
        side="buy",
        quantity=3,
    )
    working_sell = _open_order(
        order_id="sell-on-invalid-position",
        symbol="CCC",
        side="sell",
        quantity=2,
    )
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )

    result = execute_trades._reconcile_v11_short_positions(
        dry_run=False,
        positions_snapshot=[{"symbol": "AAA", "qty": float("nan")}],
        open_orders_snapshot=[working_buy, working_sell],
    )

    assert cancelled == [
        "buy-on-invalid-position",
        "sell-on-invalid-position",
    ]
    assert result[-1]["action"] == (
        "POSITION_SNAPSHOT_RECONCILIATION_PENDING_CANCELLATIONS"
    )


def test_aggregate_sell_above_long_capacity_is_cancelled_before_managers(
    monkeypatch,
):
    first = _open_order(
        order_id="sell-one",
        symbol="AAA",
        side="sell",
        quantity=3,
    )
    second = _open_order(
        order_id="sell-two",
        symbol="AAA",
        side="sell",
        quantity=3,
    )
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )

    result = execute_trades._reconcile_v11_short_positions(
        dry_run=False,
        positions_snapshot=[{"symbol": "AAA", "qty": 5.0}],
        open_orders_snapshot=[first, second],
    )

    assert cancelled == ["sell-one", "sell-two"]
    assert result[-1]["action"] == (
        "SELL_CAPACITY_RECONCILIATION_PENDING_CANCELLATIONS"
    )


def test_sell_within_long_capacity_remains_open(monkeypatch):
    sell = _open_order(
        order_id="bounded-sell",
        symbol="AAA",
        side="sell",
        quantity=5,
    )
    monkeypatch.setattr(
        trade,
        "cancel_open_order",
        lambda order_id: (_ for _ in ()).throw(
            AssertionError("bounded risk-reducing SELL was cancelled")
        ),
    )

    assert execute_trades._reconcile_v11_short_positions(
        dry_run=False,
        positions_snapshot=[{"symbol": "AAA", "qty": 5.0}],
        open_orders_snapshot=[sell],
    ) == []


def test_unreadable_order_book_requests_fail_closed_cancel_all(monkeypatch):
    cancelled_all = []
    monkeypatch.setattr(
        trade,
        "list_open_orders",
        lambda: (_ for _ in ()).throw(ValueError("invalid broker quantity")),
    )
    monkeypatch.setattr(
        trade, "cancel_all_orders", lambda: cancelled_all.append(True) or 0
    )

    result = execute_trades._reconcile_v11_short_positions(
        dry_run=False,
        positions_snapshot=[],
    )

    assert cancelled_all == [True]
    assert result[0]["action"] == "CANCEL_ALL_ORDERS_REQUESTED"


@pytest.mark.parametrize(
    ("quantity", "filled"),
    [(float("nan"), 0.0), (1.0, float("inf")), (1.0, 2.0), (-1.0, 0.0)],
)
def test_order_lifecycle_rejects_invalid_quantities(quantity, filled):
    order = SimpleNamespace(
        id="invalid-order",
        client_order_id="invalid-client",
        symbol="AAA",
        side="buy",
        type="limit",
        time_in_force="day",
        qty=quantity,
        filled_qty=filled,
        limit_price=100.0,
        status="accepted",
    )

    with pytest.raises(ValueError, match="invalid quantity lifecycle"):
        trade._order_lifecycle_view(order)


def test_valid_bound_buy_survives_early_v11_preflight(monkeypatch):
    import adaptive_momentum

    frozen = _pending_plan({"AAA": 0.09})
    pending = _open_order(
        order_id="bound-buy",
        symbol="AAA",
        side="buy",
        quantity=90,
    )
    _bind_open_order_to_plan(frozen, pending, target_weight=0.09)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [pending])
    monkeypatch.setattr(
        execute_trades,
        "load_json_object_status",
        lambda path: ({execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}, None),
    )
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(
        adaptive_momentum,
        "compute_market_state",
        lambda *args, **kwargs: _adaptive_market(above_sma200=True),
    )
    monkeypatch.setattr(
        execute_trades,
        "_adaptive_live_frames",
        lambda symbols: SimpleNamespace(latest_date=lambda symbol: "2026-07-29"),
    )

    assert execute_trades._reconcile_v11_open_buys_preflight(
        dry_run=False,
        allow_new_exposure=True,
    ) == []


@pytest.mark.parametrize("failure_point", ["positions", "spy"])
def test_reconciliation_failure_cancels_open_buy_before_return(
    monkeypatch, failure_point
):
    import portfolio

    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: _pending_plan({"AAA": 0.09})}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    pending_buy = _open_order(
        order_id="buy-risk",
        symbol="AAA",
        side="buy",
        quantity=90,
    )
    snapshots = iter([[pending_buy], []])
    cancelled = []
    submitted = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *args, **kwargs: submitted.append((args, kwargs)),
    )
    if failure_point == "positions":
        monkeypatch.setattr(
            portfolio,
            "get_positions",
            lambda: (_ for _ in ()).throw(RuntimeError("positions API down")),
        )
    else:
        monkeypatch.setattr(
            execute_trades,
            "_adaptive_live_frames",
            lambda symbols: (_ for _ in ()).throw(RuntimeError("SPY API down")),
        )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert cancelled == ["buy-risk"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"
    assert result[-1]["remaining_order_ids"] == []
    assert submitted == []


@pytest.mark.parametrize("plan_state", ["missing", "malformed"])
def test_risk_on_cancels_buy_not_bound_to_a_valid_current_plan(
    monkeypatch, plan_state
):
    perf = (
        {}
        if plan_state == "missing"
        else {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: {"schema_version": 2}}
    )
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    orphan = _open_order(
        order_id=f"orphan-{plan_state}",
        symbol="AAA",
        side="buy",
        quantity=90,
    )
    snapshots = iter([[orphan], []])
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert cancelled == [f"orphan-{plan_state}"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"
    assert "not bound" in result[0]["reason"]


@pytest.mark.parametrize(
    ("account", "error"),
    [
        (RuntimeError("account API down"), "account unavailable"),
        ({"equity": float("nan"), "cash": 100_000.0}, "invalid account equity"),
        ({"equity": 100_000.0, "cash": float("nan")}, "invalid account cash"),
    ],
    ids=["api", "equity", "cash"],
)
def test_account_failure_cancels_even_a_bound_open_buy(
    monkeypatch, account, error
):
    import portfolio

    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    pending = _open_order(
        order_id="bound-buy",
        symbol="AAA",
        side="buy",
        quantity=90,
    )
    _bind_open_order_to_plan(frozen, pending, target_weight=0.09)
    snapshots = iter([[pending], []])
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    if isinstance(account, Exception):
        monkeypatch.setattr(
            portfolio,
            "get_account",
            lambda: (_ for _ in ()).throw(account),
        )
    else:
        monkeypatch.setattr(portfolio, "get_account", lambda: account)

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert cancelled == ["bound-buy"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"
    assert error in result[0]["reason"]


@pytest.mark.parametrize(
    "symbol", sorted(execute_trades.V11_INFRASTRUCTURE_SYMBOLS)
)
def test_zero_target_infrastructure_buy_is_cancelled(monkeypatch, symbol):
    infrastructure_buy = _open_order(
        order_id=f"buy-{symbol}",
        symbol=symbol,
        side="buy",
        quantity=1,
    )
    regular_buy = _open_order(
        order_id="buy-AAA",
        symbol="AAA",
        side="buy",
        quantity=1,
    )
    snapshots = iter([[infrastructure_buy, regular_buy], [regular_buy]])
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )

    result = execute_trades._cancel_v11_infrastructure_buys(dry_run=False)

    assert cancelled == [f"buy-{symbol}"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"
    assert result[-1]["remaining_order_ids"] == []


def test_legacy_trailing_stop_is_cancelled_then_waits_before_target_sell(
    monkeypatch,
):
    position = {
        "symbol": "AAA",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: _pending_plan({})}
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    trailing = _open_order(
        order_id="trail-1",
        symbol="AAA",
        side="sell",
        quantity=10,
        order_type="trailing_stop",
        tif="gtc",
    )
    snapshots = iter([[trailing], []])
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("sell raced cancel")),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert cancelled == ["trail-1"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"
    assert result[-1]["remaining_order_ids"] == []


def test_partial_pending_sell_only_subtracts_remaining_quantity(monkeypatch):
    position = {
        "symbol": "AAA",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: _pending_plan({})}
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    pending = _open_order(
        order_id="sell-1",
        symbol="AAA",
        side="sell",
        quantity=7,
        filled=3,
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [pending])

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=True, allow_new_exposure=True
    )

    preview = next(item for item in result if item["action"] == "DRY_RUN_ADAPTIVE_EXIT")
    assert preview["qty"] == 6
    pending_result = next(item for item in result if item["action"] == "PENDING_SELL")
    assert pending_result["remaining_qty"] == 4


def test_pending_plan_freezes_signal_and_completes_only_from_filled_positions(
    monkeypatch,
):
    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    position = {
        "symbol": "AAA",
        "qty": 90.0,
        "current_price": 100.0,
        "market_value": 9_000.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("already converged")),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert result[0]["signal_date"] == "2026-07-01"
    assert result[-1]["action"] == "ADAPTIVE_REBALANCE_COMPLETE"
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY not in perf
    assert perf["last_momentum_targets"] == {"AAA": 0.09}


def test_closed_entry_gate_does_not_persist_an_unbuyable_risk_on_plan(monkeypatch):
    perf = {}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=False
    )

    assert result[0]["action"] == "ADAPTIVE_PLAN_DEFERRED"
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY not in perf


@pytest.mark.parametrize("stale_reason", ["prior_month", "old_identity"])
def test_stale_plan_is_discarded_and_current_signal_is_replanned(
    monkeypatch, stale_reason
):
    import adaptive_momentum
    import universe

    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    previous_month = (
        datetime.now(timezone.utc).replace(day=1) - timedelta(days=1)
    ).strftime("%Y-%m")
    old_plan = execute_trades._new_adaptive_pending_plan(
        rebalance_month=(previous_month if stale_reason == "prior_month" else current_month),
        signal_date="2026-06-30",
        target_weights={"AAA": 0.09},
        sector_by_symbol={"AAA": "Technology"},
        risk_off=False,
        eligible_count=10,
        construction_risk_tier="NORMAL",
    )
    if stale_reason == "old_identity":
        old_plan["strategy_identity_value"] = "0" * 64
        old_plan["plan_id"] = execute_trades._adaptive_plan_id(
            old_plan["rebalance_month"],
            old_plan["signal_date"],
            old_plan["target_weights"],
            sector_by_symbol=old_plan["sector_by_symbol"],
            risk_off=False,
            construction_risk_tier=old_plan["construction_risk_tier"],
            eligible_count=old_plan["eligible_count"],
            strategy_identity_value=old_plan["strategy_identity_value"],
            ranking_universe_sha256=old_plan["ranking_universe_sha256"],
        )
        assert execute_trades._adaptive_pending_plan_structure_valid(old_plan)
        assert not execute_trades._valid_adaptive_pending_plan(old_plan)
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: old_plan}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(universe, "load_universe_symbols", lambda **kwargs: ["BBB"])
    monkeypatch.setattr(
        execute_trades,
        "_live_sector_lookup",
        lambda provider, signal_date: lambda symbol: "Technology",
    )
    new_target = adaptive_momentum.TargetPortfolio(
        as_of="2026-07-29",
        weights={"BBB": 0.09},
        cash_weight=0.91,
        target_gross_weight=0.09,
        market_state=_adaptive_market(),
        breadth_pct=60.0,
        eligible_count=10,
        diagnostics={"evaluated_count": 1},
    )
    monkeypatch.setattr(
        adaptive_momentum, "build_target_portfolio", lambda *a, **k: new_target
    )
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": True, "reason": "open and fresh"},
    )
    submitted = []

    def submit(symbol, qty, side, price, **kwargs):
        submitted.append((symbol, side))
        return {"id": f"order-{symbol}"}

    monkeypatch.setattr(trade, "place_limit_order", submit)

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert submitted == [("BBB", "buy")]
    assert not any(item.get("symbol") == "AAA" for item in result)
    assert result[0]["signal_date"] == "2026-07-29"
    assert perf[execute_trades.ADAPTIVE_PENDING_PLAN_KEY]["target_weights"] == {
        "BBB": 0.09
    }


@pytest.mark.parametrize("stale_reason", ["prior_month", "old_identity"])
def test_unfinished_risk_off_plan_survives_recovery_and_closed_gate(
    monkeypatch, stale_reason
):
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    previous_month = (
        datetime.now(timezone.utc).replace(day=1) - timedelta(days=1)
    ).strftime("%Y-%m")
    exit_plan = execute_trades._new_adaptive_pending_plan(
        rebalance_month=(
            previous_month if stale_reason == "prior_month" else current_month
        ),
        signal_date="2026-06-30",
        target_weights={},
        sector_by_symbol={},
        risk_off=True,
        eligible_count=0,
        construction_risk_tier="HALT",
    )
    if stale_reason == "old_identity":
        exit_plan["strategy_identity_value"] = "0" * 64
        exit_plan["plan_id"] = execute_trades._adaptive_plan_id(
            exit_plan["rebalance_month"],
            exit_plan["signal_date"],
            exit_plan["target_weights"],
            sector_by_symbol=exit_plan["sector_by_symbol"],
            risk_off=True,
            construction_risk_tier=exit_plan["construction_risk_tier"],
            eligible_count=exit_plan["eligible_count"],
            strategy_identity_value=exit_plan["strategy_identity_value"],
            ranking_universe_sha256=exit_plan["ranking_universe_sha256"],
        )
    assert execute_trades._adaptive_pending_plan_structure_valid(exit_plan)

    position = {
        "symbol": "AAA",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    perf = {
        execute_trades.ADAPTIVE_PENDING_PLAN_KEY: exit_plan,
        execute_trades.ADAPTIVE_RISK_OFF_LATCH_KEY: True,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    submissions = []

    def submit(symbol, qty, side, price, **kwargs):
        submissions.append((symbol, side, qty))
        return {"id": f"order-{symbol}"}

    monkeypatch.setattr(trade, "place_limit_order", submit)

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False,
        allow_new_exposure=False,
    )

    assert submissions == [("AAA", "sell", 10.0)]
    assert any(item.get("action") == "ADAPTIVE_EXIT" for item in result)
    assert not any(item.get("action") == "ADAPTIVE_PLAN_DEFERRED" for item in result)
    assert perf[execute_trades.ADAPTIVE_PENDING_PLAN_KEY]["risk_off"] is True
    assert perf[execute_trades.ADAPTIVE_RISK_OFF_LATCH_KEY] is True


def test_legacy_risk_off_plan_is_migrated_and_converged_after_recovery(
    monkeypatch,
):
    legacy_exit_plan = _pending_plan({}, risk_off=True)
    legacy_exit_plan["schema_version"] = 2
    position = {
        "symbol": "AAA",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    perf = {
        execute_trades.ADAPTIVE_PENDING_PLAN_KEY: legacy_exit_plan,
        execute_trades.ADAPTIVE_RISK_OFF_LATCH_KEY: True,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    submissions = []

    def submit(symbol, qty, side, price, **kwargs):
        submissions.append((symbol, side, qty))
        return {"id": f"order-{symbol}"}

    monkeypatch.setattr(trade, "place_limit_order", submit)

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False,
        allow_new_exposure=False,
    )

    assert submissions == [("AAA", "sell", 10.0)]
    assert any(item.get("action") == "ADAPTIVE_EXIT" for item in result)
    migrated = perf[execute_trades.ADAPTIVE_PENDING_PLAN_KEY]
    assert migrated["schema_version"] == 3
    assert migrated["risk_off"] is True
    assert migrated["target_weights"] == {}


def test_prior_month_pending_buy_is_cancelled_before_replanning(monkeypatch):
    previous_month = (
        datetime.now(timezone.utc).replace(day=1) - timedelta(days=1)
    ).strftime("%Y-%m")
    old_plan = execute_trades._new_adaptive_pending_plan(
        rebalance_month=previous_month,
        signal_date="2026-06-30",
        target_weights={"AAA": 0.09},
        sector_by_symbol={"AAA": "Technology"},
        risk_off=False,
        eligible_count=10,
        construction_risk_tier="NORMAL",
    )
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: old_plan}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    pending_buy = _open_order(
        order_id="old-buy",
        symbol="AAA",
        side="buy",
        quantity=90,
    )
    snapshots = iter([[pending_buy], []])
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("old plan bought")),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert cancelled == ["old-buy"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"


def test_pending_normal_plan_replans_at_cautious_size_before_any_buy(monkeypatch):
    import adaptive_momentum

    old_plan = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: old_plan}
    _patch_adaptive_runtime(monkeypatch, perf=perf, risk_tier="CAUTIOUS")
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        adaptive_momentum,
        "build_target_portfolio",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("CAUTIOUS must not rerank a frozen plan")
        ),
    )
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": True, "reason": "open and fresh"},
    )
    submitted_qty = []

    def submit(symbol, qty, side, price, **kwargs):
        submitted_qty.append(qty)
        return {"id": "cautious-buy"}

    monkeypatch.setattr(trade, "place_limit_order", submit)

    execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert submitted_qty == [45]
    assert perf[execute_trades.ADAPTIVE_PENDING_PLAN_KEY][
        "construction_risk_tier"
    ] == "CAUTIOUS"


def test_held_only_symbol_is_exit_visible_but_never_in_ranking(monkeypatch):
    import adaptive_momentum
    import universe

    perf = {}
    held_only = {
        "symbol": "ARKK",
        "qty": 10.0,
        "current_price": 50.0,
        "market_value": 500.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[held_only])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    universe_calls = []

    def ranking_universe(**kwargs):
        universe_calls.append(kwargs)
        return ["AAA"]

    monkeypatch.setattr(universe, "load_universe_symbols", ranking_universe)
    monkeypatch.setattr(
        execute_trades,
        "_live_sector_lookup",
        lambda provider, signal_date: lambda symbol: "Technology",
    )
    target = adaptive_momentum.TargetPortfolio(
        as_of="2026-07-29",
        weights={"AAA": 0.09},
        cash_weight=0.91,
        target_gross_weight=0.09,
        market_state=_adaptive_market(),
        breadth_pct=60.0,
        eligible_count=1,
        diagnostics={"evaluated_count": 1},
    )

    def build(provider, candidates, *args, **kwargs):
        assert candidates == ["AAA"]
        return target

    monkeypatch.setattr(adaptive_momentum, "build_target_portfolio", build)

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=True, allow_new_exposure=True
    )

    assert universe_calls
    assert all(call == {"held_symbols": []} for call in universe_calls)
    assert any(
        item.get("symbol") == "ARKK"
        and item["action"] == "DRY_RUN_ADAPTIVE_EXIT"
        for item in result
    )
    assert any(
        item.get("symbol") == "AAA"
        and item["action"] == "DRY_RUN_ADAPTIVE_BUY"
        for item in result
    )


def test_current_held_ranking_symbol_with_short_history_aborts_plan(monkeypatch):
    import adaptive_momentum
    import universe

    perf = {}
    held = {
        "symbol": "AAA",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[held])

    class Provider:
        @staticmethod
        def latest_date(symbol):
            return "2026-07-29"

        @staticmethod
        def bars_up_to(symbol, date, lookback_days=None):
            count = 252 if symbol == "AAA" else (lookback_days or 253)
            return pd.DataFrame({"close": [100.0] * count})

    monkeypatch.setattr(execute_trades, "_adaptive_live_frames", lambda symbols: Provider())
    monkeypatch.setattr(universe, "load_universe_symbols", lambda **kwargs: ["AAA"])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        adaptive_momentum,
        "build_target_portfolio",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("short held history reached portfolio construction")
        ),
    )
    submitted = []
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *args, **kwargs: submitted.append((args, kwargs)),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert result[0]["action"] == "ABORT"
    assert "AAA=bars=252<253" in result[0]["reason"]
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY not in perf
    assert submitted == []


def test_missing_broad_market_state_does_not_persist_plan_or_start_exit(
    monkeypatch,
):
    import adaptive_momentum
    import universe

    perf = {}
    held = {
        "symbol": "AAA",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[held])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(universe, "load_universe_symbols", lambda **kwargs: ["AAA"])
    monkeypatch.setattr(
        execute_trades,
        "_live_sector_lookup",
        lambda provider, signal_date: lambda symbol: "Technology",
    )
    target_without_market = adaptive_momentum.TargetPortfolio(
        as_of="2026-07-29",
        weights={},
        cash_weight=1.0,
        target_gross_weight=0.0,
        market_state=None,
        breadth_pct=None,
        eligible_count=0,
        diagnostics={"evaluated_count": 1},
    )
    monkeypatch.setattr(
        adaptive_momentum,
        "build_target_portfolio",
        lambda *args, **kwargs: target_without_market,
    )
    saves = []
    submitted = []
    monkeypatch.setattr(
        execute_trades,
        "save_json",
        lambda path, value: saves.append((path, value)),
    )
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *args, **kwargs: submitted.append((args, kwargs)),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert result == [
        {
            "action": "ABORT",
            "reason": "broad snapshot cannot compute SPY market state",
        }
    ]
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY not in perf
    assert saves == []
    assert submitted == []


def test_rejected_buy_keeps_pending_plan_and_never_marks_month_complete(monkeypatch):
    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade,
        "validate_order",
        lambda *a, **k: {"valid": False, "reasons": ["risk cap"]},
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert any(item["action"] == "REJECTED" for item in result)
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY in perf
    assert "last_momentum_rebal_ym" not in perf


def test_adaptive_buy_rechecks_fresh_market_clock_after_planning(monkeypatch):
    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": False, "reason": "market closed during planning"},
    )
    submissions = []
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: submissions.append((a, k)),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    blocked = next(item for item in result if item["action"] == "ENTRY_GATE_BLOCKED")
    assert blocked["symbol"] == "AAA"
    assert "closed during planning" in blocked["reason"]
    assert submissions == []
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY in perf


def test_adaptive_buy_rechecks_validation_at_final_order_boundary(monkeypatch):
    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    _patch_adaptive_runtime(monkeypatch, perf=perf)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        execute_trades,
        "_v11_validation_gate",
        lambda: {
            "passed": False,
            "status": "FAIL",
            "allowed_mode": "dry-run/shadow-research-only",
            "reason": "artifact changed during planning",
        },
    )
    submissions = []
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: submissions.append((a, k)),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    blocked = next(
        item for item in result if item["action"] == "VALIDATION_GATE_BLOCKED"
    )
    assert blocked["symbol"] == "AAA"
    assert "changed during planning" in blocked["reason"]
    assert submissions == []
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY in perf


def test_failed_adaptive_sell_blocks_buy_leg(monkeypatch):
    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    position = {
        "symbol": "BBB",
        "qty": 10.0,
        "current_price": 100.0,
        "market_value": 1_000.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    submitted_sides = []

    def submit(symbol, qty, side, price, **kwargs):
        submitted_sides.append(side)
        if side == "sell":
            raise RuntimeError("sell rejected by broker")
        raise AssertionError("buy leg ran after failed sell")

    monkeypatch.setattr(trade, "place_limit_order", submit)

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert submitted_sides == ["sell"]
    assert any(item["action"] == "ERROR" for item in result)
    assert any(item["action"] == "REBALANCE_PENDING_SELLS" for item in result)


def test_pending_buy_for_symbol_blocks_adaptive_sell(monkeypatch):
    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    position = {
        "symbol": "AAA",
        "qty": 100.0,
        "current_price": 100.0,
        "market_value": 10_000.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    pending_buy = _open_order(
        order_id="buy-AAA",
        symbol="AAA",
        side="buy",
        quantity=1,
    )
    _bind_open_order_to_plan(frozen, pending_buy, target_weight=0.09)
    submitted = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: [pending_buy])
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *args, **kwargs: submitted.append((args, kwargs)),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    blocked = next(
        item for item in result if item["action"] == "PENDING_BUY_BLOCKS_SELL"
    )
    assert blocked == {
        "symbol": "AAA",
        "action": "PENDING_BUY_BLOCKS_SELL",
        "remaining_qty": 1.0,
    }
    assert not any(
        item["action"] in {"ADAPTIVE_EXIT", "ADAPTIVE_TRIM"} for item in result
    )
    assert submitted == []


def test_open_order_prevents_completion_until_fill_is_observed(monkeypatch):
    frozen = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: frozen}
    position = {
        "symbol": "AAA",
        "qty": 90.0,
        "current_price": 100.0,
        "market_value": 9_000.0,
    }
    _patch_adaptive_runtime(monkeypatch, perf=perf, positions=[position])
    pending = _open_order(
        order_id="buy-pending",
        symbol="AAA",
        side="buy",
        quantity=1,
    )
    _bind_open_order_to_plan(frozen, pending, target_weight=0.09)
    monkeypatch.setattr(trade, "list_open_orders", lambda: [pending])

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=True
    )

    assert not any(
        item["action"] == "ADAPTIVE_REBALANCE_COMPLETE" for item in result
    )
    assert execute_trades.ADAPTIVE_PENDING_PLAN_KEY in perf


def test_halt_cancels_pending_directional_buy_before_zero_target_exit(monkeypatch):
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: _pending_plan({"AAA": 0.09})}
    _patch_adaptive_runtime(monkeypatch, perf=perf, risk_tier="HALT")
    pending_buy = _open_order(
        order_id="buy-1",
        symbol="AAA",
        side="buy",
        quantity=90,
    )
    snapshots = iter([[pending_buy], []])
    cancelled = []
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(
        trade,
        "place_limit_order",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("submitted in HALT")),
    )

    result = execute_trades._manage_adaptive_momentum_picks(
        dry_run=False, allow_new_exposure=False
    )

    assert cancelled == ["buy-1"]
    assert result[-1]["action"] == "REBALANCE_PENDING_CANCELLATIONS"
    assert perf[execute_trades.ADAPTIVE_RISK_OFF_LATCH_KEY] is True
    assert perf[execute_trades.ADAPTIVE_PENDING_PLAN_KEY]["risk_off"] is True
    assert perf[execute_trades.ADAPTIVE_PENDING_PLAN_KEY]["target_weights"] == {}


def test_adaptive_client_ids_are_unique_per_intent_and_retry_deterministic():
    same = execute_trades._execution_client_order_id(
        "adaptive", "AAA", "sell", "plan-1", intent="qty=5|attempt=1"
    )
    retry = execute_trades._execution_client_order_id(
        "adaptive", "AAA", "sell", "plan-1", intent="qty=5|attempt=1"
    )
    changed_qty = execute_trades._execution_client_order_id(
        "adaptive", "AAA", "sell", "plan-1", intent="qty=6|attempt=1"
    )
    changed_attempt = execute_trades._execution_client_order_id(
        "adaptive", "AAA", "sell", "plan-1", intent="qty=5|attempt=2"
    )

    assert same == retry
    assert len({same, changed_qty, changed_attempt}) == 3


@pytest.mark.parametrize(
    "active_status", ["accepted", "suspended", "calculated"]
)
def test_terminal_order_advances_attempt_but_active_order_blocks_retry(
    monkeypatch, active_status
):
    pending = _pending_plan({"AAA": 0.09})
    perf = {execute_trades.ADAPTIVE_PENDING_PLAN_KEY: pending}
    saved = []
    monkeypatch.setattr(execute_trades, "save_json", lambda path, value: saved.append(value))
    first_id, status = execute_trades._reserve_adaptive_client_order_id(
        perf,
        pending,
        symbol="AAA",
        side="buy",
        quantity=90,
        target_weight=0.09,
    )
    assert status == "READY"
    monkeypatch.setattr(
        trade,
        "get_order_by_client_order_id",
        lambda client_id: {"status": "expired"},
    )
    second_id, status = execute_trades._reserve_adaptive_client_order_id(
        perf,
        pending,
        symbol="AAA",
        side="buy",
        quantity=90,
        target_weight=0.09,
    )
    assert status == "READY"
    assert first_id != second_id
    monkeypatch.setattr(
        trade,
        "get_order_by_client_order_id",
        lambda client_id: {"status": active_status},
    )
    blocked_id, status = execute_trades._reserve_adaptive_client_order_id(
        perf,
        pending,
        symbol="AAA",
        side="buy",
        quantity=90,
        target_weight=0.09,
    )
    assert blocked_id is None
    assert status == "PENDING_ORDER"


def test_pending_plan_validation_rejects_nonfinite_or_tampered_weights():
    nonfinite = _pending_plan({"AAA": 0.09})
    nonfinite["target_weights"]["AAA"] = float("inf")
    tampered = _pending_plan({"AAA": 0.09})
    tampered["target_weights"]["AAA"] = 0.08

    assert execute_trades._valid_adaptive_pending_plan(nonfinite) is False
    assert execute_trades._valid_adaptive_pending_plan(tampered) is False


@pytest.mark.parametrize(
    ("field", "tampered_value"),
    [
        ("sector_by_symbol", {"AAA": "Healthcare"}),
        ("sector_by_symbol", {}),
        ("construction_risk_tier", "CAUTIOUS"),
        ("eligible_count", 999),
    ],
)
def test_pending_plan_id_binds_execution_metadata(field, tampered_value):
    plan = _pending_plan({"AAA": 0.09})
    plan[field] = tampered_value

    assert execute_trades._adaptive_pending_plan_structure_valid(plan) is False


def test_fresh_risk_snapshot_overrides_stale_normal_with_same_run_halt(
    monkeypatch,
):
    import notify
    import portfolio

    perf = {"risk_tier": "NORMAL", "daily_history": [{"equity": 100_000.0}]}
    monkeypatch.setattr(execute_trades, "load_json", lambda path: perf)
    monkeypatch.setattr(
        portfolio,
        "get_account",
        lambda: {
            "equity": 92_000.0,
            "last_equity": 100_000.0,
            "daily_pnl_pct": -8.0,
        },
    )
    monkeypatch.setattr(
        portfolio,
        "get_recent_equity_history",
        lambda max_observations=22: [100_000.0],
    )

    snapshot = execute_trades._capture_execution_risk_snapshot()

    assert snapshot["available"] is True
    assert snapshot["tier"] == "HALT"
    assert snapshot["daily_pnl_pct"] == pytest.approx(-8.0)

    position = {
        "symbol": "AAA",
        "qty": 3.5,
        "current_price": 100.0,
        "market_value": 350.0,
    }
    params = {
        **strategy_config.get_strategy_params("BULL", "HALT"),
        "adaptive_momentum": True,
    }
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(execute_trades, "save_json", lambda path, value: None)
    monkeypatch.setattr(portfolio, "get_positions", lambda: [position])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(notify, "send_trade_alert", lambda *a, **k: None)
    token = execute_trades._EXECUTION_RISK_TIER.set(snapshot["tier"])
    try:
        result = execute_trades._manage_adaptive_momentum_picks(
            dry_run=True, allow_new_exposure=False
        )
    finally:
        execute_trades._EXECUTION_RISK_TIER.reset(token)
    exit_preview = next(
        item for item in result if item["action"] == "DRY_RUN_ADAPTIVE_EXIT"
    )
    assert exit_preview["qty"] == 3.5
    assert not any("BUY" in item["action"] for item in result)


def test_nonfinite_current_equity_blocks_new_exposure(monkeypatch):
    import portfolio

    monkeypatch.setattr(
        execute_trades, "load_json", lambda path: {"risk_tier": "NORMAL"}
    )
    monkeypatch.setattr(
        portfolio,
        "get_account",
        lambda: {"equity": float("nan"), "last_equity": 100_000.0},
    )
    monkeypatch.setattr(
        portfolio,
        "get_recent_equity_history",
        lambda max_observations=22: [100_000.0],
    )

    snapshot = execute_trades._capture_execution_risk_snapshot()

    assert snapshot["available"] is False
    assert "unavailable" in snapshot["reason"]


def test_recent_equity_history_comes_from_broker_and_is_bounded(monkeypatch):
    import portfolio
    from alpaca.trading.models import PortfolioHistory
    from utils import EDT

    calls = []
    today = datetime.now(EDT).date()

    class Broker:
        def get_portfolio_history(self, request):
            calls.append(request)
            dates = [today - timedelta(days=days) for days in (5, 4, 3, 2, 1, 0)]
            return PortfolioHistory(
                equity=[89_000, 90_000, 90_500, 91_000, 92_000, 999_999],
                timestamp=[
                    int(
                        datetime(
                            value.year,
                            value.month,
                            value.day,
                            12,
                            tzinfo=timezone.utc,
                        ).timestamp()
                    )
                    for value in dates
                ],
                profit_loss=[0.0] * 6,
                profit_loss_pct=[0.0] * 6,
                timeframe="1D",
            )

    monkeypatch.setattr(portfolio, "_client", Broker())

    equities = portfolio.get_recent_equity_history(max_observations=2)

    assert equities == [91_000.0, 92_000.0]
    assert len(calls) == 1
    assert calls[0].period == "3M"
    assert calls[0].timeframe == "1D"
    assert calls[0].extended_hours is False


def _broker_history_payload(dates, equities):
    return {
        "timestamp": [
            int(
                datetime(
                    value.year,
                    value.month,
                    value.day,
                    12,
                    tzinfo=timezone.utc,
                ).timestamp()
            )
            for value in dates
        ],
        "equity": equities,
    }


def test_recent_equity_history_rejects_stale_completed_data(monkeypatch):
    import portfolio
    from utils import EDT

    today = datetime.now(EDT).date()
    payload = _broker_history_payload(
        [today - timedelta(days=90), today - timedelta(days=89)],
        [100_000, 101_000],
    )
    monkeypatch.setattr(
        portfolio,
        "_client",
        SimpleNamespace(get_portfolio_history=lambda request: payload),
    )

    with pytest.raises(ValueError, match="no recent completed observation"):
        portfolio.get_recent_equity_history()


@pytest.mark.parametrize("date_offsets", [(-2, -2), (-1, -2)])
def test_recent_equity_history_rejects_duplicate_or_unordered_days(
    monkeypatch, date_offsets
):
    import portfolio
    from utils import EDT

    today = datetime.now(EDT).date()
    payload = _broker_history_payload(
        [today + timedelta(days=offset) for offset in date_offsets],
        [100_000, 101_000],
    )
    monkeypatch.setattr(
        portfolio,
        "_client",
        SimpleNamespace(get_portfolio_history=lambda request: payload),
    )

    with pytest.raises(ValueError, match="strictly increasing|duplicate or unordered"):
        portfolio.get_recent_equity_history()


def test_recent_equity_history_rejects_future_daily_bucket(monkeypatch):
    import portfolio
    from utils import EDT

    today = datetime.now(EDT).date()
    payload = _broker_history_payload(
        [today - timedelta(days=1), today + timedelta(days=1)],
        [100_000, 101_000],
    )
    monkeypatch.setattr(
        portfolio,
        "_client",
        SimpleNamespace(get_portfolio_history=lambda request: payload),
    )

    with pytest.raises(ValueError, match="future daily bucket"):
        portfolio.get_recent_equity_history()


def test_recent_equity_history_uses_new_york_date_at_utc_midnight(monkeypatch):
    import portfolio
    from utils import EDT

    today = datetime.now(EDT).date()
    prior = today - timedelta(days=2)
    utc_midnight = datetime(
        today.year,
        today.month,
        today.day,
        0,
        30,
        tzinfo=timezone.utc,
    )
    payload = {
        "timestamp": [
            int(
                datetime(
                    prior.year,
                    prior.month,
                    prior.day,
                    12,
                    tzinfo=timezone.utc,
                ).timestamp()
            ),
            int(utc_midnight.timestamp()),
        ],
        "equity": [100_000, 101_000],
    }
    monkeypatch.setattr(
        portfolio,
        "_client",
        SimpleNamespace(get_portfolio_history=lambda request: payload),
    )

    assert portfolio.get_recent_equity_history() == [100_000.0, 101_000.0]


@pytest.mark.parametrize(
    "performance_state",
    [{"risk_tier": "NORMAL"}, {}, []],
    ids=["valid", "missing", "invalid"],
)
def test_broker_history_failure_preserves_fresh_halt_and_exits(
    monkeypatch, performance_state
):
    import notify
    import portfolio

    monkeypatch.setattr(execute_trades, "load_json", lambda path: performance_state)
    monkeypatch.setattr(
        portfolio,
        "get_account",
        lambda: {
            "equity": 92_000.0,
            "last_equity": 100_000.0,
            "cash": 0.0,
        },
    )
    monkeypatch.setattr(
        portfolio,
        "get_recent_equity_history",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("history API down")),
    )

    snapshot = execute_trades._capture_execution_risk_snapshot()

    assert snapshot["available"] is False
    assert snapshot["tier"] == "HALT"
    assert "history API down" in snapshot["reason"]

    position = {
        "symbol": "AAA",
        "qty": 3.5,
        "current_price": 100.0,
        "market_value": 350.0,
    }
    params = {
        **strategy_config.get_strategy_params("BULL", "HALT"),
        "adaptive_momentum": True,
    }
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(execute_trades, "save_json", lambda path, value: None)
    monkeypatch.setattr(portfolio, "get_positions", lambda: [position])
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(notify, "send_trade_alert", lambda *a, **k: None)
    token = execute_trades._EXECUTION_RISK_TIER.set(snapshot["tier"])
    try:
        result = execute_trades._manage_adaptive_momentum_picks(
            dry_run=True, allow_new_exposure=False
        )
    finally:
        execute_trades._EXECUTION_RISK_TIER.reset(token)
    assert any(item["action"] == "DRY_RUN_ADAPTIVE_EXIT" for item in result)


def test_validation_gate_requires_full_paper_eligibility_contract(monkeypatch):
    import strategy_identity
    from backtest.validate_v11 import attach_report_contract

    report = canonical_validation_report(
        allowed_mode="dry-run/shadow-research-only"
    )
    monkeypatch.setattr(
        strategy_identity,
        "build_bar_snapshot_identity",
        lambda *args, **kwargs: {"bar_snapshot_sha256": "a" * 64},
    )
    monkeypatch.setattr(execute_trades, "load_json", lambda path: report)
    assert execute_trades._v11_validation_gate()["passed"] is False

    report["assessment"]["allowed_mode"] = "paper-validation-eligible"
    report = attach_report_contract(report)
    assert execute_trades._v11_validation_gate()["passed"] is True

    report["evidence"]["bar_snapshot_sha256"] = "b" * 64
    report = attach_report_contract(report)
    assert execute_trades._v11_validation_gate()["passed"] is False
    report["evidence"]["bar_snapshot_sha256"] = "a" * 64
    report = attach_report_contract(report)

    report["strategy"]["version"] = "v10"
    report = attach_report_contract(report)
    assert execute_trades._v11_validation_gate()["passed"] is False


def test_validation_gate_fails_closed_when_state_read_raises(monkeypatch):
    monkeypatch.setattr(
        execute_trades,
        "load_json",
        lambda path: (_ for _ in ()).throw(PermissionError("validation denied")),
    )

    gate = execute_trades._v11_validation_gate()

    assert gate["passed"] is False
    assert gate["status"] == "UNAVAILABLE"
    assert "validation denied" in gate["reason"]


def test_load_json_normalizes_wrong_type_and_io_failure(monkeypatch, tmp_path):
    import builtins
    import utils

    wrong_type = tmp_path / "wrong-type.json"
    wrong_type.write_text('["not", "an", "object"]')
    assert utils.load_json(wrong_type) == {}
    assert utils.load_json_object_status(wrong_type) == (
        {},
        "top-level JSON value is not an object",
    )

    missing = tmp_path / "missing.json"
    assert utils.load_json_object_status(missing) == ({}, None)

    monkeypatch.setattr(
        builtins,
        "open",
        lambda *a, **k: (_ for _ in ()).throw(PermissionError("denied")),
    )
    assert utils.load_json(wrong_type) == {}
    value, error = utils.load_json_object_status(wrong_type)
    assert value == {}
    assert error is not None and error.startswith("PermissionError:")


def test_wrong_type_research_state_defaults_regime_and_reaches_safety_preflight(
    monkeypatch,
):
    monkeypatch.setattr(strategy_config, "load_json", lambda path: "corrupt")
    monkeypatch.setattr(
        execute_trades, "get_market_regime", strategy_config.get_market_regime
    )
    monkeypatch.setattr(
        execute_trades,
        "get_strategy_params",
        lambda *a: {
            "adaptive_momentum": True,
            "enable_options_hedge": False,
            "enable_mean_reversion": False,
            "enable_pead": False,
        },
    )
    monkeypatch.setattr(
        execute_trades,
        "_reconcile_v11_short_positions",
        lambda **kwargs: [
            {
                "action": "ABORT_SHORT_RECONCILIATION",
                "reason": "broker snapshot unavailable",
            }
        ],
    )

    result = execute_trades._run_execution_with_risk_snapshot(
        dry_run=True,
        risk_snapshot={"available": False, "tier": "NORMAL"},
    )

    assert result["regime"] == "NEUTRAL"
    assert result["entry_gate"]["allowed"] is False
    assert result["safety_preflight"][0]["action"] == (
        "ABORT_SHORT_RECONCILIATION"
    )


def test_adaptive_midday_never_runs_legacy_stop_or_scale_mechanics(monkeypatch):
    import portfolio

    params = {
        **strategy_config.get_strategy_params("BULL", "NORMAL"),
        "adaptive_momentum": True,
    }
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_short_positions", lambda **kwargs: []
    )
    monkeypatch.setattr(
        trade, "get_market_entry_gate", lambda: {"allowed": True, "reason": "open"}
    )
    for name in (
        "execute_stop_losses",
        "sync_trailing_stops",
    ):
        monkeypatch.setattr(
            trade,
            name,
            lambda _name=name: (_ for _ in ()).throw(
                AssertionError(f"legacy {_name} ran")
            ),
        )
    for name in (
        "tighten_stops_in_profit",
        "execute_scale_outs",
        "execute_time_stops",
    ):
        monkeypatch.setattr(
            execute_trades,
            name,
            lambda _name=name: (_ for _ in ()).throw(
                AssertionError(f"legacy {_name} ran")
            ),
        )
    monkeypatch.setattr(execute_trades, "manage_bear_hedge", lambda **kwargs: [])
    monkeypatch.setattr(execute_trades, "manage_momentum_picks", lambda **kwargs: [])
    monkeypatch.setattr(
        execute_trades,
        "_v11_validation_gate",
        lambda: {"passed": True},
    )
    monkeypatch.setattr(portfolio, "save_positions_state", lambda: None)
    monkeypatch.setattr(portfolio, "update_performance_state", lambda: None)

    assert execute_trades._run_midday_command(
        {"available": True, "tier": "NORMAL"}
    ) == 0


def test_adaptive_midday_respects_infrastructure_migration_gate(monkeypatch):
    import portfolio

    params = {
        **strategy_config.get_strategy_params("BULL", "NORMAL"),
        "adaptive_momentum": True,
    }
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_short_positions", lambda **kwargs: []
    )
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_open_buys_preflight", lambda **kwargs: []
    )
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": True, "reason": "open and fresh"},
    )
    monkeypatch.setattr(
        execute_trades, "_cancel_v11_infrastructure_buys", lambda **kwargs: []
    )
    monkeypatch.setattr(execute_trades, "manage_bear_hedge", lambda **kwargs: [])
    monkeypatch.setattr(
        execute_trades,
        "_v11_validation_gate",
        lambda: {"passed": True, "status": "PASS"},
    )
    monkeypatch.setattr(
        execute_trades,
        "_infrastructure_migration_status",
        lambda: {
            "pending": True,
            "held_symbols": ["TQQQ"],
            "open_order_ids": [],
            "reason": "legacy exposure remains",
        },
    )
    momentum_calls = []
    monkeypatch.setattr(
        execute_trades,
        "manage_momentum_picks",
        lambda **kwargs: momentum_calls.append(kwargs) or [],
    )
    monkeypatch.setattr(portfolio, "save_positions_state", lambda: None)
    monkeypatch.setattr(portfolio, "update_performance_state", lambda: None)

    result = execute_trades._run_midday_command(
        {"available": True, "tier": "NORMAL"}
    )

    assert result == 0
    assert momentum_calls == [{"allow_new_exposure": False}]


def test_adaptive_midday_short_preflight_blocks_every_other_action(monkeypatch):
    params = {
        **strategy_config.get_strategy_params("BULL", "NORMAL"),
        "adaptive_momentum": True,
    }
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(execute_trades, "get_strategy_params", lambda *a: params)
    monkeypatch.setattr(
        execute_trades,
        "_reconcile_v11_short_positions",
        lambda **kwargs: [
            {
                "symbol": "AAA",
                "action": "SHORT_COVER_SUBMITTED",
                "side": "buy",
            }
        ],
    )
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: (_ for _ in ()).throw(AssertionError("clock gate ran")),
    )
    monkeypatch.setattr(
        execute_trades,
        "manage_momentum_picks",
        lambda **kwargs: (_ for _ in ()).throw(AssertionError("target engine ran")),
    )

    assert execute_trades._run_midday_command(
        {"available": True, "tier": "NORMAL"}
    ) == 0


def test_midday_cancels_orphan_buy_before_fallible_legacy_manager(monkeypatch):
    orphan = _open_order(
        order_id="midday-orphan",
        symbol="AAA",
        side="buy",
        quantity=5,
    )
    snapshots = iter([[orphan], []])
    cancelled = []
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        execute_trades,
        "get_strategy_params",
        lambda *args: {"adaptive_momentum": True},
    )
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_short_positions", lambda **kwargs: []
    )
    monkeypatch.setattr(
        execute_trades,
        "_v11_validation_gate",
        lambda: {"passed": True, "reason": "test pass"},
    )
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": True, "reason": "market open"},
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(
        execute_trades,
        "load_json_object_status",
        lambda path: ({}, None),
    )
    monkeypatch.setattr(
        execute_trades,
        "manage_bear_hedge",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("legacy manager ran before orphan BUY cancellation")
        ),
    )

    assert execute_trades._run_midday_command(
        {"available": True, "tier": "NORMAL"}
    ) == 0
    assert cancelled == ["midday-orphan"]


def test_negative_infrastructure_position_keeps_migration_pending(monkeypatch):
    import portfolio

    monkeypatch.setattr(
        portfolio,
        "get_positions",
        lambda: [{"symbol": "TQQQ", "qty": -1.5}],
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])

    result = execute_trades._infrastructure_migration_status()

    assert result["pending"] is True
    assert result["held_symbols"] == ["TQQQ"]


def test_midday_cli_uses_fresh_risk_context(monkeypatch):
    seen = []
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setattr(
        execute_trades,
        "_capture_execution_risk_snapshot",
        lambda: {"available": True, "tier": "HALT"},
    )
    monkeypatch.setattr(
        execute_trades,
        "_run_midday_command",
        lambda snapshot: seen.append((snapshot, execute_trades.get_risk_tier())) or 0,
    )

    assert execute_trades.main(["midday"]) == 0
    assert seen == [({"available": True, "tier": "HALT"}, "HALT")]


@pytest.mark.parametrize("command", ["stops", "sync-stops", "cancel"])
def test_trade_cli_mutations_require_explicit_paper_mode(monkeypatch, command):
    monkeypatch.delenv("TRADING_MODE", raising=False)
    monkeypatch.setattr(
        trade,
        "execute_stop_losses",
        lambda: (_ for _ in ()).throw(AssertionError("mutated")),
    )
    monkeypatch.setattr(
        trade,
        "sync_trailing_stops",
        lambda: (_ for _ in ()).throw(AssertionError("mutated")),
    )
    monkeypatch.setattr(
        trade,
        "cancel_all_orders",
        lambda: (_ for _ in ()).throw(AssertionError("mutated")),
    )

    assert trade.main([command]) == 2


def _dry_run_result() -> dict:
    return {
        "regime": "BULL",
        "risk_tier": "NORMAL",
        "buys": [],
        "sells": [],
        "hedge": [],
        "scale_outs": [],
        "time_stops": [],
    }


def test_default_cli_command_is_non_trading_dry_run(monkeypatch):
    calls = []
    monkeypatch.delenv("TRADING_MODE", raising=False)
    monkeypatch.setattr(
        execute_trades,
        "run_execution",
        lambda *, dry_run: calls.append(dry_run) or _dry_run_result(),
    )

    exit_code = execute_trades.main([])

    assert exit_code == 0
    assert execute_trades.resolve_cli_command([]) == "dry-run"
    assert calls == [True]


@pytest.mark.parametrize("mode", [None, "live", "LIVE", "real"])
def test_explicit_run_refuses_unset_or_live_trading_mode(monkeypatch, mode):
    calls = []
    if mode is None:
        monkeypatch.delenv("TRADING_MODE", raising=False)
    else:
        monkeypatch.setenv("TRADING_MODE", mode)
    monkeypatch.setattr(
        execute_trades,
        "run_execution",
        lambda *, dry_run: calls.append(dry_run) or _dry_run_result(),
    )

    exit_code = execute_trades.main(["run"])

    assert exit_code == 2
    assert calls == []


def test_explicit_run_accepts_only_paper_mode(monkeypatch):
    calls = []
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setattr(
        execute_trades,
        "run_execution",
        lambda *, dry_run: calls.append(dry_run) or _dry_run_result(),
    )

    exit_code = execute_trades.main(["run"])

    assert exit_code == 0
    assert calls == [False]


def test_trading_client_is_permanently_constructed_for_paper(monkeypatch):
    constructed = []

    class Client:
        def __init__(self, api_key, secret_key, **kwargs):
            constructed.append(kwargs)

    monkeypatch.setattr(trade, "TradingClient", Client)
    monkeypatch.setattr(trade, "_client", None)

    trade._get_client()

    assert constructed == [{"paper": True}]


def test_closed_entry_gate_keeps_exits_running_and_blocks_all_entry_paths(
    monkeypatch,
):
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": False, "reason": "market closed"},
    )
    monkeypatch.setattr(trade, "execute_stop_losses", lambda *, dry_run: [])
    monkeypatch.setattr(trade, "sync_trailing_stops", lambda *, dry_run: [])
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        execute_trades,
        "_infrastructure_migration_status",
        lambda: {
            "pending": False,
            "held_symbols": [],
            "open_order_ids": [],
            "reason": "converged",
        },
    )
    monkeypatch.setattr(
        execute_trades, "_cancel_v11_infrastructure_buys", lambda **kwargs: []
    )
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_open_buys_preflight", lambda **kwargs: []
    )
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_short_positions", lambda **kwargs: []
    )

    exit_calls = []
    for name in (
        "tighten_stops_in_profit",
        "execute_scale_outs",
        "execute_sells",
        "execute_mr_exits",
        "execute_pead_exits",
        "manage_regime_transition",
        "execute_time_stops",
    ):
        monkeypatch.setattr(
            execute_trades,
            name,
            lambda *, dry_run, _name=name: exit_calls.append((_name, dry_run)) or [],
        )

    entry_calls = {}
    for name in (
        "manage_bear_hedge",
        "manage_spy_base",
        "manage_tqqq_position",
        "manage_upro_position",
        "manage_momentum_picks",
        "execute_buys",
        "execute_mr_buys",
        "execute_pead_buys",
    ):
        monkeypatch.setattr(
            execute_trades,
            name,
            lambda *, dry_run, allow_new_exposure, _name=name: (
                entry_calls.setdefault(_name, allow_new_exposure) or []
            ),
        )

    import portfolio
    import strategy_metadata

    monkeypatch.setattr(portfolio, "save_positions_state", lambda: None)
    monkeypatch.setattr(portfolio, "update_performance_state", lambda: None)
    monkeypatch.setattr(portfolio, "get_positions", lambda: [])
    monkeypatch.setattr(strategy_metadata, "sync_with_positions", lambda symbols: None)

    result = execute_trades.run_execution(dry_run=False)

    assert result["entry_gate"]["allowed"] is False
    # Adaptive mode has one target engine; legacy stop/score/time exits are
    # deliberately inactive so they cannot fight the target portfolio.
    assert exit_calls == []
    assert set(entry_calls) == {
        "manage_bear_hedge",
        "manage_spy_base",
        "manage_tqqq_position",
        "manage_upro_position",
        "manage_momentum_picks",
    }
    assert not any(entry_calls.values())


def test_full_v11_short_preflight_blocks_all_strategy_managers(monkeypatch):
    import portfolio

    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        execute_trades,
        "get_strategy_params",
        lambda *a: {
            "adaptive_momentum": True,
            "enable_options_hedge": False,
            "enable_mean_reversion": False,
            "enable_pead": False,
        },
    )
    monkeypatch.setattr(
        portfolio,
        "get_positions",
        lambda: [{"symbol": "AAA", "qty": -2.0}],
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    monkeypatch.setattr(
        trade, "get_order_by_client_order_id", lambda client_order_id: None
    )
    monkeypatch.setattr(
        trade,
        "close_position",
        lambda symbol, **kwargs: {
            "symbol": symbol,
            "status": "submitted",
            "order_id": "cover-order",
            "side": "buy",
            "qty": 2,
            "price": 100.0,
        },
    )
    for name in (
        "_v11_validation_gate",
        "execute_mr_exits",
        "execute_pead_exits",
        "manage_regime_transition",
        "manage_bear_hedge",
        "manage_momentum_picks",
    ):
        monkeypatch.setattr(
            execute_trades,
            name,
            lambda *a, _name=name, **k: (_ for _ in ()).throw(
                AssertionError(f"{_name} ran before short settled")
            ),
        )

    result = execute_trades._run_execution_with_risk_snapshot(
        dry_run=False,
        risk_snapshot={"available": True, "tier": "NORMAL"},
    )

    assert result["entry_gate"]["allowed"] is False
    assert result["safety_preflight"][0]["action"] == "SHORT_COVER_SUBMITTED"
    assert result["buys"] == []


def test_full_run_cancels_orphan_buy_before_fallible_legacy_manager(monkeypatch):
    orphan = _open_order(
        order_id="full-orphan",
        symbol="AAA",
        side="buy",
        quantity=5,
    )
    snapshots = iter([[orphan], []])
    cancelled = []
    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        execute_trades,
        "get_strategy_params",
        lambda *args: {
            "adaptive_momentum": True,
            "enable_options_hedge": False,
            "enable_mean_reversion": False,
            "enable_pead": False,
        },
    )
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_short_positions", lambda **kwargs: []
    )
    monkeypatch.setattr(
        execute_trades,
        "_v11_validation_gate",
        lambda: {"passed": True, "reason": "test pass"},
    )
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": True, "reason": "market open"},
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: next(snapshots))
    monkeypatch.setattr(
        trade, "cancel_open_order", lambda order_id: cancelled.append(order_id)
    )
    monkeypatch.setattr(
        execute_trades,
        "load_json_object_status",
        lambda path: ({}, None),
    )
    monkeypatch.setattr(
        execute_trades,
        "manage_bear_hedge",
        lambda **kwargs: (_ for _ in ()).throw(
            AssertionError("legacy manager ran before orphan BUY cancellation")
        ),
    )

    result = execute_trades._run_execution_with_risk_snapshot(
        dry_run=False,
        risk_snapshot={"available": True, "tier": "NORMAL"},
    )

    assert cancelled == ["full-orphan"]
    assert result["entry_gate"]["allowed"] is False
    assert result["safety_preflight"][-1]["action"] == (
        "V11_BUY_RECONCILIATION_PENDING_CANCELLATIONS"
    )


def test_unsettled_legacy_infrastructure_blocks_adaptive_buys(monkeypatch):
    import portfolio
    import strategy_metadata

    monkeypatch.setattr(execute_trades, "get_market_regime", lambda: "BULL")
    monkeypatch.setattr(execute_trades, "get_risk_tier", lambda: "NORMAL")
    monkeypatch.setattr(
        execute_trades,
        "get_strategy_params",
        lambda *a: {
            "adaptive_momentum": True,
            "enable_options_hedge": False,
            "enable_mean_reversion": False,
            "enable_pead": False,
        },
    )
    monkeypatch.setattr(
        execute_trades,
        "_v11_validation_gate",
        lambda: {"passed": True, "status": "PASS"},
    )
    monkeypatch.setattr(
        trade,
        "get_market_entry_gate",
        lambda: {"allowed": True, "reason": "open and fresh"},
    )
    monkeypatch.setattr(trade, "execute_stop_losses", lambda **kwargs: [])
    monkeypatch.setattr(trade, "sync_trailing_stops", lambda **kwargs: [])
    for name in (
        "execute_mr_exits",
        "execute_pead_exits",
        "manage_regime_transition",
    ):
        monkeypatch.setattr(execute_trades, name, lambda **kwargs: [])
    for name in (
        "manage_bear_hedge",
        "manage_spy_base",
        "manage_tqqq_position",
        "manage_upro_position",
    ):
        monkeypatch.setattr(execute_trades, name, lambda **kwargs: [])
    monkeypatch.setattr(
        execute_trades,
        "_infrastructure_migration_status",
        lambda: {
            "pending": True,
            "held_symbols": ["TQQQ", "UPRO"],
            "open_order_ids": [],
            "reason": "legacy exposure remains",
        },
    )
    monkeypatch.setattr(
        execute_trades, "_cancel_v11_infrastructure_buys", lambda **kwargs: []
    )
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_open_buys_preflight", lambda **kwargs: []
    )
    monkeypatch.setattr(
        execute_trades, "_reconcile_v11_short_positions", lambda **kwargs: []
    )
    momentum_calls = []
    monkeypatch.setattr(
        execute_trades,
        "manage_momentum_picks",
        lambda **kwargs: momentum_calls.append(kwargs) or [],
    )
    monkeypatch.setattr(portfolio, "save_positions_state", lambda: None)
    monkeypatch.setattr(portfolio, "update_performance_state", lambda: None)
    monkeypatch.setattr(portfolio, "get_positions", lambda: [])
    monkeypatch.setattr(strategy_metadata, "sync_with_positions", lambda symbols: None)

    execute_trades._run_execution_with_risk_snapshot(
        dry_run=False,
        risk_snapshot={"available": True, "tier": "NORMAL"},
    )

    assert momentum_calls == [
        {"dry_run": False, "allow_new_exposure": False}
    ]
