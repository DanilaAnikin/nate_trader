"""The absolute dollar ceilings are enforced where orders are actually placed.

Configuration tests prove the ceilings are *parsed*. These prove they are
*applied*, at `trade.place_limit_order` — the single choke point every buy and
sell in this repository passes through.

The distinction that matters most here is buy versus sell: a notional ceiling
that could block an exit would convert a spending guard into an inability to
reduce risk, which is a worse failure than the one it prevents.
"""

from __future__ import annotations

import pytest
from types import SimpleNamespace

import trade
from broker_mode import BrokerModeError


class _FakeAccount:
    def __init__(self, account_number: str) -> None:
        self.account_number = account_number


class _FakeOrder:
    def __init__(self, symbol: str, qty: float, side: str, limit_price: float) -> None:
        self.id = "order-1"
        self.symbol = symbol
        self.qty = qty
        self.side = side
        self.limit_price = limit_price
        self.status = "accepted"
        self.created_at = "2026-09-08T13:00:00Z"


class _FakeClient:
    """Records submissions so a test can assert nothing reached the broker."""

    def __init__(self, account_number: str = "123456789") -> None:
        self.account_number = account_number
        self.submitted: list[object] = []

    def get_account(self) -> _FakeAccount:
        return _FakeAccount(self.account_number)

    def submit_order(self, request) -> _FakeOrder:
        self.submitted.append(request)
        return _FakeOrder(
            request.symbol, request.qty, str(request.side), float(request.limit_price)
        )


LIVE_ENV = {
    "TRADING_MODE": "live",
    "LIVE_TRADING_ENABLED": "yes",
    "ALPACA_LIVE_API_KEY": "live-key",
    "ALPACA_LIVE_SECRET_KEY": "live-secret",
    "ALPACA_API_KEY": "paper-key",
    "ALPACA_SECRET_KEY": "paper-secret",
    "LIVE_TRADING_ACCOUNT_NUMBER": "123456789",
    "LIVE_MAX_ORDER_NOTIONAL_USD": "10000",
    "LIVE_MAX_CYCLE_NOTIONAL_USD": "25000",
}


@pytest.fixture
def live(monkeypatch, tmp_path):
    """A live run wired to a fake broker, with a fresh per-cycle ledger."""
    for key, value in LIVE_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv(
        "LIVE_TRADING_KILL_SWITCH_FILE", str(tmp_path / "LIVE_TRADING_DISABLED")
    )
    client = _FakeClient()
    monkeypatch.setattr(trade, "_get_client", lambda: client)
    trade.reset_live_cycle_state()
    yield client
    trade.reset_live_cycle_state()


@pytest.fixture
def paper(monkeypatch, tmp_path):
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setenv("ALPACA_API_KEY", "paper-key")
    monkeypatch.setenv("ALPACA_SECRET_KEY", "paper-secret")
    for key in (
        "LIVE_TRADING_ENABLED",
        "ALPACA_LIVE_API_KEY",
        "ALPACA_LIVE_SECRET_KEY",
        "LIVE_TRADING_ACCOUNT_NUMBER",
        "LIVE_MAX_ORDER_NOTIONAL_USD",
        "LIVE_MAX_CYCLE_NOTIONAL_USD",
    ):
        monkeypatch.delenv(key, raising=False)
    client = _FakeClient()
    monkeypatch.setattr(trade, "_get_client", lambda: client)
    trade.reset_live_cycle_state()
    yield client
    trade.reset_live_cycle_state()


# ── the per-order ceiling ───────────────────────────────────────────────────


def test_a_buy_within_the_per_order_ceiling_is_submitted(live):
    trade.place_limit_order("AAPL", 10, "buy", 500.0)  # $5,000
    assert len(live.submitted) == 1


def test_a_buy_above_the_per_order_ceiling_never_reaches_the_broker(live):
    with pytest.raises(RuntimeError, match="LIVE_MAX_ORDER_NOTIONAL_USD"):
        trade.place_limit_order("AAPL", 100, "buy", 500.0)  # $50,000
    assert live.submitted == []


def test_the_ceiling_is_notional_not_share_count(live):
    """A small share count at a high price is still a large order."""
    with pytest.raises(RuntimeError, match="LIVE_MAX_ORDER_NOTIONAL_USD"):
        trade.place_limit_order("BRK.A", 1, "buy", 750_000.0)
    assert live.submitted == []


@pytest.mark.parametrize("qty,price", [
    (float("nan"), 100.0),
    (float("inf"), 100.0),
    (-1.0, 100.0),
    (0.0, 100.0),
    (1.0, float("nan")),
    (1.0, float("inf")),
    (1.0, -100.0),
    (1.0, 0.0),
    (1.0, 0.001),
    (1e308, 1e308),
])
def test_invalid_order_cannot_poison_or_reduce_live_cycle_budget(live, qty, price):
    with pytest.raises(ValueError, match="finite and positive"):
        trade.place_limit_order("AAPL", qty, "buy", price)
    assert live.submitted == []
    assert trade._live_cycle_notional_spent == 0.0
    for _ in range(2):
        trade.place_limit_order("MSFT", 20, "buy", 500.0)
    with pytest.raises(RuntimeError, match="LIVE_MAX_CYCLE_NOTIONAL_USD"):
        trade.place_limit_order("MSFT", 20, "buy", 500.0)
    assert len(live.submitted) == 2
    assert trade._live_cycle_notional_spent == 20_000.0


def test_order_cap_checks_the_rounded_broker_price(live, monkeypatch):
    monkeypatch.setenv("LIVE_MAX_ORDER_NOTIONAL_USD", "100.006")
    with pytest.raises(RuntimeError, match="LIVE_MAX_ORDER_NOTIONAL_USD"):
        trade.place_limit_order("AAPL", 1, "buy", 100.006)
    assert live.submitted == []
    assert trade._live_cycle_notional_spent == 0.0


def test_cycle_budget_reserves_the_exact_submitted_notional(live, monkeypatch):
    monkeypatch.setenv("LIVE_MAX_ORDER_NOTIONAL_USD", "100")
    trade.place_limit_order("AAPL", 1, "buy", 100.004)
    assert live.submitted[0].limit_price == 100.0
    assert trade._live_cycle_notional_spent == 100.0


def test_ambiguous_submission_failure_keeps_the_reserved_cycle_budget(live, monkeypatch):
    def interrupted_submission(request):
        raise TimeoutError("response unavailable after submission")

    monkeypatch.setattr(live, "submit_order", interrupted_submission)
    with pytest.raises(TimeoutError):
        trade.place_limit_order("AAPL", 20, "buy", 500.0)
    assert trade._live_cycle_notional_spent == 10_000.0


# ── the per-cycle ceiling ───────────────────────────────────────────────────


def test_the_cycle_ceiling_accumulates_across_orders(live):
    for _ in range(2):
        trade.place_limit_order("AAPL", 20, "buy", 500.0)  # $10,000 each
    assert len(live.submitted) == 2

    # $20,000 committed; a third $10,000 order would reach $30,000 > $25,000.
    with pytest.raises(RuntimeError, match="LIVE_MAX_CYCLE_NOTIONAL_USD"):
        trade.place_limit_order("MSFT", 20, "buy", 500.0)
    assert len(live.submitted) == 2


def test_a_refused_order_does_not_consume_cycle_budget(live):
    """A rejection must not make the next legitimate order fail too."""
    with pytest.raises(RuntimeError):
        trade.place_limit_order("AAPL", 100, "buy", 500.0)  # over per-order
    trade.place_limit_order("MSFT", 20, "buy", 500.0)  # $10,000, fine
    assert len(live.submitted) == 1


def test_resetting_the_cycle_clears_the_ledger(live):
    trade.place_limit_order("AAPL", 20, "buy", 500.0)
    trade.reset_live_cycle_state()
    for _ in range(2):
        trade.place_limit_order("MSFT", 20, "buy", 500.0)
    assert len(live.submitted) == 3


# ── sells are never blocked ─────────────────────────────────────────────────


def test_a_sell_far_above_every_ceiling_is_still_submitted(live):
    """Exits are risk-reducing. No spending guard may prevent one."""
    trade.place_limit_order("AAPL", 1000, "sell", 500.0)  # $500,000
    assert len(live.submitted) == 1


def test_sells_do_not_consume_the_cycle_budget(live):
    trade.place_limit_order("AAPL", 1000, "sell", 500.0)
    for _ in range(2):
        trade.place_limit_order("MSFT", 20, "buy", 500.0)
    assert len(live.submitted) == 3


def test_the_kill_switch_still_lets_a_sell_through(live, monkeypatch, tmp_path):
    """Parking live trading stops new exposure, not the ability to exit."""
    switch = tmp_path / "LIVE_TRADING_DISABLED"
    switch.write_text("parked")
    with pytest.raises(RuntimeError, match="kill switch"):
        trade.place_limit_order("AAPL", 1, "buy", 100.0)
    assert live.submitted == []
    trade.place_limit_order("AAPL", 1000, "sell", 500.0)
    assert len(live.submitted) == 1


def test_kill_switch_does_not_bypass_account_binding_for_an_exit(
    live, monkeypatch, tmp_path
):
    (tmp_path / "LIVE_TRADING_DISABLED").write_text("parked")
    wrong = _FakeClient(account_number="999999999")
    monkeypatch.setattr(trade, "_get_client", lambda: wrong)
    with pytest.raises(BrokerModeError, match="different Alpaca account"):
        trade.place_limit_order("AAPL", 1, "sell", 100.0)
    assert wrong.submitted == []


def test_kill_switch_permits_a_verified_short_cover(live, monkeypatch, tmp_path):
    (tmp_path / "LIVE_TRADING_DISABLED").write_text("parked")
    monkeypatch.setattr(
        live, "get_open_position",
        lambda symbol: SimpleNamespace(symbol=symbol, qty="-1000"), raising=False,
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: [])
    result = trade.close_position("AAPL", price_override=500.0, client_order_id="cover-1")
    assert result["status"] == "submitted"
    assert len(live.submitted) == 1
    assert live.submitted[0].client_order_id == "cover-1"
    assert live.submitted[0].qty == 1000


@pytest.mark.parametrize("position_qty,orders", [
    ("-0.5", []),
    ("1", []),
    ("nan", []),
    ("-1", [{"symbol": "AAPL"}]),
])
def test_kill_switch_cover_exception_requires_bounded_uncontested_short(
    live, monkeypatch, tmp_path, position_qty, orders
):
    (tmp_path / "LIVE_TRADING_DISABLED").write_text("parked")
    monkeypatch.setattr(
        live, "get_open_position",
        lambda symbol: SimpleNamespace(symbol=symbol, qty=position_qty), raising=False,
    )
    monkeypatch.setattr(trade, "list_open_orders", lambda: orders)
    with pytest.raises(RuntimeError, match="kill switch"):
        trade.place_limit_order("AAPL", 1, "buy", 100.0)
    assert live.submitted == []


def test_kill_switch_refuses_cover_when_broker_position_is_unreadable(
    live, monkeypatch, tmp_path
):
    (tmp_path / "LIVE_TRADING_DISABLED").write_text("parked")

    def unreadable(symbol):
        raise RuntimeError("broker unavailable")

    monkeypatch.setattr(live, "get_open_position", unreadable, raising=False)
    with pytest.raises(RuntimeError, match="kill switch"):
        trade.place_limit_order("AAPL", 1, "buy", 100.0)
    assert live.submitted == []


# ── the credential-to-account binding ───────────────────────────────────────


def test_a_live_order_verifies_the_account_binding_before_submitting(
    live, monkeypatch
):
    wrong = _FakeClient(account_number="999999999")
    monkeypatch.setattr(trade, "_get_client", lambda: wrong)
    trade.reset_live_cycle_state()
    with pytest.raises(BrokerModeError, match="different Alpaca account"):
        trade.place_limit_order("AAPL", 1, "buy", 100.0)
    assert wrong.submitted == []


def test_the_binding_is_verified_before_a_sell_too(live, monkeypatch):
    """Selling the wrong account's holdings is as wrong as buying in it."""
    wrong = _FakeClient(account_number="999999999")
    monkeypatch.setattr(trade, "_get_client", lambda: wrong)
    trade.reset_live_cycle_state()
    with pytest.raises(BrokerModeError, match="different Alpaca account"):
        trade.place_limit_order("AAPL", 1, "sell", 100.0)
    assert wrong.submitted == []


# ── paper is untouched ──────────────────────────────────────────────────────


def test_paper_orders_are_not_subject_to_live_ceilings(paper):
    """The paper path must behave exactly as it did before live existed."""
    trade.place_limit_order("AAPL", 10_000, "buy", 500.0)  # $5,000,000
    assert len(paper.submitted) == 1


def test_paper_does_not_verify_a_live_account_binding(paper, monkeypatch):
    other = _FakeClient(account_number="999999999")
    monkeypatch.setattr(trade, "_get_client", lambda: other)
    trade.place_limit_order("AAPL", 1, "buy", 100.0)
    assert len(other.submitted) == 1
