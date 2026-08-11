-- ============================================================================
-- 0022 assertions: request-bound idempotence, the broker-binding invariant,
-- token generations, and the audit guard.
--
-- Every block below fails on 0021. They are written against the real
-- migrations on a real PostgreSQL server, so what is asserted is what the
-- database does, not what the SQL text appears to say.
-- ============================================================================

\set ON_ERROR_STOP on

-- One transaction, rolled back at the end: these assertions create accounts
-- and must leave the database as they found it.
begin;

select set_config('test.user_a', :'user_a', true);
select set_config('test.user_b', :'user_b', true);

-- ---------------------------------------------------------------------------
-- 1. Two new operation ids, one broker binding.
--
-- The client's operation id makes a *retry* idempotent. It cannot make two
-- genuinely different submissions idempotent — a reload that loses the id, a
-- second tab, a user who clicks twice through two sessions — and nothing in
-- the schema said an owner may hold one active account per broker binding. Two
-- accounts for one Alpaca account means every per-account mirror describes the
-- same money twice.
-- ---------------------------------------------------------------------------
do $$
declare
  first   accounts;
  blocked boolean := false;
  msg     text;
  before_accounts bigint;
  before_secrets  bigint;
begin
  first := create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('1', 64),
    'Binding first', 'paper', '#123456', 'AK', 'AS', 'PA-BINDING-DUP');

  select count(*) into before_accounts from accounts;
  select count(*) into before_secrets from vault.secrets;

  begin
    perform create_account_operation(
      current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('2', 64),
      'Binding second', 'paper', '#123456', 'AK', 'AS', 'PA-BINDING-DUP');
  exception when others then blocked := true; msg := sqlerrm; end;

  if not blocked then
    raise exception
      'FAIL: a second operation id created a second account for one broker binding';
  end if;
  if (select count(*) from accounts) <> before_accounts then
    raise exception 'FAIL: the refused creation left an account row behind';
  end if;
  if (select count(*) from vault.secrets) <> before_secrets then
    raise exception 'FAIL: the refused creation left Vault secrets behind';
  end if;

  -- The *same* binding in the other mode is a different Alpaca account.
  perform create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('3', 64),
    'Other mode', 'live', '#123456', 'AK', 'AS', 'PA-BINDING-DUP');

  -- And another owner's account with the same number is not this owner's
  -- duplicate.
  perform create_account_operation(
    current_setting('test.user_b')::uuid, gen_random_uuid(), repeat('4', 64),
    'Other owner', 'paper', '#123456', 'BK', 'BS', 'PA-BINDING-DUP');

  -- Soft-deleting frees the binding: the row keeps its number for the audit
  -- trail, and the index only constrains active rows.
  perform delete_account_atomic(first.id, current_setting('test.user_a')::uuid, false);
  perform create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('5', 64),
    'Rebound', 'paper', '#123456', 'AK', 'AS', 'PA-BINDING-DUP');
end $$;

-- ---------------------------------------------------------------------------
-- 2. A committed retry resolves without a fresh broker round trip.
--
-- The service used to validate the keys against Alpaca *before* asking the
-- ledger anything. During an Alpaca outage a retry of an already-committed
-- request therefore failed at validation and never reached the ledger — the
-- one case idempotence exists for. This asserts the database half: the answer
-- is available from the ledger alone.
-- ---------------------------------------------------------------------------
do $$
declare
  op      uuid := gen_random_uuid();
  fp      text := repeat('a', 64);
  made    accounts;
  answer  jsonb;
begin
  made := create_account_operation(
    current_setting('test.user_a')::uuid, op, fp,
    'Outage retry', 'paper', '#123456', 'AK', 'AS', 'PA-OUTAGE-1');

  answer := resolve_create_operation(current_setting('test.user_a')::uuid, op, fp);
  if answer ->> 'outcome' <> 'created' then
    raise exception 'FAIL: a committed operation did not resolve as created';
  end if;
  if (answer ->> 'account_id')::uuid <> made.id then
    raise exception 'FAIL: the resolver named a different account';
  end if;

  -- Same id, different request: an explicit conflict, never the original row
  -- returned as a success.
  if (resolve_create_operation(current_setting('test.user_a')::uuid, op,
        repeat('f', 64)) ->> 'outcome') <> 'conflict' then
    raise exception 'FAIL: a different request under a used id was not a conflict';
  end if;
  if (resolve_create_operation(current_setting('test.user_b')::uuid, op, fp)
        ->> 'outcome') <> 'conflict' then
    raise exception 'FAIL: another owner resolved this operation';
  end if;

  -- A fingerprint is mandatory: an optional check is not a check.
  declare blocked boolean := false;
  begin
    begin
      perform resolve_create_operation(current_setting('test.user_a')::uuid, op, null);
    exception when others then blocked := true; end;
    if not blocked then
      raise exception 'FAIL: the resolver answered without a fingerprint';
    end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The latest verification token wins, and an old one cannot.
-- ---------------------------------------------------------------------------
do $$
declare
  acct    accounts;
  first   jsonb;
  second  jsonb;
  blocked boolean := false;
  msg     text;
begin
  acct := create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('6', 64),
    'Token order', 'paper', '#123456', 'AK', 'AS', 'PA-TOKEN-ORDER');
  -- Creation records `connected`, so the refusal below is measured against
  -- `last_verified_at` rather than the status it already has.
  update accounts set status = 'unverified', last_verified_at = null
   where id = acct.id;

  first  := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
  second := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);

  if (second ->> 'generation')::bigint <= (first ->> 'generation')::bigint then
    raise exception 'FAIL: the second begin did not advance the generation';
  end if;

  -- Exactly one token is outstanding, enforced by the index rather than by
  -- the function remembering to clean up.
  if (select count(*) from account_verification_token
       where account_id = acct.id
         and consumed_at is null and superseded_at is null and cancelled_at is null)
     <> 1 then
    raise exception 'FAIL: more than one token is outstanding for the account';
  end if;

  begin
    perform finish_account_verification(
      (first ->> 'token')::uuid, 'connected', 'PA-TOKEN-ORDER');
  exception when others then blocked := true; msg := sqlerrm; end;
  if not blocked then
    raise exception 'FAIL: a superseded token still wrote a verification';
  end if;
  if msg not like '%superseded%' then
    raise exception 'FAIL: unexpected refusal of the older token: %', msg;
  end if;
  if (select status from accounts where id = acct.id) <> 'unverified'
     or (select last_verified_at from accounts where id = acct.id) is not null then
    raise exception 'FAIL: the refused older token changed the account';
  end if;

  -- The newest one works.
  perform finish_account_verification(
    (second ->> 'token')::uuid, 'connected', 'PA-TOKEN-ORDER');
  if (select status from accounts where id = acct.id) <> 'connected' then
    raise exception 'FAIL: the current token did not record the verification';
  end if;

  -- And it is single use.
  blocked := false;
  begin
    perform finish_account_verification(
      (second ->> 'token')::uuid, 'connected', 'PA-TOKEN-ORDER');
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a consumed token was accepted a second time';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. An old token expires; a future-dated one is refused.
-- ---------------------------------------------------------------------------
do $$
declare
  acct    accounts;
  issued  jsonb;
  blocked boolean := false;
  msg     text;
begin
  acct := create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('7', 64),
    'Token age', 'paper', '#123456', 'AK', 'AS', 'PA-TOKEN-AGE');

  -- Thirty days old. The token carries one broker round trip; a month later it
  -- describes a snapshot nothing has held since.
  issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
  update account_verification_token
     set issued_at = now() - interval '30 days'
   where token = (issued ->> 'token')::uuid;

  begin
    perform finish_account_verification(
      (issued ->> 'token')::uuid, 'connected', 'PA-TOKEN-AGE');
  exception when others then blocked := true; msg := sqlerrm; end;
  if not blocked or msg not like '%expired%' then
    raise exception 'FAIL: a thirty-day-old token was accepted (%)', msg;
  end if;

  -- A token dated in the future cannot have carried a completed round trip.
  issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
  update account_verification_token
     set issued_at = now() + interval '1 hour'
   where token = (issued ->> 'token')::uuid;
  blocked := false;
  begin
    perform finish_account_verification(
      (issued ->> 'token')::uuid, 'connected', 'PA-TOKEN-AGE');
  exception when others then blocked := true; msg := sqlerrm; end;
  if not blocked or msg not like '%future%' then
    raise exception 'FAIL: a future-dated token was accepted (%)', msg;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. `finish` writes only what a broker round trip can conclude.
-- ---------------------------------------------------------------------------
do $$
declare
  acct    accounts;
  issued  jsonb;
  blocked boolean;
  msg     text;
  want    account_status;
begin
  acct := create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('8', 64),
    'Token status', 'paper', '#123456', 'AK', 'AS', 'PA-TOKEN-STATUS');
  update accounts set status = 'unverified' where id = acct.id;

  -- `unverified` is the initial state and `paused` is an operator decision.
  -- Neither is something asking Alpaca can establish.
  foreach want in array array['unverified', 'paused']::account_status[] loop
    issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
    blocked := false;
    begin
      perform finish_account_verification((issued ->> 'token')::uuid, want, null);
    exception when others then blocked := true; end;
    if not blocked then
      raise exception 'FAIL: a broker round trip wrote %', want;
    end if;
    perform cancel_account_verification((issued ->> 'token')::uuid, 'abandoned');
  end loop;

  -- `connected` without a number does not establish a binding.
  issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
  blocked := false;
  begin
    perform finish_account_verification((issued ->> 'token')::uuid, 'connected', null);
  exception when others then blocked := true; msg := sqlerrm; end;
  if not blocked then
    raise exception 'FAIL: connected was written with no broker account number';
  end if;
  blocked := false;
  begin
    perform finish_account_verification((issued ->> 'token')::uuid, 'connected', '   ');
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: connected was written with a blank broker account number';
  end if;

  -- `auth_failed` needs none: nothing about the binding was learned.
  perform finish_account_verification((issued ->> 'token')::uuid, 'auth_failed', null);
  if (select a.status from accounts a where a.id = acct.id) <> 'auth_failed' then
    raise exception 'FAIL: auth_failed was not recorded';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Cancelling closes a token that concluded nothing.
-- ---------------------------------------------------------------------------
do $$
declare
  acct    accounts;
  issued  jsonb;
  blocked boolean := false;
  reason  text;
begin
  acct := create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('9', 64),
    'Token cancel', 'paper', '#123456', 'AK', 'AS', 'PA-TOKEN-CANCEL');
  update accounts set status = 'unverified' where id = acct.id;

  -- Each way a round trip can end with no answer.
  foreach reason in array array[
    'network_error', 'timeout', 'broker_unavailable', 'malformed_response'
  ] loop
    issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
    if not cancel_account_verification((issued ->> 'token')::uuid, reason) then
      raise exception 'FAIL: cancelling an outstanding token reported nothing done';
    end if;
    -- Idempotent: a client retrying its own cancellation is not a fault.
    if cancel_account_verification((issued ->> 'token')::uuid, reason) then
      raise exception 'FAIL: cancelling twice reported two closures';
    end if;
    -- Nothing was concluded, so nothing was written about the credentials.
    if (select status from accounts where id = acct.id) <> 'unverified' then
      raise exception 'FAIL: a cancellation changed the account status';
    end if;
    -- And the cancelled token cannot then finish.
    blocked := false;
    begin
      perform finish_account_verification(
        (issued ->> 'token')::uuid, 'connected', 'PA-TOKEN-CANCEL');
    exception when others then blocked := true; end;
    if not blocked then
      raise exception 'FAIL: a cancelled token still wrote a verification';
    end if;
  end loop;

  -- A reason outside the set is refused: it lands in an owner-readable row.
  issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
  blocked := false;
  begin
    perform cancel_account_verification((issued ->> 'token')::uuid,
      'because the operator felt like it');
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a free-form cancellation reason was accepted';
  end if;
  perform cancel_account_verification((issued ->> 'token')::uuid, 'abandoned');

  -- A consumed token concluded something; cancelling afterwards would claim it
  -- did not.
  issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);
  perform finish_account_verification(
    (issued ->> 'token')::uuid, 'connected', 'PA-TOKEN-CANCEL');
  blocked := false;
  begin
    perform cancel_account_verification((issued ->> 'token')::uuid, 'abandoned');
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a consumed token was cancelled after the fact';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. The audit guard is permanent, not a one-off scan.
-- ---------------------------------------------------------------------------
do $$
declare
  blocked boolean;
  bad     jsonb;
begin
  foreach bad in array array[
    -- A raw UUID anywhere, at any depth.
    jsonb_build_object('note', gen_random_uuid()::text),
    jsonb_build_object('nested', jsonb_build_object('id', gen_random_uuid()::text)),
    jsonb_build_object('items', jsonb_build_array(gen_random_uuid()::text)),
    -- A forbidden key, whatever it holds.
    jsonb_build_object('secret_id', 'redacted'),
    jsonb_build_object('vault_ref', 'x'),
    jsonb_build_object('token', 'x'),
    jsonb_build_object('operation_id', 'x'),
    jsonb_build_object('api_key', 'x'),
    jsonb_build_object('account_number', 'PA-1234'),
    jsonb_build_object('outer', jsonb_build_object('secret_id', 'x'))
  ] loop
    blocked := false;
    begin
      insert into audit_log (actor_id, account_id, action, detail)
      values (current_setting('test.user_a')::uuid, null, 'test.guard', bad);
    exception when others then blocked := true; end;
    if not blocked then
      raise exception 'FAIL: the audit guard accepted %', bad;
    end if;
  end loop;

  -- The sanctioned shape still writes: a digest is not a UUID, and the keys
  -- the real functions use are not forbidden ones.
  insert into audit_log (actor_id, account_id, action, detail)
  values (
    current_setting('test.user_a')::uuid, null, 'test.guard',
    jsonb_build_object(
      'mode', 'paper',
      'operation_digest', substr(md5(gen_random_uuid()::text), 1, 16),
      'pair_digest', substr(md5('x'), 1, 16),
      'reason', 'operator_cleanup'
    )
  );

  -- An update cannot smuggle one in either.
  blocked := false;
  begin
    update audit_log
       set detail = jsonb_build_object('note', gen_random_uuid()::text)
     where action = 'test.guard';
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: the audit guard did not cover updates';
  end if;

  delete from audit_log where action = 'test.guard';
end $$;

select 'TOKEN AND BINDING OK' as result;

rollback;
