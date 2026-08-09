-- ============================================================================
-- 0009_accounts_server_managed.sql — lock down server-managed account columns
--
-- Before this migration `accounts` carried a single `for all` policy, so any
-- authenticated user could INSERT, UPDATE or DELETE their own rows directly
-- through PostgREST. That let a client set `mode`, `status`,
-- `alpaca_account_number`, the Vault secret UUIDs and the verification
-- timestamps — all values the server later reads when deciding what an account
-- *is*. A production binding must never rest on a user-writable column.
--
-- After this migration:
--   * authenticated/anon may only SELECT their own rows;
--   * every mutation goes through the narrow Next.js server routes, which use
--     the service role and bypass RLS; and
--   * a defence-in-depth trigger rejects a server-managed column write even if
--     a future policy is loosened by accident.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- is_service_role() — true only for the service key or a superuser session.
-- ---------------------------------------------------------------------------
create or replace function is_service_role()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    current_user
  ) in ('service_role', 'postgres', 'supabase_admin');
$$;

revoke all on function is_service_role() from public;
grant execute on function is_service_role() to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- RLS: read-only for end users. No INSERT / UPDATE / DELETE policy exists, so
-- RLS denies those by default for every non-service role.
-- ---------------------------------------------------------------------------
drop policy if exists "own accounts" on accounts;
drop policy if exists "read own accounts" on accounts;
create policy "read own accounts" on accounts
  for select using (owner_id = auth.uid());

revoke insert, update, delete, truncate on accounts from authenticated;
revoke insert, update, delete, truncate on accounts from anon;
revoke all on accounts from anon;
grant select on accounts to authenticated;

-- ---------------------------------------------------------------------------
-- Defence in depth: block direct mutation of server-managed columns.
-- ---------------------------------------------------------------------------
create or replace function accounts_guard_server_managed()
returns trigger
language plpgsql
security definer
set search_path = public
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
