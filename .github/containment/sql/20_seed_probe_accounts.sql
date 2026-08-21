-- ===========================================================================
-- 20_seed_probe_accounts.sql — the SECOND owner the ownership probe needs
--
-- NOT vendored. `sql/00_env_bootstrap.sql` and `sql/10_seed.sql` are copies of
-- the schema-compat harness's own files and the driver diffs them against
-- `bridge/pre-migration-containment`; this file is owned by this directory and
-- extends the fixture without touching that provenance.
--
-- WHY IT EXISTS
-- -------------
-- `10_seed.sql` seeds exactly one account, owned by one user. Against a
-- single-account fixture, "does `owns_account` check OWNERSHIP?" and "does
-- `owns_account` check EXISTENCE?" are the same question: a function rewritten
-- to
--
--     select exists (select 1 from accounts where id = acct)
--
-- answers `true` for the one seeded account and `false` for an absent id, which
-- is precisely what a single-account probe asserts. The rewrite is invisible.
--
-- So this file seeds a SECOND account under a DIFFERENT owner. The probe can
-- then require all three answers:
--
--     owns_account(own account)         -> true
--     owns_account(other owner's acct)  -> false     <-- the discriminating one
--     owns_account(absent account)      -> false
--
-- Only a function that reads `owner_id` produces all three.
--
-- Everything here is fake by construction, exactly as in 10_seed.sql: the
-- e-mail is on the reserved `.invalid` TLD, the "credentials" are literal
-- strings saying so, and the UUIDs are hand-written constants.
--
-- It must apply identically to the 0001-0008 reference database and to the
-- 0001-0023 one, so it writes only through paths that exist in both: plain
-- inserts as `postgres`, and `vault.create_secret` for the secret ids that
-- 0020's FK from `accounts.alpaca_*_secret_id` requires.
--
-- It ends with an assertion block. A second owner that silently failed to seed
-- would turn the discriminating probe back into an existence check.
-- ===========================================================================

\set ON_ERROR_STOP on

-- --- 1. a second auth user -------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '44444444-4444-4444-8444-444444444444',
  'authenticated', 'authenticated',
  'schema-compat-fixture-other@example.invalid',
  'NOT-A-REAL-PASSWORD-HASH',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Schema Compat Fixture (other owner)"}'::jsonb,
  now(), now()
) on conflict (id) do nothing;

-- --- 2. the second profile -------------------------------------------------
insert into public.profiles (id, display_name)
values ('44444444-4444-4444-8444-444444444444', 'Schema Compat Fixture (other owner)')
on conflict (id) do nothing;

-- --- 3. the second account, owned by the OTHER user ------------------------
do $$
declare
  key_id    uuid;
  secret_id uuid;
begin
  select id into key_id from vault.secrets where name = 'schema-compat-fixture-other-key';
  if key_id is null then
    key_id := vault.create_secret(
      'FAKE-KEY-NOT-A-CREDENTIAL', 'schema-compat-fixture-other-key',
      'schema-compat harness fixture; never a real Alpaca key');
  end if;

  select id into secret_id from vault.secrets where name = 'schema-compat-fixture-other-secret';
  if secret_id is null then
    secret_id := vault.create_secret(
      'FAKE-SECRET-NOT-A-CREDENTIAL', 'schema-compat-fixture-other-secret',
      'schema-compat harness fixture; never a real Alpaca secret');
  end if;

  insert into public.accounts (
    id, owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    is_active, last_verified_at
  ) values (
    '55555555-5555-4555-8555-555555555555',
    '44444444-4444-4444-8444-444444444444',
    'Fixture Paper Account (other owner)', 'paper', 'connected', '#34c759',
    key_id, secret_id, 'PA-FIXTURE-9999',
    true, now()
  ) on conflict (id) do nothing;
end $$;

-- --- 4. assert the second owner really exists and really differs -----------
do $$
declare
  n_users     int;
  n_profiles  int;
  n_accounts  int;
  owner_a     uuid;
  owner_b     uuid;
  n_distinct  int;
  acct_a      constant uuid := '22222222-2222-4222-8222-222222222222';
  acct_b      constant uuid := '55555555-5555-4555-8555-555555555555';
  acct_absent constant uuid := '33333333-3333-4333-8333-333333333333';
  user_b      constant uuid := '44444444-4444-4444-8444-444444444444';
begin
  select count(*) into n_users    from auth.users      where id = user_b;
  select count(*) into n_profiles from public.profiles where id = user_b;
  select count(*) into n_accounts from public.accounts where id = acct_b;

  if n_users    <> 1 then raise exception 'probe seed: expected 1 second auth.users row, got %', n_users; end if;
  if n_profiles <> 1 then raise exception 'probe seed: expected 1 second profiles row, got %', n_profiles; end if;
  if n_accounts <> 1 then raise exception 'probe seed: expected 1 second accounts row, got %', n_accounts; end if;

  select owner_id into owner_a from public.accounts where id = acct_a;
  select owner_id into owner_b from public.accounts where id = acct_b;

  if owner_a is null then
    raise exception 'probe seed: the first fixture account % is missing', acct_a;
  end if;
  if owner_b is distinct from user_b then
    raise exception 'probe seed: account % is owned by %, expected %', acct_b, owner_b, user_b;
  end if;
  -- The whole point: two accounts, two DIFFERENT owners. Equal owners would
  -- silently restore the existence-vs-ownership ambiguity this file removes.
  if owner_a is not distinct from owner_b then
    raise exception 'probe seed: both fixture accounts are owned by % — the ownership probe would prove nothing', owner_a;
  end if;

  select count(distinct owner_id) into n_distinct
    from public.accounts where id in (acct_a, acct_b) and deleted_at is null;
  if n_distinct <> 2 then
    raise exception 'probe seed: expected 2 distinct live owners across the two fixture accounts, got %', n_distinct;
  end if;

  -- and the absent id really is absent, or "false for absent" proves nothing
  if exists (select 1 from public.accounts where id = acct_absent) then
    raise exception 'probe seed: the absent-account id % exists', acct_absent;
  end if;

  raise notice 'probe seed ok: owner(%)=% owner(%)=% absent=% not present',
    acct_a, owner_a, acct_b, owner_b, acct_absent;
end $$;
