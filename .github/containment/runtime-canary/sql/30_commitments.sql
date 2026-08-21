-- ===========================================================================
-- 30_commitments.sql — everything the database is committed to, as one digest
--
-- "No canary rows" says nothing was written through the three watched
-- wrappers. It says nothing about the rest of the database. This file takes a
-- content commitment over every part of the clone an image could plausibly
-- move, so that "the frozen image changed nothing" is checked rather than
-- inferred from the one sensor that happened to be installed.
--
-- What is covered, and why each is here:
--
--   accounts, profiles                  the rows the mutating handlers write
--   audit_log                           every handler's own record of itself
--   equity_snapshots, cash_flows        the financial MIRRORS: `lib/maintenance`
--                                       calls these the largest write in the
--                                       application, performed as a side effect
--                                       of two GET handlers, so a freeze that
--                                       covered only the verbs would leave them
--                                       moving
--   auth.users                          the identity surface
--   vault.secrets                       the credential store the three watched
--                                       wrappers exist to mutate
--   EVERY table in public               a generic row-count sweep, so a table
--                                       nobody thought of is still covered on
--                                       whichever schema is running
--   every sequence in public            a row that was inserted and rolled back
--                                       leaves no rows and still burns a
--                                       sequence value; a commitment that
--                                       ignored sequences would call that
--                                       "unchanged"
--
-- Output is `KEY=VALUE` lines, one per commitment, so the shell can diff two
-- runs of this file without a parser.
--
-- SECRET HYGIENE: `vault.secrets.secret` is the encrypted payload and is
-- digested, never selected. `vault.decrypted_secrets` is deliberately not read
-- by this harness at all.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create or replace function pg_temp.nt_digest(p_sql text)
returns text
language plpgsql
as $$
declare
  out_text text;
begin
  execute p_sql into out_text;
  return coalesce(out_text, '(empty)');
exception when others then
  -- A table that does not exist on this schema is a fact about the schema, not
  -- a harness failure; it is recorded as such so the two schemas' commitment
  -- files stay comparable line for line.
  return 'ERR:' || sqlstate;
end $$;

select 'NT_COMMIT_accounts=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select id, owner_id, nickname, mode, status, color,
                 alpaca_key_secret_id, alpaca_secret_secret_id,
                 alpaca_account_number, is_active
            from public.accounts) t $q$);

select 'NT_COMMIT_accounts_n=' || pg_temp.nt_digest($q$
  select count(*)::text from public.accounts $q$);

select 'NT_COMMIT_profiles=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select id, display_name, default_account_id from public.profiles) t $q$);

select 'NT_COMMIT_audit_log=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select actor_id, account_id, action, detail from public.audit_log) t $q$);

select 'NT_COMMIT_audit_log_n=' || pg_temp.nt_digest($q$
  select count(*)::text from public.audit_log $q$);

select 'NT_COMMIT_equity_snapshots=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select account_id, snapshot_date, equity, cash, source
            from public.equity_snapshots) t $q$);

select 'NT_COMMIT_cash_flows=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select account_id, flow_date, amount, kind, source, external_id
            from public.cash_flows) t $q$);

select 'NT_COMMIT_auth_users=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select id, email, role, aud from auth.users) t $q$);

-- The encrypted payload is digested, never emitted.
select 'NT_COMMIT_vault_secrets=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select id, name, description, md5(secret) as secret_digest
            from vault.secrets) t $q$);

select 'NT_COMMIT_vault_secrets_n=' || pg_temp.nt_digest($q$
  select count(*)::text from vault.secrets $q$);

-- 0020 onwards; absent on the 0008 reference, where it records ERR:42P01.
select 'NT_COMMIT_credential_assignment=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
    from (select * from public.account_credential_assignment) t $q$);

-- --- the generic sweep -----------------------------------------------------
-- Every ordinary table in `public`, counted, whichever schema this is.
select 'NT_COMMIT_public_rowcounts=' || pg_temp.nt_digest($q$
  select md5(string_agg(rel || '=' || n::text, ',' order by rel))
    from (
      select c.relname::text as rel,
             (xpath('/row/c/text()',
                    query_to_xml(format('select count(*) as c from public.%I', c.relname),
                                 false, true, '')))[1]::text::bigint as n
        from pg_class c
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relkind in ('r','p')
    ) s $q$);

select 'NT_COMMIT_public_table_list=' || pg_temp.nt_digest($q$
  select md5(string_agg(c.relname, ',' order by c.relname))
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind in ('r','p') $q$);

-- Sequences: a rolled-back insert leaves no row and still burns a value.
select 'NT_COMMIT_public_sequences=' || pg_temp.nt_digest($q$
  select md5(coalesce(string_agg(c.relname || '=' ||
               coalesce(pg_catalog.pg_sequence_last_value(c.oid)::text, 'null'),
               ',' order by c.relname), ''))
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'S' $q$);

-- --- the sensor's own reading ----------------------------------------------
select 'NT_CANARY_HITS=' || pg_temp.nt_digest($q$
  select string_agg(fn || ':' || hits::text, ',' order by fn) from nt_canary.hits() $q$);

select 'NT_CANARY_ROWS=' || pg_temp.nt_digest($q$
  select count(*)::text from nt_canary.calls $q$);

select 'NT_CANARY_ARMED=' || pg_temp.nt_digest($q$
  select nt_canary.assert_armed() $q$);
