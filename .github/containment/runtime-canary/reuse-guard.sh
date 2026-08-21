#!/usr/bin/env bash
# ============================================================================
# reuse-guard.sh — resolve a REUSED file from the target checkout and check it
#                  against a digest that only the trusted checkout can state
#
# WHAT WENT WRONG BEFORE
# ----------------------
# The harness wanted to reuse `dashboard/test/schema-compat/sql/00_env_bootstrap.sql`
# rather than reinvent what storage-api creates. That file lives on the bridge
# branch. The old resolver did this:
#
#     if   [[ -n "$explicit" ]]; then chosen="$explicit"
#     elif [[ -f "$canonical" ]]; then chosen="$canonical"
#     else chosen="$vendored"; fi
#     sha256 "$chosen" == sha256 "$vendored"   || fail
#
# On `main` the canonical path does not exist, so `chosen` became the vendored
# copy and the "drift check" compared a file with ITSELF. Every run printed
# "(reused, drift-checked)" having checked nothing: tampering with the vendored
# copy so that it no longer matched the bridge's real file still passed.
#
# WHAT THIS DOES INSTEAD
# ----------------------
# Two physically distinct checkouts, with different jobs:
#
#   TRUSTED root — the verifier/policy checkout. It states the EXPECTED digest,
#                  and nothing else about it is negotiable. Its own HEAD sha and
#                  a digest over the harness tree are recorded in the report.
#   TARGET root  — the bridge checkout under test. The reused file is read from
#                  here and from nowhere else.
#
# and then:
#
#   * both roots must be real git worktrees, at the exact SHAs the caller
#     asserted (a stale trusted checkout is not a trusted checkout);
#   * the roots must be physically distinct — different resolved paths AND
#     different device:inode, so a bind mount or a hardlinked alias cannot make
#     one stand in for the other;
#   * the expected digest is read ONLY from inside the trusted root. A digest
#     passed on the command line is refused outright, and a digest file that
#     resolves inside the target root is refused as untrusted;
#   * the reused file is read ONLY from inside the target root, and its
#     RESOLVED path must still be inside it, so a symlink cannot substitute
#     another file;
#   * there is NO FALLBACK. A missing canonical file is a hard failure, not a
#     reason to quietly use a copy the harness ships.
#
# Usage:
#   reuse-guard.sh --label bootstrap \
#                  --trusted-root DIR --trusted-sha SHA \
#                  --target-root  DIR --target-sha  SHA \
#                  --file  <path relative to the TARGET root> \
#                  --digest-file <path relative to the TRUSTED root>
#
# On success prints, on stdout, exactly one line:
#   REUSE_OK <label> <absolute resolved file> <sha256>
# Everything else goes to stderr, prefixed REUSE_FAIL=<code>.
#
# Exit codes:  0 ok    2 harness misuse    3 a control failed
# ============================================================================

set -Eeuo pipefail

readonly EXIT_HARNESS=2
readonly EXIT_CONTROL=3

LABEL=""
TRUSTED_ROOT=""
TRUSTED_SHA=""
TARGET_ROOT=""
TARGET_SHA=""
REL_FILE=""
REL_DIGEST=""

die() {  # code, reason-code, message...
  local rc="$1" reason="$2"; shift 2
  printf 'REUSE_FAIL=%s %s\n' "$reason" "$*" >&2
  exit "$rc"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)        LABEL="${2:?}";        shift 2 ;;
    --trusted-root) TRUSTED_ROOT="${2:?}"; shift 2 ;;
    --trusted-sha)  TRUSTED_SHA="${2:?}";  shift 2 ;;
    --target-root)  TARGET_ROOT="${2:?}";  shift 2 ;;
    --target-sha)   TARGET_SHA="${2:?}";   shift 2 ;;
    --file)         REL_FILE="${2:?}";     shift 2 ;;
    --digest-file)  REL_DIGEST="${2:?}";   shift 2 ;;
    # Accepted only so it can be refused by name. A digest the caller states is
    # a digest the candidate can state, and then the comparison is a mirror.
    --expected-digest|--digest|--sha256)
      die "$EXIT_HARNESS" CANDIDATE_SUPPLIED_DIGEST \
        "$1 is not accepted: the expected digest must come from a file inside the trusted checkout, never from an argument" ;;
    *) die "$EXIT_HARNESS" BAD_ARGUMENT "unknown argument: $1" ;;
  esac
done

for v in LABEL TRUSTED_ROOT TRUSTED_SHA TARGET_ROOT TARGET_SHA REL_FILE REL_DIGEST; do
  [[ -n "${!v}" ]] || die "$EXIT_HARNESS" MISSING_ARGUMENT "--${v,,} is required"
done

# --- 1. both roots resolve, and are real git worktrees ----------------------
resolve_root() {  # var-name, path, reason-prefix
  local __out="$1" p="$2" pre="$3" real
  real="$(realpath -e -- "$p" 2>/dev/null)" \
    || die "$EXIT_HARNESS" "${pre}_ROOT_MISSING" "$p does not exist"
  [[ -d "$real" ]] || die "$EXIT_HARNESS" "${pre}_ROOT_NOT_A_DIR" "$real is not a directory"
  printf -v "$__out" '%s' "$real"
}
resolve_root TRUSTED_REAL "$TRUSTED_ROOT" TRUSTED
resolve_root TARGET_REAL  "$TARGET_ROOT"  TARGET

head_of() {  # root
  git -C "$1" rev-parse HEAD 2>/dev/null || true
}
TRUSTED_HEAD="$(head_of "$TRUSTED_REAL")"
TARGET_HEAD="$(head_of "$TARGET_REAL")"
[[ "$TRUSTED_HEAD" =~ ^[0-9a-f]{40}$ ]] \
  || die "$EXIT_CONTROL" TRUSTED_NOT_A_CHECKOUT "$TRUSTED_REAL is not a git checkout"
[[ "$TARGET_HEAD" =~ ^[0-9a-f]{40}$ ]] \
  || die "$EXIT_CONTROL" TARGET_NOT_A_CHECKOUT "$TARGET_REAL is not a git checkout"

# The caller must say which commits it believes it is verifying, and be right.
# This is what makes "the trusted checkout was stale" and "the bridge checkout
# was on the wrong commit" failures rather than footnotes.
[[ "$TRUSTED_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "$EXIT_HARNESS" TRUSTED_SHA_NOT_FULL "--trusted-sha must be a full 40-hex commit sha, got: $TRUSTED_SHA"
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] \
  || die "$EXIT_HARNESS" TARGET_SHA_NOT_FULL "--target-sha must be a full 40-hex commit sha, got: $TARGET_SHA"
[[ "$TRUSTED_HEAD" == "$TRUSTED_SHA" ]] \
  || die "$EXIT_CONTROL" TRUSTED_REF_STALE \
       "the trusted checkout $TRUSTED_REAL is at $TRUSTED_HEAD, not the asserted $TRUSTED_SHA"
[[ "$TARGET_HEAD" == "$TARGET_SHA" ]] \
  || die "$EXIT_CONTROL" TARGET_SHA_MISMATCH \
       "the target checkout $TARGET_REAL is at $TARGET_HEAD, not the asserted $TARGET_SHA"

# --- 2. the two roots are physically distinct -------------------------------
[[ "$TRUSTED_REAL" != "$TARGET_REAL" ]] \
  || die "$EXIT_CONTROL" TRUSTED_ROOT_IS_TARGET \
       "the trusted and target checkouts are the same directory ($TRUSTED_REAL); a file cannot vouch for itself"
ino_of() { stat -c '%d:%i' -- "$1"; }
if [[ "$(ino_of "$TRUSTED_REAL")" == "$(ino_of "$TARGET_REAL")" ]]; then
  die "$EXIT_CONTROL" ROOTS_SHARE_INODE \
    "the trusted and target checkouts resolve to different paths but the same device:inode ($(ino_of "$TRUSTED_REAL"))"
fi

# --- 3. the expected digest, from the trusted checkout only -----------------
DIGEST_PATH="$TRUSTED_REAL/$REL_DIGEST"
DIGEST_REAL="$(realpath -m -- "$DIGEST_PATH" 2>/dev/null || true)"
[[ -n "$DIGEST_REAL" ]] \
  || die "$EXIT_HARNESS" EXPECTED_DIGEST_UNRESOLVABLE "$DIGEST_PATH could not be resolved"
case "$DIGEST_REAL" in
  "$TARGET_REAL"/*|"$TARGET_REAL")
    die "$EXIT_CONTROL" EXPECTED_SOURCE_UNTRUSTED \
      "the expected digest resolves into the TARGET checkout ($DIGEST_REAL); the policy must not come from the thing under test" ;;
esac
case "$DIGEST_REAL" in
  "$TRUSTED_REAL"/*) ;;
  *) die "$EXIT_CONTROL" EXPECTED_SOURCE_OUTSIDE_TRUSTED \
       "the expected digest resolves outside the trusted checkout ($DIGEST_REAL)" ;;
esac
[[ -f "$DIGEST_REAL" ]] \
  || die "$EXIT_CONTROL" EXPECTED_DIGEST_MISSING \
       "the trusted checkout states no expected digest for '$LABEL' (looked for $DIGEST_REAL)"

EXPECTED="$(tr -d '[:space:]' < "$DIGEST_REAL")"
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] \
  || die "$EXIT_CONTROL" EXPECTED_DIGEST_MALFORMED \
       "$DIGEST_REAL does not contain a bare sha256 (got ${#EXPECTED} chars)"

# --- 4. the reused file, from the target checkout only, no fallback ---------
FILE_PATH="$TARGET_REAL/$REL_FILE"
if [[ ! -e "$FILE_PATH" ]]; then
  die "$EXIT_CONTROL" CANONICAL_MISSING \
    "the canonical '$LABEL' is not in the target checkout ($FILE_PATH). There is no fallback: a reused file the harness supplies itself is not reuse."
fi
FILE_REAL="$(realpath -e -- "$FILE_PATH" 2>/dev/null || true)"
[[ -n "$FILE_REAL" ]] \
  || die "$EXIT_CONTROL" CANONICAL_UNRESOLVABLE "$FILE_PATH could not be resolved"
case "$FILE_REAL" in
  "$TARGET_REAL"/*) ;;
  *) die "$EXIT_CONTROL" CANONICAL_ESCAPES_TARGET \
       "$FILE_PATH resolves to $FILE_REAL, outside the target checkout — a symlink cannot substitute the reused file" ;;
esac
[[ -f "$FILE_REAL" ]] \
  || die "$EXIT_CONTROL" CANONICAL_NOT_A_FILE "$FILE_REAL is not a regular file"
if [[ "$(ino_of "$FILE_REAL")" == "$(ino_of "$DIGEST_REAL")" ]]; then
  die "$EXIT_CONTROL" FILE_AND_DIGEST_SHARE_INODE \
    "the reused file and the expected digest are the same inode; that is the self-comparison this guard exists to prevent"
fi

ACTUAL="$(sha256sum -- "$FILE_REAL" | cut -d' ' -f1)"
if [[ "$ACTUAL" != "$EXPECTED" ]]; then
  die "$EXIT_CONTROL" CANONICAL_DRIFT \
    "$LABEL has drifted: $FILE_REAL is $ACTUAL, the trusted checkout expects $EXPECTED (re-record deliberately; the harness will not silently run either version)"
fi

printf 'REUSE_OK %s %s %s\n' "$LABEL" "$FILE_REAL" "$ACTUAL"
