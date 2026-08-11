-- ============================================================================
-- 0021_atomic_create_and_verification.sql — one transaction creates an
-- account, verification is a two-phase snapshot, and nothing owner-readable
-- carries a secret identifier.
--
-- **1. Creation was atomic only after the Vault writes.** `0020` made the
-- account row idempotent, but the two `vault_create_secret` calls still
-- happened first, as separate round trips. A lost response to either one left
-- a secret nobody references and nothing that could later prove whether it
-- should exist; a lost response to the *account* call left the caller unable
-- to distinguish "committed" from "never ran" until it could ask — and asking
-- without holding the operation lock races the very transaction it is asking
-- about. `find_account_by_operation` returning nothing is not proof of absence
-- while another session is mid-commit.
--
-- `create_account_operation` does all of it in one transaction, under an
-- advisory lock on the operation id: both secrets, the account, both
-- assignments, the audit entry, and a record of the operation and the request
-- it was for. A retry blocks on the lock until the original finishes and then
-- returns its result. The same id with a different payload is refused, because
-- that is a different request wearing a used key.
--
-- **2. Verification wrote from a snapshot it never pinned.** `0020` bound the
-- write to an *expected* version the caller had read separately, and a caller
-- that could not read it passed `null`, which disabled the check. Verification
-- is now begin/finish: `begin_account_verification` returns the credentials,
-- the authoritative mode and a single-use token under a lock, the broker is
-- asked with exactly that snapshot, and `finish_account_verification` requires
-- the token and refuses if anything moved. There is no null path.
--
-- **3. The audit log carried Vault ids.** `account.created` recorded the
-- operation id, and `vault.pair_purged` recorded both secret ids — and
-- `audit_log` is readable by the account's owner. Neither is information an
-- owner needs, and both name internal identifiers. They are replaced by
-- non-reversible digests.
--
-- 0001–0020 are not edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The operation ledger.
--
-- Separate from `accounts` because it must record an operation that produced
-- *no* account, and because the fingerprint is about the request rather than
-- the row.
-- ---------------------------------------------------------------------------
create table if not exists account_create_operation (
  operation_id uuid primary key,
  owner_id     uuid not null,
  /**
   * SHA-256 of the canonical request. Two calls with one operation id must be
   * the same request; a different payload under a used key is a different
   * request, and returning the first result for it would be wrong.
   */
  fingerprint  text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  account_id   uuid references accounts(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists account_create_operation_owner_idx
  on account_create_operation(owner_id, created_at desc);

alter table account_create_operation enable row level security;
revoke all on account_create_operation from public, anon, authenticated;

/** Advisory lock keyed on the operation id, so a retry queues behind it. */
create or replace function lock_create_operation(p_operation_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if p_operation_id is null then
    raise exception 'an operation id is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('create_account:' || p_operation_id::text, 0)
  );
end;
$$;

revoke all on routine lock_create_operation(uuid) from public, anon, authenticated;
grant execute on routine lock_create_operation(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. One transaction: secrets, account, assignments, audit, ledger.
-- ---------------------------------------------------------------------------
create or replace function create_account_operation(
  p_owner          uuid,
  p_operation_id   uuid,
  p_fingerprint    text,
  p_nickname       text,
  p_mode           account_mode,
  p_color          text,
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
  existing_op account_create_operation;
  created     accounts;
  key_id      uuid;
  secret_id   uuid;
begin
  perform set_config('lock_timeout', '15s', true);

  if p_owner is null or p_operation_id is null then
    raise exception 'owner and operation id are required' using errcode = '22023';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'a sha256 request fingerprint is required' using errcode = '22023';
  end if;
  if p_mode is null then
    raise exception 'mode is required' using errcode = '22023';
  end if;
  if p_nickname is null or btrim(p_nickname) = '' then
    raise exception 'nickname is required' using errcode = '22023';
  end if;
  if p_account_number is null or btrim(p_account_number) = '' then
    raise exception 'a broker account number is required' using errcode = '22023';
  end if;
  if p_api_key is null or btrim(p_api_key) = ''
     or p_api_secret is null or btrim(p_api_secret) = '' then
    raise exception 'api key and secret are required' using errcode = '22023';
  end if;

  -- Everything below happens with the operation held. A retry that arrives
  -- while the original is still committing *blocks here* rather than reading
  -- past it — which is the difference between "no row yet" and "no row".
  perform lock_create_operation(p_operation_id);

  select * into existing_op
    from account_create_operation
   where operation_id = p_operation_id;

  if found then
    if existing_op.owner_id <> p_owner
       or existing_op.fingerprint <> p_fingerprint then
      raise exception
        'operation id % was already used for a different request', p_operation_id
        using errcode = '23505';
    end if;
    if existing_op.account_id is null then
      -- The operation is recorded as having produced no account. Returning
      -- nothing here is a definite answer, not an absence of one.
      raise exception 'operation % completed without creating an account',
        p_operation_id
        using errcode = 'P0002';
    end if;
    select * into created from accounts where id = existing_op.account_id;
    return created;
  end if;

  -- The secrets are created *inside* this transaction, so a failure anywhere
  -- below rolls them back with everything else. There is no window in which
  -- they exist without an account, and therefore no compensation to get wrong.
  key_id := vault.create_secret(p_api_key, 'alpaca_key_' || p_operation_id::text);
  secret_id := vault.create_secret(p_api_secret, 'alpaca_secret_' || p_operation_id::text);
  if key_id is null or secret_id is null or key_id = secret_id then
    raise exception 'the Vault secrets could not be created' using errcode = 'P0002';
  end if;

  perform lock_credential_pair(key_id, secret_id);

  insert into accounts (
    owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    last_verified_at, credential_version, create_operation_id
  )
  values (
    p_owner, btrim(p_nickname), p_mode, 'connected', coalesce(p_color, '#007aff'),
    key_id, secret_id, btrim(p_account_number),
    now(), 1, p_operation_id
  )
  returning * into created;

  insert into account_credential_assignment (secret_id, account_id, role)
  values (key_id, created.id, 'key'),
         (secret_id, created.id, 'secret');

  insert into account_create_operation (operation_id, owner_id, fingerprint, account_id)
  values (p_operation_id, p_owner, p_fingerprint, created.id);

  -- No operation id and no Vault ids: `audit_log` is readable by the owner,
  -- and neither is information an owner needs. A digest is enough to correlate
  -- with the server log, and cannot be turned back into an identifier.
  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, created.id, 'account.created',
    jsonb_build_object(
      'mode', p_mode,
      'nickname', created.nickname,
      -- `md5` is built in and needs no extension. It is a *correlation*
      -- token, not a security primitive: a v4 UUID carries 122 bits of
      -- entropy, so this cannot be walked back to the id, and its only job is
      -- to let an operator match this row to a server log line.
      'operation_digest', substr(md5(p_operation_id::text), 1, 16)
    )
  );

  return created;
end;
$$;

revoke all on routine create_account_operation(
  uuid, uuid, text, text, account_mode, text, text, text, text
) from public, anon, authenticated;
grant execute on routine create_account_operation(
  uuid, uuid, text, text, account_mode, text, text, text, text
) to service_role;

/**
 * Was this operation performed, and what came of it?
 *
 * Takes the same lock the creation does, so it cannot answer while the
 * original transaction is still in flight. `0020`'s version did not, which
 * made a `null` result ambiguous exactly when it mattered.
 */
create or replace function resolve_create_operation(
  p_owner        uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  op account_create_operation;
begin
  perform set_config('lock_timeout', '15s', true);
  if p_owner is null or p_operation_id is null then
    raise exception 'owner and operation id are required' using errcode = '22023';
  end if;

  perform lock_create_operation(p_operation_id);

  select * into op
    from account_create_operation
   where operation_id = p_operation_id and owner_id = p_owner;

  if not found then
    -- Proven: the lock is held, so no creation for this id is in flight, and
    -- none has committed. Nothing was created and nothing needs purging,
    -- because the secrets are created inside the same transaction.
    return jsonb_build_object('outcome', 'absent');
  end if;
  if op.account_id is null then
    return jsonb_build_object('outcome', 'no_account');
  end if;
  return jsonb_build_object('outcome', 'created', 'account_id', op.account_id);
end;
$$;

revoke all on routine resolve_create_operation(uuid, uuid)
  from public, anon, authenticated;
grant execute on routine resolve_create_operation(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3a. The pre-0021 creation keeps working, but stops naming the operation id.
--
-- `create_account_atomic` takes *already-created* Vault ids, which is the
-- shape `create_account_operation` exists to replace — the SQL suites still
-- use it to exercise the assignment constraint and the pair lock in isolation.
-- Its audit detail named the operation id, and `audit_log` is owner-readable.
-- ---------------------------------------------------------------------------
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

  select * into existing
    from accounts
   where create_operation_id = p_operation_id and owner_id = p_owner;
  if found then
    return existing;
  end if;

  perform lock_credential_pair(p_key_secret, p_secret_secret);

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
      'mode', p_mode,
      'nickname', created.nickname,
      'operation_digest', substr(md5(p_operation_id::text), 1, 16)
    )
  );

  return created;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Purging a pair is one statement, or nothing.
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

  -- One statement for both. Two `vault_delete_secret` round trips could
  -- succeed on the first and fail on the second, which is a half-purge: the
  -- pair is no longer a pair and neither half can be reasoned about.
  delete from vault.secrets where id in (p_key, p_secret);
  get diagnostics removed = row_count;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    p_owner, null, 'vault.pair_purged',
    jsonb_build_object(
      'removed', removed,
      'reason', btrim(p_reason),
      -- A digest, not the ids: this row is owner-readable.
      'pair_digest', substr(md5(p_key::text || ':' || p_secret::text), 1, 16)
    )
  );
  return removed;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Verification: begin under a lock, finish against the same snapshot.
-- ---------------------------------------------------------------------------
create table if not exists account_verification_token (
  token              uuid primary key default gen_random_uuid(),
  account_id         uuid not null references accounts(id) on delete cascade,
  owner_id           uuid not null,
  mode               account_mode not null,
  account_number     text,
  credential_version bigint not null,
  issued_at          timestamptz not null default now(),
  consumed_at        timestamptz
);

create index if not exists account_verification_token_account_idx
  on account_verification_token(account_id, issued_at desc);

alter table account_verification_token enable row level security;
revoke all on account_verification_token from public, anon, authenticated;

create or replace function begin_account_verification(
  p_account uuid,
  p_owner   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  target    accounts;
  issued    uuid;
  key_value text;
  sec_value text;
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
  if target.alpaca_key_secret_id is null or target.alpaca_secret_secret_id is null then
    raise exception 'account has no stored credentials' using errcode = 'P0002';
  end if;
  -- Fail closed *before* the broker is asked. A version that cannot be read
  -- is not a version to verify against.
  if target.credential_version is null then
    raise exception 'the account has no readable credential version'
      using errcode = 'P0002';
  end if;

  select decrypted_secret into key_value
    from vault.decrypted_secrets where id = target.alpaca_key_secret_id;
  select decrypted_secret into sec_value
    from vault.decrypted_secrets where id = target.alpaca_secret_secret_id;
  if key_value is null or sec_value is null then
    raise exception 'the stored credentials could not be decrypted'
      using errcode = 'P0002';
  end if;

  delete from account_verification_token
   where account_id = p_account and issued_at < now() - interval '1 hour';

  insert into account_verification_token (
    account_id, owner_id, mode, account_number, credential_version
  )
  values (
    p_account, p_owner, target.mode, target.alpaca_account_number,
    target.credential_version
  )
  returning token into issued;

  return jsonb_build_object(
    'token', issued,
    'mode', target.mode,
    'credential_version', target.credential_version,
    'account_number', target.alpaca_account_number,
    'api_key', key_value,
    'api_secret', sec_value
  );
end;
$$;

revoke all on routine begin_account_verification(uuid, uuid)
  from public, anon, authenticated;
grant execute on routine begin_account_verification(uuid, uuid) to service_role;

create or replace function finish_account_verification(
  p_token          uuid,
  p_status         account_status,
  p_account_number text default null
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reservation account_verification_token;
  target      accounts;
  updated     accounts;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_token is null or p_status is null then
    raise exception 'a verification token and a status are required'
      using errcode = '22023';
  end if;

  select * into reservation
    from account_verification_token
   where token = p_token
     for update;
  if not found then
    raise exception 'unknown verification token' using errcode = 'P0002';
  end if;
  if reservation.consumed_at is not null then
    raise exception 'verification token % has already been used', p_token
      using errcode = '23505';
  end if;

  select * into target
    from accounts
   where id = reservation.account_id and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- The broker was asked about *these* credentials. If they moved while it was
  -- answering, the answer describes keys that are no longer stored, and
  -- writing `connected` from it would certify the new ones on the strength of
  -- a test of the old.
  if target.credential_version <> reservation.credential_version then
    raise exception
      'credentials changed during verification (version % -> %)',
      reservation.credential_version, target.credential_version
      using errcode = 'P0001';
  end if;
  if target.mode <> reservation.mode then
    raise exception 'the account mode changed during verification'
      using errcode = 'P0001';
  end if;
  if p_account_number is not null
     and btrim(p_account_number) is distinct from target.alpaca_account_number then
    raise exception
      'the broker account number is fixed at creation and the broker reported a different one'
      using errcode = '23514';
  end if;

  update accounts
     set status           = p_status,
         last_verified_at = case when p_status = 'connected' then now()
                                 else last_verified_at end
   where id = target.id
   returning * into updated;

  update account_verification_token set consumed_at = now() where token = p_token;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    reservation.owner_id, target.id, 'account.verified',
    jsonb_build_object(
      'status', p_status,
      'credential_version', updated.credential_version,
      'binding_confirmed', p_account_number is not null
    )
  );

  return updated;
end;
$$;

revoke all on routine finish_account_verification(uuid, account_status, text)
  from public, anon, authenticated;
grant execute on routine finish_account_verification(uuid, account_status, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Grants, and a catalogue assertion.
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
         'create_account_operation', 'resolve_create_operation',
         'lock_create_operation', 'purge_unassigned_credential_pair',
         'begin_account_verification', 'finish_account_verification'
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
    if has_table_privilege(role_, 'account_create_operation', 'SELECT')
       or has_table_privilege(role_, 'account_verification_token', 'SELECT') then
      problems := problems || format('%s can read an operation or verification token', role_);
    end if;
  end loop;

  -- No owner-readable audit row may name a Vault id or an operation id.
  if exists (
    select 1 from audit_log
     where detail ? 'operation_id'
        or detail ? 'key_secret_id'
        or detail ? 'secret_secret_id'
  ) then
    problems := problems || 'an existing audit row names an internal identifier';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'atomic-create lockdown failed: %', array_to_string(problems, '; ');
  end if;
end $$;
