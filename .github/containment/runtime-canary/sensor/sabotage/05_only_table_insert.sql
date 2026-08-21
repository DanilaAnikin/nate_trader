-- SABOTAGE 5 — write the event inside the transaction that rolls back.
-- The table insert is kept and both non-transactional channels are removed, so
-- every call that ends in the tombstone's `raise` takes its own evidence with
-- it. This is the failure mode a table-only sensor cannot distinguish from
-- "the call never happened".
\set ON_ERROR_STOP on
create or replace function nt_canary.log_call(p_fn text, p_args jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, nt_canary
as $$
begin
  insert into nt_canary.calls
    (fn, args, cell, session_user_name, current_user_name, role_guc,
     application_name, client_addr, top_query)
  values (p_fn, p_args, current_setting('nt_canary.cell', true),
     session_user, current_user, current_setting('role', true),
     current_setting('application_name', true), inet_client_addr(),
     left(current_query(), 500));
end $$;
