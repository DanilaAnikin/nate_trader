-- ============================================================================
-- broker_refresh.test.sql — a refresh may never delete, and a token is bound
-- to the credentials it was issued against.
--
-- The central property, stated once: **`publish_broker_refresh` has no code
-- path that removes a row.** Every test below that used to assert "the right
-- rows were deleted" now asserts "nothing was deleted and the transaction was
-- refused", because no payload can distinguish a genuine retraction from a
-- partial response, and guessing costs real history.
--
--   psql "$DATABASE_URL" \
--     -v user_a='...' -v user_b='...' -f supabase/tests/broker_refresh.test.sql
--
-- A clean run prints "BROKER REFRESH OK" and rolls back.
-- ============================================================================

begin;

select set_config('test.user_a', :'user_a', true);
select set_config('test.user_b', :'user_b', true);

select vault.create_secret('REFRESH-KEY', 'refresh-key') as key_id \gset
select vault.create_secret('REFRESH-SECRET', 'refresh-secret') as secret_id \gset

insert into accounts (
  id, owner_id, nickname, mode, status, alpaca_account_number,
  alpaca_key_secret_id, alpaca_secret_secret_id
)
values (
  'ffffffff-0000-0000-0000-0000000000a1', :'user_a', 'Refresh', 'paper',
  'connected', 'PA-REFRESH-7777', :'key_id', :'secret_id'
);

-- One hundred mirrored days: the exact scale of the reproduction in 0018's
-- header, where an incoming payload of 99 was inside the old allowance and
-- deleted the missing day.
insert into equity_snapshots (account_id, snapshot_date, equity, cash, source)
select 'ffffffff-0000-0000-0000-0000000000a1',
       date '2026-03-02' + (n || ' days')::interval,
       1000000 + n, 0, 'alpaca_portfolio_history'
from generate_series(0, 99) as n;

insert into cash_flows (account_id, flow_date, amount, kind, source, external_id)
select 'ffffffff-0000-0000-0000-0000000000a1',
       date '2026-03-02' + (n || ' days')::interval,
       10, 'deposit', 'alpaca_activities', 'act-' || n
from generate_series(0, 2) as n;

-- A row this mirror did not write must survive every reconciliation below.
insert into equity_snapshots (account_id, snapshot_date, equity, cash, source)
values (
  'ffffffff-0000-0000-0000-0000000000a1', date '2026-01-05', 900000, 0, 'agent'
);

-- Helpers producing exactly the payload shape the RPC validates.
create or replace function test_equity_payload(p_days int[])
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'snapshot_date', (date '2026-03-02' + (d || ' days')::interval)::date,
           'equity', 1000000 + d,
           'cash', 0,
           'profit_loss', null,
           'profit_loss_pct', null
         ) order by d), '[]'::jsonb)
  from unnest(p_days) as d;
$$;

create or replace function test_flow_payload(p_ids int[])
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'external_id', 'act-' || i,
           'flow_date', (date '2026-03-02' + (i || ' days')::interval)::date,
           'amount', 10,
           'kind', 'deposit'
         ) order by i), '[]'::jsonb)
  from unnest(p_ids) as i;
$$;

/** All 100 mirrored days, and all three mirrored flows. */
create or replace function test_full_equity() returns jsonb language sql stable as $$
  select test_equity_payload(array(select generate_series(0, 99)));
$$;
create or replace function test_full_flows() returns jsonb language sql stable as $$
  select test_flow_payload(array[0, 1, 2]);
$$;

/** A fresh token for the fixture account. */
create or replace function test_token() returns uuid language sql as $$
  select (begin_broker_refresh(
            'ffffffff-0000-0000-0000-0000000000a1',
            current_setting('test.user_a')::uuid
          ) ->> 'token')::uuid;
$$;

/** Row counts, so "nothing was written" is a measurement rather than a hope. */
create or replace function test_counts() returns text language sql stable as $$
  select format('%s/%s/%s',
    (select count(*) from equity_snapshots
      where account_id = 'ffffffff-0000-0000-0000-0000000000a1'),
    (select count(*) from cash_flows
      where account_id = 'ffffffff-0000-0000-0000-0000000000a1'),
    (select coalesce(sum(equity), 0) from equity_snapshots
      where account_id = 'ffffffff-0000-0000-0000-0000000000a1'));
$$;

-- --- 1. every argument is required, and nothing is touched ------------------
do $$
declare
  tok      uuid;
  blocked  boolean;
  before_  text := test_counts();
  attempts text[] := '{}';
begin
  tok := test_token();

  begin
    perform publish_broker_refresh(null, test_full_equity(), true,
      test_full_flows(), date '2026-03-02', true, 3, true);
    attempts := attempts || 'null token accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, null, true,
      test_full_flows(), date '2026-03-02', true, 3, true);
    attempts := attempts || 'null equity accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, test_full_equity(), null,
      test_full_flows(), date '2026-03-02', true, 3, true);
    attempts := attempts || 'null completeness accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, test_full_equity(), true,
      null, date '2026-03-02', true, 3, true);
    attempts := attempts || 'null flows accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, test_full_equity(), true,
      test_full_flows(), null, true, 3, true);
    attempts := attempts || 'null window accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, test_full_equity(), true,
      test_full_flows(), date '2026-03-02', true, null, true);
    attempts := attempts || 'null scanned accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, test_full_equity(), true,
      test_full_flows(), date '2026-03-02', true, 3, null);
    attempts := attempts || 'null terminal-page flag accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, '{"not":"an array"}'::jsonb, true,
      test_full_flows(), date '2026-03-02', true, 3, true);
    attempts := attempts || 'a non-array equity payload accepted';
  exception when others then null; end;

  begin
    perform publish_broker_refresh(tok, test_full_equity(), false,
      test_full_flows(), date '2026-03-02', true, 3, true);
    attempts := attempts || 'an incomplete equity payload accepted';
  exception when others then null; end;

  -- `page_size` is a maximum, not an EOF marker. A walk that never saw an
  -- explicit empty page did not reach the end of the feed.
  begin
    perform publish_broker_refresh(tok, test_full_equity(), true,
      test_full_flows(), date '2026-03-02', true, 3, false);
    attempts := attempts || 'a walk with no terminal empty page accepted';
  exception when others then null; end;

  -- More rows than activities examined is arithmetically impossible.
  begin
    perform publish_broker_refresh(tok, test_full_equity(), true,
      test_full_flows(), date '2026-03-02', true, 1, true);
    attempts := attempts || 'more rows than scanned activities accepted';
  exception when others then null; end;

  if array_length(attempts, 1) is not null then
    raise exception 'FAIL: %', array_to_string(attempts, '; ');
  end if;
  if test_counts() <> before_ then
    raise exception 'FAIL: a rejected publish changed the mirror (% -> %)',
      before_, test_counts();
  end if;
end $$;

-- --- 2. stored 100, incoming 99: no mutation --------------------------------
-- The exact reproduction from 0018's header. Under 0017 this succeeded and
-- deleted the omitted day, because a shrink of one was inside the allowance.
do $$
declare
  before_ text := test_counts();
  blocked boolean := false;
  msg     text;
begin
  begin
    perform publish_broker_refresh(
      test_token(),
      -- Every day except 2026-04-01 (offset 30): a valid day simply omitted.
      test_equity_payload(array(select g from generate_series(0, 99) g where g <> 30)),
      true,
      test_full_flows(), date '2026-03-02', true, 3, true
    );
  exception when others then
    blocked := true;
    msg := sqlerrm;
  end;

  if not blocked then
    raise exception
      'FAIL: a payload of 99 against 100 stored days was accepted';
  end if;
  if msg not like '%RECONCILIATION_CONFLICT%' then
    raise exception 'FAIL: expected RECONCILIATION_CONFLICT, got %', msg;
  end if;
  if test_counts() <> before_ then
    raise exception 'FAIL: the mirror changed (% -> %)', before_, test_counts();
  end if;
  if not exists (
    select 1 from equity_snapshots
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and snapshot_date = date '2026-04-01'
  ) then
    raise exception 'FAIL: the omitted day was deleted';
  end if;
end $$;

-- --- 3. a first-load partial response claims nothing -------------------------
-- Ten days out of a hundred, flagged complete. Nothing about this payload is
-- distinguishable from a broker that truncated its answer.
do $$
declare
  before_ text := test_counts();
  blocked boolean := false;
begin
  begin
    perform publish_broker_refresh(
      test_token(),
      test_equity_payload(array(select generate_series(90, 99))), true,
      test_full_flows(), date '2026-03-02', true, 3, true
    );
  exception when others then blocked := true; end;

  if not blocked then
    raise exception 'FAIL: a 10-of-100 payload was accepted';
  end if;
  if test_counts() <> before_ then
    raise exception 'FAIL: a truncated payload changed the mirror';
  end if;
end $$;

-- --- 4. an empty portfolio history is not a tombstone ------------------------
do $$
declare
  before_ text := test_counts();
  blocked boolean := false;
begin
  begin
    perform publish_broker_refresh(
      test_token(), '[]'::jsonb, true,
      test_full_flows(), date '2026-03-02', true, 3, true
    );
  exception when others then blocked := true; end;

  if not blocked then
    raise exception 'FAIL: an empty portfolio history emptied the mirror';
  end if;
  if test_counts() <> before_ then
    raise exception 'FAIL: an empty payload changed the mirror';
  end if;
end $$;

-- --- 5. flows = [] with scanned = 1 leaves the ledger alone ------------------
-- Under 0017 this deleted the whole ledger: "we examined one activity" was
-- accepted as proof that the three mirrored ones were withdrawn.
do $$
declare
  before_ text := test_counts();
  blocked boolean := false;
  msg     text;
begin
  begin
    perform publish_broker_refresh(
      test_token(), test_full_equity(), true,
      '[]'::jsonb, date '2026-03-02', true, 1, true
    );
  exception when others then
    blocked := true;
    msg := sqlerrm;
  end;

  if not blocked then
    raise exception 'FAIL: an empty activity walk emptied the ledger';
  end if;
  if msg not like '%RECONCILIATION_CONFLICT%' then
    raise exception 'FAIL: expected RECONCILIATION_CONFLICT, got %', msg;
  end if;
  if (select count(*) from cash_flows
       where account_id = 'ffffffff-0000-0000-0000-0000000000a1') <> 3 then
    raise exception 'FAIL: the ledger lost rows';
  end if;
  if test_counts() <> before_ then
    raise exception 'FAIL: the mirror changed';
  end if;
end $$;

-- --- 6. an examined empty walk is still not a tombstone ----------------------
-- Even with a large `scanned`, absence is not withdrawal.
do $$
declare
  before_ text := test_counts();
  blocked boolean := false;
begin
  begin
    perform publish_broker_refresh(
      test_token(), test_full_equity(), true,
      '[]'::jsonb, date '2026-03-02', true, 5000, true
    );
  exception when others then blocked := true; end;

  if not blocked then
    raise exception 'FAIL: a well-examined empty walk emptied the ledger';
  end if;
  if test_counts() <> before_ then
    raise exception 'FAIL: the mirror changed';
  end if;
end $$;

-- --- 7. the complete payload publishes, and removes nothing ------------------
do $$
declare
  outcome jsonb;
begin
  outcome := publish_broker_refresh(
    test_token(), test_full_equity(), true,
    test_full_flows(), date '2026-03-02', true, 3, true
  );
  if (outcome ->> 'equity_written')::int <> 100 then
    raise exception 'FAIL: expected 100 equity rows written, got %',
      outcome ->> 'equity_written';
  end if;
  if (outcome ->> 'equity_removed')::int <> 0
     or (outcome ->> 'flows_removed')::int <> 0 then
    raise exception 'FAIL: a publish reported removals';
  end if;
  -- The `agent`-sourced row this mirror never wrote is untouched, as always.
  if not exists (
    select 1 from equity_snapshots
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and source = 'agent'
  ) then
    raise exception 'FAIL: a foreign-sourced row was removed';
  end if;
end $$;

-- --- 8. per-row validation, before the first mutation ------------------------
do $$
declare
  before_  text := test_counts();
  attempts text[] := '{}';
  tok      uuid;

  procedure_failed boolean;
begin
  -- Each case builds a payload that is complete except for one bad row, so
  -- the only reason to refuse it is the row itself.
  declare
    cases jsonb[] := array[
      -- an extra key
      test_full_equity() || jsonb_build_array(jsonb_build_object(
        'snapshot_date', '2026-06-11', 'equity', 1, 'cash', 0,
        'profit_loss', null, 'profit_loss_pct', null, 'extra', 1)),
      -- a missing key
      test_full_equity() || jsonb_build_array(jsonb_build_object(
        'snapshot_date', '2026-06-11', 'equity', 1, 'cash', 0,
        'profit_loss', null)),
      -- an impossible calendar date
      test_full_equity() || jsonb_build_array(jsonb_build_object(
        'snapshot_date', '2026-02-30', 'equity', 1, 'cash', 0,
        'profit_loss', null, 'profit_loss_pct', null)),
      -- a non-positive equity
      test_full_equity() || jsonb_build_array(jsonb_build_object(
        'snapshot_date', '2026-06-11', 'equity', 0, 'cash', 0,
        'profit_loss', null, 'profit_loss_pct', null)),
      -- equity as a string
      test_full_equity() || jsonb_build_array(jsonb_build_object(
        'snapshot_date', '2026-06-11', 'equity', '1000', 'cash', 0,
        'profit_loss', null, 'profit_loss_pct', null)),
      -- profit_loss as a string
      test_full_equity() || jsonb_build_array(jsonb_build_object(
        'snapshot_date', '2026-06-11', 'equity', 1, 'cash', 0,
        'profit_loss', 'n/a', 'profit_loss_pct', null)),
      -- a duplicate session date
      test_full_equity() || jsonb_build_array(jsonb_build_object(
        'snapshot_date', '2026-03-02', 'equity', 1, 'cash', 0,
        'profit_loss', null, 'profit_loss_pct', null)),
      -- a scalar where an object belongs
      test_full_equity() || jsonb_build_array(42)
    ];
    labels text[] := array[
      'extra key', 'missing key', '2026-02-30', 'zero equity',
      'string equity', 'string profit_loss', 'duplicate date', 'scalar row'
    ];
    i int;
  begin
    for i in 1 .. array_length(cases, 1) loop
      procedure_failed := false;
      begin
        perform publish_broker_refresh(
          test_token(), cases[i], true,
          test_full_flows(), date '2026-03-02', true, 3, true
        );
      exception when others then procedure_failed := true; end;
      if not procedure_failed then
        attempts := attempts || format('equity payload with %s accepted', labels[i]);
      end if;
    end loop;
  end;

  declare
    flow_cases jsonb[] := array[
      -- a duplicate external id
      test_full_flows() || jsonb_build_array(jsonb_build_object(
        'external_id', 'act-0', 'flow_date', '2026-03-02',
        'amount', 5, 'kind', 'deposit')),
      -- a zero amount
      test_full_flows() || jsonb_build_array(jsonb_build_object(
        'external_id', 'act-9', 'flow_date', '2026-03-02',
        'amount', 0, 'kind', 'deposit')),
      -- a kind outside the allowed set
      test_full_flows() || jsonb_build_array(jsonb_build_object(
        'external_id', 'act-9', 'flow_date', '2026-03-02',
        'amount', 5, 'kind', 'fee')),
      -- a negative deposit
      test_full_flows() || jsonb_build_array(jsonb_build_object(
        'external_id', 'act-9', 'flow_date', '2026-03-02',
        'amount', -5, 'kind', 'deposit')),
      -- a flow before the declared window
      test_full_flows() || jsonb_build_array(jsonb_build_object(
        'external_id', 'act-9', 'flow_date', '2026-01-01',
        'amount', 5, 'kind', 'deposit')),
      -- an empty external id
      test_full_flows() || jsonb_build_array(jsonb_build_object(
        'external_id', '', 'flow_date', '2026-03-02',
        'amount', 5, 'kind', 'deposit'))
    ];
    flow_labels text[] := array[
      'duplicate external_id', 'zero amount', 'disallowed kind',
      'negative deposit', 'out-of-window date', 'blank external_id'
    ];
    i int;
  begin
    for i in 1 .. array_length(flow_cases, 1) loop
      procedure_failed := false;
      begin
        perform publish_broker_refresh(
          test_token(), test_full_equity(), true,
          flow_cases[i], date '2026-03-02', true, 9, true
        );
      exception when others then procedure_failed := true; end;
      if not procedure_failed then
        attempts := attempts || format('flow payload with %s accepted', flow_labels[i]);
      end if;
    end loop;
  end;

  if array_length(attempts, 1) is not null then
    raise exception 'FAIL: %', array_to_string(attempts, '; ');
  end if;
  if test_counts() <> before_ then
    raise exception 'FAIL: a rejected payload changed the mirror';
  end if;
end $$;

-- --- 9. two refreshes completing in the wrong order ---------------------------
do $$
declare
  tok_a   uuid;
  tok_b   uuid;
  blocked boolean := false;
begin
  tok_a := test_token();
  tok_b := test_token();

  -- B publishes first, adding one new day.
  perform publish_broker_refresh(
    tok_b,
    test_full_equity() || jsonb_build_array(jsonb_build_object(
      'snapshot_date', '2026-06-10', 'equity', 1000200, 'cash', 0,
      'profit_loss', null, 'profit_loss_pct', null)),
    true, test_full_flows(), date '2026-03-02', true, 3, true
  );

  -- A now arrives late, without B's new day. It is refused twice over: the
  -- generation is older, and its payload omits a stored row.
  begin
    perform publish_broker_refresh(
      tok_a, test_full_equity(), true,
      test_full_flows(), date '2026-03-02', true, 3, true
    );
  exception when others then blocked := true; end;

  if not blocked then
    raise exception 'FAIL: a stale generation overwrote a newer refresh';
  end if;
  if not exists (
    select 1 from equity_snapshots
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and snapshot_date = date '2026-06-10'
  ) then
    raise exception 'FAIL: the late refresh removed the newer day';
  end if;
end $$;

-- --- 10. a token is single-use ------------------------------------------------
do $$
declare
  tok     uuid := test_token();
  blocked boolean := false;
begin
  perform publish_broker_refresh(
    tok,
    test_full_equity() || jsonb_build_array(
      jsonb_build_object('snapshot_date', '2026-06-10', 'equity', 1000200,
        'cash', 0, 'profit_loss', null, 'profit_loss_pct', null)),
    true, test_full_flows(), date '2026-03-02', true, 3, true
  );
  begin
    perform publish_broker_refresh(
      tok,
      test_full_equity() || jsonb_build_array(
        jsonb_build_object('snapshot_date', '2026-06-10', 'equity', 1000200,
          'cash', 0, 'profit_loss', null, 'profit_loss_pct', null)),
      true, test_full_flows(), date '2026-03-02', true, 3, true
    );
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a refresh token was published twice';
  end if;
end $$;

-- --- 11. a credential change during the refresh refuses the publish -----------
do $$
declare
  tok     uuid;
  blocked boolean := false;
  msg     text;
  payload jsonb;
begin
  payload := test_full_equity() || jsonb_build_array(
    jsonb_build_object('snapshot_date', '2026-06-10', 'equity', 1000200,
      'cash', 0, 'profit_loss', null, 'profit_loss_pct', null));

  -- Reserve, then rotate, then publish: exactly the interleaving that would
  -- otherwise mix one credential's data into another's mirror.
  tok := test_token();
  perform rotate_account_credentials(
    'ffffffff-0000-0000-0000-0000000000a1',
    current_setting('test.user_a')::uuid,
    'NEW-KEY', 'NEW-SECRET', 'PA-REFRESH-7777'
  );
  begin
    perform publish_broker_refresh(
      tok, payload, true, test_full_flows(), date '2026-03-02', true, 3, true
    );
  exception when others then
    blocked := true;
    msg := sqlerrm;
  end;
  if not blocked then
    raise exception 'FAIL: a publish survived a credential rotation';
  end if;
  if msg not like '%credentials changed%' then
    raise exception 'FAIL: expected a credential-change refusal, got %', msg;
  end if;

  -- A rebind is refused outright once the account has mirrored history, so
  -- the publish can never see two broker accounts in one curve.
  blocked := false;
  begin
    perform record_account_verification(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid,
      'connected', 'PA-REFRESH-8888'
    );
  exception when others then
    blocked := true;
    msg := sqlerrm;
  end;
  if not blocked then
    raise exception 'FAIL: an account with mirrored history was rebound';
  end if;
  -- 0020 made the number immutable from creation rather than "immutable once
  -- history exists", so the refusal now names the binding rather than the
  -- history. Either message is a refusal; this asserts the current one.
  if msg not like '%fixed at creation%' then
    raise exception 'FAIL: unexpected rebind refusal: %', msg;
  end if;
  if (select alpaca_account_number from accounts
       where id = 'ffffffff-0000-0000-0000-0000000000a1') <> 'PA-REFRESH-7777' then
    raise exception 'FAIL: the refused rebind still changed the binding';
  end if;
end $$;

-- --- 11b. the publish takes part in ordinary account locking ----------------
-- The identity re-check used to be a plain SELECT, and READ COMMITTED gives
-- every statement inside the function its own snapshot — so a rotation
-- committing between the check and the upserts was invisible. The lock is what
-- makes the check mean anything.
--
-- One transaction cannot block itself, so the observable proof lives in the
-- two-connection suite (`run_concurrency.sh`, race 3: the publish waits for a
-- held account row instead of returning in a second). What is asserted here is
-- the half that is visible from one session: the publish still succeeds while
-- following the canonical lock order, so the ordering change did not
-- reintroduce the self-deadlock 0018 was working around.
do $$
declare
  payload jsonb := test_full_equity() || jsonb_build_array(
    jsonb_build_object('snapshot_date', '2026-06-10', 'equity', 1000200,
      'cash', 0, 'profit_loss', null, 'profit_loss_pct', null));
begin
  perform publish_broker_refresh(
    test_token(), payload, true, test_full_flows(), date '2026-03-02', true, 3, true
  );
  perform 1 from accounts
   where id = 'ffffffff-0000-0000-0000-0000000000a1' for update;
end $$;

-- The credential-carrying reservation returns the key that matches the token.
do $$
declare
  issued jsonb;
begin
  issued := begin_broker_refresh_with_credentials(
    'ffffffff-0000-0000-0000-0000000000a1',
    current_setting('test.user_a')::uuid
  );
  if issued ->> 'api_key' is null or issued ->> 'api_secret' is null then
    raise exception 'FAIL: the reservation returned no credentials';
  end if;
  if (issued ->> 'credential_version')::bigint <> (
       select credential_version from accounts
        where id = 'ffffffff-0000-0000-0000-0000000000a1') then
    raise exception 'FAIL: the token records a different credential version';
  end if;
  -- Credentials and token from one transaction: what the token records is by
  -- construction the key the caller holds. Reading them separately left a
  -- window where a rotation produced a token naming the new version while the
  -- caller held the old key — the one combination the version check misses.
  if (issued ->> 'api_key') <> (
       select decrypted_secret from vault.decrypted_secrets
        where id = (select alpaca_key_secret_id from accounts
                     where id = 'ffffffff-0000-0000-0000-0000000000a1')) then
    raise exception 'FAIL: the reservation returned a different key';
  end if;
end $$;

-- --- 11c. a published refresh is audited -----------------------------------
do $$ begin
  if not exists (
    select 1 from audit_log
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and action = 'broker.refresh_published'
  ) then
    raise exception 'FAIL: a published refresh wrote no audit entry';
  end if;
end $$;

-- --- 12. ownership is enforced -----------------------------------------------
do $$
declare blocked boolean := false;
begin
  begin
    perform begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                                 current_setting('test.user_b')::uuid);
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: another owner reserved a refresh';
  end if;
end $$;

-- --- 13. the superseded RPCs still refuse -------------------------------------
do $$
declare blocked int := 0;
begin
  begin
    perform reconcile_cash_flow_mirror(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid, date '2026-03-02', '[]'::jsonb);
  exception when others then blocked := blocked + 1; end;
  begin
    perform replace_equity_snapshots(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid, '[]'::jsonb);
  exception when others then blocked := blocked + 1; end;
  if blocked <> 2 then
    raise exception 'FAIL: a superseded reconciliation RPC still runs';
  end if;
end $$;

-- --- 14. withdrawing a row is deliberate, audited and one at a time -----------
do $$
declare
  before_equity bigint;
begin
  select count(*) into before_equity
    from equity_snapshots
   where account_id = 'ffffffff-0000-0000-0000-0000000000a1';

  perform retract_equity_snapshot(
    'ffffffff-0000-0000-0000-0000000000a1',
    current_setting('test.user_a')::uuid,
    date '2026-04-01',
    'broker withdrew the session in a corrected statement'
  );
  if (select count(*) from equity_snapshots
       where account_id = 'ffffffff-0000-0000-0000-0000000000a1')
     <> before_equity - 1 then
    raise exception 'FAIL: the retraction did not remove exactly one row';
  end if;
  if not exists (
    select 1 from audit_log
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and action = 'equity.retracted'
  ) then
    raise exception 'FAIL: the retraction was not audited';
  end if;

  perform retract_cash_flow(
    'ffffffff-0000-0000-0000-0000000000a1',
    current_setting('test.user_a')::uuid,
    'act-2', 'the deposit was reversed'
  );
  if exists (
    select 1 from cash_flows
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and external_id = 'act-2'
  ) then
    raise exception 'FAIL: the cash flow was not withdrawn';
  end if;
  if not exists (
    select 1 from audit_log
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and action = 'cash_flow.retracted'
  ) then
    raise exception 'FAIL: the cash-flow retraction was not audited';
  end if;
end $$;

-- A retraction without a stated reason is not a retraction.
do $$
declare blocked int := 0;
begin
  begin
    perform retract_equity_snapshot(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid, date '2026-03-03', '');
  exception when others then blocked := blocked + 1; end;
  begin
    perform retract_equity_snapshot(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid, date '2026-03-03', null);
  exception when others then blocked := blocked + 1; end;
  begin
    perform retract_cash_flow(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_b')::uuid, 'act-1', 'not my account');
  exception when others then blocked := blocked + 1; end;
  if blocked <> 3 then
    raise exception 'FAIL: an unreasoned or unowned retraction was allowed';
  end if;
end $$;

-- --- 15. the count heuristic is gone ------------------------------------------
do $$ begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('equity_retraction_limit', 'equity_retraction_allowance')
  ) then
    raise exception 'FAIL: the retraction allowance still exists';
  end if;
end $$;

-- --- 16. no client role can reach any of this ---------------------------------
select set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('test.user_a'), 'role', 'authenticated')::text,
  true
);
set local role authenticated;

do $$
declare denied int := 0;
begin
  begin
    perform begin_broker_refresh(gen_random_uuid(), gen_random_uuid());
  exception when insufficient_privilege then denied := denied + 1;
    when others then null; end;
  begin
    perform publish_broker_refresh(gen_random_uuid(), '[]'::jsonb, true,
      '[]'::jsonb, current_date, true, 0, true);
  exception when insufficient_privilege then denied := denied + 1;
    when others then null; end;
  begin
    perform retract_equity_snapshot(gen_random_uuid(), gen_random_uuid(),
      current_date, 'x');
  exception when insufficient_privilege then denied := denied + 1;
    when others then null; end;
  begin
    perform record_account_verification(gen_random_uuid(), gen_random_uuid(),
      'connected', 'PA-1');
  exception when insufficient_privilege then denied := denied + 1;
    when others then null; end;
  if denied <> 4 then
    raise exception 'FAIL: only % of 4 refresh RPCs refused a client role', denied;
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$ begin raise notice 'BROKER REFRESH OK'; end $$;

rollback;
