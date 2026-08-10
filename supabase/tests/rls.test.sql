-- ============================================================================
-- rls.test.sql — Row-Level Security verification (DASHBOARD plan T1.8)
--
-- Proves account isolation and credential lockdown. Run against a project
-- that has migrations 0001–0011 applied. Two auth users must exist; pass
-- their UUIDs via psql variables:
--
--   psql "$DATABASE_URL" \
--     -v user_a='00000000-0000-0000-0000-00000000000a' \
--     -v user_b='00000000-0000-0000-0000-00000000000b' \
--     -f supabase/tests/rls.test.sql
--
-- Every assertion raises an exception on failure; a clean run prints "RLS OK".
-- The whole script runs in a transaction and rolls back — it leaves no data.
-- ============================================================================

begin;

-- --- fixture: one account owned by user A ----------------------------------
insert into accounts (id, owner_id, nickname, mode)
values ('aaaaaaaa-0000-0000-0000-000000000001', :'user_a', 'Test A', 'paper');

-- --- 1. user A can see their own account through the sanitized view --------
-- Since 0011 the base table carries no client privileges, so isolation is
-- asserted on the only client-readable surface.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a')::text, true);
do $$ begin
  if (select count(*) from accounts_safe
      where id = 'aaaaaaaa-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FAIL: user A cannot see their own account';
  end if;
end $$;

-- --- 2. user B cannot read user A's account --------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'user_b')::text, true);
do $$ begin
  if (select count(*) from accounts_safe
      where id = 'aaaaaaaa-0000-0000-0000-000000000001') <> 0 then
    raise exception 'FAIL: user B can read user A account (RLS leak)';
  end if;
end $$;

-- --- 3. anon cannot read accounts at all -----------------------------------
set local role anon;
do $$
declare visible integer;
begin
  begin
    select count(*) into visible from accounts;
  exception when insufficient_privilege then visible := 0;
  end;
  if visible <> 0 then
    raise exception 'FAIL: anon can read accounts';
  end if;
end $$;

-- --- 4. get_account_credentials is NOT callable by authenticated -----------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a')::text, true);
do $$ begin
  begin
    perform get_account_credentials('aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'FAIL: authenticated could call get_account_credentials';
  exception
    when insufficient_privilege then null;  -- expected
  end;
end $$;

-- --- 5. equity_snapshots are isolated per owner ----------------------------
set local role postgres;
insert into equity_snapshots (account_id, snapshot_date, equity, cash)
values ('aaaaaaaa-0000-0000-0000-000000000001', current_date, 1000, 1000);

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_b')::text, true);
do $$ begin
  if (select count(*) from equity_snapshots) <> 0 then
    raise exception 'FAIL: user B can read user A equity snapshots';
  end if;
end $$;

reset role;
select 'RLS OK' as result;

rollback;
