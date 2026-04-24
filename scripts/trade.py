"""Trade execution — order validation, placement, stop-losses."""

import sys
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import (
    LimitOrderRequest,
    TrailingStopOrderRequest,
    GetOrdersRequest,
)
from alpaca.trading.enums import OrderSide, TimeInForce, QueryOrderStatus

from utils import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY, PERFORMANCE_STATE,
    setup_logging, get_now_str, load_json, save_json,
    get_risk_tier, get_tradeable_symbols, get_symbol_info,
)

log = setup_logging("trade")

client = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)


def get_market_status() -> dict:
    """Check if the market is open."""
    clock = client.get_clock()
    return {
        "is_open": clock.is_open,
        "next_open": str(clock.next_open),
        "next_close": str(clock.next_close),
        "timestamp": str(clock.timestamp),
    }


def validate_order(symbol: str, qty: float, side: str, price: float) -> dict:
    """Validate an order against all risk rules. Returns {valid: bool, reasons: []}."""
    reasons = []
    acct = client.get_account()
    equity = float(acct.equity)
    cash = float(acct.cash)
    positions = client.get_all_positions()
    risk_tier = get_risk_tier()

    # 1. Risk tier check
    if risk_tier == "HALT" and side.lower() == "buy":
        reasons.append(f"HALT mode — no new buys allowed")

    # 2. Cash reserve check (20% minimum)
    order_cost = qty * price
    if side.lower() == "buy":
        remaining_cash = cash - order_cost
        min_cash = equity * 0.20
        if remaining_cash < min_cash:
            reasons.append(f"Would breach 20% cash reserve (remaining: ${remaining_cash:,.2f}, min: ${min_cash:,.2f})")

    # 3. Position size check (5% max, 2.5% if CAUTIOUS)
    max_pct = 2.5 if risk_tier == "CAUTIOUS" else 5.0
    position_value = order_cost
    # Add existing position value if we already hold this
    for p in positions:
        if p.symbol == symbol:
            position_value += float(p.market_value)
            break
    position_pct = (position_value / equity * 100) if equity > 0 else 0
    if position_pct > max_pct:
        reasons.append(f"Position size {position_pct:.1f}% exceeds {max_pct}% limit")

    # 4. Max positions check
    if side.lower() == "buy":
        existing_symbols = {p.symbol for p in positions}
        if symbol not in existing_symbols and len(existing_symbols) >= 10:
            reasons.append(f"Max 10 positions reached ({len(existing_symbols)} open)")

    # 5. Sector concentration check (25% max)
    if side.lower() == "buy":
        symbol_info = get_symbol_info(symbol)
        target_sector = symbol_info.get("sector", "Unknown")
        sector_value = order_cost
        for p in positions:
            p_info = get_symbol_info(p.symbol)
            if p_info.get("sector") == target_sector:
                sector_value += float(p.market_value)
        sector_pct = (sector_value / equity * 100) if equity > 0 else 0
        if sector_pct > 25:
            reasons.append(f"Sector '{target_sector}' would be {sector_pct:.1f}% (max 25%)")

    # 6. Daily loss check
    daily_pnl_pct = ((float(acct.equity) - float(acct.last_equity)) / float(acct.last_equity) * 100) if float(acct.last_equity) > 0 else 0
    if daily_pnl_pct <= -3.0 and side.lower() == "buy":
        reasons.append(f"Daily loss halt triggered ({daily_pnl_pct:.2f}% today)")

    # 7. Symbol must be tradeable
    if symbol not in get_tradeable_symbols():
        reasons.append(f"{symbol} is not in the tradeable watchlist")

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


def calculate_position_size(symbol: str, entry_price: float) -> int:
    """Calculate position size respecting all limits."""
    acct = client.get_account()
    equity = float(acct.equity)
    risk_tier = get_risk_tier()

    # Method 1: 5% allocation limit (2.5% if CAUTIOUS)
    max_pct = 0.025 if risk_tier == "CAUTIOUS" else 0.05
    alloc_shares = int((equity * max_pct) / entry_price)

    # Method 2: Risk-based (0.4% risk with 8% stop)
    risk_shares = int((equity * 0.004) / (entry_price * 0.08))

    # Take the smaller
    shares = min(alloc_shares, risk_shares)

    # Subtract existing position
    try:
        pos = client.get_open_position(symbol)
        existing = int(float(pos.qty))
        shares = max(0, shares - existing)
    except Exception:
        pass

    return max(0, shares)


def place_limit_order(symbol: str, qty: int, side: str, limit_price: float) -> dict:
    """Place a limit order."""
    order_side = OrderSide.BUY if side.lower() == "buy" else OrderSide.SELL
    request = LimitOrderRequest(
        symbol=symbol,
        qty=qty,
        side=order_side,
        type="limit",
        time_in_force=TimeInForce.DAY,
        limit_price=round(limit_price, 2),
    )
    order = client.submit_order(request)
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
    order = client.submit_order(request)
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
    client.cancel_orders()
    log.info("All open orders cancelled.")
    return 0


def close_position(symbol: str) -> dict:
    """Close an entire position."""
    try:
        order = client.close_position(symbol)
        log.info(f"Closed position: {symbol}")
        return {"symbol": symbol, "status": "closed", "order_id": str(order.id)}
    except Exception as e:
        log.error(f"Failed to close {symbol}: {e}")
        return {"symbol": symbol, "status": "error", "error": str(e)}


def execute_stop_losses() -> list[dict]:
    """Check and execute manual stop-losses for positions without trailing stops."""
    positions = client.get_all_positions()
    actions = []

    for p in positions:
        entry = float(p.avg_entry_price)
        current = float(p.current_price)
        pnl_pct = float(p.unrealized_plpc) * 100

        # Check if 8% stop-loss breached
        if pnl_pct <= -8.0:
            log.warning(f"Stop-loss triggered for {p.symbol}: {pnl_pct:.2f}%")
            result = close_position(p.symbol)
            result["reason"] = f"Stop-loss at {pnl_pct:.2f}%"
            actions.append(result)

    return actions


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "market"

    if cmd == "market":
        status = get_market_status()
        print(f"\nMarket Status:")
        print(f"  Open: {'YES' if status['is_open'] else 'NO'}")
        print(f"  Next Open:  {status['next_open']}")
        print(f"  Next Close: {status['next_close']}")

    elif cmd == "stops":
        actions = execute_stop_losses()
        if actions:
            print(f"\nStop-losses executed:")
            for a in actions:
                print(f"  {a['symbol']}: {a.get('reason', 'closed')}")
        else:
            print("\nNo stop-losses triggered.")

    elif cmd == "cancel":
        cancel_all_orders()
        print("All open orders cancelled.")

    elif cmd == "validate" and len(sys.argv) >= 6:
        symbol = sys.argv[2].upper()
        qty = float(sys.argv[3])
        side = sys.argv[4].lower()
        price = float(sys.argv[5])
        result = validate_order(symbol, qty, side, price)
        print(f"\nOrder Validation: {symbol} {side.upper()} {qty} @ ${price:.2f}")
        print(f"  Valid: {'YES' if result['valid'] else 'NO'}")
        print(f"  Order Value: ${result['order_value']:,.2f}")
        print(f"  Risk Tier: {result['risk_tier']}")
        if result['reasons']:
            print(f"  Rejection Reasons:")
            for r in result['reasons']:
                print(f"    - {r}")

    else:
        print("Usage: python3 trade.py [market|stops|cancel|validate SYMBOL QTY SIDE PRICE]")
