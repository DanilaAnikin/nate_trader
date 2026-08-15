-- ===========================================================================
-- 00_env_bootstrap.sql — the part of a Supabase project that is NOT a migration
--
-- `supabase/migrations/0006_storage_policies.sql` inserts into `storage.buckets`
-- and creates policies on `storage.objects`. Neither table is created by any
-- migration in this repository, and neither is created by the
-- `supabase/postgres` image: the storage-api service creates them from its own
-- migration set the first time it starts. Against a bare database, 0006 fails
-- with `relation "storage.buckets" does not exist`, which is an artefact of
-- running postgres without the rest of the stack — not a defect in the
-- migration chain and not something the bridge can observe.
--
-- So this file reproduces exactly the two tables storage-api's initial
-- migration creates, and nothing else. It deliberately creates NOTHING in
-- `public`: run.sh asserts that `public` is still empty after this file runs,
-- so the bootstrap can never hide a missing public-schema object from the
-- catalogue check that follows.
-- ===========================================================================

create schema if not exists storage;

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

grant all on schema storage to postgres, service_role;
grant all on storage.buckets to postgres, service_role;
grant all on storage.objects to postgres, service_role;
grant select on storage.buckets to anon, authenticated;
grant select on storage.objects to anon, authenticated;
