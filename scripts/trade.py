"""Trade execution — order validation, placement, stop-losses."""

import sys
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import (
    LimitOrderRequest,
    TrailingStopOrderRequest,
    GetOrdersRequest,
)
from alpaca.trading.enums import OrderSide, OrderType, TimeInForce, QueryOrderStatus

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
    from strategy_config import get_strategy_params
    reasons = []
    acct = client.get_account()
    equity = float(acct.equity)
    cash = float(acct.cash)
    positions = client.get_all_positions()
    risk_tier = get_risk_tier()
    params = get_strategy_params()

    # Identify hedge orders early so we can apply exemptions consistently
    from utils import get_symbol_info as _get_info
    is_hedge_order = _get_info(symbol).get("sector") == "Hedge"

    # 1. Risk tier check — HALT blocks new directional longs, NOT hedges
    if risk_tier == "HALT" and side.lower() == "buy" and not is_hedge_order:
        reasons.append(f"HALT mode — no new directional buys allowed (hedges OK)")

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
        }
        max_positions = params["max_positions"]
        if symbol not in existing_symbols and len(non_hedge_symbols) >= max_positions:
            reasons.append(f"Max {max_positions} positions reached ({len(non_hedge_symbols)} open)")

    # 5. Sector concentration check (25% max) — Hedge sector is exempt
    if side.lower() == "buy" and not is_hedge_order:
        symbol_info = get_symbol_info(symbol)
        target_sector = symbol_info.get("sector", "Unknown")
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
                if p.symbol == symbol:
                    # Already accounted for via order_cost for new shares;
                    # add existing value for total post-trade position
                    sector_value += float(p.market_value)
                    continue
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

    # 7. Symbol must be a valid, tradeable asset on Alpaca
    try:
        asset = client.get_asset(symbol)
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
    acct = client.get_account()
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


def close_position(symbol: str, price_override: float | None = None) -> dict:
    """Close an entire position via limit order (not market order).

    Fetches current bid and places a limit sell at bid * 0.999 to ensure
    fill while staying limit-only. Use price_override to skip the quote.
    """
    try:
        pos = client.get_open_position(symbol)
        qty = int(float(pos.qty))
        if qty <= 0:
            return {"symbol": symbol, "status": "no_position"}

        if price_override:
            limit_price = round(price_override, 2)
        else:
            from research import get_latest_quote
            quote = get_latest_quote(symbol)
            bid = quote["bid"] if quote["bid"] > 0 else quote["mid"]
            limit_price = round(bid * 0.999, 2)

        order = place_limit_order(symbol, qty, "sell", limit_price)
        log.info(f"Closed position: {symbol} — {qty} shares @ ${limit_price:.2f}")
        return {"symbol": symbol, "status": "closed", "order_id": order["id"],
                "qty": qty, "price": limit_price}
    except Exception as e:
        log.error(f"Failed to close {symbol}: {e}")
        return {"symbol": symbol, "status": "error", "error": str(e)}


def sync_trailing_stops() -> list[dict]:
    """Place trailing stops for any filled positions that don't have one.

    Uses regime-adaptive trail_pct from strategy_config (8% default in
    NORMAL/BULL, 5–6% in CAUTIOUS/BEAR).
    """
    from strategy_config import get_strategy_params
    params = get_strategy_params()
    trail_pct = params["trailing_stop_pct"]

    positions = client.get_all_positions()
    if not positions:
        return []

    request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
    open_orders = client.get_orders(filter=request)
    symbols_with_stops = set()
    for o in open_orders:
        if o.side == OrderSide.SELL and o.type == OrderType.TRAILING_STOP:
            symbols_with_stops.add(o.symbol)

    results = []
    for p in positions:
        symbol = p.symbol
        qty = int(float(p.qty))
        if symbol in symbols_with_stops:
            continue
        if qty <= 0:
            continue

        try:
            stop = place_trailing_stop(symbol, qty, trail_percent=trail_pct)
            log.info(f"Synced trailing stop for {symbol}: {qty} shares @ {trail_pct}% trail")
            results.append({"symbol": symbol, "qty": qty, "stop_id": stop["id"], "trail_pct": trail_pct})
        except Exception as e:
            log.error(f"Failed to place trailing stop for {symbol}: {e}")
            results.append({"symbol": symbol, "error": str(e)})

    return results


def execute_stop_losses() -> list[dict]:
    """Manual hard stop-loss for positions whose unrealized loss exceeds the trail percent."""
    from strategy_config import get_strategy_params
    params = get_strategy_params()
    stop_pct = params["trailing_stop_pct"]

    positions = client.get_all_positions()
    actions = []

    for p in positions:
        pnl_pct = float(p.unrealized_plpc) * 100
        if pnl_pct <= -stop_pct:
            log.warning(f"Stop-loss triggered for {p.symbol}: {pnl_pct:.2f}% (limit -{stop_pct}%)")
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

    elif cmd == "sync-stops":
        results = sync_trailing_stops()
        if results:
            print(f"\nTrailing stops synced:")
            for r in results:
                if "error" in r:
                    print(f"  {r['symbol']}: ERROR — {r['error']}")
                else:
                    print(f"  {r['symbol']}: {r['qty']} shares @ 8% trail (ID: {r['stop_id']})")
        else:
            print("\nAll positions already have trailing stops.")

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
        print("Usage: python3 trade.py [market|stops|sync-stops|cancel|validate SYMBOL QTY SIDE PRICE]")
