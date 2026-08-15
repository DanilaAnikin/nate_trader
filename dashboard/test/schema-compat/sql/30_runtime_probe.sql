-- ===========================================================================
-- 30_runtime_probe.sql — call the functions, as the role the bridge uses
--
-- The catalogue tells you an object exists. It does not tell you the bridge
-- can call it. Migration 0022 is the case in point: it keeps
-- `vault_create_secret` / `vault_update_secret` / `vault_delete_secret` in
-- `pg_proc` — so every name-based check still passes — while replacing each
-- body with `raise exception '… is superseded …'` and revoking EXECUTE from
-- service_role. A grep for the name sees nothing wrong.
--
-- So this file actually calls each function the route surface names, under
-- `service_role`, and records the SQLSTATE. A `42501` (insufficient_privilege)
-- for the role the code runs as is a runtime blocker no matter which schema
-- produced it, and run.sh fails on it.
--
-- Requires the temporary table `wanted` from the generated route surface to
-- already exist in this session, so it can assert that every function on that
-- surface is covered by a probe here — a new RPC in the code must not slip
-- through by simply not having a probe written for it.
--
-- The probes write: `vault_create_secret` really does create a Vault row on a
-- schema where it still works. That is deliberate and safe — these containers
-- are built, seeded and destroyed by run.sh — and the value stored is the
-- literal string 'PROBE-NOT-A-CREDENTIAL'.
-- ===========================================================================

\set ON_ERROR_STOP on

create temporary table probe_result(
  fn        text,
  as_role   text,
  sqlstate  text,
  message   text
);

do $$
declare
  p    record;
  st   text;
  msg  text;
begin
  for p in
    select * from (values
      ('get_account_credentials',
       $q$select count(*) from public.get_account_credentials('22222222-2222-4222-8222-222222222222'::uuid)$q$),
      ('vault_create_secret',
       $q$select public.vault_create_secret('PROBE-NOT-A-CREDENTIAL', 'schema-compat-probe-' || md5(random()::text))$q$),
      ('vault_update_secret',
       $q$select public.vault_update_secret('00000000-0000-0000-0000-000000000000'::uuid, 'PROBE-NOT-A-CREDENTIAL')$q$),
      ('vault_delete_secret',
       $q$select public.vault_delete_secret('00000000-0000-0000-0000-000000000000'::uuid)$q$)
    ) v(fn, stmt)
  loop
    -- Only probe what this route surface actually names.
    if not exists (select 1 from wanted w where w.obj_kind = 'function' and w.obj_name = p.fn) then
      continue;
    end if;
    begin
      set role service_role;
      execute p.stmt;
      st  := '00000';
      msg := 'call completed';
    exception when others then
      get stacked diagnostics st = returned_sqlstate, msg = message_text;
    end;
    reset role;
    insert into probe_result(fn, as_role, sqlstate, message) values (p.fn, 'service_role', st, msg);
  end loop;
  reset role;
end;
$$;

\pset format aligned
\pset border 2
\echo ''
\echo '--- runtime probe: calling each named function as service_role ---'
select fn, as_role, sqlstate,
       case sqlstate
         when '00000' then 'REACHED'
         when '42501' then 'DENIED (insufficient_privilege)'
         else 'REACHED, function raised'
       end as outcome,
       message
from probe_result
order by fn;

\pset format unaligned
\pset tuples_only on

-- Any function that the route surface names, that exists here, and that has no
-- probe: the probe set has gone stale relative to the code, which is a harness
-- failure and not a pass. A function that is absent from the catalogue is
-- excluded — 20_check.sql has already reported it as a blocker and there is
-- nothing to call.
select 'SCHEMA_COMPAT_UNPROBED=' || coalesce(string_agg(w.obj_name, ',' order by w.obj_name), '')
from wanted w
where w.obj_kind = 'function'
  and exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = w.obj_name)
  and not exists (select 1 from probe_result r where r.fn = w.obj_name);

select 'SCHEMA_COMPAT_RUNTIME_DENIED=' || coalesce(string_agg(fn || '(' || sqlstate || ')', ',' order by fn), '')
from probe_result
where sqlstate = '42501';

select 'SCHEMA_COMPAT_PROBED=' || count(*) from probe_result;

\pset tuples_only off
\pset format aligned
