#!/usr/bin/env bash
# ============================================================================
# run-all.sh — every suite in .github/containment/tests, in cost order
#
# WHY THIS FILE EXISTS
# --------------------
# `runtime-canary/tests/run-all.sh` closed two defects that this directory still
# had, one level sideways:
#
#   B8(iii)  a skipped attack is not a passed attack — a runner that omits a
#            case and still prints a clean summary is certifying nothing;
#   N6       the DISK -> PLAN direction — "is every suite on disk declared?" —
#            because a suite absent from every hand-written list is absent from
#            every check.
#
# This directory had neither, because it had no runner at all. Measured before
# writing this file: `tests/counter-scan-declaration.test.sh` is invoked by
# nothing — not by `catalogue-classify.mutants.sh`, not by any workflow, not by
# any script in the repository. A repository-wide search for its name returned
# the driver flag it drives, two lines of documentation, and its own source.
# CATALOGUE-CLASSIFIER.md names the certifying invocation as
#
#     .github/containment/tests/catalogue-classify.mutants.sh --oracle both
#
# and that invocation does not run it. A suite on disk that the certifying
# invocation does not run is not a suite that passed.
#
# So: the labels are declared ONCE, `case_argv` must have a command for every
# declared label, the execution loop iterates the declaration, the FILESYSTEM is
# enumerated and every test-shaped file must be either a declared case or an
# explicitly named non-case, and the summary is reconciled against the
# declaration.
#
# WHAT THIS RUNNER DOES NOT COVER
#   * `runtime-canary/` has its own runner with its own artefact contract:
#     `runtime-canary/tests/run-all.sh --target-root DIR`. It is NOT invoked
#     from here, because its cases need bridge-checkout artefacts this runner
#     knows nothing about. Running this file green says nothing about it.
#   * `dashboard/test/containment/**` runs under the dashboard's own vitest.
#
# MEASURED, on disposable copies of this directory, before this file was
# believed (an undoctored copy plans cleanly in every case, so each refusal can
# only have come from the doctoring):
#
#   planting tests/zz-planted-control.test.sh        -> exit 2 naming it
#   planting ../zz-planted-toplevel-test.sh          -> exit 2 naming it
#   removing a case_argv branch, label left declared -> exit 2 "declared but no command"
#   chmod -x on a declared case's script             -> exit 2 "declared but not executable"
#   NT_TESTS_FORCE_NO_DOCKER=1, no --allow-skips     -> exit 2 naming the skipped case
#   NT_TESTS_FORCE_NO_DOCKER=1 --allow-skips         -> exit 0, labelled NOT a certification
#
# RESIDUAL LIMIT: those six are one-off measurements recorded here, not standing
# controls — this runner has no falsification suite of its own, and the sibling
# `runtime-canary/tests/k11-runner-omission.test.sh` covers only the sibling
# runner. A future edit that breaks one of the six would not be caught by
# anything that runs.
#
# Usage:
#   run-all.sh [--allow-skips] [--print-plan]
#
#   --print-plan   print which cases WOULD run and which would be skipped, then
#                  exit 0. The refusal is evaluated first, so --print-plan
#                  without docker and without --allow-skips still exits 2.
#   --allow-skips  run anyway, and say loudly that the run is NOT a
#                  certification. For the docker-backed case only.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINMENT="$(cd "${HERE}/.." && pwd)"

ALLOW_SKIPS=0
PRINT_PLAN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-skips) ALLOW_SKIPS=1; shift ;;
    --print-plan)  PRINT_PLAN=1;  shift ;;
    *) printf 'tests/run-all.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# The one list. The plan and the execution are the same list.
# ---------------------------------------------------------------------------
CASE_LABELS=(
  "counter-scan declaration"
  "trusted policy identity boundary"
  "catalogue classifier falsification"
)

ARGV=()
case_argv() {
  ARGV=()
  case "$1" in
    "counter-scan declaration")
      ARGV=("${HERE}/counter-scan-declaration.test.sh") ;;
    "trusted policy identity boundary")
      ARGV=("${HERE}/trusted-policy.test.sh") ;;
    "catalogue classifier falsification")
      ARGV=("${HERE}/catalogue-classify.mutants.sh" --oracle both) ;;
    *) return 1 ;;
  esac
  return 0
}

# Only the docker-backed case can be skipped, and only because the machine has
# no usable docker. Everything else is milliseconds and has no precondition.
DOCKER_CASES=("catalogue classifier falsification")
# NT_TESTS_FORCE_NO_DOCKER is a test seam and exists so the refusal below can be
# demonstrated on a machine that HAS docker. It can only push a case from RUN to
# SKIP, and a SKIP is a FAILURE unless --allow-skips is also given, so the seam
# can never turn a red run green — only a green run into a refusal.
docker_ok() {
  [[ -z "${NT_TESTS_FORCE_NO_DOCKER:-}" ]] || return 1
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

plan_status() {
  case "$1" in
    "catalogue classifier falsification")
      if docker_ok; then echo RUN
      else echo "SKIP: no usable docker daemon; this is the whole falsification suite"; fi ;;
    *) echo RUN ;;
  esac
}

# ---------------------------------------------------------------------------
# Self-check 1: PLAN -> DISK. Every declared case must have a runnable command.
# ---------------------------------------------------------------------------
undispatchable=(); missing_script=()
for c in "${CASE_LABELS[@]}"; do
  if case_argv "$c"; then
    [[ -x "${ARGV[0]}" ]] || missing_script+=("${c} -> ${ARGV[0]}")
  else
    undispatchable+=("$c")
  fi
done
if [[ "${#undispatchable[@]}" -gt 0 || "${#missing_script[@]}" -gt 0 ]]; then
  printf 'tests/run-all.sh: the declared plan and the runnable cases have diverged.\n' >&2
  for c in "${undispatchable[@]}"; do printf '  declared but no command: %s\n' "$c" >&2; done
  for c in "${missing_script[@]}"; do printf '  declared but not executable: %s\n' "$c" >&2; done
  exit 2
fi

# ---------------------------------------------------------------------------
# Self-check 2: DISK -> PLAN. Every test-shaped file must be declared, or named
# here with a reason. This is the direction that had never been checked, and it
# is the direction a newly added suite disappears into.
# ---------------------------------------------------------------------------
NON_CASE_FILES=(
  "run-all.sh"        # this runner
  "naive-oracle.sql"  # a classifier INPUT driven by the mutant suite, not a suite
)
undeclared=()
while IFS= read -r f; do
  b="$(basename "$f")"
  skip=0
  for n in "${NON_CASE_FILES[@]}"; do [[ "$b" == "$n" ]] && skip=1; done
  [[ "$skip" -eq 1 ]] && continue
  declared=0
  for c in "${CASE_LABELS[@]}"; do
    if case_argv "$c" && [[ "$(basename "${ARGV[0]}")" == "$b" ]]; then declared=1; break; fi
  done
  [[ "$declared" -eq 1 ]] || undeclared+=("tests/$b")
done < <(find "$HERE" -maxdepth 1 -type f \( -name '*.sh' -o -name '*.py' -o -name '*.mjs' -o -name '*.sql' \) \
          | LC_ALL=C sort)
# ...and the same question one directory up, where a test-shaped file would
# otherwise sit beside the artefacts it tests and be run by nothing.
while IFS= read -r f; do
  b="$(basename "$f")"
  declared=0
  for c in "${CASE_LABELS[@]}"; do
    if case_argv "$c" && [[ "$(basename "${ARGV[0]}")" == "$b" ]]; then declared=1; break; fi
  done
  [[ "$declared" -eq 1 ]] || undeclared+=("$b (in .github/containment/)")
done < <(find "$CONTAINMENT" -maxdepth 1 -type f -name '*test*.sh' | LC_ALL=C sort)
if [[ "${#undeclared[@]}" -gt 0 ]]; then
  printf 'tests/run-all.sh: these files exist but no declared case runs them:\n' >&2
  for b in "${undeclared[@]}"; do printf '  %s\n' "$b" >&2; done
  printf 'A suite that is on disk and never run is not a suite that passed. Declare it\n' >&2
  printf 'in CASE_LABELS/case_argv, or name it in NON_CASE_FILES with a reason.\n' >&2
  exit 2
fi

WOULD_SKIP=()
for c in "${DOCKER_CASES[@]}"; do
  found=0
  for d in "${CASE_LABELS[@]}"; do [[ "$d" == "$c" ]] && found=1; done
  [[ "$found" -eq 1 ]] || { printf 'tests/run-all.sh: %s is gated but not declared\n' "$c" >&2; exit 2; }
  [[ "$(plan_status "$c")" == RUN ]] || WOULD_SKIP+=("$c")
done

if [[ "${#WOULD_SKIP[@]}" -gt 0 && "$ALLOW_SKIPS" -ne 1 ]]; then
  printf 'tests/run-all.sh: refusing to run a suite that would not exercise: %s\n' \
    "$(IFS='; '; printf '%s' "${WOULD_SKIP[*]}")" >&2
  for c in "${WOULD_SKIP[@]}"; do printf '  %-38s %s\n' "$c" "$(plan_status "$c")" >&2; done
  printf 'A skipped attack is not a passed attack. Start docker, or pass --allow-skips\n' >&2
  printf 'for a run that is explicitly NOT a certification.\n' >&2
  exit 2
fi

if [[ "$PRINT_PLAN" -eq 1 ]]; then
  printf 'tests/run-all.sh plan\n'
  for c in "${CASE_LABELS[@]}"; do printf '  %-38s %s\n' "$c" "$(plan_status "$c")"; done
  printf '  %-38s %s\n' "runtime-canary suites" \
    "NOT RUN HERE: runtime-canary/tests/run-all.sh --target-root DIR has its own contract"
  [[ "${#WOULD_SKIP[@]}" -eq 0 ]] \
    || printf '\n  --allow-skips was given: this run would NOT be a certification.\n'
  exit 0
fi

results=(); reported=(); overall=0
run() {
  local label="$1"; shift
  printf '\n\033[1m>>> %s\033[0m\n' "$label"
  set +e
  "$@"
  local rc=$?
  set -e
  results+=("$(printf '%-38s %s' "$label" "$( [[ $rc -eq 0 ]] && echo 'PASS' || echo "FAIL(rc=$rc)")")")
  reported+=("$label")
  [[ $rc -eq 0 ]] || overall=1
}
skip() {
  if [[ "$ALLOW_SKIPS" -eq 1 ]]; then
    results+=("$(printf '%-38s %s' "$1" "SKIPPED (--allow-skips) — $2")")
  else
    results+=("$(printf '%-38s %s' "$1" "FAIL(not run) — $2")")
    overall=1
  fi
  reported+=("$1")
}

for c in "${CASE_LABELS[@]}"; do
  st="$(plan_status "$c")"
  if [[ "$st" == RUN ]]; then
    case_argv "$c" || { printf 'tests/run-all.sh: no command for %s\n' "$c" >&2; exit 2; }
    run "$c" "${ARGV[@]}"
  else
    skip "$c" "${st#SKIP: }"
  fi
done

unaccounted=()
for c in "${CASE_LABELS[@]}"; do
  seen=0
  for r in "${reported[@]}"; do [[ "$r" == "$c" ]] && seen=$(( seen + 1 )); done
  [[ "$seen" -eq 1 ]] || unaccounted+=("${c} (reported ${seen} times, expected 1)")
done
printf '\n\033[1m=== summary ===\033[0m\n'
printf '  %s\n' "${results[@]}"
printf '  %-38s %s\n' "(cases accounted for)" "${#reported[@]} of ${#CASE_LABELS[@]} declared"
if [[ "${#unaccounted[@]}" -gt 0 ]]; then
  printf '\n\033[1;31m  THE SUMMARY DOES NOT ACCOUNT FOR THE DECLARED PLAN:\033[0m\n'
  for c in "${unaccounted[@]}"; do printf '    %s\n' "$c"; done
  overall=1
fi
printf '  %-38s %s\n' "runtime-canary suites" \
  "NOT RUN HERE: runtime-canary/tests/run-all.sh has its own contract"
if [[ "$ALLOW_SKIPS" -eq 1 ]]; then
  printf '\n\033[1;33m  --allow-skips was given: this suite run is NOT a certification.\033[0m\n'
fi
exit "$overall"
