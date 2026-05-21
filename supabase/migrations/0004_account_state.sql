-- ============================================================================
-- 0004_account_state.sql — per-account live state
-- equity_snapshots, performance, positions, trades, cash_flows, routine_runs.
-- See DASHBOARD_SPECIFICATION.md §13.4–13.9.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- equity_snapshots — the equity curve (fixes DEF-01). One row per day.
-- ---------------------------------------------------------------------------
create table if not exists equity_snapshots (
  id                     bigint generated always as identity primary key,
  account_id             uuid not null references accounts(id) on delete cascade,
  snapshot_date          date not null,
  equity                 numeric(18,2) not null,
  cash                   numeric(18,2) not null,
  position_market_value  numeric(18,2) not null default 0,
  num_positions          int not null default 0,
  profit_loss            numeric(18,2),
  profit_loss_pct        numeric(12,6),
  deposits               numeric(18,2) not null default 0,
  withdrawals            numeric(18,2) not null default 0,
  regime                 text,
  risk_tier              text,
  source                 text not null default 'alpaca_portfolio_history',
  created_at             timestamptz not null default now(),
  unique (account_id, snapshot_date)
);

create index if not exists equity_snap_acct_date_idx
  on equity_snapshots(account_id, snapshot_date);

alter table equity_snapshots enable row level security;
drop policy if exists "read own equity" on equity_snapshots;
create policy "read own equity" on equity_snapshots
  for select using (owns_account(account_id));

-- ---------------------------------------------------------------------------
-- performance — current-state KPIs, one row per account.
-- ---------------------------------------------------------------------------
create table if not exists performance (
  account_id        uuid primary key references accounts(id) on delete cascade,
  equity            numeric(18,2) not null,
  cash              numeric(18,2) not null,
  cash_pct          numeric(12,6) not null,
  position_value    numeric(18,2) not null default 0,
  num_positions     int not null default 0,
  daily_pnl         numeric(18,2) not null default 0,
  daily_pnl_pct     numeric(12,6) not null default 0,
  weekly_twr_pct    numeric(12,6),
  monthly_twr_pct   numeric(12,6),
  ytd_twr_pct       numeric(12,6),
  all_time_twr_pct  numeric(12,6),
  risk_tier         text not null default 'NORMAL',
  risk_tier_reason  text,
  updated_at        timestamptz not null default now()
);

alter table performance enable row level security;
drop policy if exists "read own performance" on performance;
create policy "read own performance" on performance
  for select using (owns_account(account_id));

-- ---------------------------------------------------------------------------
-- positions — open positions per account.
-- ---------------------------------------------------------------------------
create table if not exists positions (
  id                bigint generated always as identity primary key,
  account_id        uuid not null references accounts(id) on delete cascade,
  symbol            text not null,
  qty               numeric(20,8) not null,
  side              trade_side_position not null default 'long',
  avg_entry_price   numeric(18,4) not null,
  current_price     numeric(18,4) not null,
  market_value      numeric(18,2) not null,
  cost_basis        numeric(18,2),
  unrealized_pl     numeric(18,2) not null,
  unrealized_pl_pct numeric(12,6) not null,   -- stored as a PERCENT, e.g. -0.80
  strategy          text,
  entry_date        date,
  updated_at        timestamptz not null default now(),
  unique (account_id, symbol)
);

create index if not exists positions_acct_idx on positions(account_id);

alter table positions enable row level security;
drop policy if exists "read own positions" on positions;
create policy "read own positions" on positions
  for select using (owns_account(account_id));

-- ---------------------------------------------------------------------------
-- trades — realized trade log (fills DEF-13).
-- ---------------------------------------------------------------------------
create table if not exists trades (
  id               bigint generated always as identity primary key,
  account_id       uuid not null references accounts(id) on delete cascade,
  alpaca_order_id  text,
  symbol           text not null,
  side             trade_side not null,
  qty              numeric(20,8) not null,
  price            numeric(18,4) not null,
  notional         numeric(18,2) not null,
  filled_at        timestamptz not null,
  realized_pnl     numeric(18,2),
  realized_pnl_pct numeric(12,6),
  reason           text,
  strategy         text,
  created_at       timestamptz not null default now(),
  unique (account_id, alpaca_order_id)
);

create index if not exists trades_acct_filled_idx
  on trades(account_id, filled_at desc);

alter table trades enable row level security;
drop policy if exists "read own trades" on trades;
create policy "read own trades" on trades
  for select using (owns_account(account_id));

-- ---------------------------------------------------------------------------
-- cash_flows — deposits / withdrawals, for correct time-weighted return.
-- ---------------------------------------------------------------------------
create table if not exists cash_flows (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  flow_date   date not null,
  amount      numeric(18,2) not null,        -- + deposit, - withdrawal
  kind        text not null,                 -- deposit | withdrawal | fee | adjustment
  source      text not null default 'alpaca_activities',
  external_id text,                          -- Alpaca activity id, for idempotency
  created_at  timestamptz not null default now(),
  unique (account_id, external_id)
);

create index if not exists cash_flows_acct_date_idx
  on cash_flows(account_id, flow_date);

alter table cash_flows enable row level security;
drop policy if exists "read own cash flows" on cash_flows;
create policy "read own cash flows" on cash_flows
  for select using (owns_account(account_id));

-- ---------------------------------------------------------------------------
-- routine_runs — agent execution log (fills DEF-15).
-- account_id is nullable: account-agnostic routines (research, screener) log
-- a single row with account_id = null.
-- ---------------------------------------------------------------------------
create table if not exists routine_runs (
  id             bigint generated always as identity primary key,
  account_id     uuid references accounts(id) on delete cascade,
  kind           routine_kind not null,
  status         routine_status not null,
  started_at     timestamptz not null,
  finished_at    timestamptz,
  duration_ms    int,
  summary        jsonb,
  github_run_url text,
  created_at     timestamptz not null default now()
);

create index if not exists routine_runs_acct_idx
  on routine_runs(account_id, started_at desc);
create index if not exists routine_runs_kind_idx
  on routine_runs(kind, started_at desc);

alter table routine_runs enable row level security;
drop policy if exists "read own routine runs" on routine_runs;
create policy "read own routine runs" on routine_runs
  for select using (account_id is null or owns_account(account_id));

-- Keep updated_at fresh on the mutable per-account tables.
drop trigger if exists performance_touch on performance;
create trigger performance_touch before update on performance
  for each row execute function touch_updated_at();

drop trigger if exists positions_touch on positions;
create trigger positions_touch before update on positions
  for each row execute function touch_updated_at();
