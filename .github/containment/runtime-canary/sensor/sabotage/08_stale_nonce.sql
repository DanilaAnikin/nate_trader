-- SABOTAGE 8 — substitute a stale nonce.
-- The counter still moves and a hit line is still written, but the correlation
-- is a fixed string from an earlier run rather than the tag of the call that
-- is happening. Replay, in one line.
\set ON_ERROR_STOP on
create or replace function nt_canary.log_call(p_fn text, p_args jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, nt_canary
as $$
declare n bigint;
begin
  n := nextval('nt_canary.hit_' || p_fn);
  raise log 'NT_CANARY_HIT fn=% n=% cell=% role=% args=%',
    p_fn, n,
    'chal:00000000000000000000000000000000:pre:0:' || p_fn,
    coalesce(current_setting('role', true), '-'), p_args;
end $$;
