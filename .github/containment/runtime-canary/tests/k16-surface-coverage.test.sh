#!/usr/bin/env bash
# ============================================================================
# K16 — the data plane is a TOTAL classification of the path, and every class
#       is read by a named claim
#
# WHY THIS SUITE EXISTS
# ---------------------
# Round 8 broke the harness twice in the same place.
#
# R8-1  THE CLASS WAS READ OFF THE ROW. claims.mjs filtered the recording
#       gateway's log with `e.kind === "postgrest"` and friends, while
#       observers.mjs derived the same class from the path one screen away and
#       PUBLISHED the derivation. Rewriting ONE line of sink-0023.jsonl in
#       place — same 555 non-empty lines — to record
#       GET /rest/v1/accounts?select=* -> 200 under the claimed request tag
#       m-off__s-off__b-probe#3 gave rc=1 FINDING with noPostgRESTCall and
#       noDatabaseCall violated WITH "kind":"postgrest" present, and rc=0, PASS
#       banner, hardFailures 0, noPostgRESTCall 480 satisfied / 0 violated with
#       the `kind` field DELETED. gatewayHarnessRows went 555->554 and
#       gatewayRowsInAClaimedRequest 0->1 in both cases: the verdict computed
#       the truth and consulted the lie.
#
# R8-2  THE WHOLE NOTION OF "THE DATA PLANE" WAS TWO PATH PREFIXES. sink.mjs,
#       instrument.cjs and observers.mjs all answered "other" for /storage/v1,
#       /graphql/v1, /realtime/v1 and /functions/v1; no claim read "other" on
#       either observer; and noUnexpectedNetworkCall permits anything addressed
#       to the gateway host. A storage read, a GraphQL query, a realtime socket
#       and a /functions/v1/place-order invocation each produced 16 of 16 claim
#       records ALL SATISFIED, with the self-consistent "kind":"other" both
#       observers would honestly write for them. Those are exactly the surfaces
#       the Stage 2 edge exists to deny.
#
# R8-3  THE CANARY'S RAW ARTEFACT WAS COMPARED WITH NOTHING. run.sh runs
#       `grep -E 'NT_CANARY_' sql/canary-dump-<gen>.out > canary-<gen>.txt` and
#       the verdict reads only the grep. An NT_CANARY_ROW naming
#       vault_create_secret gave rc=1 noVaultCall=violated in canary-0023.txt
#       and rc=0 PASS when present ONLY in sql/canary-dump-0023.out.
#
# WHAT EVERY CASE HERE IS SHAPED LIKE
# -----------------------------------
# Most cases are rejection assertions, so the suite opens with a POSITIVE
# CONTROL (GREEN) that the unmodified set still certifies and a MEASURED case
# that reads the new counters AS NUMBERS — "0 rows on /storage/v1" is also what
# a classifier that cannot see /storage/v1 produces, which is the defect this
# suite is about. Every planting helper asserts that it changed the file it
# meant to change and that the non-empty line count is unchanged, so a case
# cannot pass by planting nothing. Each case names the EXACT claim or reason it
# is aiming at, never "some non-zero exit". H6 and B7e are the negative
# controls: the readiness poll the driver's own protocol makes must still
# certify, and an untouched provenance record must read back satisfied, so the
# rules are not "any /__canary row refuses" and "any provenance edit refuses".
# TABLE is the positive control on the coverage assertion itself, which is
# otherwise a check whose passing value is silence.
#
# R9-1  THE ONE CLASS NO CLAIM READS WAS ALSO REACHABLE BY THE IMAGE. The
#       gateway serves /__canary/{cell,health,generation,observe} to anything
#       on its network, unauthenticated, and run.sh puts the image there. A
#       real GET /__canary/health row, produced by a container that was not the
#       driver, spliced into a claimed request window: rc=0, PASS, hardFailures
#       0. Cases H1-H6 and HCOUNT.
#
# R9-2  THE IMAGE/SOURCE/COMMIT BINDING WAS ASSERTED AND NEVER RE-DERIVED.
#       Rewriting provenance.json so the image was built from a tree that is
#       not the commit certified rc=0. Cases B7a-B7e.
#
# The directory is copied before it is mutated; the input is never modified.
#
# Usage:
#   k16-surface-coverage.test.sh --full-out DIR [--probe-user-id ID]
#
# Exit: 0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANARY_ROOT="$(cd "${HERE}/.." && pwd)"
VERDICT="${CANARY_ROOT}/driver/verdict.mjs"
MANIFEST="${CANARY_ROOT}/expected/request-manifest.json"

FULL_OUT=""
PROBE_USER_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full-out)      FULL_OUT="${2:?}";      shift 2 ;;
    --probe-user-id) PROBE_USER_ID="${2:?}"; shift 2 ;;
    *) printf 'k16: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$FULL_OUT" ]] || { printf 'k16: --full-out is required\n' >&2; exit 2; }
[[ -d "$FULL_OUT/cells" ]] || { printf 'k16: %s has no cells/ directory\n' "$FULL_OUT" >&2; exit 2; }
for s in 0008 0023; do
  n="$(find "$FULL_OUT/cells" -name "result-${s}-*.json" | wc -l)"
  [[ "$n" == "24" ]] || {
    printf 'k16: --full-out has %s cell files for generation %s, not 24.\n' "$n" "$s" >&2
    exit 2
  }
done

# Same forward-port refusal k14/k15 make: a directory from before the round-5
# detail binding refuses on all 480 requests, and every case here would then be
# red for a reason about the fixture's age.
WANT_OBS_V="$(node -e '
  import("'"${CANARY_ROOT}"'/driver/observation.mjs")
    .then((m) => process.stdout.write(String(m.OBSERVATION_VERSION)));
')"
[[ -n "$WANT_OBS_V" ]] || { printf 'k16: could not read OBSERVATION_VERSION\n' >&2; exit 2; }
for s in 0008 0023; do
  got="$(K16_JSONL="${HERE}/k14-jsonl.cjs" node -e '
const J = require(process.env.K16_JSONL);
for (const e of J.read(process.argv[1]).rows) {
  if (e.observation && e.observation.v !== undefined) { process.stdout.write(String(e.observation.v)); break; }
}
' "$FULL_OUT/sink-${s}.jsonl")"
  [[ "$got" == "$WANT_OBS_V" ]] || {
    printf 'k16: %s carries request attestation version %s; this checkout derives %s.\n' \
      "$FULL_OUT/sink-${s}.jsonl" "${got:-none}" "$WANT_OBS_V" >&2
    printf 'k16: drive a new matrix; this directory cannot be forward-ported.\n' >&2
    exit 2
  }
done

for st in "$FULL_OUT"/sensor-state-*; do
  [[ -d "$st" ]] || continue
  if [[ ! -f "${st}/report.hmac" ]]; then
    printf '\033[1;33mnote\033[0m %s predates the ADV-3 seal; sealing with its own run key\n' "$FULL_OUT"
    node "${HERE}/seal-legacy-report.mjs" "$FULL_OUT" \
      || { printf 'k16: %s cannot be forward-ported\n' "$FULL_OUT" >&2; exit 2; }
    break
  fi
done

if [[ -z "$PROBE_USER_ID" ]]; then
  PROBE_USER_ID="$(node "${CANARY_ROOT}/driver/keys.mjs" --print-shell \
    | sed -n 's/^CANARY_PROBE_USER_ID=//p')"
fi
[[ -n "$PROBE_USER_ID" ]] || { printf 'k16: could not determine the probe user id\n' >&2; exit 2; }

WORK="$(mktemp -d /tmp/nt-k16-XXXXXX)"

CASES_INTENDED=(GREEN MEASURED
                S-postgrest S-auth S-rpc-vault S-storage S-realtime
                S-functions S-graphql S-pg S-kong S-unclassified
                H1 H2 H3 H4 H4b H5 H6 HCOUNT
                B7a B7b B7c B7d B7e
                R8-1a R8-1b M1
                R8-3a R8-3b R8-3c R8-3d
                P1 P2 SCOPE TABLE TRIPLE)
CASES_SEEN=()
COMPLETED=0
cleanup() {
  local rc=$?
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk16 harness: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'k16 harness: an unfinished suite is not a passing one.\n' >&2
    [[ "$rc" -eq 0 ]] && exit 2
  fi
  exit "$rc"
}
trap cleanup EXIT

pass=0; fail=0
seen() { CASES_SEEN+=("${1%% *}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }
harness() { printf 'k16 harness: %s\n' "$*" >&2; exit 2; }

# Never `producer | grep -q`: grep exits at its first match, the producer dies
# of SIGPIPE, and under pipefail the pipeline's status is the producer's.
strip_to_file() { sed -e 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
has_pass_banner() { grep -qE '^PASS all [0-9]+ environment combinations' "$1"; }

# POSITIVE CONTROL for the banner detector, before anything depends on it.
printf '\033[1;32mPASS\033[0m all 24 environment combinations x 2 migration generations\n' > "$WORK/.banner-raw"
strip_to_file "$WORK/.banner-raw" "$WORK/.banner-probe"
has_pass_banner "$WORK/.banner-probe" \
  || harness "the PASS-banner detector cannot find a planted banner; every banner assertion would be vacuous"
printf 'PARTIAL 24 of 48 environment/schema combinations were driven\n' > "$WORK/.banner-raw"
strip_to_file "$WORK/.banner-raw" "$WORK/.banner-probe"
! has_pass_banner "$WORK/.banner-probe" \
  || harness "the PASS-banner detector matches a PARTIAL line"
rm -f "$WORK/.banner-probe" "$WORK/.banner-raw"

sensor_hits() {
  local f="$1/sensor-report-$2.txt" mid post
  if [[ -f "$f" ]]; then
    mid="$(sed -n 's/^SENSOR_PHASE=mid|events=\([0-9]*\)$/\1/p'  "$f" | head -1)"
    post="$(sed -n 's/^SENSOR_PHASE=post|events=\([0-9]*\)$/\1/p' "$f" | head -1)"
    if [[ -n "$mid" && -n "$post" ]]; then printf '%s' $(( mid + post )); return 0; fi
  fi
  printf '0'
}

LOG=""; FLAT=""; RC=0
verdict() {
  local out="$1"; shift
  LOG="$WORK/verdict-$$-${RANDOM}.log"
  FLAT="${LOG}.flat"
  set +e
  node "$VERDICT" --out "$out" --mode frozen --break-sensor none \
    --schemas 0008,0023 --manifest "$MANIFEST" \
    --cells-run 24 --cells-total 24 \
    --probe-user-id "$PROBE_USER_ID" \
    --sensor-verdict "0008=TRUSTWORTHY" --sensor-verdict "0023=TRUSTWORTHY" \
    --sensor-hits "0008=$(sensor_hits "$out" 0008)" \
    --sensor-hits "0023=$(sensor_hits "$out" 0023)" \
    "$@" > "$LOG" 2>&1
  RC=$?
  set -e
  strip_to_file "$LOG" "$FLAT"
}

# An absent field reads back as the literal (missing) rather than killing the
# suite at its second case — the state before the repair is exactly when these
# fields do not exist.
scope() {
  node -e '
    const fs = require("node:fs");
    let j;
    try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
    catch (e) { process.stdout.write("(no-scope-file)"); process.exit(0); }
    let v;
    try { v = (new Function("s", `return (${process.argv[2]});`))(j); }
    catch (e) { process.stdout.write("(missing)"); process.exit(0); }
    process.stdout.write(v === undefined ? "(missing)" : String(v));
  ' "$1/verdict-scope.json" "$2"
}

says() { grep -qF -- "$1" "$FLAT"; }

copy_of() {
  local d="$WORK/$1"
  rm -rf "$d"
  cp -a "$FULL_OUT" "$d"
  rm -f "$d/verdict-scope.json"
  printf '%s' "$d"
}

# ---------------------------------------------------------------------------
# THE PLANTER. One gateway row, rewritten IN PLACE, under a CLAIMED request tag.
#
# It asserts what it did: the file must still hold the same number of non-empty
# lines, the row must now carry the path asked for, and the `kind` must be
# exactly what the mode says. A planter that silently did nothing would make
# every case below a statement about an untouched corpus.
# ---------------------------------------------------------------------------
plant_row() {  # dir schema cell#tag path mode(honest|nokind|other)
  K16_ROOT="$CANARY_ROOT" node -e '
const fs = require("node:fs");
const [dir, S, TAG, P, MODE] = process.argv.slice(1);
const f = `${dir}/sink-${S}.jsonl`;
const before = fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== "").length;
import(`${process.env.K16_ROOT}/driver/claims.mjs`).then((m) => {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const i = lines.findIndex((l) => { try { return l && JSON.parse(l).cell === TAG; } catch { return false; } });
  if (i < 0) { console.error(`k16 planter: no gateway row carries ${TAG}`); process.exit(2); }
  const r = JSON.parse(lines[i]);
  r.method = "GET"; r.query = "?select=*"; r.status = 200; r.path = P;
  if (MODE === "honest") r.kind = m.classifyGatewayPath(P);
  else if (MODE === "nokind") delete r.kind;
  else if (MODE === "other") r.kind = "other";
  else { console.error(`k16 planter: bad mode ${MODE}`); process.exit(2); }
  lines[i] = JSON.stringify(r);
  fs.writeFileSync(f, lines.join("\n"));
  const after = fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== "").length;
  const back = JSON.parse(fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== "")[i]);
  const wantKind = MODE === "honest" ? m.classifyGatewayPath(P) : (MODE === "other" ? "other" : undefined);
  if (before !== after) { console.error(`k16 planter: line count moved ${before} -> ${after}`); process.exit(2); }
  if (back.path !== P) { console.error("k16 planter: the row does not carry the planted path"); process.exit(2); }
  if (back.kind !== wantKind) { console.error(`k16 planter: kind is ${JSON.stringify(back.kind)}, wanted ${JSON.stringify(wantKind)}`); process.exit(2); }
  process.stderr.write(`k16 planter: ${S} ${TAG} -> ${P} kind=${JSON.stringify(back.kind)} (${after} non-empty lines, unchanged)\n`);
}).catch((e) => { console.error(`k16 planter: ${e.message}`); process.exit(2); });
' "$@"
}

TAG="m-off__s-off__b-probe#3"
ROW='NT_CANARY_ROW=1|2026-08-17 23:25:01+00|vault_create_secret|m-off__s-off__b-probe#3|authenticated|postgres|172.18.0.5|{"name":"alpaca_key"}'

printf '\n== K16 every Supabase surface is classified, and every class is read ==\n\n'

# ---------------------------------------------------------------------------
# GREEN — the positive control.
# ---------------------------------------------------------------------------
BASE="$(copy_of base)"
verdict "$BASE"
if [[ "$RC" -eq 0 ]] && has_pass_banner "$FLAT" && [[ "$(scope "$BASE" 's.status')" == "PASS" ]]; then
  ok "GREEN the unmodified 48-cell set still certifies with the surface classification total (rc=0)"
else
  bad "GREEN the unmodified set no longer certifies (rc=${RC}, status=$(scope "$BASE" 's.status')) — every rejection case below is then meaningless"
  grep -m5 -E '^\s+(hard|control|schema)' "$FLAT" | sed 's/^/       /' || true
fi

# ---------------------------------------------------------------------------
# MEASURED — the counters, as numbers.
# ---------------------------------------------------------------------------
{
  problems=""
  for s in 0008 0023; do
    tot="$(scope "$BASE" "s.claimEvidence['$s'].gatewayRows")"
    harn="$(scope "$BASE" "s.claimEvidence['$s'].gatewayRowsByClass.harness")"
    [[ "$harn" == "$tot" ]] || problems="${problems} ${s}:harness=${harn}(want ${tot}=gatewayRows)"
    for c in auth rpc postgrest graphql pg storage realtime functions kong unclassified; do
      n="$(scope "$BASE" "s.claimEvidence['$s'].gatewayRowsByClass.${c} || 0")"
      [[ "$n" == "0" ]] || problems="${problems} ${s}:${c}=${n}(want 0)"
    done
    nk="$(scope "$BASE" "s.claimEvidence['$s'].gatewayRowsWithoutADeclaredKind")"
    [[ "$nk" == "0" ]] || problems="${problems} ${s}:rowsWithoutAKind=${nk}(want 0)"
    pc="$(scope "$BASE" "s.claimEvidence['$s'].imageEgressPathClassContradictions")"
    [[ "$pc" == "0" ]] || problems="${problems} ${s}:pathClassContradictions=${pc}(want 0)"
    ag="$(scope "$BASE" "s.controlEvidence.perSchema['$s'].canaryExtraction.agrees")"
    [[ "$ag" == "true" ]] || problems="${problems} ${s}:canaryExtraction.agrees=${ag}(want true)"
    ml="$(scope "$BASE" "s.controlEvidence.perSchema['$s'].canaryExtraction.rawMarkerLines")"
    [[ "$ml" =~ ^[0-9]+$ && "$ml" -gt 0 ]] \
      || problems="${problems} ${s}:canaryExtraction.rawMarkerLines=${ml}(want >0; agreement between two empty sets is not agreement)"
  done
  if [[ -z "$problems" ]]; then
    ok "MEASURED the per-surface counts are published for both generations and read as numbers:"
    printf '       0023 %s, canary dump %s NT_CANARY_ line(s) re-extracted and in agreement\n' \
      "$(scope "$BASE" "JSON.stringify(s.claimEvidence['0023'].gatewayRowsByClass)")" \
      "$(scope "$BASE" "s.controlEvidence.perSchema['0023'].canaryExtraction.rawMarkerLines")"
  else
    bad "MEASURED the published counters are not what a frozen run must produce:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# S-* — one Supabase surface each, recorded HONESTLY, under a claimed request
#       tag. This is the shape a real image produces: both observers write the
#       row and the row agrees with itself. Every one must be a FINDING, and
#       the claim that goes violated must be the one the class maps to.
# ---------------------------------------------------------------------------
surface_case() {  # label path expected-violated-claim...
  local label="$1" p="$2"; shift 2
  local d claim v problems=""
  d="$(copy_of "s-${label}")"
  plant_row "$d" 0023 "$TAG" "$p" honest 2>/dev/null || harness "${label}: the planter failed"
  verdict "$d"
  [[ "$RC" -eq 1 ]] || problems="${problems} rc=${RC}(want 1 FINDING)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner-present"
  for claim in "$@"; do
    v="$(scope "$d" "s.claimStatus['${claim}'].violated")"
    [[ "$v" =~ ^[0-9]+$ && "$v" -gt 0 ]] || problems="${problems} ${claim}.violated=${v}(want >0)"
  done
  # …and the claims that must NOT move, so the case discriminates rather than
  # asserting that something somewhere went red.
  for claim in noBodyParse handlerNotReached noSupabaseClient; do
    v="$(scope "$d" "s.claimStatus['${claim}'].violated")"
    [[ "$v" == "0" ]] || problems="${problems} ${claim}.violated=${v}(want 0)"
  done
  if [[ -z "$problems" ]]; then
    ok "${label} a gateway row on ${p} under a claimed request tag is a FINDING ($(printf '%s ' "$@"))"
  else
    bad "${label} ${p}:${problems}"
  fi
  rm -rf "$d"
}

surface_case S-postgrest   "/rest/v1/accounts"                            noPostgRESTCall noDatabaseCall
surface_case S-auth        "/auth/v1/user"                                noAuthCall
surface_case S-rpc-vault   "/rest/v1/rpc/vault_create_secret"             noPostgRESTCall noDatabaseCall noVaultCall
surface_case S-storage     "/storage/v1/object/private/broker-keys.json"  noUnexpectedNetworkCall
surface_case S-realtime    "/realtime/v1/websocket"                       noUnexpectedNetworkCall
surface_case S-functions   "/functions/v1/place-order"                    noUnexpectedNetworkCall
surface_case S-graphql     "/graphql/v1"                                  noDatabaseCall
surface_case S-pg          "/pg/tables"                                   noDatabaseCall
surface_case S-kong        "/"                                            noUnexpectedNetworkCall
surface_case S-unclassified "/some/surface/nobody/enumerated"             noUnexpectedNetworkCall

# ===========================================================================
# ROUND 9 (R9-1). THE CLASS NO CLAIM READS IS A CONTROL PLANE THE IMAGE CAN
# ALSO REACH, SO ITS ROWS MUST ACCOUNT FOR THEMSELVES.
#
# This block used to be case N1, and it asserted the OPPOSITE of what it
# asserts now: "a /__canary row under the same tag still certifies". That was
# true, and it was the defect. `harness` is the one class GATEWAY_CLASS_READERS
# maps to no claim; the recording gateway serves /__canary/{cell,health,
# generation,observe} unauthenticated to every container on its network; and
# run.sh puts the image under test on that network. MEASURED with a throwaway
# container against the real sink.mjs: POST /__canary/cell returned 200 and the
# gateway's attribution tag became the value the CALLER chose, GET
# /__canary/health and GET /__canary/generation each made the gateway run SQL
# on the caller's behalf, POST /__canary/observe wrote a record into the log
# this harness treats as its second observer, and GET /rest/v1/accounts was 401
# — the data plane needed a token, the control plane needed nothing. One of
# those real rows spliced into this corpus inside a claimed request window gave
# rc=0, the PASS banner and hardFailures 0.
#
# The rule is now: every /__canary row must be traffic the driver's protocol
# produces. H6 is the negative control — the disclosed residual, asserted
# rather than assumed, so this block cannot become "any /__canary row refuses".
# ===========================================================================

# The harness-row planter. It INSERTS (a real extra call adds a row, it does
# not replace one) immediately after the last row already carrying the anchor
# tag, so the plant lands inside an existing window instead of splitting one —
# a split tag is refused for a different reason and would not measure this.
# It asserts that it added exactly one line and that the line reads back.
plant_harness_row() {  # dir schema tag method path [anchor-tag]
  node -e '
const fs = require("node:fs");
const [dir, S, TAG, METHOD, P, ANCHOR] = process.argv.slice(1);
const f = `${dir}/sink-${S}.jsonl`;
const raw = fs.readFileSync(f, "utf8");
const lines = raw.split("\n");
const trailing = lines[lines.length - 1] === "" ? 1 : 0;
const body = trailing ? lines.slice(0, -1) : lines;
const rows = body.map((l) => JSON.parse(l));
const anchor = ANCHOR || (rows.some((r) => r.cell === TAG) ? TAG : "(unset)");
const at = rows.map((r, i) => (r.cell === anchor ? i : -1)).filter((i) => i >= 0).pop();
if (at === undefined) { console.error(`k16 harness planter: no row carries ${anchor}`); process.exit(2); }
const row = { seq: rows[at].seq + 1, t: rows[at].t, cell: TAG, kind: "harness",
  method: METHOD, path: P, query: "", status: 200, reqBodyBytes: 0,
  headers: { host: "nt-canary-sink:8000", connection: "keep-alive", accept: "*/*", "user-agent": "node" } };
for (let i = at + 1; i < rows.length; i++) { rows[i].seq += 1; body[i] = JSON.stringify(rows[i]); }
body.splice(at + 1, 0, JSON.stringify(row));
fs.writeFileSync(f, body.join("\n") + (trailing ? "\n" : ""));
const after = fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== "");
if (after.length !== rows.length + 1) {
  console.error(`k16 harness planter: line count ${rows.length} -> ${after.length}, wanted +1`); process.exit(2);
}
const back = JSON.parse(after[at + 1]);
if (back.path !== P || back.cell !== TAG || back.method !== METHOD) {
  console.error("k16 harness planter: the planted row does not read back"); process.exit(2);
}
process.stderr.write(`k16 harness planter: ${S} ${TAG} ${METHOD} ${P} (${rows.length} -> ${after.length} lines)\n`);
' "$@"
}

# dir-name case-id tag method path anchor expected-fragment
harness_case() {
  local nm cid tag method p anchor frag d problems
  cid="$1"; tag="$2"; method="$3"; p="$4"; anchor="$5"; frag="$6"
  nm="$(printf '%s' "$cid" | tr '[:upper:]' '[:lower:]')"
  d="$(copy_of "h-${nm}")"
  plant_harness_row "$d" 0023 "$tag" "$method" "$p" "$anchor" 2>/dev/null \
    || harness "${cid}: the harness-row planter failed"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner-printed"
  says "not traffic the driver's protocol produces" \
    || problems="${problems} refusal-does-not-name-the-protocol"
  says "$frag" || problems="${problems} refusal-does-not-say[${frag}]"
  [[ "$(scope "$d" 's.claimEvidence["0023"].gatewayHarnessUnaccounted')" == "1" ]] \
    || problems="${problems} gatewayHarnessUnaccounted=$(scope "$d" 's.claimEvidence["0023"].gatewayHarnessUnaccounted')(want 1)"
  if [[ -z "$problems" ]]; then
    ok "${cid} ${method} ${p} under a ${tag} tag is refused, naming the reason"
  else
    bad "${cid} ${method} ${p} under a ${tag} tag:${problems}"
  fi
  rm -rf "$d"
}

harness_case H1 "$TAG"                        GET  "/__canary/health" "" \
  "issues no /__canary/health under a request tag"
harness_case H2 "$TAG"                        GET  "/__canary/generation" "" \
  "issues no /__canary/generation under a request tag"
harness_case H3 "$TAG"                        POST "/__canary/observe" "" \
  "a second /__canary/observe under the tag"
harness_case H4 "m-off__s-off__b-probe#99"    POST "/__canary/cell" "(unset)" \
  "is not one this run's cell results account for"
harness_case H4b "the-image-chose-this-tag"   POST "/__canary/cell" "(unset)" \
  "issues no /__canary/cell under a other tag"
harness_case H5 "$TAG"                        GET  "/__canary/secrets" "" \
  "issues no /__canary/secrets under a request tag"

# ---------------------------------------------------------------------------
# H6 — THE NEGATIVE CONTROL, AND THE DISCLOSED RESIDUAL, MEASURED.
#      Before the driver announces the first cell tag of a generation the
#      gateway's tag is "(unset)" and run.sh's own readiness probe is
#      GET /__canary/health, retried until the gateway reaches the database. An
#      image calling /__canary/health in that window is indistinguishable from
#      the probe, and this case asserts that it still certifies — so the rule
#      above is "the driver's protocol", not "any /__canary row refuses", and
#      the residual in the harness-control-plane scope entry is a measurement
#      rather than a hedge.
# ---------------------------------------------------------------------------
{
  d="$(copy_of h6)"
  plant_harness_row "$d" 0023 "(unset)" GET "/__canary/health" "(unset)" 2>/dev/null \
    || harness "H6: the harness-row planter failed"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 0 ]] || problems="${problems} rc=${RC}(want 0)"
  has_pass_banner "$FLAT" || problems="${problems} no-PASS-banner"
  [[ "$(scope "$d" 's.claimEvidence["0023"].gatewayHarnessUnaccounted')" == "0" ]] \
    || problems="${problems} gatewayHarnessUnaccounted!=0"
  if [[ -z "$problems" ]]; then
    ok "H6 NEGATIVE CONTROL: a second readiness-poll /__canary/health under (unset) still certifies —"
    printf '       the residual the harness-control-plane scope entry discloses, measured\n'
  else
    bad "H6 the readiness poll is now refused:${problems}"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# HCOUNT — the new counters read AS NUMBERS on the untouched set, including the
#          shape table. "0 unaccounted" is also what a check that never ran
#          produces, so the accounted count and the eight protocol shapes are
#          asserted too.
# ---------------------------------------------------------------------------
{
  d="$(copy_of hcount)"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 0 ]] || problems="${problems} rc=${RC}"
  for s in 0008 0023; do
    acc="$(scope "$d" "s.claimEvidence[\"${s}\"].gatewayHarnessAccounted")"
    una="$(scope "$d" "s.claimEvidence[\"${s}\"].gatewayHarnessUnaccounted")"
    tot="$(scope "$d" "s.claimEvidence[\"${s}\"].gatewayHarnessRows")"
    nsh="$(scope "$d" "Object.keys(s.claimEvidence[\"${s}\"].gatewayHarnessByShape).length")"
    [[ "$acc" == "$tot" ]] || problems="${problems} ${s}:accounted=${acc}!=harnessRows=${tot}"
    [[ "$una" == "0" ]]    || problems="${problems} ${s}:unaccounted=${una}"
    [[ "$nsh" == "8" ]]    || problems="${problems} ${s}:shapes=${nsh}(want 8)"
  done
  if [[ -z "$problems" ]]; then
    ok "HCOUNT every /__canary row of both generations is accounted ($(scope "$d" 's.claimEvidence["0023"].gatewayHarnessAccounted') on 0023),"
    printf '       0 unaccounted, and the protocol shape table has its 8 entries\n'
  else
    bad "HCOUNT the harness-row accounting does not read back:${problems}"
  fi
  rm -rf "$d"
}

# ===========================================================================
# ROUND 9 (R9-2). THE IMAGE / SOURCE / COMMIT BINDING IS RE-DERIVED HERE.
#
# run.sh requires --source, the image's source-digest label and the tree at
# --target-sha to be one tree, and writes all of it into provenance.json. A
# literal scan of driver/ for those field names returned ZERO hits while
# provenance.json returned twelve, and rewriting any of them certified rc=0.
# ===========================================================================
prov_case() {  # case-id mutation expected-fragment
  local cid expr frag nm d problems
  cid="$1"; expr="$2"; frag="$3"
  nm="$(printf '%s' "$cid" | tr '[:upper:]' '[:lower:]')"
  d="$(copy_of "p-${nm}")"
  node -e '
const fs = require("node:fs");
const f = process.argv[1];
const p = JSON.parse(fs.readFileSync(f, "utf8"));
const before = JSON.stringify(p);
(new Function("p", process.argv[2]))(p);
if (JSON.stringify(p) === before) { console.error("k16 provenance planter: nothing changed"); process.exit(2); }
fs.writeFileSync(f, JSON.stringify(p, null, 2));
' "$d/provenance.json" "$expr" || harness "${cid}: the provenance planter failed"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner-printed"
  says "control B7 (image/source/commit binding)" || problems="${problems} not-named-as-B7"
  says "$frag" || problems="${problems} refusal-does-not-say[${frag}]"
  [[ "$(scope "$d" 's.controlEvidence.imageSourceBinding.satisfied')" == "false" ]] \
    || problems="${problems} scope-still-satisfied"
  if [[ -z "$problems" ]]; then
    ok "${cid} ${frag} -> refused"
  else
    bad "${cid} provenance mutation not refused:${problems}"
  fi
  rm -rf "$d"
}

prov_case B7a 'p.sourceDigest="0".repeat(64);'      "the run drove a surface that is not the commit's"
prov_case B7b 'p.imageSourceDigest="1".repeat(64);' "the image under test is not the tree whose routes were driven"
prov_case B7c 'p.imageRevision="deadbeef".repeat(5);' "but this verdict is filed against --target-sha"
prov_case B7d 'delete p.imageSourceDigest;'         "which is not the digest shape run.sh writes"

# B7e — THE NEGATIVE CONTROL. The four above must not be passing because every
#       provenance edit refuses; the untouched record must read back satisfied,
#       as a VALUE, because "no reason printed" is also what a control that
#       never ran produces.
{
  d="$(copy_of p-b7e)"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 0 ]] || problems="${problems} rc=${RC}(want 0)"
  for k in satisfied sourceEqualsCommit imageEqualsSource revisionEqualsTargetSha; do
    v="$(scope "$d" "s.controlEvidence.imageSourceBinding.${k}")"
    [[ "$v" == "true" ]] || problems="${problems} ${k}=${v}"
  done
  if [[ -z "$problems" ]]; then
    ok "B7e NEGATIVE CONTROL: the untouched provenance reads back satisfied on all three equalities,"
    printf '       so B7a-B7d discriminate rather than refusing every edit\n'
  else
    bad "B7e the untouched binding does not read back satisfied:${problems}"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# R8-1 — deleting the row's self-description must change nothing.
# ---------------------------------------------------------------------------
{
  dctl="$(copy_of r81-control)"
  plant_row "$dctl" 0023 "$TAG" "/rest/v1/accounts" honest 2>/dev/null || harness "R8-1a: the planter failed"
  verdict "$dctl"
  rc_ctl="$RC"
  p_ctl="$(scope "$dctl" "s.claimStatus['noPostgRESTCall'].violated")"
  d_ctl="$(scope "$dctl" "s.claimStatus['noDatabaseCall'].violated")"
  problems=""
  [[ "$rc_ctl" -eq 1 ]] || problems="${problems} rc=${rc_ctl}(want 1)"
  [[ "$p_ctl" =~ ^[0-9]+$ && "$p_ctl" -gt 0 ]] || problems="${problems} noPostgRESTCall.violated=${p_ctl}(want >0)"
  [[ "$d_ctl" =~ ^[0-9]+$ && "$d_ctl" -gt 0 ]] || problems="${problems} noDatabaseCall.violated=${d_ctl}(want >0)"
  if [[ -z "$problems" ]]; then
    ok "R8-1a POSITIVE CONTROL: the row WITH \"kind\":\"postgrest\" is refused (rc=1, noPostgRESTCall ${p_ctl}, noDatabaseCall ${d_ctl})"
  else
    bad "R8-1a the labelled row is not refused, so R8-1b below proves nothing:${problems}"
  fi

  datk="$(copy_of r81-attack)"
  plant_row "$datk" 0023 "$TAG" "/rest/v1/accounts" nokind 2>/dev/null || harness "R8-1b: the planter failed"
  verdict "$datk"
  problems=""
  [[ "$RC" -eq 1 ]] || problems="${problems} rc=${RC}(want 1)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner-present"
  p_atk="$(scope "$datk" "s.claimStatus['noPostgRESTCall'].violated")"
  d_atk="$(scope "$datk" "s.claimStatus['noDatabaseCall'].violated")"
  [[ "$p_atk" == "$p_ctl" ]] || problems="${problems} noPostgRESTCall.violated=${p_atk}(want ${p_ctl}, the same as the labelled row)"
  [[ "$d_atk" == "$d_ctl" ]] || problems="${problems} noDatabaseCall.violated=${d_atk}(want ${d_ctl})"
  nk="$(scope "$datk" "s.claimEvidence['0023'].gatewayRowsWithoutADeclaredKind")"
  [[ "$nk" == "1" ]] || problems="${problems} gatewayRowsWithoutADeclaredKind=${nk}(want 1)"
  inreq="$(scope "$datk" "s.claimEvidence['0023'].gatewayRowsInAClaimedRequest")"
  [[ "$inreq" == "1" ]] || problems="${problems} gatewayRowsInAClaimedRequest=${inreq}(want 1)"
  if [[ -z "$problems" ]]; then
    ok "R8-1b DELETING the \`kind\` field changes NOTHING: same rc, same two claims, same counts;"
    printf '       the class comes from the path, and the row is published as unlabelled (1 of %s)\n' \
      "$(scope "$datk" "s.claimEvidence['0023'].gatewayRows")"
  else
    bad "R8-1b a row that removed its own self-description is judged differently:${problems}"
  fi
  rm -rf "$dctl" "$datk"
}

# ---------------------------------------------------------------------------
# M1 — a row whose declared kind contradicts its own path is refused, not
#      resolved in either direction. This is the shape of the R8-2 attack the
#      auditor drove: "kind":"other" beside a real Supabase surface.
# ---------------------------------------------------------------------------
{
  d="$(copy_of m1)"
  plant_row "$d" 0023 "$TAG" "/storage/v1/object/private/broker-keys.json" other 2>/dev/null \
    || harness "M1: the planter failed"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner-present"
  says "declare a kind that their own path contradicts" || problems="${problems} contradiction-not-named"
  says "the path classifies as 'storage'" || problems="${problems} derived-class-not-named"
  ml="$(scope "$d" "s.claimEvidence['0023'].gatewayRowsMislabelled")"
  [[ "$ml" == "1" ]] || problems="${problems} gatewayRowsMislabelled=${ml}(want 1)"
  if [[ -z "$problems" ]]; then
    ok "M1 \"kind\":\"other\" beside /storage/v1 is refused as self-contradicting, naming the derived class"
  else
    bad "M1 a self-contradicting gateway row is not refused:${problems}"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# R8-3 — the canary's raw dump vs the grep the verdict reads.
# ---------------------------------------------------------------------------
{
  # (a) the positive control: the row in the file the verdict reads.
  d="$(copy_of r83-readfile)"
  printf '%s\n' "$ROW" >> "$d/canary-0023.txt"
  verdict "$d"
  problems=""
  v="$(scope "$d" "s.claimStatus['noVaultCall'].violated")"
  [[ "$v" =~ ^[0-9]+$ && "$v" -gt 0 ]] || problems="${problems} noVaultCall.violated=${v}(want >0)"
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  says "are in canary-0023.txt and NOT in sql/canary-dump-0023.out" || problems="${problems} extraction-side-disagreement-not-named"
  if [[ -z "$problems" ]]; then
    ok "R8-3a POSITIVE CONTROL: the NT_CANARY_ROW is a real violation (noVaultCall ${v}) and the file"
    printf '       the verdict reads no longer matches the dump it was extracted from\n'
  else
    bad "R8-3a the canary row in the read file is not a violation, so R8-3b proves nothing:${problems}"
  fi
  rm -rf "$d"

  # (b) THE ATTACK: the identical line present ONLY in the raw dump.
  d="$(copy_of r83-rawonly)"
  printf '%s\n' "$ROW" >> "$d/sql/canary-dump-0023.out"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner-present"
  says "are in sql/canary-dump-0023.out and NOT in canary-0023.txt" || problems="${problems} reason-not-named"
  says "vault_create_secret" || problems="${problems} the-refusal-does-not-quote-the-line"
  ag="$(scope "$d" "s.controlEvidence.perSchema['0023'].canaryExtraction.agrees")"
  [[ "$ag" == "false" ]] || problems="${problems} canaryExtraction.agrees=${ag}(want false)"
  n="$(scope "$d" "s.controlEvidence.perSchema['0023'].canaryExtraction.onlyInRawDump.length")"
  [[ "$n" == "1" ]] || problems="${problems} onlyInRawDump.length=${n}(want 1)"
  if [[ -z "$problems" ]]; then
    ok "R8-3b a vault-wrapper row present ONLY in sql/canary-dump-0023.out is refused and quoted"
  else
    bad "R8-3b the raw dump is still compared with nothing:${problems}"
  fi
  rm -rf "$d"

  # (c) the honest case: the row in BOTH. Still a FINDING, not a refusal — the
  #     control must not turn every real canary hit into "cannot be believed".
  d="$(copy_of r83-both)"
  printf '%s\n' "$ROW" >> "$d/sql/canary-dump-0023.out"
  printf '%s\n' "$ROW" >> "$d/canary-0023.txt"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 1 ]] || problems="${problems} rc=${RC}(want 1 FINDING)"
  v="$(scope "$d" "s.claimStatus['noVaultCall'].violated")"
  [[ "$v" =~ ^[0-9]+$ && "$v" -gt 0 ]] || problems="${problems} noVaultCall.violated=${v}(want >0)"
  ag="$(scope "$d" "s.controlEvidence.perSchema['0023'].canaryExtraction.agrees")"
  [[ "$ag" == "true" ]] || problems="${problems} canaryExtraction.agrees=${ag}(want true)"
  if [[ -z "$problems" ]]; then
    ok "R8-3c the row in BOTH files is a FINDING (noVaultCall ${v}) with the extraction still agreeing —"
    printf '       the new control refuses a DISAGREEMENT, not a canary hit\n'
  else
    bad "R8-3c an honestly recorded canary hit is no longer a plain finding:${problems}"
  fi
  rm -rf "$d"

  # (d) the dump deleted: the file the extraction is checked against is gone.
  d="$(copy_of r83-nodump)"
  rm -f "$d/sql/canary-dump-0023.out"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  says "sql/canary-dump-0023.out is absent" || problems="${problems} reason-not-named"
  if [[ -z "$problems" ]]; then
    ok "R8-3d deleting sql/canary-dump-0023.out is refused; the reading cannot be checked against nothing"
  else
    bad "R8-3d a deleted canary dump still certifies:${problems}"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# P1/P2 — the image's own pathClass, checked against the image's own URL.
#
# Both plants put ONE fetch event inside a bounded request window of the
# instrument log. Both therefore also trip the observer/transcription diff,
# because the cell result does not report the event — so rc alone cannot tell
# the two apart. The discrimination is the CONTRADICTION REASON: present for
# the record that disagrees with itself, absent for the record that does not.
# ---------------------------------------------------------------------------
plant_event() {  # dir schema cell tag pathClass path
  node -e '
const fs = require("node:fs");
const [dir, S, CELL, TAG, PC, P] = process.argv.slice(1);
const gw = `${dir}/sink-${S}.jsonl`;
const rows = fs.readFileSync(gw, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const win = rows.filter((r) => r.cell === TAG).map((r) => r.t);
if (win.length < 2) { console.error(`k16 event planter: no bounded window for ${TAG}`); process.exit(2); }
const mid = Math.floor((Math.min(...win) + Math.max(...win)) / 2);
const f = `${dir}/instr/${S}-${CELL}.jsonl`;
const before = fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== "").length;
const seq = 9000;
const ev = { seq, t: mid, kind: "fetch",
  detail: { method: "GET", url: `http://nt-canary-sink:3999${P}`, host: "nt-canary-sink:3999",
            pathname: P, hostClass: "supabase-sink", pathClass: PC },
  stack: ["k16"] };
fs.appendFileSync(f, JSON.stringify(ev) + "\n");
const after = fs.readFileSync(f, "utf8").split("\n").filter((l) => l !== "").length;
if (after !== before + 1) { console.error(`k16 event planter: line count ${before} -> ${after}`); process.exit(2); }
process.stderr.write(`k16 event planter: ${f} +1 line, pathClass=${PC} path=${P} t=${mid}\n`);
' "$@"
}

CONTRA_NEEDLE="declares pathClass"
{
  d="$(copy_of p1)"
  plant_event "$d" 0023 m-off__s-off__b-probe "$TAG" harness "/rest/v1/accounts" 2>/dev/null \
    || harness "P1: the event planter failed"
  verdict "$d"
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  says "$CONTRA_NEEDLE" || problems="${problems} contradiction-not-named"
  says "which classifies as 'postgrest'" || problems="${problems} derived-class-not-named"
  n="$(scope "$d" "s.claimEvidence['0023'].imageEgressPathClassContradictions")"
  [[ "$n" == "1" ]] || problems="${problems} imageEgressPathClassContradictions=${n}(want 1)"
  if [[ -z "$problems" ]]; then
    ok "P1 an instrument record declaring pathClass=harness for /rest/v1/accounts is refused as self-contradicting"
  else
    bad "P1 the image's declared path class is not checked against its own URL:${problems}"
  fi
  rm -rf "$d"
}
{
  d="$(copy_of p2)"
  plant_event "$d" 0023 m-off__s-off__b-probe "$TAG" postgrest "/rest/v1/accounts" 2>/dev/null \
    || harness "P2: the event planter failed"
  verdict "$d"
  problems=""
  says "$CONTRA_NEEDLE" && problems="${problems} contradiction-reported-for-a-consistent-record"
  n="$(scope "$d" "s.claimEvidence['0023'].imageEgressPathClassContradictions")"
  [[ "$n" == "0" ]] || problems="${problems} imageEgressPathClassContradictions=${n}(want 0)"
  # …and the run still refuses, for the DIFFERENT and correct reason: the cell
  # result does not report the event. Without this the case would pass if the
  # whole plant had been ignored.
  says "records 1 event(s) in this request's window that the cell result does not report" \
    || problems="${problems} the-consistent-plant-was-not-seen-at-all"
  if [[ -z "$problems" ]]; then
    ok "P2 NEGATIVE CONTROL: the same event with a CONSISTENT pathClass reports no contradiction,"
    printf '       while still being seen (and refused) as an event the cell result does not report\n'
  else
    bad "P2 the contradiction check is not discriminating:${problems}"
  fi
  rm -rf "$d"
}

# ---------------------------------------------------------------------------
# SCOPE — the machine-readable scope must name every class and its readers.
# ---------------------------------------------------------------------------
{
  problems=""
  st="$(scope "$BASE" "(s.doesNotClaim.find((x) => x.id === 'data-plane-surface') || {}).statement")"
  if [[ "$st" == "(missing)" || -z "$st" ]]; then
    problems=" no data-plane-surface entry in verdict-scope.json"
  else
    missing="$(K16_ROOT="$CANARY_ROOT" node -e '
import(`${process.env.K16_ROOT}/driver/claims.mjs`).then((m) => {
  const st = process.argv[1];
  const bad = [];
  for (const c of m.GATEWAY_PATH_CLASSES) {
    if (!st.includes(`${c} -> `)) { bad.push(`${c}:not-named`); continue; }
    for (const r of m.GATEWAY_CLASS_READERS[c]) {
      if (!st.includes(r)) bad.push(`${c}->${r}:reader-not-named`);
    }
  }
  process.stdout.write(bad.join(" "));
});
' "$st")"
    [[ -z "$missing" ]] || problems=" ${missing}"
  fi
  if [[ -z "$problems" ]]; then
    ok "SCOPE verdict-scope.json names all $(K16_ROOT="$CANARY_ROOT" node -e 'import(`${process.env.K16_ROOT}/driver/claims.mjs`).then(m=>process.stdout.write(String(m.GATEWAY_PATH_CLASSES.length)))') classes and the claim each one is read by"
  else
    bad "SCOPE the published scope does not say which claim reads which class:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# TABLE — the coverage assertion in claims.mjs is not vacuous.
#
# "Every class has a reader" is enforced by a throw at import time, and the
# passing value of a throw-at-import check is SILENCE — exactly the same
# silence as the check having been deleted. So it is shown to fire on a
# deliberately broken copy, with the exact message.
# ---------------------------------------------------------------------------
{
  D="$WORK/tabled"
  rm -rf "$D"; mkdir -p "$D"
  cp -a "${CANARY_ROOT}/driver/." "$D/"
  python3 - "$D/claims.mjs" <<'PYEOF'
import io, sys, re
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = '  storage:   ["noUnexpectedNetworkCall"],\n'
if s.count(old) != 1:
    sys.stderr.write("k16 TABLE: could not find the storage reader entry to remove\n"); sys.exit(2)
io.open(p, "w", encoding="utf-8").write(s.replace(old, ""))
PYEOF
  set +e
  out="$(node -e 'import(process.argv[1]).then(()=>{process.stdout.write("IMPORTED-CLEANLY");},(e)=>{process.stdout.write(e.message);})' "$D/claims.mjs" 2>&1)"
  set -e
  problems=""
  case "$out" in
    *"classes with no reader entry: storage"*) : ;;
    *) problems=" the broken copy did not name the uncovered class; got: ${out:0:200}" ;;
  esac
  case "$out" in
    *"IMPORTED-CLEANLY"*) problems="${problems} a claims.mjs with an unread class imported without complaint" ;;
  esac
  if [[ -z "$problems" ]]; then
    ok "TABLE POSITIVE CONTROL: removing one class from GATEWAY_CLASS_READERS makes claims.mjs refuse to load,"
    printf '       naming the class no claim would read — so the coverage assertion is not silence\n'
  else
    bad "TABLE the coverage assertion does not fire on a planted hole:${problems}"
  fi
  rm -rf "$D"
}

# ---------------------------------------------------------------------------
# TRIPLE — the three copies of the classifier must be ONE decision list.
#
# Only claims.mjs decides anything. But sink.mjs and instrument.cjs each run
# their own copy inside their own process, and the verdict REFUSES a record
# whose declared class contradicts the derived one — so a producer that drifts
# out of sync does not merely mislabel, it makes every honest run refuse. The
# three tables are extracted and compared as text, with a positive control on
# the extractor (it must find twelve decisions, because a zero-line extraction
# compares equal to another zero-line extraction) and a negative control that
# the comparison notices a planted extra line.
# ---------------------------------------------------------------------------
{
  T="$WORK/tables"; mkdir -p "$T"
  extract() {  # file, first-line-of-the-function -> normalised decision list
    awk -v s="$2" 'index($0,s){f=1} f{print; if (f && $0=="}") exit}' "$1" \
      | grep -E 'return "' \
      | sed -e 's/pathname/X/g; s/\bp\b/X/g; s/\bs\b/X/g; s/[[:space:]]\+/ /g; s/^ //'
  }
  extract "${CANARY_ROOT}/driver/claims.mjs"          'export function classifyGatewayPath(p) {' > "$T/claims"
  extract "${CANARY_ROOT}/sink/sink.mjs"              'function classify(pathname) {'            > "$T/sink"
  extract "${CANARY_ROOT}/instrument/instrument.cjs"  'function classifyPath(p) {'               > "$T/instrument"
  nclaims="$(wc -l < "$T/claims")"
  problems=""
  nclasses="$(K16_ROOT="$CANARY_ROOT" node -e 'import(`${process.env.K16_ROOT}/driver/claims.mjs`).then(m=>process.stdout.write(String(m.GATEWAY_PATH_CLASSES.length)))')"
  # One decision line per class, plus the fall-through return. An extractor that
  # matched nothing would report every pair "identical".
  if [[ "$nclaims" -lt "$nclasses" ]]; then
    problems=" the extractor found ${nclaims} decision line(s) in claims.mjs for ${nclasses} classes; an empty extraction compares equal to anything"
  else
    for other in sink instrument; do
      diff -q "$T/claims" "$T/$other" >/dev/null \
        || problems="${problems} ${other}:differs-from-claims.mjs"
    done
    # the negative control on the comparison itself
    cp "$T/instrument" "$T/planted"
    printf 'if (X === "/zzz") return "bogus";\n' >> "$T/planted"
    diff -q "$T/claims" "$T/planted" >/dev/null \
      && problems="${problems} the-comparison-cannot-see-a-planted-difference"
  fi
  if [[ -z "$problems" ]]; then
    ok "TRIPLE the classifier is ONE decision list in three files (${nclaims} lines, byte-identical after"
    printf '       renaming the parameter), and the comparison detects a planted extra decision\n'
  else
    bad "TRIPLE the three copies of the path classifier have drifted:${problems}"
    for other in sink instrument; do diff "$T/claims" "$T/$other" | sed 's/^/       /' || true; done
  fi
  rm -rf "$T"
}

rm -rf "$BASE"

# ---------------------------------------------------------------------------
printf '\n== K16: %s passed, %s failed ==\n' "$pass" "$fail"
missing=""
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && found=1; done
  [[ "$found" -eq 1 ]] || missing="${missing} ${c}"
done
if [[ -n "$missing" ]]; then
  printf 'k16: these declared cases never reported:%s\n' "$missing" >&2
  printf 'k16: a case that did not run is not a case that passed.\n' >&2
  COMPLETED=1
  exit 2
fi
COMPLETED=1
[[ "$fail" -eq 0 ]] || exit 1
exit 0
