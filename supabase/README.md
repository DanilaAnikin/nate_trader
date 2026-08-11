# Supabase — Nate Trader data layer

This directory holds the database schema for the Nate Trader multi-account
platform. See `DASHBOARD_SPECIFICATION.md` (§13) for the design and
`DASHBOARD_IMPLEMENTATION_PLAN.md` (Phases 0–1) for the build sequence.

## Migrations

Apply in numeric order against a **dedicated** Supabase project (never a
project shared with another application):

| File | Contents |
|------|----------|
| `0001_enums.sql` | Vault extension + enum types. |
| `0002_profiles_accounts.sql` | `profiles`, `accounts`, the new-user trigger. |
| `0003_helpers.sql` | `owns_account()`, `get_account_credentials()`. |
| `0004_account_state.sql` | `equity_snapshots`, `performance`, `positions`, `trades`, `cash_flows`, `routine_runs`. |
| `0005_shared.sql` | `strategy_params`, `market_history`, research/screener snapshots, `backtest_runs`, `audit_log`. |
| `0006_storage_policies.sql` | Storage buckets `backtest-results`, `research-snapshots`. |
| `0007_advisor_hardening.sql` | Resolve Supabase security-advisor warnings. |
| `0008_vault_wrappers.sql` | Service-role-only `public` wrappers for Vault writes. |
| `0009_accounts_server_managed.sql` | Remove client **writes** to `accounts`; guard server-managed columns. |
| `0010_accounts_guard_authz_fix.sql` | Make that guard `SECURITY INVOKER` so a client role cannot be read as its owner. |
| `0011_revoke_client_reads.sql` | Remove client **reads** of `accounts`, `trades` and `cash_flows`; add the sanitized `*_safe` views. |
| `0012_view_and_write_acl.sql` | Close the `accounts_safe` view and the remaining table-level write grants. |
| `0013_account_lifecycle_rpc.sql` | `create_account_atomic` / `delete_account_atomic` / `update_account_metadata` / `rotate_account_credentials`. |
| `0014_history_snapshot_rpc.sql` | `account_history_snapshot` — equity and flows from one MVCC snapshot. |
| `0015_sequence_and_function_acl.sql` | Revoke sequence privileges; first attempt at closing routine execute (superseded by `0016`). |
| `0016_global_function_acl.sql` | Global `ALTER DEFAULT PRIVILEGES`; the `CREATE PROCEDURE`-aborting event trigger removed; catalogue asserted by live probes inside the migration. |
| `0017_refresh_generation_and_guards.sql` | Refresh generations; NULL and shape guards on the destructive RPCs. |
| `0018_no_delete_reconciliation.sql` | A refresh may never delete; refresh tokens bound to `credential_version`; one Vault secret per account, enforced by a primary key. |
| `0019_lock_order_and_vault_integrity.sql` | One canonical lock order; credentials issued in the same transaction as the token; the Vault assignment table rebuilt with every ambiguity as an abort. |
| `0020_vault_fk_and_idempotent_create.sql` | The Vault foreign key mandatory and catalogue-asserted; `vault_delete_secret` refuses an assigned secret; idempotent creation via a client operation id; the broker account number immutable from creation; credentials never served for a deleted account. |
| `0021_atomic_create_and_verification.sql` | `create_account_operation` writes the Vault secrets, the account, the assignments, the audit entry and the operation record in one transaction under an operation advisory lock; `resolve_create_operation` answers under the same lock; verification is `begin`/`finish` with a single-use token; owner-readable audit rows carry digests rather than identifiers. |
| `0022_fingerprint_binding_and_token_generations.sql` | `resolve_create_operation` takes the expected request fingerprint and returns an explicit `conflict`; one active account per owner, mode and broker account number, added after auditing the existing rows; verification tokens carry an account-scoped monotonic generation, a 60-second TTL and an explicit cancel RPC; the purge reason is a closed enum; a trigger permanently refuses any audit detail carrying a forbidden key or a raw UUID; `record_account_verification`, `create_account_atomic` and the direct Vault helpers become hard failures with no executable grant. |

**Which of these production has applied is not recorded here, and cannot be
inferred from this file.** The Supabase project's own migration ledger is the
only authority. Read it before applying anything, and apply *every* pending
migration in numeric order — a partial application leaves the RPC surface and
the ACL in a state no test covers.

Migrations that have been applied anywhere are never edited; corrections go in
a new migration. `0010` corrects `0009`, `0012` corrects `0011`, `0016`
corrects `0015`, `0018` corrects `0017`, `0019` corrects `0018`, `0020`
corrects `0019` and `0021` corrects `0020`.

**Which of them production has applied is UNKNOWN**, because the ledger has
not been read. Do not infer it from the fact that the running image works.

### How to apply

**Option A — Supabase CLI**

```bash
supabase link --project-ref <project-ref>
supabase db push
```

**Option B — Supabase MCP / SQL editor**

Run each file's contents through `apply_migration` (MCP) or the SQL editor,
in order.

## Tests

Three commands, and all three run in the release gate.

`tests/run_integration.sh` applies every migration to a real PostgreSQL server
and runs every assertion file against it. This is a database test, not a grep
over SQL text.

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  supabase/tests/run_integration.sh
```

The release gate runs exactly this against a `postgres:16-alpine` service.
A clean run prints `ALL SUPABASE INTEGRATION TESTS PASSED`; every script runs
in a transaction and rolls back, leaving no data.

| Script | Proves |
|---|---|
| `accounts_server_managed.test.sql` | A client cannot insert, delete or write any server-managed `accounts` column, and a forged `service_role` claim does not help. |
| `client_read_exposure.test.sql` | Under `set local role authenticated` — the same privileges Supabase REST uses — the `accounts`, `trades` and `cash_flows` base tables and each sensitive column are unreadable, soft-deleted and foreign rows are invisible through the sanitized views, and `anon` sees nothing. |
| `account_lifecycle.test.sql` | Creation, rotation, metadata update and deletion are each one transaction with their audit entry — including that a forced `audit_log` failure rolls the whole operation back. |
| `broker_refresh.test.sql` | A refresh never deletes: 100 stored days against a 99-day payload flagged complete is `RECONCILIATION_CONFLICT` with zero mutation, an empty activity walk leaves the ledger intact, every payload row is validated before the first write, and a credential change between reservation and publish refuses the publish. |
| `rls.test.sql` | Per-owner isolation of account-scoped data and the credential lockdown. |

```bash
supabase/tests/run_postgrest.sh       # the real /rpc/ surface at db-max-rows=100
supabase/tests/run_concurrency.sh     # two connections, overlapping transactions
supabase/tests/run_vault_integrity.sh # 0019/0020 over legacy states that must abort
```

`run_postgrest.sh` proves what a browser can actually reach, and that a single
snapshot returns everything past the server's row cap where a page walk tears.

`run_concurrency.sh` runs the races as actual races — two `psql` processes,
two overlapping transactions. None is reachable from one connection: the bug
in each case was a transaction reading state another had not committed yet.
Exactly one of two concurrent creations for the same broker binding may
commit, an older refresh reservation may not publish over a newer one, a
publish must serialize against a rotation rather than read past it, a delete
and a re-creation of one binding may not both leave a live account, and two
connections running `begin`/`finish` verification in opposite arrival order
must not deadlock — the lock order is account, then token, everywhere.

Each script can also be run on its own with two existing auth users:

```bash
psql "$DATABASE_URL" \
  -v user_a='<uuid>' -v user_b='<uuid>' \
  -f supabase/tests/rls.test.sql
```

## Security notes

- Alpaca API keys are stored **only** in Supabase Vault. The `accounts` table
  holds Vault secret UUIDs, never plaintext.
- `get_account_credentials()` is callable by the **service role only**.
- Every account-scoped table has RLS; users see only their own accounts' rows.
- The service-role key belongs in server environments only (the dashboard
  container's own environment, GitHub Actions Secrets) — never in a client
  bundle or `NEXT_PUBLIC_*`.
- **A refresh RPC must never raise a class-40 SQLSTATE.** `40001`
  (serialization_failure) tells PostgREST the call may succeed on retry, and
  it retries in a loop; a permanent condition raised that way hangs the
  request until the client gives up. Reproduced against PostgREST 12.2.3 with
  `publish_broker_refresh`'s credential-change refusal. Use `P0001` for a
  refusal that retrying cannot fix.
- Removing a mirrored financial row is `retract_equity_snapshot` /
  `retract_cash_flow`: one row, a stated reason, an audit entry. No bulk path
  deletes anything.
