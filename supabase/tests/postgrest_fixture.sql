-- ============================================================================
-- postgrest_fixture.sql — data for the real-PostgREST gate.
--
-- Deliberately larger than the server's row cap and larger than 1000, so a
-- reader that assumes either number returns a visibly wrong answer.
-- ============================================================================

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'b@example.test')
on conflict (id) do nothing;

insert into accounts (
  id, owner_id, nickname, mode, status, alpaca_account_number,
  alpaca_key_secret_id, alpaca_secret_secret_id
)
values (
  'eeeeeeee-0000-0000-0000-0000000000f1',
  '00000000-0000-0000-0000-00000000000a',
  'PostgREST fixture', 'paper', 'connected', 'PA-PGRST-CANARY-4242',
  null, null
)
on conflict (id) do nothing;

-- A second owner, so cross-tenant reachability is testable.
insert into accounts (id, owner_id, nickname, mode, status)
values (
  'eeeeeeee-0000-0000-0000-0000000000f2',
  '00000000-0000-0000-0000-00000000000b',
  'Someone else', 'paper', 'connected'
)
on conflict (id) do nothing;

-- 1 250 equity days: past the 100-row server cap and past 1000.
insert into equity_snapshots (account_id, snapshot_date, equity, cash, source)
select
  'eeeeeeee-0000-0000-0000-0000000000f1',
  date '2020-01-01' + (n || ' days')::interval,
  1000000 + n * 1000,
  0,
  'alpaca_portfolio_history'
from generate_series(0, 1249) as n
on conflict (account_id, snapshot_date) do nothing;

-- 300 ledger rows, likewise past the cap.
insert into cash_flows (account_id, flow_date, amount, kind, source, external_id)
select
  'eeeeeeee-0000-0000-0000-0000000000f1',
  date '2020-01-01' + (n || ' days')::interval,
  10,
  'deposit',
  'alpaca_activities',
  'act-' || lpad(n::text, 6, '0')
from generate_series(0, 299) as n
on conflict (account_id, external_id) do nothing;
