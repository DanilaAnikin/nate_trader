-- ============================================================================
-- 0022 — the fourth audit round's database findings.
--
-- **1. Idempotence answered the wrong question.** `resolve_create_operation`
-- matched the operation id and the owner and then reported `created`. The
-- fingerprint — the thing that says the retry is the *same request* — was
-- never compared, so a second call reusing a spent operation id with a
-- different nickname, mode or key pair got the first account back as a
-- success. It now takes the expected fingerprint and returns an explicit
-- `conflict`.
--
-- **2. A lost operation id could create a second account for one broker
-- binding.** Nothing in the schema said that an owner may hold one active
-- account per (mode, broker account number). Two operation ids, two accounts,
-- one Alpaca account — and every per-account mirror then describes the same
-- money twice. A partial unique index makes the binding the invariant, so the
-- client-generated id is an optimisation rather than the only defence.
--
-- **3. Verification tokens had no generation and no deadline.** `begin` issued
-- a token and left every earlier one outstanding; `finish` accepted any of
-- them, forever. Two overlapping verifications could therefore land in either
-- order, and the *older* answer could win. Tokens are now account-scoped and
-- monotonic: `begin` supersedes every outstanding token under the account
-- lock, and `finish` accepts only the current generation, only inside a short
-- TTL, and only `connected`/`auth_failed`. A `connected` must carry a
-- non-empty broker account number matching both the reservation and the
-- stored binding. `cancel_account_verification` exists so a network error, a
-- timeout or a 5xx closes the token instead of leaving it to expire.
--
-- **4. The purge reason was free text in an owner-readable row.** It is now a
-- closed enum, and a trigger permanently refuses any audit detail carrying a
-- forbidden key or a raw UUID — a standing guard rather than a one-off scan
-- that a future insert can walk past.
--
-- **5. The superseded mutating RPCs stayed callable.** `record_account_
-- verification` (whose expected version was nullable, which is what made it
-- unsafe), the pre-0021 `create_account_atomic`, and the direct Vault helpers
-- the current code no longer uses are turned into hard failures. Dropping
-- them would edit history; refusing them append-only leaves the audit trail
-- and closes the path.
--
-- 0001–0021 are not edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. One active account per owner, mode and broker binding.
--
-- Audited first: the index cannot be created over data that already violates
-- it, and a migration that fails on a duplicate with a bare index-build error
-- says nothing useful about which rows to reconcile.
-- ---------------------------------------------------------------------------
do $$
declare
  offenders text;
begin
  select string_agg(
           format('owner=%s mode=%s binding=%s count=%s',
                  owner_id, mode, right(alpaca_account_number, 4), n),
           '; ')
    into offenders
    from (
      select owner_id, mode, alpaca_account_number, count(*) as n
        from accounts
       where deleted_at is null
         and alpaca_account_number is not null
         and btrim(alpaca_account_number) <> ''
       group by owner_id, mode, alpaca_account_number
      having count(*) > 1
    ) duplicated;

  if offenders is not null then
    raise exception
      'refusing to add the broker-binding invariant: existing active rows already violate it (%). Reconcile them first; this migration will not choose which duplicate to keep.',
      offenders
      using errcode = 'P0001';
  end if;
end;
$$;

-- Partial: soft-deleted rows keep their binding for the audit trail, and a row
-- with no binding yet is not a duplicate of another row with no binding.
create unique index if not exists accounts_active_broker_binding_idx
  on accounts (owner_id, mode, alpaca_account_number)
  where deleted_at is null and alpaca_account_number is not null;

comment on index accounts_active_broker_binding_idx is
  'One active account per owner, mode and Alpaca account number. A lost client operation id must not be able to produce a second account for the same broker binding — every per-account mirror would then describe the same money twice.';

-- ---------------------------------------------------------------------------
-- 2. Idempotence that compares the request, not just the key.
-- ---------------------------------------------------------------------------
create or replace function resolve_create_operation(
  p_owner        uuid,
  p_operation_id uuid,
  p_fingerprint  text
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
  -- The fingerprint is mandatory. An optional one is an optional check, and
  -- the caller that most needs it — a retry after a lost response — is exactly
  -- the caller least able to prove it recomputed the same request.
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'a sha256 request fingerprint is required' using errcode = '22023';
  end if;

  -- The same lock the creation takes, so this cannot answer while the original
  -- transaction is still in flight: "no row yet" and "no row" are different
  -- answers and only one of them is safe to act on.
  perform lock_create_operation(p_operation_id);

  select * into op
    from account_create_operation
   where operation_id = p_operation_id;

  if not found then
    -- Proven with the lock held: nothing was created and nothing needs
    -- purging, because the secrets are written inside the same transaction.
    return jsonb_build_object('outcome', 'absent');
  end if;

  -- Owner *and* fingerprint, both exact. Either mismatch means this id is
  -- being reused for something other than the request it was issued for, and
  -- returning the original account as a success would report someone else's
  -- row — or this owner's earlier, different row — as the thing just created.
  if op.owner_id <> p_owner or op.fingerprint <> p_fingerprint then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  if op.account_id is null then
    return jsonb_build_object('outcome', 'no_account');
  end if;
  return jsonb_build_object('outcome', 'created', 'account_id', op.account_id);
end;
$$;

revoke all on routine resolve_create_operation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on routine resolve_create_operation(uuid, uuid, text) to service_role;

-- The two-argument form cannot be left callable beside it: it is the version
-- that answers without comparing the request.
create or replace function resolve_create_operation(
  p_owner        uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception
    'resolve_create_operation(uuid, uuid) is superseded: pass the expected request fingerprint'
    using errcode = 'P0001';
end;
$$;

revoke all on routine resolve_create_operation(uuid, uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Verification tokens: account-scoped, monotonic, and short-lived.
-- ---------------------------------------------------------------------------

/**
 * How long a token may authorize a write.
 *
 * It exists to carry one broker round trip. The application's fetch timeout
 * must be strictly shorter (see `VERIFY_BROKER_TIMEOUT_MS`), so a request that
 * is still in flight when the token dies is impossible: either the fetch has
 * already given up, or the token is still valid.
 */
create or replace function account_verification_ttl()
returns interval
language sql
immutable
set search_path = pg_catalog
as $$ select interval '60 seconds' $$;

alter table account_verification_token
  add column if not exists generation bigint,
  add column if not exists superseded_at timestamptz,
  add column if not exists cancelled_at timestamptz;

-- Existing rows predate generations. They are all outstanding tokens for a
-- protocol that no longer exists, so they are retired rather than numbered.
update account_verification_token
   set superseded_at = coalesce(superseded_at, now()),
       generation = coalesce(generation, 0)
 where generation is null;

alter table account_verification_token
  alter column generation set not null;

-- One *current* token per account, enforced by the schema rather than by the
-- function remembering to clean up. A token is current while it has been
-- neither consumed, superseded nor cancelled.
create unique index if not exists account_verification_token_current_idx
  on account_verification_token (account_id)
  where consumed_at is null and superseded_at is null and cancelled_at is null;

create unique index if not exists account_verification_token_generation_idx
  on account_verification_token (account_id, generation);

/**
 * Begin a verification.
 *
 * Lock order is uniform everywhere in this schema: **account, then token**.
 * `begin` takes the account row first and only then touches
 * `account_verification_token`; `finish` and `cancel` resolve the token to its
 * account and take the account row before locking the token. Two concurrent
 * connections therefore queue on the account and never hold one another's
 * second lock.
 */
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
  target     accounts;
  issued     uuid;
  next_gen   bigint;
  key_value  text;
  sec_value  text;
  expires    timestamptz;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;

  -- Lock 1: the account.
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
  -- Fail closed *before* the broker is asked. A version that cannot be read is
  -- not a version to verify against.
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

  -- Lock 2: the tokens, always after the account. Every outstanding token for
  -- this account is superseded here, so the "newest wins" rule is a fact about
  -- the table rather than a comparison `finish` has to remember to make.
  update account_verification_token
     set superseded_at = now()
   where account_id = p_account
     and consumed_at is null
     and superseded_at is null
     and cancelled_at is null;

  select coalesce(max(generation), 0) + 1 into next_gen
    from account_verification_token
   where account_id = p_account;

  expires := now() + account_verification_ttl();

  insert into account_verification_token (
    account_id, owner_id, mode, account_number, credential_version, generation
  )
  values (
    p_account, p_owner, target.mode, target.alpaca_account_number,
    target.credential_version, next_gen
  )
  returning token into issued;

  return jsonb_build_object(
    'token', issued,
    'generation', next_gen,
    'expires_at', expires,
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

/**
 * Finish a verification against the snapshot the token pinned.
 *
 * Only `connected` and `auth_failed` may be written. `unverified` is the
 * initial state and `paused` is an operator decision; neither is something a
 * broker round trip concludes, and allowing them here would let a verification
 * silently change what the account is rather than what is known about it.
 */
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
  current_gen bigint;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_token is null or p_status is null then
    raise exception 'a verification token and a status are required'
      using errcode = '22023';
  end if;
  if p_status not in ('connected', 'auth_failed') then
    raise exception
      'a broker round trip concludes connected or auth_failed, not %', p_status
      using errcode = '22023';
  end if;

  -- Read the reservation without locking it, purely to learn which account to
  -- lock first. The uniform order is account then token; taking the token
  -- first here is what would deadlock against `begin`.
  select * into reservation
    from account_verification_token
   where token = p_token;
  if not found then
    raise exception 'unknown verification token' using errcode = 'P0002';
  end if;

  -- Lock 1: the account.
  select * into target
    from accounts
   where id = reservation.account_id and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- Lock 2: the token, re-read under the account lock so nothing that
  -- `begin` did between the two reads is missed.
  select * into reservation
    from account_verification_token
   where token = p_token
     for update;

  if reservation.consumed_at is not null then
    raise exception 'verification token % has already been used', p_token
      using errcode = '23505';
  end if;
  if reservation.cancelled_at is not null then
    raise exception 'verification token % was cancelled', p_token
      using errcode = 'P0001';
  end if;
  if reservation.superseded_at is not null then
    raise exception
      'verification token % was superseded by a later verification', p_token
      using errcode = 'P0001';
  end if;

  -- Belt and braces beside `superseded_at`: the newest generation wins even if
  -- a future code path forgets to stamp the supersession.
  select max(generation) into current_gen
    from account_verification_token
   where account_id = reservation.account_id;
  if reservation.generation <> current_gen then
    raise exception
      'verification token % is generation %, but generation % is current',
      p_token, reservation.generation, current_gen
      using errcode = 'P0001';
  end if;

  -- A token issued in the future cannot have carried a completed round trip,
  -- and an expired one describes a snapshot that is no longer pinned.
  if reservation.issued_at > now() then
    raise exception 'verification token % is dated in the future', p_token
      using errcode = 'P0001';
  end if;
  if now() - reservation.issued_at > account_verification_ttl() then
    raise exception 'verification token % has expired', p_token
      using errcode = 'P0001';
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

  if p_status = 'connected' then
    -- A `connected` is the statement that this row is bound to that broker
    -- account. It may not be written without the number, and the number must
    -- agree with both the pinned snapshot and the stored binding — otherwise
    -- the certification is of a different account than the one being marked.
    if p_account_number is null or btrim(p_account_number) = '' then
      raise exception
        'connected requires the broker account number the round trip returned'
        using errcode = '22023';
    end if;
    if btrim(p_account_number) is distinct from reservation.account_number then
      raise exception
        'the broker reported a different account than the one this token pinned'
        using errcode = '23514';
    end if;
    if btrim(p_account_number) is distinct from target.alpaca_account_number then
      raise exception
        'the broker account number is fixed at creation and the broker reported a different one'
        using errcode = '23514';
    end if;
  elsif p_account_number is not null
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
      'generation', reservation.generation,
      'binding_confirmed', p_status = 'connected'
    )
  );

  return updated;
end;
$$;

revoke all on routine finish_account_verification(uuid, account_status, text)
  from public, anon, authenticated;
grant execute on routine finish_account_verification(uuid, account_status, text)
  to service_role;

/**
 * Close a token without concluding anything.
 *
 * A network error, a timeout, an Alpaca 5xx or a malformed response all leave
 * the round trip with no answer. Without this the token sat outstanding until
 * its TTL, blocking the next `begin`'s uniqueness index for no reason and
 * leaving the operator unable to distinguish "still running" from "gave up".
 * Cancelling states the second, and it is deliberately *not* a status write:
 * nothing is known about the credentials, so nothing is recorded about them.
 */
create or replace function cancel_account_verification(
  p_token  uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reservation account_verification_token;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_token is null then
    raise exception 'a verification token is required' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in (
    'network_error', 'timeout', 'broker_unavailable', 'malformed_response',
    'abandoned'
  ) then
    raise exception 'an accepted cancellation reason is required'
      using errcode = '22023';
  end if;

  select * into reservation
    from account_verification_token
   where token = p_token;
  if not found then
    raise exception 'unknown verification token' using errcode = 'P0002';
  end if;

  -- Same order as everywhere else: the account, then the token.
  perform 1 from accounts where id = reservation.account_id for update;

  select * into reservation
    from account_verification_token
   where token = p_token
     for update;

  -- A consumed token concluded something; cancelling it afterwards would
  -- claim that it did not.
  if reservation.consumed_at is not null then
    raise exception 'verification token % has already been used', p_token
      using errcode = '23505';
  end if;
  if reservation.cancelled_at is not null or reservation.superseded_at is not null then
    -- Already closed. Idempotent rather than an error: a client retrying its
    -- own cancellation is not a fault.
    return false;
  end if;

  update account_verification_token
     set cancelled_at = now()
   where token = p_token;

  insert into audit_log (actor_id, account_id, action, detail)
  values (
    reservation.owner_id, reservation.account_id, 'account.verification_cancelled',
    jsonb_build_object('reason', p_reason, 'generation', reservation.generation)
  );
  return true;
end;
$$;

revoke all on routine cancel_account_verification(uuid, text)
  from public, anon, authenticated;
grant execute on routine cancel_account_verification(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The purge reason is a closed enum, and the audit log is guarded.
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

  if p_key is null or p_secret is null or p_owner is null then
    raise exception 'both ids and an owner are required' using errcode = '22023';
  end if;
  -- Free text used to go straight into an owner-readable `audit_log` row, so
  -- whatever a caller happened to interpolate — a message, an id, an account
  -- number — was published there. A closed set says the same thing with none
  -- of that surface.
  if p_reason is null or p_reason not in (
    'orphaned_after_failed_create',
    'orphaned_after_failed_rotation',
    'operator_cleanup',
    'integrity_repair'
  ) then
    raise exception 'an accepted purge reason code is required'
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
      'removed', removed,
      'reason', p_reason,
      -- A digest, not the ids: this row is owner-readable.
      'pair_digest', substr(md5(p_key::text || ':' || p_secret::text), 1, 16)
    )
  );
  return removed;
end;
$$;

revoke all on routine purge_unassigned_credential_pair(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on routine purge_unassigned_credential_pair(uuid, uuid, uuid, text)
  to service_role;

/**
 * A standing guard on what an audit detail may contain.
 *
 * `audit_log` is readable by the account's owner. A one-off migration scan
 * proves the rows that exist today are clean and says nothing about the next
 * insert; this is a trigger, so a future function that interpolates a Vault id
 * or a broker account number into a detail fails at write time rather than
 * publishing it.
 *
 * Two rules, both structural:
 *   * a forbidden *key* — anything naming a secret, a token or an operation;
 *   * a raw UUID *value* anywhere in the document, at any depth.
 *
 * Digests are the sanctioned way to correlate, and they are not UUIDs.
 */
create or replace function audit_detail_is_publishable(p_detail jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  entry record;
begin
  if p_detail is null then
    return true;
  end if;

  for entry in
    select je.key as k, je.value as v from jsonb_each(p_detail) je
  loop
    if entry.k ~* '(secret|token|vault|operation_id|api_key|account_number|credential_id)' then
      return false;
    end if;
    if jsonb_typeof(entry.v) = 'object' then
      if not audit_detail_is_publishable(entry.v) then
        return false;
      end if;
    elsif jsonb_typeof(entry.v) = 'array' then
      -- Wrapped so the recursion sees an object; the wrapper key is inert.
      if not audit_detail_is_publishable(jsonb_build_object('items', entry.v)) then
        return false;
      end if;
    elsif jsonb_typeof(entry.v) = 'string' then
      if entry.v #>> '{}' ~*
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then
        return false;
      end if;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function audit_log_detail_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not audit_detail_is_publishable(new.detail) then
    raise exception
      'audit detail carries a forbidden key or a raw identifier; audit_log is owner-readable, so record a digest instead'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists audit_log_detail_guard_trg on audit_log;
create trigger audit_log_detail_guard_trg
  before insert or update on audit_log
  for each row execute function audit_log_detail_guard();

-- The guard is only meaningful if what is already stored satisfies it.
do $$
declare
  offenders bigint;
begin
  select count(*) into offenders
    from audit_log
   where not audit_detail_is_publishable(detail);
  if offenders > 0 then
    raise exception
      'refusing to arm the audit guard: % existing audit rows already carry a forbidden key or raw identifier',
      offenders
      using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Superseded mutating routines become hard failures.
--
-- Append-only: dropping them would edit the history these migrations are
-- supposed to preserve. Refusing them leaves the definition visible and closes
-- the path — and each refusal names why, so an operator who finds one in a log
-- learns what to call instead.
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature,
           -- `pg_get_function_arguments`, not the identity form: the identity
           -- form strips parameter defaults, and `create or replace` refuses
           -- to remove a default from an existing function.
           pg_get_function_arguments(p.oid) as args,
           p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         -- Nullable expected version: passing null disabled the check, which
         -- is the whole reason begin/finish exists.
         'record_account_verification',
         -- Pre-0021 creation: not idempotent, and its Vault secrets lived
         -- outside the transaction that used them.
         'create_account_atomic',
         -- Direct Vault mutation. The current code creates and destroys
         -- secrets only inside the RPCs that own their lifetime.
         'vault_create_secret', 'vault_update_secret', 'vault_delete_secret'
       )
  loop
    execute format(
      $fn$
      create or replace function %s(%s)
      returns %s
      language plpgsql
      set search_path = pg_catalog, public
      as $body$
      begin
        raise exception
          '%s is superseded and must not be called; see supabase/migrations/0022'
          using errcode = 'P0001';
      end;
      $body$;
      $fn$,
      fn.proname, fn.args,
      (select pg_get_function_result(p.oid)
         from pg_proc p where p.oid = fn.signature::oid),
      fn.proname
    );
    execute format(
      'revoke all on routine %s from public, anon, authenticated, service_role',
      fn.signature
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Catalogue assertions: the invariants above, read back from the catalogue.
-- ---------------------------------------------------------------------------
do $$
declare
  problems text[] := '{}';
  found    text;
begin
  -- The broker-binding index exists, is unique and is partial.
  select case when indisunique and indpred is not null then 'ok' else 'wrong' end
    into found
    from pg_index
   where indexrelid = 'accounts_active_broker_binding_idx'::regclass;
  if found is distinct from 'ok' then
    problems := problems || array['accounts_active_broker_binding_idx is not a partial unique index'];
  end if;

  -- One current token per account.
  if to_regclass('account_verification_token_current_idx') is null then
    problems := problems || array['the current-token uniqueness index is missing'];
  end if;

  -- The fingerprint-aware resolver exists and the old one does not answer.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'resolve_create_operation'
       and pg_get_function_identity_arguments(p.oid) like '%p_fingerprint text%'
  ) then
    problems := problems || array['resolve_create_operation does not take a fingerprint'];
  end if;

  -- The cancel RPC exists.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cancel_account_verification'
  ) then
    problems := problems || array['cancel_account_verification is missing'];
  end if;

  -- The audit guard is armed.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'audit_log'::regclass
       and tgname = 'audit_log_detail_guard_trg'
       and not tgisinternal
  ) then
    problems := problems || array['the audit_log detail guard trigger is not armed'];
  end if;

  -- No superseded routine is executable by anyone.
  select string_agg(p.oid::regprocedure::text, ', ') into found
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'record_account_verification', 'create_account_atomic',
       'vault_create_secret', 'vault_update_secret', 'vault_delete_secret'
     )
     and (has_function_privilege('service_role', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if found is not null then
    problems := problems || array['superseded routines are still executable: ' || found];
  end if;

  if array_length(problems, 1) > 0 then
    raise exception '0022 post-conditions failed: %', array_to_string(problems, '; ')
      using errcode = 'P0001';
  end if;
end;
$$;
