#!/usr/bin/env bash
# =============================================================================
# run_concurrency.sh — the race tests, run as actual races.
#
# Two separate psql processes, two separate connections, two overlapping
# transactions. A sequential mock cannot exercise any of this: the whole point
# of the bug being tested is that each session reads state the other has not
# committed yet, which is unreachable from one connection.
#
# 1. Two concurrent `create_account_atomic` calls with the *same* Vault UUIDs.
#    `SELECT EXISTS` let both commit, because neither could see the other's
#    uncommitted insert. Exactly one may now succeed.
#
# 2. Two concurrent refreshes of one account. Both reserve, then publish in
#    reverse order. The older generation must be refused.
#
# 3. Deleting the winner of (1) must not disturb any other account.
#
# Requires docker. Usage:  supabase/tests/run_concurrency.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
TESTS="$REPO_ROOT/supabase/tests"
WORK="$(mktemp -d)"
PG_NAME="nt-race-$$"
PG_PORT="${PG_PORT:-55493}"

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> postgres 16"
docker run -d --name "$PG_NAME" \
  -e POSTGRES_PASSWORD=postgres -p "$PG_PORT:5432" postgres:16-alpine >/dev/null

DATABASE_URL="postgres://postgres:postgres@localhost:$PG_PORT/postgres"
PSQL=(psql "$DATABASE_URL" --quiet --no-psqlrc -v ON_ERROR_STOP=1)

# Wait on the connection this script will actually use. `pg_isready` inside the
# container answers from the temporary initdb server and races the restart.
ready=0
for _ in $(seq 1 90); do
  if psql "$DATABASE_URL" --quiet --no-psqlrc -tAc 'select 1' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "postgres did not accept a connection"; exit 1; }

echo "==> platform scaffolding"
"${PSQL[@]}" -f "$TESTS/bootstrap_local.sql" >/dev/null 2>&1

echo "==> applying migrations"
for file in "$MIGRATIONS"/*.sql; do
  sed -e 's/^create extension if not exists supabase_vault cascade;/-- [test harness] supabase_vault provided by bootstrap_local.sql/' \
      "$file" > "$WORK/$(basename "$file")"
  "${PSQL[@]}" -f "$WORK/$(basename "$file")" >/dev/null 2>&1
done

OWNER='00000000-0000-0000-0000-0000000000c1'
"${PSQL[@]}" >/dev/null <<SQL
insert into auth.users (id, email) values ('$OWNER', 'race@example.test')
  on conflict do nothing;
SQL

# ---------------------------------------------------------------------------
# 1. Two concurrent create_account_atomic calls, same Vault UUIDs.
# ---------------------------------------------------------------------------
echo "==> race 1: two concurrent create_account_atomic with the same secrets"

read -r KEY_ID SECRET_ID <<<"$(psql "$DATABASE_URL" -tA --no-psqlrc -F' ' -c \
  "select vault.create_secret('RACE-KEY','race-key'), vault.create_secret('RACE-SECRET','race-secret');")"

# A bystander account that must be untouched by anything below.
"${PSQL[@]}" >/dev/null <<SQL
select vault.create_secret('BYSTANDER-KEY','bk') as bk \\gset
select vault.create_secret('BYSTANDER-SECRET','bs') as bs \\gset
select create_account_atomic('$OWNER', 'Bystander', 'paper', '#111111',
  :'bk'::uuid, :'bs'::uuid, 'PA-BYSTANDER');
SQL

# Both sessions hold their transaction open past the RPC, which is precisely
# the window `SELECT EXISTS` could not see across.
racer() {
  local nick="$1" out="$2"
  psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -tA >"$out" 2>&1 <<SQL || true
begin;
select create_account_atomic('$OWNER', '$nick', 'paper', '#222222',
  '$KEY_ID'::uuid, '$SECRET_ID'::uuid, 'PA-$nick') is not null as created;
select pg_sleep(1.5);
commit;
SQL
}

racer "RacerA" "$WORK/a.out" &
A=$!
racer "RacerB" "$WORK/b.out" &
B=$!
wait "$A" "$B"

WINNERS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from accounts where nickname in ('RacerA','RacerB') and deleted_at is null;")
ASSIGNMENTS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from account_credential_assignment where secret_id in ('$KEY_ID','$SECRET_ID');")

if [ "$WINNERS" != "1" ]; then
  echo "FAIL: $WINNERS accounts were created from two concurrent calls (expected exactly 1)"
  echo "--- session A ---"; cat "$WORK/a.out"
  echo "--- session B ---"; cat "$WORK/b.out"
  exit 1
fi
if [ "$ASSIGNMENTS" != "2" ]; then
  echo "FAIL: the credential assignment table holds $ASSIGNMENTS rows for the shared secrets (expected 2)"
  exit 1
fi
echo "    exactly one of two concurrent creations committed"

# ---------------------------------------------------------------------------
# 2. Deleting the winner must not disturb the bystander.
# ---------------------------------------------------------------------------
echo "==> race 1b: deleting the winner leaves other accounts intact"
"${PSQL[@]}" >/dev/null <<SQL
select delete_account_atomic(
  (select id from accounts where nickname in ('RacerA','RacerB') and deleted_at is null),
  '$OWNER', false);
SQL
BYSTANDER=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from accounts where nickname = 'Bystander'
     and deleted_at is null and alpaca_key_secret_id is not null;")
if [ "$BYSTANDER" != "1" ]; then
  echo "FAIL: deleting the race winner damaged another account"
  exit 1
fi
echo "    the bystander account is untouched"

# ---------------------------------------------------------------------------
# 3. Two concurrent refreshes, published in reverse order.
# ---------------------------------------------------------------------------
echo "==> race 2: two concurrent refreshes published in reverse order"

ACCOUNT=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select id from accounts where nickname = 'Bystander' and deleted_at is null;")

"${PSQL[@]}" >/dev/null <<SQL
insert into equity_snapshots (account_id, snapshot_date, equity, cash, source)
select '$ACCOUNT', date '2026-05-04' + n, 1000 + n, 0, 'alpaca_portfolio_history'
from generate_series(0, 4) n;
SQL

# Both reserve first — the interleaving that matters — then publish B, then A.
TOK_A=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select begin_broker_refresh('$ACCOUNT','$OWNER') ->> 'token';")
TOK_B=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select begin_broker_refresh('$ACCOUNT','$OWNER') ->> 'token';")

payload() { # $1 = number of days
  cat <<SQL
(select coalesce(jsonb_agg(jsonb_build_object(
   'snapshot_date', date '2026-05-04' + n, 'equity', 1000 + n, 'cash', 0,
   'profit_loss', null, 'profit_loss_pct', null)), '[]'::jsonb)
   from generate_series(0, $1) n)
SQL
}

# B publishes six days (one more than stored).
psql "$DATABASE_URL" -tA --no-psqlrc -v ON_ERROR_STOP=1 >/dev/null <<SQL
select publish_broker_refresh('$TOK_B'::uuid, $(payload 5), true,
  '[]'::jsonb, date '2026-05-04', true, 0, true);
SQL

# A now arrives late with the older reservation.
set +e
A_OUT=$(psql "$DATABASE_URL" -tA --no-psqlrc -v ON_ERROR_STOP=1 2>&1 <<SQL
select publish_broker_refresh('$TOK_A'::uuid, $(payload 5), true,
  '[]'::jsonb, date '2026-05-04', true, 0, true);
SQL
)
A_STATUS=$?
set -e

if [ "$A_STATUS" -eq 0 ]; then
  echo "FAIL: the older reservation published over a newer one"
  exit 1
fi
case "$A_OUT" in
  *"not newer than the published generation"*) ;;
  *) echo "FAIL: unexpected refusal for the stale reservation: $A_OUT"; exit 1;;
esac

ROWS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from equity_snapshots where account_id = '$ACCOUNT';")
if [ "$ROWS" != "6" ]; then
  echo "FAIL: the mirror holds $ROWS rows after the reverse-order publish (expected 6)"
  exit 1
fi
echo "    the stale reservation was refused and the newer data survived"

# ---------------------------------------------------------------------------
# 4. publish must serialize against a rotation, not merely read past it.
#
# `publish_broker_refresh` re-checks the account's identity with a plain
# SELECT. Under READ COMMITTED each statement inside the function takes a new
# snapshot, so a rotation committing between the identity check and the upsert
# is invisible: the publish writes data fetched with credentials that no
# longer exist and reports success.
#
# The deterministic way to test the lock rather than the race: hold the lock
# the publish must acquire, and require the publish to wait for it.
# ---------------------------------------------------------------------------
echo "==> race 3: publish serializes against a held account lock"

TOK=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select begin_broker_refresh('$ACCOUNT','$OWNER') ->> 'token';")

# Session A holds the accounts row exactly as rotate/verify/delete do.
psql "$DATABASE_URL" --no-psqlrc -tA >"$WORK/holder.out" 2>&1 <<SQL &
begin;
select id from accounts where id = '$ACCOUNT' for update;
select pg_sleep(8);
commit;
SQL
HOLDER=$!
sleep 2

set +e
START=$(date +%s)
P_OUT=$(psql "$DATABASE_URL" -tA --no-psqlrc -v ON_ERROR_STOP=1 2>&1 <<SQL
select publish_broker_refresh('$TOK'::uuid, $(payload 5), true,
  '[]'::jsonb, date '2026-05-04', true, 0, true);
SQL
)
P_STATUS=$?
ELAPSED=$(( $(date +%s) - START ))
set -e
wait "$HOLDER" 2>/dev/null || true

# Waiting proves the lock is taken. Returning immediately proves it is not.
if [ "$ELAPSED" -lt 3 ]; then
  echo "FAIL: publish did not wait for the account lock (${ELAPSED}s, status $P_STATUS)"
  echo "      it read the account with a plain SELECT, so a rotation committing"
  echo "      mid-publish would be invisible."
  echo "$P_OUT" | head -3
  exit 1
fi
echo "    publish waited ${ELAPSED}s for the account lock before proceeding"

# ---------------------------------------------------------------------------
# 5. Deleting an account frees its Vault ids for reuse, atomically.
# ---------------------------------------------------------------------------
echo "==> race 4: delete-vs-create reuse of the same Vault ids"

read -r R_KEY R_SECRET <<<"$(psql "$DATABASE_URL" -tA --no-psqlrc -F' ' -c \
  "select vault.create_secret('REUSE-KEY','rk'), vault.create_secret('REUSE-SECRET','rs');")"
"${PSQL[@]}" >/dev/null <<SQL
select create_account_atomic('$OWNER', 'ToDelete', 'paper', '#333333',
  '$R_KEY'::uuid, '$R_SECRET'::uuid, 'PA-TODELETE');
SQL
TO_DELETE=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select id from accounts where nickname='ToDelete' and deleted_at is null;")

# The delete and a creation reusing the very same ids, started together.
psql "$DATABASE_URL" --no-psqlrc -tA >"$WORK/del.out" 2>&1 <<SQL &
begin;
select delete_account_atomic('$TO_DELETE', '$OWNER', false);
select pg_sleep(1.5);
commit;
SQL
D=$!
psql "$DATABASE_URL" --no-psqlrc -tA >"$WORK/new.out" 2>&1 <<SQL &
begin;
select pg_sleep(0.3);
select create_account_atomic('$OWNER', 'Reuser', 'paper', '#444444',
  '$R_KEY'::uuid, '$R_SECRET'::uuid, 'PA-REUSER');
commit;
SQL
N=$!
wait "$D" "$N" 2>/dev/null || true

LIVE=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from account_credential_assignment where secret_id in ('$R_KEY','$R_SECRET');")
OWNERS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(distinct account_id) from account_credential_assignment
    where secret_id in ('$R_KEY','$R_SECRET');")
if [ "$LIVE" != "0" ] && [ "$LIVE" != "2" ]; then
  echo "FAIL: the reused Vault ids hold $LIVE assignments (expected 0 or 2)"
  cat "$WORK/del.out" "$WORK/new.out"
  exit 1
fi
if [ "$LIVE" = "2" ] && [ "$OWNERS" != "1" ]; then
  echo "FAIL: the reused Vault ids are split across $OWNERS accounts"
  exit 1
fi
echo "    the reused ids ended up owned by exactly one account (or none)"

# ---------------------------------------------------------------------------
# 6. A rotation between reservation and publish refuses the publish.
#
# Two connections: one reserves with credentials and holds the payload, the
# other rotates. The reservation records the version the key belonged to, so
# the publish can tell that the key it used is gone.
# ---------------------------------------------------------------------------
echo "==> race 5: refresh-vs-rotate across two connections"

ISSUED=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select begin_broker_refresh_with_credentials('$ACCOUNT','$OWNER')::text;")
TOK5=$(echo "$ISSUED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
VER5=$(echo "$ISSUED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["credential_version"])')
KEY5=$(echo "$ISSUED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["api_key"])')
if [ -z "$KEY5" ] || [ "$KEY5" = "None" ]; then
  echo "FAIL: the reservation returned no credentials"
  exit 1
fi

# A separate connection rotates while the first still holds its payload.
psql "$DATABASE_URL" -q --no-psqlrc -v ON_ERROR_STOP=1 >/dev/null <<SQL
select rotate_account_credentials('$ACCOUNT', '$OWNER',
  'ROTATED-KEY', 'ROTATED-SECRET', 'PA-BYSTANDER');
SQL

set +e
R_OUT=$(psql "$DATABASE_URL" -tA --no-psqlrc -v ON_ERROR_STOP=1 2>&1 <<SQL
select publish_broker_refresh('$TOK5'::uuid, $(payload 5), true,
  '[]'::jsonb, date '2026-05-04', true, 0, true);
SQL
)
R_STATUS=$?
set -e
if [ "$R_STATUS" -eq 0 ]; then
  echo "FAIL: a publish survived a rotation that happened after its reservation"
  exit 1
fi
case "$R_OUT" in
  *"credentials changed"*) ;;
  *) echo "FAIL: unexpected refusal after rotation: $R_OUT"; exit 1;;
esac
NEWVER=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select credential_version from accounts where id = '$ACCOUNT';")
if [ "$NEWVER" = "$VER5" ]; then
  echo "FAIL: the rotation did not advance the credential version"
  exit 1
fi
echo "    the publish was refused because its key had been rotated away ($VER5 -> $NEWVER)"

echo "ALL CONCURRENCY TESTS PASSED"
