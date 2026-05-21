-- ============================================================================
-- 0002_profiles_accounts.sql — dashboard users and Alpaca accounts
-- See DASHBOARD_SPECIFICATION.md §13.2–13.3.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles — 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  display_name       text,
  default_account_id uuid,                      -- FK added after `accounts` exists
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- Auto-create a profile row whenever a new auth user is created.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email))
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- accounts — one row per Alpaca brokerage account (paper or live)
-- ---------------------------------------------------------------------------
create table if not exists accounts (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users(id) on delete cascade,
  nickname                text not null,
  mode                    account_mode   not null,
  status                  account_status not null default 'unverified',
  color                   text not null default '#007aff',
  -- Supabase Vault secret references — NEVER plaintext keys (spec §10).
  alpaca_key_secret_id    uuid,
  alpaca_secret_secret_id uuid,
  alpaca_account_number   text,
  is_active               boolean not null default true,
  last_verified_at        timestamptz,
  last_synced_at          timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);

create index if not exists accounts_owner_idx
  on accounts(owner_id) where deleted_at is null;

alter table accounts enable row level security;

drop policy if exists "own accounts" on accounts;
create policy "own accounts" on accounts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Deferred FK: profiles.default_account_id → accounts.id
do $$ begin
  alter table profiles
    add constraint profiles_default_account_fk
    foreign key (default_account_id) references accounts(id) on delete set null;
exception when duplicate_object then null; end $$;

-- Keep updated_at fresh.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists accounts_touch on accounts;
create trigger accounts_touch before update on accounts
  for each row execute function touch_updated_at();

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles
  for each row execute function touch_updated_at();
