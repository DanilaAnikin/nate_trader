-- SABOTAGE 4 — log only for a PREDICTABLE pre-check input.
-- The old positive control always tagged its calls 'arming-probe', a literal
-- checked into the repository. A sensor that records only that tag passes the
-- old arming probe perfectly and is blind to everything else.
\set ON_ERROR_STOP on
create or replace function nt_canary.log_call(p_fn text, p_args jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, nt_canary
as $$
declare n bigint;
begin
  if coalesce(current_setting('nt_canary.cell', true), '') <> 'arming-probe' then
    return;
  end if;
  n := nextval('nt_canary.hit_' || p_fn);
  raise log 'NT_CANARY_HIT fn=% n=% cell=% role=% args=%',
    p_fn, n, coalesce(current_setting('nt_canary.cell', true), '-'),
    coalesce(current_setting('role', true), '-'), p_args;
  insert into nt_canary.calls
    (fn, args, cell, session_user_name, current_user_name, role_guc,
     application_name, client_addr, top_query)
  values (p_fn, p_args, current_setting('nt_canary.cell', true),
     session_user, current_user, current_setting('role', true),
     current_setting('application_name', true), inet_client_addr(),
     left(current_query(), 500));
end $$;
