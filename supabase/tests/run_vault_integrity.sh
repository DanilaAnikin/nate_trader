#!/usr/bin/env bash
# =============================================================================
# run_vault_integrity.sh — 0019 must refuse to run on an ambiguous legacy
# Vault state instead of papering over it.
#
# 0018 backfilled `account_credential_assignment` with `ON CONFLICT DO
# NOTHING`. That is not a resolution of a conflict, it is a way of not
# noticing one: two accounts sharing a secret produced a table with one of
# them missing, and the primary key then "held" over data it had never seen.
#
# Each case below builds the legacy state *before* 0019, applies 0019, and
# requires it to abort with a message naming the problem. The last case is the
# clean one, which must apply and then prove exact correspondence.
#
# Requires docker. Usage:  supabase/tests/run_vault_integrity.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
TESTS="$REPO_ROOT/supabase/tests"
WORK="$(mktemp -d)"
PG_NAME="nt-vault-$$"
PG_PORT="${PG_PORT:-55494}"
OWNER='00000000-0000-0000-0000-0000000000d1'

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

docker run -d --name "$PG_NAME" \
  -e POSTGRES_PASSWORD=postgres -p "$PG_PORT:5432" postgres:16-alpine >/dev/null

DATABASE_URL="postgres://postgres:postgres@localhost:$PG_PORT/postgres"

ready=0
for _ in $(seq 1 90); do
  if psql "$DATABASE_URL" --quiet --no-psqlrc -tAc 'select 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "postgres did not accept a connection"; exit 1; }

# Every migration is copied once; the harness only ever edits the vault
# extension line, exactly as the other suites do.
for file in "$MIGRATIONS"/*.sql; do
  sed -e 's/^create extension if not exists supabase_vault cascade;/-- [test harness] supabase_vault provided by bootstrap_local.sql/' \
      "$file" > "$WORK/$(basename "$file")"
done

MIGRATION_0019="$WORK/0019_lock_order_and_vault_integrity.sql"

# Apply 0001-0018 into a fresh database named after the case.
prepare() {
  local db="$1"
  psql "$DATABASE_URL" -q --no-psqlrc -c "drop database if exists $db" >/dev/null
  psql "$DATABASE_URL" -q --no-psqlrc -c "create database $db" >/dev/null
  local url="postgres://postgres:postgres@localhost:$PG_PORT/$db"
  psql "$url" -q --no-psqlrc -v ON_ERROR_STOP=1 -f "$TESTS/bootstrap_local.sql" >/dev/null 2>&1
  for file in "$WORK"/00{01,02,03,04,05,06,07,08,09,10,11,12,13,14,15,16,17,18}_*.sql; do
    psql "$url" -q --no-psqlrc -v ON_ERROR_STOP=1 -f "$file" >/dev/null 2>&1
  done
  psql "$url" -q --no-psqlrc -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into auth.users (id, email) values ('$OWNER', 'vault@example.test')
  on conflict do nothing;
SQL
  echo "$url"
}

# Insert an account row directly, bypassing the RPC, exactly as a legacy row
# would already exist.
seed_account() {
  local url="$1" nick="$2" key="$3" sec="$4"
  psql "$url" -q --no-psqlrc -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into accounts (owner_id, nickname, mode, status, alpaca_account_number,
                      alpaca_key_secret_id, alpaca_secret_secret_id)
values ('$OWNER', '$nick', 'paper', 'connected', 'PA-$nick',
        $key, $sec);
SQL
}

secret() { # $1 = url, $2 = name
  psql "$1" -tA --no-psqlrc -c "select vault.create_secret('$2','v');"
}

expect_abort() { # $1 = url, $2 = label, $3 = expected fragment
  local out status
  set +e
  out=$(psql "$1" --no-psqlrc -v ON_ERROR_STOP=1 -f "$MIGRATION_0019" 2>&1)
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "FAIL: 0019 applied cleanly over $2"
    exit 1
  fi
  case "$out" in
    *"$3"*) echo "    aborted on $2" ;;
    *) echo "FAIL: 0019 aborted on $2 for the wrong reason:"; echo "$out" | tail -4; exit 1 ;;
  esac
}

echo "==> case 1: one secret shared by two active accounts"
URL=$(prepare vault_shared)
K=$(secret "$URL" SHARED-K); S1=$(secret "$URL" S1); S2=$(secret "$URL" S2)
seed_account "$URL" "AccA" "'$K'" "'$S1'"
seed_account "$URL" "AccB" "'$K'" "'$S2'"
expect_abort "$URL" "a shared key" "shared Vault ids"

echo "==> case 2: one secret used as A's key and B's secret (cross-slot)"
URL=$(prepare vault_crossslot)
X=$(secret "$URL" CROSS); Y=$(secret "$URL" Y); Z=$(secret "$URL" Z)
seed_account "$URL" "AccA" "'$X'" "'$Y'"
seed_account "$URL" "AccB" "'$Z'" "'$X'"
expect_abort "$URL" "a cross-slot share" "shared Vault ids"

echo "==> case 3: an id that is not in the vault"
URL=$(prepare vault_dangling)
G=$(secret "$URL" GOOD)
seed_account "$URL" "AccA" "'$G'" "'00000000-0000-0000-0000-0000000000ff'"
expect_abort "$URL" "a dangling id" "dangling Vault ids"

echo "==> case 4: a null credential id on an active account"
URL=$(prepare vault_null)
G=$(secret "$URL" GOOD)
seed_account "$URL" "AccA" "'$G'" "null"
expect_abort "$URL" "a null id" "null or self-referential"

echo "==> case 5: the same id in both slots of one account"
URL=$(prepare vault_selfref)
G=$(secret "$URL" SELF)
seed_account "$URL" "AccA" "'$G'" "'$G'"
expect_abort "$URL" "a self-referential pair" "null or self-referential"

echo "==> case 6: a clean legacy state applies and is then proved"
URL=$(prepare vault_clean)
K1=$(secret "$URL" K1); S1=$(secret "$URL" S1)
K2=$(secret "$URL" K2); S2=$(secret "$URL" S2)
seed_account "$URL" "AccA" "'$K1'" "'$S1'"
seed_account "$URL" "AccB" "'$K2'" "'$S2'"
psql "$URL" -q --no-psqlrc -v ON_ERROR_STOP=1 -f "$MIGRATION_0019" >/dev/null
ROWS=$(psql "$URL" -tA --no-psqlrc -c "select count(*) from account_credential_assignment;")
if [ "$ROWS" != "4" ]; then
  echo "FAIL: the rebuilt assignment table holds $ROWS rows (expected 4)"
  exit 1
fi
# The correspondence the migration asserts, checked again from outside it.
BAD=$(psql "$URL" -tA --no-psqlrc -c "
select count(*) from accounts a
 where a.deleted_at is null
   and not (
     exists (select 1 from account_credential_assignment x
              where x.account_id=a.id and x.role='key'
                and x.secret_id=a.alpaca_key_secret_id)
     and exists (select 1 from account_credential_assignment x
                  where x.account_id=a.id and x.role='secret'
                    and x.secret_id=a.alpaca_secret_secret_id));")
if [ "$BAD" != "0" ]; then
  echo "FAIL: $BAD account(s) do not match their assignments"
  exit 1
fi
echo "    applied, and every active account matches its two assignments exactly"

echo "==> case 7: a deleted account's ids are not carried into the table"
URL=$(prepare vault_deleted)
K1=$(secret "$URL" K1); S1=$(secret "$URL" S1)
seed_account "$URL" "Gone" "'$K1'" "'$S1'"
psql "$URL" -q --no-psqlrc -v ON_ERROR_STOP=1 >/dev/null <<SQL
update accounts set deleted_at = now() where nickname = 'Gone';
SQL
psql "$URL" -q --no-psqlrc -v ON_ERROR_STOP=1 -f "$MIGRATION_0019" >/dev/null
ROWS=$(psql "$URL" -tA --no-psqlrc -c "select count(*) from account_credential_assignment;")
if [ "$ROWS" != "0" ]; then
  echo "FAIL: a soft-deleted account left $ROWS assignment(s) behind"
  exit 1
fi
echo "    a soft-deleted account holds no claim on its former ids"

echo "ALL VAULT INTEGRITY TESTS PASSED"
