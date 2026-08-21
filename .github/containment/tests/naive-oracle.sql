-- ============================================================================
-- naive-oracle.sql — the classifier this exercise exists to replace.
--
-- THIS FILE IS A STRAW MAN. It is never used by the gate. It exists only so
-- the mutation suite can prove, by execution rather than by assertion, that
-- reverting to name-only / grep / bare-42501 logic turns the suite RED.
--
-- It is faithful to what the previous schema-compat harness actually did:
--
--   * find the routine by BARE NAME in pg_proc (no argument types, no
--     regprocedure, no overload check, no schema-shadow check);
--   * call it once as service_role;
--   * SQLSTATE 42501 -> "it is the intentional 0022 tombstone";
--   * anything else  -> "it is live and reachable";
--   * no row of that name -> MISSING.
--
-- It reads nothing else: not the owner, not the language, not the security
-- mode, not the volatility, not the search_path, not the body, not the ACL,
-- not the default privileges, and it has no expectation to compare against, so
-- it cannot tell a 0008 schema from a 0023 one.
--
-- It emits the same sentinel contract as catalogue-classify.sql so
-- catalogue-classify.sh can drive it unchanged.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off

create temporary table no_result(
  key       text primary key,
  present   boolean,
  sqlstate  text,
  message   text,
  final     text
);

do $no$
declare
  r    record;
  st   text;
  msg  text;
begin
  for r in
    select * from (values
      ('vault_create_secret',
       $q$select public.vault_create_secret('CC-PROBE-NOT-A-CREDENTIAL','naive-'||md5(random()::text))$q$),
      ('vault_update_secret',
       $q$select public.vault_update_secret('00000000-0000-0000-0000-000000000000'::uuid,'CC-PROBE-NOT-A-CREDENTIAL')$q$),
      ('vault_delete_secret',
       $q$select public.vault_delete_secret('00000000-0000-0000-0000-000000000000'::uuid)$q$),
      ('owns_account',
       $q$select public.owns_account('22222222-2222-4222-8222-222222222222'::uuid)$q$)
    ) v(key, stmt)
  loop
    -- name-only lookup: exactly the grep this exercise is replacing
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = r.key
    ) then
      insert into no_result values (r.key, false, null, null, 'MISSING');
      continue;
    end if;

    st := null; msg := null;
    begin
      set role service_role;
      execute r.stmt;
      st := '00000'; msg := 'call completed';
    exception when others then
      get stacked diagnostics st = returned_sqlstate, msg = message_text;
    end;
    reset role;

    insert into no_result values (
      r.key, true, st, msg,
      case when st = '42501' then 'INTENTIONALLY_TOMBSTONED' else 'LIVE' end);
  end loop;
  reset role;
end
$no$;

\pset format aligned
\pset tuples_only off
\echo ''
\echo '--- NAME-ONLY ORACLE (straw man; not the gate) --------------------------'
select key, present, sqlstate, final from no_result order by key;

\pset format unaligned
\pset tuples_only on

select 'CATALOGUE_CLASSIFY_OBJECT=' || key || '|NAME_ONLY_ORACLE|' || final
       || '|' || final || '|'
  from no_result order by key;

select 'CATALOGUE_CLASSIFY_RESULT=' ||
  case when exists (select 1 from no_result
                     where final not in ('LIVE','INTENTIONALLY_TOMBSTONED'))
       then 'FAIL' else 'PASS' end;

select 'CATALOGUE_CLASSIFY_JSON=' || jsonb_build_object(
  'gate',    'name-only straw man; never the gate',
  -- DECLARED, not silently omitted. The driver refuses a classifier that says
  -- nothing about its counter-scan, because a build that dropped its
  -- schema_scan block would otherwise be indistinguishable from one that never
  -- had a counter-scan. This straw man models the OLD harness, which performed
  -- no whole-schema counter-scan at all, so it declares false and the driver
  -- labels every run of it NOT A CERTIFICATION. Emitting an empty `kinds` array
  -- instead would be the "an absent counter-scan reads as a clean counter-scan"
  -- failure the driver check exists to prevent.
  'counter_scan_declared', false,
  'objects', (select jsonb_agg(jsonb_build_object(
                'key', key, 'expected', 'NAME_ONLY_ORACLE',
                'observed', final, 'final', final,
                'reasons', '[]'::jsonb,
                'probe', jsonb_build_object('sqlstate', sqlstate, 'message', message),
                'tomb_applicable', null)
                order by key) from no_result),
  'result',  case when exists (select 1 from no_result
                                where final not in ('LIVE','INTENTIONALLY_TOMBSTONED'))
                  then 'FAIL' else 'PASS' end
)::text;
