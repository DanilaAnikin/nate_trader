"""Trade execution — order validation, placement, stop-losses."""

import hashlib
import math
import os
import sys
from datetime import datetime, timezone
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import (
    LimitOrderRequest,
    TrailingStopOrderRequest,
    GetOrdersRequest,
)
from alpaca.trading.enums import OrderSide, OrderType, TimeInForce, QueryOrderStatus

from utils import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY,
    setup_logging, get_now_str,
    get_risk_tier, get_symbol_info,
)

log = setup_logging("trade")

_client: "TradingClient | None" = None
MAX_ENTRY_CLOCK_AGE_SECONDS = 120
_INFRASTRUCTURE_SYMBOLS = {"SPY", "SSO", "TQQQ", "UPRO", "BIL", "SH"}


def _get_client() -> TradingClient:
    """Lazily build the Alpaca client so importing this module never requires
    credentials — keeps sanity checks and unit tests importable without keys."""
    global _client
    if _client is None:
        _client = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)
    return _client


def __getattr__(name: str):
    # Back-compat: `from trade import client` / `trade.client` still works, but
    # now resolves lazily instead of building the client at import time.
    if name == "client":
        return _get_client()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def get_market_status() -> dict:
    """Check if the market is open."""
    clock = _get_client().get_clock()
    return {
        "is_open": clock.is_open,
        "next_open": str(clock.next_open),
        "next_close": str(clock.next_close),
        "timestamp": str(clock.timestamp),
    }


def get_market_entry_gate(
    *,
    now: datetime | None = None,
    max_age_seconds: int = MAX_ENTRY_CLOCK_AGE_SECONDS,
) -> dict:
    """Fail-closed gate for orders that would add market exposure.

    Alpaca's clock is authoritative for whether the market is open.  Its
    timestamp must also be close to our current UTC time so a cached/stale
    response cannot accidentally authorize entries.  Callers should continue
    processing risk-reducing sells when ``allowed`` is false.
    """
    checked_at = now or datetime.now(timezone.utc)
    if checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=timezone.utc)
    else:
        checked_at = checked_at.astimezone(timezone.utc)

    try:
        clock = _get_client().get_clock()
        clock_timestamp = clock.timestamp
        if isinstance(clock_timestamp, str):
            clock_timestamp = datetime.fromisoformat(
                clock_timestamp.replace("Z", "+00:00")
            )
        if clock_timestamp.tzinfo is None:
            clock_timestamp = clock_timestamp.replace(tzinfo=timezone.utc)
        else:
            clock_timestamp = clock_timestamp.astimezone(timezone.utc)

        age_seconds = abs((checked_at - clock_timestamp).total_seconds())
        is_open = bool(clock.is_open)
        is_fresh = age_seconds <= max_age_seconds
        if not is_open:
            reason = "Alpaca market clock reports closed"
        elif not is_fresh:
            reason = (
                f"Alpaca market clock is stale ({age_seconds:.1f}s; "
                f"max {max_age_seconds}s)"
            )
        else:
            reason = "market open and Alpaca clock fresh"
        return {
            "allowed": is_open and is_fresh,
            "is_open": is_open,
            "is_fresh": is_fresh,
            "age_seconds": age_seconds,
            "clock_timestamp": clock_timestamp.isoformat(),
            "checked_at": checked_at.isoformat(),
            "reason": reason,
        }
    except Exception as exc:
        return {
            "allowed": False,
            "is_open": False,
            "is_fresh": False,
            "age_seconds": None,
            "clock_timestamp": None,
            "checked_at": checked_at.isoformat(),
            "reason": f"Alpaca market clock unavailable: {exc}",
        }


def build_client_order_id(
    purpose: str,
    symbol: str,
    side: str,
    execution_key: str,
) -> str:
    """Build a stable Alpaca client-order ID (48 characters maximum).

    The same purpose/symbol/side/execution key always produces the same ID,
    allowing scheduled routines to be safely retried without submitting a
    duplicate order.  ``execution_key`` is deliberately supplied by callers
    (for example ``2026-07-30`` or ``2026-07``) rather than read from the
    clock, which keeps this helper deterministic and straightforward to test.
    """
    canonical = "|".join((purpose, symbol.upper(), side.lower(), execution_key))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]
    readable = "-".join(("nt", purpose, symbol.upper(), side.lower()))
    safe_readable = "".join(
        char.lower() if char.isalnum() or char == "-" else "-"
        for char in readable
    ).strip("-")
    prefix = safe_readable[:35].rstrip("-")
    return f"{prefix}-{digest}"[:48]


def validate_order(
    symbol: str,
    qty: float,
    side: str,
    price: float,
    *,
    sector_override: str | None = None,
) -> dict:
    """Validate an order against all risk rules. Returns {valid: bool, reasons: []}."""
    from strategy_config import get_strategy_params
    reasons = []
    acct = _get_client().get_account()
    equity = float(acct.equity)
    cash = float(acct.cash)
    positions = _get_client().get_all_positions()
    risk_tier = get_risk_tier()
    params = get_strategy_params()

    # Identify hedge orders early so we can apply exemptions consistently
    from utils import get_symbol_info as _get_info
    is_hedge_order = _get_info(symbol).get("sector") == "Hedge"

    # 1. Risk tier check — HALT blocks new directional longs, NOT hedges
    if risk_tier == "HALT" and side.lower() == "buy" and not is_hedge_order:
        reasons.append("HALT mode — no new directional buys allowed (hedges OK)")

    # 2. Cash reserve check (regime-adaptive minimum)
    order_cost = qty * price
    if side.lower() == "buy":
        remaining_cash = cash - order_cost
        min_cash = equity * (params["min_cash_pct"] / 100.0)
        if remaining_cash < min_cash:
            reasons.append(
                f"Would breach {params['min_cash_pct']:.0f}% cash reserve "
                f"(remaining: ${remaining_cash:,.2f}, min: ${min_cash:,.2f})"
            )

    # 3. Position size check (regime-adaptive max)
    max_pct = params["max_position_pct"]
    position_value = order_cost
    # Add existing position value if we already hold this
    for p in positions:
        if p.symbol == symbol:
            position_value += float(p.market_value)
            break
    position_pct = (position_value / equity * 100) if equity > 0 else 0
    if position_pct > max_pct:
        reasons.append(f"Position size {position_pct:.1f}% exceeds {max_pct}% limit")

    # 4. Max positions check (regime-adaptive) — hedge orders are exempt
    if side.lower() == "buy" and not is_hedge_order:
        existing_symbols = {p.symbol for p in positions}
        # Don't count existing hedge position against the directional slot count
        non_hedge_symbols = {
            s for s in existing_symbols
            if _get_info(s).get("sector") != "Hedge"
            and s not in _INFRASTRUCTURE_SYMBOLS
        }
        max_positions = params["max_positions"]
        if symbol not in existing_symbols and len(non_hedge_symbols) >= max_positions:
            reasons.append(f"Max {max_positions} positions reached ({len(non_hedge_symbols)} open)")

    # 5. Sector concentration check (25% max) — Hedge sector is exempt
    if side.lower() == "buy" and not is_hedge_order:
        symbol_info = get_symbol_info(symbol)
        target_sector = sector_override or symbol_info.get("sector", "Unknown")
        if target_sector == "Unknown":
            # Unknown means the symbol isn't in watchlist AND isn't in the sector
            # fallback map. Block the trade — better miss a single name than
            # silently breach the sector cap (the old behavior cost us).
            reasons.append(
                f"{symbol}: unknown sector — add to watchlist.json or "
                f"SECTOR_FALLBACK_MAP in utils.py before trading"
            )
        else:
            sector_value = order_cost
            for p in positions:
                if p.symbol in _INFRASTRUCTURE_SYMBOLS:
                    continue
                if p.symbol == symbol:
                    # Already accounted for via order_cost for new shares;
                    # add existing value for total post-trade position
                    sector_value += float(p.market_value)
                    continue
                p_info = get_symbol_info(p.symbol)
                if p_info.get("sector") == target_sector:
                    sector_value += float(p.market_value)
            sector_pct = (sector_value / equity * 100) if equity > 0 else 0
            max_sector_pct = float(params.get("momentum_max_sector_pct", 20.0))
            if sector_pct > max_sector_pct:
                reasons.append(
                    f"Sector '{target_sector}' would be {sector_pct:.1f}% "
                    f"(max {max_sector_pct:.0f}%)"
                )

    # 6. Fresh-account HALT backstop.  The old independent -3% threshold was
    # absent from the validated/backtested policy and made live fills diverge
    # from the evidence.  Match the shared -8% one-session HALT instead; the
    # execution orchestrator separately captures the full rolling assessment.
    from risk_policy import HALT_DAILY_RETURN_PCT

    last_equity = float(acct.last_equity)
    daily_pnl_pct = (
        (float(acct.equity) - last_equity) / last_equity * 100.0
        if last_equity > 0
        else 0.0
    )
    if (
        daily_pnl_pct <= HALT_DAILY_RETURN_PCT
        and side.lower() == "buy"
        and not is_hedge_order
    ):
        reasons.append(
            f"Daily HALT triggered ({daily_pnl_pct:.2f}% today; "
            f"threshold {HALT_DAILY_RETURN_PCT:.0f}%)"
        )

    # 7. Symbol must be a valid, tradeable asset on Alpaca
    try:
        asset = _get_client().get_asset(symbol)
        if not asset.tradable:
            reasons.append(f"{symbol} exists but is not currently tradeable on Alpaca")
        if asset.status == "inactive":
            reasons.append(f"{symbol} is inactive on Alpaca")
    except Exception:
        reasons.append(f"{symbol} is not a valid asset on Alpaca")

    valid = len(reasons) == 0
    return {
        "valid": valid,
        "symbol": symbol,
        "qty": qty,
        "side": side,
        "price": price,
        "order_value": order_cost,
        "reasons": reasons,
        "risk_tier": risk_tier,
        "timestamp": get_now_str(),
    }


def calculate_position_size(symbol: str, entry_price: float,
                            atr: float | None = None,
                            vol_20d_pct: float | None = None) -> int:
    """Calculate position size — v3 risk-budget OR Phase-D vol-target.

    Phase D mode (preferred when `target_vol_per_position_pct` is set in
    strategy_config and vol_20d_pct is known):
      shares = (target_vol_frac × equity) / (entry_price × stock_vol_frac)
      Each name contributes equal portfolio variance, smoothing the equity
      curve and ensuring high-vol names (SMCI, MSTR) get smaller weights
      than low-vol names (MSFT, JNJ) at the same risk budget.

    Legacy fallback (current production):
      shares = (equity × risk_pct) / (k × ATR_14)
      Equalises dollar-risk per trade across volatility regimes.

    Allocation cap: never more than `max_position_pct` of equity.
    """
    from strategy_config import get_strategy_params
    acct = _get_client().get_account()
    equity = float(acct.equity)
    params = get_strategy_params()

    max_pct = params["max_position_pct"] / 100.0
    risk_pct = params["risk_per_trade_pct"] / 100.0
    alloc_shares = int((equity * max_pct) / entry_price)

    target_vol = params.get("target_vol_per_position_pct")
    if target_vol and vol_20d_pct and vol_20d_pct > 0:
        target_frac = float(target_vol) / 100.0
        vol_frac = float(vol_20d_pct) / 100.0
        primary = int((equity * target_frac) / (entry_price * vol_frac))
    elif atr and atr > 0:
        k = params.get("atr_stop_multiple", 2.0)
        primary = int((equity * risk_pct) / (k * atr))
    else:
        stop_pct = params["trailing_stop_pct"] / 100.0
        primary = int((equity * risk_pct) / (entry_price * stop_pct))

    shares = min(primary, alloc_shares)

    # Subtract existing position
    try:
        pos = _get_client().get_open_position(symbol)
        existing = int(float(pos.qty))
        shares = max(0, shares - existing)
    except Exception:
        pass

    return max(0, shares)


def place_limit_order(
    symbol: str,
    qty: float,
    side: str,
    limit_price: float,
    client_order_id: str | None = None,
) -> dict:
    """Place a limit order, optionally with a caller-supplied idempotency ID.

    The fifth argument is optional for backwards compatibility.  When omitted,
    Alpaca generates the client order ID exactly as before.
    """
    order_side = OrderSide.BUY if side.lower() == "buy" else OrderSide.SELL
    request_kwargs = dict(
        symbol=symbol,
        qty=qty,
        side=order_side,
        type="limit",
        time_in_force=TimeInForce.DAY,
        limit_price=round(limit_price, 2),
    )
    if client_order_id is not None:
        request_kwargs["client_order_id"] = client_order_id
    request = LimitOrderRequest(**request_kwargs)
    order = _get_client().submit_order(request)
    result = {
        "id": str(order.id),
        "symbol": order.symbol,
        "side": str(order.side),
        "qty": str(order.qty),
        "limit_price": str(order.limit_price),
        "status": str(order.status),
        "created_at": str(order.created_at),
    }
    log.info(f"Order placed: {side.upper()} {qty} {symbol} @ ${limit_price:.2f} (ID: {order.id})")
    return result


def place_trailing_stop(symbol: str, qty: int, trail_percent: float = 8.0) -> dict:
    """Place a trailing stop order."""
    request = TrailingStopOrderRequest(
        symbol=symbol,
        qty=qty,
        side=OrderSide.SELL,
        time_in_force=TimeInForce.GTC,
        trail_percent=str(trail_percent),
    )
    order = _get_client().submit_order(request)
    result = {
        "id": str(order.id),
        "symbol": order.symbol,
        "qty": str(order.qty),
        "trail_percent": trail_percent,
        "status": str(order.status),
    }
    log.info(f"Trailing stop placed: SELL {qty} {symbol} @ {trail_percent}% trail (ID: {order.id})")
    return result


def cancel_all_orders() -> int:
    """Cancel all open orders. Returns count cancelled."""
    _get_client().cancel_orders()
    log.info("All open orders cancelled.")
    return 0


def _order_lifecycle_view(order) -> dict:
    """Normalize the broker order fields used by the execution reconciler."""

    def enum_value(value) -> str:
        return str(getattr(value, "value", value)).lower()

    qty = float(getattr(order, "qty", 0) or 0)
    filled_qty = float(getattr(order, "filled_qty", 0) or 0)
    if (
        not math.isfinite(qty)
        or not math.isfinite(filled_qty)
        or qty < 0
        or filled_qty < 0
        or filled_qty > qty + 1e-9
    ):
        raise ValueError("broker order contains invalid quantity lifecycle")
    return {
        "id": str(order.id),
        "client_order_id": str(getattr(order, "client_order_id", "") or ""),
        "symbol": str(order.symbol),
        "side": enum_value(order.side),
        "type": enum_value(getattr(order, "type", "")),
        "time_in_force": enum_value(getattr(order, "time_in_force", "")),
        "qty": qty,
        "filled_qty": filled_qty,
        "remaining_qty": max(0.0, qty - filled_qty),
        "limit_price": (
            float(order.limit_price)
            if getattr(order, "limit_price", None) is not None
            else None
        ),
        "status": enum_value(order.status),
    }


def list_open_orders() -> list[dict]:
    """Return the complete lifecycle view needed by target rebalancing.

    Exceptions deliberately propagate.  The caller must fail closed when the
    broker cannot provide a trustworthy open-order snapshot; treating an API
    failure as an empty book can submit duplicate orders.
    """

    request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
    orders = _get_client().get_orders(filter=request)
    return [_order_lifecycle_view(order) for order in orders]


def get_order_by_client_order_id(client_order_id: str) -> dict | None:
    """Resolve a prior idempotent submission, returning ``None`` on 404 only."""

    try:
        order = _get_client().get_order_by_client_id(client_order_id)
    except Exception as exc:
        status_code = getattr(exc, "status_code", None)
        message = str(exc).lower()
        if status_code == 404 or "order not found" in message:
            return None
        raise
    return _order_lifecycle_view(order)


def cancel_open_order(order_id: str) -> None:
    """Request cancellation of one known open order.

    Confirmation is intentionally the caller's responsibility: the adaptive
    executor fetches a second open-order snapshot and never submits a
    conflicting target order in the cancellation run.
    """

    _get_client().cancel_order_by_id(order_id)
    log.info(f"Order cancellation requested: {order_id}")


def close_position(
    symbol: str,
    price_override: float | None = None,
    *,
    client_order_id: str | None = None,
) -> dict:
    """Close an entire long or short position via a limit order.

    Longs sell near the bid; shorts buy to cover near the ask.  Existing
    same-side close orders are reconciled before another order is submitted.
    Use ``price_override`` to skip the quote.
    """
    try:
        pos = _get_client().get_open_position(symbol)
        raw_qty = round(float(pos.qty), 9)
        if not math.isfinite(raw_qty):
            raise ValueError("position quantity is non-finite")
        if raw_qty == 0:
            return {"symbol": symbol, "status": "no_position", "side": None}
        close_side = "buy" if raw_qty < 0 else "sell"
        absolute_qty = abs(raw_qty)
        qty: int | float = (
            int(round(absolute_qty))
            if abs(absolute_qty - round(absolute_qty)) < 1e-9
            else absolute_qty
        )

        pending_closes = [
            order
            for order in list_open_orders()
            if order["symbol"] == symbol
            and order["side"] == close_side
            and order["remaining_qty"] > 0
        ]
        if pending_closes:
            pending_qty = sum(
                order["remaining_qty"] for order in pending_closes
            )
            if pending_qty > float(qty) + 1e-9:
                raise ValueError(
                    f"pending {close_side} quantity exceeds open position"
                )
            return {
                "symbol": symbol,
                "status": "pending",
                "side": close_side,
                "qty": qty,
                "pending_order_ids": [order["id"] for order in pending_closes],
                "pending_qty": pending_qty,
            }

        if price_override is not None:
            reference = float(price_override)
        else:
            from research import get_latest_quote
            quote = get_latest_quote(symbol)
            if close_side == "buy":
                reference = quote["ask"] if quote["ask"] > 0 else quote["mid"]
                reference = float(reference) * 1.001
            else:
                reference = quote["bid"] if quote["bid"] > 0 else quote["mid"]
                reference = float(reference) * 0.999
        if not math.isfinite(reference) or reference <= 0:
            raise ValueError("close limit reference price is invalid")
        limit_price = round(reference, 2)

        order = place_limit_order(
            symbol,
            qty,
            close_side,
            limit_price,
            client_order_id=client_order_id,
        )
        log.info(
            f"Close submitted: {close_side.upper()} {qty} {symbol} "
            f"@ ${limit_price:.2f}"
        )
        return {"symbol": symbol, "status": "submitted", "order_id": order["id"],
                "side": close_side, "qty": qty, "price": limit_price}
    except Exception as e:
        log.error(f"Failed to close {symbol}: {e}")
        return {"symbol": symbol, "status": "error", "error": str(e)}


def sync_trailing_stops(dry_run: bool = False) -> list[dict]:
    """Place trailing stops for any filled positions that don't have one.

    Uses regime-adaptive trail_pct from strategy_config (8% default in
    NORMAL/BULL, 5–6% in CAUTIOUS/BEAR).

    Infrastructure positions (SPY/SSO/TQQQ base + SH hedge) are skipped —
    they're regime-driven and managed by their own functions, not by
    trailing stops. Matches the backtest engine's is_base/is_hedge skip.
    """
    from strategy_config import get_strategy_params
    params = get_strategy_params()
    trail_pct = params["trailing_stop_pct"]

    positions = _get_client().get_all_positions()
    if not positions:
        return []

    request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
    open_orders = _get_client().get_orders(filter=request)
    symbols_with_stops = set()
    for o in open_orders:
        if o.side == OrderSide.SELL and o.type == OrderType.TRAILING_STOP:
            symbols_with_stops.add(o.symbol)

    # Infrastructure positions exempt from trailing stops
    _INFRASTRUCTURE = {"SPY", "SSO", "TQQQ", "UPRO", "SH"}

    results = []
    for p in positions:
        symbol = p.symbol
        qty = int(float(p.qty))
        if symbol in _INFRASTRUCTURE:
            continue
        if symbol in symbols_with_stops:
            continue
        if qty <= 0:
            continue

        if dry_run:
            results.append({
                "symbol": symbol,
                "qty": qty,
                "trail_pct": trail_pct,
                "action": "DRY_RUN_SYNC_STOP",
            })
            continue

        try:
            stop = place_trailing_stop(symbol, qty, trail_percent=trail_pct)
            log.info(f"Synced trailing stop for {symbol}: {qty} shares @ {trail_pct}% trail")
            results.append({"symbol": symbol, "qty": qty, "stop_id": stop["id"], "trail_pct": trail_pct})
        except Exception as e:
            log.error(f"Failed to place trailing stop for {symbol}: {e}")
            results.append({"symbol": symbol, "error": str(e)})

    return results


def execute_stop_losses(dry_run: bool = False) -> list[dict]:
    """Manual hard stop-loss for positions whose unrealized loss exceeds the trail percent.

    Infrastructure positions (SPY/SSO/TQQQ base + SH hedge) are skipped —
    they're regime-driven and managed by their dedicated functions, which
    have their own circuit-breaker logic.
    """
    from strategy_config import get_strategy_params
    params = get_strategy_params()
    stop_pct = params["trailing_stop_pct"]

    positions = _get_client().get_all_positions()
    actions = []
    _INFRASTRUCTURE = {"SPY", "SSO", "TQQQ", "UPRO", "SH"}

    for p in positions:
        if p.symbol in _INFRASTRUCTURE:
            continue
        pnl_pct = float(p.unrealized_plpc) * 100
        if pnl_pct <= -stop_pct:
            log.warning(f"Stop-loss triggered for {p.symbol}: {pnl_pct:.2f}% (limit -{stop_pct}%)")
            if dry_run:
                actions.append({
                    "symbol": p.symbol,
                    "action": "DRY_RUN_STOP_LOSS",
                    "reason": f"Stop-loss at {pnl_pct:.2f}%",
                })
                continue
            result = close_position(p.symbol)
            result["reason"] = f"Stop-loss at {pnl_pct:.2f}%"
            actions.append(result)

    return actions


def main(argv: list[str] | None = None) -> int:
    """Trade utility CLI; every mutating command is paper-opt-in only."""

    args = list(sys.argv[1:] if argv is None else argv)
    cmd = args[0] if args else "market"
    if cmd in {"stops", "cancel", "sync-stops"} and (
        os.getenv("TRADING_MODE", "").strip().lower() != "paper"
    ):
        print(
            "Trading disabled: set TRADING_MODE=paper for mutating trade commands.",
            file=sys.stderr,
        )
        return 2

    if cmd == "market":
        status = get_market_status()
        print("\nMarket Status:")
        print(f"  Open: {'YES' if status['is_open'] else 'NO'}")
        print(f"  Next Open:  {status['next_open']}")
        print(f"  Next Close: {status['next_close']}")

    elif cmd == "stops":
        actions = execute_stop_losses()
        if actions:
            print("\nStop-losses executed:")
            for a in actions:
                print(f"  {a['symbol']}: {a.get('reason', 'closed')}")
        else:
            print("\nNo stop-losses triggered.")

    elif cmd == "cancel":
        cancel_all_orders()
        print("All open orders cancelled.")

    elif cmd == "sync-stops":
        results = sync_trailing_stops()
        if results:
            print("\nTrailing stops synced:")
            for r in results:
                if "error" in r:
                    print(f"  {r['symbol']}: ERROR — {r['error']}")
                else:
                    print(f"  {r['symbol']}: {r['qty']} shares @ 8% trail (ID: {r['stop_id']})")
        else:
            print("\nAll positions already have trailing stops.")

    elif cmd == "validate" and len(args) >= 5:
        symbol = args[1].upper()
        qty = float(args[2])
        side = args[3].lower()
        price = float(args[4])
        result = validate_order(symbol, qty, side, price)
        print(f"\nOrder Validation: {symbol} {side.upper()} {qty} @ ${price:.2f}")
        print(f"  Valid: {'YES' if result['valid'] else 'NO'}")
        print(f"  Order Value: ${result['order_value']:,.2f}")
        print(f"  Risk Tier: {result['risk_tier']}")
        if result['reasons']:
            print("  Rejection Reasons:")
            for r in result['reasons']:
                print(f"    - {r}")

    else:
        print("Usage: python3 trade.py [market|stops|sync-stops|cancel|validate SYMBOL QTY SIDE PRICE]")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
