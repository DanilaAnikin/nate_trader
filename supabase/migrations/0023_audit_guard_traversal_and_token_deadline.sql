-- ============================================================================
-- 0023 — two defects in 0022, both reproduced before being fixed.
--
-- **1. The audit guard recursed forever on any array, and missed three
-- things it was written to catch.**
--
-- `audit_detail_is_publishable` handled an array by re-wrapping it —
-- `jsonb_build_object('items', entry.v)` — and calling itself. The wrapper's
-- single value is that same array, so the next call wraps it again. Every
-- audit detail containing an array therefore died with `54001 stack depth
-- limit exceeded` at write time, which for a guard on `audit_log` means the
-- operation being audited is rolled back. A benign `{"symbols": ["AAPL"]}`
-- was a hard failure.
--
-- It also passed three things it was supposed to refuse:
--
--   * a UUID used as a *key* (`{"<uuid>": "x"}`) — only values were scanned;
--   * a broker account number under an innocuous key (`{"note": "PA3..."}`);
--   * anything below an array, since the recursion never got there.
--
-- Replaced with an iterative traversal over an explicit work stack: no
-- recursion, a hard node budget, and a hard depth budget. Exceeding either is
-- a refusal, not a crash — a document this guard cannot finish reading is one
-- it cannot vouch for.
--
-- **2. A verification token could expire while `finish` waited for a lock.**
--
-- The TTL was checked with `now()`, which is the *transaction start* time and
-- does not advance. A `finish` that queued on the account lock for longer than
-- the TTL still measured its age from before the wait, so a token that died
-- during the wait was accepted afterwards. The deadline is now stored on the
-- token at `begin` and compared with `clock_timestamp()` **after** both locks
-- are held.
--
-- 0001–0022 are not edited.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bounds, and what "sensitive" means.
-- ---------------------------------------------------------------------------

/**
 * The most nodes one audit detail may contain.
 *
 * These documents are a handful of scalars written by this codebase. A
 * thousand nodes is far above anything the RPCs produce and far below
 * anything that costs measurable time to walk. A document past it is refused:
 * "too big to check" and "checked and clean" must not produce the same answer.
 */
create or replace function audit_detail_max_nodes()
returns integer language sql immutable set search_path = pg_catalog
as $$ select 1000 $$;

/** The deepest nesting a detail may use. Nothing here nests beyond two. */
create or replace function audit_detail_max_depth()
returns integer language sql immutable set search_path = pg_catalog
as $$ select 12 $$;

/**
 * A string that is a broker account number.
 *
 * Two tests, because neither alone is enough:
 *
 *   * an **exact match against a stored binding** — no false positives at
 *     all. (A soft delete clears the column, so a deleted account leaves
 *     nothing here to match; there is also nothing left on that row to
 *     leak.) and
 *   * a **shape rule** for Alpaca's paper format, so a number that has not
 *     been stored yet (or belongs to another tenant) is still caught.
 *
 * The shape rule is deliberately narrow. `PA` followed by six or more
 * uppercase alphanumerics — optionally hyphenated, which is what the fixtures
 * use — is not a shape any legitimate audit value in this codebase takes.
 */
create or replace function looks_like_broker_account_number(p_value text)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return false;
  end if;
  if p_value ~ '^PA[A-Z0-9]([A-Z0-9-]{4,})[A-Z0-9]$' then
    return true;
  end if;
  return exists (
    select 1 from accounts where alpaca_account_number = p_value
  );
end;
$$;

-- The guard reads this column for every string leaf. The partial index from
-- 0022 covers only `deleted_at is null`, and this lookup does not filter on
-- that, so it needs its own.
create index if not exists accounts_broker_number_lookup_idx
  on accounts (alpaca_account_number)
  where alpaca_account_number is not null;

/** A key or value that names an internal identifier. */
create or replace function audit_token_is_sensitive(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select p_text ~*
    '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
$$;

/**
 * Whether an audit detail may be stored.
 *
 * `audit_log` is readable by the account's owner, so a detail may name what
 * happened but never *which* internal object it happened to. Digests are the
 * sanctioned way to correlate, and a digest is neither a UUID nor a broker
 * number.
 *
 * Iterative, over an explicit stack. The previous version was recursive and
 * re-wrapped arrays into `{"items": [...]}` before recursing, which is a value
 * of the same shape — so it never terminated. Nothing here calls itself.
 */
create or replace function audit_detail_is_publishable(p_detail jsonb)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  nodes    jsonb[];
  depths   integer[];
  node     jsonb;
  depth    integer;
  visited  integer := 0;
  entry    record;
  leaf     text;
begin
  if p_detail is null then
    return true;
  end if;
  -- Every RPC writes an object. A bare scalar or array is a document this
  -- guard was not written against.
  if jsonb_typeof(p_detail) <> 'object' then
    return false;
  end if;

  nodes := array[p_detail];
  depths := array[0];

  while array_length(nodes, 1) > 0 loop
    node := nodes[array_length(nodes, 1)];
    depth := depths[array_length(depths, 1)];
    nodes := nodes[1:array_length(nodes, 1) - 1];
    depths := depths[1:array_length(depths, 1) - 1];

    visited := visited + 1;
    -- Budgets are refusals, not crashes. A document too large or too deep to
    -- finish reading is one this guard cannot vouch for.
    if visited > audit_detail_max_nodes() then
      return false;
    end if;
    if depth > audit_detail_max_depth() then
      return false;
    end if;

    case jsonb_typeof(node)
      when 'object' then
        for entry in select je.key as k, je.value as v from jsonb_each(node) je loop
          -- Keys are checked too. `{"<uuid>": "x"}` published the identifier
          -- just as effectively as `{"id": "<uuid>"}`, and only values were
          -- ever scanned.
          if entry.k ~*
            '(secret|token|vault|operation_id|api_key|account_number|credential_id)'
          then
            return false;
          end if;
          if audit_token_is_sensitive(entry.k)
             or looks_like_broker_account_number(entry.k) then
            return false;
          end if;
          nodes := nodes || entry.v;
          depths := depths || (depth + 1);
        end loop;
      when 'array' then
        -- Elements are pushed as themselves. Wrapping them in an object was
        -- the non-termination.
        for entry in select ae.value as v from jsonb_array_elements(node) ae loop
          nodes := nodes || entry.v;
          depths := depths || (depth + 1);
        end loop;
      when 'string' then
        leaf := node #>> '{}';
        if audit_token_is_sensitive(leaf)
           or looks_like_broker_account_number(leaf) then
          return false;
        end if;
      else
        -- Numbers, booleans and nulls carry no identifier.
        null;
    end case;
  end loop;

  return true;
end;
$$;

-- The trigger function is unchanged in behaviour but re-declared so its
-- volatility matches the now-`stable` predicate it calls.
create or replace function audit_log_detail_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not audit_detail_is_publishable(new.detail) then
    raise exception
      'audit detail carries a forbidden key, a raw identifier or a broker account number; audit_log is owner-readable, so record a digest instead'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Re-armed explicitly: the trigger already exists from 0022, but stating it
-- here means this migration is complete on a database that somehow lacks it.
drop trigger if exists audit_log_detail_guard_trg on audit_log;
create trigger audit_log_detail_guard_trg
  before insert or update on audit_log
  for each row execute function audit_log_detail_guard();

-- Existing rows must satisfy the corrected predicate, not just the old one.
do $$
declare
  offenders bigint;
begin
  select count(*) into offenders
    from audit_log
   where not audit_detail_is_publishable(detail);
  if offenders > 0 then
    raise exception
      'refusing to arm the corrected audit guard: % existing audit rows carry a forbidden key, a raw identifier or a broker account number',
      offenders
      using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. A verification deadline that a lock wait cannot outlive.
-- ---------------------------------------------------------------------------

alter table account_verification_token
  add column if not exists expires_at timestamptz;

-- Rows that predate the column are already retired by 0022's backfill; giving
-- them a deadline in the past keeps the column total without reviving any.
update account_verification_token
   set expires_at = issued_at + account_verification_ttl()
 where expires_at is null;

alter table account_verification_token
  alter column expires_at set not null;

/**
 * Issue a token, and record the instant it dies.
 *
 * The deadline is stored rather than recomputed. `finish` used to derive it
 * from `issued_at` plus the current TTL, so a change to
 * `account_verification_ttl()` silently re-dated every outstanding token —
 * lengthening the life of one that had already been issued.
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
  deadline   timestamptz;
begin
  perform set_config('lock_timeout', '5s', true);

  if p_account is null or p_owner is null then
    raise exception 'account and owner are required' using errcode = '22023';
  end if;

  -- Lock 1: the account. The order is account, then token, everywhere.
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

  -- Lock 2: the tokens.
  update account_verification_token
     set superseded_at = clock_timestamp()
   where account_id = p_account
     and consumed_at is null
     and superseded_at is null
     and cancelled_at is null;

  select coalesce(max(generation), 0) + 1 into next_gen
    from account_verification_token
   where account_id = p_account;

  -- `clock_timestamp()`, not `now()`: the token's life starts when it is
  -- actually issued, not when this transaction began.
  deadline := clock_timestamp() + account_verification_ttl();

  insert into account_verification_token (
    account_id, owner_id, mode, account_number, credential_version, generation,
    expires_at
  )
  values (
    p_account, p_owner, target.mode, target.alpaca_account_number,
    target.credential_version, next_gen, deadline
  )
  returning token into issued;

  return jsonb_build_object(
    'token', issued,
    'generation', next_gen,
    'expires_at', deadline,
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
 * Finish against the pinned snapshot, with the deadline read after the locks.
 *
 * `now()` is the transaction's start time and does not advance. A `finish`
 * that queued on the account lock for longer than the TTL still measured the
 * token's age from before the wait, so a token that expired *during* the wait
 * was accepted on the other side of it. Every temporal test below uses
 * `clock_timestamp()`, evaluated after both locks are held — which is the only
 * point at which "is this token still alive?" is a question about now.
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
  at          timestamptz;
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

  -- Read without locking, only to learn which account to lock first.
  select * into reservation
    from account_verification_token
   where token = p_token;
  if not found then
    raise exception 'unknown verification token' using errcode = 'P0002';
  end if;

  -- Lock 1: the account. This is the wait that could outlive the token.
  select * into target
    from accounts
   where id = reservation.account_id and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- Lock 2: the token, re-read under the account lock.
  select * into reservation
    from account_verification_token
   where token = p_token
     for update;

  -- *After* both locks. Everything temporal below is measured from here.
  at := clock_timestamp();

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

  select max(generation) into current_gen
    from account_verification_token
   where account_id = reservation.account_id;
  if reservation.generation <> current_gen then
    raise exception
      'verification token % is generation %, but generation % is current',
      p_token, reservation.generation, current_gen
      using errcode = 'P0001';
  end if;

  if reservation.issued_at > at then
    raise exception 'verification token % is dated in the future', p_token
      using errcode = 'P0001';
  end if;
  if at > reservation.expires_at then
    raise exception
      'verification token % expired at % (now %)',
      p_token, reservation.expires_at, at
      using errcode = 'P0001';
  end if;

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
         last_verified_at = case when p_status = 'connected' then clock_timestamp()
                                 else last_verified_at end
   where id = target.id
   returning * into updated;

  update account_verification_token
     set consumed_at = clock_timestamp()
   where token = p_token;

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

-- `cancel` measures the same way, for the same reason.
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

  perform 1 from accounts where id = reservation.account_id for update;

  select * into reservation
    from account_verification_token
   where token = p_token
     for update;

  if reservation.consumed_at is not null then
    raise exception 'verification token % has already been used', p_token
      using errcode = '23505';
  end if;
  if reservation.cancelled_at is not null or reservation.superseded_at is not null then
    return false;
  end if;

  update account_verification_token
     set cancelled_at = clock_timestamp()
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
-- 3. Grants and catalogue assertions.
-- ---------------------------------------------------------------------------
do $$
declare
  fn       record;
  problems text[] := '{}';
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'audit_detail_is_publishable', 'audit_detail_max_nodes',
         'audit_detail_max_depth', 'audit_token_is_sensitive',
         'looks_like_broker_account_number', 'begin_account_verification',
         'finish_account_verification', 'cancel_account_verification'
       )
  loop
    execute format('revoke all on routine %s from public, anon, authenticated', fn.signature);
  end loop;

  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'begin_account_verification', 'finish_account_verification',
         'cancel_account_verification'
       )
  loop
    execute format('grant execute on routine %s to service_role', fn.signature);
  end loop;

  -- The deadline is stored, not derived.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'account_verification_token'
       and column_name = 'expires_at'
       and is_nullable = 'NO'
  ) then
    problems := problems || array['account_verification_token.expires_at is missing or nullable'];
  end if;

  -- The guard terminates on the shape that used to hang it, and refuses the
  -- three things that used to slip past. Live probes, not text inspection.
  if not audit_detail_is_publishable(
       jsonb_build_object('symbols', jsonb_build_array('AAPL', 'MSFT'), 'removed', 2)
     ) then
    problems := problems || array['the guard refuses a benign array'];
  end if;
  if audit_detail_is_publishable(
       jsonb_build_object('items', jsonb_build_array(
         jsonb_build_array(jsonb_build_object('secret_id', 'leaked'))))
     ) then
    problems := problems || array['the guard misses a forbidden key nested inside two arrays'];
  end if;
  if audit_detail_is_publishable(
       jsonb_build_object('00000000-1111-4111-8111-000000000000', 'x')
     ) then
    problems := problems || array['the guard misses a UUID used as a key'];
  end if;
  if audit_detail_is_publishable(jsonb_build_object('note', 'PA3ABCDEF12345')) then
    problems := problems || array['the guard misses a broker account number under an arbitrary key'];
  end if;
  if not audit_detail_is_publishable(
       jsonb_build_object('mode', 'paper', 'operation_digest', substr(md5('x'), 1, 16))
     ) then
    problems := problems || array['the guard refuses the sanctioned digest shape'];
  end if;

  if array_length(problems, 1) > 0 then
    raise exception '0023 post-conditions failed: %', array_to_string(problems, '; ')
      using errcode = 'P0001';
  end if;
end;
$$;
