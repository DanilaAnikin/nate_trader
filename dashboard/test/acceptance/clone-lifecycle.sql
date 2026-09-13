-- CLONE ONLY. Invoke through run-clone.mjs, which checks Docker isolation.
-- Synthetic fixtures only; no broker requests. No row/credential output.
-- The transaction rolls back all fixture rows; sequences may advance on clone.
\set ON_ERROR_STOP on
\set VERBOSITY sqlstate
begin;
set local statement_timeout = '45s';
set local lock_timeout = '5s';
set local search_path = public, pg_catalog;

do $$
declare owner_id uuid := gen_random_uuid();
begin
  if current_setting('nate.acceptance.clone_only', true) is distinct from 'true' then
    raise exception 'clone runner required';
  end if;
  perform set_config('nate.acceptance.owner', owner_id::text, true);
  insert into auth.users (id, email, raw_user_meta_data)
  values (owner_id, 'acceptance-' || owner_id::text || '@example.invalid', '{}'::jsonb);
end $$;

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
declare
  owner_id uuid := current_setting('nate.acceptance.owner')::uuid;
  operation_id uuid := gen_random_uuid();
  broker_number text := 'PA-NATE-SYNTHETIC-' || replace(operation_id::text, '-', '');
  created accounts;
  replayed accounts;
  changed accounts;
  result jsonb;
  verification jsonb;
  refresh_token jsonb;
  blocked boolean := false;
begin
  -- Test the exact service-role contract the candidate uses, including real
  -- Vault encryption/decryption, without involving Alpaca or existing owners.
  created := create_account_operation(owner_id, operation_id, repeat('a', 64),
    'Synthetic acceptance', 'paper', '#007aff',
    'SYNTHETIC-KEY-ONLY', 'SYNTHETIC-SECRET-ONLY', broker_number);
  if created.id is null or created.owner_id <> owner_id then raise exception 'create failed'; end if;
  replayed := create_account_operation(owner_id, operation_id, repeat('a', 64),
    'Synthetic acceptance', 'paper', '#007aff',
    'SYNTHETIC-KEY-ONLY', 'SYNTHETIC-SECRET-ONLY', broker_number);
  if replayed.id is distinct from created.id then raise exception 'idempotent create failed'; end if;
  result := resolve_create_operation(owner_id, operation_id, repeat('a', 64));
  if result->>'outcome' is distinct from 'created' then raise exception 'resolve failed'; end if;
  result := resolve_create_operation(owner_id, operation_id, repeat('b', 64));
  if result->>'outcome' is distinct from 'conflict' then raise exception 'fingerprint conflict failed'; end if;

  changed := update_account_metadata(created.id, owner_id, 'Updated synthetic acceptance', '#34c759', true);
  if changed.nickname is distinct from 'Updated synthetic acceptance' then raise exception 'metadata failed'; end if;
  begin
    perform update_account_metadata(created.id, gen_random_uuid(), 'Wrong owner', null, null);
  exception when no_data_found then blocked := true;
  end;
  if not blocked then raise exception 'ownership check failed'; end if;

  changed := rotate_account_credentials(created.id, owner_id,
    'ROTATED-SYNTHETIC-KEY', 'ROTATED-SYNTHETIC-SECRET', broker_number);
  if (changed.credential_version > created.credential_version) is not true then raise exception 'rotation epoch failed'; end if;
  verification := begin_account_verification(created.id, owner_id);
  if verification->>'api_key' is distinct from 'ROTATED-SYNTHETIC-KEY'
     or verification->>'api_secret' is distinct from 'ROTATED-SYNTHETIC-SECRET'
     or ((verification->>'expires_at')::timestamptz > clock_timestamp()) is not true then
    raise exception 'verification credential or deadline failed';
  end if;
  changed := finish_account_verification((verification->>'token')::uuid, 'connected', broker_number);
  if changed.status is distinct from 'connected' then raise exception 'verification finish failed'; end if;
  verification := begin_account_verification(created.id, owner_id);
  if cancel_account_verification((verification->>'token')::uuid, 'abandoned') is distinct from true then
    raise exception 'verification cancel failed';
  end if;

  refresh_token := begin_broker_refresh_with_credentials(created.id, owner_id);
  result := publish_broker_refresh((refresh_token->>'token')::uuid,
    '[]'::jsonb, true, '[]'::jsonb, current_date, true, 0, true);
  if (result->>'equity_written')::integer is distinct from 0 then raise exception 'refresh publish failed'; end if;
  result := account_history_snapshot(created.id, owner_id, null);
  if result->>'account_id' is distinct from created.id::text or (result->>'equity_count')::integer is distinct from 0 then
    raise exception 'history read failed';
  end if;

  if audit_detail_is_publishable('{"symbols":["AAPL","MSFT"]}'::jsonb) is distinct from true
     or audit_detail_is_publishable('{"items":[{"secret_id":"forbidden"}]}'::jsonb) is distinct from false then
    raise exception '0023 audit guard failed';
  end if;
  if has_function_privilege('service_role', 'public.vault_create_secret(text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.get_account_credentials(uuid)', 'EXECUTE') then
    raise exception 'credential routine ACL failed';
  end if;

  if delete_account_atomic(created.id, owner_id, false) is distinct from true then raise exception 'delete failed'; end if;
  select * into changed from accounts where id = created.id;
  if changed.deleted_at is null or changed.alpaca_key_secret_id is not null
     or changed.alpaca_secret_secret_id is not null then raise exception 'delete retained credentials'; end if;
  if exists (select 1 from account_credential_assignment where account_id = created.id) then
    raise exception 'delete retained assignment';
  end if;
end $$;

rollback;
select 'NATE_CLONE_LIFECYCLE_PASS';
