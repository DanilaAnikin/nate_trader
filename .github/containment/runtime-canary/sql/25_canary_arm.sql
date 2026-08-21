-- ===========================================================================
-- 25_canary_arm.sql — the POSITIVE CONTROL, run before any zero is believed
--
-- Every "the frozen image produced no canary rows" in this harness is an
-- absence claim, and an absence claim from an untested detector is worth
-- nothing. So before the matrix runs, this file calls all three wrappers on
-- this very database and requires the sensor to have recorded exactly three
-- hits — one per function, on the rollback-proof counter, in the server log,
-- and (where the transaction survives) in the detail table.
--
-- It is written to work on BOTH schemas, whose behaviour is opposite:
--
--   0001-0008  the wrappers really work. `vault_create_secret` returns a uuid,
--              `vault_update_secret` rewrites it, `vault_delete_secret`
--              removes it. The probe therefore cleans up after itself and the
--              Vault commitment taken afterwards is unchanged.
--   0001-0023  every call raises — 0022's P0001 for a privileged caller, the
--              replayed 42501 for anyone else — and the surrounding
--              subtransaction is rolled back. The counters still move. That is
--              the whole reason they are sequences.
--
-- The probe deliberately does NOT care which of those happened: it asserts on
-- the sensor, not on the wrapper. What it will not tolerate is a hit count
-- that did not move.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create temporary table nt_arming (fn text primary key, outcome text);

do $$
declare
  before_create bigint;
  before_update bigint;
  before_delete bigint;
  after_create  bigint;
  after_update  bigint;
  after_delete  bigint;
  probe_id      uuid;
  outcome       text[] := '{}';
  sqlstate_seen text;
  -- Captured and printed, because this is what caught a bug in this very
  -- file: `text[] || 'literal'` resolves to `anyarray || anyarray`, tries to
  -- parse the literal as an array, and raises 22P02 — INSIDE the exception
  -- block that was meant to report on the wrapper. The probe then reported
  -- the wrapper as raising 22P02 when the wrapper had in fact succeeded.
  -- Every appended literal below is therefore cast to text explicitly.
  message_seen  text;
begin
  select hits into before_create from nt_canary.hits() where fn = 'vault_create_secret';
  select hits into before_update from nt_canary.hits() where fn = 'vault_update_secret';
  select hits into before_delete from nt_canary.hits() where fn = 'vault_delete_secret';

  perform set_config('nt_canary.cell', 'arming-probe', false);

  -- 1. create ---------------------------------------------------------------
  begin
    probe_id := public.vault_create_secret(
      'NOT-A-CREDENTIAL-ARMING-PROBE', 'nt-canary-arming-probe');
    outcome := outcome || format('create=returned:%s', coalesce(probe_id::text, 'null'))::text;
    insert into nt_arming values ('vault_create_secret', 'returned');
  exception when others then
    get stacked diagnostics sqlstate_seen = returned_sqlstate, message_seen = message_text;
    raise notice 'ARMING_DETAIL %: %', sqlstate_seen, message_seen;
    outcome := outcome || format('create=raised:%s', sqlstate_seen)::text;
    insert into nt_arming values ('vault_create_secret', 'raised:' || sqlstate_seen);
  end;

  -- 2. update ---------------------------------------------------------------
  -- A uuid is needed either way; on the latest schema the call raises before
  -- it is looked at, and on 0008 it is the secret just created.
  begin
    perform public.vault_update_secret(
      coalesce(probe_id, '00000000-0000-4000-8000-0000000000aa'::uuid),
      'NOT-A-CREDENTIAL-ARMING-PROBE-2');
    outcome := outcome || 'update=returned'::text;
    insert into nt_arming values ('vault_update_secret', 'returned');
  exception when others then
    get stacked diagnostics sqlstate_seen = returned_sqlstate, message_seen = message_text;
    raise notice 'ARMING_DETAIL %: %', sqlstate_seen, message_seen;
    outcome := outcome || format('update=raised:%s', sqlstate_seen)::text;
    insert into nt_arming values ('vault_update_secret', 'raised:' || sqlstate_seen);
  end;

  -- 3. delete ---------------------------------------------------------------
  begin
    perform public.vault_delete_secret(
      coalesce(probe_id, '00000000-0000-4000-8000-0000000000aa'::uuid));
    outcome := outcome || 'delete=returned'::text;
    insert into nt_arming values ('vault_delete_secret', 'returned');
  exception when others then
    get stacked diagnostics sqlstate_seen = returned_sqlstate, message_seen = message_text;
    raise notice 'ARMING_DETAIL %: %', sqlstate_seen, message_seen;
    outcome := outcome || format('delete=raised:%s', sqlstate_seen)::text;
    insert into nt_arming values ('vault_delete_secret', 'raised:' || sqlstate_seen);
  end;

  perform set_config('nt_canary.cell', '', false);

  select hits into after_create from nt_canary.hits() where fn = 'vault_create_secret';
  select hits into after_update from nt_canary.hits() where fn = 'vault_update_secret';
  select hits into after_delete from nt_canary.hits() where fn = 'vault_delete_secret';

  -- Exactly one hit each. Not "at least one": a sensor that double-counts is
  -- as useless for an absence proof as one that under-counts, because the
  -- matrix's verdict is an exact number.
  if after_create - before_create <> 1 then
    raise exception 'CANARY_SENSOR_DEAD: vault_create_secret hit counter moved by % (expected 1)',
      after_create - before_create using errcode = 'P0001';
  end if;
  if after_update - before_update <> 1 then
    raise exception 'CANARY_SENSOR_DEAD: vault_update_secret hit counter moved by % (expected 1)',
      after_update - before_update using errcode = 'P0001';
  end if;
  if after_delete - before_delete <> 1 then
    raise exception 'CANARY_SENSOR_DEAD: vault_delete_secret hit counter moved by % (expected 1)',
      after_delete - before_delete using errcode = 'P0001';
  end if;

  raise notice 'ARMING_OUTCOMES=%', array_to_string(outcome, ' ');
end $$;

-- --- leave no trace in the commitments -------------------------------------
-- On 0008 the probe may have created a secret that its own delete removed; if
-- the delete raised (0020's FK guard, say) the secret would still be there and
-- the Vault commitment taken next would differ from the one taken after the
-- matrix for a reason that has nothing to do with the image.
delete from vault.secrets where name = 'nt-canary-arming-probe';

-- The detail rows from the probe are removed so the matrix starts from an
-- empty table. The COUNTERS are deliberately not reset: a sequence that could
-- be wound back would be a sensor that could be quietly erased, and the
-- harness compares deltas rather than absolutes precisely so it never needs to.
delete from nt_canary.calls where cell = 'arming-probe';

-- Same shape as 18_prewrapper_baseline.sql's line, so run.sh can require the
-- canary to have preserved the wrapper's observable behaviour exactly.
select 'ARMING_OUTCOME=' || string_agg(fn || '=' || outcome, ' ' order by fn)
  from nt_arming;

select 'CANARY_ARMED=yes' as verdict;
select 'CANARY_BASELINE=' || string_agg(fn || ':' || hits::text, ',' order by fn)
  from nt_canary.hits();
select 'CANARY_ROWS_AFTER_ARM=' || count(*)::text from nt_canary.calls;
