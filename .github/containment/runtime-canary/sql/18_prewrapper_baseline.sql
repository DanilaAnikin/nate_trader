-- ===========================================================================
-- 18_prewrapper_baseline.sql — what the wrappers do BEFORE the canary exists
--
-- The canary claims to preserve behaviour: it clones each wrapper's body
-- verbatim, records the call, replays the real ACL, and delegates. That claim
-- is worth exactly as much as the evidence for it, and "I copied prosrc" is not
-- evidence — the clone could differ in volatility, in `search_path`, in
-- SECURITY DEFINER, or in argument defaults, and any of those would change the
-- outcome without changing the body text.
--
-- So this file calls all three wrappers on the untouched schema and records
-- exactly what each one did: returned, or raised with which SQLSTATE.
-- 25_canary_arm.sql records the same three outcomes AFTER the canary is
-- installed, and run.sh requires them to match. A canary that quietly changed
-- what a wrapper does would fail that comparison rather than pass the run.
--
-- It runs before the canary, so it leaves no hit on any counter. It cleans up
-- the one secret it may create, so the commitment taken later is unaffected.
--
-- THE OBSERVED OUTCOMES, PER SCHEMA
-- ---------------------------------
-- These are transcribed from real runs on the pinned production image
-- (supabase/postgres@sha256:f371b5f3…67c00), not predicted:
--
--   0001-0008  ALL THREE RETURN. `vault_create_secret` returns a uuid, and
--              `vault_update_secret` and `vault_delete_secret` return void
--              having done their work.
--                BASELINE_OUTCOME=vault_create_secret=returned
--                                 vault_delete_secret=returned
--                                 vault_update_secret=returned
--
--   0001-0023  ALL THREE RAISE P0001 for a privileged caller — 0022's
--              tombstone.
--                BASELINE_OUTCOME=vault_create_secret=raised:P0001
--                                 vault_delete_secret=raised:P0001
--                                 vault_update_secret=raised:P0001
--
-- This comment previously claimed that on 0001-0008 "create returns a uuid;
-- update and delete raise, because this image's vault extension is newer than
-- migration 0008 was written against". That was wrong: the observed 0008
-- baseline is all three returning. A comment is not evidence, so the expected
-- string is no longer only written here — it is recorded per schema in
-- `sql/expected-baseline.<schema>.txt` next to this file and asserted by
-- run.sh, which fails closed when the schema's real behaviour and the recorded
-- expectation disagree. A future drift now breaks a run instead of silently
-- outdating a paragraph.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

create temporary table nt_baseline (fn text primary key, outcome text);

do $$
declare
  probe_id uuid;
  st       text;
begin
  begin
    probe_id := public.vault_create_secret(
      'NOT-A-CREDENTIAL-BASELINE-PROBE', 'nt-canary-baseline-probe');
    insert into nt_baseline values ('vault_create_secret', 'returned');
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    insert into nt_baseline values ('vault_create_secret', 'raised:' || st);
  end;

  begin
    perform public.vault_update_secret(
      coalesce(probe_id, '00000000-0000-4000-8000-0000000000bb'::uuid),
      'NOT-A-CREDENTIAL-BASELINE-PROBE-2');
    insert into nt_baseline values ('vault_update_secret', 'returned');
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    insert into nt_baseline values ('vault_update_secret', 'raised:' || st);
  end;

  begin
    perform public.vault_delete_secret(
      coalesce(probe_id, '00000000-0000-4000-8000-0000000000bb'::uuid));
    insert into nt_baseline values ('vault_delete_secret', 'returned');
  exception when others then
    get stacked diagnostics st = returned_sqlstate;
    insert into nt_baseline values ('vault_delete_secret', 'raised:' || st);
  end;
end $$;

delete from vault.secrets where name = 'nt-canary-baseline-probe';

select 'BASELINE_OUTCOME=' ||
       string_agg(fn || '=' || outcome, ' ' order by fn)
  from nt_baseline;
