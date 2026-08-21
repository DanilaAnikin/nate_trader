-- ===========================================================================
-- 50_sensor_dump.sql — the COMPLETE catalogue record of every sensor object
--
-- WHY A DUMP AND NOT A MARKER
-- ---------------------------
-- The arming check this replaces asked one question: does the wrapper's
-- `prosrc` contain the string `NT_CANARY_SENSOR_V1`? A comment satisfies that.
-- The sabotage that defeated the whole suite kept the comment, kept the
-- delegate, left `nt_canary.log_call` untouched and deleted one statement —
-- and every check in the harness still called the sensor "armed".
--
-- So nothing here looks for a substring. This file emits the ENTIRE normalised
-- definition of every object the sensor is made of, plus the catalogue
-- properties that a definition does not carry — owner, ACL, volatility,
-- strictness, leakproofness, set-returning-ness, language, config, argument
-- types, and how many overloads and cross-schema shadows the name has. The
-- trusted runner compares the whole thing, byte for byte, against what it
-- recorded at install time and against a digest pinned in the trusted
-- checkout. Any edit at all — including one that preserves every marker — is a
-- difference.
--
-- The object set is discovered, not listed: every routine in `nt_canary`, and
-- every routine in `public` whose name begins `vault_`. That is what makes
-- "alter an overload rather than the named function" visible: a second
-- `public.vault_delete_secret(text)` is a new line in this dump.
--
-- Output is one `SENSOR_OBJ=` line per object and one `SENSOR_REL=` line per
-- table/sequence, both sorted, so the comparison is a plain text diff.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset footer off

-- Whitespace is the only thing normalised. Nothing else is: a renamed
-- variable, a reordered statement or a changed literal must all show up.
create or replace function pg_temp.nts_norm(text) returns text
language sql immutable as $fn$
  select coalesce(btrim(regexp_replace($1, '\s+', ' ', 'g')), '')
$fn$;

select 'SENSOR_OBJ=' || line from (
  select
    p.pronamespace::regnamespace::text
    || '|' || p.proname
    || '|args='     || pg_catalog.pg_get_function_identity_arguments(p.oid)
    || '|argtypes=' || coalesce(
         (select string_agg(t::regtype::text, ',' order by ord)
            from unnest(p.proargtypes::oid[]) with ordinality as u(t, ord)), '')
    || '|allargtypes=' || coalesce(
         (select string_agg(t::regtype::text, ',' order by ord)
            from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as u(t, ord)), '')
    || '|argmodes=' || coalesce(array_to_string(p.proargmodes, ','), '')
    || '|argnames=' || coalesce(array_to_string(p.proargnames, ','), '')
    || '|nargs='    || p.pronargs::text
    || '|ndefaults='|| p.pronargdefaults::text
    || '|ret='      || pg_catalog.pg_get_function_result(p.oid)
    || '|kind='     || p.prokind::text
    || '|lang='     || l.lanname::text
    || '|secdef='   || p.prosecdef::text
    || '|volatile=' || p.provolatile::text
    || '|strict='   || p.proisstrict::text
    || '|leakproof='|| p.proleakproof::text
    || '|retset='   || p.proretset::text
    || '|parallel=' || p.proparallel::text
    || '|owner='    || pg_catalog.pg_get_userbyid(p.proowner)::text
    || '|config='   || coalesce(array_to_string(p.proconfig, ';'), '')
    || '|acl='      || coalesce(
         (select string_agg(
                   (case when a.grantee = 0 then 'PUBLIC'
                         else pg_catalog.pg_get_userbyid(a.grantee) end)
                   || ':' || a.privilege_type
                   || ':' || a.is_grantable::text,
                   ',' order by (case when a.grantee = 0 then 'PUBLIC'
                                      else pg_catalog.pg_get_userbyid(a.grantee) end) collate "C",
                                a.privilege_type collate "C")
            from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a), '')
    || '|overloads=' || (select count(*)::text from pg_proc p2
                          where p2.pronamespace = p.pronamespace and p2.proname = p.proname)
    || '|shadows='   || (select count(*)::text from pg_proc p3
                          where p3.pronamespace <> p.pronamespace and p3.proname = p.proname)
    || '|def='       || pg_temp.nts_norm(pg_catalog.pg_get_functiondef(p.oid))
    as line
  from pg_proc p
  join pg_language l on l.oid = p.prolang
  where p.pronamespace = 'nt_canary'::regnamespace
     or (p.pronamespace = 'public'::regnamespace and p.proname like 'vault\_%')
) s order by line collate "C";

select 'SENSOR_REL=' || line from (
  select
    c.relnamespace::regnamespace::text
    || '|' || c.relname
    || '|kind='   || c.relkind::text
    || '|owner='  || pg_catalog.pg_get_userbyid(c.relowner)::text
    || '|persist='|| c.relpersistence::text
    || '|acl='    || coalesce(
         (select string_agg(
                   (case when a.grantee = 0 then 'PUBLIC'
                         else pg_catalog.pg_get_userbyid(a.grantee) end)
                   || ':' || a.privilege_type,
                   ',' order by (case when a.grantee = 0 then 'PUBLIC'
                                      else pg_catalog.pg_get_userbyid(a.grantee) end) collate "C",
                                a.privilege_type collate "C")
            from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a), '')
    || '|cols='   || coalesce(
         (select string_agg(att.attname || ' ' || att.atttypid::regtype::text || ' ' || att.attnotnull::text,
                            ',' order by att.attnum)
            from pg_attribute att
           where att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped), '')
    as line
  from pg_class c
  where c.relnamespace = 'nt_canary'::regnamespace
) s order by line collate "C";

-- The schema itself: an ACL that let a client role create objects in nt_canary
-- would be a way to shadow the sensor without touching any object in it.
select 'SENSOR_NSP=' || n.nspname::text
       || '|owner=' || pg_catalog.pg_get_userbyid(n.nspowner)::text
       || '|acl='   || coalesce(
            (select string_agg(
                      (case when a.grantee = 0 then 'PUBLIC'
                            else pg_catalog.pg_get_userbyid(a.grantee) end)
                      || ':' || a.privilege_type,
                      ',' order by (case when a.grantee = 0 then 'PUBLIC'
                                         else pg_catalog.pg_get_userbyid(a.grantee) end) collate "C",
                                   a.privilege_type collate "C")
               from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a), '')
  from pg_namespace n where n.nspname = 'nt_canary';
