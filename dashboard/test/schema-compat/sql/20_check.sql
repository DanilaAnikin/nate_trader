-- ===========================================================================
-- 20_check.sql — does every object the bridge names actually exist here?
--
-- Reads the temporary table `wanted(obj_name, obj_kind, used_by)`, which the
-- caller creates in the same psql session — either from the generated route
-- surface or from the control set. Existence is decided by the live
-- catalogue (pg_class / pg_proc), never by reading a migration file.
--
-- `.from("X")` and `.rpc("Y")` both resolve through PostgREST against the
-- exposed schema, which is `public` on a default Supabase project, so `public`
-- is the only schema searched here. An object of the right name in another
-- schema is not reachable from the bridge and must not count as present.
-- ===========================================================================

\pset format aligned
\pset border 2
\pset null '∅'

\echo ''
\echo '--- route surface vs. live catalogue (schema: public) ---'

select
  w.obj_kind                                        as kind,
  w.obj_name                                        as object,
  case when coalesce(r.detail, f.detail) is null
       then 'ABSENT' else 'PRESENT' end             as status,
  coalesce(r.detail, f.detail)                      as catalogue_entry,
  w.req_roles                                       as needs_roles,
  coalesce(r.privs, f.privs)                        as service_role,
  coalesce(r.privs_auth, f.privs_auth)              as authenticated,
  w.used_by
from wanted w
left join lateral (
  select
    'pg_class oid=' || c.oid
      || ' relkind=' || c.relkind::text
      || ' owner='   || pg_get_userbyid(c.relowner)
      || ' rls='     || case when c.relrowsecurity then 'on' else 'off' end   as detail,
    coalesce(nullif(concat_ws(',',
      case when has_table_privilege('service_role', c.oid, 'SELECT') then 'SELECT' end,
      case when has_table_privilege('service_role', c.oid, 'INSERT') then 'INSERT' end,
      case when has_table_privilege('service_role', c.oid, 'UPDATE') then 'UPDATE' end,
      case when has_table_privilege('service_role', c.oid, 'DELETE') then 'DELETE' end), ''), 'NONE') as privs,
    coalesce(nullif(concat_ws(',',
      case when has_table_privilege('authenticated', c.oid, 'SELECT') then 'SELECT' end,
      case when has_table_privilege('authenticated', c.oid, 'INSERT') then 'INSERT' end,
      case when has_table_privilege('authenticated', c.oid, 'UPDATE') then 'UPDATE' end,
      case when has_table_privilege('authenticated', c.oid, 'DELETE') then 'DELETE' end), ''), 'NONE') as privs_auth
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where w.obj_kind = 'relation'
    and n.nspname = 'public'
    and c.relname = w.obj_name
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
) r on true
left join lateral (
  select
    string_agg(
      'pg_proc oid=' || p.oid
        || ' (' || pg_get_function_identity_arguments(p.oid) || ')'
        || ' returns ' || pg_get_function_result(p.oid)
        || ' ' || case p.prosecdef when true then 'SECURITY DEFINER' else 'SECURITY INVOKER' end,
      '; ' order by p.oid)                                                     as detail,
    string_agg(
      case when has_function_privilege('service_role', p.oid, 'EXECUTE')
           then 'EXECUTE' else 'NO-EXECUTE' end, ';' order by p.oid)           as privs,
    string_agg(
      case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
           then 'EXECUTE' else 'NO-EXECUTE' end, ';' order by p.oid)           as privs_auth
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where w.obj_kind = 'function'
    and n.nspname = 'public'
    and p.proname = w.obj_name
) f on true
order by w.obj_kind, w.obj_name;

-- ---------------------------------------------------------------------------
-- Machine-readable verdicts. run.sh parses these exact lines; anything it
-- cannot parse is a harness failure, not a pass.
-- ---------------------------------------------------------------------------
\pset format unaligned
\pset tuples_only on

select 'SCHEMA_COMPAT_WANTED=' || count(*) from wanted;

select 'SCHEMA_COMPAT_ABSENT=' || count(*)
from wanted w
where not exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where w.obj_kind = 'relation' and n.nspname = 'public'
          and c.relname = w.obj_name and c.relkind in ('r','p','v','m','f'))
  and not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where w.obj_kind = 'function' and n.nspname = 'public'
          and p.proname = w.obj_name);

select 'SCHEMA_COMPAT_ABSENT_NAMES=' || coalesce(string_agg(w.obj_kind || ':' || w.obj_name, ',' order by w.obj_name), '')
from wanted w
where not exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where w.obj_kind = 'relation' and n.nspname = 'public'
          and c.relname = w.obj_name and c.relkind in ('r','p','v','m','f'))
  and not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where w.obj_kind = 'function' and n.nspname = 'public'
          and p.proname = w.obj_name);

-- An object that exists but that the role the code actually connects as
-- cannot use is reachable in the catalogue and unusable at runtime. This is
-- the failure migration 0022 produces on purpose for the Vault wrappers, and
-- it is invisible to any check that only asks whether the name exists.
--
-- `req_roles` comes from the extractor's per-call-site attribution, so the
-- privilege is checked against the role that call site really uses, not
-- against service_role for everything. Call sites whose role could not be
-- attributed contribute no role here and are checked for existence only.
select 'SCHEMA_COMPAT_UNPRIVILEGED=' ||
       coalesce(string_agg(distinct w.obj_kind || ':' || w.obj_name || '[' || rr.role || ']', ','), '')
from wanted w
cross join lateral unnest(string_to_array(coalesce(nullif(w.req_roles, ''), 'service_role'), ' ')) as rr(role)
where (
    exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where w.obj_kind = 'relation' and n.nspname = 'public'
        and c.relname = w.obj_name and c.relkind in ('r','p','v','m','f')
        and not has_table_privilege(rr.role, c.oid, 'SELECT'))
    or exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where w.obj_kind = 'function' and n.nspname = 'public'
        and p.proname = w.obj_name
        and not has_function_privilege(rr.role, p.oid, 'EXECUTE'))
  );

\pset tuples_only off
\pset format aligned
