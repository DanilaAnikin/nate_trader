#!/usr/bin/env bash
# ============================================================================
# k4-partial-run.test.sh — a subset of the matrix cannot be a PASS
#
# `--cells N` used to print, after driving one of twenty-four environment
# combinations:
#
#     PASS every cell refused with 503 and the canary never fired.
#
# and exit 0. "every cell" was one cell. Nothing in the verdict knew the run
# had been truncated, and nothing in the exit status said so.
#
# Cases (all run against REAL artefact directories produced by run.sh, so this
# is the shipped verdict on shipped output, not a mock):
#
#   1  a 1-of-24 artefact set, declared as such -> PARTIAL, exit 4, no "PASS"
#   2  a 24-cell x BOTH-generation artefact set -> PASS, exit 0
#   3  a 1-of-24 artefact set declared COMPLETE -> refused on cardinality,
#      exit 3. This is the one that matters: a truncated run must not be able
#      to buy a PASS by claiming to be whole.
#   4  a 24-of-24 artefact set on ONE generation -> PARTIAL on the SCHEMA axis,
#      exit 4. The matrix is 24 combinations x 2 migration generations = 48, and
#      the schema half of that was not folded into the partial verdict: a
#      `--schema 0023` run drove 24 of 48 and printed the unqualified banner
#      "PASS all 24 environment combinations".
#
# Usage:
#   k4-partial-run.test.sh --partial-out DIR --full-out DIR [--schema 0023]
#
#   --full-out must come from a `run.sh --schema both` run for case 2 to be
#   able to run at all; a single-generation directory exercises case 4 and
#   reports case 2 as a failure rather than quietly passing a weaker control.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
VERDICT="${RC}/driver/verdict.mjs"
MANIFEST="${RC}/expected/request-manifest.json"

PARTIAL_OUT=""
FULL_OUT=""
SCHEMA=0023
while [[ $# -gt 0 ]]; do
  case "$1" in
    --partial-out) PARTIAL_OUT="${2:?}"; shift 2 ;;
    --full-out)    FULL_OUT="${2:?}";    shift 2 ;;
    --schema)      SCHEMA="${2:?}";      shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
for v in PARTIAL_OUT FULL_OUT; do
  [[ -n "${!v}" ]] || { printf 'k4: --%s is required\n' "${v,,}" >&2; exit 2; }
  [[ -d "${!v}" ]] || { printf 'k4: %s is not a directory\n' "${!v}" >&2; exit 2; }
done

pass=0; fail=0
# The closed set of cases. Case 4 used to sit inside `if [[ -n "$first_schema"
# && ... ]]` with no else, so an artefact directory that named no generation
# made the A2 schema-axis regression test disappear from a summary that still
# read "3 passed, 0 failed". A case that can vanish without the count changing
# is a case that is not being run.
CASES_INTENDED=(1 2 3 4)
CASES_SEEN=()
COMPLETED=0

# --- detecting the PASS banner, which is not a plain-text search -------------
# The verdict colours its verdict word, so the bytes are
#   ESC[1;32m PASS ESC[0m " all 24 environment combinations ..."
# and the obvious `grep -q 'PASS all '` NEVER matches. Both this suite and K9
# were briefly written that way, which made every "the banner must not appear"
# assertion vacuously true — a negative control that cannot fail. So the escapes
# are stripped first, and `no_pass_banner` is proved against a planted banner
# before it is trusted.
strip_ansi() { sed -e 's/\x1b\[[0-9;]*m//g'; }
# NOT `strip_ansi | grep -q`. `grep -q` exits at its FIRST match and closes the
# pipe; sed then dies of SIGPIPE with status 141, and under `set -o pipefail`
# the PIPELINE's status is 141 even though grep matched. So this function
# returned "no banner" at random — and `no_pass_banner`, a NEGATIVE CONTROL,
# then passed for precisely the reason it must never pass for: the check did not
# run. MEASURED, on an 85492-byte refusal transcript whose needle is present:
# `sed … | grep -qF` reported it ABSENT in 32 of 200 trials; strip-into-a-
# variable-then-grep reported it absent in 0 of 200. It first showed up as two
# runs of one suite over one artefact directory going red on three different
# cases between them, none of them a real failure. The command substitution
# drains sed to completion before grep sees a byte, so there is no pipe to
# break.
has_pass_banner() {  # reads stdin
  local text; text="$(strip_ansi)"
  grep -qE '^PASS all [0-9]+ environment combinations' <<< "$text"
}
no_pass_banner() { ! has_pass_banner; }
# POSITIVE CONTROL for the detector itself.
if ! printf '\033[1;32mPASS\033[0m all 24 environment combinations x 2 migration generations\n' \
     | has_pass_banner; then
  printf '%s: the PASS-banner detector cannot find a planted banner; every banner assertion below would be vacuous\n' \
    "$(basename "${BASH_SOURCE[0]}")" >&2
  exit 2
fi
if printf 'PARTIAL 24 of 48 environment/schema combinations were driven\n' | has_pass_banner; then
  printf '%s: the PASS-banner detector matches a PARTIAL line\n' "$(basename "${BASH_SOURCE[0]}")" >&2
  exit 2
fi
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }

sensor_hits_for() {  # out-dir, [schema] -> the value run.sh recorded, or 0
  local f="$1/sensor-report-${2:-$SCHEMA}.txt"
  local rounds
  if [[ -f "$f" ]]; then
    rounds="$(sed -n 's/.*|rounds=\([0-9]*\)|.*/\1/p' "$f" | head -1)"
    # the pre round happened before the baseline; the rest did not
    [[ -n "$rounds" ]] && { printf '%s' $(( (rounds - 1) * 3 )); return; }
  fi
  printf '0'
}

# The probe identity, needed to expand the manifest's __PROBE_USER_ID__ pin.
PROBE_USER_ID="$(node "${RC}/driver/keys.mjs" --print-shell | sed -n 's/^CANARY_PROBE_USER_ID=//p')"
[[ -n "$PROBE_USER_ID" ]] || { printf 'k4: could not determine the probe user id\n' >&2; exit 2; }

K4_WORK="$(mktemp -d /tmp/nt-k4-XXXXXX)"
cleanup() {
  local rc=$?
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk4: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    rm -rf "$K4_WORK"
    exit "$(( rc == 0 ? 2 : rc ))"
  fi
  rm -rf "$K4_WORK"
}
trap cleanup EXIT

run_verdict() {  # out-dir, cells-run, cells-total, [schemas] -> OUTPUT, RC
  local given="$1" run="$2" total="$3" schemas="${4:-$SCHEMA}"
  # ALWAYS over a private copy. The verdict writes verdict-scope.json into the
  # directory it is pointed at, so running this suite over a real artefact
  # directory used to overwrite that run's own machine-readable verdict with
  # whichever of these four cases happened to go last -- a 48-cell PASS
  # directory came back recording "status": "PARTIAL". The evidence a suite is
  # given to read is not the suite's to rewrite.
  local out="${K4_WORK}/$(basename "$given")-$$-${RANDOM}"
  cp -a "$given" "$out"
  local hits=()
  local s
  for s in ${schemas//,/ }; do hits+=(--sensor-verdict "${s}=TRUSTWORTHY"); done
  for s in ${schemas//,/ }; do hits+=(--sensor-hits "${s}=$(sensor_hits_for "$out" "$s")"); done
  set +e
  OUTPUT="$(node "$VERDICT" --out "$out" --mode frozen --break-sensor none \
    --schemas "$schemas" --manifest "$MANIFEST" \
    --cells-run "$run" --cells-total "$total" \
    --probe-user-id "$PROBE_USER_ID" \
    "${hits[@]}" 2>&1)"
  RC=$?
  set -e
}

printf '\n== K4 a partial run is a distinct status, never a PASS ==\n\n'

# --- 1. declared partial ----------------------------------------------------
run_verdict "$PARTIAL_OUT" 1 24
# The banner, not the word: the PARTIAL explanation legitimately contains the
# sentence "this is not a PASS", and an over-broad grep matched it. What must
# never appear is the verdict line itself.
if [[ "$RC" -eq 4 ]] && grep -q 'PARTIAL' <<< "$OUTPUT" && no_pass_banner <<< "$OUTPUT"; then
  ok "1 a 1-of-24 run is PARTIAL and exits 4, and the PASS banner is never printed"
else
  bad "1 a 1-of-24 run did not produce a clean PARTIAL (rc=$RC)"
  grep -E 'PASS|PARTIAL|FINDING|INCOMPLETE' <<< "$OUTPUT" | sed 's/^/       /'
fi

# --- 2. the complete run ----------------------------------------------------
# The POSITIVE CONTROL, and it now has to be complete on BOTH axes. The matrix
# is 24 environment combinations on each of two migration generations, so a
# 24-of-24 run on one generation is 24 of 48 and cannot be the control for
# "a complete run passes" — it is case 4 below.
MANIFEST_SCHEMAS="$(node -e 'process.stdout.write(require(process.argv[1]).schemas.join(","))' "$MANIFEST")"
FULL_SCHEMAS=""
for s in ${MANIFEST_SCHEMAS//,/ }; do
  if compgen -G "$FULL_OUT/cells/result-${s}-*.json" > /dev/null; then
    FULL_SCHEMAS="${FULL_SCHEMAS:+${FULL_SCHEMAS},}${s}"
  fi
done
if [[ "$FULL_SCHEMAS" == "$MANIFEST_SCHEMAS" ]]; then
  run_verdict "$FULL_OUT" 24 24 "$MANIFEST_SCHEMAS"
  if [[ "$RC" -eq 0 ]] && has_pass_banner <<< "$OUTPUT" && ! grep -q 'PARTIAL' <<< "$OUTPUT"; then
    ok "2 positive control: 24 cells x ${MANIFEST_SCHEMAS} is a PASS and exits 0"
  else
    bad "2 a complete run was not a PASS (rc=$RC)"
    grep -E 'PASS|PARTIAL|FINDING|INCOMPLETE|hard' <<< "$OUTPUT" | head -20 | sed 's/^/       /'
  fi
else
  bad "2 --full-out covers generations [${FULL_SCHEMAS:-none}], not [${MANIFEST_SCHEMAS}]; the PASS control cannot run"
  printf '       give a --full-out from `run.sh --schema both`; a single-generation directory is case 4\n'
fi

# --- 4. the OTHER truncated axis -------------------------------------------
# The same defect as case 1, on the schema dimension. A 24-of-24 run on one
# generation used to print the unqualified PASS banner: "all 24 environment
# combinations", over half the matrix.
first_schema="${FULL_SCHEMAS%%,*}"
if [[ -z "$first_schema" ]]; then
  bad "4 --full-out holds no cells for any generation the manifest names, so the schema-axis regression test could not run"
elif [[ "$MANIFEST_SCHEMAS" != *,* ]]; then
  bad "4 the manifest names one generation (${MANIFEST_SCHEMAS}); there is no schema axis to truncate, so this case cannot test what it claims"
else
  run_verdict "$FULL_OUT" 24 24 "$first_schema"
  if [[ "$RC" -eq 4 ]] && grep -q 'schema axis' <<< "$OUTPUT" && no_pass_banner <<< "$OUTPUT"; then
    ok "4 all 24 cells on ONE of ${MANIFEST_SCHEMAS} is PARTIAL on the schema axis (rc=$RC), never PASS"
  else
    bad "4 a single-generation run was not PARTIAL on the schema axis (rc=$RC)"
    grep -E 'PASS all|PARTIAL|schema axis' <<< "$OUTPUT" | head -10 | sed 's/^/       /'
  fi
fi

# --- 3. a truncated run claiming to be complete -----------------------------
run_verdict "$PARTIAL_OUT" 24 24
if [[ "$RC" -eq 3 ]] && grep -q 'cell result files, the manifest requires 24' <<< "$OUTPUT"; then
  ok "3 a 1-of-24 run that CLAIMS to be complete is refused on cardinality (rc=$RC)"
else
  bad "3 a truncated run bought a verdict by claiming to be whole (rc=$RC)"
  grep -E 'PASS|PARTIAL|INCOMPLETE|cell result' <<< "$OUTPUT" | head -10 | sed 's/^/       /'
fi

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
