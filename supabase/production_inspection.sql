-- Read-only production inventory. Run with psql -X -qAt -v ON_ERROR_STOP=1.
-- Output: one JSON object per line. No credentials, identifiers or row payloads.
-- Presence is NOT proof that a migration ran or its implementation is correct.
-- This file never creates/repairs the migration ledger or applies migrations.
\set ON_ERROR_STOP on
begin isolation level repeatable read read only;
set local statement_timeout = '15s';
set local lock_timeout = '2s';
set local search_path = pg_catalog;

select jsonb_build_object(
  'section', 'server',
  'observed_at', current_timestamp,
  'server_version', current_setting('server_version'),
  'server_version_num', current_setting('server_version_num'),
  'transaction_read_only', current_setting('transaction_read_only'),
  'migration_ledger_present', to_regclass('supabase_migrations.schema_migrations') is not null,
  'extensions', (select jsonb_object_agg(extname, extversion) from pg_extension
                 where extname in ('supabase_vault', 'pgsodium', 'pgcrypto'))
);

select exists (
  select 1 from pg_attribute
  where attrelid = to_regclass('supabase_migrations.schema_migrations')
    and attname = 'version' and attnum > 0 and not attisdropped
) as ledger_readable \gset
\if :ledger_readable
select jsonb_build_object('section', 'migration_versions',
  'versions', coalesce(jsonb_agg(version::text order by version::text), '[]'::jsonb))
from supabase_migrations.schema_migrations;
\else
select jsonb_build_object('section', 'migration_versions', 'versions', null,
  'status', 'unavailable; do not infer an applied version from object presence');
\endif

with required(name) as (values
  ('accounts'), ('profiles'), ('equity_snapshots'), ('performance'),
  ('positions'), ('trades'), ('cash_flows'), ('routine_runs'),
  ('accounts_safe'), ('trades_safe'), ('cash_flows_safe'),
  ('broker_refresh_state'), ('broker_refresh_token'),
  ('account_credential_assignment'), ('account_create_operation'),
  ('account_verification_token'), ('accounts_active_broker_binding_idx'),
  ('accounts_broker_number_lookup_idx')
)
select jsonb_build_object('section', 'relations',
  'objects', jsonb_object_agg(name, to_regclass('public.' || name) is not null))
from required;

with required(relation, name) as (values
  ('accounts', 'credential_version'),
  ('broker_refresh_token', 'credential_version'),
  ('account_verification_token', 'generation'),
  ('account_verification_token', 'superseded_at'),
  ('account_verification_token', 'cancelled_at'),
  ('account_verification_token', 'expires_at')
)
select jsonb_build_object('section', 'columns', 'objects', jsonb_object_agg(
  relation || '.' || name, exists (
    select 1 from pg_attribute a
    where a.attrelid = to_regclass('public.' || required.relation)
      and a.attname = required.name and a.attnum > 0 and not a.attisdropped
  ))) from required;

with required(name) as (values
  ('accounts_guard_server_managed'), ('account_history_snapshot'),
  ('create_account_operation'), ('resolve_create_operation'),
  ('update_account_metadata'), ('rotate_account_credentials'),
  ('delete_account_atomic'), ('begin_broker_refresh'), ('publish_broker_refresh'),
  ('begin_account_verification'), ('finish_account_verification'),
  ('cancel_account_verification'), ('audit_detail_is_publishable'),
  ('audit_detail_max_nodes'), ('audit_detail_max_depth'), ('audit_token_is_sensitive')
)
select jsonb_build_object('section', 'routine_names', 'objects', jsonb_object_agg(
  name, exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = required.name)
)) from required;

select jsonb_build_object('section', 'credential_fk',
  'validated_restrict_fk', exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.account_credential_assignment')
      and confrelid = to_regclass('vault.secrets')
      and conname = 'account_credential_assignment_secret_fk'
      and contype = 'f' and convalidated and confdeltype = 'r'
      and conkey = array[(select attnum from pg_attribute
        where attrelid = to_regclass('public.account_credential_assignment')
          and attname = 'secret_id' and attnum > 0 and not attisdropped)]
      and confkey = array[(select attnum from pg_attribute
        where attrelid = to_regclass('vault.secrets')
          and attname = 'id' and attnum > 0 and not attisdropped)]
  ));

-- Effective privileges include inherited and column-level grants. RLS and
-- gateway reachability are separate boundaries; these records do not prove
-- that a public request can reach a row.
select jsonb_build_object('section', 'client_privileges',
  'relation', n.nspname || '.' || c.relname, 'role', r.rolname,
  'schema_usage', has_schema_privilege(r.oid, n.oid, 'USAGE'),
  'select_any_column', has_any_column_privilege(r.oid, c.oid, 'SELECT'),
  'insert_any_column', has_any_column_privilege(r.oid, c.oid, 'INSERT'),
  'update_any_column', has_any_column_privilege(r.oid, c.oid, 'UPDATE'),
  'delete', has_table_privilege(r.oid, c.oid, 'DELETE'),
  'truncate', has_table_privilege(r.oid, c.oid, 'TRUNCATE'),
  'rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity
)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join pg_roles r
where r.rolname in ('anon', 'authenticated')
  and ((n.nspname = 'public' and c.relname in ('accounts', 'trades', 'cash_flows'))
       or (n.nspname = 'vault' and c.relname = 'secrets'))
order by n.nspname, c.relname, r.rolname;

-- SECURITY DEFINER wrappers can expose Vault even when its tables are denied.
-- Inspect their effective EXECUTE grants; never invoke them here.
select jsonb_build_object('section', 'credential_routine_privileges',
  'routine', p.proname, 'signature', pg_get_function_identity_arguments(p.oid),
  'security_definer', p.prosecdef, 'role', r.rolname,
  'executable', has_function_privilege(r.oid, p.oid, 'EXECUTE'))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
cross join pg_roles r
where n.nspname = 'public' and r.rolname in ('anon', 'authenticated', 'service_role')
  and p.proname in ('get_account_credentials', 'vault_create_secret',
                    'vault_update_secret', 'vault_delete_secret')
order by p.proname, p.oid, r.rolname;

-- Aggregate the legacy conditions that 0019, 0020 and 0022 refuse to guess at.
-- Do not read vault.decrypted_secrets or call credential-returning routines.
select count(*) = 7 as account_shape_present from pg_attribute
where attrelid = to_regclass('public.accounts') and attnum > 0 and not attisdropped
  and attname in ('owner_id', 'mode', 'deleted_at', 'alpaca_account_number',
                  'alpaca_key_secret_id', 'alpaca_secret_secret_id', 'id') \gset
\if :account_shape_present
with active_slots as (
  select alpaca_key_secret_id as secret_id from public.accounts where deleted_at is null
  union all
  select alpaca_secret_secret_id from public.accounts where deleted_at is null
), shared as (
  select secret_id from active_slots where secret_id is not null
  group by secret_id having count(*) > 1
), duplicate_bindings as (
  select owner_id, mode, alpaca_account_number from public.accounts
  where deleted_at is null and alpaca_account_number is not null
  group by owner_id, mode, alpaca_account_number having count(*) > 1
)
select jsonb_build_object('section', 'legacy_integrity',
  'active_accounts', count(*) filter (where deleted_at is null),
  'active_missing_or_reused_credential_slot', count(*) filter (
    where deleted_at is null and (alpaca_key_secret_id is null
      or alpaca_secret_secret_id is null or alpaca_key_secret_id = alpaca_secret_secret_id)),
  'shared_secret_ids', (select count(*) from shared),
  'active_missing_broker_binding', count(*) filter (
    where deleted_at is null and (alpaca_account_number is null or btrim(alpaca_account_number) = '')),
  'deleted_accounts_retaining_credentials', count(*) filter (
    where deleted_at is not null and (alpaca_key_secret_id is not null or alpaca_secret_secret_id is not null)),
  'duplicate_active_broker_bindings', (select count(*) from duplicate_bindings)
) from public.accounts;

select exists (select 1 from pg_attribute
  where attrelid = to_regclass('vault.secrets') and attname = 'id'
    and attnum > 0 and not attisdropped) as vault_shape_present \gset
\if :vault_shape_present
with referenced as (
  select alpaca_key_secret_id as secret_id from public.accounts where deleted_at is null
  union
  select alpaca_secret_secret_id from public.accounts where deleted_at is null
)
select jsonb_build_object('section', 'vault_references',
  'dangling_active_secret_ids', count(*)) from referenced r
where r.secret_id is not null
  and not exists (select 1 from vault.secrets v where v.id = r.secret_id);
\else
select jsonb_build_object('section', 'vault_references', 'status', 'unavailable: vault.secrets.id absent');
\endif
\else
select jsonb_build_object('section', 'legacy_integrity', 'status', 'unavailable: required accounts columns absent');
\endif

-- 0022 scans existing audit detail with a recursive guard that cannot handle
-- arrays; 0023 fixes it only AFTER that scan. Identify blockers without
-- executing either guard and without emitting the audit payloads.
-- This is not the full 0023 predicate: broker numbers, UUID keys and traversal
-- budgets require their own verification during the clone rehearsal.
select exists (select 1 from pg_attribute
  where attrelid = to_regclass('public.audit_log') and attname = 'detail'
    and atttypid = 'jsonb'::regtype and attnum > 0 and not attisdropped)
  as audit_shape_present \gset
\if :audit_shape_present
select jsonb_build_object('section', 'audit_upgrade_blockers',
  'rows', count(*),
  'non_object_details', count(*) filter (
    where detail is not null and jsonb_typeof(detail) <> 'object'),
  'details_containing_arrays', count(*) filter (where jsonb_path_exists(
    detail, 'strict $.** ? (@.type() == "array")')),
  'details_containing_forbidden_keys', count(*) filter (where jsonb_path_exists(
    detail, 'strict $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(secret|token|vault|operation_id|api_key|account_number|credential_id)" flag "i")')),
  'details_containing_uuid_strings', count(*) filter (where jsonb_path_exists(
    detail, 'strict $.** ? (@.type() == "string" && @ like_regex "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" flag "i")'))
) from public.audit_log;
\else
select jsonb_build_object('section', 'audit_upgrade_blockers', 'status', 'unavailable: audit_log.detail jsonb absent');
\endif

rollback;
