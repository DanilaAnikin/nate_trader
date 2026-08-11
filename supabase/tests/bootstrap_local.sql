-- ============================================================================
-- bootstrap_local.sql — minimal Supabase-shaped scaffolding for a plain
-- PostgreSQL server, so the real migrations can be applied and tested in CI.
--
-- This creates ONLY the platform objects Supabase would provide (roles, the
-- `auth` schema, a Vault stand-in). It deliberately creates none of the
-- application schema — that must come from the migrations under test.
-- ============================================================================

-- --- platform roles --------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- --- auth schema -----------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- Shaped like the real `auth.users` columns the migrations touch: 0002's
-- profile trigger reads `email` and `raw_user_meta_data`.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Supabase resolves the caller from the request's JWT claims. The real helper
-- has exactly this shape; tests set `request.jwt.claims` to impersonate.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  );
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.role() to anon, authenticated, service_role;

-- --- vault stand-in --------------------------------------------------------
-- The credential functions reference `vault.decrypted_secrets`; only its shape
-- matters here, and no test in this suite decrypts anything.
create schema if not exists vault;
create table if not exists vault.secrets (
  id     uuid primary key default gen_random_uuid(),
  name   text,
  secret text
);
create or replace view vault.decrypted_secrets as
  select id, name, secret as decrypted_secret from vault.secrets;

create or replace function vault.create_secret(p_secret text, p_name text default null)
returns uuid language plpgsql as $$
declare sid uuid;
begin
  insert into vault.secrets (name, secret) values (p_name, p_secret) returning id into sid;
  return sid;
end; $$;

create or replace function vault.update_secret(p_id uuid, p_secret text)
returns void language sql as $$
  update vault.secrets set secret = p_secret where id = p_id;
$$;

grant usage on schema vault to service_role;

-- --- storage stand-in (0006 policies attach to it) -------------------------
create schema if not exists storage;
create table if not exists storage.buckets (
  id     text primary key,
  name   text,
  public boolean not null default false
);
create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name      text,
  owner     uuid
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;

-- --- default privileges the platform normally grants ------------------------
--
-- These must match Supabase's own initial schema *exactly*, because they are
-- the reason a migration that creates a table or view without any `grant` is
-- still reachable through PostgREST. Getting them wrong makes the whole suite
-- test a database that is more locked down than production.
--
-- Two details matter and were previously missing here:
--   * `anon` receives the same defaults as `authenticated`. A migration that
--     only revokes from `public` therefore leaves `anon` holding a direct
--     grant, because revoking from `public` does not touch role grants.
--   * The default is ALL, not just SELECT/INSERT/UPDATE/DELETE — so a new view
--     arrives DML-capable, and a simple single-table view is auto-updatable.
--
-- Supabase (initial schema):
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON TABLES    TO postgres, anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
