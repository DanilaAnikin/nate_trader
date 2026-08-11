-- ============================================================================
-- 0013_account_lifecycle_rpc.sql — make key rotation and deletion atomic
--
-- Both flows used to be a sequence of independent round trips from Node:
--
--   rotate:  vault.update(key) → vault.update(secret) → update accounts → audit
--   delete:  vault.delete(key) → vault.delete(secret) → update/delete accounts
--
-- Every arrow is a place the process can fail, and each leaves the account in a
-- state no retry can repair:
--
--   * key rotated, secret not — Vault now holds a new key beside the *old*
--     secret. The previous key value is gone, so the pair can never be made
--     consistent again and the account is permanently unauthenticated.
--   * both rotated, row update failed — the account row still advertises the
--     old broker account number and status while Vault holds new credentials.
--     The production binding compares that number, so the account silently
--     stops matching.
--   * Vault purged, soft delete failed — the row survives pointing at secrets
--     that no longer exist.
--   * soft delete succeeded, Vault purge failed — and, worse, the old code
--     ignored the purge result entirely, so live credentials leaked into a
--     "deleted" account with no error anywhere.
--
-- A PL/pgSQL function body runs in a single transaction, so doing the whole
-- sequence inside one function makes it all-or-nothing: any error rolls back
-- the Vault writes and the row change together. These are the only supported
-- rotation and deletion paths.
--
-- Both are service-role only, and each takes the owner id and verifies
-- ownership itself, so a mistaken call site cannot act on someone else's row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- rotate_account_credentials — new key pair + broker binding, atomically.
--
-- The row is locked FOR UPDATE first, so two concurrent rotations serialise
-- instead of interleaving their Vault writes.
-- ---------------------------------------------------------------------------
create or replace function rotate_account_credentials(
  p_account        uuid,
  p_owner          uuid,
  p_api_key        text,
  p_api_secret     text,
  p_account_number text
)
returns accounts
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  target accounts;
begin
  if p_api_key is null or btrim(p_api_key) = ''
     or p_api_secret is null or btrim(p_api_secret) = '' then
    raise exception 'api key and secret are required' using errcode = '22023';
  end if;

  select * into target
    from accounts
   where id = p_account
     and owner_id = p_owner
     and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;
  if target.alpaca_key_secret_id is null
     or target.alpaca_secret_secret_id is null then
    raise exception 'account has no stored credentials' using errcode = 'P0002';
  end if;

  -- `vault.update_secret` is an UPDATE underneath, so an id that no longer
  -- exists updates zero rows and reports success. Rotating "successfully" into
  -- a secret that is not there would leave the account holding one new value
  -- and one that was never written, so both ids are confirmed first.
  if not exists (
    select 1 from vault.secrets where id = target.alpaca_key_secret_id
  ) then
    raise exception 'the stored API key secret is missing from the vault'
      using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from vault.secrets where id = target.alpaca_secret_secret_id
  ) then
    raise exception 'the stored API secret is missing from the vault'
      using errcode = 'P0002';
  end if;

  -- If either of these raises, the whole function rolls back — including the
  -- other one. That is the entire point.
  perform vault.update_secret(target.alpaca_key_secret_id, p_api_key);
  perform vault.update_secret(target.alpaca_secret_secret_id, p_api_secret);

  update accounts
     set status                = 'connected',
         alpaca_account_number = p_account_number,
         last_verified_at      = now()
   where id = p_account
   returning * into target;

  insert into audit_log (actor_id, account_id, action)
  values (p_owner, p_account, 'account.keys_rotated');

  return target;
end;
$$;

revoke all on function rotate_account_credentials(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function rotate_account_credentials(uuid, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- delete_account_atomic — Vault purge, row change and audit, atomically.
--
-- `p_purge_history` hard-deletes the row and cascades its history; otherwise
-- the row is soft-deleted, keeps its history, and drops every credential
-- reference *and* the broker account number the production binding compares.
-- ---------------------------------------------------------------------------
create or replace function delete_account_atomic(
  p_account       uuid,
  p_owner         uuid,
  p_purge_history boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, vault
as $$
declare
  target accounts;
begin
  select * into target
    from accounts
   where id = p_account
     and owner_id = p_owner
     and deleted_at is null
     for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- A failure here aborts the deletion rather than orphaning a live secret.
  if target.alpaca_key_secret_id is not null then
    delete from vault.secrets where id = target.alpaca_key_secret_id;
  end if;
  if target.alpaca_secret_secret_id is not null then
    delete from vault.secrets where id = target.alpaca_secret_secret_id;
  end if;

  if p_purge_history then
    delete from accounts where id = p_account;
    insert into audit_log (actor_id, account_id, action, detail)
    values (
      p_owner, null, 'account.deleted_purged',
      jsonb_build_object('nickname', target.nickname)
    );
  else
    update accounts
       set deleted_at              = now(),
           is_active               = false,
           status                  = 'paused',
           alpaca_key_secret_id    = null,
           alpaca_secret_secret_id = null,
           alpaca_account_number   = null
     where id = p_account;
    insert into audit_log (actor_id, account_id, action, detail)
    values (
      p_owner, p_account, 'account.deleted',
      jsonb_build_object('nickname', target.nickname)
    );
  end if;

  return true;
end;
$$;

revoke all on function delete_account_atomic(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function delete_account_atomic(uuid, uuid, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- The new functions are created after 0012 narrowed this migration owner's
-- default privileges for tables, but function defaults are separate: restate
-- the intent so a client role never acquires EXECUTE by default.
-- ---------------------------------------------------------------------------
alter default privileges in schema public
  revoke all on functions from anon, authenticated;
