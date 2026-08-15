-- ===========================================================================
-- 00_env_bootstrap.sql — the part of a Supabase project that is NOT a migration
--
-- Run as `supabase_admin`.
--
-- `supabase/migrations/0006_storage_policies.sql` inserts into
-- `storage.buckets` and creates policies on `storage.objects`. Neither table is
-- created by any migration in this repository, and neither is created by the
-- `supabase/postgres` image: the storage-api service creates them from its own
-- migration set, as `supabase_storage_admin`, the first time it starts.
-- Against a bare database 0006 fails with
-- `relation "storage.buckets" does not exist` — an artefact of running
-- postgres without the rest of the stack, not a defect in the migration chain
-- and nothing the bridge can observe.
--
-- So this file reproduces what storage-api's initial migration creates, under
-- the role that really owns it, and grants `postgres` membership of that role
-- the way a hosted Supabase project does (which is what lets a migration
-- applied as `postgres` create a policy on `storage.objects` at all).
--
-- It deliberately creates NOTHING in `public`: run.sh asserts that `public` is
-- still empty after this file runs, so the bootstrap can never hide a missing
-- public-schema object from the catalogue check that follows.
-- ===========================================================================

\set ON_ERROR_STOP on

-- What a hosted project does, so `postgres` can manage storage policies.
grant supabase_storage_admin to postgres;

-- Create the tables as their real owner.
set role supabase_storage_admin;

create table if not exists storage.buckets (
  id         text primary key,
  name       text not null,
  owner      uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  public     boolean default false
);
create unique index if not exists bname on storage.buckets (name);

create table if not exists storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets (id),
  name             text,
  owner            uuid,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata         jsonb
);
create unique index if not exists bucketid_objname on storage.objects (bucket_id, name);

alter table storage.objects enable row level security;

grant all on storage.buckets to postgres, service_role;
grant all on storage.objects to postgres, service_role;
grant select on storage.buckets to anon, authenticated;
grant select on storage.objects to anon, authenticated;

reset role;
