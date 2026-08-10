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

`0009` and `0010` are applied in production and are never edited; corrections
go in a new migration.

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

`tests/run_integration.sh` is the one command that matters: it applies every
migration to a real PostgreSQL server and then runs all three assertion files
against it. This is a database test, not a grep over SQL text.

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
| `rls.test.sql` | Per-owner isolation of account-scoped data and the credential lockdown. |

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
