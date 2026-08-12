-- ============================================================================
-- 0023 assertions: the audit guard's traversal, and the token deadline.
--
-- Every block fails on 0022. The array cases fail there by *hanging until the
-- stack runs out* (`54001`), which is the worst available failure for a guard
-- on `audit_log`: the operation being audited is rolled back with an error
-- that says nothing about what was wrong with it.
--
-- Each refusal names the SQLSTATE it expects. "Some error was raised" is what
-- made the previous round's guard assertions vacuous once the RPC underneath
-- them changed.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

select set_config('test.user_a', :'user_a', true);
select set_config('test.user_b', :'user_b', true);

-- ---------------------------------------------------------------------------
-- 1. The traversal terminates, and covers arrays at any depth.
-- ---------------------------------------------------------------------------
do $$
declare
  probe   jsonb;
  ok      boolean;
begin
  -- These three all died with 54001 on 0022: the array branch re-wrapped its
  -- own value in `{"items": ...}` and called itself with a value of the same
  -- shape.
  foreach probe in array array[
    jsonb_build_object('symbols', jsonb_build_array('AAPL', 'MSFT')),
    jsonb_build_object('rows', jsonb_build_array(1, 2, 3), 'removed', 2),
    jsonb_build_object('nested', jsonb_build_array(jsonb_build_array('a', 'b'))),
    jsonb_build_object('mixed', jsonb_build_array(
      jsonb_build_object('mode', 'paper'), 'x', 7, true, null))
  ] loop
    begin
      ok := audit_detail_is_publishable(probe);
    exception when others then
      raise exception 'FAIL: the guard raised % on a benign document %',
        sqlstate, probe;
    end;
    if not ok then
      raise exception 'FAIL: the guard refused a benign document %', probe;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. What must be refused, at every position the traversal can reach.
-- ---------------------------------------------------------------------------
do $$
declare
  probe jsonb;
  uuid_text text := '00000000-1111-4111-8111-000000000000';
begin
  foreach probe in array array[
    -- A forbidden key, nested inside two arrays. Unreachable on 0022.
    jsonb_build_object('items', jsonb_build_array(
      jsonb_build_array(jsonb_build_object('secret_id', 'leaked')))),
    -- A UUID inside an array of strings.
    jsonb_build_object('notes', jsonb_build_array('x', uuid_text)),
    -- A UUID inside an object inside an array.
    jsonb_build_object('rows', jsonb_build_array(
      jsonb_build_object('ref', uuid_text))),
    -- A UUID used as a *key*: only values were ever scanned.
    jsonb_build_object(uuid_text, 'x'),
    -- A UUID as a key, nested.
    jsonb_build_object('outer', jsonb_build_object(uuid_text, 'x')),
    -- A broker account number under an innocuous key.
    jsonb_build_object('note', 'PA3ABCDEF12345'),
    -- ...and inside an array.
    jsonb_build_object('history', jsonb_build_array('PA3ABCDEF12345')),
    -- ...and as a key.
    jsonb_build_object('PA3ABCDEF12345', 'x'),
    -- The keys 0022 already covered, still covered.
    jsonb_build_object('token', 'x'),
    jsonb_build_object('operation_id', 'x'),
    jsonb_build_object('api_key', 'x'),
    jsonb_build_object('vault_ref', 'x')
  ] loop
    if audit_detail_is_publishable(probe) then
      raise exception 'FAIL: the guard accepted %', probe;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. A stored binding is refused even when it takes no recognisable shape.
-- ---------------------------------------------------------------------------
do $$
declare
  acct accounts;
begin
  -- A number that the shape rule would miss entirely: no `PA` prefix, just
  -- digits. It is refused because it *is* a binding this database holds.
  acct := create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('1', 64),
    'Shapeless binding', 'paper', '#123456', 'AK', 'AS', '987654321');

  if audit_detail_is_publishable(jsonb_build_object('note', '987654321')) then
    raise exception 'FAIL: a stored broker binding was publishable';
  end if;
  if audit_detail_is_publishable(
       jsonb_build_object('trail', jsonb_build_array('987654321'))) then
    raise exception 'FAIL: a stored broker binding inside an array was publishable';
  end if;

  -- A soft delete *clears* the number (0013 onward), so after it there is no
  -- stored binding left for the guard to recognise — and nothing left on the
  -- row to leak either. Asserting the clearing is the honest form of the
  -- invariant; asserting continued refusal would be asserting a lookup against
  -- data that no longer exists.
  perform delete_account_atomic(acct.id, current_setting('test.user_a')::uuid, false);
  if (select alpaca_account_number from accounts where id = acct.id) is not null then
    raise exception 'FAIL: the soft delete left the broker binding on the row';
  end if;

  -- A number that is neither stored nor PA-shaped is not a binding.
  if not audit_detail_is_publishable(jsonb_build_object('count', '42')) then
    raise exception 'FAIL: an ordinary number was treated as a binding';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Budgets are refusals, not crashes.
-- ---------------------------------------------------------------------------
do $$
declare
  deep jsonb := jsonb_build_object('leaf', 'x');
  wide jsonb;
  i    integer;
begin
  -- Deeper than the depth budget. On 0022 this recursed until the stack died.
  for i in 1..(audit_detail_max_depth() + 5) loop
    deep := jsonb_build_object('a', deep);
  end loop;
  if audit_detail_is_publishable(deep) then
    raise exception 'FAIL: a document past the depth budget was accepted';
  end if;

  -- A document just inside the budget is still read, not refused wholesale.
  deep := jsonb_build_object('leaf', 'x');
  for i in 1..3 loop
    deep := jsonb_build_object('a', deep);
  end loop;
  if not audit_detail_is_publishable(deep) then
    raise exception 'FAIL: an ordinary nested document was refused';
  end if;

  -- Wider than the node budget.
  select jsonb_object_agg('k' || n, n) into wide
    from generate_series(1, audit_detail_max_nodes() + 50) n;
  if audit_detail_is_publishable(wide) then
    raise exception 'FAIL: a document past the node budget was accepted';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. A bare scalar or array is not an audit detail.
-- ---------------------------------------------------------------------------
do $$
begin
  if audit_detail_is_publishable('"just a string"'::jsonb) then
    raise exception 'FAIL: a bare string was accepted as a detail';
  end if;
  if audit_detail_is_publishable('[1,2,3]'::jsonb) then
    raise exception 'FAIL: a bare array was accepted as a detail';
  end if;
  if not audit_detail_is_publishable(null) then
    raise exception 'FAIL: a null detail was refused';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. The trigger refuses with P0001, and lets the sanctioned shape through.
-- ---------------------------------------------------------------------------
do $$
declare
  state text;
begin
  begin
    insert into audit_log (actor_id, account_id, action, detail)
    values (current_setting('test.user_a')::uuid, null, 'test.guard',
            jsonb_build_object('items', jsonb_build_array(
              jsonb_build_array(jsonb_build_object('secret_id', 'leaked')))));
    raise exception 'FAIL: the trigger accepted a nested forbidden key';
  exception when others then
    state := sqlstate;
    if state = 'P0001' and sqlerrm like 'FAIL:%' then raise; end if;
  end;
  if state <> 'P0001' then
    raise exception 'FAIL: the trigger gave % (expected P0001, and 54001 is the 0022 bug)', state;
  end if;

  -- A benign array now writes. On 0022 this was 54001.
  insert into audit_log (actor_id, account_id, action, detail)
  values (current_setting('test.user_a')::uuid, null, 'test.guard',
          jsonb_build_object('symbols', jsonb_build_array('AAPL', 'MSFT'),
                             'removed', 2));
  delete from audit_log where action = 'test.guard';
end $$;

-- ---------------------------------------------------------------------------
-- 7. The deadline is stored, and a lock wait cannot outlive it.
--
-- This is the single-connection half: the deadline is compared against
-- `clock_timestamp()` rather than `now()`, so time that passes *inside* the
-- transaction counts. `run_concurrency.sh` runs the two-connection form, where
-- the wait is a real lock wait.
-- ---------------------------------------------------------------------------
do $$
declare
  acct     accounts;
  issued   jsonb;
  stored   timestamptz;
  state    text;
begin
  acct := create_account_operation(
    current_setting('test.user_a')::uuid, gen_random_uuid(), repeat('2', 64),
    'Deadline', 'paper', '#123456', 'AK', 'AS', 'PA-DEADLINE-1');
  update accounts set status = 'unverified' where id = acct.id;

  issued := begin_account_verification(acct.id, current_setting('test.user_a')::uuid);

  -- The deadline is a recorded fact, returned to the caller and stored.
  select expires_at into stored
    from account_verification_token where token = (issued ->> 'token')::uuid;
  if stored is null then
    raise exception 'FAIL: the token carries no stored deadline';
  end if;
  if (issued ->> 'expires_at')::timestamptz <> stored then
    raise exception 'FAIL: the returned deadline is not the stored one';
  end if;

  -- Move the deadline into the past *within this transaction*. `now()` has not
  -- advanced since the transaction began, so a check written against it still
  -- sees a fresh token; `clock_timestamp()` sees an expired one.
  update account_verification_token
     set expires_at = clock_timestamp() - interval '1 second'
   where token = (issued ->> 'token')::uuid;

  begin
    perform finish_account_verification(
      (issued ->> 'token')::uuid, 'connected', 'PA-DEADLINE-1');
    raise exception 'FAIL: an expired token was accepted';
  exception when others then
    state := sqlstate;
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  if state <> 'P0001' then
    raise exception 'FAIL: an expired token gave % (expected P0001)', state;
  end if;
  if (select status from accounts where id = acct.id) <> 'unverified' then
    raise exception 'FAIL: the refused finish still changed the account';
  end if;
end $$;

select 'AUDIT GUARD AND DEADLINE OK' as result;

rollback;
