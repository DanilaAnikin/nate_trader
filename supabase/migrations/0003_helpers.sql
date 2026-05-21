-- ============================================================================
-- 0003_helpers.sql — RLS helper and the credential accessor
-- See DASHBOARD_SPECIFICATION.md §13.15–13.16 and §10.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- owns_account(uuid) — true if the current authed user owns the account.
-- Used by every account-scoped RLS policy.
-- ---------------------------------------------------------------------------
create or replace function owns_account(acct uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from accounts
    where id = acct
      and owner_id = auth.uid()
      and deleted_at is null
  );
$$;

grant execute on function owns_account(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- get_account_credentials(uuid) — decrypts the Alpaca key pair from Vault.
-- SECURITY: callable by the service role ONLY. Never exposed to anon/authed
-- clients. Trusted server code (the Python agent, the Next.js server runtime)
-- calls this to talk to Alpaca.
-- ---------------------------------------------------------------------------
create or replace function get_account_credentials(acct uuid)
returns table (api_key text, api_secret text)
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  k uuid;
  s uuid;
begin
  select alpaca_key_secret_id, alpaca_secret_secret_id
    into k, s
    from accounts
   where id = acct;

  if k is null or s is null then
    raise exception 'account % has no stored credentials', acct;
  end if;

  return query
    select (select decrypted_secret from vault.decrypted_secrets where id = k),
           (select decrypted_secret from vault.decrypted_secrets where id = s);
end;
$$;

-- Lock it down: remove the default PUBLIC execute grant, then grant only to
-- the service role.
revoke all on function get_account_credentials(uuid) from public;
revoke all on function get_account_credentials(uuid) from anon;
revoke all on function get_account_credentials(uuid) from authenticated;
grant execute on function get_account_credentials(uuid) to service_role;
