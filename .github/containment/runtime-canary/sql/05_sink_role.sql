-- ===========================================================================
-- 05_sink_role.sql — let the recording gateway connect the way PostgREST does
--
-- The production image ships its own `pg_hba.conf`: loopback is trusted, and
-- every other address — including the docker network the harness's containers
-- share — requires `scram-sha-256`. `POSTGRES_HOST_AUTH_METHOD=trust` does not
-- override it. So the gateway needs a password, and it gets one here rather
-- than by weakening the image's authentication configuration: a harness that
-- edited `pg_hba.conf` would no longer be running the production image's
-- security posture, which is part of what the run is supposed to exercise.
--
-- `authenticator` is the role PostgREST itself uses, with no rights of its own
-- and membership of the three request roles it switches into. That is exactly
-- the privilege shape the canary's ACL replay is written against.
--
-- The password is a literal string saying it is not a credential, for a
-- container that is destroyed at the end of the run and never reachable from
-- outside the `--internal` network.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

alter role authenticator with login password 'nt-runtime-canary-not-a-credential';
grant anon, authenticated, service_role to authenticator;

-- The gateway must be able to become each request role, or every forwarded
-- call would fail as a permission error and "no PostgREST call reached the
-- database" would be true for a reason that has nothing to do with the image.
do $$
declare missing text;
begin
  select string_agg(r, ', ')
    into missing
    from unnest(array['anon','authenticated','service_role']) as r
   where not pg_has_role('authenticator', r, 'MEMBER');
  if missing is not null then
    raise exception 'authenticator is not a member of: %', missing using errcode = 'P0001';
  end if;
  if not (select rolcanlogin from pg_roles where rolname = 'authenticator') then
    raise exception 'authenticator cannot log in' using errcode = 'P0001';
  end if;
end $$;

select 'SINK_ROLE=ready' as verdict;
