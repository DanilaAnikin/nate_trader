"""Portfolio management — account, positions, P&L, state persistence."""

import sys
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import GetOrdersRequest
from alpaca.trading.enums import QueryOrderStatus

from utils import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY,
    POSITIONS_STATE, PERFORMANCE_STATE,
    setup_logging, get_now_str, load_json, save_json, get_risk_tier,
)

log = setup_logging("portfolio")

client = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)


def get_account() -> dict:
    """Get account summary."""
    acct = client.get_account()
    return {
        "equity": float(acct.equity),
        "cash": float(acct.cash),
        "buying_power": float(acct.buying_power),
        "portfolio_value": float(acct.portfolio_value),
        "daily_pnl": float(acct.equity) - float(acct.last_equity),
        "daily_pnl_pct": ((float(acct.equity) - float(acct.last_equity)) / float(acct.last_equity) * 100)
        if float(acct.last_equity) > 0 else 0.0,
        "last_equity": float(acct.last_equity),
        "cash_pct": float(acct.cash) / float(acct.equity) * 100 if float(acct.equity) > 0 else 0.0,
    }


def get_positions() -> list[dict]:
    """Get all open positions."""
    positions = client.get_all_positions()
    result = []
    for p in positions:
        result.append({
            "symbol": p.symbol,
            "qty": float(p.qty),
            "avg_entry_price": float(p.avg_entry_price),
            "current_price": float(p.current_price),
            "market_value": float(p.market_value),
            "unrealized_pl": float(p.unrealized_pl),
            "unrealized_plpc": float(p.unrealized_plpc) * 100,
            "side": str(p.side),
        })
    return result


def get_open_orders() -> list[dict]:
    """Get all open orders."""
    request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
    orders = client.get_orders(filter=request)
    result = []
    for o in orders:
        result.append({
            "id": str(o.id),
            "symbol": o.symbol,
            "side": str(o.side),
            "qty": str(o.qty),
            "type": str(o.type),
            "limit_price": str(o.limit_price) if o.limit_price else None,
            "stop_price": str(o.stop_price) if o.stop_price else None,
            "status": str(o.status),
            "created_at": str(o.created_at),
        })
    return result


def get_position_pnl(symbol: str) -> dict | None:
    """Get P&L for a specific position."""
    try:
        p = client.get_open_position(symbol)
        return {
            "symbol": p.symbol,
            "qty": float(p.qty),
            "avg_entry_price": float(p.avg_entry_price),
            "current_price": float(p.current_price),
            "unrealized_pl": float(p.unrealized_pl),
            "unrealized_plpc": float(p.unrealized_plpc) * 100,
        }
    except Exception:
        return None


def get_portfolio_performance() -> dict:
    """Get portfolio performance metrics."""
    acct = get_account()
    positions = get_positions()
    total_unrealized = sum(p["unrealized_pl"] for p in positions)
    return {
        "equity": acct["equity"],
        "cash": acct["cash"],
        "cash_pct": acct["cash_pct"],
        "daily_pnl": acct["daily_pnl"],
        "daily_pnl_pct": acct["daily_pnl_pct"],
        "total_unrealized_pl": total_unrealized,
        "num_positions": len(positions),
        "risk_tier": get_risk_tier(),
        "updated_at": get_now_str(),
    }


def save_positions_state() -> None:
    """Persist current positions to state/positions.json."""
    positions = get_positions()
    save_json(POSITIONS_STATE, {
        "updated_at": get_now_str(),
        "positions": positions,
    })
    log.info(f"Saved {len(positions)} positions to {POSITIONS_STATE}")


def update_performance_state() -> None:
    """Update state/performance.json with current metrics."""
    perf = load_json(PERFORMANCE_STATE)
    current = get_portfolio_performance()

    perf["equity"] = current["equity"]
    perf["cash"] = current["cash"]
    perf["cash_pct"] = current["cash_pct"]
    perf["daily_pnl"] = current["daily_pnl"]
    perf["daily_pnl_pct"] = current["daily_pnl_pct"]
    perf["num_positions"] = current["num_positions"]
    perf["updated_at"] = current["updated_at"]

    # Track daily P&L history
    history = perf.get("daily_history", [])
    from utils import get_today_str
    today = get_today_str()
    # Update or append today's entry
    updated = False
    for entry in history:
        if entry.get("date") == today:
            entry["pnl"] = current["daily_pnl"]
            entry["pnl_pct"] = current["daily_pnl_pct"]
            entry["equity"] = current["equity"]
            updated = True
            break
    if not updated:
        history.append({
            "date": today,
            "pnl": current["daily_pnl"],
            "pnl_pct": current["daily_pnl_pct"],
            "equity": current["equity"],
        })
    perf["daily_history"] = history

    # Calculate weekly and monthly P&L from history
    if len(history) >= 2:
        week_entries = history[-5:] if len(history) >= 5 else history
        week_start_equity = week_entries[0].get("equity", current["equity"])
        perf["weekly_pnl"] = current["equity"] - week_start_equity
        perf["weekly_pnl_pct"] = (perf["weekly_pnl"] / week_start_equity * 100) if week_start_equity > 0 else 0.0

        month_entries = history[-22:] if len(history) >= 22 else history
        month_start_equity = month_entries[0].get("equity", current["equity"])
        perf["monthly_pnl"] = current["equity"] - month_start_equity
        perf["monthly_pnl_pct"] = (perf["monthly_pnl"] / month_start_equity * 100) if month_start_equity > 0 else 0.0

    # Auto-adjust risk tier
    weekly_pnl_pct = perf.get("weekly_pnl_pct", 0.0)
    monthly_pnl_pct = perf.get("monthly_pnl_pct", 0.0)
    if monthly_pnl_pct <= -5.0:
        perf["risk_tier"] = "HALT"
    elif weekly_pnl_pct <= -2.0:
        perf["risk_tier"] = "CAUTIOUS"

    save_json(PERFORMANCE_STATE, perf)
    log.info(f"Updated performance state (risk_tier={perf.get('risk_tier', 'NORMAL')})")


def print_account():
    acct = get_account()
    print(f"\n{'='*50}")
    print(f"  ACCOUNT SUMMARY")
    print(f"{'='*50}")
    print(f"  Equity:       ${acct['equity']:>12,.2f}")
    print(f"  Cash:         ${acct['cash']:>12,.2f} ({acct['cash_pct']:.1f}%)")
    print(f"  Buying Power: ${acct['buying_power']:>12,.2f}")
    print(f"  Daily P&L:    ${acct['daily_pnl']:>12,.2f} ({acct['daily_pnl_pct']:+.2f}%)")
    print(f"  Risk Tier:    {get_risk_tier()}")
    print(f"{'='*50}\n")


def print_positions():
    positions = get_positions()
    if not positions:
        print("\nNo open positions.\n")
        return
    print(f"\n{'='*80}")
    print(f"  OPEN POSITIONS ({len(positions)})")
    print(f"{'='*80}")
    print(f"  {'Symbol':<8} {'Qty':>6} {'Entry':>10} {'Current':>10} {'P&L':>10} {'P&L%':>8}")
    print(f"  {'-'*8} {'-'*6} {'-'*10} {'-'*10} {'-'*10} {'-'*8}")
    for p in positions:
        print(f"  {p['symbol']:<8} {p['qty']:>6.0f} ${p['avg_entry_price']:>9,.2f} ${p['current_price']:>9,.2f} ${p['unrealized_pl']:>9,.2f} {p['unrealized_plpc']:>+7.2f}%")
    print(f"{'='*80}\n")


def print_orders():
    orders = get_open_orders()
    if not orders:
        print("\nNo open orders.\n")
        return
    print(f"\n{'='*80}")
    print(f"  OPEN ORDERS ({len(orders)})")
    print(f"{'='*80}")
    for o in orders:
        print(f"  {o['symbol']} {o['side']} {o['qty']} @ {o['limit_price'] or o['stop_price']} ({o['type']}) - {o['status']}")
    print(f"{'='*80}\n")


def print_performance():
    perf = get_portfolio_performance()
    print(f"\n{'='*50}")
    print(f"  PERFORMANCE")
    print(f"{'='*50}")
    print(f"  Equity:       ${perf['equity']:>12,.2f}")
    print(f"  Cash:         ${perf['cash']:>12,.2f} ({perf['cash_pct']:.1f}%)")
    print(f"  Daily P&L:    ${perf['daily_pnl']:>12,.2f} ({perf['daily_pnl_pct']:+.2f}%)")
    print(f"  Unrealized:   ${perf['total_unrealized_pl']:>12,.2f}")
    print(f"  Positions:    {perf['num_positions']}")
    print(f"  Risk Tier:    {perf['risk_tier']}")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "account"

    if cmd == "account":
        print_account()
    elif cmd == "positions":
        print_positions()
    elif cmd == "performance":
        print_performance()
    elif cmd == "orders":
        print_orders()
    elif cmd == "save":
        save_positions_state()
        update_performance_state()
        print("State saved.")
    else:
        print(f"Usage: python3 portfolio.py [account|positions|performance|orders|save]")
