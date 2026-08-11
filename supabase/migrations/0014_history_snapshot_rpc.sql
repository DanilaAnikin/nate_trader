-- ============================================================================
-- 0014_history_snapshot_rpc.sql — read the account history in ONE snapshot
--
-- The dashboard read its equity curve and its cash-flow ledger by walking
-- pages over PostgREST. That walk was careful — keyset cursor, exact count,
-- duplicate detection — and still structurally unable to deliver what a return
-- calculation needs, because **several HTTP requests are several MVCC
-- snapshots**. Between page one and page two the database is free to change,
-- and three kinds of change are invisible to any client-side reconciliation:
--
--   * a row already read is UPDATEd — the count is unchanged, no key repeats,
--     nothing is skipped, and the reader returns a value that no longer exists;
--   * two writes cancel out in the count between checks;
--   * the count itself is computed per request, so "the count did not move" is
--     a statement about two different snapshots, not one.
--
-- No amount of client logic fixes that. The fix is to stop making several
-- requests: a `STABLE` PL/pgSQL function sees the calling statement's snapshot
-- for its whole body, so every query inside it observes one consistent state.
-- These functions therefore return the entire dataset — both datasets, for the
-- performance route — from a single snapshot, together with the snapshot token
-- that produced them so a result can be audited.
--
-- Everything here is service-role only. The dashboard already reads accounts
-- with the service role and checks ownership in code; these functions check it
-- again themselves, so a mistaken call site cannot reach another user's rows.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The hard ceiling on one snapshot.
--
-- Materialising an unbounded history into a single JSON document is its own
-- failure mode. Past this, the answer is UNAVAILABLE — never a partial one.
-- 20 000 rows is ~79 years of daily equity plus a very busy ledger.
-- ---------------------------------------------------------------------------
create or replace function account_history_row_limit()
returns integer language sql immutable
set search_path = pg_catalog
as $$ select 20000 $$;

-- ---------------------------------------------------------------------------
-- account_history_snapshot — equity curve + cash-flow ledger, one snapshot.
--
-- `stable` is load-bearing: it makes every statement in the body observe the
-- snapshot of the calling statement. Marking this `volatile` would take a
-- fresh snapshot per query and reintroduce exactly the tear this replaces.
--
-- `p_from` is inclusive and may be null for "everything". Ids are rendered as
-- text: `cash_flows.id` is a bigint, and JSON numbers in JavaScript are
-- doubles, so a large id would silently lose precision.
-- ---------------------------------------------------------------------------
create or replace function account_history_snapshot(
  p_account uuid,
  p_owner   uuid,
  p_from    date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  equity_rows bigint;
  flow_rows   bigint;
  max_rows    integer := account_history_row_limit();
begin
  if not exists (
    select 1 from accounts
     where id = p_account and owner_id = p_owner and deleted_at is null
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  select count(*) into equity_rows
    from equity_snapshots
   where account_id = p_account
     and (p_from is null or snapshot_date >= p_from);

  select count(*) into flow_rows
    from cash_flows
   where account_id = p_account
     and (p_from is null or flow_date >= p_from);

  if equity_rows + flow_rows > max_rows then
    raise exception
      'account history is % rows, above the % row snapshot limit',
      equity_rows + flow_rows, max_rows
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'schema_version', 1,
    'account_id', p_account,
    'from_date', p_from,
    -- Read-only snapshot identity. `pg_current_snapshot()` does not assign a
    -- transaction id, so this stays a pure read; it is recorded purely so a
    -- returned dataset can be audited back to the state it came from.
    'snapshot', pg_current_snapshot()::text,
    'captured_at', now(),
    'equity_count', equity_rows,
    'cash_flow_count', flow_rows,
    'equity', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'date', e.snapshot_date,
                   'equity', e.equity,
                   'cash', e.cash,
                   'profit_loss', e.profit_loss,
                   'profit_loss_pct', e.profit_loss_pct,
                   'num_positions', e.num_positions
                 )
                 order by e.snapshot_date
               )
          from equity_snapshots e
         where e.account_id = p_account
           and (p_from is null or e.snapshot_date >= p_from)
      ),
      '[]'::jsonb
    ),
    'cash_flows', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id', c.id::text,
                   'date', c.flow_date,
                   'amount', c.amount,
                   'kind', c.kind,
                   'source', c.source
                 )
                 order by c.id
               )
          from cash_flows c
         where c.account_id = p_account
           and (p_from is null or c.flow_date >= p_from)
      ),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function account_history_snapshot(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function account_history_snapshot(uuid, uuid, date)
  to service_role;

-- ---------------------------------------------------------------------------
-- reconcile_cash_flow_mirror — upsert the walk's result and delete what the
-- broker no longer reports, in one transaction.
--
-- The previous reconciliation read the mirrored ledger with a single unpaged
-- `select`, so on an account past the server's row cap it would have seen a
-- truncated list and "reconciled" against it — deleting nothing it could not
-- see, or worse, deleting rows it wrongly believed to be absent. Doing the
-- set difference inside the database removes both the paging and the race.
--
-- `p_rows` is the complete set of activities the broker currently reports for
-- the window. `p_from` bounds the authority of that claim: rows dated before
-- it are never touched, because the caller made no claim about them.
-- ---------------------------------------------------------------------------
create or replace function reconcile_cash_flow_mirror(
  p_account uuid,
  p_owner   uuid,
  p_from    date,
  p_rows    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  written integer := 0;
  removed integer := 0;
begin
  if not exists (
    select 1 from accounts
     where id = p_account and owner_id = p_owner and deleted_at is null
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;

  with incoming as (
    select
      (row ->> 'external_id')          as external_id,
      (row ->> 'flow_date')::date      as flow_date,
      (row ->> 'amount')::numeric      as amount,
      (row ->> 'kind')                 as kind
    from jsonb_array_elements(p_rows) as row
  ),
  upserted as (
    insert into cash_flows (
      account_id, flow_date, amount, kind, source, external_id
    )
    select p_account, flow_date, amount, kind, 'alpaca_activities', external_id
      from incoming
    on conflict (account_id, external_id) do update
      set flow_date = excluded.flow_date,
          amount    = excluded.amount,
          kind      = excluded.kind
    returning 1
  )
  select count(*) into written from upserted;

  -- Anything the broker no longer reports, inside the window the caller is
  -- authoritative for. A reversed transfer or a correction re-issued under a
  -- new id would otherwise keep subtracting from the return forever.
  with deleted as (
    delete from cash_flows c
     where c.account_id = p_account
       and c.source = 'alpaca_activities'
       and c.flow_date >= p_from
       and c.external_id is not null
       and not exists (
         select 1
           from jsonb_array_elements(p_rows) as row
          where row ->> 'external_id' = c.external_id
       )
    returning 1
  )
  select count(*) into removed from deleted;

  return jsonb_build_object('written', written, 'removed', removed);
end;
$$;

revoke all on function reconcile_cash_flow_mirror(uuid, uuid, date, jsonb)
  from public, anon, authenticated;
grant execute on function reconcile_cash_flow_mirror(uuid, uuid, date, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- replace_equity_snapshots — the same treatment for the equity mirror.
--
-- Alpaca's portfolio history is authoritative and retroactive: it revises past
-- days and can drop them entirely. An upsert-only mirror keeps a day the
-- broker has since withdrawn, and that stale day stays in the curve and in
-- every return computed from it.
-- ---------------------------------------------------------------------------
create or replace function replace_equity_snapshots(
  p_account uuid,
  p_owner   uuid,
  p_rows    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  written integer := 0;
  removed integer := 0;
  earliest date;
begin
  if not exists (
    select 1 from accounts
     where id = p_account and owner_id = p_owner and deleted_at is null
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    -- An empty history is not evidence that every stored day is wrong.
    return jsonb_build_object('written', 0, 'removed', 0);
  end if;

  select min((row ->> 'snapshot_date')::date) into earliest
    from jsonb_array_elements(p_rows) as row;

  with incoming as (
    select
      (row ->> 'snapshot_date')::date       as snapshot_date,
      (row ->> 'equity')::numeric           as equity,
      coalesce((row ->> 'cash')::numeric, 0) as cash,
      (row ->> 'profit_loss')::numeric      as profit_loss,
      (row ->> 'profit_loss_pct')::numeric  as profit_loss_pct
    from jsonb_array_elements(p_rows) as row
  ),
  upserted as (
    insert into equity_snapshots (
      account_id, snapshot_date, equity, cash, profit_loss, profit_loss_pct, source
    )
    select p_account, snapshot_date, equity, cash, profit_loss, profit_loss_pct,
           'alpaca_portfolio_history'
      from incoming
    on conflict (account_id, snapshot_date) do update
      set equity          = excluded.equity,
          cash            = excluded.cash,
          profit_loss     = excluded.profit_loss,
          profit_loss_pct = excluded.profit_loss_pct,
          source          = excluded.source
    returning 1
  )
  select count(*) into written from upserted;

  -- Only days this mirror wrote, and only from the first day the broker still
  -- reports: an agent-written or manually seeded row keeps its own authority.
  with deleted as (
    delete from equity_snapshots s
     where s.account_id = p_account
       and s.source = 'alpaca_portfolio_history'
       and s.snapshot_date >= earliest
       and not exists (
         select 1
           from jsonb_array_elements(p_rows) as row
          where (row ->> 'snapshot_date')::date = s.snapshot_date
       )
    returning 1
  )
  select count(*) into removed from deleted;

  return jsonb_build_object('written', written, 'removed', removed);
end;
$$;

revoke all on function replace_equity_snapshots(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function replace_equity_snapshots(uuid, uuid, jsonb)
  to service_role;

revoke all on function account_history_row_limit() from public, anon, authenticated;
grant execute on function account_history_row_limit() to service_role;

-- ---------------------------------------------------------------------------
-- create_account_atomic / update_account_metadata — the last two write flows
--
-- Both could previously succeed while their audit entry failed, because the
-- audit `insert` was a separate round trip whose result was discarded. An
-- account could therefore be created, or its metadata changed, with no record
-- that it happened — which makes "every account write is audited" false, and
-- an audit log that is sometimes missing entries is worse than none, because
-- its absence is read as evidence.
--
-- Row and audit entry now commit together or not at all.
--
-- Creation keeps its two-phase shape by necessity: the Vault secrets must
-- exist before the row can reference them, and validating the key pair means
-- calling Alpaca, which cannot happen inside a transaction. The caller stores
-- the secrets first and passes their ids here; if this transaction fails, the
-- caller compensates by purging them, and reports it when that also fails.
-- ---------------------------------------------------------------------------
create or replace function create_account_atomic(
  p_owner          uuid,
  p_nickname       text,
  p_mode           account_mode,
  p_color          text,
  p_key_secret     uuid,
  p_secret_secret  uuid,
  p_account_number text
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  created accounts;
begin
  if p_nickname is null or btrim(p_nickname) = '' then
    raise exception 'nickname is required' using errcode = '22023';
  end if;

  insert into accounts (
    owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    last_verified_at
  )
  values (
    p_owner, btrim(p_nickname), p_mode, 'connected', coalesce(p_color, '#007aff'),
    p_key_secret, p_secret_secret, p_account_number,
    now()
  )
  returning * into created;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, created.id, 'account.created',
    jsonb_build_object('mode', p_mode, 'nickname', created.nickname)
  );

  return created;
end;
$$;

revoke all on function create_account_atomic(uuid, text, account_mode, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function create_account_atomic(uuid, text, account_mode, text, uuid, uuid, text)
  to service_role;

create or replace function update_account_metadata(
  p_account   uuid,
  p_owner     uuid,
  p_nickname  text default null,
  p_color     text default null,
  p_is_active boolean default null
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  updated accounts;
  changed jsonb := '{}'::jsonb;
begin
  if p_nickname is not null and btrim(p_nickname) = '' then
    raise exception 'nickname cannot be empty' using errcode = '22023';
  end if;
  if p_nickname is null and p_color is null and p_is_active is null then
    raise exception 'nothing to update' using errcode = '22023';
  end if;

  update accounts
     set nickname  = coalesce(btrim(p_nickname), nickname),
         color     = coalesce(p_color, color),
         is_active = coalesce(p_is_active, is_active)
   where id = p_account
     and owner_id = p_owner
     and deleted_at is null
   returning * into updated;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if p_nickname  is not null then changed := changed || jsonb_build_object('nickname', btrim(p_nickname)); end if;
  if p_color     is not null then changed := changed || jsonb_build_object('color', p_color); end if;
  if p_is_active is not null then changed := changed || jsonb_build_object('is_active', p_is_active); end if;

  insert into audit_log (actor_id, account_id, action, detail)
  values (p_owner, p_account, 'account.updated', changed);

  return updated;
end;
$$;

revoke all on function update_account_metadata(uuid, uuid, text, text, boolean)
  from public, anon, authenticated;
grant execute on function update_account_metadata(uuid, uuid, text, text, boolean)
  to service_role;
