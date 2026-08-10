-- ============================================================================
-- accounts_server_managed.test.sql — proves clients cannot write account rows
--
-- Run against a database with migrations 0001–0010 applied. Two auth users
-- must exist; pass their UUIDs via psql variables:
--
--   psql "$DATABASE_URL" \
--     -v user_a='00000000-0000-0000-0000-00000000000a' \
--     -v user_b='00000000-0000-0000-0000-00000000000b' \
--     -f supabase/tests/accounts_server_managed.test.sql
--
-- `supabase/tests/run_integration.sh` does all of that against a real
-- PostgreSQL service in CI. Every assertion raises on failure; a clean run
-- prints "ACCOUNTS LOCKDOWN OK". The script runs in a transaction and rolls
-- back, so it leaves no data.
-- ============================================================================

begin;

-- psql variables are not interpolated inside dollar-quoted blocks, so stash
-- the second user id in a transaction-local setting the blocks can read.
select set_config('test.user_b', :'user_b', true);

-- --- fixture: one account per user, created as the service role ------------
insert into accounts (
  id, owner_id, nickname, mode, status, alpaca_account_number,
  alpaca_key_secret_id, alpaca_secret_secret_id
)
values
  (
    'aaaaaaaa-0000-0000-0000-0000000000f1', :'user_a', 'Locked A', 'paper',
    'connected', 'PA-FIXTURE-9999',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222'
  ),
  (
    'bbbbbbbb-0000-0000-0000-0000000000f2', :'user_b', 'Locked B', 'paper',
    'connected', 'PA-FIXTURE-1111', null, null
  );

-- --- 0. the service-role server path works ---------------------------------
-- (the inserts above ran as the migration/service session)
do $$ begin
  if (select count(*) from accounts
      where id in ('aaaaaaaa-0000-0000-0000-0000000000f1',
                   'bbbbbbbb-0000-0000-0000-0000000000f2')) <> 2 then
    raise exception 'FAIL: the service-role path could not create accounts';
  end if;
end $$;

-- The service role may also update a server-managed column.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update accounts set alpaca_account_number = 'PA-ROTATED-4242'
 where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
do $$ begin
  if (select alpaca_account_number from accounts
      where id = 'aaaaaaaa-0000-0000-0000-0000000000f1') <> 'PA-ROTATED-4242' then
    raise exception 'FAIL: the service role cannot update server-managed columns';
  end if;
end $$;
reset role;

-- --- switch to user A as an ordinary authenticated client ------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);

-- --- 1. the owner can still read their own row -----------------------------
do $$ begin
  if (select count(*) from accounts
      where id = 'aaaaaaaa-0000-0000-0000-0000000000f1') <> 1 then
    raise exception 'FAIL: owner cannot read their own account';
  end if;
end $$;

-- --- 2. the owner CAN change explicitly allowed metadata -------------------
update accounts set nickname = 'Renamed by owner', color = '#123456', is_active = false
 where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
do $$ begin
  if (select nickname from accounts
      where id = 'aaaaaaaa-0000-0000-0000-0000000000f1') <> 'Renamed by owner' then
    raise exception 'FAIL: owner cannot change allowed metadata';
  end if;
end $$;

-- --- 3. the owner cannot INSERT a new account ------------------------------
do $$
declare blocked boolean := false;
begin
  begin
    insert into accounts (owner_id, nickname, mode)
    values (auth.uid(), 'Injected', 'live');
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could INSERT an account';
  end if;
end $$;

-- --- 4. the owner cannot change `mode` -------------------------------------
do $$
declare blocked boolean := false;
begin
  begin
    update accounts set mode = 'live'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    blocked := not found;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could change accounts.mode';
  end if;
end $$;

-- --- 5. the owner cannot forge the production broker binding ---------------
do $$
declare blocked boolean := false;
begin
  begin
    update accounts set alpaca_account_number = 'PA-PRODUCTION-0001'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    blocked := not found;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception
      'FAIL: authenticated user could forge accounts.alpaca_account_number';
  end if;
end $$;

-- --- 6. the owner cannot rewrite owner_id, status or the Vault UUIDs -------
do $$
declare blocked boolean := false;
begin
  begin
    update accounts
       set owner_id = current_setting('test.user_b')::uuid,
           status = 'connected',
           alpaca_key_secret_id = gen_random_uuid()
     where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    blocked := not found;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could rewrite server-managed columns';
  end if;
end $$;

-- --- 7. the owner cannot soft-delete or DELETE ----------------------------
do $$
declare blocked boolean := false;
begin
  begin
    update accounts set deleted_at = now()
     where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    blocked := not found;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could soft-delete an account';
  end if;
end $$;

do $$
declare blocked boolean := false;
begin
  begin
    delete from accounts where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    blocked := not found;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could DELETE an account';
  end if;
end $$;

-- --- 8. a foreign row can be neither read nor written ----------------------
do $$ begin
  if (select count(*) from accounts
      where id = 'bbbbbbbb-0000-0000-0000-0000000000f2') <> 0 then
    raise exception 'FAIL: user A can read user B account (RLS leak)';
  end if;
end $$;

do $$
declare blocked boolean := false;
begin
  begin
    update accounts set nickname = 'stolen'
     where id = 'bbbbbbbb-0000-0000-0000-0000000000f2';
    blocked := not found;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: user A could update user B account';
  end if;
end $$;

-- --- 9. user B still cannot read user A's row ------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'user_b', 'role', 'authenticated')::text, true);
do $$ begin
  if (select count(*) from accounts
      where id = 'aaaaaaaa-0000-0000-0000-0000000000f1') <> 0 then
    raise exception 'FAIL: user B can read user A account (RLS leak)';
  end if;
end $$;

-- --- 10. anon can read nothing --------------------------------------------
-- The grant was revoked outright, so a read raises rather than returning an
-- empty set. Either outcome is acceptable; seeing a row is not.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
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

-- --- 11a. the guard denies a client role even with no JWT claims at all ----
-- This is the exact 0009 defect: a SECURITY DEFINER guard saw its owner in
-- `current_user` and authorized everyone whenever claims were absent.
set local role authenticated;
select set_config('request.jwt.claims', '', true);
do $$ begin
  if is_service_role() then
    raise exception
      'FAIL: is_service_role() authorizes a client role with no JWT claims';
  end if;
end $$;

-- --- 11b. the guard is not fooled by a forged role claim ------------------
-- An authenticated session claiming to be the service role must still be
-- rejected: the trigger reads the request's role claim, and PostgREST would
-- never issue this combination — but if it somehow did, RLS and the grant
-- still apply and the write must not succeed.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a', 'role', 'service_role')::text, true);
do $$
declare blocked boolean := false;
begin
  begin
    update accounts set alpaca_account_number = 'PA-FORGED-0000'
     where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    blocked := not found;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: a forged service_role claim could rewrite the binding';
  end if;
end $$;

reset role;
do $$ begin raise notice 'ACCOUNTS LOCKDOWN OK'; end $$;

rollback;
