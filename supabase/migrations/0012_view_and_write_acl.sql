-- ============================================================================
-- 0012_view_and_write_acl.sql — fix the privileges 0011 assumed it had removed
--
-- 0011 wrote `revoke all on accounts_safe from public` and then granted SELECT
-- to `authenticated`. On a real Supabase project that is not enough. Supabase's
-- initial schema sets
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
--
-- so every table and view created afterwards arrives with SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER already granted *directly*
-- to `anon` and `authenticated`. Revoking from `public` does not touch a direct
-- role grant, so all three `*_safe` views shipped DML-capable.
--
-- That was exploitable. `accounts_safe` selects from a single table with no
-- aggregate, so PostgreSQL makes it automatically updatable, and a view runs
-- with its owner's privileges. Verified against a real server before this fix:
--
--   set local role authenticated;
--   update accounts_safe set nickname = 'pwned' where id = ...;   -- 1 row
--
-- The base-table UPDATE grant and the RLS policy that 0011 removed were both
-- bypassed, because neither applies to the view owner. `DELETE` happened to be
-- caught by the 0009/0010 guard trigger, and the two join views are not
-- auto-updatable, but none of that was by design.
--
-- The same default ACL left `anon` and `authenticated` holding full DML on
-- every other table in `public` — RLS was the only thing standing in the way.
-- Every write in this application goes through the service role, with the sole
-- exception of a user editing their own `profiles` row.
--
-- 0011 is already written and is not edited; this is the follow-up.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The sanitized views: SELECT for `authenticated`, nothing else, for anyone.
--
-- Each revoke names `public`, `anon` and `authenticated` explicitly. Naming
-- only `public` is the exact mistake this migration exists to correct.
-- ---------------------------------------------------------------------------
revoke all on accounts_safe    from public, anon, authenticated;
revoke all on trades_safe      from public, anon, authenticated;
revoke all on cash_flows_safe  from public, anon, authenticated;

grant select on accounts_safe   to authenticated;
grant select on trades_safe     to authenticated;
grant select on cash_flows_safe to authenticated;

-- A view whose WHERE clause is the security boundary should not let a
-- user-supplied function be evaluated before that clause. These three filter on
-- `owner_id = auth.uid()` and `deleted_at is null`, so both are made barriers.
alter view accounts_safe   set (security_barrier = true);
alter view trades_safe     set (security_barrier = true);
alter view cash_flows_safe set (security_barrier = true);

-- ---------------------------------------------------------------------------
-- 2. The base tables 0011 already closed — restated against role grants.
-- ---------------------------------------------------------------------------
revoke all on accounts   from public, anon, authenticated;
revoke all on trades     from public, anon, authenticated;
revoke all on cash_flows from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Client write access everywhere else.
--
-- These tables are written exclusively by the service role (the scheduled
-- agent and the dashboard's server routes). RLS restricts *rows*; it does not
-- make a stray grant harmless, and a SELECT-only policy plus an INSERT grant is
-- a combination worth removing rather than reasoning about.
--
-- `anon` keeps nothing at all: an unauthenticated caller has no account
-- context, so every owner-scoped policy already yields zero rows.
-- ---------------------------------------------------------------------------
do $$
declare
  target text;
begin
  foreach target in array array[
    'equity_snapshots',
    'performance',
    'positions',
    'routine_runs',
    'audit_log',
    'strategy_params',
    'market_history',
    'research_snapshots',
    'screener_snapshots',
    'backtest_runs'
  ] loop
    execute format('revoke all on %I from public, anon, authenticated', target);
    -- Owner-scoped or explicitly shared reads stay; writes do not.
    execute format('grant select on %I to authenticated', target);
  end loop;
end $$;

-- `profiles` is the one table a signed-in user writes directly: the settings
-- screen edits their own display name and default account. Its RLS policy
-- confines that to their own row.
revoke all on profiles from public, anon, authenticated;
grant select, update on profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Fail the migration if the resulting catalogue does not match the intent.
--
-- `has_table_privilege` is the authority here, not the text above: it resolves
-- role grants, PUBLIC grants and role membership the same way the executor
-- does at query time.
-- ---------------------------------------------------------------------------
do $$
declare
  obj      text;
  role_    text;
  priv     text;
  problems text[] := '{}';
begin
  -- Nothing sensitive may be readable or writable by `anon`, and the three
  -- views must be SELECT-only for `authenticated`.
  foreach obj in array array[
    'accounts', 'trades', 'cash_flows',
    'accounts_safe', 'trades_safe', 'cash_flows_safe'
  ] loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('anon', obj::regclass, priv) then
        problems := problems || format('anon still has %s on %s', priv, obj);
      end if;
    end loop;
  end loop;

  foreach obj in array array['accounts', 'trades', 'cash_flows'] loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('authenticated', obj::regclass, priv) then
        problems := problems || format('authenticated still has %s on %s', priv, obj);
      end if;
    end loop;
  end loop;

  foreach obj in array array['accounts_safe', 'trades_safe', 'cash_flows_safe'] loop
    if not has_table_privilege('authenticated', obj::regclass, 'SELECT') then
      problems := problems || format('authenticated lost SELECT on %s', obj);
    end if;
    foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege('authenticated', obj::regclass, priv) then
        problems := problems || format('authenticated still has %s on %s', priv, obj);
      end if;
    end loop;
  end loop;

  -- No client role may write any account-scoped or shared table.
  foreach obj in array array[
    'equity_snapshots', 'performance', 'positions', 'routine_runs', 'audit_log',
    'strategy_params', 'market_history', 'research_snapshots',
    'screener_snapshots', 'backtest_runs'
  ] loop
    foreach role_ in array array['anon', 'authenticated'] loop
      foreach priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
        if has_table_privilege(role_, obj::regclass, priv) then
          problems := problems || format('%s still has %s on %s', role_, priv, obj);
        end if;
      end loop;
    end loop;
    if has_table_privilege('anon', obj::regclass, 'SELECT') then
      problems := problems || format('anon still has SELECT on %s', obj);
    end if;
  end loop;

  -- The service role must keep working: it is how the server reads and writes.
  foreach obj in array array['accounts', 'trades', 'cash_flows', 'profiles'] loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if not has_table_privilege('service_role', obj::regclass, priv) then
        problems := problems || format('service_role lost %s on %s', priv, obj);
      end if;
    end loop;
  end loop;

  -- The one legitimate client write path.
  if not has_table_privilege('authenticated', 'profiles'::regclass, 'SELECT')
     or not has_table_privilege('authenticated', 'profiles'::regclass, 'UPDATE') then
    problems := problems || 'authenticated lost its own profile access';
  end if;
  foreach priv in array array['INSERT', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('authenticated', 'profiles'::regclass, priv) then
      problems := problems || format('authenticated still has %s on profiles', priv);
    end if;
  end loop;

  if array_length(problems, 1) is not null then
    raise exception 'privilege lockdown failed: %', array_to_string(problems, '; ');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Stop the next new object from repeating this.
--
-- Supabase's project-wide defaults still apply to objects created by other
-- roles, so this narrows only what this migration owner creates from here on.
-- A future migration that needs client access must grant it deliberately.
-- ---------------------------------------------------------------------------
alter default privileges in schema public
  revoke all on tables from anon, authenticated;
