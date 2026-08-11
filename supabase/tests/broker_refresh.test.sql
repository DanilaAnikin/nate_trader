-- ============================================================================
-- broker_refresh.test.sql — the refresh generation and the ingest guards
--
-- Everything here is about not losing real data:
--
--   * two overlapping refreshes must not interleave, and the one that finishes
--     second with an older generation must be refused rather than overwriting
--     fresher data;
--   * a partial, empty or truncated upstream payload must never be read as a
--     retraction;
--   * a genuine retraction — including of the *oldest* day — must be honoured;
--   * an empty activity walk must not empty a populated ledger; and
--   * every destructive RPC must refuse a NULL or malformed argument before it
--     touches a row.
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

-- Five mirrored days and three mirrored flows to reconcile against.
insert into equity_snapshots (account_id, snapshot_date, equity, cash, source)
select 'ffffffff-0000-0000-0000-0000000000a1',
       date '2026-08-03' + (n || ' days')::interval,
       1000000 + n, 0, 'alpaca_portfolio_history'
from generate_series(0, 4) as n;

insert into cash_flows (account_id, flow_date, amount, kind, source, external_id)
select 'ffffffff-0000-0000-0000-0000000000a1',
       date '2026-08-03' + (n || ' days')::interval,
       10, 'deposit', 'alpaca_activities', 'act-' || n
from generate_series(0, 2) as n;

-- A row this mirror did not write must survive every reconciliation below.
insert into equity_snapshots (account_id, snapshot_date, equity, cash, source)
values (
  'ffffffff-0000-0000-0000-0000000000a1', date '2026-07-01', 900000, 0, 'agent'
);

-- Helper: the five mirrored days, as the payload shape the RPC expects.
create or replace function test_equity_payload(p_days int[])
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'snapshot_date', (date '2026-08-03' + (d || ' days')::interval)::date,
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
           'flow_date', (date '2026-08-03' + (i || ' days')::interval)::date,
           'amount', 10,
           'kind', 'deposit'
         ) order by i), '[]'::jsonb)
  from unnest(p_ids) as i;
$$;

-- --- 1. every argument is required -----------------------------------------
do $$
declare
  gen      bigint;
  blocked  boolean;
  attempts text[] := '{}';
begin
  gen := begin_broker_refresh(
    'ffffffff-0000-0000-0000-0000000000a1',
    current_setting('test.user_a')::uuid
  );

  -- Each call below is valid except for exactly one NULL.
  blocked := false;
  begin
    perform publish_broker_refresh(
      null, current_setting('test.user_a')::uuid, gen,
      test_equity_payload(array[0,1,2,3,4]), true,
      test_flow_payload(array[0,1,2]), date '2026-08-03', true, 3
    );
  exception when others then blocked := true; end;
  if not blocked then attempts := attempts || 'null account'; end if;

  blocked := false;
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1', current_setting('test.user_a')::uuid, gen,
      null, true, test_flow_payload(array[0,1,2]), date '2026-08-03', true, 3
    );
  exception when others then blocked := true; end;
  if not blocked then attempts := attempts || 'null equity payload'; end if;

  blocked := false;
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1', current_setting('test.user_a')::uuid, gen,
      test_equity_payload(array[0,1,2,3,4]), true,
      test_flow_payload(array[0,1,2]), null, true, 3
    );
  exception when others then blocked := true; end;
  if not blocked then attempts := attempts || 'null flow window'; end if;

  blocked := false;
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1', current_setting('test.user_a')::uuid, gen,
      '{"not":"an array"}'::jsonb, true,
      test_flow_payload(array[0,1,2]), date '2026-08-03', true, 3
    );
  exception when others then blocked := true; end;
  if not blocked then attempts := attempts || 'object instead of array'; end if;

  -- A payload the caller could not prove complete must be refused outright.
  blocked := false;
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1', current_setting('test.user_a')::uuid, gen,
      test_equity_payload(array[0,1,2,3,4]), false,
      test_flow_payload(array[0,1,2]), date '2026-08-03', true, 3
    );
  exception when others then blocked := true; end;
  if not blocked then attempts := attempts || 'unproven equity payload'; end if;

  if array_length(attempts, 1) is not null then
    raise exception 'FAIL: accepted %', array_to_string(attempts, ', ');
  end if;

  -- And none of those refusals moved anything.
  if (select count(*) from equity_snapshots
       where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
         and source = 'alpaca_portfolio_history') <> 5 then
    raise exception 'FAIL: a refused publish still changed the equity mirror';
  end if;
end $$;

-- --- 2. an empty portfolio history is not a retraction ---------------------
do $$
declare blocked boolean := false;
begin
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid,
      begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                           current_setting('test.user_a')::uuid),
      '[]'::jsonb, true,
      test_flow_payload(array[0,1,2]), date '2026-08-03', true, 3
    );
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: an empty portfolio history emptied the mirror';
  end if;
  if (select count(*) from equity_snapshots
       where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
         and source = 'alpaca_portfolio_history') <> 5 then
    raise exception 'FAIL: an empty payload deleted stored days';
  end if;
end $$;

-- --- 3. a truncated payload is not a retraction ----------------------------
-- Only the newest day survives in the payload: that is a loss of four days,
-- past the retraction limit, so it must be refused rather than applied.
do $$
declare blocked boolean := false;
begin
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid,
      begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                           current_setting('test.user_a')::uuid),
      test_equity_payload(array[4]), true,
      test_flow_payload(array[0,1,2]), date '2026-08-03', true, 3
    );
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: a truncated payload was applied as a retraction';
  end if;
  if (select count(*) from equity_snapshots
       where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
         and source = 'alpaca_portfolio_history') <> 5 then
    raise exception 'FAIL: a truncated payload deleted stored days';
  end if;
end $$;

-- --- 4. a genuine retraction of the OLDEST day is honoured -----------------
-- The bound the old code used — `>= min(incoming)` — could never remove this
-- day, because dropping it moves the bound past it.
do $$
declare removed jsonb;
begin
  removed := publish_broker_refresh(
    'ffffffff-0000-0000-0000-0000000000a1',
    current_setting('test.user_a')::uuid,
    begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                         current_setting('test.user_a')::uuid),
    test_equity_payload(array[1,2,3,4]), true,
    test_flow_payload(array[0,1,2]), date '2026-08-03', true, 3
  );
  if (removed ->> 'equity_removed')::int <> 1 then
    raise exception 'FAIL: the retracted oldest day was not removed (%)', removed;
  end if;
  if exists (
    select 1 from equity_snapshots
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and snapshot_date = date '2026-08-03'
       and source = 'alpaca_portfolio_history'
  ) then
    raise exception 'FAIL: the retracted oldest day survived';
  end if;
  -- A row this mirror did not write keeps its own authority.
  if not exists (
    select 1 from equity_snapshots
     where account_id = 'ffffffff-0000-0000-0000-0000000000a1'
       and snapshot_date = date '2026-07-01' and source = 'agent'
  ) then
    raise exception 'FAIL: the reconciliation deleted a row it did not write';
  end if;
end $$;

-- --- 5. an empty, unexamined activity walk must not empty the ledger -------
do $$
declare blocked boolean := false;
begin
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid,
      begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                           current_setting('test.user_a')::uuid),
      test_equity_payload(array[1,2,3,4]), true,
      '[]'::jsonb, date '2026-08-03', true, 0
    );
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: an unexamined empty walk emptied the ledger';
  end if;
  if (select count(*) from cash_flows
       where account_id = 'ffffffff-0000-0000-0000-0000000000a1') <> 3 then
    raise exception 'FAIL: an unexamined empty walk deleted mirrored flows';
  end if;
end $$;

-- A walk that examined activities and found none in the window may empty it.
do $$
declare result jsonb;
begin
  result := publish_broker_refresh(
    'ffffffff-0000-0000-0000-0000000000a1',
    current_setting('test.user_a')::uuid,
    begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                         current_setting('test.user_a')::uuid),
    test_equity_payload(array[1,2,3,4]), true,
    '[]'::jsonb, date '2026-08-03', true, 12
  );
  if (result ->> 'flows_removed')::int <> 3 then
    raise exception 'FAIL: an examined empty walk did not reconcile (%)', result;
  end if;
end $$;

-- --- 6. two generations completing in the wrong order ----------------------
-- A takes its generation first, B takes one after it and publishes first. A's
-- later publish carries the older generation and must be refused, so B's
-- fresher data survives.
do $$
declare
  gen_a   bigint;
  gen_b   bigint;
  blocked boolean := false;
begin
  gen_a := begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                                current_setting('test.user_a')::uuid);
  gen_b := begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                                current_setting('test.user_a')::uuid);
  if gen_b <= gen_a then
    raise exception 'FAIL: generations are not monotonic (% then %)', gen_a, gen_b;
  end if;

  -- B publishes first, with two flows.
  perform publish_broker_refresh(
    'ffffffff-0000-0000-0000-0000000000a1', current_setting('test.user_a')::uuid,
    gen_b,
    test_equity_payload(array[1,2,3,4]), true,
    test_flow_payload(array[0,1]), date '2026-08-03', true, 2
  );

  -- A now arrives late with a stale generation and only one flow.
  begin
    perform publish_broker_refresh(
      'ffffffff-0000-0000-0000-0000000000a1', current_setting('test.user_a')::uuid,
      gen_a,
      test_equity_payload(array[1,2,3,4]), true,
      test_flow_payload(array[0]), date '2026-08-03', true, 1
    );
  exception when others then blocked := true; end;

  if not blocked then
    raise exception 'FAIL: a stale generation overwrote a newer refresh';
  end if;
  if (select count(*) from cash_flows
       where account_id = 'ffffffff-0000-0000-0000-0000000000a1') <> 2 then
    raise exception
      'FAIL: the late refresh changed the ledger despite being refused';
  end if;
end $$;

-- --- 7. ownership is enforced ----------------------------------------------
do $$
declare blocked boolean := false;
begin
  begin
    perform begin_broker_refresh('ffffffff-0000-0000-0000-0000000000a1',
                                 current_setting('test.user_b')::uuid);
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: another user could start a refresh';
  end if;
end $$;

-- --- 8. the superseded RPC refuses rather than deleting --------------------
do $$
declare blocked boolean := false;
begin
  begin
    perform replace_equity_snapshots(
      'ffffffff-0000-0000-0000-0000000000a1',
      current_setting('test.user_a')::uuid,
      '[]'::jsonb
    );
  exception when others then blocked := true; end;
  if not blocked then
    raise exception 'FAIL: replace_equity_snapshots still accepts unproven input';
  end if;
end $$;

-- --- 9. neither refresh RPC is reachable by a client role ------------------
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'user_a', 'role', 'authenticated')::text, true);
do $$
declare denied boolean;
begin
  denied := false;
  begin
    perform begin_broker_refresh(gen_random_uuid(), gen_random_uuid());
  exception when insufficient_privilege then denied := true;
    when others then denied := false;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can call begin_broker_refresh';
  end if;

  denied := false;
  begin
    perform publish_broker_refresh(
      gen_random_uuid(), gen_random_uuid(), 1,
      '[]'::jsonb, true, '[]'::jsonb, current_date, true, 0
    );
  exception when insufficient_privilege then denied := true;
    when others then denied := false;
  end;
  if not denied then
    raise exception 'FAIL: authenticated can call publish_broker_refresh';
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$ begin raise notice 'BROKER REFRESH OK'; end $$;

rollback;
