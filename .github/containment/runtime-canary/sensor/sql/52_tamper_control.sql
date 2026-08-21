-- ===========================================================================
-- 52_tamper_control.sql — prove the candidate cannot reach the sensor
--
-- "Candidate code must not be able to modify the sensor" is a claim about
-- privileges, and privileges are exactly the kind of thing that is asserted in
-- a comment and never checked. So this file tries, as every role a request from
-- the image under test can arrive as, to do each of the things that would
-- disable the sensor, and requires every attempt to be refused.
--
-- The image reaches the database only through the recording gateway, which
-- connects as `authenticator` and issues `set local role` to `anon`,
-- `authenticated` or `service_role` — the same three PostgREST switches to in
-- production. Those four roles are therefore the whole attack surface from the
-- candidate's side, and each is tried.
--
-- What is attempted, per role:
--   T1  replace a watched wrapper with one that does not record
--   T2  drop the rollback-proof hit counter
--   T3  replace nt_canary.log_call with a no-op
--   T4  delete the accumulated detail rows
--   T5  create a shadowing overload of a watched wrapper
--   T6  create an object inside the nt_canary schema
--
-- A REFUSAL IS NOT ENOUGH: IT MUST BE THE RIGHT REFUSAL
-- -----------------------------------------------------
-- This file used to record only `refused = true/false`, and its own prose said
-- a refusal had to be "42501 / 42P01-class". Those are not the same thing.
-- 42501 is `insufficient_privilege` — the attempt was made and the database
-- said no. 42P01 is `undefined_table` — the object named does not exist, so
-- NOTHING WAS ATTEMPTED. An audit renamed one target so the attempt could not
-- find it, and the control still printed
-- `refused=true` and `UNREACHABLE|attempts=24|succeeded=0`: a control that
-- reports success for an attack it never launched.
--
-- So each attempt now carries the SQLSTATE it must fail with, and a refusal
-- with any other class is `class_ok=false` and counted in `wrong_class` on the
-- result line. `sensor/verify-sensor.sh` refuses to arm unless wrong_class=0.
-- Every one of these six is a privilege question, so every expected class is
-- 42501; the column exists so that adding an attempt whose legitimate refusal
-- is a different class has to be a deliberate edit rather than a silent
-- widening.
--
-- Anything that SUCCEEDS is rolled back immediately and reported as a failure
-- of this control.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned
\pset footer off

create temporary table nts_tamper (
  role_name text,
  attempt   text,
  refused   boolean,
  sqlstate  text,
  expected  text,
  class_ok  boolean,
  primary key (role_name, attempt)
);

do $$
declare
  roles    text[] := array['anon','authenticated','service_role','authenticator'];
  r        text;
  -- Written with ordinary single-quoted function bodies rather than nested
  -- dollar quoting. Two dollar-quote tags written back to back, with no
  -- separator, are not two closing tags: the scanner looking for the outer tag
  -- finds a match one character early and the statement ends in the middle of
  -- itself. That produced a syntax error which the runner correctly reported as
  -- its own failure rather than as a result — twice, because the second time
  -- the offending sequence was in this comment.
  -- name | statement | the SQLSTATE this attempt MUST fail with
  attempts text[][] := array[
    ['T1_replace_wrapper',
     $s$create or replace function public.vault_delete_secret(p_id uuid) returns void language plpgsql as 'begin return; end'$s$,
     '42501'],
    ['T2_drop_counter',
     $s$drop sequence nt_canary.hit_vault_delete_secret$s$,
     '42501'],
    ['T3_replace_log_call',
     $s$create or replace function nt_canary.log_call(p_fn text, p_args jsonb) returns void language plpgsql as 'begin return; end'$s$,
     '42501'],
    ['T4_delete_detail_rows',
     $s$delete from nt_canary.calls$s$,
     '42501'],
    ['T5_shadow_overload',
     $s$create function public.vault_delete_secret(p_id text) returns void language plpgsql as 'begin return; end'$s$,
     '42501'],
    ['T6_object_in_sensor_schema',
     $s$create table nt_canary.attacker_table(x int)$s$,
     '42501']
  ];
  i        int;
  st       text;
  refused  boolean;
begin
  foreach r in array roles loop
    for i in 1 .. array_length(attempts, 1) loop
      refused := true; st := null;
      begin
        -- Each attempt is its own subtransaction: one that unexpectedly
        -- succeeds is undone before the next runs.
        begin
          execute format('set local role %I', r);
          execute attempts[i][2];
          refused := false;
          st := '00000';
          -- undo anything that got through
          raise exception 'NTS_TAMPER_SUCCEEDED' using errcode = 'P0001';
        exception
          when sqlstate 'P0001' then
            if sqlerrm = 'NTS_TAMPER_SUCCEEDED' then
              refused := false; st := '00000';
            else
              refused := true;
              get stacked diagnostics st = returned_sqlstate;
            end if;
          when others then
            refused := true;
            get stacked diagnostics st = returned_sqlstate;
        end;
      end;
      reset role;
      insert into nts_tamper values (
        r,
        attempts[i][1],
        refused,
        coalesce(st, 'none'),
        attempts[i][3],
        -- The attempt has to have been REFUSED, and refused for the reason this
        -- control is about. A 42P01 means the object was not there to attack.
        refused and coalesce(st, 'none') = attempts[i][3]
      );
    end loop;
  end loop;
  reset role;
end $$;

select 'SENSOR_TAMPER=' || role_name || '|' || attempt || '|refused=' || refused
       || '|sqlstate=' || sqlstate
       || '|expected=' || expected
       || '|class_ok=' || class_ok
  from nts_tamper order by role_name, attempt;

-- Named separately so a negative control can assert the exact line it is aiming
-- at: an attempt that never happened is a DIFFERENT failure from an attempt
-- that succeeded, and the two must not share a verdict word.
select 'SENSOR_TAMPER_WRONG_CLASS=' || role_name || '|' || attempt
       || '|got=' || sqlstate || '|expected=' || expected
  from nts_tamper where not class_ok and refused order by role_name, attempt;

select 'SENSOR_TAMPER_RESULT=' ||
  case when exists (select 1 from nts_tamper where not refused)
       then 'REACHABLE' else 'UNREACHABLE' end
  || '|attempts=' || (select count(*)::text from nts_tamper)
  || '|succeeded=' || (select count(*)::text from nts_tamper where not refused)
  || '|wrong_class=' || (select count(*)::text from nts_tamper where refused and not class_ok);
