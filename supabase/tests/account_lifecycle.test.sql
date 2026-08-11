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
-- Rotation replaces the *key material* for the same broker account. It may no
-- longer change the account number: two broker accounts in one equity curve is
-- not a curve, and nothing in the mirrored rows marks the seam.
select rotate_account_credentials(
  'dddddddd-0000-0000-0000-0000000000d1',
  :'user_a',
  'NEW-KEY',
  'NEW-SECRET',
  'PA-OLD-1111'
);

do $$
declare blocked boolean := false;
begin
  begin
    perform rotate_account_credentials(
      'dddddddd-0000-0000-0000-0000000000d1', current_setting('test.user_a')::uuid,
      'K2', 'S2', 'PA-DIFFERENT-9999');
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a rotation changed the broker account number';
  end if;
end $$;

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
  if acct.alpaca_account_number <> 'PA-OLD-1111' then
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
  if acct.alpaca_account_number <> 'PA-OLD-1111' then
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
  sec_id  uuid;
begin
  -- Two *distinct*, really-existing Vault secrets, exactly as the server
  -- creates them. Reusing one id for both was a test shortcut that the
  -- function now refuses — sharing a secret means rotating the key would
  -- overwrite the secret with the same value.
  select vault.create_secret('CREATE-KEY', 'create-key') into key_id;
  select vault.create_secret('CREATE-SECRET', 'create-secret') into sec_id;
  select * into created from create_account_atomic(
    current_setting('test.user_a')::uuid,
    '  Created atomically  ', 'paper', '#123456',
    key_id, sec_id, 'PA-CREATED-3333'
  , gen_random_uuid());
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

-- --- 8a. a failing audit insert rolls the whole creation back --------------
--
-- The reason 0013/0014 moved these flows into functions was that the row and
-- its audit entry used to be two round trips, the second of which could fail
-- unnoticed. Asserting that the entry *exists* on the happy path does not test
-- that. This forces the audit insert to fail and asserts the account does not
-- survive it — an audit log that is sometimes missing entries is worse than
-- none, because its silence is read as evidence.
-- A dedicated account, created before the trigger is armed, for the update and
-- delete cases below.
do $$
declare
  key_id uuid;
  sec_id uuid;
  made   accounts;
begin
  select vault.create_secret('AUDITFAIL-EXISTING-KEY', 'k') into key_id;
  select vault.create_secret('AUDITFAIL-EXISTING-SECRET', 's') into sec_id;
  select * into made from create_account_atomic(
    current_setting('test.user_a')::uuid,
    'Audit rollback subject', 'paper', '#123456',
    key_id, sec_id, 'PA-AUDITFAIL-SUBJECT'
  , gen_random_uuid());
  perform set_config('test.audit_subject', made.id::text, true);
end $$;

create function fail_audit_insert() returns trigger
  language plpgsql as $fn$
begin
  raise exception 'forced audit failure' using errcode = 'P0001';
end $fn$;
create trigger fail_audit_insert_trg
  before insert on audit_log
  for each row execute function fail_audit_insert();

do $$
declare
  key_id  uuid;
  sec_id  uuid;
  before_count bigint;
  failed  boolean := false;
begin
  select vault.create_secret('AUDITFAIL-KEY', 'auditfail-key') into key_id;
  select vault.create_secret('AUDITFAIL-SECRET', 'auditfail-secret') into sec_id;
  select count(*) into before_count from accounts;

  begin
    perform create_account_atomic(
      current_setting('test.user_a')::uuid,
      'Audit failure', 'paper', '#123456',
      key_id, sec_id, 'PA-AUDITFAIL-9999'
    , gen_random_uuid());
  exception when others then failed := true;
  end;

  if not failed then
    raise exception 'FAIL: creation succeeded despite a failing audit insert';
  end if;
  if exists (
    select 1 from accounts where alpaca_account_number = 'PA-AUDITFAIL-9999'
  ) then
    raise exception 'FAIL: an unaudited account survived the rollback';
  end if;
  if (select count(*) from accounts) <> before_count then
    raise exception 'FAIL: the account count changed';
  end if;
end $$;

-- The same must hold for the other two audited flows.
do $$
declare
  target uuid := current_setting('test.audit_subject')::uuid;
  owner_ uuid := current_setting('test.user_a')::uuid;
  before_nickname text;
  failed boolean;
begin
  select nickname into before_nickname from accounts where id = target;

  failed := false;
  begin
    perform update_account_metadata(target, owner_, 'Renamed by a doomed call', null, null);
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: metadata update succeeded despite a failing audit insert';
  end if;
  if (select nickname from accounts where id = target) <> before_nickname then
    raise exception 'FAIL: an unaudited rename survived the rollback';
  end if;

  failed := false;
  begin
    perform delete_account_atomic(target, owner_, false);
  exception when others then failed := true;
  end;
  if not failed then
    raise exception 'FAIL: deletion succeeded despite a failing audit insert';
  end if;
  if (select deleted_at from accounts where id = target) is not null then
    raise exception 'FAIL: an unaudited soft delete survived the rollback';
  end if;
end $$;

drop trigger fail_audit_insert_trg on audit_log;
drop function fail_audit_insert();

-- --- 8b. every creation precondition, one at a time -----------------------
do $$
declare
  key_id  uuid;
  sec_id  uuid;
  ghost   uuid := '00000000-0000-0000-0000-0000000000ee';
  blocked boolean;
  before_count bigint;
  after_count  bigint;
begin
  select vault.create_secret('GUARD-KEY', 'guard-key') into key_id;
  select vault.create_secret('GUARD-SECRET', 'guard-secret') into sec_id;
  select count(*) into before_count from accounts;

  -- null owner
  blocked := false;
  begin
    perform create_account_atomic(null, 'x', 'paper', '#000', key_id, sec_id, 'PA-1', gen_random_uuid());
  exception when others then blocked := true; end;
  if not blocked then raise exception 'FAIL: a null owner was accepted'; end if;

  -- empty / null broker account number
  foreach ghost in array array[null::uuid] loop null; end loop;
  blocked := false;
  begin
    perform create_account_atomic(
      current_setting('test.user_a')::uuid, 'x', 'paper', '#000', key_id, sec_id, '   '
    , gen_random_uuid());
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a blank broker account number was accepted';
  end if;
  blocked := false;
  begin
    perform create_account_atomic(
      current_setting('test.user_a')::uuid, 'x', 'paper', '#000', key_id, sec_id, null
    , gen_random_uuid());
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a null broker account number was accepted';
  end if;

  -- null vault ids
  blocked := false;
  begin
    perform create_account_atomic(
      current_setting('test.user_a')::uuid, 'x', 'paper', '#000', null, sec_id, 'PA-1'
    , gen_random_uuid());
  exception when others then blocked := true; end;
  if not blocked then raise exception 'FAIL: a null key secret id was accepted'; end if;

  -- identical vault ids
  blocked := false;
  begin
    perform create_account_atomic(
      current_setting('test.user_a')::uuid, 'x', 'paper', '#000', key_id, key_id, 'PA-1'
    , gen_random_uuid());
  exception when others then blocked := true; end;
  if not blocked then raise exception 'FAIL: one secret used for both was accepted'; end if;

  -- a vault id that does not exist
  blocked := false;
  begin
    perform create_account_atomic(
      current_setting('test.user_a')::uuid, 'x', 'paper', '#000',
      key_id, '00000000-dead-0000-0000-000000000000'::uuid, 'PA-1'
    , gen_random_uuid());
  exception when others then blocked := true; end;
  if not blocked then raise exception 'FAIL: a dangling Vault id was accepted'; end if;

  -- a secret already in use by an active account
  blocked := false;
  begin
    perform create_account_atomic(
      current_setting('test.user_a')::uuid, 'shares', 'paper', '#000',
      (select alpaca_key_secret_id from accounts
        where nickname = 'Created atomically' and deleted_at is null),
      sec_id, 'PA-2'
    , gen_random_uuid());
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: two active accounts could share a Vault secret';
  end if;

  select count(*) into after_count from accounts;
  if after_count <> before_count then
    raise exception 'FAIL: a refused creation still wrote % row(s)',
      after_count - before_count;
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
  -- Everything else about the call is valid, so the *only* thing that can fail
  -- is the audit entry — which must take the account row with it.
  declare
    key_id uuid;
    sec_id uuid;
  begin
    select vault.create_secret('DOOMED-KEY', 'doomed-key') into key_id;
    select vault.create_secret('DOOMED-SECRET', 'doomed-secret') into sec_id;
    begin
      perform create_account_atomic(
        '00000000-0000-0000-0000-0000000000ff'::uuid,
        'Doomed', 'paper', '#000000', key_id, sec_id, 'PA-DOOMED-0000'
      , gen_random_uuid());
    exception when others then blocked := true;
    end;
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
    , gen_random_uuid());
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

-- --- 11. idempotent creation, and answering "did it commit?" ---------------
do $$
declare
  op    uuid := gen_random_uuid();
  k     uuid;
  sec   uuid;
  first accounts;
  again accounts;
  before_count bigint;
begin
  select vault.create_secret('IDEM-KEY', 'ik') into k;
  select vault.create_secret('IDEM-SECRET', 'is') into sec;
  select count(*) into before_count from accounts;

  first := create_account_atomic(current_setting('test.user_a')::uuid,
    'Idempotent', 'paper', '#123456', k, sec, 'PA-IDEM-1', op);

  -- The retry a caller makes after losing its HTTP response. It must return
  -- the committed row, not create a second account and not fail.
  again := create_account_atomic(current_setting('test.user_a')::uuid,
    'Idempotent', 'paper', '#123456', k, sec, 'PA-IDEM-1', op);

  if first.id <> again.id then
    raise exception 'FAIL: a repeated operation id created a second account';
  end if;
  if (select count(*) from accounts) <> before_count + 1 then
    raise exception 'FAIL: the retry changed the account count';
  end if;

  -- And the caller can ask directly, which is what makes the lost-response
  -- path decidable rather than a guess.
  if (find_account_by_operation(current_setting('test.user_a')::uuid, op)).id
     <> first.id then
    raise exception 'FAIL: the committed operation could not be found';
  end if;
  if (find_account_by_operation(current_setting('test.user_a')::uuid,
        gen_random_uuid())).id is not null then
    raise exception 'FAIL: an operation that never ran was reported as found';
  end if;

  -- An operation id is required: without one a retry is indistinguishable
  -- from a second request.
  declare blocked boolean := false;
  begin
    begin
      perform create_account_atomic(current_setting('test.user_a')::uuid,
        'NoOp', 'paper', '#123456', k, sec, 'PA-NOOP', null);
    exception when others then blocked := true; end;
    if not blocked then
      raise exception 'FAIL: creation without an operation id was accepted';
    end if;
  end;
end $$;

-- --- 12. a Vault secret assigned to an account cannot be deleted ------------
do $$
declare
  acct     accounts;
  k        uuid;
  sec      uuid;
  blocked  int := 0;
  msg      text;
begin
  select vault.create_secret('FKGUARD-KEY', 'k') into k;
  select vault.create_secret('FKGUARD-SECRET', 's') into sec;
  acct := create_account_atomic(current_setting('test.user_a')::uuid,
    'FkGuard', 'paper', '#123456', k, sec, 'PA-FKGUARD', gen_random_uuid());

  -- Through the wrapper the application uses.
  begin
    perform vault_delete_secret(k);
  exception when others then blocked := blocked + 1; msg := sqlerrm; end;
  if blocked <> 1 then
    raise exception 'FAIL: vault_delete_secret removed an assigned secret';
  end if;
  if msg not like '%assigned to account%' then
    raise exception 'FAIL: unexpected refusal: %', msg;
  end if;

  -- And directly, which is what the foreign key is for.
  begin
    delete from vault.secrets where id = k;
    blocked := blocked + 1;
  exception when foreign_key_violation then null; end;
  if blocked <> 1 then
    raise exception 'FAIL: a direct delete removed an assigned Vault secret';
  end if;
  if not exists (select 1 from vault.secrets where id = k) then
    raise exception 'FAIL: the assigned secret is gone';
  end if;

  -- Purging a pair that *is* assigned is refused too.
  blocked := 0;
  begin
    perform purge_unassigned_credential_pair(k, sec,
      current_setting('test.user_a')::uuid, 'test');
  exception when others then blocked := 1; end;
  if blocked <> 1 then
    raise exception 'FAIL: an assigned pair was purged';
  end if;

  -- Once the account is gone the pair is unassigned, and the deliberate purge
  -- is the way to remove it. (Deletion already removes the secrets, so this
  -- exercises the orphan case: a pair created for an account that never was.)
  declare
    ok  uuid;
    ok2 uuid;
    n   integer;
  begin
    select vault.create_secret('ORPHAN-KEY', 'k') into ok;
    select vault.create_secret('ORPHAN-SECRET', 's') into ok2;
    n := purge_unassigned_credential_pair(ok, ok2,
      current_setting('test.user_a')::uuid, 'creation lost its response');
    if n <> 2 then
      raise exception 'FAIL: the orphan purge removed % secrets, expected 2', n;
    end if;
    if not exists (
      select 1 from audit_log where action = 'vault.pair_purged'
    ) then
      raise exception 'FAIL: the purge was not audited';
    end if;
  end;
  perform acct;
end $$;

-- --- 13. the broker account number never moves ------------------------------
do $$
declare
  acct    accounts;
  k       uuid;
  sec     uuid;
  blocked boolean := false;
begin
  select vault.create_secret('BIND-KEY', 'k') into k;
  select vault.create_secret('BIND-SECRET', 's') into sec;
  -- No history at all: 0019 would have allowed this rebind.
  acct := create_account_atomic(current_setting('test.user_a')::uuid,
    'Binding', 'paper', '#123456', k, sec, 'PA-BIND-1', gen_random_uuid());

  begin
    perform record_account_verification(acct.id,
      current_setting('test.user_a')::uuid, 'connected', 'PA-BIND-2');
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a fresh account was rebound to another broker number';
  end if;
  if (select alpaca_account_number from accounts where id = acct.id)
     <> 'PA-BIND-1' then
    raise exception 'FAIL: the refused rebind still changed the binding';
  end if;

  -- Confirming the *same* number is what verification is for.
  perform record_account_verification(acct.id,
    current_setting('test.user_a')::uuid, 'connected', 'PA-BIND-1');

  -- A verification carrying a stale credential version is refused: the answer
  -- in hand describes keys that were rotated away while Alpaca was asked.
  blocked := false;
  perform rotate_account_credentials(acct.id,
    current_setting('test.user_a')::uuid, 'K2', 'S2', 'PA-BIND-1');
  begin
    perform record_account_verification(acct.id,
      current_setting('test.user_a')::uuid, 'connected', 'PA-BIND-1', 1::bigint);
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a verification of rotated-away keys was recorded';
  end if;
  -- The current version is accepted.
  perform record_account_verification(acct.id,
    current_setting('test.user_a')::uuid, 'connected', 'PA-BIND-1',
    (select credential_version from accounts where id = acct.id));
end $$;

-- --- 14. credentials are never served for a deleted account -----------------
do $$
declare
  acct    accounts;
  k       uuid;
  sec     uuid;
  blocked boolean := false;
begin
  select vault.create_secret('DEL-KEY', 'k') into k;
  select vault.create_secret('DEL-SECRET', 's') into sec;
  acct := create_account_atomic(current_setting('test.user_a')::uuid,
    'ToRead', 'paper', '#123456', k, sec, 'PA-TOREAD', gen_random_uuid());
  perform get_account_credentials(acct.id);

  update accounts set deleted_at = now() where id = acct.id;
  begin
    perform get_account_credentials(acct.id);
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a soft-deleted account still served credentials';
  end if;
  update accounts set deleted_at = null where id = acct.id;
end $$;

do $$ begin raise notice 'ACCOUNT LIFECYCLE OK'; end $$;

rollback;
