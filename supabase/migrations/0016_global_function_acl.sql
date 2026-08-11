-- ============================================================================
-- 0016_global_function_acl.sql — replace 0015's event trigger with the
-- mechanism that actually works
--
-- 0015 concluded that `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS
-- FROM PUBLIC` cannot suppress PostgreSQL's built-in default, and installed an
-- event trigger instead. Both halves of that were wrong, and the trigger is
-- actively harmful. All four findings below were reproduced on PostgreSQL 16
-- before this migration was written.
--
-- **1. The trigger aborts `CREATE PROCEDURE`.**
--
--     create procedure pp() language sql as 'select 1';
--     ERROR:  public.pp() is not a function
--     CONTEXT: SQL statement "revoke all on function public.pp() from ..."
--
--   `REVOKE ... ON FUNCTION` refuses a procedure — the spelling is `ON
--   PROCEDURE` or `ON ROUTINE`. Because the trigger runs at `ddl_command_end`
--   inside the same transaction, its failure rolls the `CREATE` back. Any
--   future migration adding a procedure would simply fail, with an error
--   pointing at a security helper rather than at itself.
--
-- **2. The trigger never sees `CREATE AGGREGATE`.**
--
--   It fires on the `CREATE FUNCTION` / `CREATE PROCEDURE` tags only, so an
--   aggregate — which is a `pg_proc` row reachable through PostgREST like any
--   other — kept the built-in PUBLIC grant:
--
--     create aggregate pagg(int) (sfunc=int4pl, stype=int);
--     select has_function_privilege('anon','pagg(int)','EXECUTE');  -- t
--
-- **3. The *global* form of ALTER DEFAULT PRIVILEGES does work.**
--
--   0015 tested only the schema-scoped form. Without `IN SCHEMA` the row is
--   stored and the built-in default is replaced rather than merged into:
--
--     alter default privileges revoke execute on functions from public;
--     -- pg_default_acl: one row, namespace 0, {postgres=X/postgres}
--     create function g1() ...;  create procedure g2() ...;
--     create aggregate g3(int) (sfunc=int4pl, stype=int);
--     -- every one: proacl {postgres=X/postgres}; anon/authenticated/PUBLIC f
--
--   One statement, all three routine kinds, no trigger.
--
-- **4. `CREATE OR REPLACE` does not strip grants.**
--
--   0015's comment said it did. It does not — PostgreSQL preserves the ACL of
--   an existing function. The stripping that was observed came from the
--   trigger itself, which fires on the `CREATE FUNCTION` tag that
--   `CREATE OR REPLACE FUNCTION` also emits. With the trigger gone, a replaced
--   function keeps its grants.
--
-- 0015 is not edited. This migration drops its trigger and installs the global
-- default instead, then asserts the outcome and **fails** if the catalogue
-- disagrees — no warning-only security invariant.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remove the event trigger.
--
-- Dropping it is safe precisely because step 2 covers strictly more: every
-- routine kind, without running any code at DDL time.
-- ---------------------------------------------------------------------------
drop event trigger if exists lock_new_public_functions_trg;
drop function if exists lock_new_public_functions();

-- ---------------------------------------------------------------------------
-- 2. The global default: no `IN SCHEMA`.
--
-- This applies to every schema, for objects created by the role running it.
-- That is the intent: a routine created in *any* schema by the migration owner
-- should not be world-executable by default.
--
-- Consequence to know about: an extension installed later by this same role
-- gets owner-only functions, so anything its client-facing helpers need must
-- be granted deliberately. That is the correct default for this project —
-- nothing here relies on PUBLIC being able to execute an extension function.
-- ---------------------------------------------------------------------------
alter default privileges revoke execute on functions from public;
alter default privileges revoke execute on functions from anon, authenticated;
alter default privileges grant execute on functions to service_role;

-- Keep 0015's schema-scoped statements in force as well; they are harmless and
-- they narrow the same thing for this schema.
alter default privileges in schema public
  revoke all on functions from public, anon, authenticated;
alter default privileges in schema public
  grant execute on functions to service_role;

-- ---------------------------------------------------------------------------
-- 3. Sweep every existing routine, this time with the spelling that covers
--    functions, procedures *and* aggregates.
--
-- `ON ROUTINE` is the umbrella form. The whitelist is then restored exactly as
-- 0015 defined it — RLS helpers for the client roles, everything else for the
-- service role only.
-- ---------------------------------------------------------------------------
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format(
      'revoke all on routine %s from public, anon, authenticated',
      fn.signature
    );
  end loop;
end $$;

grant execute on function owns_account(uuid)  to authenticated, service_role;
grant execute on function is_service_role()   to anon, authenticated, service_role;
grant execute on function jwt_role()          to anon, authenticated, service_role;

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'get_account_credentials', 'vault_create_secret', 'vault_update_secret',
         'vault_delete_secret', 'rotate_account_credentials',
         'delete_account_atomic', 'account_history_snapshot',
         'reconcile_cash_flow_mirror', 'replace_equity_snapshots',
         'account_history_row_limit', 'create_account_atomic',
         'update_account_metadata'
       )
  loop
    execute format('grant execute on routine %s to service_role', fn.signature);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Assert the outcome, and fail if it is wrong.
--
-- Including a live probe: a routine of each kind is created inside this
-- migration, checked, and dropped. Asserting the stored default ACL would only
-- test the intent — 0015 did exactly that and shipped a control that did
-- nothing. The only evidence that a rule governs future objects is to create
-- one and look at it.
-- ---------------------------------------------------------------------------
do $$
declare
  role_    text;
  problems text[] := '{}';
  allowed  text[] := array[
    'owns_account(uuid)',
    'is_service_role()',
    'jwt_role()'
  ];
  fn       record;
begin
  -- 4a. Existing routines: only the whitelist is client-executable.
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    foreach role_ in array array['anon', 'authenticated'] loop
      if has_function_privilege(role_, fn.signature, 'EXECUTE')
         and not (fn.signature = any (allowed)) then
        problems := problems || format('%s can execute %s', role_, fn.signature);
      end if;
    end loop;
  end loop;
  if has_function_privilege('anon', 'owns_account(uuid)', 'EXECUTE') then
    problems := problems || 'anon can execute owns_account(uuid)';
  end if;

  -- 4b. Live probes, one per routine kind. A procedure is included precisely
  -- because 0015's trigger made creating one impossible.
  create function acl_probe_function() returns int language sql immutable as 'select 1';
  create procedure acl_probe_procedure() language sql as 'select 1';
  create aggregate acl_probe_aggregate(int) (sfunc = int4pl, stype = int);

  foreach role_ in array array['anon', 'authenticated'] loop
    if has_function_privilege(role_, 'acl_probe_function()', 'EXECUTE') then
      problems := problems || format('%s can execute a new function', role_);
    end if;
    if has_function_privilege(role_, 'acl_probe_procedure()', 'EXECUTE') then
      problems := problems || format('%s can execute a new procedure', role_);
    end if;
    if has_function_privilege(role_, 'acl_probe_aggregate(int)', 'EXECUTE') then
      problems := problems || format('%s can execute a new aggregate', role_);
    end if;
  end loop;

  -- PUBLIC itself, which is the grantee the built-in default targets.
  if (select 'acl_probe_function()'::regprocedure::oid) is not null
     and exists (
       select 1
         from pg_proc p
        where p.oid = 'acl_probe_function()'::regprocedure
          and p.proacl::text like '%=X/%'
          and p.proacl::text like '%{=X/%'
     ) then
    problems := problems || 'PUBLIC can execute a new function';
  end if;

  -- The service role must keep working through the same default.
  if not has_function_privilege('service_role', 'acl_probe_function()', 'EXECUTE') then
    problems := problems || 'service_role cannot execute a new function';
  end if;

  -- A replaced function keeps its grants; nothing here should strip them.
  grant execute on function acl_probe_function() to authenticated;
  create or replace function acl_probe_function() returns int language sql immutable as 'select 2';
  if not has_function_privilege('authenticated', 'acl_probe_function()', 'EXECUTE') then
    problems := problems || 'CREATE OR REPLACE stripped an explicit grant';
  end if;

  drop function acl_probe_function();
  drop procedure acl_probe_procedure();
  drop aggregate acl_probe_aggregate(int);

  -- 4c. The server keeps everything it needs.
  if not has_function_privilege('service_role', 'get_account_credentials(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'account_history_snapshot(uuid,uuid,date)', 'EXECUTE')
     or not has_function_privilege('service_role', 'rotate_account_credentials(uuid,uuid,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'delete_account_atomic(uuid,uuid,boolean)', 'EXECUTE')
     or not has_function_privilege('service_role', 'create_account_atomic(uuid,text,account_mode,text,uuid,uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'update_account_metadata(uuid,uuid,text,text,boolean)', 'EXECUTE')
  then
    problems := problems || 'service_role lost a routine it needs';
  end if;

  -- 4d. The event trigger really is gone.
  if exists (select 1 from pg_event_trigger where evtname = 'lock_new_public_functions_trg') then
    problems := problems || 'the lock_new_public_functions event trigger still exists';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'routine ACL lockdown failed: %', array_to_string(problems, '; ');
  end if;
end $$;
