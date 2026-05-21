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

`tests/rls.test.sql` verifies Row-Level Security isolation and the credential
lockdown. It needs two existing auth users:

```bash
psql "$DATABASE_URL" \
  -v user_a='<uuid>' -v user_b='<uuid>' \
  -f supabase/tests/rls.test.sql
```

A clean run prints `RLS OK` and rolls back (leaves no data).

## Security notes

- Alpaca API keys are stored **only** in Supabase Vault. The `accounts` table
  holds Vault secret UUIDs, never plaintext.
- `get_account_credentials()` is callable by the **service role only**.
- Every account-scoped table has RLS; users see only their own accounts' rows.
- The service-role key belongs in server environments only (Vercel server
  scope, GitHub Actions Secrets) — never in a client bundle or `NEXT_PUBLIC_*`.
