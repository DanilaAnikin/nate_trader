#!/usr/bin/env bash
# ============================================================================
# k14-observer-derived.test.sh — the verdict must read the OBSERVERS, not the
#                                driver's account of them, and must not let the
#                                command line decide what the artefacts record
#
# WHAT WENT WRONG (audit findings D, B, C, E, F)
# ----------------------------------------------
# D. THE HARNESS INVERTED. `driver/verdict.mjs` collected three observers and
#    believed one. Every in-process claim — noBodyParse, noSupabaseClient,
#    noBrokerCall, noDatabaseCall, noUnexpectedNetworkCall, noAuthCall,
#    noPostgRESTCall — was decided from `results[].events`, the DRIVER'S
#    TRANSCRIPTION. The image's own log, `$OUT/instr/<schema>-<cell>.jsonl`, was
#    read for the presence of an `instrument.loaded` line and for the cell's
#    boot events, and for nothing else; its own docblock said so.
#
#    An auditor appended two lines to `instr/0023-m-off__s-off__b-probe.jsonl`
#    inside a request window — a `body.parse` and a `fetch` to
#    `paper-api.alpaca.markets` — and touched nothing else. That is not a
#    forgery: that file is written by the process under test, and finding out
#    what the process under test did is the entire purpose of this harness. The
#    verdict printed
#
#        PASS all 24 environment combinations x 2 migration generations
#        (48 combinations) …
#
#    exit 0, verdict-scope.json {"status":"PASS","hardFailures":0}, and its own
#    tally read "noBodyParse: 480 satisfied, 0 violated" and "noBrokerCall: 480
#    satisfied, 0 violated".
#
# B. 0008's twenty-four cell results filed under 0023's filenames, with
#    `schema`, `dbWitness` and `bootEvents` pasted out of the real 0023 results
#    already sitting in the directory: PASS.
#
# C. K9's R6 plus ONE more pasted field (`bootEvents`, read straight out of the
#    instrument log the check compares against): twenty-three of the twenty-four
#    certified 0023 cells carry one cell's request observations. Measured: 1
#    distinct request-observation record across 24 cells, against 24 in the
#    genuine set. PASS.
#
#    B and C both falsified the documentation as written. The README said an
#    operator must rewrite "the cell result, the gateway's log and the
#    instrument's log consistently"; verdict-scope.json's `artefact-forgery`
#    said "no forgery confined to one file survives". Both attacks touched only
#    cell-result files, using values the other two containers' logs handed them.
#
# E. `--pg-image-substituted` was argv-only. `provenance.json` recorded
#    `pgImage` and `pgImagePinned` and verdict.mjs read neither, so a run on a
#    NON-pinned postgres image re-verdicted to a full certifying PASS. Every
#    re-verification path omits the flag by construction, because run.sh passes
#    it only when run.sh itself has just substituted the image.
#
# F. Delete every trusted-runner artefact and assert `--sensor-verdict
#    TRUSTWORTHY`: PASS. verdict-scope.json did not record the sensor verdict at
#    all, so nothing downstream could notice. "An absence is only evidence from
#    a detector known to work" was enforced inside run.sh's own process — which
#    is exactly the process a re-verification does not have.
#
# WHAT THIS SUITE ASSERTS
# -----------------------
#   GREEN     the unmodified artefact set still certifies (exit 0, PASS banner)
#   MEASURED  and it did so having actually looked: verdict-scope.json must
#             record 480 gateway-defined request windows, 480 attestations
#             matched against the gateway's own copy, and a sensor verdict
#             DERIVED from the artefacts for each generation. Without this the
#             cases below are all rejection-shaped assertions whose passing
#             value is also their failure-to-run value.
#   D1        two events planted in the image's own log, nothing else touched:
#             refused, naming the disagreement, AND with noBodyParse and
#             noBrokerCall recorded VIOLATED in the tally — the exact inversion
#             of the reproduction above.
#   D2        an event present only in the driver's transcription: refused,
#             naming the direction.
#   B1        the cross-generation copy: refused.
#   C1        one cell's observations across twenty-three cells: refused.
#   E1        provenance records a substituted database image: NOT CERTIFYING,
#             with no PASS banner, WITHOUT --pg-image-substituted being passed.
#   E2        provenance's own pinned-ness boolean contradicts its own digest:
#             refused as a control failure.
#   F1        every trusted-runner artefact deleted, TRUSTWORTHY asserted on the
#             command line: refused, naming the missing report, and
#             verdict-scope.json records that the verdict was not derivable.
#   F2        the runner's SEALED report says UNTRUSTWORTHY and argv says
#             TRUSTWORTHY: refused, naming the contradiction.
#
# WHAT THE NEXT AUDIT BROKE, AND WHAT THESE CASES HOLD (ADV-1, ADV-3, ADV-4)
# -------------------------------------------------------------------------
# ADV-1. D's closure decided the in-process claims from the image's own log,
#    but only INSIDE the gateway's request windows — and those windows cover
#    about 11% of a cell's gateway timeline. Measured on the certifying set:
#    597 of 597 instrument events fall outside every request window, because
#    the driver's per-cell tag sequence is #witness, #1…#10, #idle and almost
#    all of the wall clock is the bookends. The auditor moved the D attack
#    742 ms past the last window and got the full PASS back, then did it
#    byte-faithfully — dns.lookup, socket.connect and a POST fetch to
#    paper-api.alpaca.markets in exactly the {seq,t,kind,detail,stack} shape
#    instrument.cjs emit() writes, with a Timeout._onTimeout stack. PASS, exit
#    0, "noBrokerCall: 480 satisfied, 0 violated". No forgery: the instrument
#    patches fetch/socket/tls/dns process-wide at module load.
#
# ADV-3. F's closure was defeated by RETYPING the file: delete every
#    trusted-runner artefact and write eight lines of plain text in the
#    documented shape, and the report parsed to TRUSTWORTHY with
#    manifestVerified true. The counter cross-check is real — wrong phase
#    counts ARE refused — so the forger typed the right ones.
#
# ADV-4. Every pre-verdict refusal skipped the scope write, so
#    verdict-scope.json still said PASS after the refusal (measured 6m46s
#    stale) while the scope statement told readers to PREFER that file.
#
#   ADV1      three real broker events 742 ms past the last window: refused as
#             UNATTRIBUTED, with the count in verdict-scope.json.
#   ADV1b     an event reusing a boot seq — the escape a `seq > max(bootSeq)`
#             test would have left open: refused.
#   ADV1c     an instrument log for a cell no result claims: refused.
#   ADV1d     an outbound broker call DECLARED in the boot snapshot — fully
#             attributed, and no claim is decided from a boot event: refused.
#   ADV3a     the runner state deleted and eight lines retyped: refused,
#             deriving no verdict at all from an unsealed report.
#   ADV3b     the sealed body and the readable text file disagree: the SEALED
#             body decides, and the divergence is refused.
#   ADV3c     the challenge ledger's line MACs do not verify: refused.
#   ADV4      a pre-verdict refusal over a directory that had passed:
#             verdict-scope.json is the refusal, carrying its reason.
#
# WHAT ROUND 5 BROKE IN THE ABOVE, AND WHAT THESE CASES HOLD
# ----------------------------------------------------------
# All three were full certifying PASSes over artefacts recording a real
# violation, and all three are the same shape: a check narrower than the thing
# it checks, failing OPEN on the case nobody enumerated.
#
# R5-A. ADV1d's boot judge was a DENY-list of four network kinds while
#    instrument.cjs emits eight, and it decided from detail.hostClass, a field
#    whoever writes the record chooses. A POST to paper-api.alpaca.markets
#    recorded as node:https.request certified; so did the same call as a plain
#    fetch relabelled hostClass=loopback.
# R5-B. ADV-1 accounted for every line of the IMAGE's log and left the
#    GATEWAY's read only as sinkMap.get(<cell>#<n>). A GET /rest/v1/accounts
#    and a GET /auth/v1/user under one cell's #idle tag — no instrument event,
#    no cell result touched — certified.
# R5-C. observers.mjs eventKey and observation.mjs eventDigest_16 both keyed on
#    (seq, t, kind), leaving each event's detail — the host, the port, the path
#    class — bound by nothing. Rewriting only the detail in both
#    instrument-side copies turned noBrokerCall=violated into a PASS.
#
#   R5A       a boot-snapshot broker call under EVERY outbound kind claims.mjs
#             exports (looped, not hand-picked), plus a kind nobody enumerated
#             so the allow-list's fall-through is exercised: all refused.
#   R5Ab      the same call labelling itself hostClass=loopback: still refused;
#             the boot judge reads no self-reported classification.
#   R5B       a data-plane call the gateway logged under #idle and under
#             #witness: refused — and relabelling it "harness" does not buy the
#             control-traffic exemption, which is derived from the path.
#   R5Bb      POSITIVE CONTROL for R5B: the identical pair under a REQUEST tag
#             is refused as a FINDING, so R5B is discriminating.
#   R5C       the honest artefacts of a real broker call (instrument log,
#             transcription and the gateway's attestation all consistent) are
#             refused; then rewriting ONLY the detail is refused too.
#
# WHAT ROUND 7 BROKE, AND WHAT THESE CASES HOLD
# ---------------------------------------------
# Both were full certifying PASSes over an artefact directory that legibly
# records a containment violation, and the first cost ONE BYTE.
#
# R7-1. `observers.mjs` parseJsonl dropped an unparseable line in a bare catch,
#    feeding BOTH observers, and verdict.mjs repeated the silent catch twice
#    more. Nothing compared the file's non-empty line count with the parsed
#    event count. A byte-faithful broker fetch 742 ms into #idle is refused; the
#    same record with one trailing comma certified (logEvents 298 over a
#    299-line file), and so did the same record with its final "}" replaced by a
#    SPACE — identical length, identical line count. The gateway's log broke
#    identically (gatewayRows 555 over 556). No adversary is needed:
#    instrument.cjs appends each event separately and run.sh SIGKILLs the app
#    container, so a truncated line is a normal outcome that was being discarded.
# R7-2. `eventIdentity` covers seq/t/kind/detail and excludes `stack` on
#    purpose, but nothing refused an UNKNOWN top-level key — so the exclusion
#    was really "everything that is not one of four fields". A "brokerCall"
#    object appended to an existing boot line left every published count
#    identical and certified.
# R7-1S. THE SUITE'S OWN SHARE OF R7-1 ("R7-3" is a different round-7 item, the
#    unread instr/*.applog; this one has no separate number). MEASURED does catch
#    the trailing-comma variant,
#    by comparing logEvents with `grep -c .` — and then the suite died rc=2 in
#    the next planter, because every helper read JSONL with a throwing
#    `.map((l) => JSON.parse(l))`. Twenty-one cases never reported.
#
#   R7A       the one-byte break in the IMAGE's log: rc=3 naming file and line,
#             with a positive control planting the byte-identical WELL-FORMED
#             record, which must still refuse as UNATTRIBUTED.
#   R7B       the same in the GATEWAY's log, with the same positive control.
#   R7C       an unrecognised top-level key on a boot line: refused, naming
#             file, line and key — and MEASURED as invisible to R7A/R7B's line
#             accounting, since every count is unchanged.
#   R7Cb      the same key in the driver's transcription: refused.
#   R7H       a corrupt --full-out is REPORTED by this suite rather than fatal
#             to it, and no helper in this file throws on a line any more.
#
# Every case runs the SHIPPED verdict over artefacts produced by a real run. The
# directory is copied before it is mutated, so the input evidence is never
# modified in place.
#
# Usage:
#   k14-observer-derived.test.sh --full-out DIR [--probe-user-id ID]
#
#   --full-out  an artefact directory from a run that drove all 24 cells on
#               BOTH generations (run.sh --schema both).
#
# Exit: 0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `RC` is REASSIGNED by verdict() below to the verdict's exit code, so it is the
# harness root only until the first case runs. CANARY_ROOT is the stable name;
# anything resolved after a case has run must use it. (Round-5 audit: two new
# cases needed the root mid-suite and would have silently taken "0" or "3".)
CANARY_ROOT="$(cd "${HERE}/.." && pwd)"
RC="$CANARY_ROOT"
VERDICT="${CANARY_ROOT}/driver/verdict.mjs"
MANIFEST="${CANARY_ROOT}/expected/request-manifest.json"

# ---------------------------------------------------------------------------
# ROUND-7 AUDIT (R7-1). EVERY PLANTING HELPER READS JSONL THROUGH ONE MODULE
# THAT CANNOT THROW ON THE FILE'S CONTENTS.
#
# They each used to do `.split("\n").filter(Boolean).map((l) => JSON.parse(l))`,
# so an unparseable line ANYWHERE in --full-out killed the first planter that
# touched that file, `harness` exited 2, and the suite stopped after two cases —
# even though MEASURED had just correctly gone red on it. The operator was told
# "D1 could not plant the events", which is not the diagnosis.
#
# An unparseable line is a NORMAL-OPERATION outcome (instrument.cjs appends each
# event with its own fs.appendFileSync; run.sh SIGKILLs the app container at the
# end of every cell), so the suite has to survive one and REPORT it, not die of
# it. tests/k14-jsonl.cjs carries on, writes a loud note to stderr, and never
# repairs the file behind the case's back. Case R7H below is the control that
# this is actually so.
# ---------------------------------------------------------------------------
export K14_JSONL="${HERE}/k14-jsonl.cjs"
[[ -f "$K14_JSONL" ]] || { printf 'k14: %s is missing\n' "$K14_JSONL" >&2; exit 2; }

FULL_OUT=""
PROBE_USER_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full-out)      FULL_OUT="${2:?}";      shift 2 ;;
    --probe-user-id) PROBE_USER_ID="${2:?}"; shift 2 ;;
    *) printf 'k14: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$FULL_OUT" ]] || { printf 'k14: --full-out is required\n' >&2; exit 2; }
[[ -d "$FULL_OUT/cells" ]] || { printf 'k14: %s has no cells/ directory\n' "$FULL_OUT" >&2; exit 2; }

for s in 0008 0023; do
  n="$(find "$FULL_OUT/cells" -name "result-${s}-*.json" | wc -l)"
  [[ "$n" == "24" ]] || {
    printf 'k14: --full-out has %s cell files for generation %s, not 24.\n' "$n" "$s" >&2
    printf 'k14: B1 is a CROSS-GENERATION attack; a directory with one generation cannot exercise it,\n' >&2
    printf 'k14: and a skipped attack is not a passed one.\n' >&2
    exit 2
  }
done

# --- the fixture must carry the CURRENT request attestation (round-5, R5C) ---
# `observation.mjs` v2 folds a canonical digest of each event's `detail` into
# the attested identity; v1 hashed only [seq, t, kind], and rewriting the detail
# alone certified. There is deliberately no compatibility shim, so a directory
# from before the bump refuses on all 480 requests. Say that HERE, once, in
# those words — otherwise GREEN goes red with 480 digest mismatches and the
# reader has to work out that the fixture, not the harness, is the stale thing.
# This is NOT forward-portable: recomputing the attestations from the cell
# results would make the second observer agree by construction, which is the
# exact forgery the attestation exists to make expensive.
WANT_OBS_V="$(node -e '
  import("'"${CANARY_ROOT}"'/driver/observation.mjs")
    .then((m) => process.stdout.write(String(m.OBSERVATION_VERSION)));
')"
[[ -n "$WANT_OBS_V" ]] || { printf 'k14: could not read OBSERVATION_VERSION\n' >&2; exit 2; }
for s in 0008 0023; do
  got="$(node -e '
const J = require(process.env.K14_JSONL);
for (const e of J.read(process.argv[1]).rows) {
  if (e.observation && e.observation.v !== undefined) { process.stdout.write(String(e.observation.v)); break; }
}
' "$FULL_OUT/sink-${s}.jsonl")"
  [[ -n "$got" ]] || { printf 'k14: %s carries no request attestation at all\n' "$FULL_OUT/sink-${s}.jsonl" >&2; exit 2; }
  [[ "$got" == "$WANT_OBS_V" ]] || {
    printf 'k14: %s carries observation version %s; this checkout derives version %s.\n' \
      "$FULL_OUT/sink-${s}.jsonl" "$got" "$WANT_OBS_V" >&2
    printf 'k14: v1 hashed only [seq,t,kind] per event, so an event DETAIL rewritten in both\n' >&2
    printf 'k14: instrument-side copies certified. This directory predates that binding and cannot\n' >&2
    printf 'k14: be forward-ported without forging the gateway agreement. Drive a new one:\n' >&2
    printf 'k14:   ./run.sh --image <ref> --source <dir> --target-root <dir> --target-sha <sha> --schema both\n' >&2
    exit 2
  }
done

# --- fixture forward-port (ADV-3) -------------------------------------------
# The certifying verdict now derives the sensor verdict from the report body
# verify-sensor.sh seals with the per-run key. A directory from an earlier
# run.sh has the key but no seal, so GREEN would refuse for a reason that is
# about the fixture's age. `seal-legacy-report.mjs` writes what the runner
# would have written, from that run's own report, under that run's own key —
# and refuses when the key is gone, which is the ADV-3 attack itself.
for st in "$FULL_OUT"/sensor-state-*; do
  [[ -d "$st" ]] || continue
  if [[ ! -f "${st}/report.hmac" ]]; then
    printf '\033[1;33mnote\033[0m %s predates the ADV-3 seal; sealing with its own run key\n' "$FULL_OUT"
    node "${HERE}/seal-legacy-report.mjs" "$FULL_OUT" \
      || { printf 'k14: %s cannot be forward-ported\n' "$FULL_OUT" >&2; exit 2; }
    break
  fi
done

if [[ -z "$PROBE_USER_ID" ]]; then
  PROBE_USER_ID="$(node "${RC}/driver/keys.mjs" --print-shell \
    | sed -n 's/^CANARY_PROBE_USER_ID=//p')"
fi
[[ -n "$PROBE_USER_ID" ]] || { printf 'k14: could not determine the probe user id\n' >&2; exit 2; }

WORK="$(mktemp -d /tmp/nt-k14-XXXXXX)"

CASES_INTENDED=(GREEN MEASURED D1 D2 B1 C1 E1 E2 F1 F2
                ADV1 ADV1b ADV1c ADV1d ADV3a ADV3b ADV3c ADV4
                R5A R5Ab R5B R5Bb R5C
                R7A R7B R7C R7Cb R7H)
CASES_SEEN=()
COMPLETED=0
cleanup() {
  local rc=$?
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk14 harness: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'k14 harness: an unfinished suite is not a passing one.\n' >&2
    [[ "$rc" -eq 0 ]] && exit 2
  fi
  exit "$rc"
}
trap cleanup EXIT

pass=0; fail=0
seen() { CASES_SEEN+=("${1%% *}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }
harness() { printf 'k14 harness: %s\n' "$*" >&2; exit 2; }

# --- the PASS banner is coloured, so a plain grep never matches --------------
#
# NOT `sed … | grep -q`. `grep -q` exits at its FIRST match and closes the pipe;
# sed then dies of SIGPIPE with status 141, and under `set -o pipefail` the
# PIPELINE's status is 141 even though grep matched. This suite was written that
# way and was measurably flaky. MEASURED on an 85492-byte refusal transcript
# whose needle is present: `sed … | grep -qF` reported it ABSENT in 32 of 200
# trials, strip-to-a-file-then-grep in 0 of 200. It first showed up as two runs
# over the same artefact directory going red on three different cases between
# them, none of them a real failure — and the shape is worse than a flake,
# because the same mistake in a "this string must be ABSENT" assertion (k9 and
# k4 both had one) makes it pass for the one reason it must never pass for. So
# the transcript is stripped ONCE into a plain file and every matcher greps that
# file directly. No pipeline, nothing to break.
strip_to_file() { sed -e 's/\x1b\[[0-9;]*m//g' "$1" > "$2"; }
has_pass_banner() {  # a PLAIN (already stripped) file
  grep -qE '^PASS all [0-9]+ environment combinations' "$1"
}
# POSITIVE CONTROL for the detector, before any assertion depends on it — run
# through the same strip-then-grep path the real cases use.
printf '\033[1;32mPASS\033[0m all 24 environment combinations x 2 migration generations\n' > "$WORK/.banner-raw"
strip_to_file "$WORK/.banner-raw" "$WORK/.banner-probe"
has_pass_banner "$WORK/.banner-probe" \
  || harness "the PASS-banner detector cannot find a planted banner; every banner assertion would be vacuous"
printf 'PARTIAL 24 of 48 environment/schema combinations were driven\n' > "$WORK/.banner-raw"
strip_to_file "$WORK/.banner-raw" "$WORK/.banner-probe"
! has_pass_banner "$WORK/.banner-probe" \
  || harness "the PASS-banner detector matches a PARTIAL line"
rm -f "$WORK/.banner-probe" "$WORK/.banner-raw"

# --- the transcript is captured to a FILE, never through a pipe --------------
# k13 measured captures of one refusal through $( … 2>&1 ) at anywhere between
# 92082 and 330509 bytes. Every reason assertion below would be satisfied by the
# loss rather than by the reason.
sensor_hits() {  # out-dir, schema -> the number run.sh would have declared
  local f="$1/sensor-report-$2.txt" mid post
  if [[ -f "$f" ]]; then
    mid="$(sed -n 's/^SENSOR_PHASE=mid|events=\([0-9]*\)$/\1/p'  "$f" | head -1)"
    post="$(sed -n 's/^SENSOR_PHASE=post|events=\([0-9]*\)$/\1/p' "$f" | head -1)"
    if [[ -n "$mid" && -n "$post" ]]; then printf '%s' $(( mid + post )); return 0; fi
  fi
  printf '0'
}

LOG=""      # the raw transcript
FLAT=""     # the same transcript with the colours removed, which every matcher reads
verdict() {  # out-dir [extra args…] -> LOG/FLAT (files), RC
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

scope() {  # out-dir, jq-ish node expression over the parsed scope object
  node -e '
    const fs = require("node:fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const v = (new Function("s", `return (${process.argv[2]});`))(j);
    process.stdout.write(String(v));
  ' "$1/verdict-scope.json" "$2"
}

says() {  # the stripped transcript contains this exact substring
  grep -qF -- "$1" "$FLAT"
}

copy_of() {  # label -> a fresh copy of --full-out at $WORK/<label>
  local d="$WORK/$1"
  rm -rf "$d"
  cp -a "$FULL_OUT" "$d"
  printf '%s' "$d"
}

printf '\n== K14 the in-process claims must come from the observers, and the artefacts must decide ==\n\n'

# ---------------------------------------------------------------------------
# GREEN — the positive control. Everything below is a rejection-shaped
# assertion; without this one, a verdict that refused EVERYTHING would score a
# perfect suite.
# ---------------------------------------------------------------------------
BASE="$(copy_of base)"
verdict "$BASE"
if [[ "$RC" -eq 0 ]] && has_pass_banner "$FLAT" && [[ "$(scope "$BASE" 's.status')" == "PASS" ]]; then
  ok "GREEN the unmodified 48-cell set still certifies (rc=0, PASS banner, scope PASS)"
else
  bad "GREEN the unmodified 48-cell set no longer certifies (rc=$RC, status $(scope "$BASE" 's.status' 2>/dev/null || echo '?'))"
  grep -A20 'INCOMPLETE OBSERVATION' "$FLAT" | head -24 | sed 's/^/       /' || true
fi

# ---------------------------------------------------------------------------
# MEASURED — and it looked. An empty-set assertion whose passing value is also
# its failure-to-run value needs a positive control that fails loudly rather
# than being skipped alongside it, so the counters that prove the observer
# machinery executed are asserted as NUMBERS.
# ---------------------------------------------------------------------------
{
  w=0; a=0; problems=""
  for s in 0008 0023; do
    w=$(( w + $(scope "$BASE" "s.claimEvidence['$s'].windows") ))
    a=$(( a + $(scope "$BASE" "s.claimEvidence['$s'].attestationsMatched") ))
    [[ "$(scope "$BASE" "s.claimEvidence['$s'].derivedFrom")" == "observer files" ]] \
      || problems="${problems} ${s}:claims-not-observer-derived"
    [[ "$(scope "$BASE" "s.sensorVerdict['$s'].derived")" == "TRUSTWORTHY" ]] \
      || problems="${problems} ${s}:sensor-verdict-not-derived"
    [[ "$(scope "$BASE" "s.sensorVerdict['$s'].derivedFrom")" == "sensor-report-${s}.txt" ]] \
      || problems="${problems} ${s}:sensor-verdict-not-from-the-report"
  done
  [[ "$w" == "480" ]] || problems="${problems} windows=${w}(want 480)"
  [[ "$a" == "480" ]] || problems="${problems} attestationsMatched=${a}(want 480)"
  [[ "$(scope "$BASE" 's.pgImagePinned')" == "true" ]] || problems="${problems} pgImagePinned-not-recorded"

  # ADV-1: the attribution pass must have looked at EVERY line of EVERY
  # instrument log, not merely reported a zero. The expected count is computed
  # from the directory itself, because it differs between runs; a hard-coded
  # figure would turn this into a measurement of one fixture.
  for s in 0008 0023; do
    want=0
    for f in "$FULL_OUT"/instr/"${s}"-*.jsonl; do
      [[ -f "$f" ]] || continue
      want=$(( want + $(grep -c . "$f") ))
    done
    [[ "$want" -gt 0 ]] || harness "no instrument log lines for ${s}; the attribution assertion would be vacuous"
    got="$(scope "$BASE" "s.claimEvidence['$s'].logEvents")"
    att="$(scope "$BASE" "s.claimEvidence['$s'].eventsAttributedToBoot")"
    un="$(scope "$BASE"  "s.claimEvidence['$s'].eventsUnattributed")"
    [[ "$got" == "$want" ]] || problems="${problems} ${s}:logEvents=${got}(the directory holds ${want})"
    [[ "$att" == "$want" ]] || problems="${problems} ${s}:eventsAttributedToBoot=${att}(want ${want})"
    [[ "$un"  == "0"     ]] || problems="${problems} ${s}:eventsUnattributed=${un}(want 0)"
    # R7-1: the DENOMINATOR must be published, not just the numerator. Until
    # round 7 `logEvents` was counted from the PARSED set — after parseJsonl had
    # silently dropped every line that did not parse — so it could not disagree
    # with itself, and one byte appended to a planted broker event turned ADV1's
    # refusal into a certifying PASS. `rawLines` is the number `grep -c .`
    # prints, so the two are now comparable by a reader who runs neither.
    rl="$(scope "$BASE" "s.claimEvidence['$s'].rawLines")"
    lu="$(scope "$BASE" "s.claimEvidence['$s'].linesUnparseable")"
    ilu="$(scope "$BASE" "s.claimEvidence['$s'].instrLinesUnparseable")"
    [[ "$rl" == "$want" ]] || problems="${problems} ${s}:rawLines=${rl}(the directory holds ${want})"
    [[ "$lu" == "0"     ]] || problems="${problems} ${s}:linesUnparseable=${lu}(want 0)"
    [[ "$ilu" == "0"    ]] || problems="${problems} ${s}:instrLinesUnparseable=${ilu}(want 0)"
    # R7-2: and the allow-list over each record's top-level keys must have run.
    fk="$(scope "$BASE" "s.claimEvidence['$s'].eventsWithForeignKeys")"
    [[ "$fk" == "0" ]] || problems="${problems} ${s}:eventsWithForeignKeys=${fk}(want 0)"
    br="$(scope "$BASE"  "s.claimEvidence['$s'].bootEventsRefused")"
    [[ "$br"  == "0"     ]] || problems="${problems} ${s}:bootEventsRefused=${br}(want 0)"
    # …and the boot bucket must be PUBLISHED, not merely counted: a reader has
    # to be able to see what the image did before the first request.
    bk="$(scope "$BASE" "Object.keys(s.claimEvidence['$s'].bootEventKinds).sort().join(',')")"
    [[ "$bk" == "env.read,instrument.coverage,instrument.loaded,instrument.ready" ]] \
      || problems="${problems} ${s}:bootEventKinds=${bk}"
    # ADV-3: the sensor verdict must have come from a SEALED report, and the
    # runner's own manifest and ledger must have re-verified under the key.
    [[ "$(scope "$BASE" "s.sensorVerdict['$s'].sealed")" == "true" ]] \
      || problems="${problems} ${s}:sensor-report-not-sealed"
    [[ "$(scope "$BASE" "s.sensorVerdict['$s'].manifestHmacVerified")" == "true" ]] \
      || problems="${problems} ${s}:manifest-hmac-not-verified"
    lv="$(scope "$BASE" "s.sensorVerdict['$s'].ledgerLinesVerified")"
    ll="$(scope "$BASE" "s.sensorVerdict['$s'].ledgerLines")"
    [[ "$ll" -gt 0 && "$lv" == "$ll" ]] \
      || problems="${problems} ${s}:ledgerLinesVerified=${lv}/${ll}"
    # R5B: the GATEWAY's log must also have been accounted for line by line,
    # against a count taken from the directory rather than a remembered number.
    gwant="$(grep -c . "$FULL_OUT/sink-${s}.jsonl")"
    [[ "$gwant" -gt 0 ]] || harness "sink-${s}.jsonl is empty; the gateway accounting assertion would be vacuous"
    grows="$(scope "$BASE" "s.claimEvidence['$s'].gatewayRows")"
    gharn="$(scope "$BASE" "s.claimEvidence['$s'].gatewayHarnessRows")"
    gun="$(scope "$BASE"   "s.claimEvidence['$s'].gatewayRowsUnaccounted")"
    [[ "$grows" == "$gwant" ]] || problems="${problems} ${s}:gatewayRows=${grows}(the directory holds ${gwant})"
    # R7-1, the same denominator for the second observer: `gatewayRows` was
    # also counted from the parsed set, by three separate readers each with its
    # own silent catch, and one trailing comma on a planted /rest/v1/accounts
    # row certified with gatewayRows 555 over a 556-line file.
    grw="$(scope "$BASE" "s.claimEvidence['$s'].gatewayRawLines")"
    glu="$(scope "$BASE" "s.claimEvidence['$s'].gatewayLinesUnparseable")"
    [[ "$grw" == "$gwant" ]] || problems="${problems} ${s}:gatewayRawLines=${grw}(the directory holds ${gwant})"
    [[ "$glu" == "0"      ]] || problems="${problems} ${s}:gatewayLinesUnparseable=${glu}(want 0)"
    [[ "$gharn" == "$gwant" ]] || problems="${problems} ${s}:gatewayHarnessRows=${gharn}(want ${gwant}; a frozen run makes no data-plane call)"
    [[ "$gun"   == "0"      ]] || problems="${problems} ${s}:gatewayRowsUnaccounted=${gun}(want 0)"
    gml="$(scope "$BASE" "s.claimEvidence['$s'].gatewayRowsMislabelled")"
    [[ "$gml"   == "0"      ]] || problems="${problems} ${s}:gatewayRowsMislabelled=${gml}(want 0)"
    # R5C: the attestation this directory carries must be the version that
    # binds each event's detail. A v1 directory cannot certify, and a silent
    # acceptance of one would make this whole case vacuous.
    ov="$(scope "$BASE" "s.claimEvidence['$s'].observationVersionsSeen.join(',')")"
    [[ -z "$ov" ]] || problems="${problems} ${s}:observationVersionsSeen=${ov}(want none: every attestation at the current version)"
  done
  if [[ -z "$problems" ]]; then
    ok "MEASURED the PASS was reached having read 480 gateway-defined windows, matched 480 request"
    printf '       observations against the copy the gateway wrote, ACCOUNTED FOR every line of every instrument\n'
    printf '       log, and verified the sealed sensor report, its manifest MAC and every ledger line MAC\n'
  else
    bad "MEASURED the PASS was reached without the new evidence actually being taken:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# D1 — the reproduction, inverted. Two events appended to the IMAGE'S OWN LOG
# inside a request window; no cell result is touched.
# ---------------------------------------------------------------------------
# The planter is a FUNCTION because case R7H calls it a second time, over a
# copy whose instrument log carries an unparseable line, to prove that a corrupt
# --full-out no longer kills the suite in its first planter (round-7 audit).
plant_two_in_window() {   # dir
  node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir] = process.argv.slice(1);
const CELL = "m-off__s-off__b-probe", S = "0023", TAG = `${CELL}#5`;
// The window comes from the gateway, exactly as verdict.mjs takes it.
const runs = [];
for (const e of J.read(`${dir}/sink-${S}.jsonl`).rows) {
  if (typeof e.cell === "string" && e.cell !== "(unset)" &&
      (!runs.length || runs[runs.length - 1].tag !== e.cell)) runs.push({ tag: e.cell, t: e.t });
}
const i = runs.findIndex((r) => r.tag === TAG);
if (i < 0 || i + 1 >= runs.length) { console.error("k14: no bounded window for " + TAG); process.exit(2); }
const mid = Math.floor((runs[i].t + runs[i + 1].t) / 2);
const p = `${dir}/instr/${S}-${CELL}.jsonl`;
const evs = J.read(p).rows;
const m = Math.max(...evs.map((e) => e.seq));
// BOTH at the window midpoint: a narrow window must not be able to push the
// second event past the terminator and turn a two-event plant into a one-event
// one, which would make the count assertion below a measurement of the clock.
fs.appendFileSync(p,
  JSON.stringify({ seq: m + 1, t: mid, kind: "body.parse", detail: { method: "json" } }) + "\n" +
  JSON.stringify({ seq: m + 2, t: mid, kind: "fetch",
                   detail: { hostClass: "broker", host: "paper-api.alpaca.markets" } }) + "\n");
' "$@"
}

D1="$(copy_of d1)"
plant_two_in_window "$D1" || harness "D1 could not plant the events"
verdict "$D1"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "the IMAGE'S OWN LOG" || problems="${problems} no-disagreement-message"
  says "event(s) in this request's window that the cell result does not report" \
    || problems="${problems} no-direction-in-the-message"
  says "paper-api.alpaca.markets" || problems="${problems} the-message-does-not-name-the-host"
  # THE INVERSION: the claims themselves must now be decided from that file.
  nb="$(scope "$D1" 's.claimStatus.noBodyParse.violated')"
  nk="$(scope "$D1" 's.claimStatus.noBrokerCall.violated')"
  [[ "$nb" == "1" ]] || problems="${problems} noBodyParse.violated=${nb}(want 1)"
  [[ "$nk" == "1" ]] || problems="${problems} noBrokerCall.violated=${nk}(want 1)"
  oo="$(scope "$D1" "s.claimEvidence['0023'].eventsOnlyInObserverLog")"
  [[ "$oo" == "2" ]] || problems="${problems} eventsOnlyInObserverLog=${oo}(want 2)"
  if [[ -z "$problems" ]]; then
    ok "D1 two events in the image's own log -> refused (rc=$RC), and noBodyParse/noBrokerCall are"
    printf '       recorded VIOLATED rather than "480 satisfied, 0 violated"\n'
  else
    bad "D1 the planted events did not decide the claims:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# D2 — the other direction: an event the driver reports that the image's own
# log does not carry. A transcription is not evidence just because it is
# richer than the observer.
# ---------------------------------------------------------------------------
D2="$(copy_of d2)"
node -e '
const fs = require("node:fs");
const [dir] = process.argv.slice(1);
const f = `${dir}/cells/result-0023-m-on__s-on__b-empty.json`;
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.results[3].events.push({ seq: 9001, t: 1, kind: "fetch",
  detail: { hostClass: "supabase-sink", host: "nt-canary-sink" } });
fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$D2" || harness "D2 could not plant the transcription-only event"
verdict "$D2"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "absent from the image's own log" || problems="${problems} no-message-about-the-missing-event"
  ot="$(scope "$D2" "s.claimEvidence['0023'].eventsOnlyInTranscription")"
  [[ "$ot" == "1" ]] || problems="${problems} eventsOnlyInTranscription=${ot}(want 1)"
  if [[ -z "$problems" ]]; then
    ok "D2 an event only the driver reports -> refused (rc=$RC), naming the direction"
  else
    bad "D2 a transcription richer than the observer was accepted:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# B1 — 0008's twenty-four results filed under 0023's names, with schema,
# dbWitness and bootEvents pasted from files already in the directory.
# ---------------------------------------------------------------------------
B1="$(copy_of b1)"
node -e '
const fs = require("node:fs"), path = require("node:path");
const [dir] = process.argv.slice(1);
const cells = path.join(dir, "cells");
for (const f of fs.readdirSync(cells).filter((f) => f.startsWith("result-0008-"))) {
  const target = path.join(cells, f.replace("result-0008-", "result-0023-"));
  const real = JSON.parse(fs.readFileSync(target, "utf8"));
  const j = JSON.parse(fs.readFileSync(path.join(cells, f), "utf8"));
  j.schema = "0023";
  j.dbWitness = real.dbWitness;
  j.bootEvents = real.bootEvents;
  fs.writeFileSync(target, JSON.stringify(j, null, 2));
}
' "$B1" || harness "B1 could not build the cross-generation copy"
verdict "$B1"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "does not describe the request the gateway witnessed" \
    || problems="${problems} the-gateway-copy-was-not-consulted"
  if [[ -z "$problems" ]]; then
    ok "B1 one generation's results filed as the other's -> refused (rc=$RC): the gateway's own copy"
    printf '       of each request observation contradicts them\n'
  else
    bad "B1 the cross-generation copy was still certified:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# C1 — one cell's observations across twenty-three cells, with every field the
# identity checks read repaired from the manifest and from the instrument logs.
# ---------------------------------------------------------------------------
C1="$(copy_of c1)"
node -e '
const fs = require("node:fs"), path = require("node:path");
const J = require(process.env.K14_JSONL);
const [dir, manifestPath, probe] = process.argv.slice(1);
const MAN = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const cells = path.join(dir, "cells");
const SRC = path.join(cells, "result-0023-m-on__s-on__b-empty.json");
const src = JSON.parse(fs.readFileSync(SRC, "utf8"));
const boot = (cid) => J.read(path.join(dir, "instr", `0023-${cid}.jsonl`)).rows;
for (const f of fs.readdirSync(cells).filter((f) => f.startsWith("result-0023-"))) {
  const p = path.join(cells, f);
  if (p === SRC) continue;
  const cid = f.slice("result-0023-".length, -".json".length);
  const j = JSON.parse(JSON.stringify(src));
  j.cell = cid;
  for (const r of j.results) r.cellTag = `${cid}#${r.id}`;
  j.instrumentEnv.raw_freeze_flags = Object.fromEntries(
    Object.entries(MAN.cellEnv[cid]).map(([k, v]) => [k, v === "__PROBE_USER_ID__" ? probe : v]));
  j.bootEvents = boot(cid);
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
}
' "$C1" "$MANIFEST" "$PROBE_USER_ID" || harness "C1 could not build the pasted-observation set"
verdict "$C1"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "does not describe the request the gateway witnessed" \
    || problems="${problems} the-gateway-copy-was-not-consulted"
  says "a request observation filed under a cell it did not happen in" \
    || problems="${problems} the-timings-were-not-compared-with-the-window"
  if [[ -z "$problems" ]]; then
    ok "C1 one cell's observations across twenty-three -> refused (rc=$RC), on both the gateway's copy"
    printf '       and the request timings against the gateway'"'"'s window\n'
  else
    bad "C1 twenty-three pasted cells were still certified:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# E1 — a run on a substituted database image, re-verdicted the way every
# re-verification path does: WITHOUT --pg-image-substituted.
# ---------------------------------------------------------------------------
E1="$(copy_of e1)"
node -e '
const fs = require("node:fs");
const p = `${process.argv[1]}/provenance.json`;
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.pgImage = "postgres:17-alpine";
j.pgImagePinned = false;
fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$E1" || harness "E1 could not rewrite the provenance"
verdict "$E1"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  [[ "$(scope "$E1" 's.status')" == "NOT_CERTIFYING" ]] \
    || problems="${problems} status=$(scope "$E1" 's.status')(want NOT_CERTIFYING)"
  says "not the pinned production digest" || problems="${problems} no-reason-naming-the-image"
  says "postgres:17-alpine" || problems="${problems} the-reason-does-not-name-the-substitute"
  [[ "$(scope "$E1" 's.pgImagePinned')" == "false" ]] || problems="${problems} pgImagePinned-not-recorded-false"
  if [[ -z "$problems" ]]; then
    ok "E1 provenance records a substituted database image -> NOT CERTIFYING (rc=$RC) with no flag passed"
  else
    bad "E1 a run on a non-pinned image still certified:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# E2 — the run's own boolean says pinned while its own digest says otherwise.
# A statement a run makes about itself is not evidence; the digest is.
# ---------------------------------------------------------------------------
E2="$(copy_of e2)"
node -e '
const fs = require("node:fs");
const p = `${process.argv[1]}/provenance.json`;
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.pgImage = "postgres:17-alpine";
j.pgImagePinned = true;
fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$E2" || harness "E2 could not rewrite the provenance"
verdict "$E2"
{
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "PROVENANCE_CONTRADICTED" || problems="${problems} not-reported-as-a-contradiction"
  says "pgImagePinned=true" || problems="${problems} the-message-does-not-quote-the-boolean"
  if [[ -z "$problems" ]]; then
    ok "E2 a provenance record whose pinned-ness boolean contradicts its own digest -> control failure (rc=$RC)"
  else
    bad "E2 the run's own boolean was believed over its own digest:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# F1 — every trusted-runner artefact deleted, TRUSTWORTHY asserted on the
# command line.
# ---------------------------------------------------------------------------
F1="$(copy_of f1)"
rm -f  "$F1"/sensor-*.txt
rm -rf "$F1"/sensor-state-*
verdict "$F1"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "no trusted-runner sensor report in the artefacts" \
    || problems="${problems} no-message-about-the-missing-report"
  says "an absence is only evidence from a detector KNOWN to work" \
    || problems="${problems} the-message-does-not-say-why"
  # The reporting half of F: verdict-scope.json used to record nothing at all
  # about the sensor, so nothing downstream could have noticed either.
  [[ "$(scope "$F1" "s.sensorVerdict['0023'].derived")" == "null" ]] \
    || problems="${problems} scope-does-not-record-the-derived-verdict-as-absent"
  [[ "$(scope "$F1" "s.sensorVerdict['0023'].declared")" == "TRUSTWORTHY" ]] \
    || problems="${problems} scope-does-not-record-what-argv-asserted"
  if [[ -z "$problems" ]]; then
    ok "F1 every trusted-runner artefact deleted -> refused (rc=$RC), and verdict-scope.json records"
    printf '       that TRUSTWORTHY was asserted on the command line and derived from nothing\n'
  else
    bad "F1 an asserted sensor verdict still bought a certification:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# F2 — the runner's own report says UNTRUSTWORTHY; argv says otherwise.
# ---------------------------------------------------------------------------
#
# Since ADV-3 the report is sealed, so "the runner's own report" means the
# SEALED body: this builds the artefacts of a run whose sensor really was
# untrustworthy — body, seal and readable file all saying so — and then asserts
# on the command line that it was fine.
F2="$(copy_of f2)"
node -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const dir = process.argv[1], st = `${dir}/sensor-state-0023`;
const key = Buffer.from(fs.readFileSync(`${st}/runkey`, "utf8").trim(), "hex");
const body = fs.readFileSync(`${st}/report-body.txt`, "utf8")
  .replace(/^SENSOR_RESULT=TRUSTWORTHY\|.*$/m, "SENSOR_RESULT=UNTRUSTWORTHY|violations=CHALLENGE_FAILED");
if (!/UNTRUSTWORTHY/.test(body)) { console.error("k14: no TRUSTWORTHY line in the sealed body"); process.exit(2); }
fs.writeFileSync(`${st}/report-body.txt`, body);
fs.writeFileSync(`${st}/report.hmac`, crypto.createHmac("sha256", key).update(body).digest("hex") + "\n");
fs.writeFileSync(`${dir}/sensor-report-0023.txt`, body);
' "$F2" || harness "F2 could not build the untrustworthy-run artefacts"
grep -q '^SENSOR_RESULT=UNTRUSTWORTHY|' "$F2/sensor-report-0023.txt" \
  || harness "F2 could not rewrite the sensor report (the SENSOR_RESULT line did not match)"
verdict "$F2"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "--sensor-verdict says TRUSTWORTHY but the report the trusted runner SEALED for 0023 records SENSOR_RESULT=UNTRUSTWORTHY" \
    || problems="${problems} the-contradiction-was-not-reported"
  [[ "$(scope "$F2" "s.sensorVerdict['0023'].derived")" == "UNTRUSTWORTHY" ]] \
    || problems="${problems} scope-records-the-wrong-derived-verdict"
  if [[ -z "$problems" ]]; then
    ok "F2 argv contradicting the runner's own report -> refused (rc=$RC), naming both values"
  else
    bad "F2 argv overrode the trusted runner's own report:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# ADV1 — D's closure covered the request windows and nothing else. The same
# three events, byte-faithful to what instrument.cjs emit() writes, placed
# 742 ms AFTER the cell's last window closed: measured PASS, exit 0,
# "noBrokerCall: 480 satisfied, 0 violated". No forgery is involved — the
# instrument patches fetch/socket/tls/dns process-wide at module load.
# ---------------------------------------------------------------------------
ADV1="$(copy_of adv1)"
node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir] = process.argv.slice(1);
const S = "0023", CELL = "m-off__s-off__b-probe";
const runs = [];
for (const e of J.read(`${dir}/sink-${S}.jsonl`).rows) {
  if (typeof e.cell === "string" && e.cell !== "(unset)" &&
      (!runs.length || runs[runs.length - 1].tag !== e.cell)) runs.push({ tag: e.cell, t: e.t });
}
const i = runs.findIndex((r) => r.tag === `${CELL}#10`);
if (i < 0 || i + 1 >= runs.length) { console.error("k14: no bounded window for " + CELL + "#10"); process.exit(2); }
const closed = runs[i + 1].t;                 // the #idle POST terminates the last window
const t = closed + 742;
// The gap must really be a gap: if the next cell started sooner than 742 ms
// later the plant would land in ITS window and this case would be measuring
// the clock rather than the check.
if (i + 2 < runs.length && t >= runs[i + 2].t) {
  console.error("k14: the idle gap after " + CELL + "#10 is under 742 ms"); process.exit(2);
}
const p = `${dir}/instr/${S}-${CELL}.jsonl`;
const evs = J.read(p).rows;
const m = Math.max(...evs.map((e) => e.seq));
const stack = ["Timeout._onTimeout (/app/.next/server/chunks/[root-of-the-server]__0myor-1._.js:1:9142)",
               "listOnTimeout (node:internal/timers:594:17)",
               "process.processTimers (node:internal/timers:529:7)"];
fs.appendFileSync(p,
  JSON.stringify({ seq: m + 1, t, kind: "dns.lookup",
    detail: { name: "paper-api.alpaca.markets", hostClass: "broker" }, stack }) + "\n" +
  JSON.stringify({ seq: m + 2, t: t + 1, kind: "socket.connect",
    detail: { host: "paper-api.alpaca.markets", port: 443, hostClass: "broker" }, stack }) + "\n" +
  JSON.stringify({ seq: m + 3, t: t + 2, kind: "fetch",
    detail: { method: "POST", host: "paper-api.alpaca.markets", hostClass: "broker",
              pathClass: "broker-orders" }, stack }) + "\n");
' "$ADV1" || harness "ADV1 could not plant the post-window events"
verdict "$ADV1"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "are UNATTRIBUTED" || problems="${problems} the-refusal-does-not-name-the-class"
  says "paper-api.alpaca.markets" || problems="${problems} the-message-does-not-name-the-host"
  says "nor inside any of the 10 bounded request windows" \
    || problems="${problems} the-message-does-not-say-what-would-have-accounted-for-them"
  un="$(scope "$ADV1" "s.claimEvidence['0023'].eventsUnattributed")"
  [[ "$un" == "3" ]] || problems="${problems} eventsUnattributed=${un}(want 3)"
  [[ "$(scope "$ADV1" 's.status')" == "INCOMPLETE_OBSERVATION" ]] \
    || problems="${problems} status=$(scope "$ADV1" 's.status')"
  if [[ -z "$problems" ]]; then
    ok "ADV1 three real broker events 742 ms past the last window -> refused (rc=$RC) as UNATTRIBUTED,"
    printf '       not silently excluded for falling outside the ~11%% of the cell a request window covers\n'
  else
    bad "ADV1 events outside every request window were still treated as absent:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# ADV1b — the same attack aimed at the OTHER escape: an event carrying a seq
# that is already in the boot range. A `seq > max(bootSeq)` test would wave it
# through; matching the boot snapshot by seq|t|kind does not.
# ---------------------------------------------------------------------------
ADV1B="$(copy_of adv1b)"
node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const p = `${process.argv[1]}/instr/0023-m-off__s-off__b-probe.jsonl`;
const evs = J.read(p).rows;
const b = evs[5];
if (!b) { console.error("k14: too few boot events to reuse a seq"); process.exit(2); }
fs.appendFileSync(p, JSON.stringify({ seq: b.seq, t: b.t, kind: "fetch",
  detail: { method: "POST", host: "paper-api.alpaca.markets", hostClass: "broker" },
  stack: b.stack }) + "\n");
' "$ADV1B" || harness "ADV1b could not plant the duplicate-seq event"
verdict "$ADV1B"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "are UNATTRIBUTED" || problems="${problems} not-reported-as-unattributed"
  un="$(scope "$ADV1B" "s.claimEvidence['0023'].eventsUnattributed")"
  [[ "$un" == "1" ]] || problems="${problems} eventsUnattributed=${un}(want 1)"
  if [[ -z "$problems" ]]; then
    ok "ADV1b an event reusing a boot seq -> refused (rc=$RC): the boot snapshot is matched by"
    printf '       seq|t|kind, not by a high-water mark\n'
  else
    bad "ADV1b a duplicated seq laundered an event into the boot window:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# ADV1c — an instrument log for a cell no result claims. Every line of every
# log a result points at is accounted for; a log nothing points at would
# otherwise be evidence in the directory that the verdict never opened.
# ---------------------------------------------------------------------------
ADV1C="$(copy_of adv1c)"
cp "$ADV1C/instr/0023-m-off__s-off__b-probe.jsonl" "$ADV1C/instr/0023-m-ghost__s-off__b-probe.jsonl"
verdict "$ADV1C"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "has no result file in this verdict" || problems="${problems} the-unclaimed-log-was-not-reported"
  says "0023-m-ghost__s-off__b-probe.jsonl" || problems="${problems} the-message-does-not-name-the-file"
  if [[ -z "$problems" ]]; then
    ok "ADV1c an instrument log no cell result claims -> refused (rc=$RC), naming the file"
  else
    bad "ADV1c an unclaimed instrument log was ignored:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# ADV1d — the last hiding place the attribution pass opens up. "Attributed to
# boot" accounts for an event; nothing in this harness decides a CLAIM from a
# boot event, so an outbound call declared in the boot snapshot would be fully
# accounted for and never looked at. Two edits put one there — the instrument
# log and the cell result's bootEvents — and none at all if the image really
# does it at container start.
# ---------------------------------------------------------------------------
ADV1D="$(copy_of adv1d)"
node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const dir = process.argv[1], S = "0023", CELL = "m-off__s-off__b-probe";
const p = `${dir}/instr/${S}-${CELL}.jsonl`;
const evs = J.read(p).rows;
const last = evs[evs.length - 1];
const ev = { seq: last.seq + 1, t: last.t + 5, kind: "fetch",
  detail: { method: "POST", host: "paper-api.alpaca.markets", hostClass: "broker",
            pathClass: "broker-orders" }, stack: last.stack };
fs.appendFileSync(p, JSON.stringify(ev) + "\n");
const f = `${dir}/cells/result-${S}-${CELL}.json`;
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.bootEvents.push(ev);              // …and DECLARE it, so it is fully attributed
fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$ADV1D" || harness "ADV1d could not plant the boot-snapshot broker call"
verdict "$ADV1D"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "the boot snapshot carries" || problems="${problems} the-boot-bucket-was-not-judged"
  says "paper-api.alpaca.markets" || problems="${problems} the-message-does-not-name-the-host"
  br="$(scope "$ADV1D" "s.claimEvidence['0023'].bootEventsRefused")"
  un="$(scope "$ADV1D" "s.claimEvidence['0023'].eventsUnattributed")"
  [[ "$br" == "1" ]] || problems="${problems} bootEventsRefused=${br}(want 1)"
  # It really was ATTRIBUTED — this case is about the boot bucket, not about
  # the unattributed one, and if it fell out as unattributed it would be
  # testing ADV1 over again.
  [[ "$un" == "0" ]] || problems="${problems} eventsUnattributed=${un}(want 0; this event IS attributed)"
  if [[ -z "$problems" ]]; then
    ok "ADV1d an outbound broker call DECLARED in the boot snapshot -> refused (rc=$RC): attributed"
    printf '       is not innocent, and no claim is decided from a boot event\n'
  else
    bad "ADV1d the boot snapshot absorbed an outbound call in silence:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# R5A / R5Ab — ADV1d's judge was a DENY-list, and a round-5 audit walked
# through it twice, both times to a full certifying PASS over a log recording
# POST https://paper-api.alpaca.markets/v2/orders:
#
#   R5A   the kind list held four of the eight outbound kinds instrument.cjs
#         emits. `node:https.request` — what the `https` module path produces,
#         and what claims.mjs has always counted as egress — was not one of
#         them, so the same call under that kind was attributed and unjudged.
#   R5Ab  the decision read `detail.hostClass`, a field the writer of the
#         record chooses. One word changed to `loopback` and a plain `fetch`
#         whose own `host` still said paper-api.alpaca.markets was permitted.
#
# The judge is now an ALLOW-list of the kinds a boot snapshot may contain and
# reads no self-reported classification, so BOTH refuse. R5A is looped over
# every kind in the shared EGRESS_KINDS list rather than testing one: a
# hand-picked kind would go stale exactly the way the deny-list did.
# ---------------------------------------------------------------------------
mapfile -t EGRESS_KINDS < <(node -e '
  import("'"${CANARY_ROOT}"'/driver/claims.mjs").then((m) => {
    for (const k of m.EGRESS_KINDS) process.stdout.write(k + "\n");
  });
')
[[ "${#EGRESS_KINDS[@]}" -ge 8 ]] \
  || harness "claims.mjs exports ${#EGRESS_KINDS[@]} egress kinds; expected at least 8 (fetch, four node:http* and three socket/tls/dns)"

plant_boot_event() {   # dir schema cell kind hostClass -> plants and DECLARES it
  node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir, S, CELL, KIND, HC] = process.argv.slice(1);
const p = `${dir}/instr/${S}-${CELL}.jsonl`;
const evs = J.read(p).rows;
const last = evs[evs.length - 1];
const ev = { seq: last.seq + 1, t: last.t + 5, kind: KIND,
  detail: { method: "POST", host: "paper-api.alpaca.markets", path: "/v2/orders",
            url: "https://paper-api.alpaca.markets/v2/orders",
            hostClass: HC, pathClass: "other" },
  stack: last.stack };
fs.appendFileSync(p, JSON.stringify(ev) + "\n");
const f = `${dir}/cells/result-${S}-${CELL}.json`;
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.bootEvents.push(ev);              // …and DECLARE it, so it is fully attributed
fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$@"
}

{
  problems=""; n=0
  for kind in "${EGRESS_KINDS[@]}"; do
    n=$(( n + 1 ))
    d="$(copy_of "r5a-${n}")"
    plant_boot_event "$d" 0023 m-off__s-off__b-probe "$kind" broker \
      || harness "R5A could not plant a boot ${kind}"
    verdict "$d"
    [[ "$RC" -ne 0 ]] || problems="${problems} ${kind}:rc=0"
    has_pass_banner "$FLAT" && problems="${problems} ${kind}:PASS-banner"
    says "the boot snapshot carries" || problems="${problems} ${kind}:boot-bucket-not-judged"
    br="$(scope "$d" "s.claimEvidence['0023'].bootEventsRefused")"
    [[ "$br" == "1" ]] || problems="${problems} ${kind}:bootEventsRefused=${br}"
    un="$(scope "$d" "s.claimEvidence['0023'].eventsUnattributed")"
    [[ "$un" == "0" ]] || problems="${problems} ${kind}:eventsUnattributed=${un}(this event IS attributed)"
    rm -rf "$d"
  done
  # …and the ALLOW-list's own fall-through branch. Every kind above lands in
  # the egress branch, so without this the "a kind nobody enumerated refuses"
  # claim would be untested — and a bug making that branch unreachable would
  # look exactly like a pass.
  d="$(copy_of r5a-unknown)"
  plant_boot_event "$d" 0023 m-off__s-off__b-probe child_process.spawn broker \
    || harness "R5A could not plant a boot event of an unenumerated kind"
  verdict "$d"
  [[ "$RC" -ne 0 ]] || problems="${problems} unknown-kind:rc=0"
  has_pass_banner "$FLAT" && problems="${problems} unknown-kind:PASS-banner"
  says "is not one of the kinds a boot snapshot may contain" \
    || problems="${problems} unknown-kind:allow-list-fall-through-never-fired"
  rm -rf "$d"

  if [[ -z "$problems" ]]; then
    ok "R5A a broker call declared in the boot snapshot is refused under ALL ${n} outbound kinds"
    printf '       claims.mjs exports — and so is a kind nobody enumerated, which is what makes this\n'
    printf '       an allow-list rather than the deny-list two shapes walked through\n'
  else
    bad "R5A the boot judge is narrower than the set of kinds the instrument can emit:${problems}"
  fi
}

{
  R5AB="$(copy_of r5ab)"
  plant_boot_event "$R5AB" 0023 m-off__s-off__b-probe fetch loopback \
    || harness "R5Ab could not plant the laundered boot fetch"
  verdict "$R5AB"
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "the boot snapshot carries" || problems="${problems} the-boot-bucket-was-not-judged"
  says "paper-api.alpaca.markets" || problems="${problems} the-message-does-not-name-the-host"
  br="$(scope "$R5AB" "s.claimEvidence['0023'].bootEventsRefused")"
  [[ "$br" == "1" ]] || problems="${problems} bootEventsRefused=${br}(want 1)"
  if [[ -z "$problems" ]]; then
    ok "R5Ab a boot fetch to paper-api.alpaca.markets that LABELS ITSELF hostClass=loopback is still"
    printf '       refused (rc=%s): the boot judge reads no self-reported classification\n' "$RC"
  else
    bad "R5Ab a self-reported host class still buys a pass at container start:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# R5B / R5Bb — ADV-1 accounted for every line of the IMAGE's log and left the
# GATEWAY's log — the second observer, the one that exists because the first
# runs inside the thing under test — read only inside request windows.
# sinkByCell() buckets it by tag and verdict.mjs only ever asks for
# `<cell>#<n>`, so an entry under `#witness`, `#idle` or `(unset)` was parsed
# and judged by nothing. MEASURED before the repair: a GET /rest/v1/accounts
# and a GET /auth/v1/user under one cell's #idle tag, with no instrument event
# and no cell result touched, produced a full certifying PASS.
#
# R5Bb is this case's own POSITIVE CONTROL, and it is the one that matters: the
# identical pair under a REQUEST tag must be refused as a FINDING. Without it,
# R5B could pass because the planter silently did nothing.
# ---------------------------------------------------------------------------
plant_gateway_rows() {   # dir schema cell tagsuffix
  node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir, S, CELL, SUFFIX] = process.argv.slice(1);
const f = `${dir}/sink-${S}.jsonl`;
const { all } = J.read(f);
const tag = `${CELL}#${SUFFIX}`;
const at = all.findIndex((it) => it.obj && it.obj.cell === tag);
if (at < 0) { console.error(`k14: no gateway row carries ${tag}`); process.exit(2); }
const a = all[at].obj;
// exactly what sink.mjs record()/send() writes for a real data-plane request
all.splice(at + 1, 0,
  J.inserted({ seq: a.seq + 0.1, t: a.t + 120, cell: tag, kind: "postgrest", method: "GET",
    path: "/rest/v1/accounts", query: "?select=*", status: 200, reqBodyBytes: 0,
    headers: { apikey: "[redacted]", accept: "application/json" }, role: "service_role" }),
  J.inserted({ seq: a.seq + 0.2, t: a.t + 140, cell: tag, kind: "auth", method: "GET",
    path: "/auth/v1/user", query: "", status: 200, reqBodyBytes: 0, headers: {} }));
J.dump(f, all);
' "$@"
}

{
  R5BB="$(copy_of r5bb)"
  plant_gateway_rows "$R5BB" 0008 m-off__s-off__b-probe 5 \
    || harness "R5Bb could not plant the in-request gateway entries"
  verdict "$R5BB"
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "noPostgRESTCall" || problems="${problems} noPostgRESTCall-not-mentioned"
  if [[ -z "$problems" ]]; then
    ok "R5Bb POSITIVE CONTROL: the same two gateway entries under a REQUEST tag are refused (rc=$RC),"
    printf '       so R5B below is discriminating rather than a planter that did nothing\n'
  else
    bad "R5Bb the harness does not refuse a data-plane call the gateway logged inside a request:${problems}"
  fi
  rm -rf "$R5BB"
}

{
  problems=""
  for suffix in idle witness; do
    d="$(copy_of "r5b-${suffix}")"
    plant_gateway_rows "$d" 0008 m-off__s-off__b-probe "$suffix" \
      || harness "R5B could not plant the #${suffix} gateway entries"
    verdict "$d"
    [[ "$RC" -ne 0 ]] || problems="${problems} ${suffix}:rc=0"
    has_pass_banner "$FLAT" && problems="${problems} ${suffix}:PASS-banner"
    says "RECORDING GATEWAY'S OWN LOG" || problems="${problems} ${suffix}:gateway-log-not-accounted-for"
    says "/rest/v1/accounts" || problems="${problems} ${suffix}:message-does-not-name-the-entry"
    ua="$(scope "$d" "s.claimEvidence['0008'].gatewayRowsUnaccounted")"
    [[ "$ua" == "2" ]] || problems="${problems} ${suffix}:gatewayRowsUnaccounted=${ua}(want 2)"
    rm -rf "$d"
  done
  # …and the exemption must not be purchasable with one word. If the row's own
  # `kind` decided, `"kind":"harness"` beside `"path":"/rest/v1/accounts"` would
  # buy it; the classification is derived from the path instead.
  d="$(copy_of r5b-relabel)"
  plant_gateway_rows "$d" 0008 m-off__s-off__b-probe idle \
    || harness "R5B could not plant the #idle gateway entries"
  node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const f = `${process.argv[1]}/sink-0008.jsonl`;
let n = 0;
const { all } = J.read(f);
for (const it of all) {
  if (it.obj && (it.obj.kind === "postgrest" || it.obj.kind === "auth")) {
    it.obj.kind = "harness"; J.mark(it); n++;
  }
}
if (n !== 2) { console.error(`k14: relabelled ${n} rows, expected 2`); process.exit(2); }
J.dump(f, all);
' "$d" || harness "R5B could not relabel the planted gateway entries"
  verdict "$d"
  [[ "$RC" -ne 0 ]] || problems="${problems} relabelled:rc=0"
  has_pass_banner "$FLAT" && problems="${problems} relabelled:PASS-banner"
  says "declare a kind that their own path contradicts" \
    || problems="${problems} relabelled:the-harness-exemption-was-bought-with-one-word"
  ml="$(scope "$d" "s.claimEvidence['0008'].gatewayRowsMislabelled")"
  [[ "$ml" == "2" ]] || problems="${problems} relabelled:gatewayRowsMislabelled=${ml}(want 2)"
  rm -rf "$d"

  if [[ -z "$problems" ]]; then
    ok "R5B a Supabase data-plane call the gateway logged under #idle or #witness — outside every"
    printf '       request window, no instrument event, no cell result touched — is refused, not ignored,\n'
    printf '       and relabelling it "harness" does not buy the control-traffic exemption\n'
  else
    bad "R5B the gateway's log still has an unread complement:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# R5C — both cross-checks over the in-process events keyed them on
# `(seq, t, kind)`: observers.mjs `eventKey`, which decides whether the image's
# log and the driver's transcription agree, and observation.mjs
# `eventDigest_16`, which is what the gateway attests. `detail` — the host, the
# port, the path class, the field every claim actually reads — was in neither.
#
# The case builds the honest artefacts of a run in which the image DID call the
# broker (instrument log, transcription and the gateway's attestation all
# consistent, the attestation recomputed with the harness's own module), asserts
# that this is refused — that is the positive control — and then rewrites ONLY
# the detail, in both instrument-side copies, leaving seq/t/kind alone. Before
# the repair the second step certified.
# ---------------------------------------------------------------------------
{
  R5C="$(copy_of r5c)"
  node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir, RCDIR] = process.argv.slice(1);
const S = "0008", CELL = "m-off__s-off__b-probe", REQ = "5", TAG = `${CELL}#${REQ}`;
import(`${RCDIR}/driver/observation.mjs`).then(({ observationFields, observationDigest }) => {
  const prov = JSON.parse(fs.readFileSync(`${dir}/provenance.json`, "utf8"));
  const cf = `${dir}/cells/result-${S}-${CELL}.json`;
  const cell = JSON.parse(fs.readFileSync(cf, "utf8"));
  const r = cell.results.find((x) => x.cellTag === TAG);
  if (!r) { console.error("k14: no result for " + TAG); process.exit(2); }
  const lf = `${dir}/instr/${S}-${CELL}.jsonl`;
  const evs = J.read(lf).rows;
  const ev = {
    seq: Math.max(...evs.map((e) => e.seq)) + 1,
    t: Math.floor((Number(r.t0) + Number(r.t1)) / 2),
    kind: "fetch",
    detail: { method: "POST", url: "https://paper-api.alpaca.markets/v2/orders",
              host: "paper-api.alpaca.markets", pathname: "/v2/orders",
              hostClass: "broker", pathClass: "other" },
    stack: ["instrumentedFetch (/canary/instrument.cjs:138:5)"],
  };
  fs.appendFileSync(lf, JSON.stringify(ev) + "\n");
  r.events = (r.events || []).concat([ev]);
  fs.writeFileSync(cf, JSON.stringify(cell, null, 2));
  const sf = `${dir}/sink-${S}.jsonl`;
  const { all } = J.read(sf);
  const want = observationFields(prov.runNonce, S, CELL, r);
  const digest = observationDigest(want);
  let n = 0;
  for (const it of all) {
    if (it.obj && it.obj.observation && it.obj.observation.tag === TAG) {
      it.obj.observation = { ...it.obj.observation, ...want, digest }; J.mark(it); n++;
    }
  }
  if (n !== 1) { console.error(`k14: patched ${n} attestations, expected 1`); process.exit(2); }
  J.dump(sf, all);
});
' "$R5C" "$CANARY_ROOT" || harness "R5C could not build the honest broker-call artefacts"
  verdict "$R5C"
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} honest-run:rc=0"
  has_pass_banner "$FLAT" && problems="${problems} honest-run:PASS-banner"
  says "noBrokerCall" || problems="${problems} honest-run:noBrokerCall-not-mentioned"

  # …now launder ONLY the detail, in both instrument-side copies. Every
  # untouched log line is written back byte-identically: instrumentEvidence
  # matches the boot events with a raw substring, so a re-serialised log would
  # fail for a reason that is not this case's.
  node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const dir = process.argv[1], S = "0008", CELL = "m-off__s-off__b-probe";
const clean = { method: "GET", url: "http://127.0.0.1:3000/healthz", host: "127.0.0.1",
                pathname: "/healthz", hostClass: "loopback", pathClass: "other" };
const lf = `${dir}/instr/${S}-${CELL}.jsonl`;
let n = 0;
const { all } = J.read(lf);
for (const it of all) {
  const e = it.obj;
  if (e && e.kind === "fetch" && e.detail && e.detail.hostClass === "broker") {
    it.obj = { ...e, detail: { ...clean } }; J.mark(it); n++;
  }
  // every other entry stays byte-identical: J.dump writes it.raw unless dirty
}
J.dump(lf, all);
const cf = `${dir}/cells/result-${S}-${CELL}.json`;
const cell = JSON.parse(fs.readFileSync(cf, "utf8"));
let m = 0;
for (const r of cell.results) for (const e of (r.events || [])) {
  if (e.kind === "fetch" && e.detail && e.detail.hostClass === "broker") { e.detail = { ...clean }; m++; }
}
fs.writeFileSync(cf, JSON.stringify(cell, null, 2));
if (n !== 1 || m !== 1) { console.error(`k14: laundered ${n}/${m}, expected 1/1`); process.exit(2); }
' "$R5C" || harness "R5C could not launder the event detail"
  verdict "$R5C"
  [[ "$RC" -ne 0 ]] || problems="${problems} laundered:rc=0"
  has_pass_banner "$FLAT" && problems="${problems} laundered:PASS-banner"
  # Either cross-check may speak first: the gateway's attestation now carries a
  # digest of the detail (so `eventDigest_16` disagrees), and the observer/driver
  # diff keys on the same identity. Requiring one specific wording would make
  # this case brittle for no gain; requiring NEITHER would make it vacuous.
  if says "does not describe the request the gateway witnessed" \
     || says "the driver's transcription and"; then
    :
  else
    problems="${problems} laundered:neither-cross-check-noticed-the-detail"
  fi
  says "eventDigest_16" || problems="${problems} laundered:the-event-digest-is-not-what-disagreed"
  if [[ -z "$problems" ]]; then
    ok "R5C rewriting ONLY an event's detail — same seq, same t, same kind — is refused (rc=$RC):"
    printf '       the identity both cross-checks key on now covers what the record says happened\n'
  else
    bad "R5C the field every claim is decided from is still bound by nothing:${problems}"
  fi
  rm -rf "$R5C"
}

# ---------------------------------------------------------------------------
# ADV3a — F's closure defeated by RETYPING the file. Delete every trusted-
# runner artefact and write eight lines of plain text in the documented shape:
# measured PASS, with scope recording derived:TRUSTWORTHY, manifestVerified:
# true. The phase counts are the RIGHT ones, so the counter cross-check — which
# does work — has nothing to object to. What was missing was authenticity.
# ---------------------------------------------------------------------------
ADV3A="$(copy_of adv3a)"
rm -rf "$ADV3A"/sensor-state-*
rm -f  "$ADV3A"/sensor-arm-*.txt "$ADV3A"/sensor-mid-*.txt "$ADV3A"/sensor-post-*.txt
for s in 0008 0023; do
  {
    printf 'SENSOR_MANIFEST=verified\n'
    printf 'SENSOR_DEFINITIONS=final|unchanged|objects=22\n'
    printf 'SENSOR_LEDGER=lines=12\n'
    printf 'SENSOR_PHASE=pre|events=3\n'
    printf 'SENSOR_PHASE=mid|events=6\n'
    printf 'SENSOR_PHASE=post|events=3\n'
    printf 'SENSOR_FINAL=vault_create_secret=5,vault_delete_secret=5,vault_update_secret=5|rounds=4\n'
    printf 'SENSOR_RESULT=TRUSTWORTHY|rounds=4|phases=pre,mid,post|accountedExtraHits=1\n'
  } > "$ADV3A/sensor-report-${s}.txt"
done
grep -q '^SENSOR_RESULT=TRUSTWORTHY|' "$ADV3A/sensor-report-0023.txt" \
  || harness "ADV3a did not write the retyped report"
verdict "$ADV3A"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "is not sealed by the trusted runner" || problems="${problems} no-message-about-the-missing-seal"
  says "runkey does not exist" || problems="${problems} the-message-does-not-say-what-is-missing"
  [[ "$(scope "$ADV3A" "s.sensorVerdict['0023'].derived")" == "null" ]] \
    || problems="${problems} scope-derived-a-verdict-from-an-unsealed-report"
  [[ "$(scope "$ADV3A" "s.sensorVerdict['0023'].sealed")" == "false" ]] \
    || problems="${problems} scope-does-not-record-the-report-as-unsealed"
  if [[ -z "$problems" ]]; then
    ok "ADV3a eight retyped lines in place of the runner's report -> refused (rc=$RC): the verdict is"
    printf '       derived from the sealed body, and a report that verifies against nothing is text\n'
  else
    bad "ADV3a a retyped sensor report still bought a certification:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# ADV3b — the state tree is kept and genuine; the operator edits only the text
# file a human reads. The sealed body still says UNTRUSTWORTHY.
# ---------------------------------------------------------------------------
ADV3B="$(copy_of adv3b)"
node -e '
const fs = require("node:fs"), crypto = require("node:crypto");
const st = `${process.argv[1]}/sensor-state-0023`;
const key = Buffer.from(fs.readFileSync(`${st}/runkey`, "utf8").trim(), "hex");
// what the runner WOULD have sealed on an untrustworthy run
const body = fs.readFileSync(`${st}/report-body.txt`, "utf8")
  .replace(/^SENSOR_RESULT=TRUSTWORTHY\|.*$/m, "SENSOR_RESULT=UNTRUSTWORTHY|violations=CHALLENGE_FAILED");
if (!/UNTRUSTWORTHY/.test(body)) { console.error("k14: the sealed body had no TRUSTWORTHY line"); process.exit(2); }
fs.writeFileSync(`${st}/report-body.txt`, body);
fs.writeFileSync(`${st}/report.hmac`,
  crypto.createHmac("sha256", key).update(body).digest("hex") + "\n");
// …and the text file keeps saying TRUSTWORTHY, untouched.
' "$ADV3B" || harness "ADV3b could not build the divergent report"
verdict "$ADV3B"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  [[ "$(scope "$ADV3B" "s.sensorVerdict['0023'].derived")" == "UNTRUSTWORTHY" ]] \
    || problems="${problems} derived=$(scope "$ADV3B" "s.sensorVerdict['0023'].derived")(want UNTRUSTWORTHY)"
  [[ "$(scope "$ADV3B" "s.sensorVerdict['0023'].sealedBodyAgreesWithText")" == "false" ]] \
    || problems="${problems} the-divergence-was-not-recorded"
  says "SENSOR_RESULT=UNTRUSTWORTHY" || problems="${problems} the-sealed-verdict-was-not-reported"
  if [[ -z "$problems" ]]; then
    ok "ADV3b the text file says TRUSTWORTHY and the sealed body says otherwise -> the SEALED body"
    printf '       decides, and the divergence is refused (rc=%s)\n' "$RC"
  else
    bad "ADV3b the readable file overrode the sealed one:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# ADV3c — the challenge ledger. The report's phase counts are only as good as
# the ledger they were counted from, so every line's MAC is re-verified here.
# ---------------------------------------------------------------------------
ADV3C="$(copy_of adv3c)"
node -e '
const fs = require("node:fs");
const p = `${process.argv[1]}/sensor-state-0023/ledger.jsonl`;
const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
if (!lines.length) { console.error("k14: the ledger is empty"); process.exit(2); }
fs.writeFileSync(p, lines.map((l) => "0".repeat(64) + " " + l.slice(l.indexOf(" ") + 1)).join("\n") + "\n");
' "$ADV3C" || harness "ADV3c could not rewrite the ledger"
verdict "$ADV3C"
{
  problems=""
  [[ "$RC" -ne 0 ]] || problems="${problems} rc=0"
  has_pass_banner "$FLAT" && problems="${problems} printed-the-PASS-banner"
  says "do not verify against this run's key" || problems="${problems} the-ledger-macs-were-not-checked"
  if [[ -z "$problems" ]]; then
    ok "ADV3c a challenge ledger whose line MACs do not verify -> refused (rc=$RC)"
  else
    bad "ADV3c the record of the sensor being challenged was taken on trust:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# ADV4 — a stale green. verdict-scope.json is the file the scope statements
# tell readers to PREFER over the transcript, and every pre-verdict refusal
# used to leave the PREVIOUS run's {"status":"PASS"} sitting in it. Measured at
# 6m46s stale: exit 3 on the console, PASS in the file.
# ---------------------------------------------------------------------------
ADV4="$(copy_of adv4)"
verdict "$ADV4"
# ROUND-7 AUDIT. This precondition used to call `harness`, which exits 2 and
# takes the summary with it. Over a --full-out that does not certify — a corrupt
# artefact directory, say — ADV4 is the one case that cannot be exercised at
# all, and killing the suite there hid the five cases after it AND the summary
# naming the real cause. It is now a case FAILURE that says what is missing, so
# the suite finishes and GREEN/MEASURED get to be the ones that diagnose the
# directory. MEASURED over a deliberately corrupted corpus: 2 of 28 cases
# reported before this and 28 of 28 after.
ADV4_READY=1
if [[ "$RC" -ne 0 || "$(scope "$ADV4" 's.status' 2>/dev/null || echo '?')" != "PASS" ]]; then
  ADV4_READY=0
  bad "ADV4 could not be exercised: the UNMODIFIED directory does not certify (rc=$RC, status $(scope "$ADV4" 's.status' 2>/dev/null || echo '?')), and a stale-green case needs a green to make stale — see GREEN above for why"
fi
if [[ "$ADV4_READY" -eq 1 ]]; then
# POSITIVE CONTROL for the detector: it must be able to see a PASS in this file
# before "it is not a PASS" means anything.
[[ "$(scope "$ADV4" 's.status')" == "PASS" ]] \
  || harness "ADV4's own detector cannot read a PASS out of verdict-scope.json"
node -e '
const fs = require("node:fs");
const p = `${process.argv[1]}/provenance.json`;
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.pgImage = "postgres:17-alpine";
j.pgImagePinned = true;      // contradicts its own digest -> a pre-verdict refusal
fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$ADV4" || harness "ADV4 could not provoke a pre-verdict refusal"
verdict "$ADV4"
{
  problems=""
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  says "PROVENANCE_CONTRADICTED" || problems="${problems} not-the-refusal-this-case-provokes"
  if [[ ! -f "$ADV4/verdict-scope.json" ]]; then
    problems="${problems} no-verdict-scope.json-at-all"
  else
    st="$(scope "$ADV4" 's.status')"
    [[ "$st" != "PASS" ]] || problems="${problems} verdict-scope.json-still-says-PASS"
    [[ "$st" == "PROVENANCE_CONTRADICTED" ]] || problems="${problems} status=${st}(want PROVENANCE_CONTRADICTED)"
    [[ "$(scope "$ADV4" 's.verdictReached')" == "false" ]] || problems="${problems} verdictReached-not-false"
    [[ "$(scope "$ADV4" 's.reason')" == *"pgImagePinned=true"* ]] \
      || problems="${problems} the-record-does-not-carry-the-reason"
  fi
  if [[ -z "$problems" ]]; then
    ok "ADV4 a pre-verdict refusal over a directory that had passed -> verdict-scope.json is the"
    printf '       REFUSAL, carrying its reason; the previous PASS does not survive it\n'
  else
    bad "ADV4 a refusal left a stale green in the file readers are told to prefer:${problems}"
  fi
}
fi


# ===========================================================================
# ROUND 7. THE TWO OBSERVER-INTEGRITY DEFECTS, AND THE SUITE'S OWN SHARE OF
# THEM.
#
# R7-1  ONE BYTE. `driver/observers.mjs` parseJsonl dropped an unparseable line
#       in a bare catch, with a comment justifying it. That reader fed BOTH
#       observers, and verdict.mjs repeated the same silent catch twice more in
#       sinkByCell and sinkTruthByCell. Nothing compared the file's non-empty
#       line count with the parsed event count, so `claimEvidence.logEvents`
#       and `claimEvidence.gatewayRows` were computed from the same filtered
#       set and could not disagree with themselves. Measured on the certifying
#       corpus: a byte-faithful broker fetch 742 ms into #idle -> rc=3, "1
#       UNATTRIBUTED"; the SAME record with one trailing comma -> rc=0, PASS
#       banner, noBrokerCall 480 satisfied / 0 violated, logEvents 298 over a
#       299-line file. Reduced to ONE BYTE — the final "}" replaced by a
#       SPACE, same length, same line count, cells/ and sink-*.jsonl
#       bit-identical — the refusal still became a full certifying PASS. The
#       gateway's log broke the same way: a GET /rest/v1/accounts under a
#       cell's #idle tag, refused well formed, certified malformed, with
#       gatewayRows 555 over a 556-line file.
#
#       AND IT NEEDS NO ADVERSARY. instrument.cjs appends each event with its
#       own fs.appendFileSync and run.sh SIGKILLs the app container at the end
#       of every cell, so a truncated or interleaved line is a
#       normal-operation outcome — one that was silently discarded.
#
# R7-2  `observation.mjs` eventIdentity returns [seq, t, kind, sha(detail)].
#       `stack` is excluded deliberately and documented, but nothing refused an
#       UNKNOWN top-level key, so the real exclusion was "everything that is
#       not one of four fields". Measured: appending
#       "brokerCall":{"method":"POST","url":"https://paper-api.alpaca.markets/v2/orders",…}
#       to an EXISTING boot line left every published count identical (13 raw
#       lines in that file, logEvents 298, boot 298, unattributed 0) and still
#       certified — so it survives R7-1's line accounting and k14's MEASURED
#       comparison too.
#
# R7-1S THE SUITE'S OWN SHARE OF R7-1. k14's MEASURED case DOES catch the trailing-comma
#       variant, by comparing logEvents against `grep -c .`. It then aborted the
#       whole suite at rc=2, because every planting helper read the same file
#       with `.map((l) => JSON.parse(l))` and threw. Twenty-one cases never
#       reported, and the operator was told "D1 could not plant the events".
#
#   R7A   the one-byte break in the IMAGE's log: refused (rc=3) naming the file
#         and the line — WITH a positive control planting the byte-identical
#         well-formed record, which must still refuse as UNATTRIBUTED.
#   R7B   the same in the GATEWAY's log, with the same positive control.
#   R7C   an unrecognised top-level key on an existing boot line: refused,
#         naming file, line and key — with a positive control, and with the
#         measurement that every count R7-1 publishes is UNCHANGED by it.
#   R7Cb  the same key in the DRIVER'S TRANSCRIPTION: refused. A check applied
#         to one of two copies is a check the other copy walks past.
#   R7H   a corrupt --full-out must be REPORTED by this suite, not fatal to it:
#         the planters carry on and say so, the corruption survives them, and
#         the verdict names it.
# ===========================================================================

# One planter for both the well-formed and the one-byte forms of the SAME
# record, so "the same record with one byte changed" is a fact about this file
# rather than a claim in a comment. It lands 742 ms after the cell's last
# request window closes — inside the #idle bookend ADV-1 measured at ~89% of
# the cell's timeline.
plant_post_window_fetch() {   # dir mode(wellformed|onebyte)  -> prints the line number
  node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir, mode] = process.argv.slice(1);
const S = "0023", CELL = "m-off__s-off__b-probe";
const runs = [];
for (const e of J.read(`${dir}/sink-${S}.jsonl`).rows) {
  if (typeof e.cell === "string" && e.cell !== "(unset)" &&
      (!runs.length || runs[runs.length - 1].tag !== e.cell)) runs.push({ tag: e.cell, t: e.t });
}
const i = runs.findIndex((r) => r.tag === `${CELL}#10`);
if (i < 0 || i + 1 >= runs.length) { console.error("k14: no bounded window for " + CELL + "#10"); process.exit(2); }
const t = runs[i + 1].t + 742;
if (i + 2 < runs.length && t >= runs[i + 2].t) {
  console.error("k14: the idle gap after " + CELL + "#10 is under 742 ms"); process.exit(2);
}
const p = `${dir}/instr/${S}-${CELL}.jsonl`;
const evs = J.read(p).rows;
const m = Math.max(...evs.map((e) => e.seq));
let line = JSON.stringify({ seq: m + 1, t, kind: "fetch",
  detail: { method: "POST", url: "https://paper-api.alpaca.markets/v2/orders",
            host: "paper-api.alpaca.markets", hostClass: "broker", pathClass: "broker-orders" },
  stack: ["Timeout._onTimeout (/app/.next/server/chunks/[root-of-the-server]__0myor-1._.js:1:9142)"] });
if (mode === "onebyte") {
  // THE WHOLE ATTACK: the final "}" becomes a space. Same byte count, same
  // line count, the record still legible to a human, no other file touched.
  line = line.slice(0, -1) + " ";
} else if (mode !== "wellformed") { console.error("k14: bad mode " + mode); process.exit(2); }
fs.appendFileSync(p, line + "\n");
// The PHYSICAL line number of what was just appended — counting any blank line
// the file may hold, because that is the number `sed -n <N>p` wants and the
// number the refusal prints.
const after = fs.readFileSync(p, "utf8").split("\n");
let ln = after.length;
while (ln > 0 && after[ln - 1] === "") ln--;
process.stdout.write(String(ln));
' "$@"
}

# ---------------------------------------------------------------------------
# R7A — the image's own log. Positive control first: the byte-identical record,
# well formed, must be refused as UNATTRIBUTED. Then one byte changes.
# ---------------------------------------------------------------------------
{
  problems=""
  R7A="$(copy_of r7a)"
  IL="instr/0023-m-off__s-off__b-probe.jsonl"
  LN_OK="$(plant_post_window_fetch "$R7A" wellformed)" \
    || harness "R7A could not plant the well-formed control record"
  SZ_OK="$(wc -c < "$R7A/$IL")"
  verdict "$R7A"
  [[ "$RC" -ne 0 ]] || problems="${problems} control:rc=0"
  has_pass_banner "$FLAT" && problems="${problems} control:PASS-banner"
  says "are UNATTRIBUTED" || problems="${problems} control:not-refused-as-unattributed"
  says "paper-api.alpaca.markets" || problems="${problems} control:the-host-is-not-named"
  cu="$(scope "$R7A" "s.claimEvidence['0023'].eventsUnattributed")"
  [[ "$cu" == "1" ]] || problems="${problems} control:eventsUnattributed=${cu}(want 1)"
  clu="$(scope "$R7A" "s.claimEvidence['0023'].linesUnparseable")"
  [[ "$clu" == "0" ]] || problems="${problems} control:linesUnparseable=${clu}(want 0: this record parses)"
  rm -rf "$R7A"

  R7A2="$(copy_of r7a2)"
  LN_BAD="$(plant_post_window_fetch "$R7A2" onebyte)" \
    || harness "R7A could not plant the one-byte record"
  SZ_BAD="$(wc -c < "$R7A2/$IL")"
  # The "one byte" claim is MEASURED here, not asserted in prose: same file
  # size, same line number, so nothing but the byte itself differs.
  [[ "$SZ_OK" == "$SZ_BAD" ]] \
    || problems="${problems} the-two-plants-differ-in-length(${SZ_OK}-vs-${SZ_BAD})"
  [[ "$LN_OK" == "$LN_BAD" ]] \
    || problems="${problems} the-two-plants-differ-in-line-count(${LN_OK}-vs-${LN_BAD})"
  verdict "$R7A2"
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner"
  says "does not parse" || problems="${problems} the-refusal-does-not-say-the-line-does-not-parse"
  says "${IL}:${LN_BAD}" || problems="${problems} the-refusal-does-not-name-${IL}:${LN_BAD}"
  [[ "$(scope "$R7A2" 's.status')" == "INCOMPLETE_OBSERVATION" ]] \
    || problems="${problems} status=$(scope "$R7A2" 's.status')"
  lu="$(scope "$R7A2" "s.claimEvidence['0023'].linesUnparseable")"
  ilu="$(scope "$R7A2" "s.claimEvidence['0023'].instrLinesUnparseable")"
  rl="$(scope "$R7A2" "s.claimEvidence['0023'].rawLines")"
  le="$(scope "$R7A2" "s.claimEvidence['0023'].logEvents")"
  dl="$(scope "$R7A2" "s.claimEvidence['0023'].linesUnparseableDetail.map((d) => d.file + ':' + d.lineNo).join(',')")"
  [[ "$lu"  == "1" ]] || problems="${problems} linesUnparseable=${lu}(want 1)"
  [[ "$ilu" == "1" ]] || problems="${problems} instrLinesUnparseable=${ilu}(want 1)"
  [[ "$rl" == "$(( le + 1 ))" ]] \
    || problems="${problems} rawLines=${rl}-logEvents=${le}(the denominator must exceed the numerator by 1)"
  [[ "$dl" == "${IL}:${LN_BAD}" ]] \
    || problems="${problems} linesUnparseableDetail=${dl}(want ${IL}:${LN_BAD})"
  rm -rf "$R7A2"

  if [[ -z "$problems" ]]; then
    ok "R7A one byte — the record's final '}' replaced by a space, same length, same line count — no"
    printf '       longer converts a UNATTRIBUTED refusal into a certifying PASS: rc=3 naming %s:%s,\n' "$IL" "$LN_BAD"
    printf '       and the well-formed control still refuses, so the new check is not refusing everything\n'
  else
    bad "R7A a malformed line in the image's own log is still discarded silently:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# R7B — the same defect in the GATEWAY's log, which three separate readers each
# filtered with their own silent catch.
# ---------------------------------------------------------------------------
{
  problems=""
  # POSITIVE CONTROL: the well-formed pair under #idle must still be refused as
  # unaccounted-for gateway traffic (the round-5 closure).
  R7B="$(copy_of r7b)"
  plant_gateway_rows "$R7B" 0023 m-off__s-off__b-probe idle \
    || harness "R7B could not plant the well-formed control rows"
  verdict "$R7B"
  [[ "$RC" -ne 0 ]] || problems="${problems} control:rc=0"
  has_pass_banner "$FLAT" && problems="${problems} control:PASS-banner"
  says "are not the harness's own control traffic" || problems="${problems} control:not-refused-as-unaccounted"
  cg="$(scope "$R7B" "s.claimEvidence['0023'].gatewayRowsUnaccounted")"
  [[ "$cg" == "2" ]] || problems="${problems} control:gatewayRowsUnaccounted=${cg}(want 2)"
  rm -rf "$R7B"

  # …and the same row, one trailing comma added, must not vanish.
  R7B2="$(copy_of r7b2)"
  LN_GW="$(node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir] = process.argv.slice(1);
const S = "0023", TAG = "m-off__s-off__b-probe#idle";
const f = `${dir}/sink-${S}.jsonl`;
const { all } = J.read(f);
const at = all.findIndex((it) => it.obj && it.obj.cell === TAG);
if (at < 0) { console.error("k14: no gateway row carries " + TAG); process.exit(2); }
const a = all[at].obj;
const row = { seq: a.seq + 0.1, t: a.t + 120, cell: TAG, kind: "postgrest", method: "GET",
              path: "/rest/v1/accounts", query: "?select=*", status: 200, reqBodyBytes: 0,
              headers: { apikey: "[redacted]", accept: "application/json" }, role: "service_role" };
// one trailing comma: the row is still legible, and used to be invisible
const raw = JSON.stringify(row).slice(0, -1) + ",}";
all.splice(at + 1, 0, { obj: null, raw, lineNo: null, dirty: false });
J.dump(f, all);
process.stdout.write(String(at + 2));
' "$R7B2")" || harness "R7B could not plant the malformed gateway row"
  verdict "$R7B2"
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner"
  says "does not parse" || problems="${problems} the-refusal-does-not-say-the-line-does-not-parse"
  says "sink-0023.jsonl:${LN_GW}" || problems="${problems} the-refusal-does-not-name-sink-0023.jsonl:${LN_GW}"
  glu="$(scope "$R7B2" "s.claimEvidence['0023'].gatewayLinesUnparseable")"
  grw="$(scope "$R7B2" "s.claimEvidence['0023'].gatewayRawLines")"
  grr="$(scope "$R7B2" "s.claimEvidence['0023'].gatewayRows")"
  [[ "$glu" == "1" ]] || problems="${problems} gatewayLinesUnparseable=${glu}(want 1)"
  [[ "$grw" == "$(( grr + 1 ))" ]] \
    || problems="${problems} gatewayRawLines=${grw}-gatewayRows=${grr}(the denominator must exceed the numerator by 1)"
  # …and the count must be the one the directory holds, not a remembered figure
  gtruth="$(grep -c . "$R7B2/sink-0023.jsonl")"
  [[ "$grw" == "$gtruth" ]] || problems="${problems} gatewayRawLines=${grw}(grep -c . says ${gtruth})"
  rm -rf "$R7B2"

  if [[ -z "$problems" ]]; then
    ok "R7B a data-plane row the gateway logged under #idle is refused whether or not it parses"
    printf '       (rc=3, naming sink-0023.jsonl:%s), and the published gatewayRows now sits beside the\n' "$LN_GW"
    printf '       non-empty line count a reader can take with grep -c .\n'
  else
    bad "R7B a malformed line in the gateway's log is still discarded silently:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# R7C — an UNRECOGNISED TOP-LEVEL KEY. eventIdentity covers seq/t/kind/detail
# and excludes `stack` on purpose; nothing refused a sixth key, so the real
# exclusion was open ended. This one is invisible to R7-1's line accounting:
# the line parses, so every count stays exactly where it was.
# ---------------------------------------------------------------------------
{
  problems=""
  # POSITIVE CONTROL: the same call recorded HONESTLY — a well-formed event
  # carrying only permitted keys — must still be refused. Without it, "R7C
  # refuses" is satisfied by a check that refuses everything.
  R7CC="$(copy_of r7c-control)"
  plant_post_window_fetch "$R7CC" wellformed >/dev/null \
    || harness "R7C could not plant the well-formed control record"
  verdict "$R7CC"
  [[ "$RC" -ne 0 ]] || problems="${problems} control:rc=0"
  says "are UNATTRIBUTED" || problems="${problems} control:not-refused-as-unattributed"
  cfk="$(scope "$R7CC" "s.claimEvidence['0023'].eventsWithForeignKeys")"
  [[ "$cfk" == "0" ]] || problems="${problems} control:eventsWithForeignKeys=${cfk}(want 0: it carries no foreign key)"
  rm -rf "$R7CC"

  R7C="$(copy_of r7c)"
  IL="instr/0023-m-off__s-off__b-probe.jsonl"
  LN_FK="$(node -e '
const fs = require("node:fs");
const J = require(process.env.K14_JSONL);
const [dir] = process.argv.slice(1);
const p = `${dir}/instr/0023-m-off__s-off__b-probe.jsonl`;
const { all } = J.read(p);
const at = all.findIndex((it) => it.obj && it.obj.kind === "instrument.ready");
if (at < 0) { console.error("k14: no instrument.ready line to hang the key on"); process.exit(2); }
// Appended as TEXT so the rest of the line stays byte-identical: the boot
// snapshot is matched against this file with a raw substring, and a
// re-serialised line would fail for a reason that is not this case s.
const extra = `,"brokerCall":{"method":"POST","url":"https://paper-api.alpaca.markets/v2/orders",` +
              `"host":"paper-api.alpaca.markets","hostClass":"broker","status":200}`;
all[at].raw = all[at].raw.slice(0, -1) + extra + "}";
JSON.parse(all[at].raw);                      // it must still be WELL FORMED
J.dump(p, all);
// J.dump writes one line per `all` entry with no blanks, so the entry index IS
// the physical line number of what a reader will open.
process.stdout.write(String(at + 1));
' "$R7C")" || harness "R7C could not plant the unrecognised top-level key"
  # MEASURED: this is exactly the case R7-1 s accounting cannot see. Every
  # number it publishes is unchanged from the untouched directory.
  base_le="$(scope "$BASE" "s.claimEvidence['0023'].logEvents")"
  base_rl="$(scope "$BASE" "s.claimEvidence['0023'].rawLines")"
  verdict "$R7C"
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner"
  says "${IL}:${LN_FK}" || problems="${problems} the-refusal-does-not-name-${IL}:${LN_FK}"
  says '"brokerCall"' || problems="${problems} the-refusal-does-not-name-the-key"
  says "instrument.cjs does not write" || problems="${problems} the-refusal-does-not-say-why"
  fk="$(scope "$R7C" "s.claimEvidence['0023'].eventsWithForeignKeys")"
  [[ "$fk" == "1" ]] || problems="${problems} eventsWithForeignKeys=${fk}(want 1)"
  le="$(scope "$R7C" "s.claimEvidence['0023'].logEvents")"
  rl="$(scope "$R7C" "s.claimEvidence['0023'].rawLines")"
  un="$(scope "$R7C" "s.claimEvidence['0023'].eventsUnattributed")"
  lu="$(scope "$R7C" "s.claimEvidence['0023'].linesUnparseable")"
  [[ "$le" == "$base_le" && "$rl" == "$base_rl" && "$un" == "0" && "$lu" == "0" ]] \
    || problems="${problems} the-counting-closure-DID-see-it(logEvents=${le}/${base_le} rawLines=${rl}/${base_rl} unattributed=${un} unparseable=${lu})"
  rm -rf "$R7C"

  if [[ -z "$problems" ]]; then
    ok "R7C a \"brokerCall\" object appended to an existing boot line — every published count identical"
    printf '       to the untouched directory (logEvents %s, rawLines %s, 0 unattributed, 0 unparseable) —\n' "$base_le" "$base_rl"
    printf '       is refused (rc=3) by an allow-list over the top-level keys of the record, naming %s:%s\n' "$IL" "$LN_FK"
  else
    bad "R7C an unrecognised top-level key still rides through the attested event identity:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# R7Cb — the OTHER copy. The transcription is compared with the image's log on
# the same identity, so the key is bound by nothing on that side either.
# ---------------------------------------------------------------------------
{
  problems=""
  R7CB="$(copy_of r7cb)"
  node -e '
const fs = require("node:fs");
const [dir] = process.argv.slice(1);
const f = `${dir}/cells/result-0023-m-off__s-off__b-probe.json`;
const j = JSON.parse(fs.readFileSync(f, "utf8"));
if (!Array.isArray(j.bootEvents) || j.bootEvents.length < 3) {
  console.error("k14: too few boot events to hang the key on"); process.exit(2);
}
j.bootEvents[2].brokerCall = { method: "POST", url: "https://paper-api.alpaca.markets/v2/orders",
                               host: "paper-api.alpaca.markets", hostClass: "broker", status: 200 };
fs.writeFileSync(f, JSON.stringify(j, null, 2));
' "$R7CB" || harness "R7Cb could not plant the key in the transcription"
  verdict "$R7CB"
  [[ "$RC" -eq 3 ]] || problems="${problems} rc=${RC}(want 3)"
  has_pass_banner "$FLAT" && problems="${problems} PASS-banner"
  says "bootEvents[2] carries top-level key(s)" || problems="${problems} the-refusal-does-not-name-the-field"
  says "result-0023-m-off__s-off__b-probe.json" || problems="${problems} the-refusal-does-not-name-the-file"
  says '"brokerCall"' || problems="${problems} the-refusal-does-not-name-the-key"
  fk="$(scope "$R7CB" "s.claimEvidence['0023'].eventsWithForeignKeys")"
  [[ "$fk" == "1" ]] || problems="${problems} eventsWithForeignKeys=${fk}(want 1)"
  rm -rf "$R7CB"
  if [[ -z "$problems" ]]; then
    ok "R7Cb the same key in the DRIVER'S TRANSCRIPTION is refused too (rc=3): a check applied to one"
    printf '       of two copies is a check the other copy walks past\n'
  else
    bad "R7Cb the transcription copy still carries an unrecognised key unchallenged:${problems}"
  fi
}

# ---------------------------------------------------------------------------
# R7H — THE SUITE'S OWN SHARE. A corrupt --full-out must be reported by this
# suite, not fatal to it. Before round 7 the MEASURED case caught the corruption
# and the very next planter threw, `harness` exited 2, and twenty-one cases
# never reported.
# ---------------------------------------------------------------------------
{
  problems=""
  R7H="$(copy_of r7h)"
  IL="instr/0023-m-off__s-off__b-probe.jsonl"
  # Corrupt the LAST line of one instrument log the way a SIGKILL does: cut it
  # short. Nothing else is touched.
  node -e '
const fs = require("node:fs");
const p = `${process.argv[1]}/instr/0023-m-off__s-off__b-probe.jsonl`;
const lines = fs.readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
lines[lines.length - 1] = lines[lines.length - 1].slice(0, 40);   // a truncated tail
fs.writeFileSync(p, lines.join("\n") + "\n");
' "$R7H" || harness "R7H could not truncate the last line"
  CORRUPT="$(tail -1 "$R7H/$IL")"
  LN_H="$(grep -c . "$R7H/$IL")"

  # 1. THE PLANTER MUST SURVIVE IT. This is the exact D1 planter, re-run.
  set +e
  plant_two_in_window "$R7H" > "$WORK/.r7h-out" 2> "$WORK/.r7h-err"
  prc=$?
  set -e
  [[ "$prc" -eq 0 ]] || problems="${problems} the-planter-still-dies(rc=${prc})"
  grep -qF "${IL}:${LN_H} does not parse" "$WORK/.r7h-err" \
    || problems="${problems} the-planter-skipped-the-line-SILENTLY"
  # 2. …and must not have quietly repaired the directory behind the case's back.
  grep -qxF "$CORRUPT" "$R7H/$IL" || problems="${problems} the-planter-DELETED-the-corrupt-line"

  # 3. POSITIVE CONTROL for the note detector: it must not match a clean file.
  R7HC="$(copy_of r7h-clean)"
  set +e
  plant_two_in_window "$R7HC" > /dev/null 2> "$WORK/.r7h-clean-err"
  crc=$?
  set -e
  rm -rf "$R7HC"
  [[ "$crc" -eq 0 ]] || harness "R7H's positive control could not plant into the clean copy"
  grep -q "does not parse" "$WORK/.r7h-clean-err" \
    && problems="${problems} the-note-detector-fires-on-a-CLEAN-file"

  # 4. …and the verdict must REPORT the corruption rather than absorb it.
  verdict "$R7H"
  [[ "$RC" -eq 3 ]] || problems="${problems} verdict-rc=${RC}(want 3)"
  says "${IL}:${LN_H}" || problems="${problems} the-verdict-does-not-name-${IL}:${LN_H}"

  # 5. STRUCTURAL: no EXECUTABLE line of this file may still read JSONL with the
  #    throwing idiom. Comment lines are stripped first — every paragraph above
  #    that explains the defect quotes it — and so is this scan's own definition
  #    of what it is looking for. A zero-hit scan is only evidence once it has
  #    been shown to hit a planted instance THROUGH THE SAME STRIPPING PATH, so
  #    the control is a copy of the stripped file with one line appended.
  IDIOM='map((l) => JSON.parse(l))'
  awk '!/^[[:space:]]*(#|\/\/)/ && !/^[[:space:]]*IDIOM=/' "${BASH_SOURCE[0]}" > "$WORK/.r7h-code"
  [[ -s "$WORK/.r7h-code" ]] || harness "R7H stripped this file to nothing; the scan would be vacuous"
  cp "$WORK/.r7h-code" "$WORK/.r7h-code-probe"
  printf 'const evs = fs.readFileSync(p, "utf8").split("x").filter(Boolean).%s;\n' "$IDIOM" \
    >> "$WORK/.r7h-code-probe"
  grep -qF -- "$IDIOM" "$WORK/.r7h-code-probe" \
    || harness "R7H's idiom detector cannot find a planted instance; the scan below would be vacuous"
  if grep -qF -- "$IDIOM" "$WORK/.r7h-code"; then
    problems="${problems} $(grep -cF -- "$IDIOM" "$WORK/.r7h-code")-planting-helper(s)-still-JSON.parse-every-line"
  fi
  rm -rf "$R7H"

  if [[ -z "$problems" ]]; then
    ok "R7H an unparseable line in --full-out is REPORTED by this suite, not fatal to it: the planter"
    printf '       carries on and says so on stderr, the corrupt line survives it, the verdict names\n'
    printf '       %s:%s, and no helper in this file still throws on a line it cannot parse\n' "$IL" "$LN_H"
  else
    bad "R7H a corrupt artefact directory still stops the suite instead of being reported by it:${problems}"
  fi
}

# ---------------------------------------------------------------------------
printf '\n  %s passed, %s failed\n' "$pass" "$fail"

missing=""
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && found=1; done
  [[ "$found" -eq 1 ]] || missing="${missing} ${c}"
done
if [[ -n "$missing" ]]; then
  printf '  \033[1;31mFAIL\033[0m these cases never reported:%s\n' "$missing"
  fail=$(( fail + 1 ))
fi

COMPLETED=1
[[ "$fail" -eq 0 ]] || exit 1
exit 0
