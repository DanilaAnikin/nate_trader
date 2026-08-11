-- ============================================================================
-- 0020_vault_fk_and_idempotent_create.sql — the Vault foreign key is mandatory,
-- account creation is idempotent, and a broker account number never moves.
--
-- **1. The Vault foreign key was optional.** 0019 wrapped it in an exception
-- handler that downgraded a refusal to a `NOTICE`, so on any platform where
-- `vault.secrets` does not accept a foreign key the migration reported success
-- and left the integrity check it had just described *absent*. A constraint
-- that may or may not exist is not a constraint; the catalogue is asserted
-- here instead, and a missing or unvalidated one aborts.
--
-- **2. `vault_delete_secret` would delete an assigned secret.** Even with the
-- foreign key, the wrapper is the path the application uses, and it should not
-- rely on a constraint to catch a call it should never make. It refuses now,
-- and `purge_unassigned_credential_pair` is the deliberate way to remove a
-- pair that belongs to nobody — under the same advisory locks as creation and
-- deletion, so it cannot race a creation claiming the pair.
--
-- **3. A lost HTTP response could orphan a Vault pair or duplicate an
-- account.** `create_account_atomic` committed, the response never arrived,
-- and the caller had no way to ask whether it had. Retrying created a second
-- account; purging the secrets destroyed the credentials of an account that
-- exists. A client-generated operation id, unique in the database, makes the
-- retry return the committed row, and makes "did it commit?" answerable.
--
-- **4. A broker account number could still move.** 0019 refused a rebind once
-- history existed — but an account with no history yet could be repointed, and
-- the production binding compares against that number. It is now immutable
-- from creation: verification may confirm an exact match and nothing else.
--
-- **5. Two legacy states were never checked.** An active account with a NULL
-- broker number can never be bound and cannot be verified; a soft-deleted
-- account still holding Vault references leaves live secrets nobody can reach
-- through the application. Both abort this migration and ask for a human.
--
-- **6. `get_account_credentials` served deleted accounts.** It filtered on
-- `id` alone, so a soft-deleted row that still had ids — exactly the state (5)
-- describes — handed out working credentials.
--
-- 0001–0019 are not edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Legacy states that must not be repaired automatically.
-- ---------------------------------------------------------------------------
do $$
declare
  problems text[] := '{}';
  offending text;
begin
  select string_agg(format('%s (%s)', id, nickname), ', ')
    into offending
    from accounts
   where deleted_at is null
     and (alpaca_account_number is null or btrim(alpaca_account_number) = '');
  if offending is not null then
    problems := problems || format(
      'active account(s) with no broker account number: %s — they can never be '
      'bound to the production release and cannot be verified', offending);
  end if;

  select string_agg(format('%s (%s)', id, nickname), ', ')
    into offending
    from accounts
   where deleted_at is not null
     and (alpaca_key_secret_id is not null or alpaca_secret_secret_id is not null);
  if offending is not null then
    problems := problems || format(
      'soft-deleted account(s) still holding Vault references: %s — the secrets '
      'are live and unreachable through the application', offending);
  end if;

  if array_length(problems, 1) is not null then
    raise exception
      'this migration will not repair an ambiguous legacy state automatically: %. '
      'Each needs a decision a migration cannot make (bind or delete the account; '
      'purge or reassign the secrets), taken by hand and written to audit_log.',
      array_to_string(problems, '; ');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The Vault foreign key, mandatory.
-- ---------------------------------------------------------------------------
alter table account_credential_assignment
  drop constraint if exists account_credential_assignment_secret_fk;

alter table account_credential_assignment
  add constraint account_credential_assignment_secret_fk
  foreign key (secret_id) references vault.secrets(id) on delete restrict;

do $$
declare
  c record;
begin
  select convalidated, confdeltype into c
    from pg_constraint
   where conname = 'account_credential_assignment_secret_fk'
     and conrelid = 'account_credential_assignment'::regclass;
  if not found then
    raise exception
      'the Vault foreign key was not created. It is not optional: without it '
      'a secret can be deleted out from under a live account.';
  end if;
  if not c.convalidated then
    raise exception 'the Vault foreign key exists but is NOT VALID';
  end if;
  -- `r` is RESTRICT. Anything else — cascade, set null, no action — would let
  -- the delete through and silently break the account.
  if c.confdeltype <> 'r' then
    raise exception
      'the Vault foreign key has delete action %, expected RESTRICT', c.confdeltype;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The Vault wrapper refuses an assigned secret on its own.
-- ---------------------------------------------------------------------------
create or replace function vault_delete_secret(p_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  holder uuid;
begin
  if p_id is null then
    raise exception 'a secret id is required' using errcode = '22023';
  end if;
  select account_id into holder
    from account_credential_assignment
   where secret_id = p_id;
  if found then
    raise exception
      'secret % is assigned to account % and cannot be deleted directly; '
      'delete the account, or use purge_unassigned_credential_pair',
      p_id, holder
      using errcode = '23503';
  end if;
  delete from vault.secrets where id = p_id;
end;
$$;

revoke all on routine vault_delete_secret(uuid) from public, anon, authenticated;
grant execute on routine vault_delete_secret(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The deliberate way to remove a pair nobody owns.
--
-- Under the same advisory locks as creation and deletion, so it cannot race a
-- creation that is about to claim the pair.
-- ---------------------------------------------------------------------------
create or replace function purge_unassigned_credential_pair(
  p_key    uuid,
  p_secret uuid,
  p_owner  uuid,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  assigned uuid;
  removed  integer := 0;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_key is null or p_secret is null or p_owner is null
     or p_reason is null or btrim(p_reason) = '' then
    raise exception 'both ids, an owner and a stated reason are required'
      using errcode = '22023';
  end if;

  perform lock_credential_pair(p_key, p_secret);

  select account_id into assigned
    from account_credential_assignment
   where secret_id in (p_key, p_secret)
   limit 1;
  if found then
    raise exception
      'refusing to purge: one of these secrets is assigned to account %', assigned
      using errcode = '23503';
  end if;

  delete from vault.secrets where id in (p_key, p_secret);
  get diagnostics removed = row_count;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, null, 'vault.pair_purged',
    jsonb_build_object(
      'key_secret_id', p_key,
      'secret_secret_id', p_secret,
      'removed', removed,
      'reason', btrim(p_reason)
    )
  );
  return removed;
end;
$$;

revoke all on routine purge_unassigned_credential_pair(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on routine purge_unassigned_credential_pair(uuid, uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Idempotent creation.
--
-- The client generates the id before it calls, so a retry after a lost
-- response carries the same one and the database can recognise it. Unique, so
-- two concurrent retries cannot both create.
-- ---------------------------------------------------------------------------
alter table accounts
  add column if not exists create_operation_id uuid;

create unique index if not exists accounts_create_operation_id_key
  on accounts(create_operation_id)
  where create_operation_id is not null;

/**
 * Did this operation commit?
 *
 * The account row and its operation id are written in one transaction, so a
 * successful query returning no row is *proof of absence*, not an absence of
 * proof. That distinction is the whole point: it lets a caller that lost its
 * HTTP response decide between "already done", "never happened" and "cannot
 * tell" instead of guessing.
 */
create or replace function find_account_by_operation(
  p_owner        uuid,
  p_operation_id uuid
)
returns accounts
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  found_row accounts;
begin
  if p_owner is null or p_operation_id is null then
    raise exception 'owner and operation id are required' using errcode = '22023';
  end if;
  select * into found_row
    from accounts
   where create_operation_id = p_operation_id and owner_id = p_owner;
  return found_row;
end;
$$;

revoke all on routine find_account_by_operation(uuid, uuid)
  from public, anon, authenticated;
grant execute on routine find_account_by_operation(uuid, uuid) to service_role;

drop function if exists create_account_atomic(
  uuid, text, account_mode, text, uuid, uuid, text
);

create or replace function create_account_atomic(
  p_owner          uuid,
  p_nickname       text,
  p_mode           account_mode,
  p_color          text,
  p_key_secret     uuid,
  p_secret_secret  uuid,
  p_account_number text,
  p_operation_id   uuid
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  created  accounts;
  existing accounts;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_owner is null or p_mode is null then
    raise exception 'owner and mode are required' using errcode = '22023';
  end if;
  if p_operation_id is null then
    raise exception 'an operation id is required so a retry can be recognised'
      using errcode = '22023';
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

  -- The retry path. Returning the committed row is the correct answer to "do
  -- this", not a special case: the operation was already performed.
  select * into existing
    from accounts
   where create_operation_id = p_operation_id and owner_id = p_owner;
  if found then
    return existing;
  end if;

  perform lock_credential_pair(p_key_secret, p_secret_secret);

  -- Checked again under the lock: a concurrent retry may have committed
  -- between the read above and the lock.
  select * into existing
    from accounts
   where create_operation_id = p_operation_id and owner_id = p_owner;
  if found then
    return existing;
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
    last_verified_at, credential_version, create_operation_id
  )
  values (
    p_owner, btrim(p_nickname), p_mode, 'connected', coalesce(p_color, '#007aff'),
    p_key_secret, p_secret_secret, btrim(p_account_number),
    now(), 1, p_operation_id
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
    jsonb_build_object(
      'mode', p_mode, 'nickname', created.nickname,
      'operation_id', p_operation_id
    )
  );

  return created;
end;
$$;

revoke all on routine create_account_atomic(
  uuid, text, account_mode, text, uuid, uuid, text, uuid
) from public, anon, authenticated;
grant execute on routine create_account_atomic(
  uuid, text, account_mode, text, uuid, uuid, text, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- 6. The broker account number is immutable from creation.
--
-- 0019 refused a *rebind once history existed*, which left an account with no
-- history yet repointable — and the production binding compares against this
-- number, so repointing it silently changes which broker account the executor
-- believes it is trading. Verification may now only confirm an exact match.
-- ---------------------------------------------------------------------------
create or replace function record_account_verification(
  p_account          uuid,
  p_owner            uuid,
  p_status           account_status,
  p_account_number   text default null,
  p_expected_version bigint default null
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target  accounts;
  updated accounts;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null or p_status is null then
    raise exception 'account, owner and status are required' using errcode = '22023';
  end if;

  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- The verification was performed *against* a particular set of credentials.
  -- If they were rotated while Alpaca was being asked, the answer in hand
  -- describes keys that no longer exist, and writing `connected` from it would
  -- mark the *new* keys verified on the strength of a test of the old ones.
  if p_expected_version is not null
     and target.credential_version <> p_expected_version then
    raise exception
      'credentials changed during verification (version % -> %); the result '
      'describes keys that are no longer stored',
      p_expected_version, target.credential_version
      using errcode = 'P0001';
  end if;

  if p_account_number is not null
     and btrim(p_account_number) is distinct from target.alpaca_account_number then
    raise exception
      'the broker account number is fixed at creation: this account is bound to '
      '%, and the broker reported %. A different broker account is a different '
      'account; create one.',
      target.alpaca_account_number, btrim(p_account_number)
      using errcode = '23514';
  end if;

  update accounts
     set status           = p_status,
         last_verified_at = case when p_status = 'connected' then now()
                                 else last_verified_at end
   where id = p_account
   returning * into updated;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, p_account, 'account.verified',
    jsonb_build_object(
      'status', p_status,
      'credential_version', updated.credential_version,
      'binding_confirmed', p_account_number is not null
    )
  );

  return updated;
end;
$$;

drop function if exists record_account_verification(
  uuid, uuid, account_status, text
);

revoke all on routine record_account_verification(
  uuid, uuid, account_status, text, bigint
) from public, anon, authenticated;
grant execute on routine record_account_verification(
  uuid, uuid, account_status, text, bigint
) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Credentials are never served for a deleted account.
-- ---------------------------------------------------------------------------
create or replace function get_account_credentials(acct uuid)
returns table (api_key text, api_secret text)
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  k uuid;
  s uuid;
begin
  -- `deleted_at is null` is the change. Without it a soft-deleted row that
  -- still held ids handed out working credentials for an account the
  -- application considers gone.
  select alpaca_key_secret_id, alpaca_secret_secret_id
    into k, s
    from accounts
   where id = acct and deleted_at is null;

  if not found then
    raise exception 'account % is not an active account', acct
      using errcode = 'P0002';
  end if;
  if k is null or s is null then
    raise exception 'account % has no stored credentials', acct
      using errcode = 'P0002';
  end if;

  return query
    select (select decrypted_secret from vault.decrypted_secrets where id = k),
           (select decrypted_secret from vault.decrypted_secrets where id = s);
end;
$$;

revoke all on routine get_account_credentials(uuid) from public, anon, authenticated;
grant execute on routine get_account_credentials(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Deletion goes through the wrapper's rules, in order.
--
-- The assignment rows are removed first so the foreign key permits the secret
-- deletes that follow; the advisory lock is already held, so no creation can
-- claim the pair in between.
-- ---------------------------------------------------------------------------
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

  select * into target
    from accounts
   where id = p_account and owner_id = p_owner and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if target.alpaca_key_secret_id is not null
     and target.alpaca_secret_secret_id is not null then
    perform lock_credential_pair(
      target.alpaca_key_secret_id, target.alpaca_secret_secret_id
    );
  end if;

  delete from account_credential_assignment where account_id = p_account;

  -- Now unassigned, so the foreign key and the wrapper both permit this.
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
         'create_account_atomic', 'delete_account_atomic',
         'record_account_verification', 'get_account_credentials',
         'vault_delete_secret', 'purge_unassigned_credential_pair',
         'find_account_by_operation'
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

  -- The old four-argument creation must be gone, or a caller could reach it
  -- and skip the operation id entirely.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'create_account_atomic'
       -- Identity arguments carry parameter *names*, so the test is for the
       -- named operation id rather than for a trailing type.
       and pg_get_function_identity_arguments(p.oid) not like '%p_operation_id uuid%' 
  ) then
    problems := problems
      || array['a create_account_atomic without an operation id still exists'];
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'accounts_create_operation_id_key'
  ) then
    problems := problems || array['the create operation id is not unique'];
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'vault/idempotency lockdown failed: %',
      array_to_string(problems, '; ');
  end if;
end $$;
