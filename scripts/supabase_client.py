"""Service-role Supabase client for the Nate Trader agent.

Centralises every Supabase interaction the routines need. Uses the
service-role key, so it bypasses RLS — this module must only ever run
server-side (GitHub Actions / local agent), never in a browser.

Phase 5 introduces the equity/cash-flow helpers; Phase 6 extends this with
performance, positions, trades and routine-run helpers.
"""

import os

from dotenv import load_dotenv

try:
    from supabase import Client, create_client
except ImportError:  # pragma: no cover - dependency not yet installed
    Client = None  # type: ignore
    create_client = None  # type: ignore

from utils import PROJECT_ROOT

load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

_client = None


def supabase_configured() -> bool:
    """True when the Supabase env vars are present."""
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def get_service_client():
    """Return a cached service-role Supabase client."""
    global _client
    if _client is None:
        if create_client is None:
            raise RuntimeError("the `supabase` package is not installed")
        if not supabase_configured():
            raise RuntimeError(
                "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set"
            )
        _client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    return _client


# --- accounts ---------------------------------------------------------------

def get_active_accounts() -> list[dict]:
    """Every active, non-deleted account."""
    sb = get_service_client()
    res = (
        sb.table("accounts")
        .select("*")
        .eq("is_active", True)
        .is_("deleted_at", "null")
        .order("created_at")
        .execute()
    )
    return res.data or []


def get_account_credentials(account_id: str) -> tuple[str, str]:
    """Decrypt an account's Alpaca key pair via the service-role-only RPC."""
    sb = get_service_client()
    res = sb.rpc("get_account_credentials", {"acct": account_id}).execute()
    rows = res.data or []
    if not rows:
        raise RuntimeError(f"no stored credentials for account {account_id}")
    row = rows[0]
    return row["api_key"], row["api_secret"]


# --- equity / cash flows ----------------------------------------------------

def upsert_equity_snapshots(rows: list[dict]) -> int:
    """Upsert equity_snapshots rows, keyed by (account_id, snapshot_date)."""
    if not rows:
        return 0
    sb = get_service_client()
    sb.table("equity_snapshots").upsert(
        rows, on_conflict="account_id,snapshot_date"
    ).execute()
    return len(rows)


def upsert_cash_flows(rows: list[dict]) -> int:
    """Upsert cash_flows rows, keyed by (account_id, external_id)."""
    if not rows:
        return 0
    sb = get_service_client()
    sb.table("cash_flows").upsert(
        rows, on_conflict="account_id,external_id"
    ).execute()
    return len(rows)


# --- performance / positions ------------------------------------------------

def upsert_performance(row: dict) -> None:
    """Upsert the singleton performance row for an account."""
    sb = get_service_client()
    sb.table("performance").upsert(row, on_conflict="account_id").execute()


def replace_positions(account_id: str, rows: list[dict]) -> int:
    """Replace an account's open positions with the supplied set."""
    sb = get_service_client()
    sb.table("positions").delete().eq("account_id", account_id).execute()
    if rows:
        sb.table("positions").insert(rows).execute()
    return len(rows)


def upsert_trades(rows: list[dict]) -> int:
    """Upsert trade-fill rows, keyed by (account_id, alpaca_order_id)."""
    if not rows:
        return 0
    sb = get_service_client()
    sb.table("trades").upsert(
        rows, on_conflict="account_id,alpaca_order_id"
    ).execute()
    return len(rows)


# --- routine telemetry ------------------------------------------------------

def insert_routine_run(row: dict) -> None:
    """Record one routine execution in routine_runs."""
    sb = get_service_client()
    sb.table("routine_runs").insert(row).execute()
