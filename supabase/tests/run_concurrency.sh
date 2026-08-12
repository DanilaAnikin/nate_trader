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

# ---------------------------------------------------------------------------
# Concurrent workers, with their exit status kept.
#
# The workers used to run without ON_ERROR_STOP and with `|| true`, which is
# two ways of throwing the same information away: psql exits 0 after a failed
# statement unless told otherwise, and `|| true` discards even that. A worker
# that died on the *wrong* error — a syntax mistake, a missing function, a
# connection drop — looked exactly like one that lost a race, and the
# end-state assertions ("exactly one account exists") were satisfied by both.
#
# Every worker now stops on the first error and records its status next to its
# output, and every race asserts what each worker's status was, not only what
# the table looks like afterwards.
# ---------------------------------------------------------------------------
worker() {
  local out="$1" status=0
  # `set +e` for exactly this call. The script runs under `set -e`, and a
  # backgrounded worker is a subshell — so a losing racer's non-zero psql
  # aborted the subshell *before* it could record why, which reads downstream
  # as "the worker never ran" rather than "the worker was refused".
  set +e
  psql "$DATABASE_URL" --no-psqlrc -v ON_ERROR_STOP=1 -tA >"$out" 2>&1
  status=$?
  set -e
  printf '%s\n' "$status" > "$out.status"
  return 0
}

worker_status() {
  cat "$1.status" 2>/dev/null || echo "no-status"
}

# `expect_worker <label> <out> <ok|fail>` — assert one worker's exit status.
expect_worker() {
  local label="$1" out="$2" want="$3" status
  status="$(worker_status "$out")"
  case "$want" in
    ok)
      if [ "$status" != "0" ]; then
        echo "FAIL: $label exited $status, expected success"
        cat "$out"; exit 1
      fi;;
    fail)
      if [ "$status" = "0" ]; then
        echo "FAIL: $label exited 0, expected a refusal"
        cat "$out"; exit 1
      fi
      if [ "$status" = "no-status" ]; then
        echo "FAIL: $label never recorded an exit status"; exit 1
      fi;;
    any)
      if [ "$status" = "no-status" ]; then
        echo "FAIL: $label never recorded an exit status"; exit 1
      fi;;
  esac
}

# Exactly one of two workers succeeded and the other did not.
expect_exactly_one_winner() {
  local a="$1" b="$2" sa sb
  sa="$(worker_status "$a")"; sb="$(worker_status "$b")"
  if [ "$sa" = "no-status" ] || [ "$sb" = "no-status" ]; then
    echo "FAIL: a racer never recorded an exit status ($sa / $sb)"; exit 1
  fi
  if [ "$sa" = "0" ] && [ "$sb" = "0" ]; then
    echo "FAIL: both racers succeeded ($sa / $sb)"; cat "$a" "$b"; exit 1
  fi
  if [ "$sa" != "0" ] && [ "$sb" != "0" ]; then
    echo "FAIL: both racers failed ($sa / $sb)"; cat "$a" "$b"; exit 1
  fi
}

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
# 1. Two concurrent creations for one broker binding, two operation ids.
#
# The client's operation id makes a *retry* idempotent. It cannot make two
# genuinely different submissions idempotent — a reload that loses it, a
# second tab, two sessions — and 0021 had nothing else: two ids produced two
# accounts for one Alpaca account, and every per-account mirror then described
# the same money twice. 0022's partial unique index is the invariant, and this
# is the race that has to hit it.
#
# `create_account_atomic` was the previous subject here. 0022 retired it, so
# the race now runs against the path production actually uses.
# ---------------------------------------------------------------------------
echo "==> race 1: two concurrent creations for one broker binding"

# A bystander account that must be untouched by anything below.
"${PSQL[@]}" >/dev/null <<SQL
select create_account_operation('$OWNER', gen_random_uuid(), repeat('e', 64),
  'Bystander', 'paper', '#111111', 'BK', 'BS', 'PA-BYSTANDER');
SQL

# Both sessions hold their transaction open past the RPC, which is precisely
# the window a `SELECT EXISTS` guard could not see across.
racer() {
  local nick="$1" out="$2" fp="$3"
  worker "$out" <<SQL
begin;
select create_account_operation('$OWNER', gen_random_uuid(), '$fp',
  '$nick', 'paper', '#222222', 'AK', 'AS', 'PA-RACE-BINDING') is not null as created;
select pg_sleep(1.5);
commit;
SQL
}

racer "RacerA" "$WORK/a.out" "$(printf 'a%.0s' $(seq 64))" &
A=$!
racer "RacerB" "$WORK/b.out" "$(printf 'b%.0s' $(seq 64))" &
B=$!
wait "$A" "$B"

# Exit statuses first: the end state alone cannot distinguish "one lost the
# race" from "both died for an unrelated reason and neither wrote".
expect_exactly_one_winner "$WORK/a.out" "$WORK/b.out"

WINNERS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from accounts where nickname in ('RacerA','RacerB') and deleted_at is null;")
# The loser must leave nothing behind: its Vault secrets are created inside the
# same transaction, so the rollback takes them with it.
ORPHANS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from vault.secrets s
    where s.name like 'alpaca_%'
      and not exists (select 1 from account_credential_assignment a
                       where a.secret_id = s.id);")

if [ "$WINNERS" != "1" ]; then
  echo "FAIL: $WINNERS accounts were created from two concurrent calls (expected exactly 1)"
  echo "--- session A ---"; cat "$WORK/a.out"
  echo "--- session B ---"; cat "$WORK/b.out"
  exit 1
fi
if [ "$ORPHANS" != "0" ]; then
  echo "FAIL: the losing creation left $ORPHANS unassigned Vault secrets behind"
  exit 1
fi
echo "    exactly one of two concurrent creations committed, with no orphans"

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

# Session A holds the accounts row and then *rotates* it, exactly as a real
# rotation would. The publish must not merely be slow — it must be refused, and
# the mirror must be untouched afterwards.
ROWS_BEFORE=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from equity_snapshots where account_id = '$ACCOUNT';")
VER_BEFORE=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select credential_version from accounts where id = '$ACCOUNT';")

worker "$WORK/holder.out" <<SQL &
begin;
select id from accounts where id = '$ACCOUNT' for update;
select pg_sleep(3);
select rotate_account_credentials('$ACCOUNT', '$OWNER',
  'LOCKRACE-KEY', 'LOCKRACE-SECRET', 'PA-BYSTANDER');
commit;
SQL
HOLDER=$!
sleep 1

set +e
START=$(date +%s)
P_OUT=$(psql "$DATABASE_URL" -tA --no-psqlrc -v ON_ERROR_STOP=1 2>&1 <<SQL
select publish_broker_refresh('$TOK'::uuid, $(payload 6), true,
  '[]'::jsonb, date '2026-05-04', true, 0, true);
SQL
)
P_STATUS=$?
ELAPSED=$(( $(date +%s) - START ))
set -e
wait "$HOLDER" 2>/dev/null || true

# 1. It must have waited: a plain SELECT would have returned immediately.
if [ "$ELAPSED" -lt 2 ]; then
  echo "FAIL: publish did not wait for the account lock (${ELAPSED}s)"
  echo "      it read the account with a plain SELECT, so a rotation committing"
  echo "      mid-publish would be invisible."
  exit 1
fi
# 2. It must have been refused, not merely delayed. Elapsed time alone would
#    pass even if the publish then went ahead with stale credentials.
if [ "$P_STATUS" -eq 0 ]; then
  echo "FAIL: publish succeeded after waiting for a rotation to commit"
  echo "$P_OUT" | head -3
  exit 1
fi
case "$P_OUT" in
  *"credentials changed"*|*"lock_timeout"*|*"canceling statement"*) ;;
  *) echo "FAIL: unexpected refusal after the rotation: $P_OUT"; exit 1;;
esac
# 3. And the database must be exactly as it was, plus the rotation.
ROWS_AFTER=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from equity_snapshots where account_id = '$ACCOUNT';")
VER_AFTER=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select credential_version from accounts where id = '$ACCOUNT';")
if [ "$ROWS_AFTER" != "$ROWS_BEFORE" ]; then
  echo "FAIL: the refused publish changed the mirror ($ROWS_BEFORE -> $ROWS_AFTER)"
  exit 1
fi
if [ "$VER_AFTER" = "$VER_BEFORE" ]; then
  echo "FAIL: the rotation did not commit, so the race did not happen"
  exit 1
fi
CONSUMED=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select consumed_at is null from broker_refresh_token where token = '$TOK';")
if [ "$CONSUMED" != "t" ]; then
  echo "FAIL: the refused publish consumed its token"
  exit 1
fi
echo "    publish waited ${ELAPSED}s, was refused, and left the mirror untouched"

# ---------------------------------------------------------------------------
# 5. Deleting an account frees its broker binding, atomically.
#
# This used to race two creations over the *same Vault ids*, which was only
# possible while `create_account_atomic` took them as arguments. 0022 retired
# that path and `create_account_operation` mints its own secrets, so the
# contested resource is now the binding: an owner may hold one active account
# per (mode, broker account number), and a delete releases it. Started
# together, the delete and the re-creation must produce exactly one live
# account for the binding — never two, and never one with half its rows.
# ---------------------------------------------------------------------------
echo "==> race 4: delete-vs-recreate on one broker binding"

"${PSQL[@]}" >/dev/null <<SQL
select create_account_operation('$OWNER', gen_random_uuid(), repeat('c', 64),
  'ToDelete', 'paper', '#333333', 'DK', 'DS', 'PA-REBIND');
SQL
TO_DELETE=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select id from accounts where nickname='ToDelete' and deleted_at is null;")

worker "$WORK/del.out" <<SQL &
begin;
select delete_account_atomic('$TO_DELETE', '$OWNER', false);
select pg_sleep(1.5);
commit;
SQL
D=$!
worker "$WORK/new.out" <<SQL &
begin;
select pg_sleep(0.3);
select create_account_operation('$OWNER', gen_random_uuid(), repeat('d', 64),
  'Reuser', 'paper', '#444444', 'RK', 'RS', 'PA-REBIND');
commit;
SQL
N=$!
wait "$D" "$N" 2>/dev/null || true

# The delete holds the account for 1.5s, so the re-creation either waits for it
# and succeeds, or is refused by the binding index. Both statuses are recorded
# and both must be a definite answer, never a crash.
expect_worker "the delete" "$WORK/del.out" ok
expect_worker "the re-creation" "$WORK/new.out" any

LIVE=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from accounts
    where owner_id = '$OWNER' and mode = 'paper'
      and alpaca_account_number = 'PA-REBIND' and deleted_at is null;")
ORPHANS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from account_credential_assignment x
    where not exists (select 1 from accounts a
                       where a.id = x.account_id and a.deleted_at is null);")
DANGLING=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from account_credential_assignment x
    where not exists (select 1 from vault.secrets v where v.id = x.secret_id);")

if [ "$LIVE" -gt 1 ]; then
  echo "FAIL: $LIVE live accounts share one broker binding after the race"
  cat "$WORK/del.out" "$WORK/new.out"
  exit 1
fi
if [ "$ORPHANS" != "0" ]; then
  echo "FAIL: $ORPHANS credential assignment(s) belong to no live account"
  cat "$WORK/del.out" "$WORK/new.out"; exit 1
fi
if [ "$DANGLING" != "0" ]; then
  echo "FAIL: $DANGLING credential assignment(s) point at a missing secret"
  exit 1
fi
echo "    the binding ended up held by at most one live account"

# ---------------------------------------------------------------------------
# 5b. begin/finish verification on two connections does not deadlock.
#
# `begin` locks the account and then the tokens; `finish` and `cancel` resolve
# the token to its account and lock the account first. Taking the token first
# in one of them is what would let two connections hold each other's second
# lock. Two overlapping verifications of one account are run here in opposite
# arrival order, and both must complete inside the statement timeout — a
# deadlock would be detected and reported instead.
# ---------------------------------------------------------------------------
echo "==> race 4b: begin/finish on two connections does not deadlock"

"${PSQL[@]}" >/dev/null <<SQL
select create_account_operation('$OWNER', gen_random_uuid(), repeat('f', 64),
  'Deadlock', 'paper', '#555555', 'LK', 'LS', 'PA-DEADLOCK');
SQL
DL=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select id from accounts where nickname='Deadlock' and deleted_at is null;")

# Session A: begin, hold the transaction, then finish.
worker "$WORK/dlA.out" <<SQL &
set deadlock_timeout = '200ms';
set statement_timeout = '10s';
begin;
select begin_account_verification('$DL', '$OWNER') ->> 'token' as tok \gset
select pg_sleep(1);
select finish_account_verification(:'tok'::uuid, 'connected', 'PA-DEADLOCK') is not null;
commit;
SQL
DA=$!

# Session B: the opposite arrival order — it begins while A holds the account,
# so it queues on the account rather than on A's token.
worker "$WORK/dlB.out" <<SQL &
set deadlock_timeout = '200ms';
set statement_timeout = '10s';
begin;
select pg_sleep(0.3);
select begin_account_verification('$DL', '$OWNER') ->> 'token' as tok \gset
select cancel_account_verification(:'tok'::uuid, 'timeout');
commit;
SQL
DB=$!
wait "$DA" "$DB" 2>/dev/null || true

# Both verification sessions must *complete*. A deadlock, a lock timeout or a
# statement timeout would show up here as a non-zero status; without checking
# it, "no deadlock in the log" was satisfied by a worker that never ran.
expect_worker "verification session A" "$WORK/dlA.out" ok
expect_worker "verification session B" "$WORK/dlB.out" ok

if grep -qi "deadlock detected" "$WORK/dlA.out" "$WORK/dlB.out"; then
  echo "FAIL: begin/finish deadlocked across two connections"
  cat "$WORK/dlA.out" "$WORK/dlB.out"
  exit 1
fi
if grep -qi "statement timeout\|canceling statement" "$WORK/dlA.out" "$WORK/dlB.out"; then
  echo "FAIL: a verification session never acquired its locks"
  cat "$WORK/dlA.out" "$WORK/dlB.out"
  exit 1
fi
OUTSTANDING=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select count(*) from account_verification_token
    where account_id = '$DL'
      and consumed_at is null and superseded_at is null and cancelled_at is null;")
if [ "$OUTSTANDING" -gt 1 ]; then
  echo "FAIL: $OUTSTANDING tokens are outstanding for one account"
  exit 1
fi
echo "    both verification sessions completed with at most one token outstanding"

# ---------------------------------------------------------------------------
# 5c. A verification token that expires while `finish` waits for the lock.
#
# 0022 checked the TTL with `now()`, which is the transaction's *start* time
# and does not advance. A `finish` that queued on the account lock for longer
# than the token's life still measured its age from before the wait, so the
# token was accepted on the other side of it — a write authorized by a
# snapshot that had already been released.
#
# This is the only shape that reproduces it: the wait has to be a real lock
# wait on another connection, and the deadline has to fall during the wait.
# ---------------------------------------------------------------------------
echo "==> race 4c: a token that expires while finish waits for the lock"

"${PSQL[@]}" >/dev/null <<SQL
select create_account_operation('$OWNER', gen_random_uuid(), repeat('9', 64),
  'Deadline race', 'paper', '#666666', 'WK', 'WS', 'PA-DEADLINE-RACE');
SQL
DR=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select id from accounts where nickname='Deadline race' and deleted_at is null;")
"${PSQL[@]}" >/dev/null <<SQL
update accounts set status = 'unverified' where id = '$DR';
SQL

# Issue a token and give it a two-second life, so the deadline lands squarely
# inside the holder's window.
DR_TOKEN=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select begin_account_verification('$DR','$OWNER') ->> 'token';")
"${PSQL[@]}" >/dev/null <<SQL
update account_verification_token
   set expires_at = clock_timestamp() + interval '2 seconds'
 where token = '$DR_TOKEN';
SQL

# Session A holds the account row for three seconds. Deliberately *shorter*
# than the function's 5s `lock_timeout` and *longer* than the token's 2s life:
# session B must actually acquire the lock and then find the token dead. If
# the holder outlasted the timeout, a lock-timeout refusal would satisfy this
# test without the deadline ever being consulted — which is exactly the bug
# passing itself off as a fix.
worker "$WORK/hold.out" <<SQL &
begin;
select id from accounts where id = '$DR' for update;
select pg_sleep(3);
commit;
SQL
HOLD=$!

sleep 0.5
worker "$WORK/late.out" <<SQL
select finish_account_verification('$DR_TOKEN'::uuid, 'connected', 'PA-DEADLINE-RACE');
SQL
wait "$HOLD" 2>/dev/null || true

expect_worker "the lock holder" "$WORK/hold.out" ok
expect_worker "the late finish" "$WORK/late.out" fail

# The deadline, specifically. A lock-timeout refusal here would mean the wait
# never completed and the temporal check was never reached.
LATE_OUT=$(cat "$WORK/late.out")
case "$LATE_OUT" in
  *expired\ at*) ;;
  *lock\ timeout*|*canceling\ statement*)
    echo "FAIL: the late finish timed out on the lock instead of reaching the deadline check: $LATE_OUT"
    exit 1;;
  *) echo "FAIL: unexpected refusal for the late finish: $LATE_OUT"; exit 1;;
esac

DR_STATUS=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select status from accounts where id = '$DR';")
if [ "$DR_STATUS" != "unverified" ]; then
  echo "FAIL: a token that expired during the lock wait still wrote '$DR_STATUS'"
  echo "$LATE_OUT"
  exit 1
fi
DR_CONSUMED=$(psql "$DATABASE_URL" -tA --no-psqlrc -c \
  "select consumed_at is not null from account_verification_token where token = '$DR_TOKEN';")
if [ "$DR_CONSUMED" != "f" ]; then
  echo "FAIL: the expired token was consumed by the refused finish"
  exit 1
fi
echo "    the expired token was refused after the wait and wrote nothing"

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
