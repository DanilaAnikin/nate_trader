-- ============================================================================
-- 0011_revoke_client_reads.sql — remove client read access to sensitive tables
--
-- 0009/0010 stopped clients *writing* `accounts`, but a signed-in browser could
-- still `select *` the base table through Supabase REST and read
-- `alpaca_account_number`, both Vault secret UUIDs, `owner_id` and
-- `deleted_at`. The Next.js `SafeAccount` allowlist never protected that path:
-- PostgREST answers the browser directly. The 0009 SELECT policy also did not
-- exclude soft-deleted rows, so a deleted account stayed readable.
--
-- `trades` had the same shape of problem: `alpaca_order_id` is a broker order
-- identifier and was readable by any owner through REST.
--
-- After this migration:
--   * `accounts` and `trades` carry no client privileges at all — every read
--     goes through a Next.js route that verifies the session and ownership
--     explicitly and returns a sanitized DTO;
--   * two sanitized, explicitly-columned views remain available as defence in
--     depth for any future direct client read, both filtering soft-deleted
--     accounts; and
--   * nothing else browser-accessible exposes a broker identifier.
--
-- 0009 and 0010 are already applied in production and are left untouched.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- accounts — no client privileges whatsoever.
--
-- Dropping the policies as well as the grants means a future `grant select`
-- cannot silently re-open the table: RLS would still deny every row.
-- ---------------------------------------------------------------------------
drop policy if exists "read own accounts" on accounts;
drop policy if exists "update own account metadata" on accounts;

revoke all on accounts from authenticated;
revoke all on accounts from anon;

-- ---------------------------------------------------------------------------
-- trades — withhold the broker order identifier.
-- ---------------------------------------------------------------------------
drop policy if exists "read own trades" on trades;
revoke all on trades from authenticated;
revoke all on trades from anon;

-- ---------------------------------------------------------------------------
-- accounts_safe — explicit safe-column view.
--
-- Security-definer (the default for views) so it can read the base table the
-- caller no longer can, while filtering to the caller's own, non-deleted rows.
-- The column list is explicit: adding a sensitive column to `accounts` later
-- cannot leak through this view.
-- ---------------------------------------------------------------------------
create or replace view accounts_safe as
  select
    a.id,
    a.nickname,
    a.mode,
    a.status,
    a.color,
    a.is_active,
    -- Only the last four characters ever leave the database.
    case
      when a.alpaca_account_number is null then null
      when length(a.alpaca_account_number) < 4 then null
      else '••••' || right(a.alpaca_account_number, 4)
    end as broker_account_mask,
    a.last_verified_at,
    a.created_at
  from accounts a
  where a.owner_id = auth.uid()
    and a.deleted_at is null;

revoke all on accounts_safe from public;
grant select on accounts_safe to authenticated;

-- ---------------------------------------------------------------------------
-- trades_safe — the trade log without the broker order identifier, and never
-- for a soft-deleted account.
-- ---------------------------------------------------------------------------
create or replace view trades_safe as
  select
    t.id,
    t.account_id,
    t.symbol,
    t.side,
    t.qty,
    t.price,
    t.notional,
    t.filled_at,
    t.realized_pnl,
    t.realized_pnl_pct,
    t.reason,
    t.strategy,
    t.created_at
  from trades t
  join accounts a on a.id = t.account_id
  where a.owner_id = auth.uid()
    and a.deleted_at is null;

revoke all on trades_safe from public;
grant select on trades_safe to authenticated;

-- ---------------------------------------------------------------------------
-- cash_flows — `external_id` is the Alpaca activity identifier, kept for
-- idempotency. It is a broker-side identifier like `alpaca_order_id`, so it
-- gets the same treatment: the table loses its client grants and a view
-- without that column takes its place. Everything else here (date, amount,
-- kind) is ordinary portfolio history.
-- ---------------------------------------------------------------------------
drop policy if exists "read own cash flows" on cash_flows;
revoke all on cash_flows from authenticated;
revoke all on cash_flows from anon;

create or replace view cash_flows_safe as
  select
    c.id,
    c.account_id,
    c.flow_date,
    c.amount,
    c.kind,
    c.source,
    c.created_at
  from cash_flows c
  join accounts a on a.id = c.account_id
  where a.owner_id = auth.uid()
    and a.deleted_at is null;

revoke all on cash_flows_safe from public;
grant select on cash_flows_safe to authenticated;

-- ---------------------------------------------------------------------------
-- Soft-deleted accounts must disappear from every account-scoped read.
--
-- `owns_account()` already required `deleted_at is null`, but it is restated
-- here as a single explicit definition so the rule cannot drift.
-- ---------------------------------------------------------------------------
create or replace function owns_account(acct uuid)
returns boolean
language sql
security definer
stable
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from accounts
    where id = acct
      and owner_id = auth.uid()
      and deleted_at is null
  );
$$;

-- `create or replace function` preserves the existing ACL, so 0007's revoke
-- still stands; it is restated for the same reason the body is.
revoke all on function owns_account(uuid) from public, anon;
grant execute on function owns_account(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The remaining account-scoped tables (equity_snapshots, performance,
-- positions, routine_runs) were reviewed column by column: they hold prices,
-- quantities, timestamps and a GitHub run URL, but no broker account number,
-- order or activity identifier, and no credential reference. They keep their
-- owner-scoped SELECT policies, which all route through `owns_account()` and
-- therefore exclude soft-deleted accounts.
--
-- Known and accepted: `routine_runs` rows with `account_id is null` are
-- account-agnostic and readable by any signed-in user. They carry only a
-- routine kind, status, duration and a public GitHub run URL.
-- ---------------------------------------------------------------------------
