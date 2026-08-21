#!/usr/bin/env bash
# ============================================================================
# k1-sensor-negative-controls.sh — ten ways to kill the canary, ten refusals
#
# Property (C) is that the sensor cannot be quietly removed. The old suite
# claimed it and did not have it: the arming check was a `prosrc LIKE '%marker%'`
# test that a comment satisfied, so a sabotage which kept the marker, kept the
# delegate, left `nt_canary.log_call` intact and deleted the one
# `perform nt_canary.log_call(...)` line produced a dead sensor that reported
# itself "armed", and the whole run printed PASS and exited 0.
#
# Each case below applies one sabotage to a real 0001-0023 clone on the pinned
# production image and requires the trusted runner to fail FOR THE INTENDED
# REASON. Asserting only "non-zero" would be satisfied by the runner crashing,
# so every case names the violation code it is aiming at. The runner reports
# every violation it finds rather than stopping at the first, which is what
# makes "the intended reason is among them" a meaningful assertion when a
# sabotage legitimately trips more than one detector.
#
# Case P0 is the positive control: with no sabotage the same sequence must
# succeed. Without it, a runner that refused everything would score ten out of
# ten and block every honest run.
#
# Usage:  ./k1-sensor-negative-controls.sh [--only N]
# Exit:   0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
VS="${RC}/sensor/verify-sensor.sh"
SAB="${RC}/sensor/sabotage"
# The fixture image is content-keyed; see tests/lib-schema-base.sh. A constant
# tag here would silently reuse a fixture built from other migrations.
# shellcheck source=lib-schema-base.sh
. "${HERE}/lib-schema-base.sh"
SCHEMA=0023
BASE_IMAGE=""

ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="${2:?}"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

BASE_IMAGE="$(schema_base_image "$SCHEMA")" || exit 2
schema_base_require "$SCHEMA" "$BASE_IMAGE" || exit 2
printf '   fixture image: %s\n' "$BASE_IMAGE"

WORK="$(mktemp -d /tmp/nt-k1nc-XXXXXX)"
C="nt-canary-k1nc-$$"
# ---------------------------------------------------------------------------
# THIS SUITE HAD NO SELF-ACCOUNTING.
#
# `rc=0` meant "nothing that ran objected", not "everything ran": deleting a
# case, or an early `exit` in the middle of one, left a SHORTER "N passed, 0
# failed" and nothing anywhere saying a case had gone. k11's own header records
# measuring exactly that on itself — deleting its N2 block left it printing
# "K11 GREEN" over ten of eleven cases. A count is not a roster.
#
# So the case tokens are a closed set, every ok/bad records the token it
# reported, the reported set is reconciled against the closed set at the end,
# and an EXIT trap turns "died before the summary" into a harness failure.
# ---------------------------------------------------------------------------
CASES_INTENDED=(P0 1 2 3 4 4b 5 5b 6 7 8 9 10a 10b 10c)
CASES_SEEN=()
COMPLETED=0
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }

cleanup() {
  local __rc=$?
  docker rm -f "$C" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk1: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$__rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( __rc == 0 ? 2 : __rc ))"
  fi
}
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }

# 5 CONSECUTIVE semantic queries as supabase_admin. Never pg_isready: this
# image restarts postgres during its own bootstrap and a socket probe answers
# from the temporary server that is about to go away.
boot() {
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker run -d --name "$C" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$BASE_IMAGE" >/dev/null
  local streak=0 waited=0 out
  while (( waited < 240 )); do
    if out="$(docker exec "$C" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -X -tA \
              -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage','vault')" 2>/dev/null)"; then
      if [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "5" ]]; then
        streak=$(( streak + 1 ))
        if (( streak >= 5 )); then return 0; fi
      else
        streak=0
      fi
    else
      streak=0
    fi
    sleep 1; waited=$(( waited + 1 ))
  done
  printf 'harness: %s never became ready\n' "$C" >&2
  exit 2
}

apply_sql() {  # file
  docker cp "$1" "$C:/sab.sql" >/dev/null
  docker exec -i "$C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f /sab.sql \
    > "$WORK/sab.out" 2> "$WORK/sab.err" \
    || { printf 'harness: sabotage %s failed to apply\n' "$1" >&2; sed 's/^/    /' "$WORK/sab.err" >&2; exit 2; }
}

# Runs the whole sensor lifecycle with a hook after `arm`. Collects every
# SENSOR_VIOLATION code emitted at any stage.
lifecycle() {  # state-dir, after-arm-hook (may be ""), skip-post(0|1)
  local state="$1" hook="$2" skip_post="${3:-0}"
  local log="$WORK/life.log"
  : > "$log"
  set +e
  "$VS" arm --pg "$C" --schema "$SCHEMA" --state "$state" \
        --artifact-digest "$(printf 'artifact-%s' "$RANDOM")" >> "$log" 2>&1
  local arm_rc=$?
  if [[ -n "$hook" ]]; then apply_sql "$hook"; fi
  "$VS" challenge --pg "$C" --state "$state" --phase mid --round 1 >> "$log" 2>&1
  if [[ "$skip_post" -eq 0 ]]; then
    "$VS" challenge --pg "$C" --state "$state" --phase post --round 0 >> "$log" 2>&1
  fi
  "$VS" report --pg "$C" --state "$state" >> "$log" 2>&1
  local rep_rc=$?
  set -e
  ARM_RC="$arm_rc"; REPORT_RC="$rep_rc"; LIFE_LOG="$log"
  CODES="$(awk '/^SENSOR_VIOLATION=/ { sub(/^SENSOR_VIOLATION=/, ""); print $1 }' "$log" | sort -u | tr '\n' ',' )"
}

expect() {  # label, wanted-code
  local label="$1" want="$2"
  if [[ "$REPORT_RC" -eq 0 ]]; then
    bad "$label: the run was reported TRUSTWORTHY (report rc=0)"
    sed -n '1,25p' "$LIFE_LOG" | sed 's/^/       /'
    return
  fi
  if [[ ",${CODES}" != *",${want},"* ]]; then
    bad "$label: refused (report rc=$REPORT_RC) but not for ${want}; codes: ${CODES:-none}"
    sed -n '1,30p' "$LIFE_LOG" | sed 's/^/       /'
    return
  fi
  ok "$label -> ${want} (report rc=$REPORT_RC; all codes: ${CODES%,})"
}

want() { [[ -z "$ONLY" || "$ONLY" == "$1" ]]; }

printf '\n== K1 sensor negative controls (image %s) ==\n\n' "$BASE_IMAGE"

# --- P0 POSITIVE CONTROL ----------------------------------------------------
if want P0; then
  boot
  lifecycle "$WORK/s-p0" "" 0
  if [[ "$REPORT_RC" -eq 0 ]] && grep -q 'SENSOR_RESULT=TRUSTWORTHY' "$LIFE_LOG"; then
    ok "P0 positive control: an unsabotaged sensor is TRUSTWORTHY ($(grep -c 'SENSOR_CHALLENGE=' "$LIFE_LOG") challenge events)"
  else
    bad "P0 positive control: an honest run was refused (rc=$REPORT_RC, codes: ${CODES:-none})"
    sed -n '1,40p' "$LIFE_LOG" | sed 's/^/       /'
  fi
fi

# --- 1. keep marker + delegate, remove the logging call ---------------------
if want 1; then
  boot; lifecycle "$WORK/s1" "$SAB/01_tombstone_wrappers.sql" 0
  expect "1  marker and delegate kept, logging call deleted" CHALLENGE_MISSING
fi

# --- 2. delete the sensor after the pre-check -------------------------------
if want 2; then
  boot; lifecycle "$WORK/s2" "$SAB/02_delete_sensor.sql" 0
  expect "2  the sensor is deleted after the pre-check" SENSOR_DISAPPEARED
fi

# --- 3. disable only the post-check ----------------------------------------
if want 3; then
  boot; lifecycle "$WORK/s3" "" 1
  expect "3  the post-matrix challenge is simply not run" PHASE_MISSING
fi

# --- 4. log only for a predictable pre-check input --------------------------
if want 4; then
  boot; lifecycle "$WORK/s4" "$SAB/04_predictable_input_only.sql" 0
  expect "4  the sensor records only the predictable 'arming-probe' tag" CHALLENGE_MISSING
  # ...and the point of the case: the OLD positive control still passes on this
  # very database, which is why a predictable probe was never evidence.
  docker cp "${RC}/sql/25_canary_arm.sql" "$C:/arm.sql" >/dev/null
  set +e
  docker exec -i "$C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f /arm.sql \
    > "$WORK/oldarm.out" 2> "$WORK/oldarm.err"
  old_rc=$?
  set -e
  if [[ "$old_rc" -eq 0 ]] && grep -Fq 'CANARY_ARMED=yes' "$WORK/oldarm.out"; then
    ok "4b the OLD predictable arming probe still reports CANARY_ARMED=yes on the same sabotaged clone"
  else
    bad "4b expected the old predictable probe to be fooled here (rc=$old_rc); the case is not demonstrating what it claims"
  fi
fi

# --- 5. write the event inside a transaction that rolls back ---------------
if want 5; then
  boot; lifecycle "$WORK/s5" "$SAB/05_only_table_insert.sql" 0
  expect "5  only a table insert, in the transaction the tombstone aborts" CHALLENGE_MISSING
  rows="$(docker exec "$C" psql -U postgres -d postgres -X -tA \
          -c "select count(*) from nt_canary.calls" | tr -d '[:space:]')"
  if [[ "$rows" == "0" ]]; then
    ok "5b and the detail table really is empty afterwards (rows=$rows): the evidence rolled back with the call"
  else
    bad "5b expected the rolled-back insert to leave no row, found $rows"
  fi
fi

# --- 6. return a fabricated counter ----------------------------------------
if want 6; then
  boot; lifecycle "$WORK/s6" "$SAB/06_fabricated_counter.sql" 0
  expect "6  a dead sensor with a lying nt_canary.hits()" COUNTER_FABRICATED
fi

# --- 7. duplicate an event --------------------------------------------------
if want 7; then
  boot; lifecycle "$WORK/s7" "$SAB/07_duplicate_event.sql" 0
  expect "7  one call recorded twice" CHALLENGE_DUPLICATE
fi

# --- 8. substitute a stale nonce -------------------------------------------
if want 8; then
  boot; lifecycle "$WORK/s8" "$SAB/08_stale_nonce.sql" 0
  expect "8  events tagged with a nonce from an earlier run" CHALLENGE_NONCE_MISMATCH
fi

# --- 9. alter an overload rather than the named function -------------------
if want 9; then
  boot; lifecycle "$WORK/s9" "$SAB/09_alter_overload.sql" 0
  expect "9  an uninstrumented overload added beside the watched signature" DEFINITION_DRIFT
fi

# --- 10. modify the expected definition from candidate-controlled code -----
if want 10; then
  boot
  STATE="$WORK/s10"
  # (a) a forged expectation planted where a candidate could write it must have
  #     no effect: the runner reads only its own trusted checkout.
  CAND="$WORK/candidate-controlled"
  mkdir -p "$CAND"
  printf '%064d\n' 0 > "$CAND/sensor-objects.${SCHEMA}.sha256"
  set +e
  "$VS" arm --pg "$C" --schema "$SCHEMA" --state "$STATE" \
        --artifact-digest cand10 > "$WORK/s10-arm.log" 2>&1
  a_rc=$?
  set -e
  if [[ "$a_rc" -eq 0 ]] && grep -q 'SENSOR_EXPECTED=matched-pin' "$WORK/s10-arm.log"; then
    ok "10a a forged expectation in a candidate-writable directory changes nothing"
  else
    bad "10a arm did not proceed from the trusted pin (rc=$a_rc)"
    sed -n '1,20p' "$WORK/s10-arm.log" | sed 's/^/       /'
  fi
  # (b) editing the sealed manifest without the run key
  python3 - "$STATE/manifest.json" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read().replace('"requiredPhases":"pre,mid,post"', '"requiredPhases":"pre"')
open(p, "w").write(s)
PY
  set +e
  "$VS" challenge --pg "$C" --state "$STATE" --phase mid --round 1 >> "$WORK/s10-arm.log" 2>&1
  "$VS" challenge --pg "$C" --state "$STATE" --phase post --round 0 >> "$WORK/s10-arm.log" 2>&1
  "$VS" report --pg "$C" --state "$STATE" >> "$WORK/s10-arm.log" 2>&1
  r_rc=$?
  set -e
  CODES="$(awk '/^SENSOR_VIOLATION=/ { sub(/^SENSOR_VIOLATION=/, ""); print $1 }' "$WORK/s10-arm.log" | sort -u | tr '\n' ',')"
  REPORT_RC="$r_rc"; LIFE_LOG="$WORK/s10-arm.log"
  expect "10b the sealed run manifest edited after the fact" MANIFEST_HMAC_INVALID
  # (c) a digest handed to the runner as an argument
  set +e
  out="$("$VS" arm --pg "$C" --schema "$SCHEMA" --state "$WORK/s10c" \
         --artifact-digest x --expected-digest "$(printf '%064d' 0)" 2>&1)"
  c_rc=$?
  set -e
  if [[ "$c_rc" -ne 0 ]] && grep -q 'is not accepted' <<< "$out"; then
    ok "10c a caller-supplied expected digest is refused by name (rc=$c_rc)"
  else
    bad "10c a caller-supplied expected digest was accepted (rc=$c_rc)"
    printf '%s\n' "$out" | sed 's/^/       /'
  fi
fi

# --- the closed-set check on this suite's own coverage -----------------------
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
# DISTINCT, not the raw count: a case that legitimately reports more than once
# (k3's case 12 runs for the bootstrap and for the seed) would otherwise print
# "14 of 13 intended cases reported", which reads as a defect and is not one.
DISTINCT_SEEN="$(printf '%s\n' "${CASES_SEEN[@]}" | LC_ALL=C sort -u | wc -l)"
COMPLETED=1
printf '\n  %s passed, %s failed (%s of %s intended cases reported)\n\n' \
  "$pass" "$fail" "$DISTINCT_SEEN" "${#CASES_INTENDED[@]}"
[[ "$fail" -eq 0 ]]
