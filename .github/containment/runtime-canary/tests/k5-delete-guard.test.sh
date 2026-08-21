#!/usr/bin/env bash
# ============================================================================
# k5-delete-guard.test.sh — make-mutant.sh must not rm -rf its way into a
#                           git worktree
#
# The guard under test is a DELETE guard: the statement immediately after it is
# `rm -rf "$TO"`. So every case here is checked two ways — the exit status, and
# whether a canary file inside the victim directory still exists afterwards. A
# guard that refused with the right message after deleting the tree would pass
# a status-only test.
#
# There is a POSITIVE CONTROL (case P) as well as the refusals: a guard that
# rejected everything would pass all the negative cases and make the script
# useless. It has to still accept an ordinary scratch path.
#
# Exit: 0 all cases behaved, 1 otherwise.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MM="${HERE}/../mutant/make-mutant.sh"
GITREPO="$(cd "${HERE}/../../../.." && pwd)"

WORK="$(mktemp -d /tmp/nt-k5-XXXXXX)"
# The victim deliberately lives OUTSIDE /tmp, because that is the whole point of
# the traversal: a string-prefix guard sees "/tmp/..." and lets it through.
VICTIM_ROOT="${HOME}/.cache/nt-canary-k5-victim-$$"

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
CASES_INTENDED=(A B C D E F P)
CASES_SEEN=()
COMPLETED=0
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }

cleanup() {
  local __rc=$?
  rm -rf "$WORK" "$VICTIM_ROOT"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk5: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$__rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( __rc == 0 ? 2 : __rc ))"
  fi
}
trap cleanup EXIT

pass=0; fail=0
ok()   { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad()  { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }

# --- a minimal but valid --from tree ---------------------------------------
FROM="$WORK/from"
mkdir -p "$FROM/app/api/accounts/[id]"
printf 'frozen\n' > "$FROM/app/api/accounts/[id]/route.ts"

make_victim() {  # $1 = directory to create as a git worktree with a canary file
  rm -rf "$1"
  mkdir -p "$1/dashboard/app/api/accounts/[id]"
  git init -q "$1"
  printf 'PRECIOUS USER WORK\n' > "$1/dashboard/CANARY_FILE.txt"
  printf 'x\n' > "$1/dashboard/app/api/accounts/[id]/route.ts"
}

# `--restore-from-git` is only read AFTER the guard, so the run is expected to
# fail for one of two reasons; the test distinguishes them.
run_mm() {  # $1 = --to value ; prints combined output, returns rc
  set +e
  "$MM" --from "$FROM" --to "$1" --restore-from-git "$GITREPO" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

expect_refused() {  # label, --to value, victim canary path (may be empty)
  local label="$1" to="$2" canary="$3" out rc
  set +e
  out="$(run_mm "$to")"
  rc=$?
  set -e
  if [[ "$rc" -eq 0 ]]; then
    bad "$label: exited 0; the guard did not refuse"
    printf '%s\n' "$out" | sed 's/^/       /'
    return
  fi
  # The exact failure class, not "some non-zero exit": the message has to name
  # the guard, otherwise a crash somewhere else would score as a refusal.
  if ! grep -qE 'refusing to rm -rf it|must RESOLVE to a path inside|--to could not be resolved|the parent of --to does not exist' <<< "$out"; then
    bad "$label: rc=$rc but not for the guard's reason"
    printf '%s\n' "$out" | sed 's/^/       /'
    return
  fi
  if [[ -n "$canary" && ! -f "$canary" ]]; then
    bad "$label: refused (rc=$rc) but the victim was ALREADY DELETED"
    return
  fi
  ok "$label: refused (rc=$rc)$( [[ -n "$canary" ]] && printf ', victim intact' )"
}

printf '\n== K5 make-mutant.sh --to delete guard ==\n\n'

# --- A. the exact traversal the verifier found -----------------------------
make_victim "$VICTIM_ROOT"
expect_refused "A traversal out of /tmp into a worktree" \
  "/tmp/..${VICTIM_ROOT}/dashboard" "$VICTIM_ROOT/dashboard/CANARY_FILE.txt"

# --- B. the bare prefix the old guard also accepted ------------------------
expect_refused "B bare '/tmp/'" "/tmp/" ""

# --- C. a symlinked leaf pointing at a worktree ----------------------------
make_victim "$VICTIM_ROOT"
ln -sfn "$VICTIM_ROOT/dashboard" "$WORK/link-to-victim"
expect_refused "C symlinked leaf under /tmp -> worktree" \
  "$WORK/link-to-victim" "$VICTIM_ROOT/dashboard/CANARY_FILE.txt"

# --- D. a symlinked ANCESTOR component -------------------------------------
make_victim "$VICTIM_ROOT"
ln -sfn "$VICTIM_ROOT" "$WORK/link-to-victim-root"
expect_refused "D symlinked ancestor under /tmp -> worktree" \
  "$WORK/link-to-victim-root/dashboard" "$VICTIM_ROOT/dashboard/CANARY_FILE.txt"

# --- E. a git worktree that really is under /tmp ---------------------------
TMP_VICTIM="$WORK/tmp-worktree"
make_victim "$TMP_VICTIM"
expect_refused "E a worktree that genuinely lives under /tmp" \
  "$TMP_VICTIM/dashboard" "$TMP_VICTIM/dashboard/CANARY_FILE.txt"

# --- F. a path whose parent does not exist ---------------------------------
expect_refused "F parent directory absent" "$WORK/no/such/parent/x" ""

# --- P. POSITIVE CONTROL: an ordinary scratch path is still accepted --------
# Without this, a guard that refused everything would score six for six above
# and leave property (B) unbuildable.
PLAIN="$WORK/plain-mutant"
set +e
pout="$(run_mm "$PLAIN")"
prc=$?
set -e
if [[ "$prc" -ne 0 ]] && grep -qE 'refusing to rm -rf it|must RESOLVE to a path inside' <<< "$pout"; then
  bad "P positive control: an ordinary /tmp path was refused by the guard"
  printf '%s\n' "$pout" | sed 's/^/       /'
elif [[ ! -d "$PLAIN" ]]; then
  bad "P positive control: the guard let it through but nothing was copied"
  printf '%s\n' "$pout" | sed 's/^/       /'
else
  # It is expected to fail LATER (this repo's HEAD file is not a mutant), which
  # is fine: the guard is what is under test here.
  ok "P positive control: an ordinary /tmp path passes the guard and is populated"
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
