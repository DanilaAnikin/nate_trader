-- ============================================================================
-- 0010_accounts_guard_authz_fix.sql — correct the accounts guard authorization
--
-- Migration 0009 authorized the guard with `is_service_role()`, which falls
-- back to `current_user` when no JWT role claim is present. Inside a
-- SECURITY DEFINER function `current_user` is the function *owner* (typically
-- `postgres`), not the caller — so the fallback authorized everyone and the
-- guard could be bypassed. 0009 is left untouched; this migration replaces the
-- helper and the trigger function with a fail-closed version.
--
-- The corrected rule:
--   * the guard is SECURITY INVOKER, so `current_user` is genuinely the
--     caller's effective role rather than the function owner. The guard needs
--     no elevated rights — it only inspects NEW/OLD and raises — so being a
--     definer bought nothing and cost the only reliable identity signal;
--   * authorization prefers the request's JWT role claim;
--   * with no JWT at all (a direct psql/migration connection) the effective
--     role must itself be a service or owner role;
--   * anything else is denied.
-- Both functions pin `search_path` so a caller cannot shadow the helpers.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- jwt_role() — the role asserted by the current request, or null.
-- Deliberately NOT security definer: it only reads request-local settings.
-- ---------------------------------------------------------------------------
create or replace function jwt_role()
returns text
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  claims text;
  claim_role text;
begin
  begin
    claim_role := nullif(current_setting('request.jwt.claim.role', true), '');
  exception when others then
    claim_role := null;
  end;
  if claim_role is not null then
    return claim_role;
  end if;

  begin
    claims := nullif(current_setting('request.jwt.claims', true), '');
  exception when others then
    claims := null;
  end;
  if claims is null then
    return null;
  end if;

  begin
    return claims::jsonb ->> 'role';
  exception when others then
    -- A malformed claims blob is not a role. Fail closed.
    return null;
  end;
end;
$$;

revoke all on function jwt_role() from public;
grant execute on function jwt_role() to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- is_service_role() — fail-closed replacement for the 0009 version.
--
-- Not SECURITY DEFINER, so `current_user` is the caller's effective role. A
-- client role is refused outright even if it somehow arrives without claims.
-- ---------------------------------------------------------------------------
create or replace function is_service_role()
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    -- A client role is never the service role, whatever it claims.
    when current_user in ('anon', 'authenticated') then false
    -- A request carrying a JWT is authorized only by that claim.
    when jwt_role() is not null then jwt_role() = 'service_role'
    -- No JWT and not a client role: a direct owner/service connection.
    else current_user in ('service_role', 'postgres', 'supabase_admin')
  end;
$$;

revoke all on function is_service_role() from public;
grant execute on function is_service_role() to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Recreate the guard so it picks up the corrected helper and pins its own
-- search_path to the same explicit list.
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: the guard must see the *caller's* role, and it
-- needs no privileges of its own.
create or replace function accounts_guard_server_managed()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if is_service_role() then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    raise exception
      'accounts rows are created only by the server (service role)'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    raise exception
      'accounts rows are removed only by the server (service role)'
      using errcode = '42501';
  end if;

  if new.owner_id                is distinct from old.owner_id
     or new.mode                 is distinct from old.mode
     or new.status               is distinct from old.status
     or new.alpaca_account_number is distinct from old.alpaca_account_number
     or new.alpaca_key_secret_id  is distinct from old.alpaca_key_secret_id
     or new.alpaca_secret_secret_id is distinct from old.alpaca_secret_secret_id
     or new.last_verified_at     is distinct from old.last_verified_at
     or new.last_synced_at       is distinct from old.last_synced_at
     or new.created_at           is distinct from old.created_at
     or new.deleted_at           is distinct from old.deleted_at
     or new.id                   is distinct from old.id
  then
    raise exception
      'server-managed account columns are not client-writable'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists accounts_guard on accounts;
create trigger accounts_guard
  before insert or update or delete on accounts
  for each row execute function accounts_guard_server_managed();

-- ---------------------------------------------------------------------------
-- Narrow, explicit metadata update policy.
--
-- 0009 left `accounts` SELECT-only, which made "what may a client change?"
-- untestable — every UPDATE was filtered away by RLS before the guard ran.
-- Name the three cosmetic, owner-scoped columns that are safe to change
-- directly; the guard above still rejects every server-managed column, so the
-- policy and the trigger together state the rule explicitly.
-- ---------------------------------------------------------------------------
drop policy if exists "update own account metadata" on accounts;
create policy "update own account metadata" on accounts
  for update
  using (owner_id = auth.uid() and deleted_at is null)
  with check (owner_id = auth.uid() and deleted_at is null);

grant update (nickname, color, is_active) on accounts to authenticated;
