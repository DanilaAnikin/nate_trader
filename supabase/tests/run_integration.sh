#!/usr/bin/env bash
# =============================================================================
# run_integration.sh — apply the real migrations to a real PostgreSQL server
# and run the accounts-lockdown assertions against them.
#
# This is a genuine database test, not a grep over SQL text: every policy,
# grant and trigger under test is the one the migrations actually create.
#
# Usage:
#   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
#     supabase/tests/run_integration.sh
# =============================================================================
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
TESTS="$REPO_ROOT/supabase/tests"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PSQL=(psql "$DATABASE_URL" --quiet --no-psqlrc -v ON_ERROR_STOP=1)

echo "==> platform scaffolding (roles, auth, vault, storage)"
"${PSQL[@]}" -f "$TESTS/bootstrap_local.sql" >/dev/null

# The only edit made to any migration: `create extension supabase_vault` cannot
# run on stock PostgreSQL, and bootstrap_local.sql provides the `vault` schema
# it would have created. Every other statement is applied verbatim.
echo "==> applying migrations"
for file in "$MIGRATIONS"/*.sql; do
  name="$(basename "$file")"
  sed -e 's/^create extension if not exists supabase_vault cascade;/-- [test harness] supabase_vault provided by bootstrap_local.sql/' \
      "$file" > "$WORK/$name"
  echo "    - $name"
  "${PSQL[@]}" -f "$WORK/$name" >/dev/null
done

echo "==> seeding two auth users"
USER_A="00000000-0000-0000-0000-00000000000a"
USER_B="00000000-0000-0000-0000-00000000000b"
"${PSQL[@]}" -c "insert into auth.users (id, email) values
    ('$USER_A', 'a@example.test'), ('$USER_B', 'b@example.test')
  on conflict (id) do nothing;" >/dev/null

echo "==> accounts lockdown assertions"
"${PSQL[@]}" -v user_a="$USER_A" -v user_b="$USER_B" \
  -f "$TESTS/accounts_server_managed.test.sql"

echo "==> client read exposure assertions"
"${PSQL[@]}" -v user_a="$USER_A" -v user_b="$USER_B" \
  -f "$TESTS/client_read_exposure.test.sql"

echo "==> account lifecycle transaction assertions"
"${PSQL[@]}" -v user_a="$USER_A" -v user_b="$USER_B" \
  -f "$TESTS/account_lifecycle.test.sql"

echo "==> broker refresh generation and ingest guards"
"${PSQL[@]}" -v user_a="$USER_A" -v user_b="$USER_B" \
  -f "$TESTS/broker_refresh.test.sql"

echo "==> 0022 token generations, broker binding and the audit guard"
"${PSQL[@]}" -v user_a="$USER_A" -v user_b="$USER_B" \
  -f "$TESTS/token_and_binding.test.sql"

echo "==> legacy RLS assertions"
"${PSQL[@]}" -v user_a="$USER_A" -v user_b="$USER_B" \
  -f "$TESTS/rls.test.sql"

echo "ALL SUPABASE INTEGRATION TESTS PASSED"
