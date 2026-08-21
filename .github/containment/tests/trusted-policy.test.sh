#!/usr/bin/env bash
# ============================================================================
# trusted-policy.test.sh — the identity boundary, executed
#
# WHY THIS FILE EXISTS
# --------------------
# `trusted-policy.sh` is the ONLY script in `.github/containment/` that CI
# actually executes (dashboard-containment-gate.yml, job `identity-boundary`),
# and it is the script that decides whether a candidate commit is confined to
# `dashboard/`. Until this file was written it had NO test of any kind —
# measured, not assumed: a repository-wide search for its name returned the
# workflow, one README sentence and its own source, and nothing else. Every
# other artefact in this directory has a falsification suite; the one thing that
# runs in CI had none.
#
# WHAT IT FOUND, AND WHAT IS NOW FROZEN HERE
# ------------------------------------------
# Section 3 of the policy scanned `git ls-tree -r <candidate> -- dashboard/`
# for symlinks (mode 120000) and submodules (160000), swallowed the scan's exit
# status with `2>/dev/null || true`, and then printed
#
#     ok    no symlinks or submodules under dashboard/
#
# UNCONDITIONALLY — including when the scan returned zero rows. Measured against
# this repository's root commit d2bbd8a5, which has no `dashboard/` at all:
# `git ls-tree -r d2bbd8a5 -- dashboard/ | wc -l` is 0 and the line was printed
# anyway. An absence verdict from a scan nobody proved had looked at anything.
# Case N3 below is that measurement, frozen as a standing control.
#
# CASES (every one asserts an EXACT reason string, never "some non-zero exit")
#   C1  positive control on THIS file's own matcher
#   P1  the audited bridge candidate -> exit 0, PASS, and the four claim fields
#   N1  a malformed candidate sha -> exit 1 and the exact machine-readable reason
#   N2  a 40-hex string that is not an object -> exit 1 naming that
#   N3  a candidate with no dashboard/ tree -> exit 1 with the empty-scan refusal
#   N4  the forbidden post-0014 line -> exit 1 naming that line, and NOT naming
#       the empty-scan refusal (so N3's message is discriminating, not generic)
#   C2  the policy's own symlink/submodule matcher control must be reported in
#       every run, and a DOCTORED copy whose matcher is broken must report it as
#       failed — the red-before for the control itself
#   N5  no run, passing or failing, may ever emit paper_promotable true or
#       paper_validation_result PASS
#
# RESIDUAL LIMIT — READ THIS BEFORE QUOTING A GREEN RESULT
# --------------------------------------------------------
# No case here plants a REAL symlink, a REAL submodule or a REAL rename in a
# candidate commit, because building such a fixture means writing git objects
# and this harness deliberately writes none: every candidate it uses is a commit
# that already exists in this repository. The consequences, stated plainly:
#
#   * the 120000/160000 matcher is proved live only on a PLANTED ROW inside the
#     policy (its own positive control, asserted here by C2), not end to end on
#     a candidate that really contains a symlink;
#   * the rename/copy rejection (`R*|C*` in section 2) has NO case here at all;
#   * the "tree CHANGED" and "blob CHANGED" arms are exercised only incidentally,
#     by N3/N4, and not one at a time.
#
# Those are gaps in THIS file, not properties of the policy. They are closable
# by a harness that is allowed to create commits in a disposable clone.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINMENT="$(cd "${HERE}/.." && pwd)"
REPO="$(cd "${CONTAINMENT}/../.." && pwd)"
POLICY="${CONTAINMENT}/trusted-policy.sh"
[[ -x "$POLICY" || -f "$POLICY" ]] || { printf 'tp: no policy at %s\n' "$POLICY" >&2; exit 2; }
[[ -d "${REPO}/.git" ]] || { printf 'tp: %s is not a git checkout\n' "$REPO" >&2; exit 2; }

# Pinned, immutable candidates. A SHA is used rather than a branch name on
# purpose: a branch is mutable and this suite must mean the same thing tomorrow.
CAND_PASS=8e21d0cdbf0c8976389174cca85f5c5b2d059024   # bridge/pre-migration-containment
CAND_FORBIDDEN=0f6c415324625767f4b03c0cbfeda63b37d8c753  # the post-0014 line
CAND_NO_DASHBOARD=d2bbd8a5970a78a245f8c770bb8f7859403c602f  # root commit
CAND_NOT_AN_OBJECT=0000000000000000000000000000000000000000

WORK="$(mktemp -d)"

CASES_INTENDED=(C1 P1 N1 N2 N3 N4 C2 N5)
CASES_SEEN=()
COMPLETED=0
rc=0
cleanup() {
  local r=$?
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\ntp: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$r" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    rm -rf "$WORK"
    exit "$(( r == 0 ? 2 : r ))"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { CASES_SEEN+=("$1"); printf '   \033[1;32mgreen\033[0m %s %s\n' "$1" "${*:2}"; }
fail() { CASES_SEEN+=("$1"); printf '   \033[1;31mRED\033[0m   %s %s\n' "$1" "${*:2}" >&2; rc=1; }
hdr()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }

# The matcher every assertion uses, in one place so C1 can prove it works.
says() { grep -F -q -- "$2" "$1"; }

# Run a policy (real or doctored) against a candidate. Prints nothing; leaves
# $LOG, $JSON and $PRC set.
LOG=""; JSON=""; PRC=0
run_policy() {  # policy, candidate, tag
  LOG="$WORK/$3.log"; JSON="$WORK/$3.json"
  set +e
  bash "$1" "$REPO" "$2" "$JSON" > "$LOG" 2>&1
  PRC=$?
  set -e
}

json_field() {  # file, key
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except Exception as exc:
    print("__UNREADABLE__:%s" % exc); raise SystemExit(0)
v = doc.get(sys.argv[2], "__ABSENT__")
print(json.dumps(v) if not isinstance(v, str) else v)
PY
}

json_failures_contain() {  # file, needle
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1]))
except Exception:
    print("no"); raise SystemExit(0)
print("yes" if any(sys.argv[2] in f for f in doc.get("failures", [])) else "no")
PY
}

# ---------------------------------------------------------------------------
hdr "C1. positive control on this file's own matcher"
printf 'alpha\nBRAVO planted\ncharlie\n' > "$WORK/c1.txt"
if says "$WORK/c1.txt" "BRAVO planted" && ! says "$WORK/c1.txt" "DELTA absent"; then
  pass C1 "the matcher finds a planted string and refuses one that is absent"
else
  fail C1 "the matcher used by every assertion below does not discriminate"
fi

# Fixtures must exist, or every case below is measuring nothing.
missing_fixture=""
for s in "$CAND_PASS" "$CAND_FORBIDDEN" "$CAND_NO_DASHBOARD"; do
  [[ "$(git -C "$REPO" cat-file -t "$s" 2>/dev/null || true)" == commit ]] \
    || missing_fixture="${missing_fixture} ${s}"
done
if [[ -n "$missing_fixture" ]]; then
  printf '\ntp: pinned candidate commit(s) missing from this checkout:%s\n' "$missing_fixture" >&2
  printf 'A missing fixture is a harness error, not a skipped case.\n' >&2
  exit 2
fi
# ...and the no-dashboard fixture must really have no dashboard/, or N3 proves
# nothing. Measured here rather than assumed.
nd_rows="$(git -C "$REPO" ls-tree -r "$CAND_NO_DASHBOARD" -- dashboard/ | wc -l)"
pd_rows="$(git -C "$REPO" ls-tree -r "$CAND_PASS" -- dashboard/ | wc -l)"
if [[ "$nd_rows" -ne 0 || "$pd_rows" -lt 50 ]]; then
  printf '\ntp: fixture assumption broken: no-dashboard candidate has %s row(s), pass candidate has %s\n' \
    "$nd_rows" "$pd_rows" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
hdr "P1. the audited bridge candidate passes, and says exactly what it attests"
run_policy "$POLICY" "$CAND_PASS" p1
p1_ok=1
[[ "$PRC" -eq 0 ]] || { p1_ok=0; fail P1 "exit ${PRC}, expected 0"; }
says "$LOG" "IDENTITY BOUNDARY PASSED" || { p1_ok=0; fail P1 "the pass banner is absent"; }
for pair in "result:PASS" "paper_promotable:false" "paper_validation_result:NOT_APPLICABLE" \
            "dashboard_containment_promotable:true" "containment_scope_valid:true"; do
  k="${pair%%:*}"; want="${pair#*:}"
  got="$(json_field "$JSON" "$k")"
  [[ "$got" == "$want" ]] || { p1_ok=0; fail P1 "${k}=${got}, expected ${want}"; }
done
# and the scan really looked at something
says "$LOG" "no symlinks or submodules among the ${pd_rows} entries under dashboard/" \
  || { p1_ok=0; fail P1 "the symlink scan did not report how many entries it read"; }
[[ "$p1_ok" -eq 1 ]] && pass P1 "exit 0, PASS, the four claim fields, and a scan that names its ${pd_rows}-entry input"

# ---------------------------------------------------------------------------
hdr "N1. a malformed candidate sha is refused by its exact machine-readable reason"
run_policy "$POLICY" "not-a-sha" n1
if [[ "$PRC" -eq 1 ]] \
   && says "$LOG" "is not a full 40-character lowercase SHA" \
   && [[ "$(json_field "$JSON" reason)" == "malformed candidate sha" ]]; then
  pass N1 "exit 1, the exact stdout reason, and reason=malformed candidate sha in the JSON"
else
  fail N1 "exit ${PRC}, reason=$(json_field "$JSON" reason)"
fi

# ---------------------------------------------------------------------------
hdr "N2. a well-formed sha that is not an object in this repository"
run_policy "$POLICY" "$CAND_NOT_AN_OBJECT" n2
if [[ "$PRC" -eq 1 ]] \
   && [[ "$(json_failures_contain "$JSON" "is not a commit object in this repository")" == yes ]]; then
  pass N2 "exit 1, and the failure names the missing commit object"
else
  fail N2 "exit ${PRC}; failures=$(json_field "$JSON" failures)"
fi

# ---------------------------------------------------------------------------
hdr "N3. RED-BEFORE, frozen: a candidate with no dashboard/ must not read as 'no symlinks'"
run_policy "$POLICY" "$CAND_NO_DASHBOARD" n3
n3_need="refusing to report an empty scan as 'no symlinks'"
if [[ "$PRC" -eq 1 ]] \
   && [[ "$(json_failures_contain "$JSON" "$n3_need")" == yes ]] \
   && ! says "$LOG" "no symlinks or submodules among"; then
  pass N3 "exit 1, the empty-scan refusal is a named failure, and no clean-scan line was printed"
else
  fail N3 "exit ${PRC}; the zero-row scan did not refuse (this is the defect this file was written for)"
  sed -n '/matcher proved live/,+3p' "$LOG" >&2
fi

# ---------------------------------------------------------------------------
hdr "N4. the forbidden post-0014 line, and N3's message is discriminating"
run_policy "$POLICY" "$CAND_FORBIDDEN" n4
n4_ok=1
[[ "$PRC" -eq 1 ]] || { n4_ok=0; fail N4 "exit ${PRC}, expected 1"; }
[[ "$(json_failures_contain "$JSON" "the post-0014 candidate line")" == yes ]] \
  || { n4_ok=0; fail N4 "the post-0014 line was not named as a failure"; }
# discrimination: this candidate HAS a dashboard/, so N3's refusal must be absent
[[ "$(json_failures_contain "$JSON" "$n3_need")" == no ]] \
  || { n4_ok=0; fail N4 "the empty-scan refusal fired on a candidate that has a dashboard/ tree"; }
says "$LOG" "no symlinks or submodules among" \
  || { n4_ok=0; fail N4 "the symlink scan did not run on a candidate that has a dashboard/ tree"; }
[[ "$n4_ok" -eq 1 ]] && pass N4 "exit 1 naming the forbidden line, with the empty-scan refusal correctly absent"

# ---------------------------------------------------------------------------
hdr "C2. the policy's own matcher control is reported, and a broken matcher fails it"
c2_ok=1
for tag in p1 n3 n4; do
  says "$WORK/${tag}.log" "symlink/submodule matcher proved live on a planted 120000 and 160000 row" \
    || { c2_ok=0; fail C2 "run ${tag} did not report the matcher's positive control"; }
done
# RED-BEFORE for the control itself: neutralise the 120000 arm in a COPY and
# require the control to notice. The doctoring is asserted to have changed the
# file, so a sed that matched nothing cannot pass as a refusal — and P1 above
# already showed the UNDOCTORED policy exits 0 on this same candidate, so the
# refusal can only have come from the doctoring.
DOCTORED="$WORK/policy-broken-matcher.sh"
{
  sed "s|120000) printf 'symlink introduced or present in a changed path: %s\\\\n' \"\$path\" ;;|120000) : ;;|" \
    "$POLICY" > "$DOCTORED"
  if cmp -s "$POLICY" "$DOCTORED"; then
    c2_ok=0; fail C2 "the matcher-neutralising doctoring matched nothing; the red-before is vacuous"
  else
    run_policy "$DOCTORED" "$CAND_PASS" c2
    if [[ "$PRC" -eq 1 ]] \
       && [[ "$(json_failures_contain "$JSON" "failed its own positive control")" == yes ]]; then
      pass C2 "a policy whose 120000 arm is dead fails its own matcher control (exit 1)"
    else
      c2_ok=0
      fail C2 "a policy with a dead 120000 arm still passed (exit ${PRC}) — the control is decorative"
    fi
  fi
}
[[ "$c2_ok" -eq 1 ]] || true

# ---------------------------------------------------------------------------
hdr "N5. no run may ever claim paper promotability"
n5_ok=1
for tag in p1 n2 n3 n4 c2; do
  j="$WORK/${tag}.json"
  [[ -f "$j" ]] || continue
  [[ "$(json_field "$j" paper_promotable)" == "false" ]] \
    || { n5_ok=0; fail N5 "${tag}: paper_promotable is not false"; }
  [[ "$(json_field "$j" paper_validation_result)" == "NOT_APPLICABLE" ]] \
    || { n5_ok=0; fail N5 "${tag}: paper_validation_result is not NOT_APPLICABLE"; }
done
[[ "$n5_ok" -eq 1 ]] && pass N5 "every attestation written by this suite reports paper_promotable false and NOT_APPLICABLE"

# ---------------------------------------------------------------------------
# The suite must account for itself.
unaccounted=()
for c in "${CASES_INTENDED[@]}"; do
  seen=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && seen=$(( seen + 1 )); done
  [[ "$seen" -ge 1 ]] || unaccounted+=("$c")
done
if [[ "${#unaccounted[@]}" -gt 0 ]]; then
  printf '\ntp: these intended cases never reported: %s\n' "${unaccounted[*]}" >&2
  rc=1
fi
COMPLETED=1
if [[ "$rc" -eq 0 ]]; then
  printf '\n\033[1;32mTRUSTED-POLICY GREEN\033[0m  the identity boundary is executed, and its symlink scan can no longer certify an absence it never looked for.\n'
  printf '\033[1;33mRESIDUAL LIMIT\033[0m no case here plants a real symlink, submodule or rename in a candidate\n'
  printf '  commit; the matcher is proved on a planted row inside the policy (C2), and the\n'
  printf '  rename/copy arm has no case at all. See the header.\n'
else
  printf '\n\033[1;31mTRUSTED-POLICY RED\033[0m\n'
fi
exit "$rc"
