#!/usr/bin/env bash
# =============================================================================
# run_postgrest.sh — exercise the ACL and the history snapshot through a REAL
# PostgREST, not a hand-written fake.
#
# Two things can only be proven here:
#
#   1. **What a browser can actually reach.** The `/rpc/` surface, the row cap,
#      the role switching and the JWT handling are PostgREST's behaviour, not
#      the database's. A migration can revoke perfectly and still leave a
#      function callable if the grant model is misunderstood.
#
#   2. **That `db-max-rows` does not silently truncate the answer.** The gate
#      runs with `PGRST_DB_MAX_ROWS=100` — far below any real dataset — so a
#      reader that assumes a 1000-row cap, or infers "short page means done",
#      fails loudly instead of returning a plausible wrong number.
#
# Requires docker. Usage:
#   supabase/tests/run_postgrest.sh
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
TESTS="$REPO_ROOT/supabase/tests"
WORK="$(mktemp -d)"

PG_NAME="nt-pgrst-db-$$"
API_NAME="nt-pgrst-api-$$"
NET_NAME="nt-pgrst-net-$$"
PG_PORT="${PG_PORT:-55491}"
API_PORT="${API_PORT:-55492}"
DB_MAX_ROWS="${DB_MAX_ROWS:-100}"

cleanup() {
  docker rm -f "$API_NAME" "$PG_NAME" >/dev/null 2>&1 || true
  docker network rm "$NET_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> postgres 16 + postgrest (db-max-rows=$DB_MAX_ROWS)"
docker network create "$NET_NAME" >/dev/null
docker run -d --name "$PG_NAME" --network "$NET_NAME" \
  -e POSTGRES_PASSWORD=postgres -p "$PG_PORT:5432" postgres:16-alpine >/dev/null

for _ in $(seq 1 60); do
  docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

DATABASE_URL="postgres://postgres:postgres@localhost:$PG_PORT/postgres"
PSQL=(psql "$DATABASE_URL" --quiet --no-psqlrc -v ON_ERROR_STOP=1)

echo "==> platform scaffolding"
"${PSQL[@]}" -f "$TESTS/bootstrap_local.sql" >/dev/null

echo "==> applying migrations"
for file in "$MIGRATIONS"/*.sql; do
  sed -e 's/^create extension if not exists supabase_vault cascade;/-- [test harness] supabase_vault provided by bootstrap_local.sql/' \
      "$file" > "$WORK/$(basename "$file")"
  "${PSQL[@]}" -f "$WORK/$(basename "$file")" >/dev/null
done

# PostgREST authenticates as a dedicated role and switches to the role in the
# JWT — exactly the Supabase arrangement.
echo "==> authenticator role + JWT secret"
JWT_SECRET="${JWT_SECRET:-nate-trader-postgrest-integration-secret-0123456789}"
"${PSQL[@]}" <<SQL >/dev/null
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'authenticator';
  end if;
end \$\$;
grant anon, authenticated, service_role to authenticator;
SQL

echo "==> seeding fixtures"
"${PSQL[@]}" -v ON_ERROR_STOP=1 -f "$TESTS/postgrest_fixture.sql" >/dev/null

docker run -d --name "$API_NAME" --network "$NET_NAME" -p "$API_PORT:3000" \
  -e PGRST_DB_URI="postgres://authenticator:authenticator@$PG_NAME:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_DB_MAX_ROWS="$DB_MAX_ROWS" \
  -e PGRST_LOG_LEVEL=error \
  postgrest/postgrest:v12.2.3 >/dev/null

echo "==> waiting for the API"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$API_PORT/" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://localhost:$API_PORT/" >/dev/null 2>&1 || {
  echo "postgrest did not become ready"; docker logs "$API_NAME" | tail -20; exit 1;
}

echo "==> assertions"
API_URL="http://localhost:$API_PORT" \
DATABASE_URL="$DATABASE_URL" \
JWT_SECRET="$JWT_SECRET" \
DB_MAX_ROWS="$DB_MAX_ROWS" \
  python3 "$TESTS/postgrest_assertions.py"

echo "ALL POSTGREST INTEGRATION TESTS PASSED"
