-- SABOTAGE 9 — alter an overload rather than the named function.
-- The instrumented signature is untouched. A second, uninstrumented overload
-- of the same name is added, and a caller who passes a text id reaches it
-- instead. Nothing about the watched function changed.
\set ON_ERROR_STOP on
create or replace function public.vault_delete_secret(p_id text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, public, vault
as $$
begin
  delete from vault.secrets where id::text = p_id;
end $$;
grant execute on function public.vault_delete_secret(text) to public, anon, authenticated, service_role;
