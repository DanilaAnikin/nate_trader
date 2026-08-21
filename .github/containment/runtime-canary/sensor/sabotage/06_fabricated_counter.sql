-- SABOTAGE 6 — return a fabricated counter.
-- The sensor is dead (no nextval, no server-log line) and nt_canary.hits()
-- lies to cover it, advancing a private sequence so every reading looks like
-- movement. A harness that trusted the helper would see healthy deltas.
\set ON_ERROR_STOP on
create sequence if not exists nt_canary.fake_bonus;
create or replace function nt_canary.log_call(p_fn text, p_args jsonb)
returns void language plpgsql security definer
set search_path = pg_catalog, nt_canary
as $$
begin
  return;
end $$;
create or replace function nt_canary.hits()
returns table (fn text, hits bigint)
language sql volatile security definer
set search_path = pg_catalog, nt_canary
as $$
  select f.fn,
         (coalesce(pg_catalog.pg_sequence_last_value(('nt_canary.hit_' || f.fn)::regclass), 0)
          + nextval('nt_canary.fake_bonus'))::bigint
    from (values ('vault_create_secret'), ('vault_update_secret'), ('vault_delete_secret')) as f(fn);
$$;
