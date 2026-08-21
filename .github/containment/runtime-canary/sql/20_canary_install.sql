-- ===========================================================================
-- 20_canary_install.sql — make ANY call to a tombstoned Vault wrapper visible
--
-- WHAT THIS IS FOR
-- ----------------
-- "The frozen image never reaches `vault_create_secret` / `vault_update_secret`
-- / `vault_delete_secret`" is, as usually argued, a statement about a module
-- graph: nothing imports the helper, so nothing can call it. That is a claim
-- about the code someone searched, not about the process that ran. This file
-- replaces it with a sensor in the database itself: each of the three wrapper
-- signatures is re-created, byte-identically in its argument list and return
-- type, around a body that first appends a row to a private call log and only
-- then does what the schema's own version would have done.
--
-- After this runs, a call that arrives leaves a row. So "no row" is evidence,
-- provided the sensor is known to work — which is what 25_canary_arm.sql
-- establishes, by calling all three and requiring exactly three rows, before
-- any zero from the image under test is believed.
--
-- FIDELITY: WHAT "BEHAVES AS THE REAL VERSION WOULD" MEANS HERE
-- ------------------------------------------------------------
-- Two things have to be preserved, and they are preserved separately.
--
--  1. THE BODY. The current definition of each wrapper is cloned verbatim into
--     `nt_canary.real_<name>` before it is replaced — same body text, same
--     volatility, same SECURITY DEFINER flag, same `search_path` — and the
--     canary delegates to it. On the 0001-0008 schema that means the real
--     `vault.create_secret` work still happens (in the disposable clone, which
--     is the only database this harness ever connects to). On 0001-0023 it
--     means migration 0022's `raise ... using errcode = 'P0001'` still fires,
--     with its original message.
--
--  2. THE ACL. On 0001-0023, 0022 does not only replace the bodies; it revokes
--     EXECUTE from PUBLIC, anon, authenticated *and* service_role. So on the
--     latest schema the truthful outcome of a service-role call is `42501
--     permission denied`, reached before any body runs — and a sensor placed
--     in the body would therefore never see it. That is the exact failure mode
--     this file has to avoid, so EXECUTE is granted to everyone here and the
--     refusal is re-implemented as the first thing the body does, from a
--     snapshot of the real ACL taken immediately before the grant. The call is
--     logged, then refused with the same SQLSTATE the schema would have used.
--     An unprivileged call is now observable AND still unprivileged.
--
-- SECRET HYGIENE
-- --------------
-- The log records the LENGTH of a secret argument and never its value. A
-- canary that copied plaintext credentials into a table would be a worse
-- problem than the one it was installed to detect.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create schema if not exists nt_canary;
revoke all on schema nt_canary from public;
grant usage on schema nt_canary to public;

-- --- the log ---------------------------------------------------------------
drop table if exists nt_canary.calls;
create table nt_canary.calls (
  seq          bigserial primary key,
  at           timestamptz not null default clock_timestamp(),
  fn           text        not null,
  args         jsonb       not null,
  -- set by the recording sink for the request it is forwarding, so a row can
  -- be attributed to one matrix cell without relying on clock comparison.
  cell         text,
  session_user_name name   not null,
  current_user_name name   not null,
  role_guc     text,
  application_name  text,
  client_addr  inet,
  top_query    text
);
revoke all on table nt_canary.calls from public;
comment on table nt_canary.calls is
  'NT_CANARY_SENSOR_V1: one row per call to a public vault_* wrapper.';

-- --- the ACL snapshot, taken BEFORE anything is granted --------------------
drop table if exists nt_canary.acl;
create table nt_canary.acl (
  fn        text not null,
  role_name text not null,
  allowed   boolean not null,
  primary key (fn, role_name)
);
revoke all on table nt_canary.acl from public;

-- --- the original definitions, for the record ------------------------------
drop table if exists nt_canary.original;
create table nt_canary.original (
  fn         text primary key,
  identity   text not null,
  -- WITH defaults: `create or replace function` needs them, and refuses to
  -- drop one from an existing function.
  arguments  text not null,
  -- WITHOUT defaults: `grant`/`revoke` name a function by its identity
  -- arguments and reject a DEFAULT clause outright.
  identity_arguments text not null,
  result     text not null,
  secdef     boolean not null,
  volatility "char" not null,
  config     text[],
  body       text not null,
  def        text not null
);
revoke all on table nt_canary.original from public;

do $$
declare
  fn        record;
  wanted    text[] := array['vault_create_secret','vault_update_secret','vault_delete_secret'];
  r         text;
  n_found   int := 0;
begin
  for fn in
    select p.oid,
           p.proname,
           p.oid::regprocedure::text            as identity,
           pg_get_function_arguments(p.oid)      as arguments,
           pg_get_function_identity_arguments(p.oid) as identity_arguments,
           pg_get_function_result(p.oid)         as result,
           p.prosecdef                           as secdef,
           p.provolatile                         as volatility,
           p.proconfig                           as config,
           p.prosrc                              as body,
           pg_get_functiondef(p.oid)             as def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any (wanted)
  loop
    n_found := n_found + 1;

    insert into nt_canary.original
      (fn, identity, arguments, identity_arguments, result, secdef, volatility, config, body, def)
    values
      (fn.proname, fn.identity, fn.arguments, fn.identity_arguments, fn.result, fn.secdef,
       fn.volatility, fn.config, fn.body, fn.def);

    -- The real ACL, before the canary widens it.
    foreach r in array array['anon','authenticated','service_role','postgres','public']
    loop
      execute format(
        'insert into nt_canary.acl(fn, role_name, allowed) values (%L, %L, has_function_privilege(%L, %L, ''EXECUTE''))',
        fn.proname, r, r, fn.identity);
    end loop;

    -- The verbatim clone the canary delegates to.
    execute format(
      'create or replace function nt_canary.real_%I(%s) returns %s language plpgsql %s %s %s as %L',
      fn.proname,
      fn.arguments,
      fn.result,
      case fn.volatility when 'i' then 'immutable' when 's' then 'stable' else 'volatile' end,
      case when fn.secdef then 'security definer' else 'security invoker' end,
      case when fn.config is null then ''
           else 'set ' || replace(fn.config[1], '=', ' = ') end,
      fn.body);
  end loop;

  if n_found <> 3 then
    raise exception
      'canary install: expected all 3 vault_* wrappers in public, found % — this schema is not what the harness was pointed at',
      n_found
      using errcode = 'P0001';
  end if;
end $$;

-- --- rollback-proof hit counters -------------------------------------------
-- THE SUBTRANSACTION PROBLEM, AND WHY A TABLE ALONE IS NOT A SENSOR
--
-- On the latest schema every one of these wrappers ends in `raise` — 0022's
-- P0001, or the replayed 42501. A row inserted earlier in the same (sub)
-- transaction is rolled back with it. A canary that only inserted into a table
-- would therefore record NOTHING for exactly the calls it exists to catch, and
-- the resulting zero would look identical to a call that never happened. That
-- is the single most dangerous failure mode available to this design.
--
-- So the primary counter is a SEQUENCE. `nextval` is deliberately exempt from
-- rollback (it is why sequences have gaps), which makes it the one write in
-- PostgreSQL that survives the exception the call is about to raise. The
-- server log is a second, independent, equally non-transactional channel; the
-- table is the third and carries the detail, for the calls that do commit.
--
-- 25_canary_arm.sql proves all three by calling wrappers that raise.
drop sequence if exists nt_canary.hit_vault_create_secret;
drop sequence if exists nt_canary.hit_vault_update_secret;
drop sequence if exists nt_canary.hit_vault_delete_secret;
create sequence nt_canary.hit_vault_create_secret;
create sequence nt_canary.hit_vault_update_secret;
create sequence nt_canary.hit_vault_delete_secret;

-- --- the private recorder --------------------------------------------------
-- SECURITY DEFINER so a caller with no rights on nt_canary.* can still be
-- recorded. It is the only thing granted to PUBLIC in this schema.
create or replace function nt_canary.log_call(p_fn text, p_args jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, nt_canary
as $$
declare
  n bigint;
begin
  -- NT_CANARY_SENSOR_V1
  -- 1. the rollback-proof counter
  n := nextval('nt_canary.hit_' || p_fn);
  -- 2. the rollback-proof server-log line (LOG passes the default
  --    log_min_messages=warning, which includes LOG and above)
  raise log 'NT_CANARY_HIT fn=% n=% cell=% role=% args=%',
    p_fn, n, coalesce(current_setting('nt_canary.cell', true), '-'),
    coalesce(current_setting('role', true), '-'), p_args;
  -- 3. the detail row, for calls whose transaction commits
  insert into nt_canary.calls
    (fn, args, cell, session_user_name, current_user_name, role_guc,
     application_name, client_addr, top_query)
  values
    (p_fn, p_args,
     current_setting('nt_canary.cell', true),
     session_user, current_user,
     current_setting('role', true),
     current_setting('application_name', true),
     inet_client_addr(),
     left(current_query(), 500));
end $$;
grant execute on function nt_canary.log_call(text, jsonb) to public;

-- The reader every verdict uses: total hits, immune to rollback.
-- `pg_sequence_last_value` returns NULL for a sequence that has never been
-- advanced, which is the only difference between "zero calls" and "one call".
create or replace function nt_canary.hits()
returns table (fn text, hits bigint)
language sql
volatile
security definer
set search_path = pg_catalog, nt_canary
as $$
  select f.fn,
         coalesce(pg_catalog.pg_sequence_last_value(('nt_canary.hit_' || f.fn)::regclass), 0)::bigint
    from (values ('vault_create_secret'), ('vault_update_secret'), ('vault_delete_secret')) as f(fn);
$$;
grant execute on function nt_canary.hits() to public;

-- --- the replayed ACL ------------------------------------------------------
create or replace function nt_canary.acl_allows(p_fn text, p_role text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, nt_canary
as $$
  select coalesce(
           (select allowed from nt_canary.acl where fn = p_fn and role_name = p_role),
           -- A role the snapshot does not name (the connection role of a
           -- harness psql session, say) is treated as allowed: the snapshot
           -- covers exactly the roles a request can arrive as, and refusing an
           -- unknown role would break the arming probe rather than the image.
           true);
$$;
grant execute on function nt_canary.acl_allows(text, text) to public;

-- --- who is really calling -------------------------------------------------
-- Inside a SECURITY DEFINER function `current_user` is the owner, so it cannot
-- answer "who called". PostgREST issues `set local role <role>` per request and
-- that GUC survives the definer switch, so it is the caller's own claim about
-- itself and the right thing to replay the ACL against. `session_user` is the
-- fallback for a direct connection that never set a role.
create or replace function nt_canary.effective_caller()
returns text
language sql
stable
as $$
  select coalesce(nullif(current_setting('role', true), 'none'), session_user::text);
$$;
grant execute on function nt_canary.effective_caller() to public;

-- --- the three canaries ----------------------------------------------------
-- Built from `nt_canary.original` so the argument list and return type are the
-- schema's own, character for character. The bodies address parameters
-- positionally ($1, $2) so they do not depend on parameter NAMES either.
do $$
declare
  o        record;
  arg_json text;
  guard    text;
  delegate text;
begin
  for o in select * from nt_canary.original order by fn loop
    arg_json := case o.fn
      when 'vault_create_secret' then
        'jsonb_build_object(''p_secret_length'', length($1), ''p_name'', $2)'
      when 'vault_update_secret' then
        'jsonb_build_object(''p_id'', $1, ''p_secret_length'', length($2))'
      when 'vault_delete_secret' then
        'jsonb_build_object(''p_id'', $1)'
    end;

    guard := format(
      $g$
      if not nt_canary.acl_allows(%L, nt_canary.effective_caller()) then
        raise exception 'permission denied for function %s'
          using errcode = '42501';
      end if;
      $g$, o.fn, o.fn);

    if o.result = 'void' then
      delegate := format('perform nt_canary.real_%I(%s);', o.fn,
                         case o.fn when 'vault_delete_secret' then '$1' else '$1, $2' end);
    else
      delegate := format('return nt_canary.real_%I(%s);', o.fn,
                         case o.fn when 'vault_delete_secret' then '$1' else '$1, $2' end);
    end if;

    execute format(
      $fn$
      create or replace function public.%I(%s)
      returns %s
      language plpgsql
      volatile
      security definer
      set search_path = pg_catalog, public, vault, nt_canary
      as $body$
      begin
        -- NT_CANARY_SENSOR_V1 — remove this and 25_canary_arm.sql fails.
        perform nt_canary.log_call(%L, %s);
        %s
        %s
      end
      $body$;
      $fn$,
      o.fn, o.arguments, o.result,
      o.fn, arg_json,
      guard,
      delegate);

    -- Widened on purpose: see the ACL note at the top. The refusal now lives
    -- in the body, one statement after the sensor.
    execute format('grant execute on function public.%I(%s) to public, anon, authenticated, service_role',
                   o.fn, o.identity_arguments);
  end loop;
end $$;

-- --- arming assertion ------------------------------------------------------
create or replace function nt_canary.assert_armed()
returns text
language plpgsql
as $$
declare
  n_marked int;
  n_real   int;
  i        int;
begin
  select count(*) into n_marked
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('vault_create_secret','vault_update_secret','vault_delete_secret')
     and p.prosrc like '%NT_CANARY_SENSOR_V1%';
  select count(*) into n_real
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'nt_canary' and p.proname like 'real\_%';

  if n_marked <> 3 then
    raise exception 'CANARY_SENSOR_DEAD: only % of 3 public wrappers carry the sensor marker', n_marked
      using errcode = 'P0001';
  end if;
  if n_real <> 3 then
    raise exception 'CANARY_SENSOR_DEAD: only % of 3 delegate clones exist', n_real
      using errcode = 'P0001';
  end if;
  if to_regclass('nt_canary.calls') is null then
    raise exception 'CANARY_SENSOR_DEAD: the call log table is gone'
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'nt_canary' and p.proname = 'log_call'
                    and p.prosrc like '%insert into nt_canary.calls%') then
    raise exception 'CANARY_SENSOR_DEAD: log_call no longer writes to the call log'
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'nt_canary' and p.proname = 'log_call'
                    and p.prosrc like '%nextval(%') then
    raise exception 'CANARY_SENSOR_DEAD: log_call no longer advances the rollback-proof counter'
      using errcode = 'P0001';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'nt_canary' and p.proname = 'log_call'
                    and p.prosrc like '%NT_CANARY_HIT%') then
    raise exception 'CANARY_SENSOR_DEAD: log_call no longer writes the server-log line'
      using errcode = 'P0001';
  end if;
  for i in 1..3 loop
    if to_regclass((array['nt_canary.hit_vault_create_secret',
                          'nt_canary.hit_vault_update_secret',
                          'nt_canary.hit_vault_delete_secret'])[i]) is null then
      raise exception 'CANARY_SENSOR_DEAD: hit counter % is gone',
        (array['vault_create_secret','vault_update_secret','vault_delete_secret'])[i]
        using errcode = 'P0001';
    end if;
  end loop;
  return 'armed';
end $$;

-- `assert_armed()` is retained as a cheap structural smoke test of the install
-- itself. It is NOT the arming evidence: it is a catalogue-shape check that a
-- comment can satisfy, and a sabotage which kept the marker, kept the delegate
-- and deleted the one `perform nt_canary.log_call(...)` statement passed it
-- while the sensor was provably dead. The arming evidence is
-- `sensor/verify-sensor.sh`, which compares complete normalised definitions
-- and fires every wrapper under an unpredictable per-run nonce, before, during
-- and after the matrix.
select 'CANARY_INSTALL=' || nt_canary.assert_armed() as verdict;
select 'CANARY_ACL_SNAPSHOT=' ||
       coalesce(string_agg(fn || ':' || role_name || '=' || allowed::text, ',' order by fn, role_name), '(none)')
  from nt_canary.acl;

-- CANARY_TOMBSTONED IS NO LONGER PRINTED HERE.
--
-- It used to be `prosrc like '%superseded and must not be called%'` — a
-- substring test, printed into the transcript and asserted on by nothing. It
-- was wrong in both directions: a genuine tombstone whose message had been
-- reworded read "live", and a live routine whose body merely mentioned the
-- phrase read "raises-P0001". Decoration that looks like a check is worse than
-- no check, because a reader counts it.
--
-- The tombstone classification now comes from the project's real classifier,
-- `.github/containment/catalogue-classify.sql`, via `tombstone-binding.sh`,
-- which requires that classifier to report PASS and each of the three wrappers
-- to be in the state the schema demands. run.sh fails the run when it does not.
