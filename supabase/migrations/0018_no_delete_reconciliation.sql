-- ============================================================================
-- 0018_no_delete_reconciliation.sql — a refresh may never delete, a refresh
-- token is bound to the credentials it was issued for, and a Vault secret can
-- belong to exactly one account.
--
-- Three independent ways the previous design could destroy real data.
--
-- **1. A partial HTTP 200 was indistinguishable from a retraction, and the
-- difference was decided by counting.** 0017 allowed a refresh to delete
-- stored days that the incoming payload no longer mentioned, bounded by
-- `equity_retraction_allowance()` — the smaller of five rows and a tenth of
-- the history. Reproduced against PostgreSQL 16:
--
--     stored equity rows                    100
--     incoming payload, flagged complete     99  (one valid day omitted)
--     allowance                               5
--     100 - 99 = 1 <= 5                     -> accepted
--     result: the omitted day is DELETED
--
-- The bound is not the bug; the premise is. Nothing in a 200 response
-- distinguishes "the broker withdrew this day" from "the broker did not send
-- it this time", and a count cannot recover information the payload does not
-- contain. Any threshold at all deletes real history at some frequency.
--
-- So a refresh no longer deletes anything, ever. A stored row the payload does
-- not mention aborts the whole transaction with `RECONCILIATION_CONFLICT`
-- (SQLSTATE 23514) and the mirror is left exactly as it was. Genuine
-- retractions are rare and consequential, and they now go through
-- `retract_equity_snapshot` / `retract_cash_flow`: one row at a time, with a
-- stated reason, written to `audit_log`.
--
-- **2. An empty activity page was accepted as a tombstone.** `p_flows = '[]'`
-- with `p_flows_scanned = 1` deleted the entire ledger, because "we examined
-- something" was treated as proof that the absence was real. The absence of an
-- activity is never evidence that a mirrored one was withdrawn. Same rule now:
-- no deletes.
--
-- **3. `create_account_atomic` guarded credential reuse with SELECT EXISTS.**
-- That is a read, and two concurrent transactions both read "not in use"
-- before either writes. Reproduced: two sessions calling the RPC with the same
-- two Vault UUIDs both committed, leaving two live accounts sharing one
-- secret — rotating either silently breaks the other. Replaced with
-- `account_credential_assignment`, whose primary key on `secret_id` makes the
-- database refuse the second writer whatever the interleaving, and which also
-- covers cross-column reuse (the same id as one account's key and another's
-- secret).
--
-- Plus: a refresh token now carries the account, owner, mode, broker account
-- number and credential version it was issued against, and publishing
-- re-checks all five. A rotation that lands while the broker is being read
-- makes the publish refuse rather than mixing two credentials' data.
--
-- No historical migration is edited. 0016 and 0017 stand as written.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Credential versioning.
--
-- One counter per account, bumped by every operation that changes what a
-- credential *is* or what it points at: rotation, binding change, deletion.
-- A refresh that started before the bump can be recognised afterwards.
-- ---------------------------------------------------------------------------
alter table accounts
  add column if not exists credential_version bigint not null default 1;

-- ---------------------------------------------------------------------------
-- 2. One Vault secret, one account, one role — enforced by the database.
-- ---------------------------------------------------------------------------
create table if not exists account_credential_assignment (
  secret_id  uuid primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  role       text not null check (role in ('key', 'secret')),
  created_at timestamptz not null default now(),
  unique (account_id, role)
);

create index if not exists account_credential_assignment_account_idx
  on account_credential_assignment(account_id);

alter table account_credential_assignment enable row level security;
revoke all on account_credential_assignment from public, anon, authenticated;

-- Backfill from whatever is already stored. `on conflict do nothing` keeps the
-- migration idempotent and cannot invent an assignment for a shared id.
insert into account_credential_assignment (secret_id, account_id, role)
select a.alpaca_key_secret_id, a.id, 'key'
  from accounts a
 where a.deleted_at is null and a.alpaca_key_secret_id is not null
on conflict do nothing;

insert into account_credential_assignment (secret_id, account_id, role)
select a.alpaca_secret_secret_id, a.id, 'secret'
  from accounts a
 where a.deleted_at is null and a.alpaca_secret_secret_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Validation helpers.
--
-- `try_date` exists because casting an invalid date raises rather than
-- returning null, and every row of an incoming payload must be checked before
-- the first mutation rather than discovered half-way through one.
-- ---------------------------------------------------------------------------
create or replace function try_date(p_text text)
returns date
language plpgsql
immutable
set search_path = pg_catalog
as $$
begin
  -- The shape test matters: PostgreSQL accepts '2026' and 'today' as dates.
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then
    return null;
  end if;
  return p_text::date;
exception when others then
  return null;
end;
$$;

revoke all on routine try_date(text) from public, anon, authenticated;
grant execute on routine try_date(text) to service_role;

create or replace function broker_refresh_row_limit()
returns integer language sql immutable
set search_path = pg_catalog
as $$ select 20000 $$;

revoke all on routine broker_refresh_row_limit() from public, anon, authenticated;
grant execute on routine broker_refresh_row_limit() to service_role;

-- ---------------------------------------------------------------------------
-- 4. Refresh tokens.
--
-- 0017's generation was a bare integer, which proves ordering and nothing
-- else. A token records what the refresh was issued *against*, so publishing
-- can verify that none of it moved while the broker was being read.
-- ---------------------------------------------------------------------------
create table if not exists broker_refresh_token (
  token              uuid primary key default gen_random_uuid(),
  account_id         uuid not null references accounts(id) on delete cascade,
  owner_id           uuid not null,
  mode               account_mode not null,
  account_number     text,
  credential_version bigint not null,
  generation         bigint not null,
  issued_at          timestamptz not null default now(),
  consumed_at        timestamptz
);

create index if not exists broker_refresh_token_account_idx
  on broker_refresh_token(account_id, issued_at desc);

alter table broker_refresh_token enable row level security;
revoke all on broker_refresh_token from public, anon, authenticated;

/**
 * How long a reservation stays usable.
 *
 * A refresh reads two broker endpoints; anything beyond this is a stalled
 * request whose data describes a different moment.
 */
create or replace function broker_refresh_token_ttl()
returns interval language sql immutable
set search_path = pg_catalog
as $$ select interval '30 minutes' $$;

revoke all on routine broker_refresh_token_ttl() from public, anon, authenticated;
grant execute on routine broker_refresh_token_ttl() to service_role;

-- ---------------------------------------------------------------------------
-- 5. begin_broker_refresh — reserve a generation and bind it to the identity
--    the refresh is about to read.
-- ---------------------------------------------------------------------------
drop function if exists begin_broker_refresh(uuid, uuid);

create or replace function begin_broker_refresh(p_account uuid, p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target     accounts;
  generation bigint;
  issued     uuid;
begin
  -- A refresh must never wait indefinitely for a row lock. Without this a
  -- request that queues behind a rotation holds a server worker until the
  -- client gives up — and the client giving up does not cancel the query, so
  -- the next attempt queues behind the first and the queue only grows.
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;

  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- Housekeeping, bounded and cheap: a token nobody published is dead weight.
  delete from broker_refresh_token
   where account_id = p_account
     and issued_at < now() - interval '1 day';

  generation := nextval('broker_refresh_generation_seq');

  insert into broker_refresh_token (
    account_id, owner_id, mode, account_number, credential_version, generation
  )
  values (
    p_account, p_owner, target.mode, target.alpaca_account_number,
    target.credential_version, generation
  )
  returning token into issued;

  return jsonb_build_object(
    'token', issued,
    'generation', generation,
    'credential_version', target.credential_version,
    'mode', target.mode,
    'account_number', target.alpaca_account_number
  );
end;
$$;

revoke all on routine begin_broker_refresh(uuid, uuid) from public, anon, authenticated;
grant execute on routine begin_broker_refresh(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. publish_broker_refresh — upsert only, and refuse anything else.
-- ---------------------------------------------------------------------------
drop function if exists publish_broker_refresh(
  uuid, uuid, bigint, jsonb, boolean, jsonb, date, boolean, integer
);

create or replace function publish_broker_refresh(
  p_token                uuid,
  p_equity               jsonb,
  p_equity_complete      boolean,
  p_flows                jsonb,
  p_flows_from           date,
  p_flows_complete       boolean,
  p_flows_scanned        integer,
  p_flows_saw_empty_page boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reservation     broker_refresh_token;
  target          accounts;
  previous        bigint;
  equity_written  integer := 0;
  flows_written   integer := 0;
  bad             text;
  missing_count   bigint;
  missing_sample  text;
  incoming_equity bigint;
  incoming_flows  bigint;
begin
  -- See `begin_broker_refresh`: a bounded wait, so a contended refresh fails
  -- closed and fast instead of pinning a connection until the client times
  -- out. `lock_not_available` (55P03) is reported as an ordinary refusal.
  perform set_config('lock_timeout', '5s', true);

  -- --- parameter shape, before anything is touched -------------------------
  if p_token is null
     or p_equity is null or p_equity_complete is null
     or p_flows is null or p_flows_from is null or p_flows_complete is null
     or p_flows_scanned is null or p_flows_saw_empty_page is null then
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
    raise exception 'refusing to publish a refresh that is not proven complete'
      using errcode = '22023';
  end if;
  -- A walk that did not end on an explicit empty page did not reach the end of
  -- the feed, whatever it claims. `page_size` is a maximum, not an EOF marker.
  if not p_flows_saw_empty_page then
    raise exception
      'refusing to publish an activity walk that did not terminate on an empty page'
      using errcode = '22023';
  end if;

  incoming_equity := jsonb_array_length(p_equity);
  incoming_flows := jsonb_array_length(p_flows);
  if incoming_equity > broker_refresh_row_limit()
     or incoming_flows > broker_refresh_row_limit() then
    raise exception 'a refresh payload exceeds the % row limit', broker_refresh_row_limit()
      using errcode = '22023';
  end if;
  -- The walk cannot have produced more rows than it looked at.
  if incoming_flows > p_flows_scanned then
    raise exception
      'the activity walk reports % rows from % examined activities',
      incoming_flows, p_flows_scanned
      using errcode = '22023';
  end if;

  -- --- the reservation, and everything it was issued against ---------------
  select * into reservation
    from broker_refresh_token
   where token = p_token
     for update;
  if not found then
    raise exception 'unknown refresh token' using errcode = 'P0002';
  end if;
  if reservation.consumed_at is not null then
    raise exception 'refresh token % has already been published', p_token
      using errcode = '23505';
  end if;
  if reservation.issued_at < now() - broker_refresh_token_ttl() then
    raise exception 'refresh token % is older than the % reservation window',
      p_token, broker_refresh_token_ttl()
      using errcode = 'P0001';
  end if;

  -- A plain read, deliberately. `FOR UPDATE` here would hold the account row
  -- for the whole publish, which does two things wrong: it makes a user's
  -- credential rotation wait behind a bulk mirror write, and it creates a
  -- lock-ordering hazard against `record_account_verification`, which takes
  -- the account row first and the refresh tables never.
  --
  -- READ COMMITTED gives the latest committed values, which is exactly what
  -- the identity re-check needs: a rotation that committed before this
  -- statement is seen and refuses the publish, and one committing after it
  -- cannot have been used for the fetch that already happened. Mutual
  -- exclusion belongs to the token and the generation row, which are locked.
  select * into target
    from accounts
   where id = reservation.account_id
     and owner_id = reservation.owner_id
     and deleted_at is null;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- Five-point identity re-check. A rotation, a re-binding or a deletion that
  -- landed while the broker was being read means the payload in hand may have
  -- been fetched with credentials that no longer describe this account.
  --
  -- SQLSTATE `P0001`, deliberately, and **never class 40**. A `40001`
  -- (serialization_failure) advertises "this transaction may succeed if you
  -- retry it", and PostgREST acts on that: it retried the call in a loop and
  -- the request never returned, because the condition is permanent — the
  -- credentials really did change and the data in hand really was fetched
  -- with the old ones. Reproduced against PostgREST 12.2.3: a verification
  -- followed by a publish hung until the client gave up, while the same
  -- sequence with any other refusal returned in 30 ms. Retrying cannot fix a
  -- stale payload; only re-fetching can, and that is the caller's decision.
  if target.credential_version <> reservation.credential_version then
    raise exception
      'credentials changed during the refresh (version % -> %); nothing was written',
      reservation.credential_version, target.credential_version
      using errcode = 'P0001';
  end if;
  if target.mode <> reservation.mode then
    raise exception 'the account mode changed during the refresh; nothing was written'
      using errcode = 'P0001';
  end if;
  if target.alpaca_account_number is distinct from reservation.account_number then
    raise exception
      'the broker account number changed during the refresh; nothing was written'
      using errcode = 'P0001';
  end if;

  -- --- generation guard ----------------------------------------------------
  insert into broker_refresh_state (account_id, last_generation)
  values (reservation.account_id, 0)
  on conflict (account_id) do nothing;

  select last_generation into previous
    from broker_refresh_state
   where account_id = reservation.account_id
     for update;

  if reservation.generation <= previous then
    raise exception
      'refresh generation % is not newer than the published generation %',
      reservation.generation, previous
      using errcode = 'P0001';
  end if;

  -- --- every incoming row, fully validated, before the first mutation ------
  select string_agg(problem, '; ')
    into bad
    from (
      select format('equity row %s: %s', ordinality - 1, reason) as problem
        from jsonb_array_elements(p_equity) with ordinality as e(row, ordinality)
        cross join lateral (
          select case
            when jsonb_typeof(e.row) <> 'object' then 'not an object'
            when (select count(*) from jsonb_object_keys(e.row)) <> 5
              then 'unexpected key set'
            when not (e.row ?& array['snapshot_date','equity','cash','profit_loss','profit_loss_pct'])
              then 'missing a required key'
            when try_date(e.row ->> 'snapshot_date') is null
              then format('%s is not a calendar date', e.row ->> 'snapshot_date')
            when jsonb_typeof(e.row -> 'equity') <> 'number'
              or not ((e.row ->> 'equity')::numeric > 0)
              then 'equity is not a finite positive number'
            when jsonb_typeof(e.row -> 'cash') <> 'number'
              then 'cash is not a number'
            when jsonb_typeof(e.row -> 'profit_loss') not in ('number', 'null')
              then 'profit_loss is neither a number nor null'
            when jsonb_typeof(e.row -> 'profit_loss_pct') not in ('number', 'null')
              then 'profit_loss_pct is neither a number nor null'
            else null
          end as reason
        ) as checked
       where checked.reason is not null
       limit 5
    ) as problems;
  if bad is not null then
    raise exception 'the portfolio history payload is unusable: %', bad
      using errcode = '22023';
  end if;

  if (
    select count(*) from (
      select distinct e.row ->> 'snapshot_date' as d
        from jsonb_array_elements(p_equity) as e(row)
    ) as dates
  ) <> incoming_equity then
    raise exception 'the portfolio history payload repeats a session date'
      using errcode = '22023';
  end if;

  select string_agg(problem, '; ')
    into bad
    from (
      select format('flow row %s: %s', ordinality - 1, reason) as problem
        from jsonb_array_elements(p_flows) with ordinality as f(row, ordinality)
        cross join lateral (
          select case
            when jsonb_typeof(f.row) <> 'object' then 'not an object'
            when (select count(*) from jsonb_object_keys(f.row)) <> 4
              then 'unexpected key set'
            when not (f.row ?& array['external_id','flow_date','amount','kind'])
              then 'missing a required key'
            when jsonb_typeof(f.row -> 'external_id') <> 'string'
              or btrim(f.row ->> 'external_id') = ''
              then 'external_id is not a non-empty string'
            when try_date(f.row ->> 'flow_date') is null
              then format('%s is not a calendar date', f.row ->> 'flow_date')
            when try_date(f.row ->> 'flow_date') < p_flows_from
              then format('%s precedes the declared window %s',
                          f.row ->> 'flow_date', p_flows_from)
            when jsonb_typeof(f.row -> 'amount') <> 'number'
              or (f.row ->> 'amount')::numeric = 0
              or not ((f.row ->> 'amount')::numeric between -1e12 and 1e12)
              then 'amount is not a finite non-zero number'
            when (f.row ->> 'kind') not in ('deposit', 'withdrawal')
              then format('%s is not an allowed flow kind', f.row ->> 'kind')
            when (f.row ->> 'kind') = 'deposit'
              and (f.row ->> 'amount')::numeric < 0
              then 'a deposit cannot be negative'
            when (f.row ->> 'kind') = 'withdrawal'
              and (f.row ->> 'amount')::numeric > 0
              then 'a withdrawal cannot be positive'
            else null
          end as reason
        ) as checked
       where checked.reason is not null
       limit 5
    ) as problems;
  if bad is not null then
    raise exception 'the cash-flow payload is unusable: %', bad
      using errcode = '22023';
  end if;

  if (
    select count(*) from (
      select distinct f.row ->> 'external_id' as x
        from jsonb_array_elements(p_flows) as f(row)
    ) as ids
  ) <> incoming_flows then
    raise exception 'the cash-flow payload repeats an external_id'
      using errcode = '22023';
  end if;

  -- --- reconciliation is a check, not a delete -----------------------------
  --
  -- Anything stored that the payload does not mention aborts the transaction.
  -- Nothing here can remove a row; the only mutations below are upserts.
  -- The payload is expanded **once** and anti-joined. A correlated
  -- `not exists (select ... from jsonb_array_elements(p_equity))` re-expands
  -- the whole array for every stored row: at 1 250 days that is 1.5 million
  -- element expansions, and the real-PostgREST gate timed out on it.
  with incoming as materialized (
    select try_date(e.row ->> 'snapshot_date') as snapshot_date
      from jsonb_array_elements(p_equity) as e(row)
  ),
  sampled as (
    select s.snapshot_date::text as sample
      from equity_snapshots s
      left join incoming i on i.snapshot_date = s.snapshot_date
     where s.account_id = reservation.account_id
       and s.source = 'alpaca_portfolio_history'
       and i.snapshot_date is null
     order by s.snapshot_date
     limit 5
  )
  select count(*), string_agg(sample, ', ' order by sample)
    into missing_count, missing_sample
    from sampled;

  if coalesce(missing_count, 0) > 0 then
    raise exception
      'RECONCILIATION_CONFLICT: the portfolio history no longer reports stored session(s) %. '
      'A payload that omits a stored day is indistinguishable from a partial response, so '
      'nothing was written. Use retract_equity_snapshot to withdraw a day deliberately.',
      missing_sample
      using errcode = '23514';
  end if;

  with incoming as materialized (
    select f.row ->> 'external_id' as external_id
      from jsonb_array_elements(p_flows) as f(row)
  ),
  sampled as (
    select c.external_id as sample
      from cash_flows c
      left join incoming i on i.external_id = c.external_id
     where c.account_id = reservation.account_id
       and c.source = 'alpaca_activities'
       and c.flow_date >= p_flows_from
       and c.external_id is not null
       and i.external_id is null
     order by c.external_id
     limit 5
  )
  select count(*), string_agg(sample, ', ' order by sample)
    into missing_count, missing_sample
    from sampled;

  if coalesce(missing_count, 0) > 0 then
    raise exception
      'RECONCILIATION_CONFLICT: the activity walk no longer reports mirrored activity/activities %. '
      'The absence of an activity is not evidence that a mirrored one was withdrawn, so nothing '
      'was written. Use retract_cash_flow to withdraw one deliberately.',
      missing_sample
      using errcode = '23514';
  end if;

  -- --- upserts only --------------------------------------------------------
  if incoming_equity > 0 then
    with incoming as (
      select
        try_date(row ->> 'snapshot_date')      as snapshot_date,
        (row ->> 'equity')::numeric            as equity,
        (row ->> 'cash')::numeric              as cash,
        (row ->> 'profit_loss')::numeric       as profit_loss,
        (row ->> 'profit_loss_pct')::numeric   as profit_loss_pct
      from jsonb_array_elements(p_equity) as row
    ),
    upserted as (
      insert into equity_snapshots (
        account_id, snapshot_date, equity, cash, profit_loss, profit_loss_pct, source
      )
      select reservation.account_id, snapshot_date, equity, cash,
             profit_loss, profit_loss_pct, 'alpaca_portfolio_history'
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
  end if;

  if incoming_flows > 0 then
    with incoming as (
      select
        (row ->> 'external_id')       as external_id,
        try_date(row ->> 'flow_date') as flow_date,
        (row ->> 'amount')::numeric   as amount,
        (row ->> 'kind')              as kind
      from jsonb_array_elements(p_flows) as row
    ),
    upserted as (
      insert into cash_flows (
        account_id, flow_date, amount, kind, source, external_id
      )
      select reservation.account_id, flow_date, amount, kind,
             'alpaca_activities', external_id
        from incoming
      on conflict (account_id, external_id) do update
        set flow_date = excluded.flow_date,
            amount    = excluded.amount,
            kind      = excluded.kind
      returning 1
    )
    select count(*) into flows_written from upserted;
  end if;

  update broker_refresh_state
     set last_generation = reservation.generation,
         last_published_at = now()
   where account_id = reservation.account_id;

  update broker_refresh_token
     set consumed_at = now()
   where token = p_token;

  return jsonb_build_object(
    'generation', reservation.generation,
    'equity_written', equity_written,
    'equity_removed', 0,
    'flows_written', flows_written,
    'flows_removed', 0
  );
end;
$$;

revoke all on routine publish_broker_refresh(
  uuid, jsonb, boolean, jsonb, date, boolean, integer, boolean
) from public, anon, authenticated;
grant execute on routine publish_broker_refresh(
  uuid, jsonb, boolean, jsonb, date, boolean, integer, boolean
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. The deliberate, audited way to withdraw a mirrored row.
--
-- Rare, one row at a time, and it states why. That is the whole difference
-- from what 0017 did implicitly on every refresh.
-- ---------------------------------------------------------------------------
create or replace function retract_equity_snapshot(
  p_account uuid,
  p_owner   uuid,
  p_date    date,
  p_reason  text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  if p_account is null or p_owner is null or p_date is null
     or p_reason is null or btrim(p_reason) = '' then
    raise exception 'account, owner, date and a stated reason are required'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from accounts
     where id = p_account and owner_id = p_owner and deleted_at is null
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  delete from equity_snapshots
   where account_id = p_account and snapshot_date = p_date;
  get diagnostics removed = row_count;
  if removed = 0 then
    raise exception 'no equity snapshot is stored for %', p_date
      using errcode = 'P0002';
  end if;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, p_account, 'equity.retracted',
    jsonb_build_object('snapshot_date', p_date, 'reason', btrim(p_reason))
  );
  return true;
end;
$$;

create or replace function retract_cash_flow(
  p_account     uuid,
  p_owner       uuid,
  p_external_id text,
  p_reason      text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer;
begin
  if p_account is null or p_owner is null
     or p_external_id is null or btrim(p_external_id) = ''
     or p_reason is null or btrim(p_reason) = '' then
    raise exception 'account, owner, external id and a stated reason are required'
      using errcode = '22023';
  end if;
  if not exists (
    select 1 from accounts
     where id = p_account and owner_id = p_owner and deleted_at is null
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  delete from cash_flows
   where account_id = p_account and external_id = p_external_id;
  get diagnostics removed = row_count;
  if removed = 0 then
    raise exception 'no cash flow is stored for external id %', p_external_id
      using errcode = 'P0002';
  end if;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, p_account, 'cash_flow.retracted',
    jsonb_build_object('external_id', p_external_id, 'reason', btrim(p_reason))
  );
  return true;
end;
$$;

-- The count heuristic is gone, and nothing may reintroduce it.
drop function if exists equity_retraction_allowance(bigint);
drop function if exists equity_retraction_limit();

-- ---------------------------------------------------------------------------
-- 8. create_account_atomic — the reuse guard is now a constraint.
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
  if p_account_number is null or btrim(p_account_number) = '' then
    raise exception 'a broker account number is required' using errcode = '22023';
  end if;
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

  insert into accounts (
    owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    last_verified_at, credential_version
  )
  values (
    p_owner, btrim(p_nickname), p_mode, 'connected', coalesce(p_color, '#007aff'),
    p_key_secret, p_secret_secret, btrim(p_account_number),
    now(), 1
  )
  returning * into created;

  -- The reuse guard. `SELECT EXISTS` was a read, and two concurrent callers
  -- both read "free" before either wrote; the primary key here is evaluated at
  -- write time, so exactly one of them can succeed whatever the interleaving.
  -- It covers cross-column reuse too: one id cannot be a key here and a secret
  -- there, because the constraint is on the id alone.
  begin
    insert into account_credential_assignment (secret_id, account_id, role)
    values (p_key_secret, created.id, 'key'),
           (p_secret_secret, created.id, 'secret');
  exception when unique_violation then
    raise exception 'those Vault secrets are already in use by an active account'
      using errcode = '23505';
  end;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, created.id, 'account.created',
    jsonb_build_object('mode', p_mode, 'nickname', created.nickname)
  );

  return created;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Rotation and deletion bump the credential version and keep the
--    assignment table honest.
-- ---------------------------------------------------------------------------
create or replace function rotate_account_credentials(
  p_account        uuid,
  p_owner          uuid,
  p_api_key        text,
  p_api_secret     text,
  p_account_number text
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  target accounts;
begin
  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;
  if p_api_key is null or btrim(p_api_key) = ''
     or p_api_secret is null or btrim(p_api_secret) = '' then
    raise exception 'api key and secret are required' using errcode = '22023';
  end if;
  if p_account_number is null or btrim(p_account_number) = '' then
    raise exception 'a broker account number is required' using errcode = '22023';
  end if;

  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target.alpaca_key_secret_id is null
     or target.alpaca_secret_secret_id is null then
    raise exception 'account has no stored credentials' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from vault.secrets where id = target.alpaca_key_secret_id
  ) then
    raise exception 'the stored API key secret is missing from the vault'
      using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from vault.secrets where id = target.alpaca_secret_secret_id
  ) then
    raise exception 'the stored API secret is missing from the vault'
      using errcode = 'P0002';
  end if;

  perform vault.update_secret(target.alpaca_key_secret_id, p_api_key);
  perform vault.update_secret(target.alpaca_secret_secret_id, p_api_secret);

  -- The version bump is the point: a refresh holding a token issued before
  -- this transaction will be refused at publish time.
  update accounts
     set status                = 'connected',
         alpaca_account_number = btrim(p_account_number),
         last_verified_at      = now(),
         credential_version    = accounts.credential_version + 1
   where id = p_account
   returning * into target;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, p_account, 'account.keys_rotated',
    jsonb_build_object('credential_version', target.credential_version)
  );

  return target;
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

  -- Freeing the assignment before the secrets go is what lets the ids be
  -- reused later by a different account, and what stops a deleted account
  -- holding a claim on them forever.
  delete from account_credential_assignment where account_id = p_account;

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
           alpaca_account_number   = null,
           credential_version      = accounts.credential_version + 1
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

-- ---------------------------------------------------------------------------
-- 10. record_account_verification — the only way a status or binding changes.
--
-- `GET /api/accounts/[id]/status` and `/live` used to write `status` directly
-- when Alpaca rejected the credentials, so a read mutated the account and did
-- so unaudited. Verification is a command now: one transaction, one audit
-- entry, and a credential-version bump when the binding actually moves.
-- ---------------------------------------------------------------------------
create or replace function record_account_verification(
  p_account        uuid,
  p_owner          uuid,
  p_status         account_status,
  p_account_number text default null
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target  accounts;
  updated accounts;
  rebind  boolean;
begin
  if p_account is null or p_owner is null or p_status is null then
    raise exception 'account, owner and status are required' using errcode = '22023';
  end if;
  if p_account_number is not null and btrim(p_account_number) = '' then
    raise exception 'a broker account number cannot be blank' using errcode = '22023';
  end if;

  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  rebind :=
    p_account_number is not null
    and btrim(p_account_number) is distinct from target.alpaca_account_number;

  update accounts
     set status                = p_status,
         alpaca_account_number = coalesce(btrim(p_account_number), alpaca_account_number),
         last_verified_at      = case when p_status = 'connected' then now()
                                      else last_verified_at end,
         credential_version    = accounts.credential_version + (case when rebind then 1 else 0 end)
   where id = p_account
   returning * into updated;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, p_account, 'account.verified',
    jsonb_build_object(
      'status', p_status,
      'rebound', rebind,
      'credential_version', updated.credential_version
    )
  );

  return updated;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Restate every grant, and fail if the catalogue disagrees.
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
         'create_account_atomic', 'delete_account_atomic',
         'rotate_account_credentials', 'account_history_snapshot',
         'update_account_metadata', 'begin_broker_refresh',
         'publish_broker_refresh', 'retract_equity_snapshot',
         'retract_cash_flow', 'record_account_verification',
         'try_date', 'broker_refresh_row_limit', 'broker_refresh_token_ttl'
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
    if has_table_privilege(role_, 'broker_refresh_token', 'SELECT')
       or has_table_privilege(role_, 'broker_refresh_token', 'INSERT')
       or has_table_privilege(role_, 'broker_refresh_token', 'UPDATE')
       or has_table_privilege(role_, 'broker_refresh_token', 'DELETE') then
      problems := problems || format('%s can reach broker_refresh_token', role_);
    end if;
    if has_table_privilege(role_, 'account_credential_assignment', 'SELECT')
       or has_table_privilege(role_, 'account_credential_assignment', 'INSERT')
       or has_table_privilege(role_, 'account_credential_assignment', 'UPDATE')
       or has_table_privilege(role_, 'account_credential_assignment', 'DELETE') then
      problems := problems || format('%s can reach account_credential_assignment', role_);
    end if;
  end loop;

  -- The heuristic must be gone, not merely unused.
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('equity_retraction_limit', 'equity_retraction_allowance')
  ) then
    problems := problems || 'the equity retraction allowance still exists';
  end if;

  if not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'account_credential_assignment'
       and c.contype = 'p'
  ) then
    problems := problems || 'account_credential_assignment has no primary key';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'no-delete reconciliation lockdown failed: %',
      array_to_string(problems, '; ');
  end if;
end $$;
