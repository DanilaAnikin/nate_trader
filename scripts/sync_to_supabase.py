"""Mirror live Alpaca account state into Supabase for the dashboard.

This is the safe half of the multi-account migration (the "write to Supabase"
side of dual-write): standalone, read-then-write telemetry. It does NOT place
orders or change any trading behaviour — it reads each active account from
Alpaca and writes performance, positions and the equity curve into Supabase
so the dashboard shows real, per-account data.

Usage:
    python3 scripts/sync_to_supabase.py
"""

import sys
from datetime import datetime, timezone

from accounts import iter_account_contexts
from equity_sync import backfill_equity, sync_cash_flows
from supabase_client import (
    insert_routine_run,
    replace_positions,
    supabase_configured,
    upsert_performance,
)
from utils import setup_logging

log = setup_logging("sync_to_supabase")


def _position_rows(account_id: str, raw_positions) -> list[dict]:
    rows = []
    for p in raw_positions:
        qty = float(p.qty)
        is_short = str(p.side).lower().endswith("short") or qty < 0
        rows.append(
            {
                "account_id": account_id,
                "symbol": p.symbol,
                "qty": abs(qty),
                "side": "short" if is_short else "long",
                "avg_entry_price": float(p.avg_entry_price),
                "current_price": float(p.current_price),
                "market_value": float(p.market_value),
                "cost_basis": (
                    float(p.cost_basis) if p.cost_basis is not None else None
                ),
                "unrealized_pl": float(p.unrealized_pl),
                "unrealized_pl_pct": float(p.unrealized_plpc) * 100,
            }
        )
    return rows


def sync_account(ctx) -> None:
    """Mirror one account's live Alpaca state into Supabase."""
    acct = ctx.client.get_account()
    raw_positions = ctx.client.get_all_positions()

    equity = float(acct.equity)
    cash = float(acct.cash)
    last_equity = float(acct.last_equity or equity)
    daily_pnl = equity - last_equity
    position_value = sum(float(p.market_value) for p in raw_positions)

    upsert_performance(
        {
            "account_id": ctx.id,
            "equity": round(equity, 2),
            "cash": round(cash, 2),
            "cash_pct": round(cash / equity * 100, 6) if equity > 0 else 0,
            "position_value": round(position_value, 2),
            "num_positions": len(raw_positions),
            "daily_pnl": round(daily_pnl, 2),
            "daily_pnl_pct": (
                round(daily_pnl / last_equity * 100, 6) if last_equity > 0 else 0
            ),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    )

    replace_positions(ctx.id, _position_rows(ctx.id, raw_positions))

    # Keep the equity curve and cash flows fresh (idempotent upserts).
    backfill_equity(ctx.row)
    sync_cash_flows(ctx.row)

    log.info(
        "synced %s — equity $%.2f, %d positions",
        ctx.nickname,
        equity,
        len(raw_positions),
    )


def main() -> None:
    if not supabase_configured():
        log.error(
            "Supabase not configured — set SUPABASE_URL and "
            "SUPABASE_SERVICE_ROLE_KEY"
        )
        sys.exit(1)

    started = datetime.now(timezone.utc)
    synced = 0
    failed = 0
    for ctx in iter_account_contexts():
        try:
            sync_account(ctx)
            synced += 1
        except Exception as exc:  # isolation — one account never blocks others
            failed += 1
            log.error("account %s sync failed: %s", ctx.nickname, exc)

    finished = datetime.now(timezone.utc)
    try:
        insert_routine_run(
            {
                "kind": "heartbeat",
                "status": "success" if failed == 0 else "partial",
                "started_at": started.isoformat(),
                "finished_at": finished.isoformat(),
                "duration_ms": int((finished - started).total_seconds() * 1000),
                "summary": {"accounts_synced": synced, "accounts_failed": failed},
            }
        )
    except Exception as exc:
        log.error("routine_run insert failed: %s", exc)

    log.info("sync complete — %d ok, %d failed", synced, failed)


if __name__ == "__main__":
    main()
