-- ============================================================================
-- accounts_server_managed.test.sql — proves clients cannot write account rows
--
-- Run against a project with migrations 0001–0009 applied. Two auth users must
-- exist; pass their UUIDs via psql variables:
--
--   psql "$DATABASE_URL" \
--     -v user_a='00000000-0000-0000-0000-00000000000a' \
--     -v user_b='00000000-0000-0000-0000-00000000000b' \
--     -f supabase/tests/accounts_server_managed.test.sql
--
-- Every assertion raises on failure; a clean run prints "ACCOUNTS LOCKDOWN OK".
-- The whole script runs in a transaction and rolls back — it leaves no data.
-- ============================================================================

begin;

-- --- fixture: one account owned by user A, created as the service role -----
insert into accounts (
  id, owner_id, nickname, mode, status, alpaca_account_number
)
values (
  'aaaaaaaa-0000-0000-0000-0000000000f1', :'user_a', 'Locked A', 'paper',
  'connected', 'PA-FIXTURE-9999'
);

set local role authenticated;
set local request.jwt.claims to json_build_object('sub', :'user_a', 'role', 'authenticated')::text;

-- --- 1. the owner can still read their own row -----------------------------
do $$ begin
  if (select count(*) from accounts
      where id = 'aaaaaaaa-0000-0000-0000-0000000000f1') <> 1 then
    raise exception 'FAIL: owner cannot read their own account';
  end if;
end $$;

-- --- 2. the owner cannot INSERT a new account ------------------------------
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

-- --- 3. the owner cannot change `mode` -------------------------------------
do $$
declare blocked boolean := false;
begin
  begin
    update accounts set mode = 'live'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    if found then blocked := false; else blocked := true; end if;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could change accounts.mode';
  end if;
end $$;

-- --- 4. the owner cannot change the broker account number ------------------
do $$
declare blocked boolean := false;
begin
  begin
    update accounts set alpaca_account_number = 'PA-PRODUCTION-0001'
    where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    if found then blocked := false; else blocked := true; end if;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception
      'FAIL: authenticated user could change accounts.alpaca_account_number';
  end if;
end $$;

-- --- 5. the owner cannot change owner_id, status or the Vault UUIDs --------
do $$
declare blocked boolean := false;
begin
  begin
    update accounts
       set owner_id = :'user_b'::uuid,
           status = 'connected',
           alpaca_key_secret_id = gen_random_uuid()
     where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    if found then blocked := false; else blocked := true; end if;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could rewrite server-managed columns';
  end if;
end $$;

-- --- 6. the owner cannot soft-delete or DELETE ----------------------------
do $$
declare blocked boolean := false;
begin
  begin
    delete from accounts where id = 'aaaaaaaa-0000-0000-0000-0000000000f1';
    if found then blocked := false; else blocked := true; end if;
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: authenticated user could DELETE an account';
  end if;
end $$;

-- --- 7. user B still cannot read user A's row ------------------------------
set local request.jwt.claims to json_build_object('sub', :'user_b', 'role', 'authenticated')::text;
do $$ begin
  if (select count(*) from accounts
      where id = 'aaaaaaaa-0000-0000-0000-0000000000f1') <> 0 then
    raise exception 'FAIL: user B can read user A account (RLS leak)';
  end if;
end $$;

-- --- 8. anon can read nothing ---------------------------------------------
set local role anon;
do $$ begin
  if (select count(*) from accounts) <> 0 then
    raise exception 'FAIL: anon can read accounts';
  end if;
end $$;

reset role;
do $$ begin raise notice 'ACCOUNTS LOCKDOWN OK'; end $$;

rollback;
