-- ===========================================================================
-- 22_canary_break.sql — deliberately sabotage the sensor (property C)
--
-- Property (C) of the suite is that the canary cannot be quietly removed: if
-- someone deletes it, mutes it, or arranges for the verdict to stop reading
-- it, the falsification suite must FAIL rather than report a clean run. A
-- sensor whose removal is indistinguishable from a pass is not a control, it
-- is decoration.
--
-- This file implements the two database-side sabotages. The third — making the
-- verdict ignore a sensor that is still there — is `run.sh --break-sensor
-- verdict`, because it lives in the checker rather than in the schema.
--
--   :mode = 'drop'  restore the schema's own definitions from
--                   nt_canary.original, exactly as migration 0008/0020/0022
--                   left them, and re-apply the real ACL. The canary is gone
--                   and the database is once again the database under test.
--   :mode = 'mute'  leave every canary in place — the marker comment, the
--                   wrappers, the log table, the counters — and gut only
--                   `log_call`, so calls still arrive and nothing records
--                   them. This is the subtle one: a `grep` for the sensor
--                   still finds it.
--
-- Neither is ever run by a normal invocation.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

-- psql does NOT interpolate `:variables` inside a dollar-quoted block, so the
-- mode is carried in through a GUC set OUTSIDE the block, where interpolation
-- does happen. Writing `:'mode'` inside the `do $$ ... $$` produced a syntax
-- error at the colon — which the harness correctly reported as its own failure
-- (exit 2) rather than as a result.
select set_config('nt_canary.break_mode', :'mode', false);

do $$
declare
  o    record;
  a    record;
  mode text := current_setting('nt_canary.break_mode');
begin
  if mode not in ('drop', 'mute') then
    raise exception 'unknown sabotage mode: %', mode using errcode = 'P0001';
  end if;

  if mode = 'drop' then
    for o in select * from nt_canary.original order by fn loop
      -- `pg_get_functiondef` of the pre-canary function: the schema's own text.
      execute o.def;
      -- ...and the schema's own ACL, from the snapshot taken before the grant.
      execute format('revoke all on function public.%I(%s) from public, anon, authenticated, service_role',
                     o.fn, o.identity_arguments);
      for a in select * from nt_canary.acl where fn = o.fn and allowed and role_name <> 'public' loop
        execute format('grant execute on function public.%I(%s) to %I',
                       o.fn, o.identity_arguments, a.role_name);
      end loop;
    end loop;
    raise notice 'SABOTAGE=drop: the three wrappers are the schema''s own again';

  else
    execute $mute$
      create or replace function nt_canary.log_call(p_fn text, p_args jsonb)
      returns void
      language plpgsql
      security definer
      set search_path = pg_catalog, nt_canary
      as $body$
      begin
        -- Sabotaged for the property (C) control: the sensor is still named,
        -- still called, still granted, and records absolutely nothing.
        return;
      end
      $body$;
    $mute$;
    raise notice 'SABOTAGE=mute: log_call still exists and no longer records anything';
  end if;
end $$;

select 'CANARY_SABOTAGE=' || :'mode' as verdict;
