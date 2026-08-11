-- ============================================================================
-- 0015_sequence_and_function_acl.sql — close the two ACL classes 0012 missed
--
-- 0012 fixed tables and views. Supabase's initial schema grants defaults for
-- three object classes, not one:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON TABLES    TO postgres, anon, authenticated, service_role;
--     GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
--     GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
--
-- so two holes remained:
--
--   * **Sequences.** Every identity column's sequence arrived with USAGE,
--     SELECT and UPDATE for `anon` and `authenticated`. That is `nextval()`
--     and `setval()` — a client could burn identifiers or move a sequence
--     backwards so the next server insert collides with an existing row. RLS
--     does not apply to sequences at all.
--
--   * **Functions.** PostgreSQL grants EXECUTE to `PUBLIC` by default for
--     every new function, *and* Supabase's default adds `anon` and
--     `authenticated` explicitly. 0012 narrowed only the table defaults and
--     only for those two roles, so the next function created in `public`
--     would still be world-executable through PostgREST's `/rpc/` surface.
--
-- This migration revokes both classes, restores exactly the audited whitelist,
-- and narrows the defaults — including for `PUBLIC`, which 0012 did not touch.
--
-- 0012, 0013 and 0014 are not edited. This is append-only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Sequences: no client role may allocate or move an identifier.
--
-- `service_role` keeps USAGE and SELECT because every insert the server makes
-- into an identity column needs `nextval()`. It does not need UPDATE, which is
-- `setval()` — nothing in this system legitimately rewinds a sequence.
-- ---------------------------------------------------------------------------
do $$
declare
  seq record;
begin
  for seq in
    select schemaname, sequencename
      from pg_sequences
     where schemaname = 'public'
  loop
    execute format(
      'revoke all on sequence %I.%I from public, anon, authenticated',
      seq.schemaname, seq.sequencename
    );
    execute format(
      'grant usage, select on sequence %I.%I to service_role',
      seq.schemaname, seq.sequencename
    );
  end loop;
end $$;

alter default privileges in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public
  grant usage, select on sequences to service_role;

-- ---------------------------------------------------------------------------
-- 2. Functions: revoke everything, then restore the audited whitelist.
--
-- Sweeping first and re-granting second is the only way to be sure: a
-- per-function revoke list silently misses anything added since it was
-- written, which is precisely how the previous migrations drifted.
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
       and p.prokind in ('f', 'p')
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      fn.signature
    );
  end loop;
end $$;

-- --- the whitelist ----------------------------------------------------------
--
-- Client roles get EXECUTE on exactly the helpers RLS needs to evaluate a
-- policy on their behalf, and nothing else. Each entry is here because a
-- policy or trigger calls it in the caller's own context:
--
--   owns_account(uuid)   — the row filter on every account-scoped table.
--   is_service_role()    — the accounts guard trigger, SECURITY INVOKER, so it
--                          executes as the caller.
--   jwt_role()           — read by the guard above.
--
-- `anon` gets the two guard helpers (a trigger may fire for it and must be
-- able to refuse it) but never `owns_account`, which 0007 already withheld.
grant execute on function owns_account(uuid)  to authenticated, service_role;
grant execute on function is_service_role()   to anon, authenticated, service_role;
grant execute on function jwt_role()          to anon, authenticated, service_role;

-- Everything the server calls, restored to the service role only.
grant execute on function get_account_credentials(uuid)            to service_role;
grant execute on function vault_create_secret(text, text)          to service_role;
grant execute on function vault_update_secret(uuid, text)          to service_role;
grant execute on function vault_delete_secret(uuid)                to service_role;
grant execute on function rotate_account_credentials(uuid, uuid, text, text, text)
  to service_role;
grant execute on function delete_account_atomic(uuid, uuid, boolean) to service_role;
grant execute on function account_history_snapshot(uuid, uuid, date) to service_role;
grant execute on function reconcile_cash_flow_mirror(uuid, uuid, date, jsonb)
  to service_role;
grant execute on function replace_equity_snapshots(uuid, uuid, jsonb) to service_role;
grant execute on function account_history_row_limit()              to service_role;
grant execute on function create_account_atomic(uuid, text, account_mode, text, uuid, uuid, text)
  to service_role;
grant execute on function update_account_metadata(uuid, uuid, text, text, boolean)
  to service_role;

-- Trigger functions are invoked by the trigger, never called directly, so no
-- role needs EXECUTE on them. They are deliberately absent from the whitelist:
--   handle_new_user(), touch_updated_at(), accounts_guard_server_managed()

-- ---------------------------------------------------------------------------
-- 3. Defaults for future functions.
--
-- `anon` and `authenticated` are removed from the stored default, and the
-- table default from 0012 is restated against PUBLIC as well.
-- ---------------------------------------------------------------------------
alter default privileges in schema public
  revoke all on functions from public, anon, authenticated;
alter default privileges in schema public
  grant execute on functions to service_role;

alter default privileges in schema public
  revoke all on tables from public;

-- ---------------------------------------------------------------------------
-- 3b. PUBLIC's built-in EXECUTE default — which the statement above cannot fix.
--
-- PostgreSQL grants `EXECUTE` on every new function to `PUBLIC` as a *built-in*
-- default, and `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM
-- PUBLIC` does not remove it. Verified directly against PostgreSQL 16:
--
--   alter default privileges in schema t1 revoke execute on functions from public;
--   -- pg_default_acl: 0 rows          (an empty ACL is not stored)
--   create function t1.p() ...;
--   -- pg_proc.proacl: null            (i.e. the built-in default: EXECUTE to PUBLIC)
--
-- and with a non-empty stored default the built-in survives the merge:
--
--   -- pg_default_acl: {service_role=X/postgres}
--   -- pg_proc.proacl: {=X/postgres, postgres=X/postgres, service_role=X/postgres}
--                       ^^^^^^^^^^^^ PUBLIC, still there
--
-- A stored default ACL is merged *over* the built-in one, so it can add
-- grantees but never remove PUBLIC. The only mechanism that closes this for
-- objects that do not exist yet is an event trigger.
--
-- Consequence for future migrations: `create function` in `public` arrives
-- with no client privileges at all, so any new RPC must grant explicitly.
-- `create or replace` also strips grants, which is why every function in this
-- migration is granted after it is defined.
-- ---------------------------------------------------------------------------
create or replace function lock_new_public_functions()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_ddl_commands() loop
    if obj.schema_name = 'public'
       and obj.object_type in ('function', 'procedure') then
      execute format(
        'revoke all on function %s from public, anon, authenticated',
        obj.object_identity
      );
    end if;
  end loop;
end;
$$;

revoke all on function lock_new_public_functions() from public, anon, authenticated;

do $$ begin
  if exists (
    select 1 from pg_event_trigger where evtname = 'lock_new_public_functions_trg'
  ) then
    drop event trigger lock_new_public_functions_trg;
  end if;
  create event trigger lock_new_public_functions_trg
    on ddl_command_end
    when tag in ('CREATE FUNCTION', 'CREATE PROCEDURE')
    execute function lock_new_public_functions();
exception
  -- Creating an event trigger needs superuser. If the migration runs as a role
  -- without it, say so loudly rather than pretending the control is in place:
  -- the sweep above still locked every function that exists *today*, but a
  -- function added later would be world-executable until a migration revokes it.
  when insufficient_privilege then
    raise warning
      'lock_new_public_functions_trg was NOT created (insufficient privilege). '
      'Functions created after this migration will inherit EXECUTE for PUBLIC '
      'until explicitly revoked. Re-run this migration as a superuser.';
end $$;

-- ---------------------------------------------------------------------------
-- 4. Fail the migration unless the catalogue agrees.
-- ---------------------------------------------------------------------------
do $$
declare
  fn       record;
  role_    text;
  problems text[] := '{}';
  allowed  text[] := array[
    'owns_account(uuid)',
    'is_service_role()',
    'jwt_role()'
  ];
begin
  -- No sequence is reachable by a client role.
  for fn in select schemaname, sequencename from pg_sequences where schemaname = 'public'
  loop
    foreach role_ in array array['anon', 'authenticated'] loop
      if has_sequence_privilege(
           role_, format('%I.%I', fn.schemaname, fn.sequencename), 'USAGE')
         or has_sequence_privilege(
           role_, format('%I.%I', fn.schemaname, fn.sequencename), 'UPDATE')
         or has_sequence_privilege(
           role_, format('%I.%I', fn.schemaname, fn.sequencename), 'SELECT')
      then
        problems := problems
          || format('%s can reach sequence %s', role_, fn.sequencename);
      end if;
    end loop;
    if not has_sequence_privilege(
         'service_role', format('%I.%I', fn.schemaname, fn.sequencename), 'USAGE')
    then
      problems := problems
        || format('service_role lost USAGE on sequence %s', fn.sequencename);
    end if;
  end loop;

  -- Only the whitelisted helpers are client-executable.
  for fn in
    select p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f', 'p')
  loop
    foreach role_ in array array['anon', 'authenticated'] loop
      if has_function_privilege(role_, fn.signature, 'EXECUTE')
         and not (fn.signature = any (allowed))
      then
        problems := problems || format('%s can execute %s', role_, fn.signature);
      end if;
    end loop;
  end loop;

  -- `owns_account` stays out of anon's reach, as 0007 intended.
  if has_function_privilege('anon', 'owns_account(uuid)', 'EXECUTE') then
    problems := problems || 'anon can execute owns_account(uuid)';
  end if;

  -- The server keeps everything it needs.
  if not has_function_privilege('service_role', 'get_account_credentials(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'account_history_snapshot(uuid,uuid,date)', 'EXECUTE')
     or not has_function_privilege('service_role', 'rotate_account_credentials(uuid,uuid,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'delete_account_atomic(uuid,uuid,boolean)', 'EXECUTE')
  then
    problems := problems || 'service_role lost a function it needs';
  end if;

  if array_length(problems, 1) is not null then
    raise exception 'function/sequence lockdown failed: %',
      array_to_string(problems, '; ');
  end if;
end $$;
