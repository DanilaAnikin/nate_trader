#!/usr/bin/env bash
# ============================================================================
# k2-sensor-removal.test.sh — removing ANY sensor must break completeness
#
# The defect this closes was not "one claim was wrong". It was that three
# claims CEASED TO EXIST when the observer behind them was missing, and the row
# printed clean. So the requirement is not "each claim has a detector" but
# "removing any individual detector fails the run rather than removing its
# claim".
#
# This walks every sensor in the closed schema, marks it dead in a copy of a
# REAL cell artefact produced by run.sh, and requires the shipped verdict to:
#   * exit 3 (a control failed), and
#   * report EXACTLY the claims that name that sensor as INDETERMINATE — no
#     fewer (the claim did not vanish) and no more (the failure is scoped).
#
# The `driver` sensor is the exception and is checked differently: the driver
# is what produces the record, so its absence is a missing sensor BLOCK, which
# must also be a hard failure.
#
# TWO DEFECTS FOUND IN THIS FILE BY A SECOND AUDIT, both of the same family —
# a check that cannot fail:
#
#  1. THE ASSERTION WAS SATISFIED BY CONSTRUCTION. It read
#         for c in $want; do grep -q "$c" <<< "$OUTPUT" || missing+=("$c"); done
#     against the verdict's whole transcript. verdict.mjs prints, once per
#     schema and before anything can fail,
#         claims required per request (16): requestDriven, routeMatched, …
#     — every claim name in the closed set, unconditionally. So `grep -q` was
#     TRUE for all sixteen claims on every run, the branch
#     "refused, but these dependent claims were never named" could never
#     execute, and the suite would not have noticed a verdict that dropped a
#     claim entirely. Measured: with NO sensor removed at all, all sixteen
#     names still match. The assertion now reads the per-claim tally out of
#     verdict-scope.json AS DATA and requires SET EQUALITY with the dependency
#     map, which also makes it discriminating — removing `coverage` must not
#     make `noBodyParse` indeterminate, and the old grep could not tell.
#
#  2. AN EMPTY SENSOR LIST WAS A PASS. `mapfile -t SENSORS < <(node … )` leaves
#     SENSORS empty when the import fails — a rename of `ALL_SENSORS` in
#     claims.mjs is enough, and this programme has already had one half-applied
#     rename kill a suite three cases from the end. The loop then ran zero
#     times and the file printed "2 passed, 0 failed" and exited 0, which
#     run-all.sh records as `K2 sensor removal   PASS`. Measured, verbatim.
#     The sensor set is now pinned HERE, in a different file from the one it is
#     read out of, and a disagreement in either direction is a harness failure.
#
# The reader itself has a POSITIVE CONTROL (case `baseline`), run FIRST: over
# the untouched artefacts every claim must be readable, with satisfied > 0 and
# indeterminate == 0. A reader that always returns "no indeterminate claims"
# would make every case below vacuous, and that is the same defect one level in.
#
# Usage:  k2-sensor-removal.test.sh --out DIR [--schema 0023]
#   DIR is an artefact directory from a completed run.sh run. It is COPIED
#   before anything is done to it and is never modified in place.
# ============================================================================

set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
VERDICT="${RC}/driver/verdict.mjs"
CLAIMS="${RC}/driver/claims.mjs"
MANIFEST="${RC}/expected/request-manifest.json"

SRC_OUT=""
SCHEMA=0023
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)    SRC_OUT="${2:?}"; shift 2 ;;
    --schema) SCHEMA="${2:?}";  shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -d "$SRC_OUT" ]] || { printf 'k2-sensor-removal: --out must be a run.sh artefact directory\n' >&2; exit 2; }

WORK="$(mktemp -d /tmp/nt-k2sr-XXXXXX)"

pass=0; fail=0
CASES_SEEN=()
COMPLETED=0
# The closed set of cases this file intends to report on, resolved after the
# sensor set is validated. An EXIT trap turns "died before the summary" into a
# loud harness failure instead of a short list that reads as a clean sweep.
CASES_INTENDED=()
cleanup() {
  local rc=$?
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk2-sensor-removal: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    rm -rf "$WORK"
    exit "$(( rc == 0 ? 2 : rc ))"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# The case token is the first word of the message, with a trailing colon
# stripped: "driver: …" and "driver removed …" are the same case.
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }
harness() { printf 'k2-sensor-removal harness: %s\n' "$*" >&2; rm -rf "$WORK"; trap - EXIT; exit 2; }

# --- the closed sensor set, pinned HERE -------------------------------------
# Duplicated on purpose, in a different file from claims.mjs. A list checked
# only against itself checks nothing: an emptied or renamed export would empty
# the loop, and an empty loop used to be a pass.
SENSORS_EXPECTED=(driver response instrument coverage routeCoverage sink canary sensorRunner)

SENSORS=()
if ! mapfile -t SENSORS < <(node --input-type=module -e '
  const { ALL_SENSORS } = await import(process.argv[1]);
  if (!Array.isArray(ALL_SENSORS)) { console.error("ALL_SENSORS is not an array"); process.exit(1); }
  for (const s of ALL_SENSORS) console.log(s);
' "$CLAIMS"); then
  harness "could not read ALL_SENSORS out of ${CLAIMS}"
fi
# mapfile succeeds with zero lines when the process substitution fails, so the
# emptiness is checked explicitly rather than inferred from an exit status.
[[ "${#SENSORS[@]}" -gt 0 ]] \
  || harness "ALL_SENSORS read as an EMPTY set; a suite that walks no sensors is not a suite that passed"
{
  a="$(printf '%s\n' "${SENSORS[@]}" | LC_ALL=C sort | tr '\n' ',')"
  b="$(printf '%s\n' "${SENSORS_EXPECTED[@]}" | LC_ALL=C sort | tr '\n' ',')"
  [[ "$a" == "$b" ]] || harness "the sensor set has changed: claims.mjs says [${a%,}], this test pins [${b%,}]. Change both, deliberately."
}

# The claims each sensor decides, read from the map the verdict itself uses.
claims_for() {  # sensor -> space-separated claim names
  node --input-type=module -e '
    const { CLAIM_SENSORS } = await import(process.argv[1]);
    const s = process.argv[2];
    console.log(Object.entries(CLAIM_SENSORS).filter(([, v]) => v.includes(s)).map(([k]) => k).sort().join(" "));
  ' "$CLAIMS" "$1"
}

# The claims the verdict actually reported as INDETERMINATE, as data. This is
# the reader the positive control below proves live.
indeterminate_claims() {  # verdict-scope.json -> space-separated claim names
  node -e '
    const fs=require("node:fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const t=j.claimStatus;
    if (!t || typeof t !== "object") { console.error("no claimStatus"); process.exit(1); }
    console.log(Object.entries(t).filter(([, v]) => (v.indeterminate|0) > 0).map(([k]) => k).sort().join(" "));
  ' "$1"
}
tally_readable() {  # verdict-scope.json -> "claims satisfied>0 indeterminate==0" summary or fails
  node -e '
    const fs=require("node:fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const t=j.claimStatus||{};
    const names=Object.keys(t);
    const noSat=names.filter((k)=>(t[k].satisfied|0)===0);
    const anyInd=names.filter((k)=>(t[k].indeterminate|0)>0);
    if (!names.length) { console.error("empty"); process.exit(1); }
    console.log(JSON.stringify({claims:names.length,withoutSatisfied:noSat,indeterminate:anyInd}));
  ' "$1"
}

sensor_hits() {
  local f="$1/sensor-report-${SCHEMA}.txt" rounds
  if [[ -f "$f" ]]; then
    rounds="$(sed -n 's/.*|rounds=\([0-9]*\)|.*/\1/p' "$f" | head -1)"
    [[ -n "$rounds" ]] && { printf '%s' $(( (rounds - 1) * 3 )); return; }
  fi
  printf '0'
}

prepare() {  # -> a writable copy of the artefact directory
  rm -rf "$WORK/out"
  cp -a "$SRC_OUT" "$WORK/out"
  chmod -R u+w "$WORK/out"
  rm -f "$WORK/out/verdict-scope.json"   # never read the input run's own verdict
}

run_verdict() {  # [--no-sensor-verdict]
  local args=(--out "$WORK/out" --mode frozen --break-sensor none
              --schemas "$SCHEMA" --manifest "$MANIFEST"
              --cells-run 24 --cells-total 24
              --sensor-hits "${SCHEMA}=$(sensor_hits "$SRC_OUT")")
  [[ "${1:-}" == "--no-sensor-verdict" ]] || args+=(--sensor-verdict "${SCHEMA}=TRUSTWORTHY")
  set +e
  OUTPUT="$(node "$VERDICT" "${args[@]}" 2>&1)"
  RC_=$?
  set -e
  SCOPE="$WORK/out/verdict-scope.json"
}

kill_sensor_in_files() {  # sensor
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const dir = process.argv[1], sensor = process.argv[2], schema = process.argv[3];
    let n = 0;
    for (const f of fs.readdirSync(path.join(dir, "cells"))) {
      if (!f.startsWith(`result-${schema}-`) || !f.endsWith(".json")) continue;
      const p = path.join(dir, "cells", f);
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const r of j.results) {
        r.sensors = r.sensors || {};
        r.sensors[sensor] = { live: false, reason: "removed by the sensor-removal control" };
        n++;
      }
      fs.rmSync(p, { force: true });
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    }
    if (n === 0) { console.error("the control edited NO request records"); process.exit(1); }
  ' "$WORK/out" "$1" "$SCHEMA" || harness "could not remove sensor '$1' from the artefact copy"
}

# CASES_INTENDED can be resolved now: the reader control, one case per
# non-driver sensor, the driver block, and the end-to-end control.
CASES_INTENDED=(baseline)
for s in "${SENSORS[@]}"; do [[ "$s" == driver ]] || CASES_INTENDED+=("$s"); done
CASES_INTENDED+=(driver control)

printf '\n== K2 removing any one sensor must fail completeness ==\n'
printf '   sensors in the closed schema: %s\n\n' "${SENSORS[*]}"

# --- baseline: THE POSITIVE CONTROL ON THIS SUITE'S OWN READER ---------------
# Runs FIRST. Without it, every "these claims went indeterminate" assertion
# below could be satisfied by a reader that reports the same thing whatever it
# is given, which is exactly the defect this file exists to close one level up.
prepare
run_verdict
if ! SUMMARY="$(tally_readable "$SCOPE" 2>&1)"; then
  bad "baseline the per-claim tally could not be read from verdict-scope.json (${SUMMARY}); every case below would be vacuous"
else
  n_claims="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).claims))' "$SUMMARY")"
  no_sat="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).withoutSatisfied.join(",")) ' "$SUMMARY")"
  any_ind="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).indeterminate.join(",")) ' "$SUMMARY")"
  if [[ "$n_claims" -lt 16 ]]; then
    bad "baseline the tally lists only ${n_claims} claims; the closed set is 16"
  elif [[ -n "$no_sat" ]]; then
    bad "baseline these claims were never satisfied on untouched artefacts: ${no_sat}"
  elif [[ -n "$any_ind" ]]; then
    bad "baseline untouched artefacts already have indeterminate claims (${any_ind}); the cases below cannot discriminate"
  else
    ok "baseline positive control: all ${n_claims} claims readable, every one satisfied and none indeterminate (rc=$RC_)"
  fi
fi

# --- one case per sensor ------------------------------------------------------
for sensor in "${SENSORS[@]}"; do
  [[ "$sensor" == "driver" ]] && continue
  prepare
  kill_sensor_in_files "$sensor"
  # canary / sensorRunner are supplied host-side by the verdict, so those two
  # are removed by withholding their inputs as well.
  #
  # `sensorRunner` used to be removed by withholding `--sensor-verdict` alone.
  # Audit finding F closed that: the verdict no longer takes the sensor verdict
  # from argv at all, it DERIVES it from `sensor-report-<schema>.txt` — which is
  # the repair, and which means withholding the flag now changes nothing and the
  # case scored rc=4 instead of rc=3. Removing this sensor means removing the
  # trusted runner's own report, exactly as removing `canary` means removing the
  # canary reading. The flag is withheld too, so the case is the full "the runner
  # said nothing, anywhere" state.
  case "$sensor" in
    canary)       rm -f "$WORK/out/canary-${SCHEMA}.txt" ;;
    sensorRunner) rm -f "$WORK/out/sensor-report-${SCHEMA}.txt" ;;
  esac

  if [[ "$sensor" == "sensorRunner" ]]; then
    run_verdict --no-sensor-verdict
  else
    run_verdict
  fi

  want="$(claims_for "$sensor")"
  if [[ -z "$want" ]]; then
    bad "$sensor no claim in CLAIM_SENSORS names this sensor; the case cannot assert anything"
    continue
  fi
  if [[ ! -f "$SCOPE" ]]; then
    bad "$sensor the verdict wrote no verdict-scope.json (rc=$RC_); the tally cannot be read"
    grep -E 'PASS|FINDING|INCOMPLETE|MANIFEST|PROVENANCE' <<< "$OUTPUT" | head -3 | sed 's/^/       /'
    continue
  fi
  got="$(indeterminate_claims "$SCOPE")"
  if [[ "$RC_" -ne 3 ]]; then
    bad "$sensor: the run was not refused (rc=$RC_); a removed sensor must fail the run"
    grep -E 'PASS|FINDING|INCOMPLETE' <<< "$OUTPUT" | head -3 | sed 's/^/       /'
  elif ! grep -qE 'INCOMPLETE OBSERVATION|SENSOR_IGNORED' <<< "$OUTPUT"; then
    bad "$sensor: refused for some other reason than incomplete observation"
    grep -E 'FINDING|INCOMPLETE|hard' <<< "$OUTPUT" | head -3 | sed 's/^/       /'
  elif [[ "$got" != "$want" ]]; then
    # Both directions, named. Too few means a claim disappeared with its sensor
    # — the original defect. Too many means the failure is not scoped to the
    # sensor that was removed, and the case is not discriminating.
    missing=""; extra=""
    for c in $want; do [[ " $got " == *" $c "* ]] || missing="${missing} $c"; done
    for c in $got;  do [[ " $want " == *" $c "* ]] || extra="${extra} $c"; done
    bad "$sensor: the INDETERMINATE set is not the dependency set${missing:+ (never reported indeterminate:${missing})}${extra:+ (indeterminate but does not name this sensor:${extra})}"
  else
    ok "$sensor removed -> refused (rc=$RC_), and exactly its dependent claims are INDETERMINATE: $(tr ' ' ',' <<< "$want")"
  fi
done

# --- the driver's own record block ------------------------------------------
prepare
node -e '
  const fs = require("node:fs"), path = require("node:path");
  const dir = process.argv[1], schema = process.argv[2];
  let n = 0;
  for (const f of fs.readdirSync(path.join(dir, "cells"))) {
    if (!f.startsWith(`result-${schema}-`) || !f.endsWith(".json")) continue;
    const p = path.join(dir, "cells", f);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const r of j.results) { delete r.sensors; n++; }
    fs.rmSync(p, { force: true });
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  }
  if (n === 0) { console.error("edited no records"); process.exit(1); }
' "$WORK/out" "$SCHEMA" || harness "could not strip the sensor blocks"
run_verdict
if [[ "$RC_" -eq 3 ]] && grep -q 'reported no sensor block' <<< "$OUTPUT"; then
  ok "driver: a result with no sensor block at all is refused (rc=$RC_)"
else
  bad "driver: a result with no sensor block was accepted (rc=$RC_)"
  grep -E 'INCOMPLETE|sensor block|PASS|PARTIAL' <<< "$OUTPUT" | head -5 | sed 's/^/       /'
fi

# --- POSITIVE CONTROL: unmodified artefacts must still be usable ------------
prepare
run_verdict
if [[ "$RC_" -eq 0 ]] || grep -q 'PROPERTY A' <<< "$OUTPUT"; then
  ok "control: the untouched artefact set still reaches a verdict (rc=$RC_)"
else
  bad "control: the untouched artefact set was refused (rc=$RC_)"
  grep -E 'INCOMPLETE|hard|- ' <<< "$OUTPUT" | head -5 | sed 's/^/       /'
fi

# --- the closed-set check on this suite's own coverage -----------------------
missing_cases=()
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && { found=1; break; }; done
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
