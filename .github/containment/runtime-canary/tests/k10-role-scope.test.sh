#!/usr/bin/env bash
# ============================================================================
# k10-role-scope.test.sh — the tamper control's role list is DERIVED, not typed
#
# THE DEFECT THIS CLOSES (audit finding B8(ii))
# ---------------------------------------------
# `sensor/sql/52_tamper_control.sql` proves that none of the roles a request can
# arrive as can disable the canary, against four role names written out by hand.
# `sink/sink.mjs` decides which roles a request CAN arrive as, in three more
# hand-written names plus the role its pool connects as. Nothing compared the
# two lists. Add a role to the gateway and the tamper proof silently stops
# covering it; the proof still says `UNREACHABLE|attempts=24|succeeded=0`.
#
# That is the shape C5 was fixed for — a hand-maintained list standing in for a
# derived one — and it survived one level along.
#
# `sensor/role-scope.sh` now derives the reachable set from the gateway's own
# source and requires SET EQUALITY with what the SQL attempts. This suite proves
# that check can fail, for its own named reason, in each direction:
#
#   P0  the real files agree                                    -> ROLE_SCOPE_OK
#   N1  a role added to SAFE_ROLES and not to the SQL           -> UNPROVEN <role>
#   N2  a role removed from the SQL array                       -> UNPROVEN <role>
#   N3  a role in the SQL that the gateway cannot reach         -> SURPLUS <role>
#   N4  a DIFFERENT connection role in the gateway              -> UNPROVEN <role>
#   N5  both literals planted inside COMMENTS only              -> still OK
#   N6  the SAFE_ROLES literal removed entirely                 -> EXTRACTION_FAILED
#
# N5 is the control this programme has been burned by three times: a guard that
# matches its own documentation. Both files' prose contains the exact literals
# the extractor looks for, so the extractor strips comments first — and N5 is
# what proves the stripping is real rather than incidental.
# N6 is the other half: an extractor that finds nothing must FAIL, not return an
# empty set that trivially equals another empty set.
#
# Exit: 0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
SCOPE="${RC}/sensor/role-scope.sh"
SINK="${RC}/sink/sink.mjs"
SQL="${RC}/sensor/sql/52_tamper_control.sql"

[[ -x "$SCOPE" ]] || { printf 'k10: %s is not executable\n' "$SCOPE" >&2; exit 2; }

WORK="$(mktemp -d /tmp/nt-k10-XXXXXX)"
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
CASES_INTENDED=(P0 N1 N2 N3 N4 N5 N6)
CASES_SEEN=()
COMPLETED=0
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }

cleanup() {
  local __rc=$?
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk10: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$__rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( __rc == 0 ? 2 : __rc ))"
  fi
}
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }

check() {  # sink-file, sql-file -> OUTPUT, CRC
  set +e
  OUTPUT="$("$SCOPE" --check --sink-file "$1" --sql-file "$2" 2>&1)"
  CRC=$?
  set -e
}

printf '\n== K10 the tamper control must attempt exactly the reachable roles ==\n\n'

# --- P0 positive control ----------------------------------------------------
check "$SINK" "$SQL"
if [[ "$CRC" -eq 0 ]] && grep -q 'ROLE_SCOPE_OK' <<< "$OUTPUT"; then
  ok "P0 the shipped gateway and tamper control agree: $(sed -n 's/.*reachable=attempted=//p' <<< "$OUTPUT")"
else
  bad "P0 the shipped files were reported as disagreeing (rc=$CRC)"
  sed 's/^/       /' <<< "$OUTPUT"
fi

# --- N1 a role the gateway can reach and the SQL does not attempt ------------
cp "$SINK" "$WORK/n1.mjs"
perl -0pi -e 's/const SAFE_ROLES = new Set\(\[/const SAFE_ROLES = new Set(["k10_extra_role", /' "$WORK/n1.mjs"
grep -q 'k10_extra_role' "$WORK/n1.mjs" || { printf 'k10: N1 mutation did not apply\n' >&2; exit 2; }
check "$WORK/n1.mjs" "$SQL"
if [[ "$CRC" -eq 1 ]] && grep -q 'UNPROVEN a request can arrive as k10_extra_role' <<< "$OUTPUT"; then
  ok "N1 a role added to the gateway and not to the control is named UNPROVEN (rc=$CRC)"
else
  bad "N1 wrong outcome (rc=$CRC)"; sed 's/^/       /' <<< "$OUTPUT"
fi

# --- N2 a role dropped from the SQL array -----------------------------------
cp "$SQL" "$WORK/n2.sql"
perl -0pi -e "s/array\['anon','authenticated','service_role','authenticator'\]/array['anon','authenticated','service_role']/" "$WORK/n2.sql"
grep -q "array\['anon','authenticated','service_role'\]" "$WORK/n2.sql" || { printf 'k10: N2 mutation did not apply\n' >&2; exit 2; }
check "$SINK" "$WORK/n2.sql"
if [[ "$CRC" -eq 1 ]] && grep -q 'UNPROVEN a request can arrive as authenticator' <<< "$OUTPUT"; then
  ok "N2 a role dropped from the control is named UNPROVEN (rc=$CRC)"
else
  bad "N2 wrong outcome (rc=$CRC)"; sed 's/^/       /' <<< "$OUTPUT"
fi

# --- N3 a role the SQL attempts that no request can arrive as ---------------
cp "$SQL" "$WORK/n3.sql"
perl -0pi -e "s/array\['anon',/array['k10_ghost_role','anon',/" "$WORK/n3.sql"
grep -q 'k10_ghost_role' "$WORK/n3.sql" || { printf 'k10: N3 mutation did not apply\n' >&2; exit 2; }
check "$SINK" "$WORK/n3.sql"
if [[ "$CRC" -eq 1 ]] && grep -q 'SURPLUS  the control attempts k10_ghost_role' <<< "$OUTPUT"; then
  ok "N3 a role no request can arrive as is named SURPLUS, not quietly tolerated (rc=$CRC)"
else
  bad "N3 wrong outcome (rc=$CRC)"; sed 's/^/       /' <<< "$OUTPUT"
fi

# --- N4 the gateway connects as a different role ----------------------------
cp "$SINK" "$WORK/n4.mjs"
perl -0pi -e 's/SINK_PGUSER \|\| "authenticator"/SINK_PGUSER || "k10_other_login"/' "$WORK/n4.mjs"
grep -q 'k10_other_login' "$WORK/n4.mjs" || { printf 'k10: N4 mutation did not apply\n' >&2; exit 2; }
check "$WORK/n4.mjs" "$SQL"
if [[ "$CRC" -eq 1 ]] \
   && grep -q 'UNPROVEN a request can arrive as k10_other_login' <<< "$OUTPUT" \
   && grep -q 'SURPLUS  the control attempts authenticator' <<< "$OUTPUT"; then
  ok "N4 changing the connection role is caught in both directions (rc=$CRC)"
else
  bad "N4 wrong outcome (rc=$CRC)"; sed 's/^/       /' <<< "$OUTPUT"
fi

# --- N5 THE COMMENT CONTROL -------------------------------------------------
# Plant a decoy of each literal inside a comment, before the real one. An
# extractor that does not strip comments reads the decoy and the check goes
# green on text nothing executes.
cp "$SINK" "$WORK/n5.mjs"
printf '\n/* decoy: const SAFE_ROLES = new Set(["k10_comment_role"]); and SINK_PGUSER || "k10_comment_login" */\n' \
  | cat - "$WORK/n5.mjs" > "$WORK/n5b.mjs" && mv "$WORK/n5b.mjs" "$WORK/n5.mjs"
printf '\n-- decoy: roles text[] := array[%s];\n' "'k10_comment_role'" \
  | cat - "$SQL" > "$WORK/n5.sql"
grep -q 'k10_comment_role' "$WORK/n5.mjs" && grep -q 'k10_comment_role' "$WORK/n5.sql" \
  || { printf 'k10: N5 decoys were not planted\n' >&2; exit 2; }
check "$WORK/n5.mjs" "$WORK/n5.sql"
if [[ "$CRC" -eq 0 ]] && grep -q 'ROLE_SCOPE_OK' <<< "$OUTPUT" \
   && ! grep -q 'k10_comment' <<< "$OUTPUT"; then
  ok "N5 decoy literals planted in COMMENTS are not read (rc=$CRC)"
else
  bad "N5 the extractor read its own documentation (rc=$CRC)"; sed 's/^/       /' <<< "$OUTPUT"
fi

# --- N6 an extraction that finds nothing must FAIL --------------------------
cp "$SINK" "$WORK/n6.mjs"
perl -0pi -e 's/const SAFE_ROLES = new Set\(\[[^\]]*\]\);/const SAFE_ROLES = buildRoles();/' "$WORK/n6.mjs"
grep -q 'buildRoles()' "$WORK/n6.mjs" || { printf 'k10: N6 mutation did not apply\n' >&2; exit 2; }
check "$WORK/n6.mjs" "$SQL"
if [[ "$CRC" -eq 2 ]] && grep -q 'ROLE_SCOPE_EXTRACTION_FAILED' <<< "$OUTPUT" \
   && grep -q 'no SAFE_ROLES literal' <<< "$OUTPUT"; then
  ok "N6 an unparseable gateway is a harness failure, not an empty set that matches everything (rc=$CRC)"
else
  bad "N6 wrong outcome (rc=$CRC)"; sed 's/^/       /' <<< "$OUTPUT"
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
