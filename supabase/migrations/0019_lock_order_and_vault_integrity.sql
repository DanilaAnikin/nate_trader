-- ============================================================================
-- 0019_lock_order_and_vault_integrity.sql — one lock order, credentials issued
-- with the token that describes them, and a Vault assignment table that is
-- proved rather than assumed.
--
-- **1. The identity re-check was a read, so it could be read past.** 0018
-- re-checked `credential_version`, `mode` and the broker account number with a
-- plain `SELECT`. Under READ COMMITTED every statement inside a plpgsql
-- function takes a fresh snapshot, so a rotation committing between that check
-- and the upserts is simply invisible — the publish writes data fetched with
-- credentials that no longer exist and reports success. Reproduced: with the
-- account row held `FOR UPDATE` by another session, the publish returned
-- `{"equity_written": 6}` in one second instead of waiting.
--
-- 0018 removed the `FOR UPDATE` for a real reason — it took the token row
-- first and the account row second, while `record_account_verification` takes
-- the account row and nothing else, which is a lock-order inversion. The fix
-- is not to drop the lock but to order it. **Canonical order, everywhere:**
--
--     1. accounts                    (the entity everything else hangs off)
--     2. broker_refresh_token        (the reservation)
--     3. broker_refresh_state        (the published generation)
--     4. account_credential_assignment, via advisory locks on the two Vault
--        ids in ascending order
--
-- Every routine below acquires a prefix of that sequence, so no cycle exists.
--
-- **2. Credentials were fetched before the reservation existed.** The caller
-- read `get_account_credentials` and *then* reserved, so a rotation landing
-- between the two produced a token recording the new `credential_version`
-- while the fetch used the old key — the one combination the version check
-- cannot catch, because the token and the account agree. Credentials and token
-- now come from one transaction, so what the token records is by construction
-- what the caller holds.
--
-- **3. Rebinding an account mixed two brokers' history.** Changing
-- `alpaca_account_number` on an account that already has mirrored rows leaves
-- one equity curve describing two different broker accounts, with nothing in
-- the data marking the seam. A rebind is now refused once history exists; a
-- different broker account is a different account, and that is the epoch
-- boundary.
--
-- **4. The Vault backfill accepted whatever it found.** 0018 populated
-- `account_credential_assignment` with `ON CONFLICT DO NOTHING`, which is not
-- a resolution of an ambiguous legacy state — it is a way of not noticing one.
-- Two accounts sharing a secret, an id used as one account's key and another's
-- secret, a dangling id, a null id: each produced a silently incomplete table
-- and the constraint then "held" over data it had never checked. This
-- migration rebuilds the table with every one of those as an abort, and proves
-- exact correspondence afterwards.
--
-- 0001–0018 are not edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Vault integrity: abort before touching anything.
-- ---------------------------------------------------------------------------
do $$
declare
  problems text[] := '{}';
  offending text;
begin
  -- (a) An active account missing either id, or holding the same id twice.
  select string_agg(format('account %s', id), ', ')
    into offending
    from accounts
   where deleted_at is null
     and (alpaca_key_secret_id is null
          or alpaca_secret_secret_id is null
          or alpaca_key_secret_id = alpaca_secret_secret_id);
  if offending is not null then
    problems := problems
      || format('null or self-referential Vault ids: %s', offending);
  end if;

  -- (b) One id shared by two active accounts, in any slot combination.
  --     `cross-slot` is the case a per-column unique index would miss: the
  --     same id as one account's key and another's secret.
  select string_agg(format('%s used %s times', secret_id, uses), ', ')
    into offending
    from (
      select secret_id, count(*) as uses
        from (
          select id as account_id, alpaca_key_secret_id as secret_id
            from accounts where deleted_at is null
             and alpaca_key_secret_id is not null
          union all
          select id, alpaca_secret_secret_id
            from accounts where deleted_at is null
             and alpaca_secret_secret_id is not null
        ) as slots
       group by secret_id
      having count(*) > 1
    ) as shared;
  if offending is not null then
    problems := problems || format('shared Vault ids: %s', offending);
  end if;

  -- (c) An id that does not exist in the vault at all.
  select string_agg(format('%s', secret_id), ', ')
    into offending
    from (
      select alpaca_key_secret_id as secret_id
        from accounts where deleted_at is null
         and alpaca_key_secret_id is not null
      union
      select alpaca_secret_secret_id
        from accounts where deleted_at is null
         and alpaca_secret_secret_id is not null
    ) as referenced
   where not exists (select 1 from vault.secrets v where v.id = referenced.secret_id);
  if offending is not null then
    problems := problems || format('dangling Vault ids: %s', offending);
  end if;

  if array_length(problems, 1) is not null then
    raise exception
      'Vault credential state is ambiguous and must be resolved by hand before '
      'this migration can run: %. Resolving it automatically would mean '
      'guessing which account owns a shared secret.',
      array_to_string(problems, '; ');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Rebuild the assignment table from the accounts rows, exactly.
--
-- No `ON CONFLICT`: the checks above establish that no conflict is possible,
-- so one here would only hide a check that failed to fire.
-- ---------------------------------------------------------------------------
delete from account_credential_assignment;

insert into account_credential_assignment (secret_id, account_id, role)
select a.alpaca_key_secret_id, a.id, 'key'
  from accounts a
 where a.deleted_at is null and a.alpaca_key_secret_id is not null;

insert into account_credential_assignment (secret_id, account_id, role)
select a.alpaca_secret_secret_id, a.id, 'secret'
  from accounts a
 where a.deleted_at is null and a.alpaca_secret_secret_id is not null;

-- Real referential integrity, now that the rows are known to be clean.
alter table account_credential_assignment
  drop constraint if exists account_credential_assignment_secret_fk;

do $$ begin
  -- `vault.secrets` is a Supabase-managed table; the FK is added when the
  -- platform permits it and skipped (with the assertion below standing in)
  -- when it does not.
  begin
    alter table account_credential_assignment
      add constraint account_credential_assignment_secret_fk
      foreign key (secret_id) references vault.secrets(id) on delete restrict;
  exception when insufficient_privilege or wrong_object_type or undefined_table then
    raise notice
      'vault.secrets does not accept a foreign key here; the catalogue '
      'assertion below is the integrity check instead';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Prove exact correspondence, or fail.
-- ---------------------------------------------------------------------------
do $$
declare
  mismatched bigint;
  missing    bigint;
begin
  -- Every active account has exactly one key and one secret assignment,
  -- pointing at the ids the account row actually holds.
  select count(*) into mismatched
    from accounts a
   where a.deleted_at is null
     and not (
       exists (
         select 1 from account_credential_assignment x
          where x.account_id = a.id and x.role = 'key'
            and x.secret_id = a.alpaca_key_secret_id
       )
       and exists (
         select 1 from account_credential_assignment x
          where x.account_id = a.id and x.role = 'secret'
            and x.secret_id = a.alpaca_secret_secret_id
       )
       and (
         select count(*) from account_credential_assignment x
          where x.account_id = a.id
       ) = 2
     );
  if mismatched > 0 then
    raise exception
      '% active account(s) do not have exactly the two credential assignments '
      'their row states', mismatched;
  end if;

  -- No assignment survives for a deleted or absent account.
  select count(*) into missing
    from account_credential_assignment x
   where not exists (
     select 1 from accounts a where a.id = x.account_id and a.deleted_at is null
   );
  if missing > 0 then
    raise exception '% credential assignment(s) belong to no active account', missing;
  end if;

  -- Every assigned secret exists.
  select count(*) into missing
    from account_credential_assignment x
   where not exists (select 1 from vault.secrets v where v.id = x.secret_id);
  if missing > 0 then
    raise exception '% assigned Vault secret(s) do not exist', missing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The advisory lock that serializes credential-set operations.
--
-- Two ids, taken in ascending order so two callers naming the same pair always
-- queue rather than deadlock. This covers the window a unique constraint alone
-- cannot: a delete freeing a pair while a creation claims it.
-- ---------------------------------------------------------------------------
create or replace function lock_credential_pair(p_a uuid, p_b uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  ids uuid[];
begin
  if p_a is null or p_b is null then
    raise exception 'both Vault ids are required to lock a credential pair'
      using errcode = '22023';
  end if;
  ids := array(select unnest(array[p_a, p_b]) order by 1);
  -- `hashtextextended` gives a stable 64-bit key per uuid; taking them in
  -- ascending uuid order makes the acquisition order total across callers.
  perform pg_advisory_xact_lock(hashtextextended(ids[1]::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(ids[2]::text, 0));
end;
$$;

revoke all on routine lock_credential_pair(uuid, uuid) from public, anon, authenticated;
grant execute on routine lock_credential_pair(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. begin_broker_refresh_with_credentials — one transaction, one identity.
--
-- The credentials returned are read *after* the account row is locked and
-- *inside* the transaction that writes the token, so the version the token
-- records is the version the key belongs to. There is no window.
-- ---------------------------------------------------------------------------
create or replace function begin_broker_refresh_with_credentials(
  p_account uuid,
  p_owner   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  target     accounts;
  generation bigint;
  issued     uuid;
  key_value  text;
  sec_value  text;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;

  -- Lock order step 1: the account row.
  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target.alpaca_key_secret_id is null or target.alpaca_secret_secret_id is null then
    raise exception 'account has no stored credentials' using errcode = 'P0002';
  end if;

  select decrypted_secret into key_value
    from vault.decrypted_secrets where id = target.alpaca_key_secret_id;
  select decrypted_secret into sec_value
    from vault.decrypted_secrets where id = target.alpaca_secret_secret_id;
  if key_value is null or sec_value is null then
    raise exception 'the stored credentials could not be decrypted'
      using errcode = 'P0002';
  end if;

  delete from broker_refresh_token
   where account_id = p_account
     and issued_at < now() - interval '1 day';

  generation := nextval('broker_refresh_generation_seq');

  -- Lock order step 2: the token row (created here, so trivially ordered).
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
    'account_number', target.alpaca_account_number,
    'api_key', key_value,
    'api_secret', sec_value
  );
end;
$$;

revoke all on routine begin_broker_refresh_with_credentials(uuid, uuid)
  from public, anon, authenticated;
grant execute on routine begin_broker_refresh_with_credentials(uuid, uuid)
  to service_role;

-- The credential-free reservation is kept for callers that genuinely do not
-- need the key (the SQL tests), and now takes the account lock too so that it
-- follows the same order.
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
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;

  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

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

-- ---------------------------------------------------------------------------
-- 6. publish_broker_refresh — same body as 0018, with the account row locked
--    first so the identity re-check cannot be read past.
-- ---------------------------------------------------------------------------
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
  if incoming_flows > p_flows_scanned then
    raise exception
      'the activity walk reports % rows from % examined activities',
      incoming_flows, p_flows_scanned
      using errcode = '22023';
  end if;

  -- --- the reservation -----------------------------------------------------
  -- Read without a lock first, purely to learn which account row to lock. The
  -- token is immutable apart from `consumed_at`, and the real lock on it is
  -- taken below in canonical order.
  select * into reservation from broker_refresh_token where token = p_token;
  if not found then
    raise exception 'unknown refresh token' using errcode = 'P0002';
  end if;

  -- Lock order step 1: the account row. This is the change. A plain SELECT
  -- here let a rotation commit between the identity check and the upserts,
  -- and READ COMMITTED made that invisible: each statement in this function
  -- takes its own snapshot. Holding the row means every rotation, rebinding
  -- and deletion either happened entirely before this publish or waits for it.
  select * into target
    from accounts
   where id = reservation.account_id
     and owner_id = reservation.owner_id
     and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- Lock order step 2: the token row.
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
  if reservation.account_id <> target.id then
    raise exception 'the refresh token does not belong to the locked account'
      using errcode = 'P0001';
  end if;

  -- Identity re-check. `P0001`, never class 40: a 40001 tells PostgREST the
  -- call may succeed on retry and it retries in a loop, hanging the request.
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

  -- Lock order step 3: the generation row.
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

  -- Every mutation of the financial mirrors is audited. A refresh is now an
  -- explicit command with an actor behind it (`POST .../refresh`), so the
  -- ledger can answer "who moved this, and when" for the mirrors exactly as
  -- it already does for the account lifecycle.
  insert into audit_log (actor_id, account_id, action, detail)
  values (
    reservation.owner_id, reservation.account_id, 'broker.refresh_published',
    jsonb_build_object(
      'generation', reservation.generation,
      'equity_written', equity_written,
      'flows_written', flows_written,
      'credential_version', reservation.credential_version
    )
  );

  return jsonb_build_object(
    'generation', reservation.generation,
    'equity_written', equity_written,
    'equity_removed', 0,
    'flows_written', flows_written,
    'flows_removed', 0
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. A rebind is a new epoch, not an edit.
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
  target     accounts;
  updated    accounts;
  rebind     boolean;
  history    bigint;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null or p_status is null then
    raise exception 'account, owner and status are required' using errcode = '22023';
  end if;
  if p_account_number is not null and btrim(p_account_number) = '' then
    raise exception 'a broker account number cannot be blank' using errcode = '22023';
  end if;

  -- Lock order step 1.
  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  rebind :=
    p_account_number is not null
    and btrim(p_account_number) is distinct from target.alpaca_account_number
    and target.alpaca_account_number is not null;

  -- Two broker accounts in one equity curve is not a curve. Nothing in the
  -- mirrored rows marks where one account stops and the other starts, so the
  -- return, the drawdown and the benchmark comparison would all be computed
  -- across a seam that is invisible in the data. A different broker account
  -- is a different account; create one.
  if rebind then
    select (
      (select count(*) from equity_snapshots where account_id = p_account)
      + (select count(*) from cash_flows where account_id = p_account)
    ) into history;
    if history > 0 then
      raise exception
        'refusing to rebind account % from broker account % to %: % mirrored '
        'row(s) already describe the first one, and one equity curve cannot '
        'describe two broker accounts. Create a new account instead.',
        p_account, target.alpaca_account_number, btrim(p_account_number), history
        using errcode = '23514';
    end if;
  end if;

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
-- 8. Creation and deletion take the credential-pair lock.
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
  perform set_config('lock_timeout', '5s', true);

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

  -- Lock order step 4: the credential pair, in ascending id order. The unique
  -- constraint alone leaves a window against a concurrent *delete* freeing the
  -- same pair; this closes it, and two callers naming the same pair queue
  -- rather than deadlock because the order is total.
  perform lock_credential_pair(p_key_secret, p_secret_secret);

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
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null or p_purge_history is null then
    raise exception 'account, owner and purge flag are required'
      using errcode = '22023';
  end if;

  -- Lock order step 1.
  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- Lock order step 4, so a creation reusing this pair waits for the delete to
  -- commit rather than racing the constraint against a half-freed assignment.
  if target.alpaca_key_secret_id is not null
     and target.alpaca_secret_secret_id is not null then
    perform lock_credential_pair(
      target.alpaca_key_secret_id, target.alpaca_secret_secret_id
    );
  end if;

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

-- `rotate_account_credentials` already takes the account row `FOR UPDATE`
-- first and touches no refresh table, so it is already in canonical order; it
-- only needs the bounded wait.
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
  perform set_config('lock_timeout', '5s', true);

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
  if btrim(p_account_number) is distinct from target.alpaca_account_number then
    raise exception
      'rotate_account_credentials cannot change the broker account number; '
      'use record_account_verification, which refuses a rebind once history exists'
      using errcode = '23514';
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

  update accounts
     set status             = 'connected',
         last_verified_at   = now(),
         credential_version = accounts.credential_version + 1
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

-- ---------------------------------------------------------------------------
-- 9. Grants, and a catalogue assertion.
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
         'begin_broker_refresh', 'begin_broker_refresh_with_credentials',
         'publish_broker_refresh', 'record_account_verification',
         'create_account_atomic', 'delete_account_atomic',
         'rotate_account_credentials', 'lock_credential_pair'
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

  if not has_function_privilege(
       'service_role',
       'begin_broker_refresh_with_credentials(uuid,uuid)', 'EXECUTE') then
    problems := problems || 'service_role cannot reserve a refresh with credentials';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'lock-order/vault lockdown failed: %',
      array_to_string(problems, '; ');
  end if;
end $$;
