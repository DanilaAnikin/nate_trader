-- Database-side invariants complement, but do not replace, the exact final
-- rehearsed catalog comparison required by a production bundle.
do $nt_postconditions$
declare role_name text; routine record;
begin
  if not exists (
    select 1 from pg_constraint c
    where c.conrelid='public.account_credential_assignment'::regclass
      and c.confrelid='vault.secrets'::regclass and c.contype='f'
      and c.convalidated and c.confdeltype='r'
      and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='secret_id')]::smallint[]
      and c.confkey=array[(select attnum from pg_attribute where attrelid=c.confrelid and attname='id')]::smallint[]
  ) then raise exception 'Validated Vault credential foreign key missing'; end if;
  foreach role_name in array array['anon','authenticated'] loop
    if has_any_column_privilege(role_name,'public.accounts','SELECT')
      or has_any_column_privilege(role_name,'public.accounts','INSERT')
      or has_any_column_privilege(role_name,'public.accounts','UPDATE')
      or has_table_privilege(role_name,'public.accounts','DELETE')
      or has_table_privilege(role_name,'public.accounts','TRUNCATE') then
      raise exception 'Client account table privilege remains';
    end if;
    for routine in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('get_account_credentials','vault_create_secret','vault_update_secret','vault_delete_secret') loop
      if has_function_privilege(role_name,routine.oid,'EXECUTE') then
        raise exception 'Client credential routine privilege remains';
      end if;
    end loop;
  end loop;
  if not (select relrowsecurity from pg_class where oid='public.accounts'::regclass)
    or to_regprocedure('public.cancel_account_verification(uuid,text)') is null
    or to_regprocedure('public.audit_detail_max_nodes()') is null
    or to_regprocedure('public.audit_detail_max_depth()') is null then
    raise exception 'Final account/audit/verification contract incomplete';
  end if;
end $nt_postconditions$;
