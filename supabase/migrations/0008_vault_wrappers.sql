-- ============================================================================
-- 0008_vault_wrappers.sql — public-schema wrappers for Vault writes.
--
-- PostgREST (and therefore supabase-js .rpc()) only reaches the `public`
-- schema, so the dashboard cannot call vault.* directly. These wrappers are
-- SECURITY DEFINER and locked to the service role only — the same trust level
-- as get_account_credentials().
-- ============================================================================

create or replace function vault_create_secret(p_secret text, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare sid uuid;
begin
  select vault.create_secret(p_secret, p_name) into sid;
  return sid;
end; $$;

create or replace function vault_update_secret(p_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  perform vault.update_secret(p_id, p_secret);
end; $$;

create or replace function vault_delete_secret(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  delete from vault.secrets where id = p_id;
end; $$;

revoke all on function vault_create_secret(text, text) from public, anon, authenticated;
revoke all on function vault_update_secret(uuid, text) from public, anon, authenticated;
revoke all on function vault_delete_secret(uuid)        from public, anon, authenticated;
grant execute on function vault_create_secret(text, text) to service_role;
grant execute on function vault_update_secret(uuid, text) to service_role;
grant execute on function vault_delete_secret(uuid)       to service_role;
