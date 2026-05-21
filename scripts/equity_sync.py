"""Sync Alpaca portfolio history into Supabase.

Fixes the flat equity chart (DEF-01): the dashboard equity curve is driven
by `equity_snapshots`, which this script populates from Alpaca's own
Portfolio History — the real, retroactive daily equity for each account.

Usage:
    python3 scripts/equity_sync.py backfill     # full history, all accounts
    python3 scripts/equity_sync.py sync         # history + cash flows (daily)
    python3 scripts/equity_sync.py cash-flows   # deposits / withdrawals only
"""

import sys
from datetime import datetime, timezone

import requests

from supabase_client import (
    get_account_credentials,
    get_active_accounts,
    supabase_configured,
    upsert_cash_flows,
    upsert_equity_snapshots,
)
from utils import setup_logging

log = setup_logging("equity_sync")

PAPER_BASE = "https://paper-api.alpaca.markets/v2"
LIVE_BASE = "https://api.alpaca.markets/v2"


def _base(mode: str) -> str:
    return LIVE_BASE if mode == "live" else PAPER_BASE


def _headers(key: str, secret: str) -> dict:
    return {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}


def _history_to_rows(account_id: str, hist: dict) -> list[dict]:
    """Map an Alpaca portfolio-history payload to equity_snapshots rows."""
    ts = hist.get("timestamp", []) or []
    equity = hist.get("equity", []) or []
    pl = hist.get("profit_loss", []) or []
    plpc = hist.get("profit_loss_pct", []) or []

    by_date: dict[str, dict] = {}
    for i, t in enumerate(ts):
        eq = equity[i] if i < len(equity) else None
        if eq is None or eq <= 0:
            continue
        day = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")
        by_date[day] = {
            "account_id": account_id,
            "snapshot_date": day,
            "equity": round(float(eq), 2),
            # Portfolio history carries no per-day cash/positions; the daily
            # agent run records those accurately for current days.
            "cash": 0,
            "profit_loss": (
                round(float(pl[i]), 2) if i < len(pl) and pl[i] is not None else None
            ),
            "profit_loss_pct": (
                round(float(plpc[i]), 6)
                if i < len(plpc) and plpc[i] is not None
                else None
            ),
            "source": "alpaca_portfolio_history",
        }
    return list(by_date.values())


def backfill_equity(account: dict) -> int:
    """Pull the account's full Alpaca portfolio history into equity_snapshots."""
    key, secret = get_account_credentials(account["id"])
    res = requests.get(
        f"{_base(account['mode'])}/account/portfolio/history",
        params={"period": "all", "timeframe": "1D"},
        headers=_headers(key, secret),
        timeout=30,
    )
    res.raise_for_status()
    rows = _history_to_rows(account["id"], res.json())
    upsert_equity_snapshots(rows)
    log.info(
        "account %s — backfilled %d equity snapshots",
        account.get("nickname"),
        len(rows),
    )
    return len(rows)


def sync_today(account: dict) -> int:
    """Refresh recent equity. Portfolio history (period=all) already includes
    today, and the upsert is idempotent, so this reuses the backfill."""
    return backfill_equity(account)


def sync_cash_flows(account: dict) -> int:
    """Pull cash deposits / withdrawals into cash_flows for TWR adjustment."""
    key, secret = get_account_credentials(account["id"])
    res = requests.get(
        f"{_base(account['mode'])}/account/activities",
        params={"activity_types": "CSD,CSW"},
        headers=_headers(key, secret),
        timeout=30,
    )
    res.raise_for_status()
    rows = []
    for act in res.json() or []:
        kind = "deposit" if act.get("activity_type") == "CSD" else "withdrawal"
        amount = abs(float(act.get("net_amount", 0) or 0))
        if kind == "withdrawal":
            amount = -amount
        flow_date = act.get("date") or (act.get("transaction_time") or "")[:10]
        if not flow_date:
            continue
        rows.append(
            {
                "account_id": account["id"],
                "flow_date": flow_date,
                "amount": round(amount, 2),
                "kind": kind,
                "source": "alpaca_activities",
                "external_id": act.get("id"),
            }
        )
    upsert_cash_flows(rows)
    log.info(
        "account %s — synced %d cash flows", account.get("nickname"), len(rows)
    )
    return len(rows)


def main() -> None:
    if not supabase_configured():
        log.error(
            "Supabase not configured — set SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY"
        )
        sys.exit(1)

    cmd = sys.argv[1] if len(sys.argv) > 1 else "sync"
    accounts = get_active_accounts()
    if not accounts:
        log.info("no active accounts to sync")
        return

    for account in accounts:
        try:
            if cmd in ("backfill", "sync"):
                backfill_equity(account)
            if cmd in ("sync", "cash-flows"):
                sync_cash_flows(account)
        except Exception as exc:  # isolation — one account must not block others
            log.error("account %s failed: %s", account.get("nickname"), exc)


if __name__ == "__main__":
    main()
