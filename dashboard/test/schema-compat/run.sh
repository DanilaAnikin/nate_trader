#!/usr/bin/env bash
# ============================================================================
# run.sh — prove the pre-migration bridge deploys against BOTH database shapes
#
# The bridge image has to serve a database that may still be at migration 0008
# (nothing after it applied) or already at 0023. Reading the migrations and
# grepping the ported code says the bridge names no post-0008 object. That is
# a statement about names someone searched for. This script replaces it with an
# executed proof:
#
#   1. two real PostgreSQL servers on the exact production image;
#   2. one gets migrations 0001-0008 only, the other 0001-0023, each applied
#      with ON_ERROR_STOP=1 so a failure is a failure;
#   3. representative fixture data is seeded into both, and the seed asserts
#      it actually seeded;
#   4. every route under dashboard/app/api is enumerated from disk, its
#      transitive import closure walked, and every `.from()` / `.rpc()` in that
#      closure resolved to an object name; and
#   5. each of those names is looked up in the live catalogue (pg_class /
#      pg_proc) of BOTH databases.
#
# Nothing here talks to a broker, to Alpaca, or to any production system. The
# only credentials that exist are literal strings saying they are not
# credentials.
#
# Usage:
#   ./run.sh                 # full run, containers removed afterwards
#   ./run.sh --keep          # leave both containers up for inspection
#   ./run.sh --include-pages # widen the surface past app/api to the server
#                            # components, server actions and the edge proxy
#   ./run.sh --self-test     # additionally inject a route that names an object
#                            # that exists in neither schema, and require the
#                            # run to fail with the blocker verdict
#
# Exit codes:
#   0  every named object exists in both schemas
#   1  a deploy blocker: some object is absent (or unprivileged) somewhere
#   2  the harness itself failed (docker, image, migration, seed, extractor)
#   3  a negative control misbehaved — the check cannot be trusted this run
# ============================================================================

set -Eeuo pipefail

readonly IMAGE="supabase/postgres:17.6.1.136"
readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly DASHBOARD="$(cd "${HERE}/../.." && pwd)"
readonly REPO="$(cd "${DASHBOARD}/.." && pwd)"
# Overridable so the harness's own guards can be exercised against a doctored
# copy of the migration directory without ever touching supabase/migrations.
readonly MIGRATIONS="${NT_SCHEMA_COMPAT_MIGRATIONS:-${REPO}/supabase/migrations}"
readonly SQL="${HERE}/sql"

readonly REF_NAME="nt-schema-compat-0008"
readonly LATEST_NAME="nt-schema-compat-latest"

WORK="$(mktemp -d)"
KEEP=0
SELF_TEST=0
INCLUDE_PAGES=0
EXIT_HARNESS=2
EXIT_CONTROL=3

for arg in "$@"; do
  case "$arg" in
    --keep)          KEEP=1 ;;
    --self-test)     SELF_TEST=1 ;;
    --include-pages) INCLUDE_PAGES=1 ;;
    -h|--help)   sed -n '2,47p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "run.sh: unknown argument: $arg" >&2; exit "$EXIT_HARNESS" ;;
  esac
done

# ---------------------------------------------------------------------------
# plumbing
# ---------------------------------------------------------------------------

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\n\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; }

cleanup() {
  local rc=$?
  if [[ "$KEEP" -eq 1 ]]; then
    printf '\n--keep: containers left running: %s %s\n' "$REF_NAME" "$LATEST_NAME"
    printf '        work dir: %s\n' "$WORK"
  else
    docker rm -f "$REF_NAME" "$LATEST_NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  exit "$rc"
}
trap cleanup EXIT

# `docker rm -f` on a container that does not exist is not a correctness
# error, so its failure is genuinely ignorable — unlike anything below.
docker rm -f "$REF_NAME" "$LATEST_NAME" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 0. preflight
# ---------------------------------------------------------------------------

log "0. preflight"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not on PATH"; exit "$EXIT_HARNESS"
fi
if ! command -v node >/dev/null 2>&1; then
  fail "node is not on PATH"; exit "$EXIT_HARNESS"
fi

# The exact production image, resolved locally. Not :latest, not a tag that
# could drift: the point of the exercise is the image production runs.
if ! image_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)"; then
  fail "image $IMAGE is not present locally; pull it deliberately before running"
  exit "$EXIT_HARNESS"
fi
info "image      : $IMAGE"
info "image id   : $image_id"
info "repo       : $REPO"
info "migrations : $MIGRATIONS"
info "work dir   : $WORK"

for d in "$MIGRATIONS" "$SQL" "$DASHBOARD/app/api"; do
  if [[ ! -d "$d" ]]; then fail "missing directory: $d"; exit "$EXIT_HARNESS"; fi
done

# ---------------------------------------------------------------------------
# 1. the migration set, enumerated from disk
# ---------------------------------------------------------------------------

log "1. migrations discovered on disk"

mapfile -t ALL_MIGRATIONS < <(find "$MIGRATIONS" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort)
if [[ "${#ALL_MIGRATIONS[@]}" -eq 0 ]]; then
  fail "no migrations found in $MIGRATIONS"; exit "$EXIT_HARNESS"
fi

REF_SET=()
LATEST_SET=()
for m in "${ALL_MIGRATIONS[@]}"; do
  LATEST_SET+=("$m")
  if [[ "${m:0:4}" < "0009" ]]; then REF_SET+=("$m"); fi
done

# The 0001-0008 reference must really be 0001..0008 with no gap. A missing
# file would otherwise quietly shrink the reference schema and make the
# comparison meaningless.
expected=()
for n in 0001 0002 0003 0004 0005 0006 0007 0008; do expected+=("$n"); done
got=()
for m in "${REF_SET[@]}"; do got+=("${m:0:4}"); done
if [[ "${expected[*]}" != "${got[*]}" ]]; then
  fail "the 0001-0008 range is not contiguous: found [${got[*]}], expected [${expected[*]}]"
  exit "$EXIT_HARNESS"
fi

info "all migrations   : ${#ALL_MIGRATIONS[@]} (${ALL_MIGRATIONS[0]} .. ${ALL_MIGRATIONS[-1]})"
info "reference set    : ${#REF_SET[@]} (${REF_SET[0]} .. ${REF_SET[-1]})"
info "latest set       : ${#LATEST_SET[@]} (${LATEST_SET[0]} .. ${LATEST_SET[-1]})"

# ---------------------------------------------------------------------------
# 2. start both servers
# ---------------------------------------------------------------------------

start_db() {
  local name="$1"
  docker run -d --name "$name" \
    -e POSTGRES_PASSWORD=schema-compat-throwaway \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$IMAGE" >/dev/null
}

# Semantic readiness, not pg_isready.
#
# During init the entrypoint runs a temporary server that listens on the unix
# socket only, so a socket probe can succeed against a database that is about
# to be shut down and re-initialised. This probe therefore (a) goes over TCP,
# which the temporary server does not serve, (b) connects as supabase_admin,
# and (c) asks a question about the schema layout rather than `select 1`. Five
# consecutive correct answers are required; a single failure resets the count.
readonly READY_STREAK=5
readonly READY_TIMEOUT_S=180

db_probe() {
  local name="$1" out
  if ! out="$(docker exec "$name" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres \
        -X -tA -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage')" 2>/dev/null)"; then
    return 1
  fi
  [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "4" ]]
}

wait_ready() {
  local name="$1" streak=0 waited=0
  while (( waited < READY_TIMEOUT_S )); do
    if db_probe "$name"; then
      streak=$(( streak + 1 ))
      if (( streak >= READY_STREAK )); then
        info "$name: ready (${streak} consecutive semantic queries, ${waited}s)"
        return 0
      fi
    else
      streak=0
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  fail "$name never reached ${READY_STREAK} consecutive successful queries in ${READY_TIMEOUT_S}s"
  docker logs --tail 40 "$name" >&2 || true
  return 1
}

log "2. starting two ${IMAGE} servers"
start_db "$REF_NAME"
start_db "$LATEST_NAME"
wait_ready "$REF_NAME"   || exit "$EXIT_HARNESS"
wait_ready "$LATEST_NAME" || exit "$EXIT_HARNESS"

for c in "$REF_NAME" "$LATEST_NAME"; do
  running_image="$(docker inspect --format '{{.Image}}' "$c")"
  if [[ "$running_image" != "$image_id" ]]; then
    fail "$c is running image $running_image, not $image_id"; exit "$EXIT_HARNESS"
  fi
done
info "both containers confirmed running image id $image_id"

# ---------------------------------------------------------------------------
# 3. environment bootstrap + migrations
# ---------------------------------------------------------------------------

psql_file() {  # container, path-inside-container
  docker exec -i "$1" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f "$2"
}

log "3. environment bootstrap (the storage tables storage-api owns, not a migration)"
for c in "$REF_NAME" "$LATEST_NAME"; do
  docker cp "$SQL/00_env_bootstrap.sql" "$c:/00_env_bootstrap.sql" >/dev/null
  # As supabase_admin: the storage schema is owned by supabase_admin and the
  # tables by supabase_storage_admin, exactly as in a real project.
  if ! docker exec -i "$c" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 -f /00_env_bootstrap.sql; then
    fail "$c: environment bootstrap failed"; exit "$EXIT_HARNESS"
  fi
  # The bootstrap must not create anything in `public`; otherwise it could
  # mask exactly the kind of missing object this harness exists to find.
  n_public="$(docker exec "$c" psql -U postgres -d postgres -X -tA -c \
    "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f')")"
  if [[ "$(printf '%s' "$n_public" | tr -d '[:space:]')" != "0" ]]; then
    fail "$c: bootstrap left $n_public relations in public; it must touch only storage"
    exit "$EXIT_HARNESS"
  fi
  info "$c: bootstrap applied, public schema still empty ($n_public relations)"
done

# --- negative control: does ON_ERROR_STOP actually stop, with the right error?
log "3b. control — a broken statement must abort the applier with its own error"
control_err="$WORK/on-error-stop.err"
set +e
printf 'select 1;\nselect 1/0;\nselect 2;\n' \
  | docker exec -i "$REF_NAME" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - \
    >/dev/null 2>"$control_err"
control_rc=$?
set -e
if [[ "$control_rc" -eq 0 ]]; then
  fail "control: a division-by-zero migration exited 0 — ON_ERROR_STOP is not in effect"
  exit "$EXIT_CONTROL"
fi
if ! grep -F -q 'division by zero' "$control_err"; then
  fail "control: applier failed with rc=$control_rc but not with the expected error class"
  cat "$control_err" >&2
  exit "$EXIT_CONTROL"
fi
info "control ok: rc=$control_rc, stderr names the exact failure: $(tr -d '\n' < "$control_err" | sed 's/  */ /g')"

apply_migrations() {  # container, then migration filenames
  local c="$1"; shift
  local failures=0
  docker cp "$MIGRATIONS" "$c:/mig" >/dev/null
  for m in "$@"; do
    local err="$WORK/${c}.${m}.err"
    set +e
    psql_file "$c" "/mig/$m" >"$WORK/${c}.${m}.out" 2>"$err"
    local rc=$?
    set -e
    if [[ "$rc" -ne 0 ]]; then
      failures=$(( failures + 1 ))
      fail "$c: migration $m failed (rc=$rc)"
      sed 's/^/       /' "$err" >&2
    else
      # NOTICEs are normal (idempotent drops); surface them compactly.
      local notices
      notices="$(grep -c 'NOTICE' "$err" || true)"
      info "$c: $m applied (${notices} notices)"
    fi
  done
  return "$failures"
}

log "4. applying migrations 0001-0008 to the clean reference database"
if ! apply_migrations "$REF_NAME" "${REF_SET[@]}"; then
  fail "the 0001-0008 reference could not be built"; exit "$EXIT_HARNESS"
fi

log "5. applying migrations 0001-0023 to the latest-schema database"
if ! apply_migrations "$LATEST_NAME" "${LATEST_SET[@]}"; then
  fail "the 0001-0023 schema could not be built"; exit "$EXIT_HARNESS"
fi

# The two databases must genuinely differ, or "compatible with both" is vacuous.
count_public() {
  docker exec "$1" psql -U postgres -d postgres -X -tA -c \
    "select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f'))
         || '/' ||
            (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')"
}
ref_counts="$(count_public "$REF_NAME")"
latest_counts="$(count_public "$LATEST_NAME")"
info "public relations/functions — 0008: $ref_counts   0023: $latest_counts"
if [[ "$ref_counts" == "$latest_counts" ]]; then
  fail "the two schemas have identical object counts ($ref_counts); the migrations 0009-0023 did not take effect"
  exit "$EXIT_CONTROL"
fi

# ---------------------------------------------------------------------------
# 6. seed
# ---------------------------------------------------------------------------

log "6. seeding representative fixture data into both databases"
for c in "$REF_NAME" "$LATEST_NAME"; do
  docker cp "$SQL/10_seed.sql" "$c:/10_seed.sql" >/dev/null
  set +e
  docker exec -i "$c" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f /10_seed.sql \
    >"$WORK/${c}.seed.out" 2>"$WORK/${c}.seed.err"
  seed_rc=$?
  set -e
  if [[ "$seed_rc" -ne 0 ]]; then
    fail "$c: seed failed (rc=$seed_rc)"; sed 's/^/       /' "$WORK/${c}.seed.err" >&2
    exit "$EXIT_HARNESS"
  fi
  sed 's/^/   /' "$WORK/${c}.seed.err"
done

log "6b. seeded rows, read back from each database"
for c in "$REF_NAME" "$LATEST_NAME"; do
  printf '\n   --- %s ---\n' "$c"
  docker exec "$c" psql -U postgres -d postgres -X -c "
    select 'auth.users'       as tbl, count(*) from auth.users
    union all select 'profiles',         count(*) from public.profiles
    union all select 'accounts',         count(*) from public.accounts
    union all select 'equity_snapshots', count(*) from public.equity_snapshots
    union all select 'cash_flows',       count(*) from public.cash_flows
    union all select 'audit_log',        count(*) from public.audit_log
    order by 1;" | sed 's/^/   /'
  docker exec "$c" psql -U postgres -d postgres -X -c "
    select a.id, a.owner_id, a.nickname, a.mode, a.status, u.email
    from public.accounts a join auth.users u on u.id = a.owner_id;" | sed 's/^/   /'
done

# ---------------------------------------------------------------------------
# 7. enumerate the route surface
# ---------------------------------------------------------------------------

log "7. enumerating every route under dashboard/app/api and its object surface"

EXTRA_ROUTE_ARGS=()

if [[ "$INCLUDE_PAGES" -eq 1 ]]; then
  # The routes are the required surface. Server components, server actions and
  # the edge proxy reach the database too, and at least one of them
  # (lib/account-context.ts) reads `profiles` as `authenticated` rather than
  # with the service role — a different grant, on a table two later migrations
  # rewrite the ACL of. Off by default so the required proof stays exactly the
  # route surface the task names.
  while IFS= read -r page; do
    EXTRA_ROUTE_ARGS+=(--extra-route "$page")
  done < <(find "$DASHBOARD/app" \( -name 'page.tsx' -o -name 'layout.tsx' -o -name 'actions.ts' \) -not -name '*.test.*' | sort)
  if [[ -f "$DASHBOARD/proxy.ts" ]]; then
    EXTRA_ROUTE_ARGS+=(--extra-route "$DASHBOARD/proxy.ts")
  fi
  info "--include-pages: $(( ${#EXTRA_ROUTE_ARGS[@]} / 2 )) non-API entrypoints added to the surface"
fi

if [[ "$SELF_TEST" -eq 1 ]]; then
  cat > "$WORK/selftest-route.ts" <<'TS'
import { getSupabaseService } from "@/lib/supabase/service";
export async function GET() {
  const svc = getSupabaseService();
  await svc.from("nt_selftest_table_that_cannot_exist").select("*");
  await svc.rpc("nt_selftest_function_that_cannot_exist", {});
  return new Response("ok");
}
TS
  EXTRA_ROUTE_ARGS+=(--extra-route "$WORK/selftest-route.ts")
  info "self-test: injecting a route that names two objects absent from every schema"
fi

if ! node "$HERE/extract-route-objects.mjs" \
      --dashboard "$DASHBOARD" \
      --out-json "$WORK/route-objects.json" \
      --out-sql  "$WORK/wanted.sql" \
      "${EXTRA_ROUTE_ARGS[@]+"${EXTRA_ROUTE_ARGS[@]}"}" > "$WORK/route-objects.stdout"; then
  fail "the route-surface extractor refused to produce a report"
  exit "$EXIT_HARNESS"
fi

node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`   route files found: ${r.routeFileCount}`);
console.log(`   test files under app/api (not routes): ${r.testFilesUnderApi.length}`);
for (const rt of r.routes) {
  console.log(`\n   ${rt.route}   [${rt.file}]  closure: ${rt.closureSize} local files`);
  if (rt.calls.length === 0) { console.log("      (touches no database object)"); continue; }
  for (const c of rt.calls) {
    console.log(`      ${c.kind.padEnd(8)} ${c.object.padEnd(26)} role=${String(c.role).padEnd(34)} ${c.file}:${c.line}`);
  }
}
console.log("\n   distinct objects the whole surface needs:");
for (const o of r.objects) {
  const roles = o.requiredRoles.length ? o.requiredRoles.join("+") : "(role unattributed)";
  console.log(`      ${o.kind.padEnd(8)} ${o.object.padEnd(26)} as ${roles.padEnd(28)} used by ${o.routes.join(" ")}`);
}
' "$WORK/route-objects.json"

# ---------------------------------------------------------------------------
# 8. control the catalogue check before trusting it
# ---------------------------------------------------------------------------

run_sql_with_wanted() {  # container, wanted-fragment, sql-file
  local c="$1" fragment="$2" body="$3"
  cat "$fragment" "$body" | docker exec -i "$c" \
    psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 -f -
}

run_check() {  # container, wanted-fragment
  run_sql_with_wanted "$1" "$2" "$SQL/20_check.sql"
}

parse_verdict() {  # file, key -> value  (empty value is legal, missing is not)
  local file="$1" key="$2" line
  line="$(grep -m1 -F "${key}=" "$file" || true)"
  if [[ -z "$line" ]]; then
    fail "verdict line ${key}= not found in the check output"
    return 1
  fi
  printf '%s' "${line#*=}"
}

log "8. negative control — the catalogue check must discriminate"
for c in "$REF_NAME" "$LATEST_NAME"; do
  out="$WORK/${c}.controls.txt"
  if ! run_check "$c" "$SQL/05_controls.sql" > "$out" 2>&1; then
    fail "$c: the control check did not run"; cat "$out" >&2; exit "$EXIT_CONTROL"
  fi
  sed 's/^/   /' "$out"
  n_absent="$(parse_verdict "$out" SCHEMA_COMPAT_ABSENT)" || exit "$EXIT_CONTROL"
  names="$(parse_verdict "$out" SCHEMA_COMPAT_ABSENT_NAMES)" || exit "$EXIT_CONTROL"
  expect_names='function:__nt_absent_probe_function,relation:__nt_absent_probe_relation'
  if [[ "$n_absent" != "2" ]]; then
    fail "$c: control expected exactly 2 absent objects, got '$n_absent'"; exit "$EXIT_CONTROL"
  fi
  if [[ "$names" != "$expect_names" ]]; then
    fail "$c: control expected absent names '$expect_names', got '$names'"; exit "$EXIT_CONTROL"
  fi
  info "$c: control ok — the two impossible objects are reported ABSENT and the two real ones PRESENT"
done

# ---------------------------------------------------------------------------
# 9. the actual proof
# ---------------------------------------------------------------------------

blockers=0
absent_findings=""
unprivileged_findings=""
denied_findings=""

check_schema() {  # container, label
  local c="$1" label="$2" out n_wanted n_absent names unpriv
  out="$WORK/${c}.check.txt"
  log "9. ${label} — catalogue lookup for every object the routes name"
  if ! run_check "$c" "$WORK/wanted.sql" > "$out" 2>&1; then
    fail "$c: the schema check did not run"; cat "$out" >&2; exit "$EXIT_HARNESS"
  fi
  sed 's/^/   /' "$out"

  n_wanted="$(parse_verdict "$out" SCHEMA_COMPAT_WANTED)" || exit "$EXIT_HARNESS"
  n_absent="$(parse_verdict "$out" SCHEMA_COMPAT_ABSENT)" || exit "$EXIT_HARNESS"
  names="$(parse_verdict "$out" SCHEMA_COMPAT_ABSENT_NAMES)" || exit "$EXIT_HARNESS"
  unpriv="$(parse_verdict "$out" SCHEMA_COMPAT_UNPRIVILEGED)" || exit "$EXIT_HARNESS"

  if [[ "$n_wanted" -lt 1 ]]; then
    fail "$label: the check ran against zero objects; that is not a pass"
    exit "$EXIT_CONTROL"
  fi
  if [[ "$n_absent" != "0" ]]; then
    fail "$label: DEPLOY BLOCKER — ${n_absent} object(s) absent: ${names}"
    absent_findings+="${label}: ${names}"$'\n'
    blockers=$(( blockers + 1 ))
  else
    info "$label: all ${n_wanted} named objects exist in the live catalogue"
  fi
  if [[ -n "$unpriv" ]]; then
    fail "$label: DEPLOY BLOCKER — present but service_role cannot use: ${unpriv}"
    unprivileged_findings+="${label}: ${unpriv}"$'\n'
    blockers=$(( blockers + 1 ))
  else
    info "$label: service_role holds a usable privilege on every one of them"
  fi
}

probe_schema() {  # container, label
  local c="$1" label="$2" out denied unprobed probed
  out="$WORK/${c}.probe.txt"
  log "9b. ${label} — calling each named function as service_role"
  if ! run_sql_with_wanted "$c" "$WORK/wanted.sql" "$SQL/30_runtime_probe.sql" > "$out" 2>&1; then
    fail "$c: the runtime probe did not run"; cat "$out" >&2; exit "$EXIT_HARNESS"
  fi
  sed 's/^/   /' "$out"

  unprobed="$(parse_verdict "$out" SCHEMA_COMPAT_UNPROBED)" || exit "$EXIT_HARNESS"
  denied="$(parse_verdict "$out" SCHEMA_COMPAT_RUNTIME_DENIED)" || exit "$EXIT_HARNESS"
  probed="$(parse_verdict "$out" SCHEMA_COMPAT_PROBED)" || exit "$EXIT_HARNESS"

  if [[ -n "$unprobed" ]]; then
    fail "$label: the route surface names function(s) with no runtime probe: ${unprobed}"
    fail "        add them to sql/30_runtime_probe.sql; an unprobed function is not a pass"
    exit "$EXIT_CONTROL"
  fi
  if [[ "$probed" -lt 1 ]]; then
    fail "$label: zero functions were probed; that is not a pass"; exit "$EXIT_CONTROL"
  fi
  if [[ -n "$denied" ]]; then
    fail "$label: DEPLOY BLOCKER — service_role is refused at call time: ${denied}"
    denied_findings+="${label}: ${denied}"$'\n'
    blockers=$(( blockers + 1 ))
  else
    info "$label: all ${probed} probed functions were reachable by service_role"
  fi
}

check_schema "$REF_NAME"    "0001-0008 reference schema"
probe_schema "$REF_NAME"    "0001-0008 reference schema"
check_schema "$LATEST_NAME" "0001-0023 latest schema"
probe_schema "$LATEST_NAME" "0001-0023 latest schema"

# ---------------------------------------------------------------------------
# 10. verdict
# ---------------------------------------------------------------------------

log "10. verdict"

if [[ "$SELF_TEST" -eq 1 ]]; then
  # Not "some failure happened": the two injected names have to appear in the
  # absent list of BOTH schemas, or the injection proved nothing.
  ok=1
  while IFS= read -r want; do
    [[ -z "$want" ]] && continue
    for label in "0001-0008 reference schema" "0001-0023 latest schema"; do
      case "$absent_findings" in
        *"${label}: "*"${want}"*) ;;
        *) fail "self-test: '${want}' was NOT reported absent for the ${label}"; ok=0 ;;
      esac
    done
  done <<'WANTED'
relation:nt_selftest_table_that_cannot_exist
function:nt_selftest_function_that_cannot_exist
WANTED
  if [[ "$ok" -ne 1 ]]; then
    fail "self-test: the injected impossible objects did not surface as blockers"
    printf '   absent findings seen:\n%s\n' "$absent_findings"
    exit "$EXIT_CONTROL"
  fi
  info "self-test ok: both injected impossible objects were reported ABSENT in both schemas"
  info "self-test deliberately ends in a non-zero exit"
  exit 1
fi

if [[ "$blockers" -ne 0 ]]; then
  printf '\n'
  if [[ -n "$absent_findings" ]]; then
    printf '   objects the routes name that do NOT exist:\n'
    printf '%s' "$absent_findings" | sed 's/^/     /'
  fi
  if [[ -n "$unprivileged_findings" ]]; then
    printf '   objects that exist but service_role holds no usable privilege on:\n'
    printf '%s' "$unprivileged_findings" | sed 's/^/     /'
  fi
  if [[ -n "$denied_findings" ]]; then
    printf '   functions that refused a real call from service_role:\n'
    printf '%s' "$denied_findings" | sed 's/^/     /'
  fi
  fail "the bridge is NOT deployable against every checked schema (${blockers} blocking findings)"
  exit 1
fi

printf '\n\033[1;32mPASS\033[0m  every database object the API surface names exists, with usable\n'
printf '      privileges, in both the 0001-0008 reference schema and the\n'
printf '      0001-0023 latest schema on %s.\n' "$IMAGE"
exit 0
