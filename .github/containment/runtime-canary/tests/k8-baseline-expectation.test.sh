#!/usr/bin/env bash
# ============================================================================
# k8-baseline-expectation.test.sh — the documented pre-canary baseline must be
#                                   the observed one, and must be checked
#
# `sql/18_prewrapper_baseline.sql` documented, in prose, that on the 0001-0008
# schema "create returns a uuid; update and delete raise". The observed
# baseline on the pinned production image is all three RETURNING. Nothing
# compared the two, so the paragraph was free to be wrong indefinitely — and
# was.
#
# The correction is not only to the prose. The expected string is now recorded
# per schema in `sql/expected-baseline.<schema>.txt` and asserted by run.sh, so
# the prose is bound to something a run can fail on.
#
# Cases:
#   P1/P2  the recorded expectation matches what the schema really does
#   D1/D2  the prose in 18_prewrapper_baseline.sql agrees with the recorded
#          expectation (a comment that drifts from the file beside it is the
#          original defect returning)
#   N1     a wrong recorded expectation is detected (the comparison works)
#
# Exit: 0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
# shellcheck source=lib-schema-base.sh
. "${HERE}/lib-schema-base.sh"
PROBE="${RC}/sql/18_prewrapper_baseline.sql"

C="nt-canary-k8t-$$"
WORK="$(mktemp -d /tmp/nt-k8-XXXXXX)"
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
CASES_INTENDED=(P/0008 D/0008 P/0023 D/0023 N1)
CASES_SEEN=()
COMPLETED=0
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }

cleanup() {
  local __rc=$?
  docker rm -f "$C" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk8: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$__rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( __rc == 0 ? 2 : __rc ))"
  fi
}
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }

boot() {
  docker rm -f "$C" >/dev/null 2>&1 || true
  # Resolved into a variable with its status checked, NOT inline in the docker
  # argument list: a command substitution that fails inside a word expansion
  # does not trip errexit, and the container would start on an empty image name
  # (or, worse, the wrong one) with nothing said about it.
  local base
  if ! base="$(schema_base_image "$1")"; then
    printf 'harness: could not resolve the %s fixture image\n' "$1" >&2
    return 1
  fi
  if ! schema_base_require "$1" "$base"; then
    printf 'harness: the %s fixture image is not the content-keyed fixture\n' "$1" >&2
    return 1
  fi
  docker run -d --name "$C" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$base" >/dev/null
  local streak=0 waited=0 out
  while (( waited < 240 )); do
    if out="$(docker exec "$C" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -X -tA \
              -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage','vault')" 2>/dev/null)"; then
      if [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "5" ]]; then
        streak=$(( streak + 1 )); (( streak >= 5 )) && return 0
      else streak=0; fi
    else streak=0; fi
    sleep 1; waited=$(( waited + 1 ))
  done
  printf 'harness: %s never became ready\n' "$C" >&2; exit 2
}

observe() {  # -> the BASELINE_OUTCOME line the schema really produces
  docker cp "$PROBE" "$C:/b.sql" >/dev/null
  docker exec -i "$C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f /b.sql 2>/dev/null \
    | grep -m1 -F 'BASELINE_OUTCOME='
}

printf '\n== K8 the recorded pre-canary baseline ==\n\n'

for gen in 0008 0023; do
  boot "$gen"
  observed="$(observe)"
  expected_file="${RC}/sql/expected-baseline.${gen}.txt"
  if [[ ! -f "$expected_file" ]]; then
    bad "P/${gen} no recorded expectation at ${expected_file}"
    continue
  fi
  expected="$(head -1 "$expected_file" | tr -d '\r')"
  if [[ "$observed" == "$expected" ]]; then
    ok "P/${gen} recorded expectation matches the schema: ${observed#BASELINE_OUTCOME=}"
  else
    bad "P/${gen} mismatch
       observed: $observed
       recorded: $expected"
  fi

  # The prose must agree with the recorded string, per wrapper. This is the
  # check whose absence let the old paragraph say "update and delete raise"
  # while all three returned.
  doc_block="$(sed -n '/THE OBSERVED OUTCOMES, PER SCHEMA/,/^-- ===/p' "$PROBE")"
  gen_label="$([[ "$gen" == "0008" ]] && echo '0001-0008' || echo '0001-0023')"
  doc_says_all_return=0
  grep -Fq "$gen_label  ALL THREE RETURN" <<< "$doc_block" && doc_says_all_return=1
  doc_says_all_raise=0
  grep -Fq "$gen_label  ALL THREE RAISE" <<< "$doc_block" && doc_says_all_raise=1
  obs_all_return=0; obs_all_raise=0
  [[ "$(grep -o 'returned' <<< "$observed" | wc -l)" == "3" ]] && obs_all_return=1
  [[ "$(grep -o 'raised:' <<< "$observed" | wc -l)" == "3" ]] && obs_all_raise=1
  if [[ "$doc_says_all_return" == "$obs_all_return" && "$doc_says_all_raise" == "$obs_all_raise" \
        && $(( doc_says_all_return + doc_says_all_raise )) -eq 1 ]]; then
    ok "D/${gen} the prose in 18_prewrapper_baseline.sql agrees with the observation"
  else
    bad "D/${gen} the prose does not agree (doc: allReturn=$doc_says_all_return allRaise=$doc_says_all_raise; observed: allReturn=$obs_all_return allRaise=$obs_all_raise)"
  fi
done

# --- N1 a wrong recorded expectation must be detectable ---------------------
# The comparison run.sh performs, exercised directly against a deliberately
# wrong expectation — the exact claim the old prose made about 0008.
boot 0008
observed="$(observe)"
wrong='BASELINE_OUTCOME=vault_create_secret=returned vault_delete_secret=raised:P0001 vault_update_secret=raised:P0001'
if [[ "$observed" != "$wrong" ]]; then
  ok "N1 the old documented claim ('create returns, update and delete raise') does NOT match the schema, and a string comparison sees it"
else
  bad "N1 the old documented claim matched; this case is not demonstrating what it claims"
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
