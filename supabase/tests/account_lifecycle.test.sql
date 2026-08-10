-- ============================================================================
-- account_lifecycle.test.sql — the rotation and deletion transactions
--
-- These prove the property the TypeScript cannot: that a failure part-way
-- through leaves *nothing* behind. Each flow used to be a sequence of separate
-- round trips, so a failure between them produced a state no retry could
-- repair — most seriously a new Vault key beside the old secret, with the
-- previous key value already overwritten.
--
--   psql "$DATABASE_URL" \
--     -v user_a='00000000-0000-0000-0000-00000000000a' \
--     -v user_b='00000000-0000-0000-0000-00000000000b' \
--     -f supabase/tests/account_lifecycle.test.sql
--
-- A clean run prints "ACCOUNT LIFECYCLE OK" and rolls back.
-- ============================================================================

begin;

select set_config('test.user_a', :'user_a', true);
select set_config('test.user_b', :'user_b', true);

-- --- fixture: one account with two real Vault secrets ----------------------
select vault.create_secret('OLD-KEY', 'test-key') as key_id \gset
select vault.create_secret('OLD-SECRET', 'test-secret') as secret_id \gset

insert into accounts (
  id, owner_id, nickname, mode, status, alpaca_account_number,
  alpaca_key_secret_id, alpaca_secret_secret_id
)
values (
  'dddddddd-0000-0000-0000-0000000000d1', :'user_a', 'Rotating', 'paper',
  'connected', 'PA-OLD-1111', :'key_id', :'secret_id'
);

-- --- 1. a successful rotation moves everything at once ---------------------
select rotate_account_credentials(
  'dddddddd-0000-0000-0000-0000000000d1',
  :'user_a',
  'NEW-KEY',
  'NEW-SECRET',
  'PA-NEW-2222'
);

do $$
declare
  acct   accounts;
  keyval text;
  secval text;
begin
  select * into acct from accounts
   where id = 'dddddddd-0000-0000-0000-0000000000d1';
  select decrypted_secret into keyval from vault.decrypted_secrets
   where id = acct.alpaca_key_secret_id;
  select decrypted_secret into secval from vault.decrypted_secrets
   where id = acct.alpaca_secret_secret_id;

  if keyval <> 'NEW-KEY' or secval <> 'NEW-SECRET' then
    raise exception 'FAIL: rotation did not replace both secrets (% / %)',
      keyval, secval;
  end if;
  if acct.alpaca_account_number <> 'PA-NEW-2222' then
    raise exception 'FAIL: rotation did not rebind the broker account number';
  end if;
  if acct.status <> 'connected' or acct.last_verified_at is null then
    raise exception 'FAIL: rotation did not record the verification';
  end if;
  if not exists (
    select 1 from audit_log
     where account_id = 'dddddddd-0000-0000-0000-0000000000d1'
       and action = 'account.keys_rotated'
  ) then
    raise exception 'FAIL: rotation wrote no audit entry';
  end if;
end $$;

-- --- 2. a failure part-way through rolls the whole thing back --------------
-- The second Vault write is made to fail by pointing the account at a secret
-- id that does not exist. Before this was one transaction, the *first* write
-- would already have destroyed the previous key value.
do $$
declare
  acct    accounts;
  keyval  text;
  blocked boolean := false;
begin
  update accounts
     set alpaca_secret_secret_id = '00000000-dead-0000-0000-000000000000'
   where id = 'dddddddd-0000-0000-0000-0000000000d1';

  begin
    perform rotate_account_credentials(
      'dddddddd-0000-0000-0000-0000000000d1',
      current_setting('test.user_a')::uuid,
      'DOOMED-KEY',
      'DOOMED-SECRET',
      'PA-DOOMED-9999'
    );
  exception when others then blocked := true;
  end;

  if not blocked then
    raise exception 'FAIL: rotation succeeded against a missing Vault secret';
  end if;

  select * into acct from accounts
   where id = 'dddddddd-0000-0000-0000-0000000000d1';
  select decrypted_secret into keyval from vault.decrypted_secrets
   where id = acct.alpaca_key_secret_id;

  -- The key must still hold the value from the last *successful* rotation.
  if keyval <> 'NEW-KEY' then
    raise exception
      'FAIL: a failed rotation left the key overwritten (%), which is unrecoverable',
      keyval;
  end if;
  if acct.alpaca_account_number <> 'PA-NEW-2222' then
    raise exception 'FAIL: a failed rotation still rebound the broker number';
  end if;
end $$;

-- --- 3. ownership is enforced inside the function --------------------------
do $$
declare blocked boolean := false;
begin
  begin
    perform rotate_account_credentials(
      'dddddddd-0000-0000-0000-0000000000d1',
      current_setting('test.user_b')::uuid,
      'STOLEN-KEY',
      'STOLEN-SECRET',
      'PA-STOLEN-0000'
    );
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: another user could rotate this account''s credentials';
  end if;
end $$;

-- --- 4. a soft delete purges Vault, clears the binding and audits ----------
-- Repair the fixture the failure test broke, then delete for real.
do $$
declare fresh uuid;
begin
  select vault.create_secret('SECOND-SECRET', 'test-secret-2') into fresh;
  update accounts set alpaca_secret_secret_id = fresh
   where id = 'dddddddd-0000-0000-0000-0000000000d1';
end $$;

do $$
declare
  acct     accounts;
  key_id   uuid;
  sec_id   uuid;
begin
  select alpaca_key_secret_id, alpaca_secret_secret_id into key_id, sec_id
    from accounts where id = 'dddddddd-0000-0000-0000-0000000000d1';

  perform delete_account_atomic(
    'dddddddd-0000-0000-0000-0000000000d1',
    current_setting('test.user_a')::uuid,
    false
  );

  select * into acct from accounts
   where id = 'dddddddd-0000-0000-0000-0000000000d1';
  if acct.deleted_at is null then
    raise exception 'FAIL: the account was not soft-deleted';
  end if;
  if acct.alpaca_account_number is not null then
    raise exception
      'FAIL: a soft-deleted account still carries the broker account number';
  end if;
  if acct.alpaca_key_secret_id is not null
     or acct.alpaca_secret_secret_id is not null then
    raise exception 'FAIL: a soft-deleted account still references Vault secrets';
  end if;
  if exists (select 1 from vault.secrets where id in (key_id, sec_id)) then
    raise exception 'FAIL: the Vault secrets survived the deletion';
  end if;
  if not exists (
    select 1 from audit_log
     where account_id = 'dddddddd-0000-0000-0000-0000000000d1'
       and action = 'account.deleted'
  ) then
    raise exception 'FAIL: the deletion wrote no audit entry';
  end if;
end $$;

-- --- 5. deleting an already-deleted account fails, and changes nothing -----
do $$
declare blocked boolean := false;
begin
  begin
    perform delete_account_atomic(
      'dddddddd-0000-0000-0000-0000000000d1',
      current_setting('test.user_a')::uuid,
      false
    );
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: a soft-deleted account could be deleted again';
  end if;
end $$;

-- --- 6. a hard delete removes the row and its history ----------------------
do $$
declare purge_key uuid;
begin
  select vault.create_secret('PURGE-KEY', 'purge') into purge_key;
  insert into accounts (
    id, owner_id, nickname, mode, status, alpaca_key_secret_id
  ) values (
    'dddddddd-0000-0000-0000-0000000000d2',
    current_setting('test.user_a')::uuid,
    'Purge me', 'paper', 'connected', purge_key
  );
  insert into equity_snapshots (account_id, snapshot_date, equity, cash)
  values ('dddddddd-0000-0000-0000-0000000000d2', current_date, 1000, 1000);

  perform delete_account_atomic(
    'dddddddd-0000-0000-0000-0000000000d2',
    current_setting('test.user_a')::uuid,
    true
  );

  if exists (
    select 1 from accounts where id = 'dddddddd-0000-0000-0000-0000000000d2'
  ) then
    raise exception 'FAIL: the hard delete left the account row';
  end if;
  if exists (
    select 1 from equity_snapshots
     where account_id = 'dddddddd-0000-0000-0000-0000000000d2'
  ) then
    raise exception 'FAIL: the hard delete left the account history';
  end if;
  if exists (select 1 from vault.secrets where id = purge_key) then
    raise exception 'FAIL: the hard delete left the Vault secret';
  end if;
end $$;

-- --- 7. neither function is reachable by a client role ---------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
do $$
declare denied boolean;
begin
  denied := false;
  begin
    perform rotate_account_credentials(
      gen_random_uuid(), gen_random_uuid(), 'k', 's', 'PA-1'
    );
  exception when insufficient_privilege then denied := true;
    when others then denied := false;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can call rotate_account_credentials';
  end if;

  denied := false;
  begin
    perform delete_account_atomic(gen_random_uuid(), gen_random_uuid(), false);
  exception when insufficient_privilege then denied := true;
    when others then denied := false;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can call delete_account_atomic';
  end if;
end $$;
reset role;
-- `set_config(..., true)` is transaction-local and outlives `reset role`, so a
-- leftover client claim would make `is_service_role()` refuse the server's own
-- writes below. Impersonation is cleared explicitly.
select set_config('request.jwt.claims', '', true);

-- --- 8. creation is atomic with its audit entry ----------------------------
do $$
declare
  created accounts;
  key_id  uuid;
begin
  select vault.create_secret('CREATE-KEY', 'create-key') into key_id;
  select * into created from create_account_atomic(
    current_setting('test.user_a')::uuid,
    '  Created atomically  ', 'paper', '#123456',
    key_id, key_id, 'PA-CREATED-3333'
  );
  if created.nickname <> 'Created atomically' then
    raise exception 'FAIL: creation did not trim the nickname';
  end if;
  if created.status <> 'connected' or created.alpaca_account_number <> 'PA-CREATED-3333' then
    raise exception 'FAIL: creation did not bind the broker account number';
  end if;
  if not exists (
    select 1 from audit_log
     where account_id = created.id and action = 'account.created'
  ) then
    raise exception 'FAIL: creation wrote no audit entry';
  end if;
end $$;

-- A failing audit insert must take the account row with it.
do $$
declare
  before_count bigint;
  after_count  bigint;
  blocked      boolean := false;
begin
  select count(*) into before_count from accounts;
  -- Break the audit insert by pointing the actor at a user that cannot exist.
  begin
    perform create_account_atomic(
      '00000000-0000-0000-0000-0000000000ff'::uuid,
      'Doomed', 'paper', '#000000', null, null, 'PA-DOOMED-0000'
    );
  exception when others then blocked := true;
  end;
  select count(*) into after_count from accounts;
  if not blocked then
    raise exception 'FAIL: creation succeeded with an unusable actor';
  end if;
  if after_count <> before_count then
    raise exception
      'FAIL: a rolled-back creation left % account row(s) behind',
      after_count - before_count;
  end if;
end $$;

-- --- 9. metadata updates are atomic with their audit entry -----------------
do $$
declare
  target  uuid;
  updated accounts;
  blocked boolean := false;
begin
  select id into target from accounts
   where owner_id = current_setting('test.user_a')::uuid
     and nickname = 'Created atomically';

  select * into updated from update_account_metadata(
    target, current_setting('test.user_a')::uuid, 'Renamed', '#abcdef', false
  );
  if updated.nickname <> 'Renamed' or updated.color <> '#abcdef'
     or updated.is_active then
    raise exception 'FAIL: the metadata update did not apply';
  end if;
  if not exists (
    select 1 from audit_log
     where account_id = target and action = 'account.updated'
  ) then
    raise exception 'FAIL: the metadata update wrote no audit entry';
  end if;

  -- Another user must not be able to rename it.
  begin
    perform update_account_metadata(
      target, current_setting('test.user_b')::uuid, 'Stolen', null, null
    );
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: another user could rename this account';
  end if;

  -- An empty patch is refused rather than writing an empty audit entry.
  blocked := false;
  begin
    perform update_account_metadata(
      target, current_setting('test.user_a')::uuid, null, null, null
    );
  exception when others then blocked := true;
  end;
  if not blocked then
    raise exception 'FAIL: an empty metadata patch was accepted';
  end if;
end $$;

-- --- 10. neither new function is reachable by a client role ----------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
do $$
declare denied boolean;
begin
  denied := false;
  begin
    perform create_account_atomic(
      gen_random_uuid(), 'x', 'paper', '#000', null, null, 'PA-1'
    );
  exception when insufficient_privilege then denied := true;
    when others then denied := false;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can call create_account_atomic';
  end if;

  denied := false;
  begin
    perform update_account_metadata(gen_random_uuid(), gen_random_uuid(), 'x', null, null);
  exception when insufficient_privilege then denied := true;
    when others then denied := false;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can call update_account_metadata';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$ begin raise notice 'ACCOUNT LIFECYCLE OK'; end $$;

rollback;
