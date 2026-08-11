-- ============================================================================
-- client_read_exposure.test.sql — what a signed-in browser can actually READ
--
-- These assertions run real SELECT statements under the `authenticated` role,
-- through exactly the privileges Supabase REST (PostgREST) uses. A DTO test in
-- the application cannot prove any of this: PostgREST answers the browser
-- directly and never goes near the Next.js allowlist.
--
-- Run with migrations 0001–0011 applied and two auth users:
--
--   psql "$DATABASE_URL" \
--     -v user_a='00000000-0000-0000-0000-00000000000a' \
--     -v user_b='00000000-0000-0000-0000-00000000000b' \
--     -f supabase/tests/client_read_exposure.test.sql
--
-- A clean run prints "CLIENT READ EXPOSURE OK" and rolls back.
-- ============================================================================

begin;

select set_config('test.user_b', :'user_b', true);

-- --- fixture: a live account, a soft-deleted account, and a trade ----------
insert into accounts (
  id, owner_id, nickname, mode, status, alpaca_account_number,
  alpaca_key_secret_id, alpaca_secret_secret_id, deleted_at
)
values
  (
    'aaaaaaaa-0000-0000-0000-0000000000e1', :'user_a', 'Live A', 'paper',
    'connected', 'PA-READ-CANARY-5150',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444', null
  ),
  (
    'aaaaaaaa-0000-0000-0000-0000000000e2', :'user_a', 'Deleted A', 'paper',
    'paused', 'PA-DELETED-CANARY-6161', null, null, now()
  ),
  (
    'bbbbbbbb-0000-0000-0000-0000000000e3', :'user_b', 'Live B', 'paper',
    'connected', 'PA-FOREIGN-CANARY-7171', null, null, null
  );

insert into trades (
  account_id, alpaca_order_id, symbol, side, qty, price, notional, filled_at
)
values (
  'aaaaaaaa-0000-0000-0000-0000000000e1', 'ORDER-CANARY-9001', 'ASML', 'buy',
  10, 100, 1000, now()
);

-- --- become an ordinary signed-in client -----------------------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);

-- --- 1. the base `accounts` table is not readable at all -------------------
do $$
declare visible integer;
begin
  begin
    select count(*) into visible from accounts;
  exception when insufficient_privilege then visible := -1;
  end;
  if visible <> -1 then
    raise exception
      'FAIL: authenticated can SELECT the accounts base table (% rows visible)',
      visible;
  end if;
end $$;

-- --- 2. no sensitive column is readable, one column at a time --------------
-- Column-level privileges are separate from table-level ones, so each is
-- probed individually rather than assuming the table check covers them.
do $$
declare
  col text;
  denied boolean;
begin
  foreach col in array array[
    'alpaca_account_number',
    'alpaca_key_secret_id',
    'alpaca_secret_secret_id',
    'owner_id',
    'deleted_at'
  ] loop
    denied := false;
    begin
      execute format('select %I from accounts limit 1', col);
    exception when insufficient_privilege then denied := true;
    end;
    if not denied then
      raise exception 'FAIL: authenticated can read accounts.% via REST', col;
    end if;
  end loop;
end $$;

-- --- 3. the trades base table (broker order id) is not readable ------------
do $$
declare visible integer;
begin
  begin
    select count(*) into visible from trades;
  exception when insufficient_privilege then visible := -1;
  end;
  if visible <> -1 then
    raise exception 'FAIL: authenticated can SELECT the trades base table';
  end if;
end $$;

do $$
declare denied boolean := false;
begin
  begin
    perform alpaca_order_id from trades limit 1;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can read trades.alpaca_order_id';
  end if;
end $$;

-- --- 4. the sanitized view shows only the owner's live account -------------
do $$
declare rows_seen integer;
begin
  select count(*) into rows_seen from accounts_safe;
  if rows_seen <> 1 then
    raise exception
      'FAIL: accounts_safe returned % rows, expected exactly the one live account',
      rows_seen;
  end if;
  if (select id from accounts_safe)
     <> 'aaaaaaaa-0000-0000-0000-0000000000e1' then
    raise exception 'FAIL: accounts_safe returned the wrong row';
  end if;
end $$;

-- --- 5. a soft-deleted account is invisible --------------------------------
do $$ begin
  if exists (
    select 1 from accounts_safe
    where id = 'aaaaaaaa-0000-0000-0000-0000000000e2'
  ) then
    raise exception 'FAIL: a soft-deleted account is readable through accounts_safe';
  end if;
end $$;

-- --- 6. a foreign account is invisible -------------------------------------
do $$ begin
  if exists (
    select 1 from accounts_safe
    where id = 'bbbbbbbb-0000-0000-0000-0000000000e3'
  ) then
    raise exception 'FAIL: another user''s account is readable through accounts_safe';
  end if;
end $$;

-- --- 7. the view exposes only the allowlisted columns ----------------------
do $$
declare unexpected text;
begin
  select string_agg(column_name, ', ')
    into unexpected
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'accounts_safe'
     and column_name not in (
       'id', 'nickname', 'mode', 'status', 'color', 'is_active',
       'broker_account_mask', 'last_verified_at', 'created_at'
     );
  if unexpected is not null then
    raise exception 'FAIL: accounts_safe exposes unexpected columns: %', unexpected;
  end if;
end $$;

-- --- 8. the view masks the broker account number ---------------------------
do $$
declare mask text;
begin
  select broker_account_mask into mask from accounts_safe;
  if mask is distinct from '••••5150' then
    raise exception 'FAIL: accounts_safe broker mask is %, expected ••••5150', mask;
  end if;
  if exists (
    select 1 from accounts_safe where broker_account_mask like '%CANARY%'
  ) then
    raise exception 'FAIL: accounts_safe leaked the full broker account number';
  end if;
end $$;

-- --- 9. trades_safe carries no order identifier ----------------------------
do $$
declare unexpected text;
begin
  select string_agg(column_name, ', ')
    into unexpected
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'trades_safe'
     and column_name = 'alpaca_order_id';
  if unexpected is not null then
    raise exception 'FAIL: trades_safe exposes alpaca_order_id';
  end if;
  if (select count(*) from trades_safe) <> 1 then
    raise exception 'FAIL: trades_safe did not return the owner''s trade';
  end if;
end $$;

-- --- 9b. the Alpaca activity id is unreachable too -------------------------
do $$
declare denied boolean := false;
begin
  begin
    perform external_id from cash_flows limit 1;
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can read cash_flows.external_id';
  end if;
end $$;

do $$
declare unexpected text;
begin
  select string_agg(column_name, ', ')
    into unexpected
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'cash_flows_safe'
     and column_name = 'external_id';
  if unexpected is not null then
    raise exception 'FAIL: cash_flows_safe exposes external_id';
  end if;
end $$;

-- --- 10. account-scoped tables exclude a soft-deleted account --------------
-- owns_account() gates every one of them, so a snapshot belonging to a deleted
-- account must disappear along with it.
reset role;
insert into equity_snapshots (account_id, snapshot_date, equity, cash)
values ('aaaaaaaa-0000-0000-0000-0000000000e2', current_date, 1000, 1000);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
do $$ begin
  if exists (
    select 1 from equity_snapshots
    where account_id = 'aaaaaaaa-0000-0000-0000-0000000000e2'
  ) then
    raise exception
      'FAIL: equity snapshots of a soft-deleted account are still readable';
  end if;
end $$;

-- --- 10b. the sanitized views are SELECT-only, in the catalogue ------------
-- Supabase's default ACL grants ALL on every new object directly to `anon` and
-- `authenticated`, and revoking from `public` does not touch a role grant. The
-- catalogue is checked before the DML attempts so a missing privilege and a
-- blocked statement cannot be confused for one another.
do $$
declare
  obj      text;
  role_    text;
  priv     text;
  problems text[] := '{}';
begin
  foreach obj in array array['accounts_safe', 'trades_safe', 'cash_flows_safe'] loop
    if not has_table_privilege('authenticated', obj::regclass, 'SELECT') then
      problems := problems || format('authenticated cannot SELECT %s', obj);
    end if;
    foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('authenticated', obj::regclass, priv) then
        problems := problems || format('authenticated has %s on %s', priv, obj);
      end if;
    end loop;
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('anon', obj::regclass, priv) then
        problems := problems || format('anon has %s on %s', priv, obj);
      end if;
    end loop;
  end loop;
  if array_length(problems, 1) is not null then
    raise exception 'FAIL: view ACL is wrong: %', array_to_string(problems, '; ');
  end if;
end $$;

-- --- 10c. and SELECT-only when actually exercised --------------------------
-- `accounts_safe` selects from one table with no aggregate, so PostgreSQL makes
-- it automatically updatable, and a view executes with its owner's privileges.
-- Before 0012 this exact UPDATE renamed the row: neither the base-table grant
-- nor the RLS policy applies to the view owner. Only the missing privilege
-- stops it, so the privilege is what is tested.
do $$
declare
  stmt     text;
  state    text;
  problems text[] := '{}';
begin
  -- `accounts_safe` is auto-updatable, so the *only* thing standing between a
  -- client and a write is the missing privilege. Each of these must fail with
  -- exactly 42501 insufficient_privilege.
  foreach stmt in array array[
    'update accounts_safe set nickname = ''pwned''',
    'delete from accounts_safe',
    'insert into accounts_safe (id, nickname, mode, status, color, is_active) '
      || 'values (gen_random_uuid(), ''forged'', ''paper'', ''connected'', ''#000'', true)'
  ] loop
    state := null;
    begin
      execute stmt;
    exception when others then state := SQLSTATE;
    end;
    if state is null then
      problems := problems || format('%s SUCCEEDED', stmt);
    elsif state <> '42501' then
      problems := problems
        || format('%s was refused with %s, not insufficient_privilege', stmt, state);
    end if;
  end loop;

  -- `trades_safe` and `cash_flows_safe` join two tables, so PostgreSQL rejects
  -- the statement as non-updatable (55000) before it ever reaches a privilege
  -- check. Both refusals are acceptable here — but not success, and not some
  -- third error. The catalogue assertion above is what proves the privilege
  -- itself is gone; this proves the write is unreachable in practice.
  foreach stmt in array array[
    'update trades_safe set symbol = ''PWN''',
    'delete from trades_safe',
    'insert into trades_safe (account_id, symbol, side, qty, price, notional, filled_at) '
      || 'values (gen_random_uuid(), ''PWN'', ''buy'', 1, 1, 1, now())',
    'update cash_flows_safe set amount = 999999',
    'delete from cash_flows_safe',
    'insert into cash_flows_safe (account_id, flow_date, amount, kind, source) '
      || 'values (gen_random_uuid(), current_date, 999999, ''deposit'', ''forged'')'
  ] loop
    state := null;
    begin
      execute stmt;
    exception when others then state := SQLSTATE;
    end;
    if state is null then
      problems := problems || format('%s SUCCEEDED', stmt);
    elsif state not in ('42501', '55000') then
      problems := problems || format('%s was refused with unexpected %s', stmt, state);
    end if;
  end loop;

  if array_length(problems, 1) is not null then
    raise exception 'FAIL: %', array_to_string(problems, '; ');
  end if;
end $$;

-- --- 10d. no client role may write any account-scoped table ----------------
do $$
declare
  obj      text;
  role_    text;
  priv     text;
  problems text[] := '{}';
begin
  foreach obj in array array[
    'equity_snapshots', 'performance', 'positions', 'routine_runs', 'audit_log',
    'strategy_params', 'market_history', 'research_snapshots',
    'screener_snapshots', 'backtest_runs'
  ] loop
    foreach role_ in array array['anon', 'authenticated'] loop
      foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
        if has_table_privilege(role_, obj::regclass, priv) then
          problems := problems || format('%s has %s on %s', role_, priv, obj);
        end if;
      end loop;
    end loop;
  end loop;
  -- The settings screen edits the caller's own profile; that stays.
  if not has_table_privilege('authenticated', 'profiles'::regclass, 'UPDATE') then
    problems := problems || 'authenticated lost UPDATE on profiles';
  end if;
  if array_length(problems, 1) is not null then
    raise exception 'FAIL: %', array_to_string(problems, '; ');
  end if;
end $$;

-- --- 10e. the write block is real, not only catalogued ---------------------
do $$
declare denied boolean := false;
begin
  begin
    insert into equity_snapshots (account_id, snapshot_date, equity, cash)
    values ('aaaaaaaa-0000-0000-0000-0000000000e1', current_date, 1, 1);
  exception when insufficient_privilege then denied := true;
  end;
  if not denied then
    raise exception 'FAIL: authenticated could INSERT an equity snapshot';
  end if;
end $$;

-- --- 11. anon sees nothing at all ------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
declare visible integer;
begin
  begin
    select count(*) into visible from accounts_safe;
  exception when insufficient_privilege then visible := 0;
  end;
  if visible <> 0 then
    raise exception 'FAIL: anon can read accounts_safe';
  end if;
end $$;

reset role;
-- --- the audit log an owner can read carries no internal identifier --------
--
-- `audit_log` has a "read own audit" policy, so everything written into
-- `detail` is owner-visible. Vault ids and the create-operation id were both
-- there; neither is information an owner needs, and both name internals.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', :'user_a', 'role', 'authenticated')::text,
  true
);

do $$
declare
  leaked text;
begin
  select string_agg(distinct action, ', ') into leaked
    from audit_log
   where detail ? 'operation_id'
      or detail ? 'key_secret_id'
      or detail ? 'secret_secret_id'
      or detail ? 'api_key'
      or detail ? 'alpaca_account_number'
      or detail::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  if leaked is not null then
    raise exception
      'FAIL: an owner-readable audit row names an internal identifier (%)', leaked;
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$ begin raise notice 'CLIENT READ EXPOSURE OK'; end $$;

rollback;
