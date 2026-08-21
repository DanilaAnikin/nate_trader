-- SABOTAGE 7 — duplicate an event.
-- A sensor that double-counts is as useless for an absence proof as one that
-- under-counts: the verdict is an exact number, not "at least one".
\set ON_ERROR_STOP on
create or replace function nt_canary.log_call(p_fn text, p_args jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, nt_canary
as $$
declare n bigint; m bigint;
begin
  n := nextval('nt_canary.hit_' || p_fn);
  raise log 'NT_CANARY_HIT fn=% n=% cell=% role=% args=%',
    p_fn, n, coalesce(current_setting('nt_canary.cell', true), '-'),
    coalesce(current_setting('role', true), '-'), p_args;
  m := nextval('nt_canary.hit_' || p_fn);
  raise log 'NT_CANARY_HIT fn=% n=% cell=% role=% args=%',
    p_fn, m, coalesce(current_setting('nt_canary.cell', true), '-'),
    coalesce(current_setting('role', true), '-'), p_args;
end $$;
