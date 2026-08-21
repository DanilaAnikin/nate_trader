-- ===========================================================================
-- 16_reset_probe_account.sql — put the probe account back, between mutant cells
--
-- Only the MUTANT run uses this, and it exists for an unglamorous reason: the
-- unfrozen `DELETE /api/accounts/[id]` works. Once the first cell has
-- soft-deleted the probe account, every later cell gets a 404 from the
-- ownership lookup and never reaches `vault_delete_secret` — so the mutant
-- would appear to stop reaching the canary after cell 1, and "the sensor fires"
-- would rest on a single observation instead of on the matrix.
--
-- The frozen run never calls this. Its commitments are therefore compared
-- across the whole matrix with nothing at all written in between, which is the
-- stronger statement and the one property (A) needs.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

do $$
declare
  key_id    uuid;
  secret_id uuid;
begin
  select id into key_id from vault.secrets where name = 'runtime-canary-probe-key';
  if key_id is null then
    key_id := vault.create_secret(
      'FAKE-KEY-NOT-A-CREDENTIAL', 'runtime-canary-probe-key',
      'runtime-canary fixture; never a real Alpaca key');
  end if;
  select id into secret_id from vault.secrets where name = 'runtime-canary-probe-secret';
  if secret_id is null then
    secret_id := vault.create_secret(
      'FAKE-SECRET-NOT-A-CREDENTIAL', 'runtime-canary-probe-secret',
      'runtime-canary fixture; never a real Alpaca secret');
  end if;

  insert into public.accounts (
    id, owner_id, nickname, mode, status, color,
    alpaca_key_secret_id, alpaca_secret_secret_id, alpaca_account_number,
    is_active, last_verified_at
  ) values (
    '44444444-4444-4444-8444-444444444444',
    '33333333-3333-4333-8333-333333333333',
    'Canary Probe Account', 'paper', 'connected', '#123456',
    key_id, secret_id, 'PA-CANARY-0000',
    true, now()
  )
  on conflict (id) do update set
    deleted_at              = null,
    is_active               = true,
    status                  = 'connected',
    nickname                = 'Canary Probe Account',
    alpaca_key_secret_id    = excluded.alpaca_key_secret_id,
    alpaca_secret_secret_id = excluded.alpaca_secret_secret_id,
    alpaca_account_number   = 'PA-CANARY-0000';
end $$;

-- If the reset did not restore a usable target, the next mutant cell would
-- silently degrade to "nothing happened" — which reads exactly like a pass.
do $$
declare k uuid; s uuid; d timestamptz;
begin
  select alpaca_key_secret_id, alpaca_secret_secret_id, deleted_at
    into k, s, d
    from public.accounts where id = '44444444-4444-4444-8444-444444444444';
  if k is null or s is null or d is not null then
    raise exception
      'probe account reset failed (key=%, secret=%, deleted_at=%) — the mutant would have nothing to delete',
      k, s, d using errcode = 'P0001';
  end if;
end $$;

select 'PROBE_ACCOUNT_RESET=ok' as verdict;
