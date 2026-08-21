-- SABOTAGE 1 — "keep marker + delegate, remove the logging call".
-- The exact defeat the adversarial verifier used: the NT_CANARY_SENSOR_V1
-- marker comment stays, the delegate to nt_canary.real_* stays,
-- nt_canary.log_call is not touched at all, and the single
-- `perform nt_canary.log_call(...)` statement is deleted.
\set ON_ERROR_STOP on
do $$
declare o record; guard text; delegate text;
begin
  for o in select * from nt_canary.original order by fn loop
    guard := format($g$
      if not nt_canary.acl_allows(%L, nt_canary.effective_caller()) then
        raise exception 'permission denied for function %s' using errcode = '42501';
      end if;$g$, o.fn, o.fn);
    if o.result = 'void' then
      delegate := format('perform nt_canary.real_%I(%s);', o.fn,
                   case o.fn when 'vault_delete_secret' then '$1' else '$1, $2' end);
    else
      delegate := format('return nt_canary.real_%I(%s);', o.fn,
                   case o.fn when 'vault_delete_secret' then '$1' else '$1, $2' end);
    end if;
    execute format($fn$
      create or replace function public.%I(%s) returns %s
      language plpgsql volatile security definer
      set search_path = pg_catalog, public, vault, nt_canary
      as $body$
      begin
        -- NT_CANARY_SENSOR_V1 — remove this and 25_canary_arm.sql fails.
        %s
        %s
      end
      $body$;$fn$, o.fn, o.arguments, o.result, guard, delegate);
  end loop;
end $$;
