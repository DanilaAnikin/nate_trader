-- ===========================================================================
-- 15_probe_identity.sql — the disposable Auth identity, created in OUR clone
--
-- The authenticated half of the matrix needs a signed-in user. It must not be
-- the production probe identity and must not come from production Auth: this
-- file creates one inside the throwaway database the harness just built, and
-- nothing outside the container ever learns anything about it that is not
-- already written here in plaintext.
--
-- Everything is fake by construction: `.invalid` is the reserved TLD, the
-- password hash is a literal string saying it is not one, and the uuids are
-- hand-written constants that appear in `driver/keys.mjs` as well so the JWT
-- and the row agree.
--
-- The probe user also gets an account of its OWN. The reused schema-compat
-- seed's account belongs to a different fixture user, and a mutation aimed at
-- someone else's account is rejected by the ownership check before it can
-- reach a Vault wrapper — which would make "no canary rows" true for the wrong
-- reason. The mutant must be able to get all the way through.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '33333333-3333-4333-8333-333333333333',
  'authenticated', 'authenticated',
  'runtime-canary-probe@example.invalid',
  'NOT-A-REAL-PASSWORD-HASH',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Runtime Canary Probe"}'::jsonb,
  now(), now()
) on conflict (id) do nothing;

insert into public.profiles (id, display_name)
values ('33333333-3333-4333-8333-333333333333', 'Runtime Canary Probe')
on conflict (id) do nothing;

do $$
declare
  key_id    uuid;
  secret_id uuid;
begin
  select id into key_id from vault.secrets where name = 'runtime-canary-probe-key';
  if key_id is null then
    key_id := vault.create_secret(
      'FAKE-KEY-NOT-A-CREDENTIAL', 'runtime-canary-probe-key',
      'runtime-canary fixture; never a real Alpaca key');
  end if;

  select id into secret_id from vault.secrets where name = 'runtime-canary-probe-secret';
  if secret_id is null then
    secret_id := vault.create_secret(
      'FAKE-SECRET-NOT-A-CREDENTIAL', 'runtime-canary-probe-secret',
      'runtime-canary fixture; never a real Alpaca secret');
  end if;

  insert into public.accounts (
    id, owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    is_active, last_verified_at
  ) values (
    '44444444-4444-4444-8444-444444444444',
    '33333333-3333-4333-8333-333333333333',
    'Canary Probe Account', 'paper', 'connected', '#123456',
    key_id, secret_id, 'PA-CANARY-0000',
    true, now()
  ) on conflict (id) do nothing;
end $$;

-- --- assert the identity actually exists -----------------------------------
-- A probe identity that silently failed to insert would make every
-- authenticated request in the matrix a 401, and "no canary rows" would then
-- be a statement about a missing user rather than about a frozen image.
do $$
declare
  n_user int; n_profile int; n_account int; owner uuid; k uuid; s uuid;
begin
  select count(*) into n_user    from auth.users      where id = '33333333-3333-4333-8333-333333333333';
  select count(*) into n_profile from public.profiles where id = '33333333-3333-4333-8333-333333333333';
  select count(*) into n_account from public.accounts where id = '44444444-4444-4444-8444-444444444444';
  select owner_id, alpaca_key_secret_id, alpaca_secret_secret_id
    into owner, k, s
    from public.accounts where id = '44444444-4444-4444-8444-444444444444';

  if n_user    <> 1 then raise exception 'probe identity: expected 1 auth.users row, got %', n_user; end if;
  if n_profile <> 1 then raise exception 'probe identity: expected 1 profiles row, got %', n_profile; end if;
  if n_account <> 1 then raise exception 'probe identity: expected 1 accounts row, got %', n_account; end if;
  if owner is distinct from '33333333-3333-4333-8333-333333333333'::uuid then
    raise exception 'probe identity: the probe account is owned by % not the probe user', owner;
  end if;
  -- The credential ids are what `deleteAccount` feeds to `vault_delete_secret`.
  -- Without them the mutant would skip the wrapper call entirely (see
  -- `purgeCredentials`: it is a no-op on nulls) and property (B) would silently
  -- degrade into "nothing happened", which looks exactly like a pass.
  if k is null or s is null then
    raise exception 'probe identity: the probe account has no vault secret ids (key=%, secret=%)', k, s;
  end if;

  raise notice 'probe identity ok: user=1 profile=1 account=1 key_secret=% secret_secret=%', k, s;
end $$;
