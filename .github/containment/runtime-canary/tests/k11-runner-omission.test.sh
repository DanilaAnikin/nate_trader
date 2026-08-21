#!/usr/bin/env bash
# ============================================================================
# k11-runner-omission.test.sh — the runner must not omit a case in silence
#
# WHAT THIS CLOSES (audit finding B8(iii))
# ----------------------------------------
# `run-all.sh` used to SKIP the three artefact-driven cases — K2 sensor
# removal, K4 partial verdict, K9 cell+generation identity — whenever the
# artefact directories were not supplied, and still print a clean summary and
# exit 0. A default `run-all.sh --target-root X` therefore certified a suite
# that had never exercised the A1/A2/B1 regression tests, the ones an audit
# rated blocking. A skipped attack is not a passed attack.
#
# The repair is only worth as much as the test that holds it in place, so this
# file asserts the behaviour in BOTH directions and asserts the EXACT failure,
# never "some non-zero exit":
#
#   N1  no artefact directories, no --allow-skips  -> exit 2, and the message
#       must name all three omitted cases by name.
#   N2  only --full-out                            -> exit 2 naming K4 alone;
#       K2 and K9 must NOT be named, or the message is not discriminating.
#   P1  --allow-skips                              -> exit 0, plan prints all
#       three as SKIP and says the run is not a certification.
#   P2  both artefact directories                  -> exit 0, plan prints all
#       three as RUN and NOTHING as SKIP.
#   P3  the runner still refuses an unknown argument and a missing
#       --target-root, so P1/P2 are not passing because argument parsing has
#       been loosened.
#
# AND THEN THE SAME DEFECT WAS FOUND ONE LEVEL IN
# -----------------------------------------------
# N1/N2/P1/P2 all assert things about `--print-plan`. The plan used to be a
# HAND-WRITTEN list of labels, and the execution below it a SEPARATE
# hand-written sequence of `run` calls, with nothing comparing the two.
# Measured on the tree as it stood: deleting the single line
#
#     run "K10 tamper role scope"        "${HERE}/k10-role-scope.test.sh"
#
# left `--print-plan` still printing "K10 tamper role scope   RUN", left THIS
# FILE GREEN, and would have produced a summary with no K10 row and exit 0. A
# runner that certifies against its own plan, while the plan is not what runs,
# is the same defect as a verdict that certifies a subset — one level down.
#
# run-all.sh now derives the plan and the execution from ONE table, refuses to
# start when a declared case has no command or a missing script, and reconciles
# the summary against the declaration. Three cases hold that in place:
#
#   N3  the plan lists the WHOLE expected roster. This list is deliberately
#       duplicated here, in a different file, because a roster checked only
#       against itself checks nothing: deleting a case from run-all.sh's table
#       would otherwise delete it from the plan too and look consistent.
#   N4  RED-BEFORE, executed: a copy of the runner with one case_argv branch
#       removed — the label still declared — must exit 2 and name that case.
#   N5  a copy whose case script is not executable must exit 2 and name it,
#       so a renamed or deleted suite is refused before the fixtures build.
#   C1  POSITIVE CONTROL ON THIS TEST'S OWN GREP. The same matcher is run
#       against a planted string it must find and a planted string it must
#       not, so a matcher that silently matches nothing cannot make N1/N2 pass.
#
# AND THEN THE SAME DEFECT ONE SHAPE ALONG (N7, N8)
# -------------------------------------------------
# N6 planted `tests/k99-….test.sh` and required the runner to name it. It
# passed — against an enumeration that read `find "$HERE" -maxdepth 1 -type f
# -name '*.sh'`, which could only ever have seen that one shape. Measured on
# the tree as it stood: planting `tests/k98-….py` and
# `tests/extra/k97-….test.sh` in a copy left `--print-plan` exiting 0 with no
# mention of either, and left THIS FILE GREEN. A suite added as .py, .mjs or in
# a subdirectory was absent from run-all.sh's table AND from its disk scan —
# the "missing from both hand-written lists" state N6 exists to prevent,
# reachable by choosing a different file extension. N7 and N8 plant those two
# shapes; C3 removes all three and requires the same copy to plan cleanly.
#
# Nothing here starts a container or touches a database: --print-plan exits
# before the fixture build. That is deliberate — an omission test that needs
# 2.6 GB of images and ten minutes is an omission test that gets skipped.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# NT_K11_RUNNER is a test seam, and exists for one purpose: to point this file
# at a DOCTORED copy of run-all.sh so the suite's own red-before can be
# demonstrated — a copy with the refusal removed must make N1 and N2 go RED. It
# is read-only and can only make this test stricter or point it at a different
# file; it can never turn a real failure green. Default is the real runner.
RUNNER="${NT_K11_RUNNER:-${HERE}/run-all.sh}"
[[ -x "$RUNNER" ]] || { printf 'k11: no runner at %s\n' "$RUNNER" >&2; exit 2; }
[[ "$RUNNER" == "${HERE}/run-all.sh" ]] \
  || printf '\033[1;33mNOTE\033[0m k11 is running against %s, NOT the real runner\n' "$RUNNER"

WORK="$(mktemp -d)"

# ---------------------------------------------------------------------------
# THIS FILE HAD THE DEFECT IT EXISTS TO PROSECUTE.
#
# It reported "K11 GREEN … the runner refuses to omit a case in silence" while
# omitting one of its own cases in silence. Measured: deleting the whole N2
# block from a copy left the suite printing K11 GREEN, exit 0, with ten green
# lines instead of eleven and no mention anywhere that a case was gone. There
# was no closed set of cases and no assertion that the suite reached its own
# end, so `rc=0` meant "nothing that ran objected", not "everything ran".
#
# So: the case token is now an explicit argument to `pass`/`fail` — not the
# first word of a prose message, which several of them did not carry — the
# reported set is reconciled against CASES_INTENDED, and an EXIT trap turns
# "died before the summary" into a harness failure rather than a short list.
# ---------------------------------------------------------------------------
CASES_INTENDED=(C1 N1 N2 P1 P2 P3 N3 N4 N5 C2 N6 N7 N8 C3)
CASES_SEEN=()
COMPLETED=0
rc=0
cleanup() {
  local r=$?
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk11: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
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

# The matcher every assertion below uses, in one place so C1 can prove it works.
# grep -F, deliberately: two of the case labels contain a `+`, and matching them
# as an ERE silently turns "cell+generation" into "one or more l" — a pattern
# that matches nothing here and would have made every plan assertion vacuous.
says() {  # file, needle
  grep -qF -- "$2" "$1"
}

# The status the plan prints for one case, read by splitting the line on its
# column gap rather than by pattern-matching the label.
plan_status_of() {  # file, label
  awk -v want="$2" '
    { line = $0; sub(/^  /, "", line)
      idx = match(line, /  +/)
      if (idx > 0) { lab = substr(line, 1, idx - 1); st = substr(line, idx) }
      else         { lab = line; st = "" }
      sub(/^ +/, "", st); sub(/ +$/, "", st)
      if (lab == want) { print st; found = 1; exit } }
    END { if (!found) print "__NO_SUCH_PLAN_LINE__" }' "$1"
}

run_plan() {  # out-file, args...
  local out="$1"; shift
  set +e
  "$RUNNER" "$@" > "$out" 2>&1
  local r=$?
  set -e
  printf '%s' "$r"
}

# A target root that exists but is not a real bridge checkout: the refusal must
# happen before anything looks inside it.
TARGET="$WORK/target"; mkdir -p "$TARGET"
ART="$WORK/artefacts";  mkdir -p "$ART/cells"

# ---------------------------------------------------------------------------
hdr "C1. positive control on this test's own matcher"
printf 'K4 partial verdict\n' > "$WORK/canary.txt"
if says "$WORK/canary.txt" "K4 partial verdict"; then
  if says "$WORK/canary.txt" "K4 partial verdict is definitely not in this file"; then
    fail C1 "the matcher reports a string that is not there; every assertion below is void"
  else
    pass C1 "the matcher finds a planted string and refuses one that is absent"
  fi
else
  fail C1 "the matcher cannot find a string that IS there; every assertion below is void"
fi

# ---------------------------------------------------------------------------
hdr "N1. no artefact directories, no --allow-skips -> exit 2 naming all three"
out="$WORK/n1.txt"
got="$(run_plan "$out" --target-root "$TARGET")"
if [[ "$got" != 2 ]]; then
  fail N1 "exit was ${got}, expected 2 (a default invocation must refuse, not certify)"
  sed -n '1,20p' "$out" >&2
else
  missing=""
  for c in "K2 sensor removal" "K4 partial verdict" "K9 cell+generation identity"; do
    says "$out" "$c" || missing="${missing} [${c}]"
  done
  if says "$out" "refusing to run a suite that would not exercise"; then
    if [[ -n "$missing" ]]; then
      fail N1 "the refusal does not name:${missing}"
    else
      pass N1 "exit 2, and the refusal names K2, K4 and K9 explicitly"
    fi
  else
    fail N1 "exit 2 but without the refusal message; the reason must be stated"
  fi
fi

# ---------------------------------------------------------------------------
hdr "N2. only --full-out -> exit 2 naming K4 ALONE"
out="$WORK/n2.txt"
got="$(run_plan "$out" --target-root "$TARGET" --full-out "$ART")"
if [[ "$got" != 2 ]]; then
  fail N2 "exit was ${got}, expected 2 (K4 still cannot run without --partial-out)"
else
  wrong=""
  says "$out" "K4 partial verdict" || wrong="${wrong} K4-not-named"
  ! says "$out" "refusing to run a suite that would not exercise: K2" \
    || wrong="${wrong} K2-named-but-it-can-run"
  if says "$out" "K9 cell+generation identity"; then wrong="${wrong} K9-named-but-it-can-run"; fi
  if [[ -n "$wrong" ]]; then
    fail N2 "the refusal is not discriminating:${wrong}"
    sed -n '1,20p' "$out" >&2
  else
    pass N2 "exit 2, K4 named, K2 and K9 correctly absent from the refusal"
  fi
fi

# ---------------------------------------------------------------------------
hdr "P1. --allow-skips -> exit 0, all three SKIP, and it says it is not a certification"
out="$WORK/p1.txt"
got="$(run_plan "$out" --target-root "$TARGET" --allow-skips --print-plan)"
if [[ "$got" != 0 ]]; then
  fail P1 "exit was ${got}, expected 0 (--allow-skips must still be usable)"
  sed -n '1,30p' "$out" >&2
else
  bad=""
  for c in "K2 sensor removal" "K4 partial verdict" "K9 cell+generation identity"; do
    st="$(plan_status_of "$out" "$c")"
    [[ "$st" == SKIP:* ]] || bad="${bad} [${c} -> ${st}, expected SKIP:]"
  done
  says "$out" "would NOT be a certification" || bad="${bad} [no non-certification banner]"
  if [[ -n "$bad" ]]; then fail P1 "the plan is wrong:${bad}"; sed -n '1,30p' "$out" >&2
  else pass P1 "exit 0, three SKIP lines, and the run is labelled non-certifying"; fi
fi

# ---------------------------------------------------------------------------
hdr "P2. both artefact directories -> exit 0, all three RUN, nothing SKIP"
out="$WORK/p2.txt"
got="$(run_plan "$out" --target-root "$TARGET" --full-out "$ART" --partial-out "$ART" --print-plan)"
if [[ "$got" != 0 ]]; then
  fail P2 "exit was ${got}, expected 0"
  sed -n '1,30p' "$out" >&2
else
  bad=""
  for c in "K2 sensor removal" "K4 partial verdict" "K9 cell+generation identity"; do
    st="$(plan_status_of "$out" "$c")"
    [[ "$st" == RUN ]] || bad="${bad} [${c} -> ${st}, expected RUN]"
  done
  ! grep -q 'SKIP:' "$out" || bad="${bad} [something is still SKIP]"
  says "$out" "K7 Server Actions" || bad="${bad} [the K7 gap is not stated in the plan]"
  if [[ -n "$bad" ]]; then fail P2 "the plan is wrong:${bad}"; sed -n '1,30p' "$out" >&2
  else pass P2 "exit 0, all three RUN, no SKIP, and the K7 gap is still stated"; fi
fi

# ---------------------------------------------------------------------------
hdr "P3. argument parsing has not been loosened to make the above pass"
out="$WORK/p3a.txt"
got="$(run_plan "$out" --print-plan)"
[[ "$got" == 2 ]] && says "$out" "--target-root" \
  && pass P3 "a missing --target-root is still exit 2, naming the option" \
  || fail P3 "a missing --target-root gave exit ${got}"
out="$WORK/p3b.txt"
got="$(run_plan "$out" --target-root "$TARGET" --allow-skips --not-an-option)"
[[ "$got" == 2 ]] && says "$out" "unknown argument" \
  && pass P3 "an unknown argument is still exit 2" \
  || fail P3 "an unknown argument gave exit ${got}"

# ---------------------------------------------------------------------------
hdr "N3. the plan lists the whole expected roster, checked against a list kept HERE"
# Kept in this file on purpose. A roster that lives only in run-all.sh is
# checked against itself; deleting a case there would delete it from the plan
# and nothing would notice. If a case is legitimately retired, this list and the
# runner's table have to be changed together, deliberately, in two files.
EXPECTED_ROSTER=(
  "build 0023 schema base"
  "build 0008 schema base"
  "K11 runner omission"
  "K12 verifier digest scope"
  "K5 make-mutant delete guard"
  "K3 reuse guard"
  "K8 baseline expectation"
  "K6 tombstone binding"
  "K1 sensor negative controls"
  "K10 tamper role scope"
  "K2 claim completeness"
  "K2 sensor removal"
  "K4 partial verdict"
  "K9 cell+generation identity"
  "K13 transcript integrity"
  "K14 observer-derived claims"
  "K15 run controls"
  "K16 data-plane surface coverage"
)
out="$WORK/n3.txt"
got="$(run_plan "$out" --target-root "$TARGET" --full-out "$ART" --partial-out "$ART" --print-plan)"
if [[ "$got" != 0 ]]; then
  fail N3 "the plan itself exited ${got}; the roster cannot be checked"
  sed -n '1,30p' "$out" >&2
else
  absent=""
  for c in "${EXPECTED_ROSTER[@]}"; do
    st="$(plan_status_of "$out" "$c")"
    [[ "$st" == "__NO_SUCH_PLAN_LINE__" ]] && absent="${absent} [${c}]"
  done
  # And the converse: a plan line this file does not know about. A NEW case is
  # not a failure of the runner, but it must be added here consciously, or the
  # roster silently stops being a roster.
  unknown=""
  while IFS= read -r lab; do
    [[ -n "$lab" ]] || continue
    [[ "$lab" == "K7 Server Actions" ]] && continue   # the declared non-coverage line
    known=0
    for c in "${EXPECTED_ROSTER[@]}"; do [[ "$c" == "$lab" ]] && known=1; done
    [[ "$known" -eq 1 ]] || unknown="${unknown} [${lab}]"
  done < <(awk 'NR>1 { line=$0; sub(/^  /,"",line); idx=match(line,/  +/)
                       if (idx>0) print substr(line,1,idx-1) }' "$out")
  if [[ -n "$absent" ]]; then
    fail N3 "the plan no longer lists:${absent} — a case has been retired without saying so"
  elif [[ -n "$unknown" ]]; then
    fail N3 "the plan lists cases this test does not know about:${unknown} — add them to EXPECTED_ROSTER"
  else
    pass N3 "all ${#EXPECTED_ROSTER[@]} expected cases are in the plan, and nothing unexpected is"
  fi
fi

# ---------------------------------------------------------------------------
hdr "N4/N5. a declared case with no command, or no runnable script, is refused"
# Only meaningful against the real runner; a doctored NT_K11_RUNNER is already
# a modified copy and doctoring it twice proves nothing.
if [[ "$RUNNER" != "${HERE}/run-all.sh" ]]; then
  printf '   \033[1;33mskip \033[0m N4/N5/C2/N6/N7/N8/C3 need the real runner to doctor; RUNNER is overridden\n'
  # The intended set is REDUCED deliberately and out loud, rather than leaving
  # five cases silently unreported against a set that still names them. A run
  # in this mode is a red-before demonstration, not a certification of k11.
  CASES_INTENDED=(C1 N1 N2 P1 P2 P3 N3)
  printf '   \033[1;33mnote \033[0m this NT_K11_RUNNER run covers %s only\n' "${CASES_INTENDED[*]}"
else
  CANARY_DIR="$(cd "${HERE}/.." && pwd)"
  # N4: remove one case_argv branch, leave the label declared.
  D4="$WORK/doctored4"; rm -rf "$D4"; cp -a "$CANARY_DIR" "$D4"
  if ! python3 - "$D4/tests/run-all.sh" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
needle = '    "K10 tamper role scope")       ARGV=("${HERE}/k10-role-scope.test.sh") ;;\n'
if needle not in s:
    sys.exit(3)
open(p, 'w').write(s.replace(needle, ''))
PY
  then
    fail N4 "could not doctor the runner (the case_argv branch for K10 was not found verbatim); this control is void"
  else
    set +e
    o4="$("$D4/tests/run-all.sh" --target-root "$TARGET" --full-out "$ART" --partial-out "$ART" --print-plan 2>&1)"
    r4=$?
    set -e
    if [[ "$r4" == 2 ]] \
       && grep -qF -- "case_argv has no command: K10 tamper role scope" <<< "$o4"; then
      pass N4 "a declared case with no command -> exit 2 naming it, before any fixture is built"
    else
      fail N4 "a declared case with no command gave exit ${r4} without naming it"
      printf '%s\n' "$o4" | sed -n '1,10p' >&2
    fi
  fi
  # N5: the script itself is gone.
  D5="$WORK/doctored5"; rm -rf "$D5"; cp -a "$CANARY_DIR" "$D5"
  chmod -x "$D5/tests/k10-role-scope.test.sh"
  set +e
  o5="$("$D5/tests/run-all.sh" --target-root "$TARGET" --full-out "$ART" --partial-out "$ART" --print-plan 2>&1)"
  r5=$?
  set -e
  if [[ "$r5" == 2 ]] && grep -qF -- "its script is missing or not executable" <<< "$o5" \
     && grep -qF -- "K10 tamper role scope" <<< "$o5"; then
    pass N5 "a declared case whose script is not runnable -> exit 2 naming it"
  else
    fail N5 "an unrunnable case script gave exit ${r5} without the exact refusal"
    printf '%s\n' "$o5" | sed -n '1,10p' >&2
  fi
  # C2: the same invocation against an UNdoctored copy must NOT refuse, or
  # N4/N5 are passing because every invocation refuses.
  D6="$WORK/undoctored"; rm -rf "$D6"; cp -a "$CANARY_DIR" "$D6"
  set +e
  o6="$("$D6/tests/run-all.sh" --target-root "$TARGET" --full-out "$ART" --partial-out "$ART" --print-plan 2>&1)"
  r6=$?
  set -e
  if [[ "$r6" == 0 ]] && ! grep -qF -- "have diverged" <<< "$o6"; then
    pass C2 "an undoctored copy plans cleanly, so N4/N5 are discriminating"
  else
    fail C2 "an undoctored copy already refuses (exit ${r6}); N4/N5 prove nothing"
    printf '%s\n' "$o6" | sed -n '1,10p' >&2
  fi

  # -------------------------------------------------------------------------
  # N6. THE OTHER DIRECTION: A SUITE ON DISK THAT NO CASE RUNS.
  #
  # N3/N4/N5 all ask "is every DECLARED case runnable?". Nothing asked "is
  # every RUNNABLE suite declared?", and the answer was no: a new test file
  # dropped into tests/ was executed by nothing, appeared in no plan, and no
  # output anywhere said so. Both rosters — run-all.sh's table and
  # EXPECTED_ROSTER above — are hand-written, so a suite missing from both is
  # missing from both checks. run-all.sh now enumerates the directory.
  #
  # The planted file is a real, executable, plausibly-named suite, because a
  # check that only catches a file called `nonsense.sh` catches nothing.
  #
  # N7/N8 exist because N6 alone did not close the defect it names. The
  # enumeration was `find -maxdepth 1 -type f -name '*.sh'`, so N6's planted
  # `.sh` in `tests/` was the ONE shape it could see. A suite added as `.py` or
  # `.mjs`, or under `tests/<subdir>/`, was invisible to the disk check and to
  # the plan — the same "absent from both hand-written lists" state, reachable
  # by simply choosing a different file extension. Three plants, three separate
  # assertions, one shared negative control.
  # -------------------------------------------------------------------------
  D7="$WORK/planted"; rm -rf "$D7"; cp -a "$CANARY_DIR" "$D7"
  PLANTED_REL=(
    "k99-a-suite-nobody-runs.test.sh"       # N6: the original shape
    "k98-a-suite-nobody-runs.py"            # N7: a non-.sh suite at depth 1
    "extra/k97-a-suite-nobody-runs.test.sh" # N8: a suite in a subdirectory
  )
  mkdir -p "$D7/tests/extra"
  for rel in "${PLANTED_REL[@]}"; do
    cat > "$D7/tests/${rel}" <<'PLANTED'
#!/usr/bin/env bash
# A suite that exists, is executable, and that no declared case invokes.
echo "PLANTED GREEN"
PLANTED
    chmod +x "$D7/tests/${rel}"
  done
  set +e
  o7="$("$D7/tests/run-all.sh" --target-root "$TARGET" --full-out "$ART" --partial-out "$ART" --print-plan 2>&1)"
  r7=$?
  set -e
  # Each plant is judged on its own: a refusal that names one of the three and
  # stays silent about the others is the defect, not the repair.
  check_plant() {  # case-token, relative path, prose
    local tok="$1" rel="$2" what="$3"
    if [[ "$r7" == 2 ]] \
       && grep -qF -- "no declared case runs them" <<< "$o7" \
       && grep -qF -- "$rel" <<< "$o7"; then
      pass "$tok" "$what -> exit 2 naming ${rel}"
    else
      fail "$tok" "${what} gave exit ${r7} without naming ${rel}"
      printf '%s\n' "$o7" | sed -n '1,12p' >&2
    fi
  }
  check_plant N6 "k99-a-suite-nobody-runs.test.sh" \
    "a .sh test script on disk that no case runs"
  check_plant N7 "k98-a-suite-nobody-runs.py" \
    "a suite added as .py rather than .sh"
  check_plant N8 "extra/k97-a-suite-nobody-runs.test.sh" \
    "a suite added in a SUBDIRECTORY of tests/"
  # C3: the same copy WITHOUT the planted files must plan cleanly, or N6/N7/N8
  # are passing because every copy refuses.
  for rel in "${PLANTED_REL[@]}"; do rm -f "$D7/tests/${rel}"; done
  rmdir "$D7/tests/extra"
  set +e
  o8="$("$D7/tests/run-all.sh" --target-root "$TARGET" --full-out "$ART" --partial-out "$ART" --print-plan 2>&1)"
  r8=$?
  set -e
  if [[ "$r8" == 0 ]] && ! grep -qF -- "no declared case runs them" <<< "$o8"; then
    pass C3 "removing all three planted files makes the same copy plan cleanly again"
  else
    fail C3 "the copy still refuses after the planted files were removed (exit ${r8}); N6/N7/N8 prove nothing"
    printf '%s\n' "$o8" | sed -n '1,10p' >&2
  fi
fi

# ---------------------------------------------------------------------------
# THE CLOSED-SET CHECK ON THIS SUITE'S OWN COVERAGE.
# A suite that prosecutes silent omission has to be able to detect its own.
# ---------------------------------------------------------------------------
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
  printf '   \033[1;31mRED\033[0m   COVERAGE these intended cases never reported: %s\n' "${missing_cases[*]}" >&2
  rc=1
fi
if [[ "${#unknown_cases[@]}" -ne 0 ]]; then
  printf '   \033[1;31mRED\033[0m   COVERAGE these cases reported but are not in CASES_INTENDED: %s\n' "${unknown_cases[*]}" >&2
  rc=1
fi
DISTINCT_SEEN="$(printf '%s\n' "${CASES_SEEN[@]}" | LC_ALL=C sort -u | wc -l)"
COMPLETED=1

printf '\n'
if [[ "$rc" -eq 0 ]]; then
  printf '\033[1;32mK11 GREEN\033[0m  the runner refuses to omit a case in silence, and so does this suite (%s of %s intended cases reported).\n' \
    "$DISTINCT_SEEN" "${#CASES_INTENDED[@]}"
else
  printf '\033[1;31mK11 RED\033[0m  (%s of %s intended cases reported)\n' "$DISTINCT_SEEN" "${#CASES_INTENDED[@]}"
fi
exit "$rc"
