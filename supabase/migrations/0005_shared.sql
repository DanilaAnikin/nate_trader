-- ============================================================================
-- 0005_shared.sql — account-agnostic / shared data
-- strategy_params, market_history, research/screener snapshots,
-- backtest_runs, audit_log.
-- See DASHBOARD_SPECIFICATION.md §13.10–13.14.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- strategy_params — live regime parameters (fixes DEF-08).
-- Singleton row written by the agent after each research run so the dashboard
-- reads the REAL limits instead of hard-coding them.
-- ---------------------------------------------------------------------------
create table if not exists strategy_params (
  id                 int primary key default 1,
  regime             text not null,
  risk_tier          text not null,
  score_threshold    numeric,
  gate_score_min     numeric,
  min_cash_pct       numeric,
  max_cash_pct       numeric,
  max_positions      int,
  max_position_pct   numeric,
  risk_per_trade_pct numeric,
  trailing_stop_pct  numeric,
  raw                jsonb,
  updated_at         timestamptz not null default now(),
  constraint strategy_params_singleton check (id = 1)
);

alter table strategy_params enable row level security;
drop policy if exists "read params" on strategy_params;
create policy "read params" on strategy_params
  for select using (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- market_history — SPY / benchmark daily closes.
-- ---------------------------------------------------------------------------
create table if not exists market_history (
  symbol    text not null,
  bar_date  date not null,
  close     numeric(18,4) not null,
  primary key (symbol, bar_date)
);

alter table market_history enable row level security;
drop policy if exists "read market" on market_history;
create policy "read market" on market_history
  for select using (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- research_snapshots — index row; the large per-symbol payload lives in
-- Supabase Storage (fixes DEF-02).
-- ---------------------------------------------------------------------------
create table if not exists research_snapshots (
  id           bigint generated always as identity primary key,
  generated_at timestamptz not null,
  spy          jsonb,
  symbol_count int,
  buy_count    int,
  hold_count   int,
  sell_count   int,
  storage_path text not null,
  created_at   timestamptz not null default now()
);

create index if not exists research_snap_gen_idx
  on research_snapshots(generated_at desc);

alter table research_snapshots enable row level security;
drop policy if exists "read research" on research_snapshots;
create policy "read research" on research_snapshots
  for select using (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- screener_snapshots — same shape as research_snapshots.
-- ---------------------------------------------------------------------------
create table if not exists screener_snapshots (
  id              bigint generated always as identity primary key,
  generated_at    timestamptz not null,
  candidate_count int,
  scored_count    int,
  highest_score   numeric,
  storage_path    text not null,
  created_at      timestamptz not null default now()
);

create index if not exists screener_snap_gen_idx
  on screener_snapshots(generated_at desc);

alter table screener_snapshots enable row level security;
drop policy if exists "read screener" on screener_snapshots;
create policy "read screener" on screener_snapshots
  for select using (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- backtest_runs — backtest index (fixes DEF-03). Full payload in Storage.
-- ---------------------------------------------------------------------------
create table if not exists backtest_runs (
  id           text primary key,            -- e.g. 'single_20260521_073748'
  kind         backtest_kind not null,
  generated_at timestamptz not null,
  start_date   date,
  end_date     date,
  summary      jsonb not null,
  storage_path text not null,
  created_at   timestamptz not null default now()
);

create index if not exists backtest_runs_kind_idx
  on backtest_runs(kind, generated_at desc);

alter table backtest_runs enable row level security;
drop policy if exists "read backtests" on backtest_runs;
create policy "read backtests" on backtest_runs
  for select using (auth.uid() is not null);

-- ---------------------------------------------------------------------------
-- audit_log — credential & account events. Never stores key material.
-- ---------------------------------------------------------------------------
create table if not exists audit_log (
  id         bigint generated always as identity primary key,
  actor_id   uuid,
  account_id uuid,
  action     text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_actor_idx
  on audit_log(actor_id, created_at desc);

alter table audit_log enable row level security;
drop policy if exists "read own audit" on audit_log;
create policy "read own audit" on audit_log
  for select using (actor_id = auth.uid());
