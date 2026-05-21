-- ============================================================================
-- 0001_enums.sql — extensions and enum types
-- Nate Trader multi-account platform. See DASHBOARD_SPECIFICATION.md §13.1.
-- ============================================================================

-- Supabase Vault — encrypted secret storage for Alpaca API keys.
-- (On modern Supabase projects this is enabled by default; create defensively.)
create extension if not exists supabase_vault cascade;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

-- Alpaca account environment.
do $$ begin
  create type account_mode as enum ('paper', 'live');
exception when duplicate_object then null; end $$;

-- Connection state derived from the last Alpaca call.
do $$ begin
  create type account_status as enum ('unverified', 'connected', 'auth_failed', 'paused');
exception when duplicate_object then null; end $$;

-- Agent routine identifier.
do $$ begin
  create type routine_kind as enum (
    'premarket', 'execution', 'midday', 'eod', 'weekly',
    'gap_scanner', 'backtest', 'auto_iteration', 'heartbeat'
  );
exception when duplicate_object then null; end $$;

-- Outcome of a routine run.
do $$ begin
  create type routine_status as enum ('success', 'partial', 'failed', 'running');
exception when duplicate_object then null; end $$;

-- Direction of an executed trade.
do $$ begin
  create type trade_side as enum ('buy', 'sell');
exception when duplicate_object then null; end $$;

-- Direction of an open position (normalized — fixes DEF-09).
do $$ begin
  create type trade_side_position as enum ('long', 'short');
exception when duplicate_object then null; end $$;

-- Backtest run kind.
do $$ begin
  create type backtest_kind as enum (
    'single', 'sweep', 'monte_carlo', 'walk_forward', 'compare'
  );
exception when duplicate_object then null; end $$;
