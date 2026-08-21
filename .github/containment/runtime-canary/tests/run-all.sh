#!/usr/bin/env bash
# ============================================================================
# run-all.sh — every closure test in this directory, in dependency order
#
# WHAT THIS SUITE DOES AND DOES NOT COVER
# ---------------------------------------
# An adversarial verifier confirmed EIGHT defects (K1..K8). This directory holds
# a closure test for SEVEN of them — K1, K2, K3, K4, K5, K6, K8 — plus K9 (cell
# AND generation identity), K10 (the tamper control's role scope), K11 (this
# runner must not omit a case in silence) and K12 (the verifier's own pin covers
# what it claims to cover), all added by later audits. The header used to say
# "the eight defects" over seven files, which reads as complete coverage and is
# not:
#
#   K7 ("Server Actions are inside the containment surface") has NO test here,
#   and cannot have one as this harness is built. run.sh drives the surface
#   `driver/enumerate-routes.mjs` finds, and that enumerator walks `app/api` for
#   Next `route.{ts,tsx,js,mjs}` files only. Server Actions — the bridge has
#   three files of them — are not enumerated and not driven. They are covered
#   statically, in the bridge checkout, by
#   `dashboard/test/containment/server-actions.test.ts`. That is a different
#   kind of evidence from the executed proof this directory produces, and the
#   difference is the point of saying so here.
#
# Each test carries its own positive control, so a suite that refused everything
# would not pass, and each negative case asserts the EXACT failure it is aiming
# at rather than "some non-zero exit".
#
# The artefact-driven suites (K2 sensor removal, K4 partial verdict, K9 cell and
# generation identity) need directories produced by real run.sh runs.
#
# THEY USED TO BE SKIPPED WHEN THOSE DIRECTORIES WERE NOT SUPPLIED, and a
# default `run-all.sh --target-root X` therefore reported a clean suite without
# ever exercising the A1/A2/B1 regression tests — the ones that close the two
# defects an audit rated blocking. Audit finding B8(iii). A skipped attack is
# not a passed attack, so a missing artefact directory is now a FAILURE.
# `--allow-skips` restores the old behaviour for exploratory runs; it prints a
# banner saying the suite is not a certification.
#
# Usage:
#   run-all.sh --target-root DIR [--partial-out DIR] [--full-out DIR]
#              [--allow-skips] [--print-plan]
#
#   --print-plan   print which cases WOULD run and which would be skipped, then
#                  exit 0 without starting anything. The refusal above is
#                  evaluated first, so `--print-plan` without the artefact
#                  directories and without --allow-skips still exits 2. This is
#                  the seam tests/k11-runner-omission.test.sh asserts against.
#
#   --full-out     an artefact directory from a run that drove ALL 24 cells on
#                  BOTH generations (`run.sh --schema both`). K9's R5/R6 attacks
#                  are cross-generation and cannot run on half of one.
#   --partial-out  an artefact directory from a deliberately partial run.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET_ROOT=""
PARTIAL_OUT=""
FULL_OUT=""
ALLOW_SKIPS=0
PRINT_PLAN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-root) TARGET_ROOT="${2:?}"; shift 2 ;;
    --partial-out) PARTIAL_OUT="${2:?}"; shift 2 ;;
    --full-out)    FULL_OUT="${2:?}";    shift 2 ;;
    --allow-skips) ALLOW_SKIPS=1;        shift ;;
    --print-plan)  PRINT_PLAN=1;         shift ;;
    *) printf 'run-all.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$TARGET_ROOT" ]] || { printf 'run-all.sh: --target-root (the bridge checkout) is required\n' >&2; exit 2; }

# ---------------------------------------------------------------------------
# FIXTURE FORWARD-PORT (audit finding ADV-3).
#
# `verify-sensor.sh report` now seals its report body with the per-run key, and
# the certifying verdict derives the sensor verdict from the SEALED body. An
# artefact directory produced by an earlier run.sh has the key and the report
# but no seal, so every certifying suite over it would refuse — for a reason
# that is about the fixture's age and not about the harness. This writes what
# the runner would have written, from that run's own report, under that run's
# own key. It REFUSES if the key is gone, so it cannot manufacture a seal for a
# directory whose runner state was deleted — which is the ADV-3 attack itself.
#
# It is loud on purpose: a corpus that had to be forward-ported is a corpus
# that predates the check it is being used to exercise, and the reader should
# know which one they have.
# ---------------------------------------------------------------------------
for d in "$FULL_OUT" "$PARTIAL_OUT"; do
  [[ -n "$d" && -d "$d" ]] || continue
  needs=0
  for st in "$d"/sensor-state-*; do
    [[ -d "$st" ]] || continue
    [[ -f "${st}/report.hmac" ]] || needs=1
  done
  if [[ "$needs" -eq 1 ]]; then
    printf '\033[1;33mnote\033[0m %s predates the ADV-3 sensor-report seal; sealing it with its own run key.\n' "$d"
    node "${HERE}/seal-legacy-report.mjs" "$d" \
      || { printf 'run-all.sh: %s cannot be forward-ported; re-run the matrix\n' "$d" >&2; exit 2; }
  fi
done

# ---------------------------------------------------------------------------
# AND WHAT IS *NOT* FORWARD-PORTABLE (round-5 audit, R5C).
#
# `observation.mjs` v2 folds a canonical digest of each event's `detail` into
# the request attestation the recording gateway writes; v1 hashed only
# [seq, t, kind], and rewriting a broker call's detail in both instrument-side
# copies turned a measured violation into a certifying PASS. A directory from
# before that bump cannot be repaired the way the sensor seal above can:
# recomputing the attestations from the cell results would make the SECOND
# OBSERVER agree by construction, which is precisely the forgery the
# attestation exists to make expensive. So it is refused, by k14's own
# preflight, naming the version and saying to drive a new matrix. Checked here
# too, before anything expensive starts, so the operator learns it in the plan
# rather than forty minutes in.
#
# AND IT LOOPED OVER --full-out ONLY (round-8 audit, R8-5). --partial-out feeds
# exactly one case, K4, and K4 is the one case that reads a partial directory's
# attestations. So a v1 --partial-out sailed through this preflight, twelve
# database-backed suites ran, and K4 then reported 11 hard failures every one of
# which said "observation version 1; this verdict derives version 2" — the exact
# failure mode the comment above says this block exists to prevent, arriving
# forty minutes in, from the other argument. MEASURED: run-all.sh over a v2
# --full-out and a v1 --partial-out is rc=1 with 17 of 17 cases reported, 16 PASS
# and K4 FAIL (3 passed / 1 failed); with a v2 partial the same invocation is
# 17 of 17 PASS. Both directories are checked now, by the same loop, and the
# message names WHICH argument is stale.
# ---------------------------------------------------------------------------
WANT_OBS_V=""
if [[ ( -n "$FULL_OUT" && -d "$FULL_OUT" ) || ( -n "$PARTIAL_OUT" && -d "$PARTIAL_OUT" ) ]]; then
  WANT_OBS_V="$(node -e '
    import("'"${HERE}"'/../driver/observation.mjs")
      .then((m) => process.stdout.write(String(m.OBSERVATION_VERSION)));
  ')"
  [[ -n "$WANT_OBS_V" ]] || { printf 'run-all.sh: could not read OBSERVATION_VERSION\n' >&2; exit 2; }
fi
# THE POSITIVE CONTROL ON THE DETECTOR, because "no stale directory found" is
# also what a preflight that cannot read a version produces — and a preflight
# that inspected nothing is exactly how this block missed --partial-out for
# five rounds. The extractor is therefore shown to find a PLANTED instance
# before it is believed about any real directory: a synthetic gateway line at
# version 1 must read back as 1, and one at the current version must read back
# as the current version. If it answers "" to the planted v1 line, every
# directory below would look forward-portable and the check would be silence.
if [[ -n "$WANT_OBS_V" ]]; then
  obs_probe="$(mktemp -d /tmp/nt-runall-obsprobe-XXXXXX)"
  printf '{"seq":1,"t":1,"cell":"probe#1","kind":"harness","path":"/__canary/observe","observation":{"v":1,"digest":"x"}}\n' \
    > "${obs_probe}/v1.jsonl"
  printf '{"seq":1,"t":1,"cell":"probe#1","kind":"harness","path":"/__canary/observe","observation":{"v":%s,"digest":"x"}}\n' \
    "$WANT_OBS_V" > "${obs_probe}/vnow.jsonl"
  read_obs_v() {  # file -> the first attestation version in it, or ""
    K14_JSONL="${HERE}/k14-jsonl.cjs" node -e '
const J = require(process.env.K14_JSONL);
for (const e of J.read(process.argv[1]).rows) {
  if (e.observation && e.observation.v !== undefined) { process.stdout.write(String(e.observation.v)); break; }
}
' "$1"
  }
  probe_v1="$(read_obs_v "${obs_probe}/v1.jsonl")"
  probe_now="$(read_obs_v "${obs_probe}/vnow.jsonl")"
  rm -rf "$obs_probe"
  if [[ "$probe_v1" != "1" || "$probe_now" != "$WANT_OBS_V" ]]; then
    printf 'run-all.sh: the attestation-version preflight cannot read a PLANTED version: a synthetic\n' >&2
    printf 'run-all.sh: v1 line read back as %s and a v%s line as %s. A version check that cannot find\n' \
      "${probe_v1:-<nothing>}" "$WANT_OBS_V" "${probe_now:-<nothing>}" >&2
    printf 'run-all.sh: a version it was handed is silence, and silence here is indistinguishable from\n' >&2
    printf 'run-all.sh: "every supplied directory is current". Fix the reader, do not skip the check.\n' >&2
    exit 2
  fi
fi
obs_dirs_scanned=0
obs_files_scanned=0
for pair in "full-out:${FULL_OUT}" "partial-out:${PARTIAL_OUT}"; do
  which_arg="${pair%%:*}"
  d="${pair#*:}"
  [[ -n "$d" && -d "$d" ]] || continue
  obs_dirs_scanned=$(( obs_dirs_scanned + 1 ))
  for s in 0008 0023; do
    [[ -f "$d/sink-${s}.jsonl" ]] || continue
    obs_files_scanned=$(( obs_files_scanned + 1 ))
    # Round-7 audit: through the ONE tolerant JSONL reader, which says on stderr
    # what it could not parse instead of skipping it in a bare catch. This
    # preflight only needs the first attestation version it can find; the
    # verdict is what refuses an unparseable line, and k14's GREEN/MEASURED are
    # what report one in --full-out.
    got="$(K14_JSONL="${HERE}/k14-jsonl.cjs" node -e '
const J = require(process.env.K14_JSONL);
for (const e of J.read(process.argv[1]).rows) {
  if (e.observation && e.observation.v !== undefined) { process.stdout.write(String(e.observation.v)); break; }
}
' "$d/sink-${s}.jsonl")"
    [[ -z "$got" || "$got" == "$WANT_OBS_V" ]] || {
      printf 'run-all.sh: --%s %s carries request attestation version %s; this checkout derives %s.\n' \
        "$which_arg" "$d" "$got" "$WANT_OBS_V" >&2
      printf 'run-all.sh: that directory predates the round-5 binding of each event DETAIL and CANNOT be\n' >&2
      printf 'run-all.sh: forward-ported without forging the gateway agreement. Drive a new matrix.\n' >&2
      printf 'run-all.sh: (a 1-cell run is enough for --partial-out: run.sh --schema 0023 --cells 1 ...)\n' >&2
      exit 2
    }
  done
done
# A directory with no sink log at all is not refused here — k11 drives the plan
# with a stub artefact directory on purpose, and the suites that need a real one
# refuse for themselves. What must never happen silently is the case above: a
# reader that cannot see a version. The two counts are printed only when the
# preflight actually had something to look at, so the reader can tell the two
# situations apart.
if [[ "$obs_dirs_scanned" -gt 0 && "$obs_files_scanned" -eq 0 ]]; then
  printf '\033[1;33mnote\033[0m the attestation-version preflight found no sink-<gen>.jsonl in the %s ' \
    "$obs_dirs_scanned" >&2
  printf 'artefact directory/directories supplied; nothing was version-checked.\n' >&2
fi

# ---------------------------------------------------------------------------
# THE PLAN IS DECIDED, AND REFUSED, BEFORE ANYTHING EXPENSIVE HAPPENS.
#
# The skip-is-a-failure rule used to live only at the bottom of the file, in
# `skip()`. That is correct but late: a default `run-all.sh --target-root X`
# built two ~1.3 GB fixture images and ran seven database-backed suites before
# announcing that the three artefact-driven ones — the A1/A2/B1 regression
# tests — had never run. Deciding here means the refusal is instant, and it
# means the decision is TESTABLE without a docker daemon: `--print-plan`
# prints what would run and exits, which is what tests/k11-runner-omission
# asserts against. A runner whose omission behaviour cannot be tested cheaply
# is a runner whose omission behaviour will not be tested.
# ---------------------------------------------------------------------------
plan_status() {  # case-label -> "RUN" or "SKIP: reason"
  case "$1" in
    "K2 sensor removal")
      [[ -n "$FULL_OUT" ]] && echo RUN || echo "SKIP: no --full-out artefact directory given" ;;
    "K4 partial verdict")
      [[ -n "$FULL_OUT" && -n "$PARTIAL_OUT" ]] && echo RUN \
        || echo "SKIP: needs both --partial-out and --full-out" ;;
    "K9 cell+generation identity")
      [[ -n "$FULL_OUT" ]] && echo RUN \
        || echo "SKIP: no --full-out artefact directory given (this is the A1/A2/B1 regression suite)" ;;
    "K13 transcript integrity")
      [[ -n "$FULL_OUT" ]] && echo RUN \
        || echo "SKIP: no --full-out artefact directory given" ;;
    "K14 observer-derived claims")
      [[ -n "$FULL_OUT" ]] && echo RUN \
        || echo "SKIP: no --full-out artefact directory given (this is the D/B/C/E/F regression suite)" ;;
    "K15 run controls")
      [[ -n "$FULL_OUT" ]] && echo RUN \
        || echo "SKIP: no --full-out artefact directory given (this is the R7-3/R7-4 regression suite)" ;;
    "K16 data-plane surface coverage")
      [[ -n "$FULL_OUT" ]] && echo RUN \
        || echo "SKIP: no --full-out artefact directory given (this is the R8-1/R8-2/R8-3 regression suite)" ;;
    *) echo RUN ;;
  esac
}

ARTEFACT_CASES=("K2 sensor removal" "K4 partial verdict" "K9 cell+generation identity"
                "K13 transcript integrity" "K14 observer-derived claims" "K15 run controls"
                "K16 data-plane surface coverage")

# ---------------------------------------------------------------------------
# ONE LIST. THE PLAN AND THE EXECUTION ARE THE SAME LIST.
#
# The B8(iii) repair above made a MISSING ARTEFACT DIRECTORY a failure, and
# tests/k11-runner-omission.test.sh holds that in place. It did not close the
# same defect one level in: `--print-plan` printed a hand-written list of case
# labels, and the execution below was a separate hand-written sequence of `run`
# calls. Nothing compared them. Measured, not reasoned about: deleting the line
#
#     run "K10 tamper role scope"        "${HERE}/k10-role-scope.test.sh"
#
# left `--print-plan` still printing "K10 tamper role scope   RUN", left K11
# GREEN, and would have produced a summary that simply has no K10 row and exits
# 0. A plan that is not the thing that runs is a coverage claim computed against
# a set whose completeness is the question — the defect this whole programme
# keeps finding, one level down from where it was last found.
#
# So the labels are declared ONCE, `case_argv` must have a command for every
# declared label, and the execution loop iterates the declaration. A case can no
# longer be dropped from the run while remaining in the plan (the loop is the
# plan), nor run without being declared (there is no other invocation site).
# `--print-plan` runs the dispatch self-check, so the property is testable in
# milliseconds without a docker daemon.
# ---------------------------------------------------------------------------
CASE_LABELS=(
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

# label -> the argv that runs it, in the global array ARGV. Returns 1 for a
# label it does not know, which is what the self-check below detects.
ARGV=()
case_argv() {
  ARGV=()
  case "$1" in
    "build 0023 schema base")
      ARGV=("${HERE}/build-schema-base.sh" --generation 0023 --target-root "$TARGET_ROOT") ;;
    "build 0008 schema base")
      ARGV=("${HERE}/build-schema-base.sh" --generation 0008 --target-root "$TARGET_ROOT") ;;
    "K11 runner omission")         ARGV=("${HERE}/k11-runner-omission.test.sh") ;;
    "K12 verifier digest scope")   ARGV=("${HERE}/k12-verifier-digest.test.sh") ;;
    "K5 make-mutant delete guard") ARGV=("${HERE}/k5-delete-guard.test.sh") ;;
    "K3 reuse guard")              ARGV=("${HERE}/k3-reuse-guard.test.sh") ;;
    "K8 baseline expectation")     ARGV=("${HERE}/k8-baseline-expectation.test.sh") ;;
    "K6 tombstone binding")        ARGV=("${HERE}/k6-tombstone-binding.test.sh") ;;
    "K1 sensor negative controls") ARGV=("${HERE}/k1-sensor-negative-controls.sh") ;;
    "K10 tamper role scope")       ARGV=("${HERE}/k10-role-scope.test.sh") ;;
    "K2 claim completeness")       ARGV=("${HERE}/k2-claim-completeness.sh") ;;
    "K2 sensor removal")
      ARGV=("${HERE}/k2-sensor-removal.test.sh" --out "$FULL_OUT") ;;
    "K4 partial verdict")
      ARGV=("${HERE}/k4-partial-run.test.sh" --partial-out "$PARTIAL_OUT" --full-out "$FULL_OUT") ;;
    "K9 cell+generation identity")
      ARGV=("${HERE}/k9-cell-identity.test.sh" --full-out "$FULL_OUT") ;;
    "K13 transcript integrity")
      ARGV=("${HERE}/k13-transcript-integrity.test.sh" --out "$FULL_OUT") ;;
    "K14 observer-derived claims")
      ARGV=("${HERE}/k14-observer-derived.test.sh" --full-out "$FULL_OUT") ;;
    "K15 run controls")
      ARGV=("${HERE}/k15-run-controls.test.sh" --full-out "$FULL_OUT") ;;
    "K16 data-plane surface coverage")
      ARGV=("${HERE}/k16-surface-coverage.test.sh" --full-out "$FULL_OUT") ;;
    *) return 1 ;;
  esac
  return 0
}


# The self-check. A declared case with no command would otherwise be discovered
# as a missing summary row after twenty minutes of fixture building, and a case
# whose script has been deleted or renamed would be discovered as rc=127.
undispatchable=()
missing_script=()
for c in "${CASE_LABELS[@]}"; do
  if case_argv "$c"; then
    [[ -x "${ARGV[0]}" ]] || missing_script+=("${c} -> ${ARGV[0]}")
  else
    undispatchable+=("$c")
  fi
done
if [[ "${#undispatchable[@]}" -gt 0 || "${#missing_script[@]}" -gt 0 ]]; then
  printf 'run-all.sh: the declared plan and the runnable cases have diverged.\n' >&2
  for c in "${undispatchable[@]}"; do
    printf '  declared in CASE_LABELS but case_argv has no command: %s\n' "$c" >&2
  done
  for c in "${missing_script[@]}"; do
    printf '  declared, but its script is missing or not executable: %s\n' "$c" >&2
  done
  printf 'A plan that is not what runs is not a plan. Fix the table, do not delete the case.\n' >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# AND THE DIRECTION NOTHING CHECKED: THE DISK -> THE PLAN.
#
# The self-check below asks "does every declared case have a runnable script?".
# It never asked the converse — "is every suite on disk declared?" — so a test
# file added to this directory was simply never run, by anything, and no output
# anywhere said so. That is the defect this programme has already found twice
# in other shapes (a vitest config that silently ignored four test files; this
# runner skipping two suites), and the roster in k11 does not close it either,
# because that roster is a hand-written list too: a suite absent from BOTH
# lists is absent from both checks.
#
# So the FILESYSTEM is enumerated and every executable test script must be
# either a declared case or an explicitly named non-case. A new suite is
# therefore refused until someone declares it — deliberately, in this table —
# rather than existing on disk while never running.
#
# AND THEN THE SAME DEFECT, ONE SHAPE ALONG. The enumeration was
#
#     find "$HERE" -maxdepth 1 -type f -name '*.sh'
#
# so it could only see a suite that was (i) directly in this directory and
# (ii) named `*.sh`. A suite added as `k99.py`, `k99.mjs`, or as
# `tests/whatever/k99.test.sh` was invisible to the disk check for exactly the
# reason a suite absent from CASE_LABELS was invisible to the plan — and being
# invisible to both is the state this block exists to make impossible. The
# harness already has non-bash executables (`driver/*.mjs`,
# `instrument/*.cjs`, `mutant/positive-mutants.cjs`), so "a future suite is a
# `.sh` in this directory" was an assumption, not a fact.
#
# The enumeration is now RECURSIVE and EXTENSION-AGNOSTIC: every regular file
# under this directory that is executable, or that carries any recognised
# script extension, is a suite candidate and must be accounted for. Paths are
# compared relative to this directory, so two files with the same basename in
# different subdirectories cannot exempt each other. k11's N6/N7/N8 plant a
# `.sh`, a `.py` and a file in a subdirectory and require all three to be
# named — a scan believed without a planted instance is not a scan.
# ---------------------------------------------------------------------------
NON_CASE_SCRIPTS=(
  "run-all.sh"              # this runner
  "build-schema-base.sh"    # a fixture builder, invoked as two declared cases
  "lib-schema-base.sh"      # a sourced library, not a suite
  # A fixture migration, not a suite: it seals an artefact directory produced
  # before the ADV-3 report seal, using that run's own key, so the certifying
  # suites can read a corpus that predates the check. It asserts nothing, and
  # is invoked above (and by k14 standalone) rather than as a case. It REFUSES
  # when the run key is absent, so it cannot manufacture a seal.
  "seal-legacy-report.mjs"
  # A sourced library, not a suite: the ONE JSONL reader k14's planting
  # helpers use, so a helper cannot abort on an unparseable line in the
  # fixture it was handed. It is `require`d (K14_JSONL=…), never executed as
  # a case, and it asserts nothing on its own.
  "k14-jsonl.cjs"
)
# Any file with one of these suffixes counts even when the executable bit is
# missing — a suite committed without +x is a suite that does not run, which is
# the failure this block is about, not an excuse to ignore it.
SUITE_EXTS=(sh bash py mjs cjs js ts pl rb)
is_suite_candidate() {  # path -> 0 when it must be accounted for
  local p="$1" e
  [[ -x "$p" ]] && return 0
  for e in "${SUITE_EXTS[@]}"; do [[ "$p" == *".${e}" ]] && return 0; done
  return 1
}
undeclared_on_disk=()
scanned_on_disk=0
saw_self=0
while IFS= read -r rel; do
  [[ -n "$rel" ]] || continue
  is_suite_candidate "${HERE}/${rel}" || continue
  scanned_on_disk=$(( scanned_on_disk + 1 ))
  [[ "$rel" == "run-all.sh" ]] && saw_self=1
  skip=0
  for n in "${NON_CASE_SCRIPTS[@]}"; do [[ "$rel" == "$n" ]] && skip=1; done
  [[ "$skip" -eq 1 ]] && continue
  declared=0
  for c in "${CASE_LABELS[@]}"; do
    if case_argv "$c"; then
      argv_rel="${ARGV[0]}"
      argv_rel="${argv_rel#"${HERE}/"}"
      [[ "$argv_rel" == "$rel" ]] && { declared=1; break; }
    fi
  done
  [[ "$declared" -eq 1 ]] || undeclared_on_disk+=("$rel")
done < <(find "$HERE" -type f -printf '%P\n' | LC_ALL=C sort)
# THE POSITIVE CONTROL ON THE SCAN ITSELF.
#
# "no undeclared suites on disk" is a count-of-zero assertion, and a count of
# zero is also what a scan that cannot see anything produces — a mistyped
# `-name`, a wrong root, a `find` that failed. So the scan must be shown to
# work on an instance known to exist, and the one file guaranteed to be there
# is this runner. If the enumeration cannot find run-all.sh in the directory
# run-all.sh lives in, nothing it says about the other files means anything.
if [[ "$scanned_on_disk" -lt 1 || "$saw_self" -ne 1 ]]; then
  printf 'run-all.sh: the on-disk suite scan of %s is not working: it found %s file(s)\n' \
    "$HERE" "$scanned_on_disk" >&2
  printf 'and did NOT find run-all.sh, which is certainly there. A scan that cannot find a\n' >&2
  printf 'file it is standing in cannot be believed when it reports none are undeclared.\n' >&2
  exit 2
fi
if [[ "${#undeclared_on_disk[@]}" -gt 0 ]]; then
  printf 'run-all.sh: these test scripts exist in %s but no declared case runs them:\n' "$HERE" >&2
  for b in "${undeclared_on_disk[@]}"; do printf '  %s\n' "$b" >&2; done
  printf 'A suite that is on disk and never run is not a suite that passed. Declare it in\n' >&2
  printf 'CASE_LABELS/case_argv, or name it in NON_CASE_SCRIPTS with a reason.\n' >&2
  exit 2
fi

WOULD_SKIP=()
for c in "${ARTEFACT_CASES[@]}"; do
  [[ "$(plan_status "$c")" == RUN ]] || WOULD_SKIP+=("$c")
done
# Every artefact case must be a declared case, or the refusal above is guarding
# a label the runner never intends to execute.
for c in "${ARTEFACT_CASES[@]}"; do
  found=0
  for d in "${CASE_LABELS[@]}"; do [[ "$d" == "$c" ]] && found=1; done
  if [[ "$found" -eq 0 ]]; then
    printf 'run-all.sh: %s is treated as an artefact case but is not a declared case\n' "$c" >&2
    exit 2
  fi
done

if [[ "${#WOULD_SKIP[@]}" -gt 0 && "$ALLOW_SKIPS" -ne 1 ]]; then
  printf 'run-all.sh: refusing to run a suite that would not exercise: %s\n' \
    "$(IFS='; '; printf '%s' "${WOULD_SKIP[*]}")" >&2
  for c in "${WOULD_SKIP[@]}"; do
    printf '  %-30s %s\n' "$c" "$(plan_status "$c")" >&2
  done
  printf 'A skipped attack is not a passed attack. Supply the artefact directories,\n' >&2
  printf 'or pass --allow-skips for a run that is explicitly NOT a certification.\n' >&2
  exit 2
fi

if [[ "$PRINT_PLAN" -eq 1 ]]; then
  printf 'run-all.sh plan (--target-root %s)\n' "$TARGET_ROOT"
  for c in "${CASE_LABELS[@]}"; do
    printf '  %-34s %s\n' "$c" "$(plan_status "$c")"
  done
  printf '  %-34s %s\n' "K7 Server Actions" \
    "NOT COVERED HERE: no executed test exists; covered statically in the bridge checkout"
  if [[ "${#WOULD_SKIP[@]}" -gt 0 ]]; then
    printf '\n  --allow-skips was given: this suite run would NOT be a certification.\n'
  fi
  exit 0
fi

results=()
reported=()      # the LABEL of every case that produced a summary row
overall=0
run() {  # label, command...
  local label="$1"; shift
  printf '\n\033[1m>>> %s\033[0m\n' "$label"
  set +e
  "$@"
  local rc=$?
  set -e
  results+=("$(printf '%-34s %s' "$label" "$( [[ $rc -eq 0 ]] && echo 'PASS' || echo "FAIL(rc=$rc)")")")
  reported+=("$label")
  [[ $rc -eq 0 ]] || overall=1
}
# A suite that cannot run is a suite that did not pass. Without --allow-skips
# this is a FAILURE, and the summary says which artefact it needed.
skip() {
  if [[ "$ALLOW_SKIPS" -eq 1 ]]; then
    results+=("$(printf '%-34s %s' "$1" "SKIPPED (--allow-skips) — $2")")
  else
    results+=("$(printf '%-34s %s' "$1" "FAIL(not run) — $2; pass it, or --allow-skips to run non-certifying")")
    overall=1
  fi
  reported+=("$1")
}

# The schema fixtures every database-backed case needs. Their tags are
# content-keyed over the migrations, bootstrap and seed that go into them, so
# they are RESOLVED here and exported: a child suite must never spell the tag.
export NT_CANARY_TARGET_ROOT="$TARGET_ROOT"

# Things that must happen at a particular point in the sequence, expressed as
# hooks on the declared case rather than as extra statements between `run`
# calls — an extra statement between `run` calls is how the two lists drifted
# apart in the first place.
pre_case()  {
  case "$1" in
    "K9 cell+generation identity")
      # K9 needs BOTH generations for its cross-generation attacks. Say so here
      # rather than letting the suite discover it as three failures.
      local g have_both=1
      for g in 0008 0023; do
        [[ -n "$(find "$FULL_OUT/cells" -name "result-${g}-*.json" -print -quit 2>/dev/null)" ]] || have_both=0
      done
      if [[ "$have_both" -eq 0 ]]; then
        printf '\033[1;33m   note\033[0m %s holds only one migration generation; K9 R5/R6/R7 are cross-generation\n' "$FULL_OUT"
      fi ;;
  esac
}
post_case() {
  case "$1" in
    "build 0008 schema base")
      # The fixture tags are content-keyed over the migrations, bootstrap and
      # seed that go into them. They are RESOLVED here and exported: a child
      # suite must never spell the tag.
      local gen tag
      for gen in 0008 0023; do
        if tag="$("${HERE}/build-schema-base.sh" --generation "$gen" --target-root "$TARGET_ROOT" --print-tag)"; then
          export "NT_CANARY_PG_BASE_${gen}=${tag}"
          printf '   fixture %s -> %s\n' "$gen" "$tag"
        else
          printf 'run-all.sh: could not resolve the %s fixture tag\n' "$gen" >&2
          exit 2
        fi
      done ;;
  esac
}

# THE EXECUTION IS THE PLAN. K11 and K12 need no fixture and no docker, and are
# ordered early in CASE_LABELS so that a runner which has quietly gone back to
# omitting cases, or a harness that has been edited out from under its pin, is
# caught before anything expensive starts.
for c in "${CASE_LABELS[@]}"; do
  st="$(plan_status "$c")"
  if [[ "$st" == RUN ]]; then
    if ! case_argv "$c"; then
      printf 'run-all.sh: no command for declared case %s\n' "$c" >&2
      exit 2
    fi
    pre_case "$c"
    run "$c" "${ARGV[@]}"
    post_case "$c"
  else
    skip "$c" "${st#SKIP: }"
  fi
done

# ---------------------------------------------------------------------------
# THE SUMMARY MUST ACCOUNT FOR EVERY DECLARED CASE.
#
# The loop above makes a silent omission structurally impossible, which is
# exactly why this check is here: a structural argument is a claim, and this is
# the assertion that holds it. If a future edit reintroduces a conditional that
# runs a case without recording it — or records one that was never declared —
# the summary says so and the run fails, rather than printing a short list that
# reads as a clean sweep.
# ---------------------------------------------------------------------------
unaccounted=()
for c in "${CASE_LABELS[@]}"; do
  seen=0
  for r in "${reported[@]}"; do [[ "$r" == "$c" ]] && seen=$(( seen + 1 )); done
  [[ "$seen" -eq 1 ]] || unaccounted+=("${c} (reported ${seen} times, expected 1)")
done
undeclared=()
for r in "${reported[@]}"; do
  known=0
  for c in "${CASE_LABELS[@]}"; do [[ "$c" == "$r" ]] && known=1; done
  [[ "$known" -eq 1 ]] || undeclared+=("$r")
done

printf '\n\033[1m=== summary ===\033[0m\n'
printf '  %s\n' "${results[@]}"
printf '  %-34s %s\n' "(cases accounted for)" \
  "${#reported[@]} of ${#CASE_LABELS[@]} declared"
if [[ "${#unaccounted[@]}" -gt 0 || "${#undeclared[@]}" -gt 0 ]]; then
  printf '\n\033[1;31m  THE SUMMARY DOES NOT ACCOUNT FOR THE DECLARED PLAN:\033[0m\n'
  for c in "${unaccounted[@]}";  do printf '    declared but not reported once: %s\n' "$c"; done
  for c in "${undeclared[@]}";   do printf '    reported but never declared   : %s\n' "$c"; done
  overall=1
fi
printf '  %-34s %s\n' "K7 Server Actions" \
  "NOT COVERED HERE: no executed test exists; covered statically in the bridge checkout"
if [[ "$ALLOW_SKIPS" -eq 1 ]]; then
  printf '\n\033[1;33m  --allow-skips was given: this suite run is NOT a certification.\033[0m\n'
fi
exit "$overall"
