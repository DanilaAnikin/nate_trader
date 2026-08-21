#!/usr/bin/env bash
# ============================================================================
# make-mutant.sh — build the deliberately-unfrozen source tree for property (B)
#
# Property (B) of the runtime canary is that the sensor can actually see a call.
# A sensor that has never fired is indistinguishable from a sensor that cannot
# fire, so the suite must contain an image that DOES reach the tombstoned
# wrappers. This script produces the source for it.
#
# The mutation is deliberately the smallest honest one: take the frozen bridge
# source and restore ONE file — `app/api/accounts/[id]/route.ts` — to the
# version already in the bridge branch's own history, from before the handlers
# were replaced by the constant refusal. That restores two mutation paths:
#
#   PATCH  -> reads the request body, constructs a cookie-bound and a
#             service-role Supabase client, authenticates, and writes
#             `accounts` + `audit_log` through PostgREST
#   DELETE -> the same, plus `purgeCredentials()`, which is the code path that
#             calls `vault_delete_secret` — one of the three tombstoned
#             wrappers the canary watches
#
# Nothing else is changed: same Dockerfile, same lockfile, same build script.
# So the difference between (A) and (B) is one file's contents, which is the
# only way "the frozen image does not reach the wrappers" is a claim about the
# freeze rather than about two unrelated builds.
#
# It refuses to write anywhere near a git worktree.
#
# THE `--to` GUARD IS A DELETE GUARD, NOT A STYLE CHECK
# -----------------------------------------------------
# The next thing this script does with `--to` is `rm -rf` it. The guard was
# once a bare prefix match on the literal string (`case "$TO" in /tmp/*`), which
# is not a guard at all: it accepts `/tmp/` itself, and it accepts
# `/tmp/../home/you/your-repo/dashboard`, which is a traversal straight back out
# of /tmp into a live worktree. That was demonstrated destroying a git
# worktree's contents while the script exited 0.
#
# So the path is resolved with `realpath -m` FIRST — which collapses every `..`
# and follows every symlink, including a symlinked leaf and a symlinked ancestor
# — and only the resolved path is tested. It must sit strictly inside the
# resolved /tmp, and neither it nor any ancestor may be a git worktree. Nothing
# is deleted until both hold.
#
# Usage:
#   ./make-mutant.sh --from <frozen-source-dir> --to <mutant-source-dir> \
#                    --restore-from-git <worktree> [--ref HEAD]
#
# Exit codes:
#   0  the mutant tree exists and differs from the frozen tree in exactly the
#      expected way
#   2  harness failure (including a refused --to)
# ============================================================================

set -Eeuo pipefail

EXIT_HARNESS=2

FROM=""
TO=""
GIT_DIR=""
REF="HEAD"
# Repo-relative, because that is how git addresses it.
readonly TARGET='dashboard/app/api/accounts/[id]/route.ts'
readonly TARGET_IN_TREE='app/api/accounts/[id]/route.ts'
# THE FREEZE IS TWO LAYERS, AND THIS SCRIPT ONLY UNDID ONE
# --------------------------------------------------------
# `lib/frozen.ts` says so explicitly: "The proxy keeps its own pre-authentication
# refusal. That is deliberate redundancy: two independent layers, either of which
# is sufficient." When the second layer arrived (`dashboard/proxy.ts`, added
# after the pre-freeze ref this script restores from), restoring the handler
# stopped being a mutation of anything observable. The tree still differed in
# exactly one file, `cmp` still said the file had changed, the `deleteAccount`
# and `frozenResponse` guards below still passed — and a full 24-cell
# `--mode mutant` run returned 503 on all 240 requests with `routeExec=0` and
# ZERO canary hits. Property (B) was silently dead: the harness was comparing
# the frozen image with itself.
#
# So the mutation is defined over BOTH layers. The proxy did not exist at the
# pre-freeze ref, so "restore it" means DELETE it; and if a file that enforces
# the freeze ahead of the handler survives into the mutant, this script refuses
# rather than producing a tree that only looks unfrozen.
readonly PROXY_IN_TREE='proxy.ts'
readonly PROXY='dashboard/proxy.ts'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)             FROM="${2:?}";    shift 2 ;;
    --to)               TO="${2:?}";      shift 2 ;;
    --restore-from-git) GIT_DIR="${2:?}"; shift 2 ;;
    --ref)              REF="${2:?}";     shift 2 ;;
    -h|--help) sed -n '2,38p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'make-mutant.sh: unknown argument: %s\n' "$1" >&2; exit "$EXIT_HARNESS" ;;
  esac
done

for v in FROM TO GIT_DIR; do
  if [[ -z "${!v}" ]]; then
    printf 'make-mutant.sh: --from, --to and --restore-from-git are all required\n' >&2
    exit "$EXIT_HARNESS"
  fi
done
if [[ ! -f "$FROM/$TARGET_IN_TREE" ]]; then
  printf 'make-mutant.sh: %s is not in the frozen source tree\n' "$FROM/$TARGET_IN_TREE" >&2
  exit "$EXIT_HARNESS"
fi

# --- the delete guard -------------------------------------------------------
# Sets TO_REAL to the resolved path, or returns non-zero having said why. It is
# a function rather than a command substitution on purpose: an `exit` inside
# `$( )` only leaves the subshell, so a guard written that way cannot stop the
# script it is guarding.
TO_REAL=""
validate_to() {
  local raw="$1" parent real probe tmp_real
  if [[ -z "$raw" ]]; then
    printf 'make-mutant.sh: --to is empty\n' >&2; return 1
  fi
  if ! tmp_real="$(realpath -e -- "${TMPDIR:-/tmp}" 2>/dev/null)"; then
    printf 'make-mutant.sh: cannot resolve the temporary directory\n' >&2; return 1
  fi
  parent="$(dirname -- "$raw")"
  if [[ ! -d "$parent" ]]; then
    printf 'make-mutant.sh: the parent of --to does not exist: %s\n' "$parent" >&2; return 1
  fi
  # -m so the leaf may be absent; every `..` is collapsed and every symlink —
  # leaf or ancestor — is followed before anything is tested.
  if ! real="$(realpath -m -- "$raw" 2>/dev/null)" || [[ -z "$real" ]]; then
    printf 'make-mutant.sh: --to could not be resolved: %s\n' "$raw" >&2; return 1
  fi
  case "$real" in
    "$tmp_real"/?*) ;;
    *) printf 'make-mutant.sh: --to must RESOLVE to a path inside %s; %s resolves to %s\n' \
              "$tmp_real" "$raw" "$real" >&2
       return 1 ;;
  esac
  # ...and it must not be, or live inside, a git worktree — even one somebody
  # put under /tmp. `.git` is a directory in a normal clone and a file in a
  # linked worktree, so both are tested.
  probe="$real"
  while :; do
    if [[ -e "$probe/.git" ]]; then
      printf 'make-mutant.sh: --to resolves to %s, which is inside the git worktree %s; refusing to rm -rf it\n' \
             "$real" "$probe" >&2
      return 1
    fi
    [[ "$probe" == "/" ]] && break
    probe="$(dirname -- "$probe")"
  done
  TO_REAL="$real"
  return 0
}
if ! validate_to "$TO"; then exit "$EXIT_HARNESS"; fi
if [[ "$TO_REAL" != "$TO" ]]; then
  printf 'make-mutant.sh: --to %s resolved to %s\n' "$TO" "$TO_REAL"
fi
TO="$TO_REAL"

rm -rf "$TO"
cp -a "$FROM" "$TO"

# `git -C <worktree> show` only READS the worktree's object store.
if ! git -C "$GIT_DIR" show "${REF}:${TARGET}" > "$TO/$TARGET_IN_TREE"; then
  printf 'make-mutant.sh: could not read %s:%s from %s\n' "$REF" "$TARGET" "$GIT_DIR" >&2
  exit "$EXIT_HARNESS"
fi

# --- the mutation must actually be a mutation ------------------------------
# A `cp` that silently produced an identical tree would make property (B) a
# test of the frozen image against itself, which always "passes" the freeze
# assertions and proves nothing about the sensor.
if cmp -s "$FROM/$TARGET_IN_TREE" "$TO/$TARGET_IN_TREE"; then
  printf 'make-mutant.sh: the restored file is identical to the frozen one; there is no mutant\n' >&2
  exit "$EXIT_HARNESS"
fi

# ...and it must be a mutation of the right KIND. Restoring some other old
# version of the file that also refuses writes would be just as useless.
if ! grep -q 'deleteAccount' "$TO/$TARGET_IN_TREE"; then
  printf 'make-mutant.sh: the restored handler does not call deleteAccount; it cannot reach vault_delete_secret\n' >&2
  exit "$EXIT_HARNESS"
fi
if grep -q 'frozenResponse' "$TO/$TARGET_IN_TREE"; then
  printf 'make-mutant.sh: the restored handler still returns the frozen constant\n' >&2
  exit "$EXIT_HARNESS"
fi

# --- the SECOND freeze layer -----------------------------------------------
# Restore the proxy to its pre-freeze state. It did not exist at the pre-freeze
# ref, so restoring it means removing it. Both outcomes are handled explicitly
# rather than assumed, because "it did not exist then" is a fact about the ref
# and has to be read from the ref.
PROXY_EXPECTED_STATE=""
if git -C "$GIT_DIR" cat-file -e "${REF}:${PROXY}" 2>/dev/null; then
  if ! git -C "$GIT_DIR" show "${REF}:${PROXY}" > "$TO/$PROXY_IN_TREE"; then
    printf 'make-mutant.sh: could not restore %s from %s\n' "$PROXY" "$REF" >&2
    exit "$EXIT_HARNESS"
  fi
  PROXY_EXPECTED_STATE="restored from ${REF}"
elif [[ -f "$TO/$PROXY_IN_TREE" ]]; then
  rm -f "$TO/$PROXY_IN_TREE"
  PROXY_EXPECTED_STATE="deleted (it did not exist at ${REF})"
else
  PROXY_EXPECTED_STATE="absent in both trees"
fi

# ...and now the check that would have caught the dead mutant: NOTHING may
# still refuse ahead of the handler. Any surviving edge file that pulls in the
# compile-time freeze constant makes the restored handler unreachable, and a
# run against such a tree measures the frozen image twice.
STILL_FROZEN=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  if grep -qE 'from "@/lib/frozen"|from "\./lib/frozen"|require\(.*lib/frozen' "$f"; then
    STILL_FROZEN+=("${f#"$TO"/}")
  fi
done < <(find "$TO" -maxdepth 2 \( -name 'proxy.ts' -o -name 'middleware.ts' -o -name 'proxy.js' -o -name 'middleware.js' \) -type f)
if [[ "${#STILL_FROZEN[@]}" -gt 0 ]]; then
  printf 'make-mutant.sh: the mutant tree still enforces the freeze AHEAD of the restored handler, in: %s\n' \
    "$(IFS=', '; echo "${STILL_FROZEN[*]}")" >&2
  printf '  A tree like this returns 503 with routeExec=0 on every request and produces ZERO canary hits.\n' >&2
  printf '  It is not a mutant: property (B) run against it compares the frozen image with itself.\n' >&2
  exit "$EXIT_HARNESS"
fi
# The positive side of the same statement: the frozen tree MUST have had such a
# layer, or this check can never fire and is not a check.
FROZEN_HAD_EDGE=0
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  grep -qE 'from "@/lib/frozen"|from "\./lib/frozen"|require\(.*lib/frozen' "$f" && FROZEN_HAD_EDGE=1
done < <(find "$FROM" -maxdepth 2 \( -name 'proxy.ts' -o -name 'middleware.ts' -o -name 'proxy.js' -o -name 'middleware.js' \) -type f)
if [[ "$FROZEN_HAD_EDGE" -eq 0 ]]; then
  printf 'make-mutant.sh: the FROZEN tree has no edge-layer freeze for this check to remove.\n' >&2
  printf '  Either the second layer moved, or the check is looking in the wrong place; refusing to guess.\n' >&2
  exit "$EXIT_HARNESS"
fi

# Exactly one file may differ.
#
# `diff -rq` exits 1 *because* it found a difference, which is the expected
# outcome here — so its status is captured and interpreted, never fed to
# `pipefail` (where it would abort the script) and never discarded with
# `|| true` (which would also hide a real diff failure, exit 2).
difflist="$(mktemp)"
set +e
diff -rq "$FROM" "$TO" > "$difflist" 2>&1
diff_rc=$?
set -e
if [[ "$diff_rc" -gt 1 ]]; then
  printf 'make-mutant.sh: diff itself failed (rc=%s)\n' "$diff_rc" >&2
  cat "$difflist" >&2
  exit "$EXIT_HARNESS"
fi
changed="$(wc -l < "$difflist")"
# The mutation is now defined over both freeze layers, so the expected number of
# differing paths depends on what the proxy needed. It is still an EXACT number:
# "at most a couple" would let an unrelated edit ride along.
expected_changed=1
[[ "$PROXY_EXPECTED_STATE" == "absent in both trees" ]] || expected_changed=2
if [[ "$changed" != "$expected_changed" ]]; then
  printf 'make-mutant.sh: expected exactly %s differing path(s), found %s:\n' "$expected_changed" "$changed" >&2
  cat "$difflist" >&2
  exit "$EXIT_HARNESS"
fi
# ...and they must be the two paths the mutation is defined over, not any two.
# -F, because the path contains `[id]`, which a regex reads as a character class
# and which therefore matches almost nothing.
if ! grep -Fq "$TARGET_IN_TREE" "$difflist"; then
  printf 'make-mutant.sh: the restored handler is not among the differing paths:\n' >&2
  cat "$difflist" >&2
  exit "$EXIT_HARNESS"
fi
if [[ "$expected_changed" == "2" ]] && ! grep -Fq "$PROXY_IN_TREE" "$difflist"; then
  printf 'make-mutant.sh: the proxy is not among the differing paths:\n' >&2
  cat "$difflist" >&2
  exit "$EXIT_HARNESS"
fi
rm -f "$difflist"

printf 'mutant ready: %s\n' "$TO"
printf '  handler restored from %s:%s\n' "$REF" "$TARGET"
printf '  proxy         : %s\n' "$PROXY_EXPECTED_STATE"
printf '  frozen sha256 : %s\n' "$(sha256sum "$FROM/$TARGET_IN_TREE" | cut -d' ' -f1)"
printf '  mutant sha256 : %s\n' "$(sha256sum "$TO/$TARGET_IN_TREE"   | cut -d' ' -f1)"
printf '  no edge layer in the mutant still imports the compile-time freeze constant\n'
