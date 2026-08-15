-- ===========================================================================
-- 10_seed.sql — representative, obviously-disposable fixture data
--
-- Everything here is fake by construction: the e-mail is on the reserved
-- `.invalid` TLD, the "credentials" are literal strings saying so, and the
-- UUIDs are hand-written constants. There is no broker call anywhere in this
-- harness and no real key is ever accepted — a real Alpaca key would be an
-- error, not a shortcut.
--
-- The file must apply identically to the 0001-0008 reference database and to
-- the 0001-0023 database, so it writes only through paths that exist in both:
-- plain inserts as `postgres` (which `is_service_role()` recognises from 0009
-- onwards) and `vault.create_secret`, which 0020's FK from
-- `accounts.alpaca_*_secret_id` to `vault.secrets` requires.
--
-- It ends with an assertion block. A seed that silently seeded nothing would
-- make every later query trivially "succeed".
-- ===========================================================================

\set ON_ERROR_STOP on

-- --- 1. an auth user -------------------------------------------------------
-- 0002 puts an AFTER INSERT trigger on auth.users that creates the profile
-- row, so the profile below is created by the migration chain, not by hand.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-4111-8111-111111111111',
  'authenticated', 'authenticated',
  'schema-compat-fixture@example.invalid',
  'NOT-A-REAL-PASSWORD-HASH',
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Schema Compat Fixture"}'::jsonb,
  now(), now()
) on conflict (id) do nothing;

-- --- 2. the profile --------------------------------------------------------
-- Created by the on_auth_user_created trigger. Inserted defensively so the
-- seed is idempotent if the trigger is ever dropped, and asserted below.
insert into public.profiles (id, display_name)
values ('11111111-1111-4111-8111-111111111111', 'Schema Compat Fixture')
on conflict (id) do nothing;

-- --- 3. Vault secrets standing in for the Alpaca key pair ------------------
do $$
declare
  key_id    uuid;
  secret_id uuid;
begin
  select id into key_id from vault.secrets where name = 'schema-compat-fixture-key';
  if key_id is null then
    key_id := vault.create_secret(
      'FAKE-KEY-NOT-A-CREDENTIAL', 'schema-compat-fixture-key',
      'schema-compat harness fixture; never a real Alpaca key');
  end if;

  select id into secret_id from vault.secrets where name = 'schema-compat-fixture-secret';
  if secret_id is null then
    secret_id := vault.create_secret(
      'FAKE-SECRET-NOT-A-CREDENTIAL', 'schema-compat-fixture-secret',
      'schema-compat harness fixture; never a real Alpaca secret');
  end if;

  -- --- 4. the account ------------------------------------------------------
  insert into public.accounts (
    id, owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    is_active, last_verified_at
  ) values (
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'Fixture Paper Account', 'paper', 'connected', '#007aff',
    key_id, secret_id, 'PA-FIXTURE-0000',
    true, now()
  ) on conflict (id) do nothing;
end $$;

-- --- 5. an equity curve and a cash-flow ledger -----------------------------
insert into public.equity_snapshots (
  account_id, snapshot_date, equity, cash, position_market_value,
  num_positions, profit_loss, profit_loss_pct, source
)
select
  '22222222-2222-4222-8222-222222222222',
  d::date,
  100000 + (row_number() over (order by d)) * 137.50,
  10000,
  90000,
  8,
  137.50,
  0.001375,
  'schema-compat-fixture'
from generate_series(date '2026-01-02', date '2026-01-30', interval '1 day') d
where extract(isodow from d) < 6
on conflict (account_id, snapshot_date) do nothing;

insert into public.cash_flows (
  account_id, flow_date, amount, kind, source, external_id
) values
  ('22222222-2222-4222-8222-222222222222', date '2026-01-02',  100000.00, 'deposit',    'schema-compat-fixture', 'fixture-flow-1'),
  ('22222222-2222-4222-8222-222222222222', date '2026-01-15',   25000.00, 'deposit',    'schema-compat-fixture', 'fixture-flow-2'),
  ('22222222-2222-4222-8222-222222222222', date '2026-01-27',  -5000.00,  'withdrawal', 'schema-compat-fixture', 'fixture-flow-3')
on conflict (account_id, external_id) do nothing;

-- --- 6. an audit trail -----------------------------------------------------
insert into public.audit_log (actor_id, account_id, action, detail)
values (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'schema_compat.seed',
  '{"note":"harness fixture"}'::jsonb
);

-- --- 7. assert the seed actually seeded ------------------------------------
do $$
declare
  n_users    int;
  n_profiles int;
  n_accounts int;
  n_equity   int;
  n_flows    int;
  n_audit    int;
  acct_owner uuid;
  -- Named once, used by both the condition and the message, so a changed
  -- expectation cannot leave the error text quietly describing the old one.
  exp_users     constant int := 1;
  exp_profiles  constant int := 1;
  exp_accounts  constant int := 1;
  min_equity    constant int := 20;
  exp_flows     constant int := 3;
  min_audit     constant int := 1;
  exp_owner     constant uuid := '11111111-1111-4111-8111-111111111111';
begin
  select count(*) into n_users    from auth.users where id = '11111111-1111-4111-8111-111111111111';
  select count(*) into n_profiles from public.profiles where id = '11111111-1111-4111-8111-111111111111';
  select count(*) into n_accounts from public.accounts where id = '22222222-2222-4222-8222-222222222222';
  select count(*) into n_equity   from public.equity_snapshots where account_id = '22222222-2222-4222-8222-222222222222';
  select count(*) into n_flows    from public.cash_flows where account_id = '22222222-2222-4222-8222-222222222222';
  select count(*) into n_audit    from public.audit_log where action = 'schema_compat.seed';
  select owner_id into acct_owner from public.accounts where id = '22222222-2222-4222-8222-222222222222';

  if n_users    <> exp_users    then raise exception 'seed: expected % auth.users row(s), got %',        exp_users,    n_users;    end if;
  if n_profiles <> exp_profiles then raise exception 'seed: expected % profiles row(s), got %',          exp_profiles, n_profiles; end if;
  if n_accounts <> exp_accounts then raise exception 'seed: expected % accounts row(s), got %',          exp_accounts, n_accounts; end if;
  if n_equity   <  min_equity   then raise exception 'seed: expected >=% equity_snapshots rows, got %',  min_equity,   n_equity;   end if;
  if n_flows    <> exp_flows    then raise exception 'seed: expected % cash_flows rows, got %',          exp_flows,    n_flows;    end if;
  if n_audit    <  min_audit    then raise exception 'seed: expected >=% audit_log row(s), got %',       min_audit,    n_audit;    end if;
  if acct_owner is distinct from exp_owner then
    raise exception 'seed: accounts.owner_id % does not match the seeded auth user %', acct_owner, exp_owner;
  end if;

  raise notice 'seed ok: users=% profiles=% accounts=% equity=% flows=% audit=%',
    n_users, n_profiles, n_accounts, n_equity, n_flows, n_audit;
end $$;
