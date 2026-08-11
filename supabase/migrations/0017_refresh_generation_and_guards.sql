-- ============================================================================
-- 0017_refresh_generation_and_guards.sql — one refresh generation, and
-- destructive RPCs that refuse malformed input
--
-- Three problems, all of them ways to lose or corrupt real data:
--
-- **1. Two independent refreshes could interleave.** `/equity` and
--    `/performance` each refreshed the equity mirror and the cash-flow ledger
--    on their own. Two overlapping requests could publish in either order, so
--    an older fetch could land on top of a newer one, and the two datasets
--    could come from different moments even though they are read together. A
--    monotonic generation makes late arrivals visible and refuses them.
--
-- **2. A partial upstream payload was indistinguishable from a retraction.**
--    `replace_equity_snapshots` deleted every stored day at or after the
--    earliest incoming day. That is wrong in both directions: a truncated
--    payload deletes real history, and a payload whose *oldest* day was
--    retracted never deletes it, because the bound moves with the payload.
--
-- **3. Destructive RPCs accepted anything.** A SQL NULL for `p_rows` fell
--    through `jsonb_typeof(...) <> 'array'` (NULL is not 'array', so that one
--    was caught) but a null account, owner or date was not, and an empty
--    activities array silently emptied a populated ledger.
--
-- 0014, 0015 and 0016 are not edited. This migration replaces function bodies
-- and adds the generation state.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Refresh generations
--
-- A generation is taken *before* the broker is read and presented at publish
-- time. Publishing a generation that is not newer than the last one published
-- is refused, so two overlapping refreshes cannot interleave: whichever
-- finishes second with an older generation is rejected outright rather than
-- overwriting fresher data.
-- ---------------------------------------------------------------------------
create sequence if not exists broker_refresh_generation_seq as bigint;

create table if not exists broker_refresh_state (
  account_id        uuid primary key references accounts(id) on delete cascade,
  last_generation   bigint      not null default 0,
  last_published_at timestamptz
);

alter table broker_refresh_state enable row level security;
-- No policy at all: nothing but the service role ever touches this.
revoke all on broker_refresh_state from public, anon, authenticated;
revoke all on sequence broker_refresh_generation_seq from public, anon, authenticated;
grant usage, select on sequence broker_refresh_generation_seq to service_role;

create or replace function begin_broker_refresh(p_account uuid, p_owner uuid)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from accounts
     where id = p_account and owner_id = p_owner and deleted_at is null
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  return nextval('broker_refresh_generation_seq');
end;
$$;

revoke all on routine begin_broker_refresh(uuid, uuid) from public, anon, authenticated;
grant execute on routine begin_broker_refresh(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. How much of the stored history a single refresh may remove.
--
-- `period=all` is authoritative, and a genuine retraction — a day the broker
-- has withdrawn, including the oldest one — must be honoured. But a truncated
-- or partial response is structurally identical to a huge retraction, and
-- treating it as one would delete real history.
--
-- The two are separated by size. A real retraction is a handful of days; a
-- truncation loses many. Beyond the bound the payload is refused, nothing is
-- deleted, and the caller reports UNAVAILABLE.
--
-- The bound is proportional as well as absolute, because a fixed count means
-- opposite things at different scales: losing four days out of five is a
-- catastrophe, losing four out of 1 250 is routine. The allowance is therefore
-- the *smaller* of this ceiling and a tenth of the stored history, with a floor
-- of one so a single retracted day is always permitted.
-- ---------------------------------------------------------------------------
create or replace function equity_retraction_limit()
returns integer language sql immutable
set search_path = pg_catalog
as $$ select 5 $$;

create or replace function equity_retraction_allowance(p_existing bigint)
returns bigint language sql immutable
set search_path = pg_catalog, public
as $$
  select least(
    equity_retraction_limit()::bigint,
    greatest(1::bigint, coalesce(p_existing, 0) / 10)
  );
$$;

revoke all on routine equity_retraction_limit() from public, anon, authenticated;
grant execute on routine equity_retraction_limit() to service_role;

-- ---------------------------------------------------------------------------
-- 3. publish_broker_refresh — both datasets, one transaction, one generation.
--
-- The caller fetches and fully validates both datasets first, then hands them
-- over together. Nothing here is optional: a payload the caller could not
-- prove complete must not reach this function at all, and the `*_complete`
-- flags are checked rather than trusted to be implied.
-- ---------------------------------------------------------------------------
create or replace function publish_broker_refresh(
  p_account         uuid,
  p_owner           uuid,
  p_generation      bigint,
  p_equity          jsonb,
  p_equity_complete boolean,
  p_flows           jsonb,
  p_flows_from      date,
  p_flows_complete  boolean,
  p_flows_scanned   integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  equity_written  integer := 0;
  equity_removed  integer := 0;
  flows_written   integer := 0;
  flows_removed   integer := 0;
  existing_equity bigint;
  incoming_equity bigint;
  existing_flows  bigint;
  previous        bigint;
begin
  -- --- parameter shape, before anything is touched -------------------------
  if p_account is null or p_owner is null or p_generation is null
     or p_equity is null or p_equity_complete is null
     or p_flows is null or p_flows_from is null or p_flows_complete is null
     or p_flows_scanned is null then
    raise exception 'every publish_broker_refresh argument is required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_equity) <> 'array' or jsonb_typeof(p_flows) <> 'array' then
    raise exception 'p_equity and p_flows must be JSON arrays' using errcode = '22023';
  end if;
  if p_flows_scanned < 0 then
    raise exception 'p_flows_scanned cannot be negative' using errcode = '22023';
  end if;
  if not p_equity_complete or not p_flows_complete then
    -- The caller is responsible for returning UNAVAILABLE instead of calling
    -- this. Refusing again here means no future caller can publish a payload
    -- it could not prove complete.
    raise exception
      'refusing to publish a refresh that is not proven complete'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from accounts
     where id = p_account and owner_id = p_owner and deleted_at is null
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- --- generation guard ----------------------------------------------------
  insert into broker_refresh_state (account_id, last_generation)
  values (p_account, 0)
  on conflict (account_id) do nothing;

  select last_generation into previous
    from broker_refresh_state
   where account_id = p_account
     for update;

  if p_generation <= previous then
    raise exception
      'refresh generation % is not newer than the published generation %',
      p_generation, previous
      using errcode = 'P0001';
  end if;

  -- --- equity --------------------------------------------------------------
  select count(*) into existing_equity
    from equity_snapshots
   where account_id = p_account and source = 'alpaca_portfolio_history';
  incoming_equity := jsonb_array_length(p_equity);

  if incoming_equity = 0 then
    -- An empty history is never evidence that every stored day is wrong.
    if existing_equity > 0 then
      raise exception
        'refusing to treat an empty portfolio history as a retraction of % stored day(s)',
        existing_equity
        using errcode = 'P0001';
    end if;
  else
    -- A shrink larger than a plausible retraction is a truncated payload.
    if existing_equity - incoming_equity
       > equity_retraction_allowance(existing_equity) then
      raise exception
        'portfolio history shrank from % to % rows, beyond the % row retraction allowance',
        existing_equity, incoming_equity,
        equity_retraction_allowance(existing_equity)
        using errcode = 'P0001';
    end if;

    with incoming as (
      select
        (row ->> 'snapshot_date')::date        as snapshot_date,
        (row ->> 'equity')::numeric            as equity,
        coalesce((row ->> 'cash')::numeric, 0) as cash,
        (row ->> 'profit_loss')::numeric       as profit_loss,
        (row ->> 'profit_loss_pct')::numeric   as profit_loss_pct
      from jsonb_array_elements(p_equity) as row
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
    select count(*) into equity_written from upserted;

    -- No lower bound. `period=all` describes the whole account, so a day it no
    -- longer reports has been withdrawn — including the oldest one, which the
    -- previous `>= min(incoming)` bound could never remove.
    with deleted as (
      delete from equity_snapshots s
       where s.account_id = p_account
         and s.source = 'alpaca_portfolio_history'
         and not exists (
           select 1 from jsonb_array_elements(p_equity) as row
            where (row ->> 'snapshot_date')::date = s.snapshot_date
         )
      returning 1
    )
    select count(*) into equity_removed from deleted;
  end if;

  -- --- cash flows ----------------------------------------------------------
  select count(*) into existing_flows
    from cash_flows
   where account_id = p_account
     and source = 'alpaca_activities'
     and flow_date >= p_flows_from;

  if jsonb_array_length(p_flows) = 0 and existing_flows > 0 and p_flows_scanned = 0 then
    -- The walk returned nothing *and* examined nothing. That is indistinguishable
    -- from a broker outage, so it is not evidence that % mirrored rows are gone.
    raise exception
      'refusing to delete % mirrored cash flow(s) on an empty, unexamined activity walk',
      existing_flows
      using errcode = 'P0001';
  end if;

  with incoming as (
    select
      (row ->> 'external_id')     as external_id,
      (row ->> 'flow_date')::date as flow_date,
      (row ->> 'amount')::numeric as amount,
      (row ->> 'kind')            as kind
    from jsonb_array_elements(p_flows) as row
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
  select count(*) into flows_written from upserted;

  with deleted as (
    delete from cash_flows c
     where c.account_id = p_account
       and c.source = 'alpaca_activities'
       and c.flow_date >= p_flows_from
       and c.external_id is not null
       and not exists (
         select 1 from jsonb_array_elements(p_flows) as row
          where row ->> 'external_id' = c.external_id
       )
    returning 1
  )
  select count(*) into flows_removed from deleted;

  update broker_refresh_state
     set last_generation = p_generation,
         last_published_at = now()
   where account_id = p_account;

  return jsonb_build_object(
    'generation', p_generation,
    'equity_written', equity_written,
    'equity_removed', equity_removed,
    'flows_written', flows_written,
    'flows_removed', flows_removed
  );
end;
$$;

revoke all on routine publish_broker_refresh(
  uuid, uuid, bigint, jsonb, boolean, jsonb, date, boolean, integer
) from public, anon, authenticated;
grant execute on routine publish_broker_refresh(
  uuid, uuid, bigint, jsonb, boolean, jsonb, date, boolean, integer
) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Harden the RPCs 0013/0014 introduced.
--
-- Bodies are replaced; signatures and grants are unchanged. `CREATE OR REPLACE`
-- preserves an existing ACL (verified on PostgreSQL 16), and 0016 removed the
-- event trigger that used to strip it — but the grants are restated at the end
-- anyway, because relying on that is exactly the kind of assumption this audit
-- keeps finding.
-- ---------------------------------------------------------------------------
-- `reconcile_cash_flow_mirror` is superseded by `publish_broker_refresh`, which
-- carries the completeness evidence this one never had: how many activities
-- were examined, and whether the walk finished. Without that, an empty payload
-- and a broker outage are the same input, and one of them must not empty the
-- ledger. It refuses rather than delegating — a shim that quietly did half the
-- job would be worse than an error.
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
begin
  raise exception
    'reconcile_cash_flow_mirror is superseded by publish_broker_refresh, which '
    'requires proof that the activity walk was complete'
    using errcode = '0A000';
end;
$$;

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
set search_path = pg_catalog, public, vault
as $$
declare
  created accounts;
begin
  if p_owner is null or p_mode is null then
    raise exception 'owner and mode are required' using errcode = '22023';
  end if;
  if p_nickname is null or btrim(p_nickname) = '' then
    raise exception 'nickname is required' using errcode = '22023';
  end if;

  -- The broker account number is what the production binding compares against.
  -- A row created without one can never be bound, and an empty string is not a
  -- number — both used to be accepted.
  if p_account_number is null or btrim(p_account_number) = '' then
    raise exception 'a broker account number is required' using errcode = '22023';
  end if;

  -- Both credential references must exist, and be two different secrets. A
  -- shared id means rotating the key would overwrite the secret with the same
  -- value; a dangling id means the account can never authenticate.
  if p_key_secret is null or p_secret_secret is null then
    raise exception 'both Vault secret ids are required' using errcode = '22023';
  end if;
  if p_key_secret = p_secret_secret then
    raise exception 'the API key and secret must be two distinct Vault secrets'
      using errcode = '22023';
  end if;
  if not exists (select 1 from vault.secrets where id = p_key_secret) then
    raise exception 'the API key secret does not exist in the vault'
      using errcode = 'P0002';
  end if;
  if not exists (select 1 from vault.secrets where id = p_secret_secret) then
    raise exception 'the API secret does not exist in the vault'
      using errcode = 'P0002';
  end if;

  -- Two live accounts must never share a credential: rotating or deleting one
  -- would silently break the other.
  if exists (
    select 1 from accounts
     where deleted_at is null
       and (alpaca_key_secret_id in (p_key_secret, p_secret_secret)
            or alpaca_secret_secret_id in (p_key_secret, p_secret_secret))
  ) then
    raise exception 'those Vault secrets are already in use by an active account'
      using errcode = '23505';
  end if;

  insert into accounts (
    owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    last_verified_at
  )
  values (
    p_owner, btrim(p_nickname), p_mode, 'connected', coalesce(p_color, '#007aff'),
    p_key_secret, p_secret_secret, btrim(p_account_number),
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

create or replace function delete_account_atomic(
  p_account       uuid,
  p_owner         uuid,
  p_purge_history boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  target accounts;
begin
  if p_account is null or p_owner is null or p_purge_history is null then
    raise exception 'account, owner and purge flag are required'
      using errcode = '22023';
  end if;

  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if target.alpaca_key_secret_id is not null then
    delete from vault.secrets where id = target.alpaca_key_secret_id;
  end if;
  if target.alpaca_secret_secret_id is not null then
    delete from vault.secrets where id = target.alpaca_secret_secret_id;
  end if;

  if p_purge_history then
    delete from accounts where id = p_account;
    insert into audit_log (actor_id, account_id, action, detail)
    values (
      p_owner, null, 'account.deleted_purged',
      jsonb_build_object('nickname', target.nickname)
    );
  else
    update accounts
       set deleted_at              = now(),
           is_active               = false,
           status                  = 'paused',
           alpaca_key_secret_id    = null,
           alpaca_secret_secret_id = null,
           alpaca_account_number   = null
     where id = p_account;
    insert into audit_log (actor_id, account_id, action, detail)
    values (
      p_owner, p_account, 'account.deleted',
      jsonb_build_object('nickname', target.nickname)
    );
  end if;

  return true;
end;
$$;

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
  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;
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
  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;
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
   where id = p_account and owner_id = p_owner and deleted_at is null
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

-- `replace_equity_snapshots` is superseded by `publish_broker_refresh`, which
-- carries the completeness evidence. It is kept for signature compatibility
-- and refuses outright rather than deleting on unproven input.
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
begin
  raise exception
    'replace_equity_snapshots is superseded by publish_broker_refresh, which '
    'requires proof that the portfolio-history payload is complete'
    using errcode = '0A000';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Restate every grant, and fail if the catalogue disagrees.
-- ---------------------------------------------------------------------------
do $$
declare
  fn       record;
  role_    text;
  problems text[] := '{}';
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'reconcile_cash_flow_mirror', 'replace_equity_snapshots',
         'create_account_atomic', 'delete_account_atomic',
         'account_history_snapshot', 'update_account_metadata',
         'begin_broker_refresh', 'publish_broker_refresh',
         'equity_retraction_limit', 'equity_retraction_allowance'
       )
  loop
    execute format('revoke all on routine %s from public, anon, authenticated', fn.signature);
    execute format('grant execute on routine %s to service_role', fn.signature);
  end loop;

  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    foreach role_ in array array['anon', 'authenticated'] loop
      if has_function_privilege(role_, fn.signature, 'EXECUTE')
         and fn.signature not in (
           'owns_account(uuid)', 'is_service_role()', 'jwt_role()'
         ) then
        problems := problems || format('%s can execute %s', role_, fn.signature);
      end if;
    end loop;
  end loop;

  foreach role_ in array array['anon', 'authenticated'] loop
    if has_table_privilege(role_, 'broker_refresh_state', 'SELECT')
       or has_table_privilege(role_, 'broker_refresh_state', 'INSERT')
       or has_table_privilege(role_, 'broker_refresh_state', 'UPDATE')
       or has_table_privilege(role_, 'broker_refresh_state', 'DELETE') then
      problems := problems || format('%s can reach broker_refresh_state', role_);
    end if;
    if has_sequence_privilege(role_, 'broker_refresh_generation_seq', 'USAGE')
       or has_sequence_privilege(role_, 'broker_refresh_generation_seq', 'UPDATE') then
      problems := problems || format('%s can move the refresh generation', role_);
    end if;
  end loop;

  if not has_function_privilege(
       'service_role',
       'publish_broker_refresh(uuid,uuid,bigint,jsonb,boolean,jsonb,date,boolean,integer)',
       'EXECUTE') then
    problems := problems || 'service_role cannot publish a refresh';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'refresh/guard lockdown failed: %', array_to_string(problems, '; ');
  end if;
end $$;
