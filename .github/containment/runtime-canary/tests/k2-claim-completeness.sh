#!/usr/bin/env bash
# ============================================================================
# k2-claim-completeness.sh — a claim may fail, but it may not disappear
#
# THE DEFECT THIS CLOSES
# ----------------------
# `noBodyParse`, `noSupabaseClient` and `noBrokerCall` were decided purely from
# events the in-process instrument emitted. With the instrument missing from a
# matrix container they produced no violation and no warning: they silently
# ceased to exist, and the row printed a green dash. The verifier demonstrated
# a request that provably parsed a body and provably constructed a Supabase
# client losing exactly those two claims. `driver/verdict.mjs` never read
# `marksReadable`, `instrumentEnv` or `bootEvents`.
#
# WHAT IS TESTED HERE
# -------------------
#   RED-EQUIVALENT (case A): the same stack, the same mutant, the instrument
#       NOT loaded. Ground truth — written by the mutant itself, to a file no
#       sensor and no verdict reads — says the body was parsed and the client
#       was built. The run must be REFUSED as incomplete, not reported clean.
#
#   POSITIVE MUTANTS (cases 1..11): the forbidden action really happens, in the
#       real image, inside the driven request's window, and the corresponding
#       claim must come back `violated`. A claim whose mutant cannot trip it is
#       a claim that cannot fail. Eleven mutants cover TEN of the sixteen
#       claims (two target noPostgRESTCall); the header used to say "one per
#       claim", which it is not, and the README states the six that have no
#       positive mutant rather than rounding up.
#
#   DISCRIMINATION (case 11d): mutant 11 answers 503 WITHOUT the freeze
#       refusal's identity. `expectedResponseClass` must stay satisfied while
#       `refusalIdentity` goes violated, or the new claim is a duplicate of the
#       status check rather than a check on the reason.
#
#   CARDINALITY (cases C1..C3): a cell that drove fewer requests, a cell with
#       an endpoint the committed manifest does not list, and a claim record
#       set with one claim removed must each be refused.
#
#   BASELINE (case P): with no mutant and the instrument loaded, every one of
#       the 16 claims is `satisfied` for all 10 requests. Without this, a
#       verdict that failed everything would score full marks above.
#
#   IMAGE IDENTITY (cases F1, F0): the suite must be able to say WHICH image
#       produced the numbers, and must refuse an image that is not the frozen
#       containment bridge instead of reporting the difference as a finding.
#       F1 controls the label checker; F0 executes the property — no freeze
#       flag in the container, and the refusal must be unchanged. See the long
#       note above `image_identity_problems` for the two days this cost.
#
# Usage:  ./k2-claim-completeness.sh [--only CASE]
# Cases:  F1 F0 P A 1..11 11d C1 C2 C3   (the closed set; the summary
#         reconciles what reported against it)
# Exit:   0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
REPO="$(cd "${RC}/../../.." && pwd)"
VS="${RC}/sensor/verify-sensor.sh"
# K2 drives synthetic single cells (k2-<case>), which are deliberately not
# matrix combinations, so it is judged against the committed NON-CERTIFYING
# fixture manifest. driver/verdict.mjs refuses to print PASS for that manifest
# whatever else holds: a test seam must not be promotable into a certification.
# The endpoint set, the request count and the claim set are the real ones.
MANIFEST="${RC}/expected/k2-fixture-manifest.json"
MATRIX_MANIFEST="${RC}/expected/request-manifest.json"

IMAGE="${NT_CANARY_IMAGE:-nt-canary/dashboard:frozen}"
# The fixture image is content-keyed; see tests/lib-schema-base.sh.
# shellcheck source=lib-schema-base.sh
. "${HERE}/lib-schema-base.sh"
PG_BASE=""
NODE_IMAGE="node:22-alpine"
SCHEMA=0023

ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="${2:?}"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
want() { [[ -z "$ONLY" || "$ONLY" == "$1" ]]; }

# The fixture manifest must be a faithful restatement of the real one on every
# axis except the cell identities: same endpoints, same requests-per-cell, same
# claim set. Otherwise "K2 drives a full cell" would be a statement about the
# fixture rather than about the matrix. A variable that is only read by a
# comment is not a check, so this is the check.
if ! node -e '
const fs = require("node:fs");
const fix = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const real = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const problems = [];
const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
if (!eq(fix.endpoints, real.endpoints)) problems.push("endpoint sets differ");
if (!eq(fix.claims, real.claims)) problems.push("claim sets differ");
if (fix.requestsPerCell !== real.requestsPerCell) problems.push(`requestsPerCell ${fix.requestsPerCell} vs ${real.requestsPerCell}`);
if (fix.certifying !== false) problems.push("the fixture manifest is not certifying=false");
if (problems.length) { for (const p of problems) console.error("   " + p); process.exit(1); }
' "$MANIFEST" "$MATRIX_MANIFEST"; then
  printf 'k2: the fixture manifest does not restate the committed matrix manifest\n' >&2
  exit 2
fi

PG_BASE="$(schema_base_image "$SCHEMA")" || exit 2
schema_base_require "$SCHEMA" "$PG_BASE" || exit 2

RUN="$$"
NET="nt-canary-k2net-${RUN}"
PG_C="nt-canary-k2pg-${RUN}"
SINK_C="nt-canary-k2sink-${RUN}"
APP_C="nt-canary-k2app-${RUN}"
OUT="$(mktemp -d /tmp/nt-k2-XXXXXX)"
chmod 0777 "$OUT"

# ---------------------------------------------------------------------------
# THIS SUITE HAD NO SELF-ACCOUNTING.
#
# `rc=0` meant "nothing that ran objected", not "everything ran". Deleting a
# `mutant_case` line, or an early `harness` exit inside one, left the suite
# printing "N passed, 0 failed" over a SHORTER N with nothing anywhere saying a
# case had gone — the defect k11's own header records having had. So: the case
# tokens are a closed set, every ok/bad records the token it reported, the
# reported set is reconciled against the closed set, and an EXIT trap turns
# "died before the summary" into a harness failure rather than a short list.
# ---------------------------------------------------------------------------
CASES_INTENDED=(F1 F0 P A 1 2 3 4 5 6 7 8 9 10 11 11d C1 C2 C3)
if [[ -n "$ONLY" ]]; then
  CASES_INTENDED=("$ONLY")
fi
CASES_SEEN=()
COMPLETED=0

cleanup() {
  local rc=$?
  docker rm -f "$APP_C" "$SINK_C" "$PG_C" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [[ -n "${NT_K2_KEEP:-}" ]] && printf '   artefacts kept: %s\n' "$OUT"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk2: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( rc == 0 ? 2 : rc ))"
  fi
  return 0
}
trap cleanup EXIT

pass=0; fail=0
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }
harness() { printf 'harness: %s\n' "$*" >&2; exit 2; }

# ---------------------------------------------------------------------------
# WHICH IMAGE IS THIS, ACCORDING TO THE IMAGE?
#
# THE MEASURED FAILURE. On 2026-08-16 and again on 2026-08-17 case P was red:
# all ten baseline refusals violated `refusalIdentity`, answering 503 with
# `{"code":"MAINTENANCE_MODE", ...}`, `Retry-After: 600` and no
# `x-artifact-role` header at all. It was written up as possibly a BRIDGE
# defect — a configuration flag changing the observable identity of the
# refusal, contradicting lib/frozen.ts.
#
# It was not. The default tag `nt-canary/dashboard:frozen` resolved to an image
# built 2026-08-15 11:20, and the proxy chunk inside it still contained
#
#   process.env.DASHBOARD_MAINTENANCE_MODE ... && !(DASHBOARD_SIDECAR_ONLY &&
#   DASHBOARD_FREEZE_BYPASS_USERS) -> 503 {"code":"MAINTENANCE_MODE"}
#
# which is the CONDITIONAL PRE-FREEZE proxy that bridge commit 86654b552
# ("freeze the edge too", 2026-08-15 14:45) deleted. Built from a post-86654b55
# tree, the same scan finds zero occurrences of all three flag names while
# still finding FROZEN_CONTAINMENT_BRIDGE in six chunks. The suite had driven a
# stale fixture for two days and reported the result as a property of the
# bridge.
#
# The cause is that this suite took ANY image `NT_CANARY_IMAGE` named and asked
# it nothing. run.sh binds its image to a commit by label and to a source tree
# by content digest (audit finding B7); this suite did neither, so a tag left
# pointing at yesterday's build was indistinguishable from the artifact under
# test. A tag is a name; a name is not evidence.
#
# Two guards, because they fail for different reasons:
#   F1  the image's own recorded identity — a 40-hex revision and a source
#       digest, both stamped by build-image.sh. The stale image carried
#       `revision=canary-frozen` and no source-digest at all, so this alone
#       would have refused it in one millisecond. F1 is the CONTROL on the
#       checker: it is run against the stale image's real label pair, which it
#       must reject naming both problems, and against this image's, which it
#       must accept. A refusal that never fires is not a guard.
#   F0  the property itself, executed: with every freeze flag ABSENT from the
#       container, the refusal must still carry the frozen identity. That is
#       exactly lib/frozen.ts's claim that writes "cannot be enabled by
#       configuration", and it is the assertion the pre-freeze image fails.
# ---------------------------------------------------------------------------
image_identity_problems() {  # revision-label, source-digest-label
  local rev="$1" sd="$2"
  [[ "$rev" =~ ^[0-9a-f]{40}$ ]] \
    || printf 'org.opencontainers.image.revision=%s is not a 40-hex commit\n' "${rev:-<none>}"
  [[ -n "$sd" && "$sd" != "<no value>" ]] \
    || printf 'org.nt.canary.source-digest is absent\n'
}

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)" \
  || harness "the image under test is not present locally: $IMAGE"
IMAGE_REV="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
IMAGE_SD="$(docker image inspect --format '{{index .Config.Labels "org.nt.canary.source-digest"}}' "$IMAGE")"
# `docker image inspect` prints the literal `<no value>` for an absent label.
if [[ "$IMAGE_REV" == "<no value>" ]]; then IMAGE_REV=""; fi
if [[ "$IMAGE_SD"  == "<no value>" ]]; then IMAGE_SD=""; fi

printf '\n== K2 claim completeness (image %s) ==\n' "$IMAGE"
printf '   image id       : %s\n'   "$IMAGE_ID"
printf '   revision label : %s\n'   "${IMAGE_REV:-<none>}"
printf '   source digest  : %s\n\n' "${IMAGE_SD:-<none>}"

# --- F1. the identity checker discriminates ---------------------------------
if want F1; then
  # The rejected pair is not invented: it is the label set the stale
  # 2026-08-15 11:20 image actually carried.
  stale_problems="$(image_identity_problems "canary-frozen" "")"
  real_problems="$(image_identity_problems "$IMAGE_REV" "$IMAGE_SD")"
  # `grep -c` exits 1 on a zero count, which is a RESULT here; the rc is
  # interpreted rather than discarded, so an unreadable input (rc 2) cannot be
  # read back as "no problems".
  set +e
  n_stale="$(printf '%s\n' "$stale_problems" | grep -c '[^[:space:]]')"
  n_stale_rc=$?
  set -e
  case "$n_stale_rc" in
    0) ;;
    1) n_stale=0 ;;
    *) harness "could not count the identity-checker's output (grep rc=${n_stale_rc})" ;;
  esac
  if [[ "$n_stale" -ne 2 ]]; then
    bad "F1 the identity checker did not reject the stale image's real label pair (${n_stale} problems, expected 2)"
    printf '%s\n' "$stale_problems" | sed 's/^/       /'
  elif ! grep -q 'is not a 40-hex commit' <<< "$stale_problems" \
       || ! grep -q 'source-digest is absent' <<< "$stale_problems"; then
    bad "F1 the checker rejected the stale pair for the wrong reasons: ${stale_problems//$'\n'/; }"
  elif [[ -n "$real_problems" ]]; then
    bad "F1 the checker rejects THIS image too, so its rejection is not discriminating: ${real_problems//$'\n'/; }"
  else
    ok "F1 the image-identity checker rejects revision=canary-frozen + no source-digest (both reasons named) and accepts this image"
  fi
fi

# --- and the refusal itself -------------------------------------------------
problems="$(image_identity_problems "$IMAGE_REV" "$IMAGE_SD")"
if [[ -n "$problems" ]]; then
  printf 'k2: %s does not carry the identity of an image built by build-image.sh:\n' "$IMAGE" >&2
  printf '%s\n' "$problems" | sed 's/^/    /' >&2
  printf '  This is how a two-day-old PRE-FREEZE build was driven as "the frozen bridge"\n' >&2
  printf '  and its MAINTENANCE_MODE refusal reported as a containment finding. Rebuild:\n' >&2
  printf '    ./build-image.sh --source <scratch copy of the bridge dashboard/> \\\n' >&2
  printf '                     --tag %s --sha <the bridge commit>\n' "$IMAGE" >&2
  exit 2
fi

# --- the stack --------------------------------------------------------------
mkdir -p "$OUT/cells" "$OUT/sql" "$OUT/instr"
chmod 0777 "$OUT/cells" "$OUT/instr"

eval "$(node "${RC}/driver/keys.mjs" --print-shell | sed 's/^/export /')"
COOKIE_VALUE="$(node -e 'import("'"${RC}"'/driver/keys.mjs").then(m=>process.stdout.write(m.sessionCookieValue()))')"
[[ -n "$COOKIE_VALUE" ]] || harness "could not mint the probe session cookie"

docker network create --internal "$NET" >/dev/null
[[ "$(docker network inspect --format '{{.Internal}}' "$NET")" == "true" ]] \
  || harness "the harness network is not internal"

docker run -d --name "$PG_C" --network "$NET" --network-alias nt-canary-pg \
  -e POSTGRES_PASSWORD=runtime-canary-throwaway -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$PG_BASE" >/dev/null
streak=0; waited=0
while (( waited < 240 )); do
  if out="$(docker exec "$PG_C" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -X -tA \
            -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage','vault')" 2>/dev/null)"; then
    if [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "5" ]]; then
      streak=$(( streak + 1 )); (( streak >= 5 )) && break
    else streak=0; fi
  else streak=0; fi
  sleep 1; waited=$(( waited + 1 ))
done
(( streak >= 5 )) || harness "$PG_C never became ready"
printf '   postgres ready (%ss, 5 consecutive semantic queries)\n' "$waited"

docker cp "${RC}/sql/15_probe_identity.sql" "$PG_C:/probe.sql" >/dev/null
docker exec -i "$PG_C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f /probe.sql >/dev/null 2>&1 \
  || harness "the probe identity could not be created"

STATE="$OUT/sensor-state"
"$VS" arm --pg "$PG_C" --schema "$SCHEMA" --state "$STATE" \
      --artifact-digest "$(docker image inspect --format '{{.Id}}' "$IMAGE")" > "$OUT/sensor-arm.log" 2>&1 \
  || { sed 's/^/    /' "$OUT/sensor-arm.log" >&2; harness "the sensor did not arm"; }
printf '   sensor armed (%s)\n' "$(grep -c 'SENSOR_CHALLENGE=' "$OUT/sensor-arm.log") challenge events"

docker cp "${RC}/sql/05_sink_role.sql" "$PG_C:/sinkrole.sql" >/dev/null
docker exec -i "$PG_C" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 -f /sinkrole.sql >/dev/null \
  || harness "the gateway role could not be prepared"

SINKDEPS="$OUT/sinkdeps"; mkdir -p "$SINKDEPS"
( cd "$SINKDEPS" && npm install --silent --no-audit --no-fund --no-package-lock pg@8 >/dev/null 2>&1 )
[[ -d "$SINKDEPS/node_modules/pg" ]] || harness "could not install the gateway's pg client"

: > "$OUT/sink-${SCHEMA}.jsonl"; chmod 0666 "$OUT/sink-${SCHEMA}.jsonl"
docker run -d --name "$SINK_C" --network "$NET" --network-alias nt-canary-sink \
  -v "${RC}/sink:/canary:ro" -v "${SINKDEPS}/node_modules:/node_modules:ro" \
  -v "$OUT/sink-${SCHEMA}.jsonl:/out/sink.jsonl" \
  -e SINK_PGHOST=nt-canary-pg \
  -e SINK_PGPASSWORD='nt-runtime-canary-not-a-credential' \
  -e SINK_JWT_SECRET="nt-runtime-canary-not-a-secret-signing-key" \
  -e SINK_PROBE_USER_ID="$CANARY_PROBE_USER_ID" \
  "$NODE_IMAGE" node /canary/sink.mjs >/dev/null
waited=0; health=""
while (( waited < 60 )); do
  health="$(docker exec "$SINK_C" node -e '
    fetch("http://127.0.0.1:8000/__canary/health",{signal:AbortSignal.timeout(3000)})
      .then(r=>r.json()).then(j=>process.stdout.write(String(j.ok)))
      .catch(()=>process.stdout.write("down"));' 2>/dev/null || true)"
  [[ "$health" == "true" ]] && break
  sleep 1; waited=$(( waited + 1 ))
done
[[ "$health" == "true" ]] || harness "the recording gateway never reached the database"
printf '   recording gateway up\n\n'

# --- the plan: one full cell from the committed manifest --------------------
node --input-type=module -e '
import fs from "node:fs";
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const account = process.argv[2];
const requests = [];
let i = 0;
for (const e of m.endpoints) {
  const [method, tmpl, auth] = [e.split(" ")[0], e.split(" ")[1], e.endsWith("auth=true")];
  requests.push({
    id: String(++i), method, url: tmpl.replace(":id", account), template: tmpl,
    file: "(manifest)", authenticated: auth,
  });
}
fs.writeFileSync(process.argv[3], JSON.stringify({
  id: "k2-cell", env: {}, requests,
}, null, 2));
' "$MANIFEST" "$CANARY_PROBE_ACCOUNT_ID" "$OUT/cells/plan-k2.json"

# --- run one case -----------------------------------------------------------
# $1 label, $2 mutant name ("" for none), $3 with-instrument (1|0),
# $4 freeze-flag mode: "on" (default) sets DASHBOARD_MAINTENANCE_MODE=on and
#    DASHBOARD_SIDECAR_ONLY=on; "absent" sets NO freeze variable at all, which
#    is the configuration F0 needs — the frozen bridge's refusal must not
#    depend on any of them.
run_case() {
  local label="$1" mutant="$2" instr="$3" freeze="${4:-on}"
  local cell="k2-${label}"
  docker rm -f "$APP_C" >/dev/null 2>&1 || true
  : > "$OUT/instr/${cell}.jsonl";  chmod 0666 "$OUT/instr/${cell}.jsonl"
  : > "$OUT/instr/${cell}.mutant"; chmod 0666 "$OUT/instr/${cell}.mutant"

  local preloads=()
  [[ "$instr" == "1" ]] && preloads+=("--require /canary/instrument.cjs")
  [[ -n "$mutant" ]]    && preloads+=("--require /mut/positive-mutants.cjs")

  local freeze_env=()
  case "$freeze" in
    on)     freeze_env=(-e DASHBOARD_MAINTENANCE_MODE=on -e DASHBOARD_SIDECAR_ONLY=on) ;;
    absent) freeze_env=() ;;
    *) harness "run_case: unknown freeze mode '${freeze}'" ;;
  esac

  docker run -d --name "$APP_C" --network "$NET" --network-alias nt-canary-app \
    -v "${RC}/instrument:/canary:ro" \
    -v "${RC}/mutant:/mut:ro" \
    -v "$OUT/instr/${cell}.jsonl:/instr/events.jsonl" \
    -v "$OUT/instr/${cell}.mutant:/instr/mutant.jsonl" \
    -e NODE_OPTIONS="${preloads[*]}" \
    -e NT_CANARY_INSTR_OUT=/instr \
    -e NT_CANARY_MUTANT_OUT=/instr/mutant.jsonl \
    -e NT_CANARY_POSITIVE_MUTANT="$mutant" \
    -e NT_CANARY_SINK_HOST=nt-canary-sink \
    -e NT_CANARY_PG_HOST=nt-canary-pg \
    -e SUPABASE_SERVER_URL="http://nt-canary-sink:8000" \
    -e NEXT_PUBLIC_SUPABASE_URL="http://nt-canary-sink:8000" \
    -e NEXT_PUBLIC_SUPABASE_ANON_KEY="$CANARY_ANON_KEY" \
    -e SUPABASE_SERVICE_ROLE_KEY="$CANARY_SERVICE_ROLE_KEY" \
    -e NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME="$CANARY_COOKIE_NAME" \
    "${freeze_env[@]}" \
    "$IMAGE" >/dev/null

  local w=0 s=0 st probe
  while (( w < 90 )); do
    st="$(docker inspect --format '{{.State.Running}}' "$APP_C" 2>/dev/null || echo missing)"
    if [[ "$st" != "true" ]]; then
      printf 'harness: the image exited before becoming ready (state=%s)\n' "$st" >&2
      docker logs --tail 20 "$APP_C" >&2 || true
      return 1
    fi
    probe="$(docker exec "$SINK_C" node -e '
      fetch("http://nt-canary-app:3000/api/health",{signal:AbortSignal.timeout(3000)})
        .then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write("down"));' 2>/dev/null || true)"
    if [[ "$probe" == "200" ]]; then s=$(( s + 1 )); (( s >= 3 )) && break; else s=0; fi
    sleep 1; w=$(( w + 1 ))
  done
  (( s >= 3 )) || { printf 'harness: the image never became ready\n' >&2; docker logs --tail 20 "$APP_C" >&2 || true; return 1; }

  docker run --rm --network "$NET" \
    -v "${RC}/driver:/canary:ro" -v "$OUT/cells:/out" \
    -e NT_CELL="$cell" -e NT_PLAN="/out/plan-k2.json" \
    -e NT_OUT="/out/result-${SCHEMA}-${cell}.json" \
    -e NT_COOKIE_NAME="$CANARY_COOKIE_NAME" -e NT_COOKIE_VALUE="$COOKIE_VALUE" \
    "$NODE_IMAGE" node /canary/drive.mjs >/dev/null
  docker rm -f "$APP_C" >/dev/null 2>&1 || true

  # the readings the host-side observers contribute
  docker cp "${RC}/sql/40_canary_dump.sql" "$PG_C:/dump.sql" >/dev/null
  docker exec -i "$PG_C" psql -U postgres -d postgres -X -q -tA -v ON_ERROR_STOP=1 -f /dump.sql \
    2>/dev/null | grep -E '^NT_CANARY_' > "$OUT/canary-${SCHEMA}.txt" || true
  docker logs "$PG_C" > "$OUT/pglog-all.txt" 2>&1
  set +e
  grep -E 'LOG: +NT_CANARY_HIT fn=' "$OUT/pglog-all.txt" > "$OUT/pglog-hits-${SCHEMA}.txt"
  set -e
  printf 'NT_CANARY_HITS=%s\n' "$(docker exec "$PG_C" psql -U postgres -d postgres -X -tA -c \
    "select string_agg(fn || ':' || hits::text, ',' order by fn) from nt_canary.hits()" | tr -d '[:space:]')" \
    > "$OUT/sql/commit-before-${SCHEMA}.txt"
  return 0
}

# Runs the REAL verdict over exactly the one cell just produced.
verdict_for() {  # cell-label -> writes $OUT/verdict.txt, sets VRC
  local cell="k2-$1"
  find "$OUT/cells" -name "result-${SCHEMA}-*.json" ! -name "result-${SCHEMA}-${cell}.json" -delete
  set +e
  node "${RC}/driver/verdict.mjs" --out "$OUT" --mode frozen --break-sensor none \
    --schemas "$SCHEMA" --manifest "$MANIFEST" \
    --cells-run 1 --cells-total 1 --expect-status 503 \
    --sensor-verdict "${SCHEMA}=TRUSTWORTHY" > "$OUT/verdict.txt" 2>&1
  VRC=$?
  set -e
}

# The driver container writes its result as root. The host user owns the
# directory, so the file can be unlinked and recreated but not opened for
# writing in place — an in-place writeFileSync fails EACCES and aborts the
# suite before the cardinality cases run.
rewrite_cell() {  # file, javascript operating on `j`
  local f="$1" js="$2"
  node -e "
    const fs=require('node:fs');
    const p=process.argv[1];
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    ${js}
    fs.rmSync(p,{force:true});
    fs.writeFileSync(p, JSON.stringify(j,null,2));
  " "$f"
}

restore_cell() {  # backup, file
  rm -f "$2"; cp "$1" "$2"
}

claim_status() {  # claim -> prints the statuses seen for it, one per line
  grep -o "$1=[a-z]*" "$OUT/verdict.txt" | sed "s/^$1=//" | sort -u | tr '\n' ',' || true
}

# THE STATUSES, AS DATA — not as the absence of a string in a transcript.
#
# The verdict transcript prints only the claims that FAILED. `claim_status`
# above can therefore see "violated" but can NEVER see "satisfied", so the
# discrimination control for case 11 — which must show `expectedResponseClass`
# STILL satisfied while `refusalIdentity` goes violated — was asserting on a
# string the output never contains. That is the coloured-banner defect again: an
# assertion that cannot fail is not a test. verdict.mjs now emits a per-claim
# tally into verdict-scope.json and this reads it.
claim_count() {  # claim, status -> prints the count, or "-" when unreadable
  node -e '
    const fs=require("node:fs");
    try {
      const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const t=(j.claimStatus||{})[process.argv[2]];
      process.stdout.write(t && Object.prototype.hasOwnProperty.call(t,process.argv[3])
        ? String(t[process.argv[3]]) : "-");
    } catch { process.stdout.write("-"); }
  ' "$OUT/verdict-scope.json" "$1" "$2"
}

# --- F0. THE FREEZE IS UNCONDITIONAL, EXECUTED ------------------------------
#
# Every other case here runs the image with DASHBOARD_MAINTENANCE_MODE=on, so
# every other case is compatible with an image whose refusal is a maintenance
# flag rather than the artifact's own freeze — which is exactly the image this
# suite silently drove for two days. F0 removes every freeze variable from the
# container and requires the refusal to be unchanged: 10 of 10 requests must
# carry the frozen identity, 0 must violate it.
#
# The negative control is mutant 11, which answers 503 from the HTTP server
# before any freeze logic and therefore CANNOT carry the identity. Both halves
# run in the same no-flag configuration, so "F0 passed" cannot mean "the
# reader sees satisfied for everything".
if want F0; then
  run_case noflags "" 1 absent || harness "F0 could not run the image with no freeze flags"
  verdict_for noflags
  f0_sat="$(claim_count refusalIdentity satisfied)"
  f0_vio="$(claim_count refusalIdentity violated)"
  run_case noflags-control respond_503_unrelated 1 absent \
    || harness "F0's negative control could not run"
  verdict_for noflags-control
  f0c_sat="$(claim_count refusalIdentity satisfied)"
  f0c_vio="$(claim_count refusalIdentity violated)"
  if [[ "$f0_sat" == "-" || "$f0c_vio" == "-" ]]; then
    bad "F0 verdict-scope.json carried no refusalIdentity tally (satisfied=${f0_sat} controlViolated=${f0c_vio})"
  elif (( f0c_vio < 10 || f0c_sat > 0 )); then
    bad "F0 negative control failed: an unrelated 503 with NO freeze flags still satisfied refusalIdentity ${f0c_sat}/10 (violated ${f0c_vio}); F0 cannot discriminate"
  elif (( f0_sat == 10 && f0_vio == 0 )); then
    ok "F0 with DASHBOARD_MAINTENANCE_MODE/SIDECAR_ONLY/FREEZE_BYPASS_USERS all ABSENT, 10/10 refusals still carry the frozen identity (control: an unrelated 503 violates it 10/10)"
  else
    bad "F0 the freeze is CONFIGURATION-DEPENDENT: with no freeze flag set, refusalIdentity was satisfied ${f0_sat}/10 and violated ${f0_vio}/10"
    printf '       this is either a pre-freeze image (check the revision label above) or a\n'
    printf '       real regression of bridge commit 86654b552; the two are told apart by\n'
    printf '       whether the proxy chunk still names DASHBOARD_MAINTENANCE_MODE.\n'
    sed -n '1,40p' "$OUT/verdict.txt" | sed 's/^/       /'
  fi
fi

# --- P. BASELINE ------------------------------------------------------------
if want P; then
  run_case baseline "" 1 || harness "the baseline case could not run"
  verdict_for baseline
  n_indet="$(sed -n 's/.*requests with an INDETERMINATE *: *\([0-9]*\).*/\1/p' "$OUT/verdict.txt" | head -1)"
  n_viol="$(sed -n 's/.*requests with a violated claim *: *\([0-9]*\).*/\1/p' "$OUT/verdict.txt" | head -1)"
  n_req="$(sed -n 's/.*requests driven *: *\([0-9]*\).*/\1/p' "$OUT/verdict.txt" | head -1)"
  n_records="$(sed -n 's/.*claim records evaluated *: *\([0-9]*\).*/\1/p' "$OUT/verdict.txt" | head -1)"
  if [[ "$n_req" == "10" && "$n_records" == "160" && "$n_viol" == "0" && "$n_indet" == "0" && "$VRC" == "4" ]]; then
    ok "P baseline: 10 requests x 16 claims = 160 records, 0 violated, 0 indeterminate (rc=$VRC PARTIAL)"
  else
    bad "P baseline: req=$n_req records=$n_records violated=$n_viol indeterminate=$n_indet rc=$VRC"
    sed -n '1,60p' "$OUT/verdict.txt" | sed 's/^/       /'
  fi
fi

# --- A. THE DEMONSTRATED DEFECT: the instrument is simply not there ---------
if want A; then
  run_case noinstr parse_body 0 || harness "case A could not run"
  # ground truth, from the mutant's own file — nothing the verdict reads
  gt="$(grep -c '"action":"body.parsed"' "$OUT/instr/k2-noinstr.mutant" || true)"
  verdict_for noinstr
  if [[ "$gt" -lt 1 ]]; then
    bad "A ground truth is missing: the mutant did not report parsing a body ($gt records)"
  elif [[ "$VRC" == "3" ]] && grep -q 'INCOMPLETE OBSERVATION' "$OUT/verdict.txt" \
       && grep -q 'noBodyParse' "$OUT/verdict.txt"; then
    ok "A instrument absent + body provably parsed ($gt times) -> INCOMPLETE OBSERVATION, rc=$VRC (not a clean row)"
  else
    bad "A the run was not refused as incomplete (rc=$VRC)"
    sed -n '1,40p' "$OUT/verdict.txt" | sed 's/^/       /'
  fi
fi

# --- 1..10 POSITIVE MUTANTS -------------------------------------------------
mutant_case() {  # case-id, mutant, claim, ground-truth-action
  local id="$1" mut="$2" claim="$3" action="$4"
  want "$id" || return 0
  run_case "$mut" "$mut" 1 || { bad "$id $mut: the case could not run"; return 0; }
  local gt
  gt="$(grep -c "\"action\":\"${action}\"" "$OUT/instr/k2-${mut}.mutant" || true)"
  verdict_for "$mut"
  local seen; seen="$(claim_status "$claim")"
  if [[ "$gt" -lt 1 ]]; then
    bad "$id $mut: ground truth missing — the mutant never reported '${action}'"
    sed -n '1,10p' "$OUT/instr/k2-${mut}.mutant" | sed 's/^/       /'
  elif [[ ",${seen}" == *",violated,"* ]]; then
    ok "$id $mut did '${action}' ${gt}x -> ${claim}=violated"
  else
    bad "$id $mut did '${action}' ${gt}x but ${claim} was never violated (statuses: ${seen:-none})"
    sed -n '1,40p' "$OUT/verdict.txt" | sed 's/^/       /'
  fi
}

mutant_case 1  parse_body              noBodyParse            body.parsed
mutant_case 2  create_supabase_client  noSupabaseClient       supabase.client.constructed
mutant_case 3  auth_get_user           noAuthCall             auth.getUser
mutant_case 4  postgrest_traffic       noPostgRESTCall        postgrest.select
mutant_case 5  execute_rpc             noPostgRESTCall        rpc.executed
mutant_case 6  database_socket         noDatabaseCall         db.socket
mutant_case 7  vault_wrapper           noVaultCall            vault.wrapper.invoked
mutant_case 8  broker_client           noBrokerCall           broker.called
mutant_case 9  respond_401             expectedResponseClass  responded.401
# THE POSITIVE CONTROL FOR THE TALLY READER, taken from case 9's own verdict:
# mutant 9 answers 401, so `expectedResponseClass` must be readable as VIOLATED
# here. Without this, 11d's "expectedResponseClass was not violated" could be
# satisfied by a reader that can never see a violation at all.
POS_ERC_VIOLATED="-"
if want 9; then POS_ERC_VIOLATED="$(claim_count expectedResponseClass violated)"; fi

mutant_case 10 reach_handler           handlerNotReached      handler.reached
mutant_case 11 respond_503_unrelated   refusalIdentity        responded.503.unrelated

# ...and the discrimination control for case 11. A new claim that fires whenever
# the old one fires has added nothing. The mutant answers with a 503, so
# `expectedResponseClass` must STILL be satisfied while `refusalIdentity` is
# violated — that is the whole difference between "it refused" and "it refused
# for the reason containment depends on".
if want 11d; then
  erc_sat="$(claim_count expectedResponseClass satisfied)"
  erc_vio="$(claim_count expectedResponseClass violated)"
  rid_vio="$(claim_count refusalIdentity violated)"
  if [[ "$POS_ERC_VIOLATED" == "-" ]]; then
    bad "11d the tally reader has no positive control (case 9 was not run); '--only 11d' cannot decide this"
  elif (( POS_ERC_VIOLATED < 1 )); then
    bad "11d positive control failed: the tally reader could not see expectedResponseClass=violated even for mutant 9 (got ${POS_ERC_VIOLATED})"
  elif [[ "$erc_sat" == "-" || "$erc_vio" == "-" || "$rid_vio" == "-" ]]; then
    bad "11d verdict-scope.json carried no claim tally (satisfied=${erc_sat} violated=${erc_vio} identity=${rid_vio})"
  elif (( erc_sat == 10 && erc_vio == 0 && rid_vio == 10 )); then
    ok "11d respond_503_unrelated: expectedResponseClass satisfied 10/10 while refusalIdentity violated 10/10 (reader proven live by mutant 9: ${POS_ERC_VIOLATED} violations seen)"
  else
    bad "11d the two response claims did not discriminate (expectedResponseClass satisfied=${erc_sat} violated=${erc_vio}; refusalIdentity violated=${rid_vio})"
  fi
fi

# --- C1..C3 CARDINALITY -----------------------------------------------------
if want C1; then
  run_case card "" 1 >/dev/null 2>&1 || true
  f="$OUT/cells/result-${SCHEMA}-k2-card.json"
  [[ -f "$f" ]] || harness "case C1 has no cell result to mutate"
  cp "$f" "$OUT/card-backup.json"
  rewrite_cell "$f" 'j.results.pop();' 
  verdict_for card
  if [[ "$VRC" == "3" ]] && grep -q 'requests, the manifest requires 10' "$OUT/verdict.txt"; then
    ok "C1 a cell that drove 9 of 10 manifest requests is refused (rc=$VRC)"
  else
    bad "C1 a short cell was not refused (rc=$VRC)"
    sed -n '1,20p' "$OUT/verdict.txt" | sed 's/^/       /'
  fi
  restore_cell "$OUT/card-backup.json" "$f"
fi

if want C2; then
  f="$OUT/cells/result-${SCHEMA}-k2-card.json"
  [[ -f "$f" ]] || { run_case card "" 1 >/dev/null 2>&1 || true; }
  cp "$f" "$OUT/card-backup.json"
  rewrite_cell "$f" 'j.results[0].template="/api/not-in-the-manifest";' 
  verdict_for card
  if [[ "$VRC" == "3" ]] && grep -q 'endpoint set differs from the manifest' "$OUT/verdict.txt"; then
    ok "C2 a cell that drove an endpoint the manifest does not list is refused (rc=$VRC)"
  else
    bad "C2 an off-manifest endpoint was not refused (rc=$VRC)"
    sed -n '1,20p' "$OUT/verdict.txt" | sed 's/^/       /'
  fi
  restore_cell "$OUT/card-backup.json" "$f"
fi

if want C3; then
  # Removing an individual sensor must make COMPLETENESS fail, not make the
  # claim disappear. `coverage` feeds noSupabaseClient and noBrokerCall.
  f="$OUT/cells/result-${SCHEMA}-k2-card.json"
  [[ -f "$f" ]] || { run_case card "" 1 >/dev/null 2>&1 || true; }
  cp "$f" "$OUT/card-backup.json"
  rewrite_cell "$f" 'for (const r of j.results) r.sensors.coverage = { live:false, reason:"removed by the C3 control" };' 
  verdict_for card
  if [[ "$VRC" == "3" ]] && grep -q 'INDETERMINATE' "$OUT/verdict.txt" \
     && grep -q 'noSupabaseClient' "$OUT/verdict.txt" && grep -q 'noBrokerCall' "$OUT/verdict.txt"; then
    ok "C3 removing the coverage sensor makes COMPLETENESS fail (rc=$VRC), it does not remove its claims"
  else
    bad "C3 a removed sensor did not break completeness (rc=$VRC)"
    sed -n '1,20p' "$OUT/verdict.txt" | sed 's/^/       /'
  fi
  restore_cell "$OUT/card-backup.json" "$f"
fi

# --- the closed-set check on this suite's own coverage -----------------------
# A case that stops reporting must show up as a failure, not as a smaller total.
missing_cases=()
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && { found=1; break; }; done
  [[ "$found" -eq 1 ]] || missing_cases+=("$c")
done
unknown_cases=()
for s in "${CASES_SEEN[@]}"; do
  known=0
  for c in "${CASES_INTENDED[@]}"; do [[ "$c" == "$s" ]] && { known=1; break; }; done
  [[ "$known" -eq 1 ]] || unknown_cases+=("$s")
done
if [[ "${#missing_cases[@]}" -ne 0 ]]; then
  printf '  \033[1;31mFAIL\033[0m COVERAGE these intended cases never reported: %s\n' "${missing_cases[*]}"
  fail=$(( fail + 1 ))
fi
if [[ "${#unknown_cases[@]}" -ne 0 ]]; then
  printf '  \033[1;31mFAIL\033[0m COVERAGE these cases reported but are not in CASES_INTENDED: %s\n' "${unknown_cases[*]}"
  fail=$(( fail + 1 ))
fi
DISTINCT_SEEN="$(printf '%s\n' "${CASES_SEEN[@]}" | LC_ALL=C sort -u | wc -l)"
COMPLETED=1
printf '\n  %s passed, %s failed   (%s of %s intended cases reported; artefacts: %s)\n\n' \
  "$pass" "$fail" "$DISTINCT_SEEN" "${#CASES_INTENDED[@]}" "$OUT"
[[ "$fail" -eq 0 ]]
