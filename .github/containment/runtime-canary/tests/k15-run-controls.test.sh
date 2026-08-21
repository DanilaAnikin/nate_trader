#!/usr/bin/env bash
# ============================================================================
# K15 — the run's own controls must be READ at verdict time, not merely run
#
# WHY THIS SUITE EXISTS
# ---------------------
# Audit finding F says an absence is only evidence from a detector KNOWN to
# work. It was closed for exactly one detector — the trusted runner's sensor
# report (k14 F1/F2, ADV3a-c). Four other controls were asserted inside
# run.sh's own process and read by nothing afterwards, and a fifth artefact,
# the image's own stdout, was collected and never opened.
#
# MEASURED against the code as shipped before round 7, over a genuine 48-cell
# certifying set:
#
#   * deleting instr/egress-control.jsonl and instr/egress-broker.txt
#     alone                                                    -> rc=0 PASS
#   * deleting those two plus canary-arm-<gen>.txt,
#     sql/arm-<gen>.{out,err}, sql/on-error-stop-<gen>.err and
#     tombstone-<gen>.txt                                      -> rc=0 PASS,
#     with no mention of any of them in the transcript or in
#     verdict-scope.json
#   * two lines appended to one cell's .applog, recording a 200 OK from
#     paper-api.alpaca.markets and a successful vault_create_secret rpc
#                                                              -> rc=0 PASS
#
# §3c is the one that makes noBrokerCall MEAN anything: it proves the
# in-process classifier calls paper-api.alpaca.markets a broker and does NOT
# call the recording gateway one. Its passing value is byte-identical to the
# value the matrix prints when the classifier was never shown to work.
#
# WHAT EVERY CASE BELOW IS SHAPED LIKE. Each is a rejection assertion, so the
# suite opens with a POSITIVE CONTROL (GREEN) that the unmodified set still
# certifies — without it, a verdict that refused everything would score a
# perfect suite — and a MEASURED case that asserts the CONTROL COUNTERS as
# numbers, because "0 hits" and "satisfied" are also what a check that never
# ran produces. Every planting helper additionally asserts that it changed the
# file it meant to change, so a case cannot pass by planting nothing.
#
# Each rejection case asserts the EXACT reason string, never "some non-zero
# exit": a refusal for an unrelated reason is not this case passing.
#
# The directory is copied before it is mutated; the input evidence is never
# modified in place.
#
# Usage:
#   k15-run-controls.test.sh --full-out DIR [--probe-user-id ID]
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
    *) printf 'k15: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$FULL_OUT" ]] || { printf 'k15: --full-out is required\n' >&2; exit 2; }
[[ -d "$FULL_OUT/cells" ]] || { printf 'k15: %s has no cells/ directory\n' "$FULL_OUT" >&2; exit 2; }

# Both generations are needed: the arming, ON_ERROR_STOP and tombstone controls
# are per-generation, and the tombstone control's whole point is that 0008 and
# 0023 must classify DIFFERENTLY. A one-generation directory cannot exercise it,
# and a skipped case is not a passed one.
for s in 0008 0023; do
  n="$(find "$FULL_OUT/cells" -name "result-${s}-*.json" | wc -l)"
  [[ "$n" == "24" ]] || {
    printf 'k15: --full-out has %s cell files for generation %s, not 24.\n' "$n" "$s" >&2
    exit 2
  }
done

# The fixture must carry the CURRENT request attestation, for the same reason
# k14 says so: a directory from before the round-5 detail binding refuses on all
# 480 requests, and GREEN would then go red for a reason that is about the
# fixture's age rather than about any control.
WANT_OBS_V="$(node -e '
  import("'"${CANARY_ROOT}"'/driver/observation.mjs")
    .then((m) => process.stdout.write(String(m.OBSERVATION_VERSION)));
')"
[[ -n "$WANT_OBS_V" ]] || { printf 'k15: could not read OBSERVATION_VERSION\n' >&2; exit 2; }
for s in 0008 0023; do
  got="$(node -e '
const fs = require("node:fs");
for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!l.trim()) continue;
  let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.observation && e.observation.v !== undefined) { process.stdout.write(String(e.observation.v)); break; }
}
' "$FULL_OUT/sink-${s}.jsonl")"
  [[ "$got" == "$WANT_OBS_V" ]] || {
    printf 'k15: %s carries request attestation version %s; this checkout derives %s.\n' \
      "$FULL_OUT/sink-${s}.jsonl" "${got:-none}" "$WANT_OBS_V" >&2
    printf 'k15: drive a new matrix; this directory cannot be forward-ported.\n' >&2
    exit 2
  }
done

for st in "$FULL_OUT"/sensor-state-*; do
  [[ -d "$st" ]] || continue
  if [[ ! -f "${st}/report.hmac" ]]; then
    printf '\033[1;33mnote\033[0m %s predates the ADV-3 seal; sealing with its own run key\n' "$FULL_OUT"
    node "${HERE}/seal-legacy-report.mjs" "$FULL_OUT" \
      || { printf 'k15: %s cannot be forward-ported\n' "$FULL_OUT" >&2; exit 2; }
    break
  fi
done

if [[ -z "$PROBE_USER_ID" ]]; then
  PROBE_USER_ID="$(node "${CANARY_ROOT}/driver/keys.mjs" --print-shell \
    | sed -n 's/^CANARY_PROBE_USER_ID=//p')"
fi
[[ -n "$PROBE_USER_ID" ]] || { printf 'k15: could not determine the probe user id\n' >&2; exit 2; }

WORK="$(mktemp -d /tmp/nt-k15-XXXXXX)"

CASES_INTENDED=(GREEN MEASURED
                E1 E2 E3 E4 E5
                A1 A2 A3
                O1 O2
                T1 T2
                L1 L2 L3 L4
                SCOPE)
CASES_SEEN=()
COMPLETED=0
cleanup() {
  local rc=$?
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk15 harness: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'k15 harness: an unfinished suite is not a passing one.\n' >&2
    [[ "$rc" -eq 0 ]] && exit 2
  fi
  exit "$rc"
}
trap cleanup EXIT

pass=0; fail=0
seen() { CASES_SEEN+=("${1%% *}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }
harness() { printf 'k15 harness: %s\n' "$*" >&2; exit 2; }

# The transcript is captured to a FILE and stripped ONCE into a plain file that
# every matcher greps directly. Never `sed … | grep -q`: grep exits at its first
# match, sed dies of SIGPIPE, and under pipefail the pipeline's status is then
# the OPPOSITE of what the test means. k13 measured captures of one refusal
# through a pipe at anywhere between 92082 and 330509 bytes.
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

# A missing field must be a REPORTED value, never an abort. When the field this
# suite exists to assert is absent — which is exactly the state before the
# repair — a throwing reader kills the suite at its second case and eighteen
# rejection cases never run. An unfinished suite is caught by the cleanup trap,
# but "1 of 19 cases had reported" is a far worse diagnostic than nineteen
# named failures, and a suite that cannot describe its own red-before is not
# much of a suite. So: absent reads back as the literal (missing).
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

# A rejection case: run the verdict, require rc=3 AND the exact reason.
expect_refusal() {  # label, dir, needle
  local label="$1" dir="$2" needle="$3"
  verdict "$dir"
  local problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner-present"
  says "$needle" || problems="${problems} reason-not-named"
  if [[ -z "$problems" ]]; then
    ok "$label"
  else
    bad "${label} —${problems}"
    printf '       wanted: %s\n' "$needle"
    grep -m3 -E 'control §|image stdout \(' "$FLAT" | head -3 | sed 's/^/       got: /' || true
  fi
}

printf '\n== K15 the run'"'"'s own controls must be read at verdict time ==\n\n'

# ---------------------------------------------------------------------------
# GREEN — the positive control.
# ---------------------------------------------------------------------------
BASE="$(copy_of base)"
verdict "$BASE"
if [[ "$RC" -eq 0 ]] && has_pass_banner "$FLAT" && [[ "$(scope "$BASE" 's.status')" == "PASS" ]]; then
  ok "GREEN the unmodified 48-cell set still certifies with all five controls re-derived (rc=0)"
else
  bad "GREEN the unmodified set no longer certifies (rc=$RC, status $(scope "$BASE" 's.status' 2>/dev/null || echo '?'))"
  grep -m6 -E 'control §|image stdout \(' "$FLAT" | sed 's/^/       /' || true
fi

# ---------------------------------------------------------------------------
# MEASURED — and it looked. Every counter is asserted as a NUMBER, and the
# expected applog count is computed FROM THE DIRECTORY, because a hard-coded
# figure would turn this into a measurement of one fixture.
# ---------------------------------------------------------------------------
{
  problems=""
  [[ "$(scope "$BASE" 's.controlEvidence.egressClassifier.satisfied')" == "true" ]] \
    || problems="${problems} egress-not-satisfied"
  b="$(scope "$BASE" 's.controlEvidence.egressClassifier.brokerClassifiedNamingABrokerHost')"
  g="$(scope "$BASE" 's.controlEvidence.egressClassifier.sinkClassifiedNamingTheGateway')"
  x="$(scope "$BASE" 's.controlEvidence.egressClassifier.gatewayNamedButClassifiedBroker')"
  [[ "$b" =~ ^[0-9]+$ && "$b" -ge 1 ]] || problems="${problems} brokerClassifiedNamingABrokerHost=${b}(want >=1)"
  [[ "$g" =~ ^[0-9]+$ && "$g" -ge 1 ]] || problems="${problems} sinkClassifiedNamingTheGateway=${g}(want >=1)"
  [[ "$x" == "0" ]] || problems="${problems} gatewayNamedButClassifiedBroker=${x}(want 0)"
  [[ "$(scope "$BASE" 's.controlEvidence.egressClassifier.configAgreesWithPin')" == "true" ]] \
    || problems="${problems} egress-config-not-pinned"
  [[ "$(scope "$BASE" 's.controlEvidence.egressClassifier.brokerFileAgrees')" == "true" ]] \
    || problems="${problems} egress-broker-file-disagrees"
  for s in 0008 0023; do
    for k in arming.armedYes arming.fidelityHolds arming.baselineMatchesCheckout \
             arming.armTxtAgreesWithArmOut onErrorStop.expectedErrorClassPresent \
             tombstoneClassification.agreesWithCheckout applogScan.satisfied; do
      [[ "$(scope "$BASE" "s.controlEvidence.perSchema['$s'].${k}")" == "true" ]] \
        || problems="${problems} ${s}:${k}"
    done
    want="$(find "$FULL_OUT/cells" -name "result-${s}-*.json" | wc -l)"
    got="$(scope "$BASE" "s.controlEvidence.perSchema['$s'].applogScan.filesScanned")"
    [[ "$got" == "$want" ]] || problems="${problems} ${s}:applogsScanned=${got}(want ${want})"
    lines="$(scope "$BASE" "s.controlEvidence.perSchema['$s'].applogScan.linesScanned")"
    bytes="$(scope "$BASE" "s.controlEvidence.perSchema['$s'].applogScan.bytesScanned")"
    [[ "$lines" =~ ^[0-9]+$ && "$lines" -gt 0 ]] || problems="${problems} ${s}:linesScanned=${lines}(want >0)"
    [[ "$bytes" =~ ^[0-9]+$ && "$bytes" -gt 0 ]] || problems="${problems} ${s}:bytesScanned=${bytes}(want >0)"
  done
  # The two generations must classify DIFFERENTLY, or the tombstone control is
  # satisfied by a classifier that answers the same thing to everything.
  c8="$(scope  "$BASE" "s.controlEvidence.perSchema['0008'].tombstoneClassification.requiredState")"
  c23="$(scope "$BASE" "s.controlEvidence.perSchema['0023'].tombstoneClassification.requiredState")"
  [[ -n "$c8" && -n "$c23" && "$c8" != "$c23" ]] \
    || problems="${problems} tombstone-classes-not-distinct(0008=${c8} 0023=${c23})"
  if [[ -z "$problems" ]]; then
    ok "MEASURED and it looked: egress ${b} broker / ${g} gateway / ${x} crossed, applogs scanned per generation" \
       "equal the cell results present, line and byte counts > 0, 0008=${c8} vs 0023=${c23}"
  else
    bad "MEASURED the control counters do not read as a check that ran —${problems}"
  fi
}

# ---------------------------------------------------------------------------
# §3c — the egress classifier
# ---------------------------------------------------------------------------
E1="$(copy_of e1)"
rm -f "$E1/instr/egress-control.jsonl" "$E1/instr/egress-broker.txt"
expect_refusal "E1 the egress control's artefacts deleted -> refused, naming what a zero noBrokerCall would then mean" \
  "$E1" "instr/egress-control.jsonl is absent"

E2="$(copy_of e2)"
node -e '
const fs = require("node:fs");
const p = process.argv[1] + "/instr/egress-control.jsonl";
const before = fs.readFileSync(p, "utf8");
const after = before.replace(/("host":"nt-canary-sink[^"]*","pathname":"[^"]*",)"hostClass":"supabase-sink"/, "$1\"hostClass\":\"broker\"");
if (after === before) { console.error("k15: E2 planted nothing"); process.exit(2); }
fs.writeFileSync(p, after);
const broker = after.split("\n").filter((l) => l !== "" && l.includes("\"hostClass\":\"broker\""));
fs.writeFileSync(process.argv[1] + "/instr/egress-broker.txt", broker.join("\n") + "\n");
' "$E2" || harness "E2 could not relabel the gateway"
expect_refusal "E2 the gateway relabelled 'broker' -> refused: a classifier that calls the gateway a broker is not discriminating" \
  "$E2" "are classified 'broker'; a classifier that calls the gateway a broker"

E3="$(copy_of e3)"
node -e '
const fs = require("node:fs");
const p = process.argv[1] + "/instr/egress-control.jsonl";
const before = fs.readFileSync(p, "utf8");
const after = before.split("\"hostClass\":\"broker\"").join("\"hostClass\":\"loopback\"");
if (after === before) { console.error("k15: E3 planted nothing"); process.exit(2); }
fs.writeFileSync(p, after);
fs.writeFileSync(process.argv[1] + "/instr/egress-broker.txt", "");
' "$E3" || harness "E3 could not relabel the broker"
expect_refusal "E3 every broker event relabelled 'loopback', consistently in both files -> refused: a real broker fetch produced no broker-classified event" \
  "$E3" "holds no event that both names a pinned broker host and is classified 'broker'"

E4="$(copy_of e4)"
node -e '
const fs = require("node:fs");
const p = process.argv[1] + "/instr/egress-broker.txt";
const ls = fs.readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
if (ls.length < 2) { console.error("k15: E4 needs at least two broker lines"); process.exit(2); }
fs.writeFileSync(p, ls.slice(0, -1).join("\n") + "\n");
' "$E4" || harness "E4 could not truncate egress-broker.txt"
expect_refusal "E4 the extraction the shipped check greps, edited by one line -> refused: it no longer re-derives from the log" \
  "$E4" "the two disagree, so one of them was edited after the control ran"

E5="$(copy_of e5)"
node -e '
const fs = require("node:fs");
const p = process.argv[1] + "/instr/egress-control.jsonl";
const before = fs.readFileSync(p, "utf8");
const after = before.replace(/"brokerHosts":\[[^\]]*\]/, "\"brokerHosts\":[\"broker.example.invalid\"]");
if (after === before) { console.error("k15: E5 planted nothing"); process.exit(2); }
fs.writeFileSync(p, after);
' "$E5" || harness "E5 could not rewrite the configured broker hosts"
expect_refusal "E5 the control container configured with hosts other than the pinned ones -> refused: it proves a classifier the matrix did not run against" \
  "$E5" "but this checkout pins"

# ---------------------------------------------------------------------------
# §8b/§8b2 — arming and fidelity
# ---------------------------------------------------------------------------
A1="$(copy_of a1)"
rm -f "$A1/canary-arm-0023.txt"
expect_refusal "A1 the arming record deleted -> refused: a zero canary count is then an absence from an unproven detector" \
  "$A1" "canary-arm-0023.txt is absent"

A2="$(copy_of a2)"
node -e '
const fs = require("node:fs");
const p = process.argv[1] + "/sql/arm-0023.out";
const before = fs.readFileSync(p, "utf8");
const after = before.replace(/^ARMING_OUTCOME=.*$/m,
  "ARMING_OUTCOME=vault_create_secret=returned vault_delete_secret=returned vault_update_secret=returned");
if (after === before) { console.error("k15: A2 planted nothing"); process.exit(2); }
fs.writeFileSync(p, after);
' "$A2" || harness "A2 could not break the fidelity comparison"
expect_refusal "A2 the canary changed what the wrappers do -> refused, before and after quoted" \
  "$A2" "the canary CHANGED what the wrappers do on 0023"

A3="$(copy_of a3)"
node -e '
const fs = require("node:fs");
const dir = process.argv[1];
const line = "vault_create_secret=returned vault_delete_secret=returned vault_update_secret=returned";
for (const [f, k] of [["sql/arm-0023.out", "ARMING_OUTCOME"], ["sql/baseline-0023.out", "BASELINE_OUTCOME"]]) {
  const p = `${dir}/${f}`;
  const before = fs.readFileSync(p, "utf8");
  const after = before.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${line}`);
  if (after === before) { console.error(`k15: A3 planted nothing in ${f}`); process.exit(2); }
  fs.writeFileSync(p, after);
}
' "$A3" || harness "A3 could not rewrite both outcome lines"
expect_refusal "A3 BOTH arming artefacts rewritten to agree with each other -> still refused, against sql/expected-baseline.0023.txt" \
  "$A3" "but this checkout records"

# ---------------------------------------------------------------------------
# §5b — the ON_ERROR_STOP applier control
# ---------------------------------------------------------------------------
O1="$(copy_of o1)"
rm -f "$O1/sql/on-error-stop-0008.err"
expect_refusal "O1 the applier control's artefact deleted -> refused: 'the migrations applied cleanly' would rest on an applier never shown to fail" \
  "$O1" "sql/on-error-stop-0008.err is absent"

O2="$(copy_of o2)"
printf 'psql:<stdin>:2: ERROR:  permission denied for schema public\n' > "$O2/sql/on-error-stop-0008.err"
expect_refusal "O2 the applier failed for some OTHER reason -> refused: 'some non-zero exit' is not a control" \
  "$O2" "does not name the expected failure class ('division by zero')"

# ---------------------------------------------------------------------------
# §7c — the tombstone classification
# ---------------------------------------------------------------------------
T1="$(copy_of t1)"
rm -f "$T1/tombstone-0023.txt"
expect_refusal "T1 the classification deleted -> refused: nothing then records what the wrappers were on that generation" \
  "$T1" "tombstone-0023.txt is absent"

T2="$(copy_of t2)"
node -e '
const fs = require("node:fs");
const p = process.argv[1] + "/tombstone-0023.txt";
const before = fs.readFileSync(p, "utf8");
const after = before.split("INTENTIONALLY_TOMBSTONED").join("LIVE_EXPECTED");
if (after === before) { console.error("k15: T2 planted nothing"); process.exit(2); }
fs.writeFileSync(p, after);
' "$T2" || harness "T2 could not flip the classification"
expect_refusal "T2 0023 reclassified as LIVE_EXPECTED -> refused against expected/tombstone-state.0023.txt" \
  "$T2" "pins 'INTENTIONALLY_TOMBSTONED' for generation 0023"

# ---------------------------------------------------------------------------
# The image's own stdout
# ---------------------------------------------------------------------------
L1="$(copy_of l1)"
victim="$(find "$L1/instr" -name '0023-*.applog' | sort | head -1)"
[[ -n "$victim" ]] || harness "L1 found no applog to delete"
rm -f "$victim"
expect_refusal "L1 one cell's applog deleted -> refused: the image's own stdout for a driven cell is not in the directory" \
  "$L1" "have no applog"

L2="$(copy_of l2)"
cp "$L2/instr/0023-m-on__s-on__b-empty.applog" "$L2/instr/0023-not-a-cell.applog"
[[ -f "$L2/instr/0023-not-a-cell.applog" ]] || harness "L2 planted nothing"
expect_refusal "L2 an applog belonging to no cell result -> refused, naming the file" \
  "$L2" "belong to no cell result in this verdict"

L3="$(copy_of l3)"
target="$L3/instr/0023-m-off__s-off__b-probe.applog"
sz_before="$(wc -c < "$target")"
printf '[broker] POST https://paper-api.alpaca.markets/v2/orders {"symbol":"AAPL","qty":1} -> 200 OK\n' >> "$target"
[[ "$(wc -c < "$target")" -gt "$sz_before" ]] || harness "L3 planted nothing"
expect_refusal "L3 the image printed a 200 OK from the broker on its own stdout -> refused" \
  "$L3" "name a pinned broker host or an instrumented wrapper"

L4="$(copy_of l4)"
target="$L4/instr/0008-m-on__s-on__b-empty.applog"
sz_before="$(wc -c < "$target")"
printf 'vault_create_secret\n' >> "$target"
[[ "$(wc -c < "$target")" -gt "$sz_before" ]] || harness "L4 planted nothing"
expect_refusal "L4 a ONE-LINE plant of just a wrapper name -> refused: the scan is not looking only for whole sentences" \
  "$L4" "name a pinned broker host or an instrumented wrapper"

# ---------------------------------------------------------------------------
# SCOPE — the machine-readable record must carry the controls on a REFUSAL too,
# not only on the pass. A reader told to prefer verdict-scope.json over the
# transcript gets nothing if the refusal path drops the field.
# ---------------------------------------------------------------------------
{
  problems=""
  [[ "$(scope "$L3" 's.status')" == "INCOMPLETE_OBSERVATION" ]] \
    || problems="${problems} status=$(scope "$L3" 's.status')"
  hits="$(scope "$L3" "s.controlEvidence.perSchema['0023'].applogScan.hits.length")"
  [[ "$hits" =~ ^[0-9]+$ && "$hits" -ge 1 ]] || problems="${problems} hits=${hits}(want >=1)"
  [[ "$(scope "$L3" "s.controlEvidence.perSchema['0023'].applogScan.satisfied")" == "false" ]] \
    || problems="${problems} applogScan-still-satisfied"
  [[ "$(scope "$E1" 's.controlEvidence.egressClassifier.present')" == "false" ]] \
    || problems="${problems} egress-present-not-false"
  [[ "$(scope "$E1" 's.controlEvidence.egressClassifier.satisfied')" == "false" ]] \
    || problems="${problems} egress-still-satisfied"
  if [[ -z "$problems" ]]; then
    ok "SCOPE verdict-scope.json carries controlEvidence on a refusal, with the failing control marked" \
       "unsatisfied and the applog hit counted (${hits})"
  else
    bad "SCOPE the machine-readable record does not carry the control outcome —${problems}"
  fi
}

missing_cases=()
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for t in "${CASES_SEEN[@]}"; do [[ "$t" == "$c" ]] && { found=1; break; }; done
  [[ "$found" -eq 1 ]] || missing_cases+=("$c")
done
if [[ "${#missing_cases[@]}" -ne 0 ]]; then
  printf '  \033[1;31mFAIL\033[0m COVERAGE these intended cases never reported: %s\n' "${missing_cases[*]}"
  fail=$(( fail + 1 ))
fi
COMPLETED=1

printf '\n  %s passed, %s failed (%s of %s intended cases reported)\n\n' \
  "$pass" "$fail" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}"
[[ "$fail" -eq 0 ]]
