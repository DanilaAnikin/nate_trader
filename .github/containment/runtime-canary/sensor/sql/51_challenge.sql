-- ===========================================================================
-- 51_challenge.sql — fire every instrumented wrapper once, under a tag the
--                    candidate cannot predict
--
-- WHAT A CHALLENGE IS
-- -------------------
-- A definition comparison proves the sensor's TEXT has not changed. It cannot
-- prove the sensor WORKS: the very first install could have been dead. So each
-- phase of a run also calls all three wrappers for real, from a privileged path
-- the image under test has no route to (`docker exec psql -U postgres`), with
-- the call tagged by a per-run nonce that is generated after the artifact under
-- test is already fixed. Exactly one event, carrying exactly that tag, must
-- appear on every channel.
--
-- THE ORACLE HAS TO SURVIVE THE CALL
-- ----------------------------------
-- On the latest schema every one of these wrappers ends in `raise`, so the
-- subtransaction the call runs in is rolled back. A row in a table would go
-- with it. Three channels are therefore read, and only one of them is a table:
--
--   RAW SEQUENCE     `pg_sequence_last_value` straight out of the catalogue,
--                    NOT through `nt_canary.hits()`. Sequences are exempt from
--                    rollback. Reading the catalogue rather than the helper is
--                    what makes a fabricated `hits()` visible.
--   hits()           the helper the rest of the harness uses. It must agree
--                    with the raw sequence.
--   SERVER LOG       `raise log` reaches the postgres log immediately, outside
--                    the transaction; the trusted runner reads it from OUTSIDE
--                    the database with `docker logs`. That is the external
--                    test-side recorder, and it is the channel a rollback
--                    cannot touch at all.
--
-- Variables (all required):
--   tag_prefix   e.g. chal:<nonce>:pre:0     — the per-call tag is
--                <tag_prefix>:<fn>
--
-- It leaves nothing behind: on 0001-0008 the wrappers really work, so the
-- secret the create call makes is removed again, and the detail rows this
-- probe caused are deleted. The COUNTERS are deliberately not reset — a sensor
-- whose counter could be wound back would be a sensor that could be erased.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset footer off

create temporary table nts_chal (
  fn          text primary key,
  tag         text not null,
  raw_before  bigint,
  raw_after   bigint,
  hits_before bigint,
  hits_after  bigint,
  outcome     text,
  sqlstate    text
);

-- psql does NOT interpolate `:variables` inside a dollar-quoted block, so the
-- tag prefix is carried in through a GUC set OUTSIDE the block, where
-- interpolation does happen. Writing `:'tag_prefix'` inside the `do $$ … $$`
-- produced a syntax error at the colon, which the runner correctly reported as
-- its own failure (CHALLENGE_NOT_RUN) rather than as a silent sensor.
select set_config('nt_canary.chal_prefix', :'tag_prefix', false);

do $$
declare
  fns    text[] := array['vault_create_secret','vault_update_secret','vault_delete_secret'];
  f      text;
  tag    text;
  prefix text := current_setting('nt_canary.chal_prefix');
  rb     bigint;
  ra     bigint;
  hb     bigint;
  ha     bigint;
  st     text;
  oc     text;
  sid    uuid;
begin
  foreach f in array fns loop
    tag := prefix || ':' || f;

    -- raw catalogue read; coalesce because a never-advanced sequence is null
    execute format(
      'select coalesce(pg_catalog.pg_sequence_last_value(%L::regclass), 0)::bigint',
      'nt_canary.hit_' || f) into rb;
    select h.hits into hb from nt_canary.hits() h where h.fn = f;

    perform set_config('nt_canary.cell', tag, false);

    begin
      if f = 'vault_create_secret' then
        sid := public.vault_create_secret('NOT-A-CREDENTIAL-CHALLENGE', 'nt-canary-challenge');
        oc  := 'returned';
      elsif f = 'vault_update_secret' then
        perform public.vault_update_secret(
          coalesce(sid, '00000000-0000-4000-8000-0000000000cc'::uuid),
          'NOT-A-CREDENTIAL-CHALLENGE-2');
        oc := 'returned';
      else
        perform public.vault_delete_secret(
          coalesce(sid, '00000000-0000-4000-8000-0000000000cc'::uuid));
        oc := 'returned';
      end if;
      st := '00000';
    exception when others then
      get stacked diagnostics st = returned_sqlstate;
      oc := 'raised';
    end;

    perform set_config('nt_canary.cell', '', false);

    execute format(
      'select coalesce(pg_catalog.pg_sequence_last_value(%L::regclass), 0)::bigint',
      'nt_canary.hit_' || f) into ra;
    select h.hits into ha from nt_canary.hits() h where h.fn = f;

    insert into nts_chal values (f, tag, rb, ra, hb, ha, oc, st);
  end loop;
end $$;

-- Leave no trace in the commitments: on 0001-0008 the create really created.
delete from vault.secrets where name = 'nt-canary-challenge';
delete from nt_canary.calls where cell like :'tag_prefix' || ':%';

select 'SENSOR_CHAL=' || fn
       || '|' || tag
       || '|raw_before=' || raw_before
       || '|raw_after='  || raw_after
       || '|hits_before='|| hits_before
       || '|hits_after=' || hits_after
       || '|outcome='    || outcome
       || '|sqlstate='   || sqlstate
  from nts_chal order by fn;
