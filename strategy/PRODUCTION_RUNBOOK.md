# V11 paper-production runbook

## Supported scope

This deployment is forward validation on one Alpaca **paper** account. It is
not a live-money release. `TRADING_MODE=paper`, the hard-coded Alpaca paper
endpoint, the canonical validation artifact, and the current market/risk gates
must all agree before new exposure is allowed.

The scheduled production input is the full immutable commit SHA stored in the
`paper-production` environment variable `PRODUCTION_RELEASE_SHA`. The workflow
requires a successful `V11 Release Gate` for that exact SHA before it accesses
the broker. Runtime broker reconciliation state is kept in a private Actions
artifact named for the approved SHA rather than committed to this public
repository. Its JSON schema and release lineage are validated before restore.
Workflow concurrency permits only one execution at a time.

## Release contract

- Python is exactly 3.12.11.
- Production dependencies come only from the hash-locked
  `requirements.lock`.
- The complete test suite, compile check, deployment lint, canonical validator,
  and `scripts/sanity_check.py` must pass in that exact runtime.
- `state/backtest/v11_validation.json` must report `PASS` and
  `paper-validation-eligible`; its code, runtime, universe, and adjusted-bar
  fingerprints must match the checkout.
- The current promoted universe is the exact 540-symbol validated watchlist
  fallback. A dynamic Alpaca universe refresh is a new release: fetch full
  adjusted history, rerun the canonical validator, and promote only if it
  passes.

## Deployment and canary

1. Push the reviewed release commit, wait for its `V11 Release Gate`, and create
   an immutable release tag.
2. Set `PRODUCTION_RELEASE_SHA` in the `paper-production` GitHub environment to
   the full tagged commit SHA.
3. Run `V11 Paper Production` manually with `operation=preflight`.
4. Require a green offline sanity check, paper endpoint/account check, current
   broker clock, no shorts, a fresh rolling risk snapshot, and a dry-run that
   performs no mutations.
5. Inspect the dry-run plan and account snapshot. A closed weekend/holiday
   market is acceptable for preflight; a stale broker clock is not.
6. The weekday scheduler runs at 15:05 UTC, which is 10:05 EST or 11:05 EDT.
   Alpaca's clock remains authoritative and blocks new exposure outside the
   regular session.
7. The first open-market run is the canary. Inspect its Actions result and
   Alpaca paper orders before treating later cycles as unattended validation.

No dynamic universe refresh, optimizer, legacy sleeve, options executor,
Supabase multi-account client, or auto-iteration job belongs to this workflow.

## Monitoring

- Every run emits a JSON preflight report and retains diagnostics for 30 days.
- A mutating run writes `state/production/last_run.json` and uploads the exact
  runtime state for 90 days, including on a partial failure.
- `ABORT` or `ERROR` execution actions make the production runner return
  non-zero.
- A failed workflow opens or updates one P1 GitHub issue. No failed gate is
  allowed to degrade into an entry.
- The validation evidence expires after 35 days. Staleness automatically blocks
  buys; refresh data and regenerate the fixed report before expiry.

## Rollback / emergency stop

1. Disable the workflow first:
   `gh workflow disable paper-production.yml --repo DanilaAnikin/nate_trader`.
2. Inspect the paper account, open orders, positions, latest diagnostic
   artifact, and latest `paper-runtime-state` artifact.
3. Cancel only pending directional BUY intent. Preserve risk-reducing SELLs and
   do not assume an accepted order was filled.
4. If a code rollback is required, revert to a known tagged release. Its own
   matching validation artifact and runtime lock must pass before another BUY;
   never copy a newer PASS artifact onto older code.
5. Restore a prior runtime artifact only when it belongs to the same paper
   account and release lineage. Broker positions and orders remain authoritative.
6. Re-enable the workflow only after a new manual preflight and dry-run pass.

For a complete strategy rollback to cash, use the guarded executor's zero-target
risk-off path during an open paper session and reconcile until the broker is
flat. Do not delete state or issue blind bulk orders.
