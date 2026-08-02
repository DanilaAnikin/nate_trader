"""Portfolio management — account, positions, P&L, state persistence."""

import math
import sys
from datetime import datetime, timezone
from alpaca.trading.client import TradingClient
from alpaca.trading.requests import GetOrdersRequest
from alpaca.trading.enums import QueryOrderStatus

from utils import (
    ALPACA_API_KEY, ALPACA_SECRET_KEY,
    POSITIONS_STATE, PERFORMANCE_STATE,
    EDT, setup_logging, get_now_str, load_json, save_json, get_risk_tier,
)
from risk_policy import assess_portfolio_risk

log = setup_logging("portfolio")

_client: "TradingClient | None" = None


def _get_client() -> TradingClient:
    """Lazily build the Alpaca client so importing this module never requires
    credentials — keeps sanity checks and unit tests importable without keys."""
    global _client
    if _client is None:
        _client = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)
    return _client


def __getattr__(name: str):
    if name == "client":
        return _get_client()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def get_account() -> dict:
    """Get account summary."""
    acct = _get_client().get_account()
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


def get_recent_equity_history(max_observations: int = 22) -> list[float]:
    """Fetch recent daily broker equity observations for the rolling risk gate.

    This intentionally reads Alpaca rather than ``state/performance.json`` so
    missed scheduler runs cannot make the live drawdown window stale.  Any API
    or schema failure propagates and causes the execution entry gate to fail
    closed while leaving risk-reducing exits available.
    """

    if type(max_observations) is not int or max_observations < 1:
        raise ValueError("max_observations must be a positive integer")
    payload = _get_client().get(
        "/v2/account/portfolio/history",
        {"period": "3M", "timeframe": "1D", "extended_hours": False},
    )
    if not isinstance(payload, dict):
        raise ValueError("Alpaca portfolio history response is not an object")
    raw_equities = payload.get("equity")
    raw_timestamps = payload.get("timestamp")
    if not isinstance(raw_equities, list):
        raise ValueError("Alpaca portfolio history has no equity array")
    if not isinstance(raw_timestamps, list) or len(raw_timestamps) != len(
        raw_equities
    ):
        raise ValueError("Alpaca portfolio history timestamps are missing or misaligned")
    today = datetime.now(EDT).date()
    equities: list[float] = []
    for raw_timestamp, raw in zip(raw_timestamps, raw_equities, strict=True):
        try:
            if isinstance(raw_timestamp, (int, float)):
                observation_date = datetime.fromtimestamp(
                    float(raw_timestamp), timezone.utc
                ).date()
            else:
                observation_date = datetime.fromisoformat(
                    str(raw_timestamp).replace("Z", "+00:00")
                ).date()
        except (OSError, OverflowError, TypeError, ValueError) as exc:
            raise ValueError(
                "Alpaca portfolio history contains invalid timestamp"
            ) from exc
        # The current account equity is appended separately by the shared risk
        # policy.  Excluding today's history bucket prevents counting the same
        # in-progress session twice.
        if observation_date >= today:
            continue
        if raw is None:
            continue
        try:
            equity = float(raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("Alpaca portfolio history contains invalid equity") from exc
        if not math.isfinite(equity):
            raise ValueError("Alpaca portfolio history contains non-finite equity")
        if equity > 0:
            equities.append(equity)
    if not equities:
        raise ValueError("Alpaca portfolio history has no positive equity observations")
    return equities[-max_observations:]


def get_positions() -> list[dict]:
    """Get all open positions."""
    positions = _get_client().get_all_positions()
    result = []
    for p in positions:
        row = {
            "symbol": p.symbol,
            "qty": float(p.qty),
            "avg_entry_price": float(p.avg_entry_price),
            "current_price": float(p.current_price),
            "market_value": float(p.market_value),
            "unrealized_pl": float(p.unrealized_pl),
            "unrealized_plpc": float(p.unrealized_plpc) * 100,
            "side": str(p.side),
        }
        numeric = (
            row["qty"],
            row["avg_entry_price"],
            row["current_price"],
            row["market_value"],
            row["unrealized_pl"],
            row["unrealized_plpc"],
        )
        if not all(math.isfinite(float(value)) for value in numeric):
            raise ValueError(f"broker position {p.symbol} contains non-finite values")
        if (
            row["qty"] == 0
            or row["avg_entry_price"] <= 0
            or row["current_price"] <= 0
        ):
            raise ValueError(f"broker position {p.symbol} contains invalid prices/qty")
        result.append(row)
    return result


def get_open_orders() -> list[dict]:
    """Get all open orders."""
    request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
    orders = _get_client().get_orders(filter=request)
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
        p = _get_client().get_open_position(symbol)
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
        "last_equity": acct["last_equity"],
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

    # Track daily P&L history — equity + cash + num_positions per day so the
    # dashboard can render all three curves on the same chart
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
            entry["cash"] = current["cash"]
            entry["num_positions"] = current["num_positions"]
            updated = True
            break
    if not updated:
        history.append({
            "date": today,
            "pnl": current["daily_pnl"],
            "pnl_pct": current["daily_pnl_pct"],
            "equity": current["equity"],
            "cash": current["cash"],
            "num_positions": current["num_positions"],
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

    # A rolling monthly peak avoids the old permanent half-exposure lock after
    # an ancient high-water mark, while current-day -5%/-8% breakers remain.
    prior_equities = [
        entry.get("equity")
        for entry in history
        if entry.get("date") != today
    ]
    assessment = assess_portfolio_risk(
        current["equity"],
        previous_equity=current["last_equity"],
        prior_equities=prior_equities,
    )
    perf["risk_tier"] = assessment.tier
    perf["risk_lookback_sessions"] = assessment.lookback_sessions
    perf["rolling_peak_equity"] = assessment.rolling_peak_equity
    perf["rolling_drawdown_pct"] = assessment.rolling_drawdown_pct

    save_json(PERFORMANCE_STATE, perf)
    log.info(f"Updated performance state (risk_tier={perf.get('risk_tier', 'NORMAL')})")


def print_account():
    acct = get_account()
    print(f"\n{'='*50}")
    print("  ACCOUNT SUMMARY")
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
    print("  PERFORMANCE")
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
        print("Usage: python3 portfolio.py [account|positions|performance|orders|save]")
