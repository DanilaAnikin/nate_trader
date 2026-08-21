#!/usr/bin/env bash
# ============================================================================
# run.sh — prove a frozen dashboard image never reaches the tombstoned Vault
#          wrappers, and prove the proof could have failed
#
# WHAT IS ACTUALLY BEING CLAIMED
# ------------------------------
# The containment argument for the pre-migration bridge is that its mutating
# handlers return a constant 503 and never touch `vault_create_secret`,
# `vault_update_secret` or `vault_delete_secret` — the three routines migration
# 0022 tombstones. As usually made, that argument is static: nothing imports
# the credentials helper, so nothing can call it. This harness replaces it with
# an executed one.
#
#   * two real PostgreSQL servers on the exact production image, by digest, one
#     at migrations 0001-0008 and one at 0001-0023;
#   * a CANARY installed BY THE TRUSTED RUNNER over all three wrapper
#     signatures, so any call — even one the schema would refuse before running
#     a line of the body — leaves a rollback-proof mark;
#   * the image under test driven over every mutating method enumerated from
#     the route filesystem, unauthenticated and authenticated, under every
#     combination of the three freeze environment variables, and matched
#     against a COMMITTED request manifest so the run cannot pass by driving
#     less;
#   * sixteen typed claims per request, each carrying the sensors it was
#     decided from, checked against observers that are not the application. A
#     claim whose sensor was unavailable is INDETERMINATE and fails the run; it
#     does not vanish.
#
# AND WHY THE ZEROES MEAN ANYTHING
# --------------------------------
# An absence is only evidence from a detector known to work, so the run refuses
# to report one until:
#
#   (A) `sensor/verify-sensor.sh` has compared the sensor's COMPLETE normalised
#       definitions against a digest pinned in this checkout, and has fired
#       every wrapper under an unpredictable per-run nonce — before the matrix,
#       at unpredictable points DURING it, and after it — with exactly one
#       correlated event on the raw catalogue sequence, on `nt_canary.hits()`
#       and in the postgres server log read from outside the database;
#   (B) `--mode mutant` has shown a deliberately-unfrozen build of the same
#       source reaching the canary through the same stack; and
#   (C) `--break-sensor`, and the ten sabotages in
#       `tests/k1-sensor-negative-controls.sh`, have shown that deleting,
#       muting, tombstoning, duplicating, replaying, fabricating or ignoring
#       the canary makes this suite FAIL rather than pass quietly.
#
# The marker-comment arming check that used to stand in for (A) is gone: a
# sabotage that kept the marker, kept the delegate, left `nt_canary.log_call`
# untouched and deleted the one `perform nt_canary.log_call(...)` statement
# produced a provably dead sensor that reported itself armed, and the suite
# printed PASS and exited 0.
#
# NOTHING HERE TOUCHES PRODUCTION. Every container is named `nt-canary-*`, the
# network is `--internal` (verified at run time, so a broker call cannot leave
# the host), no workflow is dispatched, and the only "credentials" in the stack
# are literal strings saying they are not credentials.
#
# Usage:
#   ./run.sh --image <ref> --source <dir> [options]
#
#     --image <ref>        dashboard image under test (required)
#     --source <dir>       the source tree that image was built from, used for
#                          route enumeration (required; must not be a worktree)
#     --target-root <dir>  the BRIDGE checkout under test. The reused
#                          bootstrap/seed are read from here and nowhere else.
#                          (required)
#     --target-sha <sha>   the full commit the target checkout must be at
#                          (required)
#     --trusted-root <dir> the VERIFIER/POLICY checkout, which states the
#                          expected digests. Defaults to the checkout this
#                          script lives in, and must be physically distinct
#                          from --target-root.
#     --trusted-sha <sha>  the full commit the trusted checkout must be at
#                          (defaults to its current HEAD)
#     --schema 0008|0023|both        default: both
#     --mode frozen|mutant           default: frozen
#     --break-sensor none|drop|mute|verdict     default: none
#     --pg-image <ref>     default: the production digest
#     --migrations <dir>   default: <repo>/supabase/migrations
#     --out <dir>          default: a fresh directory under /tmp
#     --cells <n>          run only the first n of the 24 env combinations.
#                          A partial run is a distinct status (PARTIAL, exit 4)
#                          and can never be a PASS. So is `--schema 0008` or
#                          `--schema 0023`: the matrix is 24 combinations on
#                          EACH of the two generations, 48 in all.
#     --allow-dirty-target run even though --target-root has modified paths.
#                          They are recorded in target-worktree-status.txt and
#                          the run is reported NOT CERTIFYING (exit 4): the
#                          image cannot be bound to a commit whose tree it was
#                          not built from.
#     --keep               leave the stack up
#     --print-trusted-digest   print this harness's own content digest and exit;
#                          this is how expected/trusted-digest.txt is re-recorded
#                          after a deliberate edit.
#
#   --out must be EMPTY or absent. An artefact directory is the record of ONE
#   run: two runs into the same directory leave a set no verdict can distinguish
#   from a single complete one, which is how a 24-combination run was certified
#   as 48.
#
# WHAT IS BOUND TO WHAT, AND BY WHAT
# ----------------------------------
#   image        -> --target-sha   org.opencontainers.image.revision (a string
#                                  the operator typed at build time)
#   image        -> --source       org.nt.canary.source-digest, recomputed here
#   --source     -> --target-sha   compared with `git archive <sha> dashboard`
#   this harness -> its own pin    expected/trusted-digest.txt
#   each cell    -> its generation the recording gateway's fingerprint of the
#                                  running database, logged twice in two files
#                                  written by two different containers
#   each cell    -> this run       a 128-bit nonce in provenance.json
#
#   `--bootstrap` and `--seed` are deliberately NOT accepted any more: a file
#   path the caller supplies is a file path the candidate can supply, and that
#   was how the old reuse guard ended up comparing one copy with itself.
#
# Exit codes:
#   0  the expectation for this --mode / --break-sensor held, in full
#   1  a containment finding: the image under test violated a claim
#   2  the harness itself failed
#   3  a control misbehaved — nothing this run says can be trusted
#   4  PARTIAL (fewer than 24 cells, or fewer than both generations) or
#      NOT CERTIFYING (dirty target worktree, substituted --pg-image)
# ============================================================================

set -Eeuo pipefail

readonly EXIT_FINDING=1
readonly EXIT_HARNESS=2
readonly EXIT_CONTROL=3
readonly EXIT_PARTIAL=4

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO="$(cd "${HERE}/../../.." && pwd)"
readonly REUSE_GUARD="${HERE}/reuse-guard.sh"
readonly SENSOR="${HERE}/sensor/verify-sensor.sh"
readonly TOMB_BINDING="${HERE}/tombstone-binding.sh"
readonly REQUEST_MANIFEST="${HERE}/expected/request-manifest.json"
# Where the reused files live inside the TARGET checkout, and where their
# expected digests live inside the TRUSTED one. Both are relative, because the
# roots are what the caller supplies and the guard resolves.
readonly REL_BOOTSTRAP="dashboard/test/schema-compat/sql/00_env_bootstrap.sql"
readonly REL_SEED="dashboard/test/schema-compat/sql/10_seed.sql"
readonly REL_BOOTSTRAP_DIGEST=".github/containment/runtime-canary/expected/00_env_bootstrap.sha256"
readonly REL_SEED_DIGEST=".github/containment/runtime-canary/expected/10_seed.sha256"

# The exact production image, addressed by digest. A tag can be re-pointed;
# this cannot.
readonly PG_IMAGE_DEFAULT="supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00"
readonly NODE_IMAGE="node:22-alpine"

# The trusted verifier's own digest: every executable and every expectation in
# this directory, in one number. Defined here because `--print-trusted-digest`
# has to work before any other argument is validated — that is how the pin in
# expected/trusted-digest.txt gets re-recorded after a deliberate edit.
#
# TWO THINGS THIS GOT WRONG, both found by re-reading the sentence above against
# what the code actually hashed:
#
#  1. "every expectation" was FALSE. The glob covered .sh/.mjs/.cjs/.sql/.json
#     and the two .sha256 files, and every expectation kept as a .txt was
#     outside it — `expected/tombstone-state.0008.txt`,
#     `expected/tombstone-state.0023.txt`, `sensor/expected/sensor-objects.*.txt`
#     and `sql/expected-baseline.*.txt`, six files a verdict is compared against.
#     Editing any of them changed what the harness would accept while the run
#     still printed "verifier digest : matches expected/trusted-digest.txt".
#     A guard whose stated coverage is wider than its real coverage is worse
#     than no guard, because the banner is believed. `.txt` is now IN, with the
#     pin file itself excluded BY PATH — it cannot hash itself.
#
#  2. It hashed ABSOLUTE paths. `sha256sum "$HERE/$f"` prints the path beside
#     the hash, so the digest changed when the tree moved, and two byte-identical
#     checkouts in different directories disagreed. The relative path is what
#     carries meaning; it is now what is hashed, and the digest is genuinely
#     content-addressed.
#
# STILL OUTSIDE IT, deliberately: `*.md`. Documentation does not change what the
# harness accepts, and pinning it would mean re-recording the pin for a typo fix
# — which trains exactly the reflex ("just re-record it") this pin exists to
# discourage. The scope is therefore "every file this harness READS to decide an
# outcome", not "every file in the directory".
compute_trusted_digest() {
  find "$HERE" -type f \
    \( -name '*.sh' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.sql' \
       -o -name '*.json' -o -name '*.sha256*' -o -name '*.txt' \) \
    ! -path "${HERE}/expected/trusted-digest.txt" \
    -printf '%P\n' | LC_ALL=C sort \
    | while IFS= read -r f; do
        printf '%s  %s\n' "$(sha256sum < "${HERE}/${f}" | cut -d' ' -f1)" "$f"
      done | sha256sum | cut -d' ' -f1
}

IMAGE=""
SOURCE=""
TARGET_ROOT=""
TARGET_SHA=""
TRUSTED_ROOT="$REPO"
TRUSTED_SHA=""
SCHEMA="both"
MODE="frozen"
BREAK_SENSOR="none"
PG_IMAGE="$PG_IMAGE_DEFAULT"
MIGRATIONS="${REPO}/supabase/migrations"
OUT=""
CELL_LIMIT=0
KEEP=0
ALLOW_DIRTY_TARGET=0
TARGET_DIRTY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image)         IMAGE="${2:?}";        shift 2 ;;
    --source)        SOURCE="${2:?}";       shift 2 ;;
    --target-root)   TARGET_ROOT="${2:?}";  shift 2 ;;
    --target-sha)    TARGET_SHA="${2:?}";   shift 2 ;;
    --trusted-root)  TRUSTED_ROOT="${2:?}"; shift 2 ;;
    --trusted-sha)   TRUSTED_SHA="${2:?}";  shift 2 ;;
    --schema)        SCHEMA="${2:?}";       shift 2 ;;
    --mode)          MODE="${2:?}";         shift 2 ;;
    --break-sensor)  BREAK_SENSOR="${2:?}"; shift 2 ;;
    --pg-image)      PG_IMAGE="${2:?}";     shift 2 ;;
    --migrations)    MIGRATIONS="${2:?}";   shift 2 ;;
    --out)           OUT="${2:?}";          shift 2 ;;
    --cells)         CELL_LIMIT="${2:?}";   shift 2 ;;
    --keep)          KEEP=1;                shift ;;
    --print-trusted-digest) compute_trusted_digest; exit 0 ;;
    --allow-dirty-target) ALLOW_DIRTY_TARGET=1; shift ;;
    --bootstrap|--seed)
      printf 'run.sh: %s is no longer accepted. The reused SQL is read from --target-root and checked against a digest in --trusted-root; a caller-supplied path would reintroduce the self-comparison this guard exists to prevent.\n' "$1" >&2
      exit "$EXIT_HARNESS" ;;
    -h|--help)       sed -n '2,80p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'run.sh: unknown argument: %s\n' "$1" >&2; exit "$EXIT_HARNESS" ;;
  esac
done

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m ok \033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
# THE VERIFIER CHECKS ITSELF BEFORE IT CHECKS ANYTHING ELSE.
#
# It used to be PRINTED and nothing else — audit finding B8(i), "nothing refuses
# an edited verifier". It is now compared with a pin, and a mismatch is exit 3.
# The pin lives in expected/trusted-digest.txt (excluded from the digest by
# path, so it cannot chase its own tail); re-record it with
# `run.sh --print-trusted-digest > expected/trusted-digest.txt` DELIBERATELY,
# as a separate act from the edit.
#
# It runs HERE, immediately after argument parsing, rather than two hundred
# lines down after the reuse guard: an edited verifier should be refused before
# a single container starts, and a check that can only be reached by standing
# up a bridge checkout and a docker daemon is a check nothing will ever test.
# tests/k12-verifier-digest.test.sh reaches it in milliseconds because of this.
#
# WHAT THIS IS NOT: an independent attestation. The pin sits in the same working
# tree as the files it pins, because this directory is not committed. It catches
# an accidental or concurrent edit, and a run that used a different verifier
# from the one being reported. It does not stop someone who edits both.
# ---------------------------------------------------------------------------
TRUSTED_DIGEST="$(compute_trusted_digest)"
TRUSTED_DIGEST_PIN_FILE="${HERE}/expected/trusted-digest.txt"
if [[ ! -f "$TRUSTED_DIGEST_PIN_FILE" ]]; then
  fail "this checkout records no expected verifier digest (${TRUSTED_DIGEST_PIN_FILE})"
  fail "  record it deliberately:  ./run.sh --print-trusted-digest > expected/trusted-digest.txt"
  exit "$EXIT_CONTROL"
fi
TRUSTED_DIGEST_PIN="$(tr -d '[:space:]' < "$TRUSTED_DIGEST_PIN_FILE")"
if [[ "$TRUSTED_DIGEST" != "$TRUSTED_DIGEST_PIN" ]]; then
  fail "the harness in this checkout is NOT the one expected/trusted-digest.txt pins:"
  fail "  computed: $TRUSTED_DIGEST"
  fail "  pinned  : $TRUSTED_DIGEST_PIN"
  fail "  Something under ${HERE} changed. If the change was intended, re-record the pin"
  fail "  with ./run.sh --print-trusted-digest and say so in the report; do not do it to"
  fail "  make a run go green."
  exit "$EXIT_CONTROL"
fi

RUN_ID="$(date +%s)-$$"
NET="nt-canary-net-${RUN_ID}"
SINK_C="nt-canary-sink-${RUN_ID}"
APP_C="nt-canary-app-${RUN_ID}"
PG_C=""     # set per schema

cleanup() {
  local rc=$?
  if [[ "$KEEP" -eq 1 ]]; then
    printf '\n--keep: stack left up. network=%s out=%s\n' "$NET" "$OUT"
  else
    docker rm -f "$APP_C" "$SINK_C" >/dev/null 2>&1 || true
    for s in 0008 0023; do docker rm -f "nt-canary-pg-${s}-${RUN_ID}" >/dev/null 2>&1 || true; done
    docker network rm "$NET" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 0. preflight
# ---------------------------------------------------------------------------
log "0. preflight"

for v in IMAGE SOURCE TARGET_ROOT TARGET_SHA; do
  if [[ -z "${!v}" ]]; then fail "--${v//_/-} is required" ; exit "$EXIT_HARNESS"; fi
done
TRUSTED_SHA="${TRUSTED_SHA:-$(git -C "$TRUSTED_ROOT" rev-parse HEAD 2>/dev/null || true)}"
if [[ -z "$TRUSTED_SHA" ]]; then
  fail "--trusted-root ($TRUSTED_ROOT) is not a git checkout and no --trusted-sha was given"
  exit "$EXIT_HARNESS"
fi
case "$SCHEMA" in 0008|0023|both) ;; *) fail "--schema must be 0008, 0023 or both"; exit "$EXIT_HARNESS" ;; esac
case "$MODE" in frozen|mutant) ;; *) fail "--mode must be frozen or mutant"; exit "$EXIT_HARNESS" ;; esac
case "$BREAK_SENSOR" in none|drop|mute|verdict) ;; *) fail "--break-sensor must be none, drop, mute or verdict"; exit "$EXIT_HARNESS" ;; esac

for c in docker node; do
  command -v "$c" >/dev/null 2>&1 || { fail "$c is not on PATH"; exit "$EXIT_HARNESS"; }
done

if [[ -e "$SOURCE/.git" ]]; then
  fail "--source points at a git worktree ($SOURCE); give it a scratch copy"
  exit "$EXIT_HARNESS"
fi
[[ -d "$SOURCE/app/api" ]] || { fail "$SOURCE/app/api is missing"; exit "$EXIT_HARNESS"; }
[[ -d "$MIGRATIONS"     ]] || { fail "$MIGRATIONS is missing";     exit "$EXIT_HARNESS"; }

if ! app_image_id="$(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null)"; then
  fail "the image under test is not present locally: $IMAGE"
  exit "$EXIT_HARNESS"
fi

# --- the image must be the TARGET COMMIT's image ---------------------------
# The whole report is a statement about one commit's artifact, and until now the
# only thing tying the two together was the operator's memory. `--image` took a
# tag; `--target-sha` took a hex string; nothing compared them. A stale
# `nt-canary/dashboard:current` from an earlier commit produced a report headed
# with the new sha, and the audit found exactly that on this machine: the image
# on disk was built from 38bf4a11 while the target worktree had moved on.
#
# build-image.sh stamps `org.opencontainers.image.revision`, so the binding is
# available and was simply never read.
if ! app_image_rev="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE" 2>/dev/null)"; then
  fail "could not read the labels of the image under test ($IMAGE)"
  exit "$EXIT_HARNESS"
fi
case "$MODE" in
  frozen) want_rev="$TARGET_SHA" ;;
  # The mutant is deliberately NOT the target's source, so it carries the target
  # sha plus an explicit marker. Accepting a bare target sha here would let the
  # frozen image be run as the mutant and "prove" the sensor is live.
  mutant) want_rev="${TARGET_SHA}+mutant" ;;
esac
if [[ -z "$app_image_rev" || "$app_image_rev" == "<no value>" ]]; then
  fail "the image under test carries no org.opencontainers.image.revision label"
  fail "  build it with build-image.sh --sha '${want_rev}'; an unlabelled image cannot be bound to a commit"
  exit "$EXIT_CONTROL"
fi
if [[ "$app_image_rev" != "$want_rev" ]]; then
  fail "the image under test was built from a different source than this run claims"
  fail "  image label : $app_image_rev"
  fail "  --mode $MODE requires : $want_rev"
  exit "$EXIT_CONTROL"
fi
ok "image bound to the target commit by label (${MODE}: ${app_image_rev})"

# --- and the target checkout must BE that commit, cleanly ------------------
# A dirty worktree means the sha names a tree the image was not built from. It
# does not have to stop the run, but it must stop the CERTIFICATION, and it must
# be recorded rather than remembered.
if ! target_head="$(git -C "$TARGET_ROOT" rev-parse HEAD 2>/dev/null)"; then
  fail "--target-root ($TARGET_ROOT) is not a git checkout"
  exit "$EXIT_HARNESS"
fi
if [[ "$target_head" != "$TARGET_SHA" ]]; then
  fail "--target-root is at $target_head, not the asserted --target-sha $TARGET_SHA"
  exit "$EXIT_CONTROL"
fi
TARGET_DIRTY_FILE="$(mktemp /tmp/nt-canary-target-dirty-XXXXXX)"
if ! git -C "$TARGET_ROOT" status --porcelain > "$TARGET_DIRTY_FILE" 2>/dev/null; then
  fail "could not read the target checkout's working-tree status"
  exit "$EXIT_HARNESS"
fi
# `grep -c` exits 1 when the count is zero, which is a RESULT here, not an
# error — so the status is interpreted rather than discarded with `|| true`,
# which would also swallow grep's exit 2 (unreadable file) and report a clean
# tree for a tree it could not read.
set +e
TARGET_DIRTY="$(grep -c . "$TARGET_DIRTY_FILE")"
dirty_rc=$?
set -e
case "$dirty_rc" in
  0) ;;
  1) TARGET_DIRTY=0 ;;
  *) fail "could not count the target checkout's modified paths (grep rc=$dirty_rc)"; exit "$EXIT_HARNESS" ;;
esac
if [[ "$TARGET_DIRTY" -gt 0 ]]; then
  if [[ "$ALLOW_DIRTY_TARGET" -eq 0 ]]; then
    fail "the target checkout has ${TARGET_DIRTY} modified path(s); it is not the commit it claims to be:"
    sed 's/^/       /' "$TARGET_DIRTY_FILE" >&2
    fail "  commit or stash them, or pass --allow-dirty-target to run anyway (the run then cannot certify)"
    exit "$EXIT_CONTROL"
  fi
  printf '\033[1;33m   NOT CERTIFYING\033[0m --allow-dirty-target: %s modified path(s) in %s\n' \
    "$TARGET_DIRTY" "$TARGET_ROOT"
  sed 's/^/       /' "$TARGET_DIRTY_FILE"
else
  ok "the target checkout is clean at $TARGET_SHA"
fi
if ! pg_image_id="$(docker image inspect --format '{{.Id}}' "$PG_IMAGE" 2>/dev/null)"; then
  info "pulling $PG_IMAGE (by digest)"
  docker pull "$PG_IMAGE" >/dev/null || { fail "could not pull $PG_IMAGE"; exit "$EXIT_HARNESS"; }
  pg_image_id="$(docker image inspect --format '{{.Id}}' "$PG_IMAGE")"
fi
docker image inspect --format '{{.Id}}' "$NODE_IMAGE" >/dev/null 2>&1 || docker pull "$NODE_IMAGE" >/dev/null

# --- the artefact directory must belong to THIS run ------------------------
# Audit finding B3: nothing stopped
#     run.sh --schema 0023 --out D   ...   run.sh --schema 0008 --out D
# from leaving D holding a complete 48-file set produced by two different runs,
# with two different images, which a later `verdict.mjs --schemas 0008,0023
# --out D` would certify. A verdict is over one run, so the directory has to be
# one run's.
if [[ -n "$OUT" && -e "$OUT" ]]; then
  if [[ ! -d "$OUT" ]]; then
    fail "--out ($OUT) exists and is not a directory"; exit "$EXIT_HARNESS"
  fi
  if [[ -n "$(find "$OUT" -mindepth 1 -print -quit)" ]]; then
    fail "--out ($OUT) is not empty. An artefact directory is the record of ONE run:"
    fail "  a second run into the same directory leaves a set that no verdict can tell"
    fail "  apart from a single complete one. Give a fresh directory."
    exit "$EXIT_HARNESS"
  fi
fi
OUT="${OUT:-$(mktemp -d /tmp/nt-canary-out-XXXXXX)}"
mkdir -p "$OUT/cells" "$OUT/sql" "$OUT/instr"
# 128 bits drawn once per run, stamped into every cell result by the driver and
# into provenance.json here, so cells from two runs cannot be pooled.
RUN_NONCE="$(od -An -N16 -tx1 < /dev/urandom | tr -d ' \n')"
if [[ ! "$RUN_NONCE" =~ ^[0-9a-f]{32}$ ]]; then
  fail "could not draw a 128-bit run nonce from /dev/urandom (got '${RUN_NONCE}')"; exit "$EXIT_HARNESS"
fi
# The working-tree status is part of the report, not a preflight side effect.
cp "$TARGET_DIRTY_FILE" "$OUT/target-worktree-status.txt"
rm -f "$TARGET_DIRTY_FILE"
# The image under test runs as uid 1001; it has to be able to append its
# instrument log to a bind mount owned by the host user.
chmod 0777 "$OUT" "$OUT/instr" "$OUT/cells"

info "image under test : $IMAGE ($app_image_id)"
info "source tree      : $SOURCE"
info "postgres image   : $PG_IMAGE"
info "postgres id      : $pg_image_id"
info "migrations       : $MIGRATIONS"
info "mode             : $MODE   break-sensor: $BREAK_SENSOR   schema: $SCHEMA"
info "output           : $OUT"

# --- the reused bootstrap and seed, from TWO DISTINCT CHECKOUTS ------------
# The harness reuses `dashboard/test/schema-compat/sql/00_env_bootstrap.sql`
# rather than reinventing what storage-api creates. That file lives on the
# bridge branch.
#
# The previous resolver fell back to a vendored copy when the canonical path
# was absent and then sha256-compared "chosen" against "vendored" — which, on
# `main`, where the canonical path does not exist, compared one file WITH
# ITSELF. Every run printed "(reused, drift-checked)" having checked nothing,
# and tampering with the vendored copy so it no longer matched the bridge's
# real file still passed.
#
# So the file now comes from the TARGET checkout and the expected digest comes
# from the TRUSTED one, they must be physically distinct roots at the exact
# commits the caller asserted, and there is NO fallback: a missing canonical
# file is a hard failure. See reuse-guard.sh for the full list of refusals.
reuse() {  # label, target-relative file, trusted-relative digest -> path
  local out
  if ! out="$("$REUSE_GUARD" --label "$1" \
        --trusted-root "$TRUSTED_ROOT" --trusted-sha "$TRUSTED_SHA" \
        --target-root  "$TARGET_ROOT"  --target-sha  "$TARGET_SHA" \
        --file "$2" --digest-file "$3" 2>&1)"; then
    fail "the reused '$1' could not be established:"
    printf '%s\n' "$out" | sed 's/^/       /' >&2
    exit "$EXIT_CONTROL"
  fi
  printf '%s' "$(awk '{print $3}' <<< "$out")"
}
BOOTSTRAP_FILE="$(reuse bootstrap "$REL_BOOTSTRAP" "$REL_BOOTSTRAP_DIGEST")"
SEED_FILE="$(reuse seed           "$REL_SEED"      "$REL_SEED_DIGEST")"

# TRUSTED_DIGEST was computed and enforced immediately after argument parsing,
# before any container started. It is recorded in the report from there; the
# commit alone does not cover these harness files, which are untracked while
# they are being developed.

# The tombstone classification is delegated to `.github/containment/
# catalogue-classify.sql`, which lives OUTSIDE this directory and has its own
# development going on. It is therefore not covered by the digest above, and a
# run that used one version of it is not reproducible against another. Its
# digest is recorded at the start and re-checked at the end, because a file
# edited by a concurrent session halfway through a 25-minute run would
# otherwise leave two different classifiers behind one report.
# It is the whole external toolchain, not one file: `tombstone-binding.sh` also
# runs `extract-tombstone-template.py` and applies the classifier's fixture SQL.
# Digesting only catalogue-classify.sql was itself too narrow — a concurrent
# session changed the extractor's interface from "one migration file" to "the
# migration directory" mid-development, and the only symptom was a run that died
# four minutes in.
CLASSIFIER_ROOT="${REPO}/.github/containment"
# The digest is over (relative name, content) pairs and NOTHING else. It has to
# be, because it is used to compare two roots -- the live checkout and the
# snapshot taken from it -- and any absolute path in the hashed stream makes
# those two roots differ by construction. `sha256sum FILE` prints the path it
# was given, so the earlier form ("sha256sum ${CLASSIFIER_ROOT}/x") could never
# report a faithful snapshot: byte-identical trees digested differently and the
# comparison below failed unconditionally, which is precisely what happened.
# Content is read on stdin (`sha256sum < FILE`, which prints only the hash and
# `-`) and the relative name is printed beside it explicitly.
compute_classifier_digest() {  # root -> digest over (relative name, content)
  local root="$1" f
  {
    for f in catalogue-classify.sql catalogue-classify.sh extract-tombstone-template.py; do
      if [[ -f "${root}/$f" ]]; then
        printf '%s  %s\n' "$(sha256sum < "${root}/$f" | cut -d' ' -f1)" "$f"
      else
        printf 'absent  %s\n' "$f"
      fi
    done
    find "${root}/sql" -maxdepth 1 -type f -name '*.sql' -printf '%P\n' 2>/dev/null \
      | LC_ALL=C sort | while IFS= read -r f; do
          printf '%s  sql/%s\n' "$(sha256sum < "${root}/sql/$f" | cut -d' ' -f1)" "$f"
        done
  } | sha256sum | cut -d' ' -f1
}
# SELF-TEST, before the digest decides anything. Both directions have now failed
# in this file: the first version could never report two identical trees as
# identical (it hashed the absolute path, so run.sh exited 3 on every single
# invocation and the harness could not be run at all), and a "fix" that dropped
# the name would report a renamed or missing file as identical. So the function
# is required, here, to say EQUAL to a faithful copy and DIFFERENT to each of
# the two ways a copy can be unfaithful.
classifier_digest_selftest() {
  local a b rc=0
  a="$(mktemp -d /tmp/nt-canary-cdst-a-XXXXXX)"
  b="$(mktemp -d /tmp/nt-canary-cdst-b-XXXXXX)"
  mkdir -p "$a/sql" "$b/sql"
  printf 'classifier\n'  > "$a/catalogue-classify.sql"
  printf 'runner\n'      > "$a/catalogue-classify.sh"
  printf 'extractor\n'   > "$a/extract-tombstone-template.py"
  printf 'fixture\n'     > "$a/sql/10_seed.sql"
  printf 'second\n'      > "$a/sql/20_more.sql"
  cp -a "$a/." "$b/"
  # (1) a faithful copy must compare EQUAL -- the property the original defect broke
  if [[ "$(compute_classifier_digest "$a")" != "$(compute_classifier_digest "$b")" ]]; then
    fail "the classifier digest reports a byte-identical copy as different; the snapshot check cannot pass"
    rc=1
  fi
  # (2) one changed byte must compare DIFFERENT
  printf 'classifier!\n' > "$b/catalogue-classify.sql"
  if [[ "$(compute_classifier_digest "$a")" == "$(compute_classifier_digest "$b")" ]]; then
    fail "the classifier digest cannot see a changed byte; the snapshot check would be vacuous"
    rc=1
  fi
  # (3) a missing file must compare DIFFERENT, including one in sql/
  cp -a "$a/catalogue-classify.sql" "$b/catalogue-classify.sql"
  rm -f "$b/sql/20_more.sql"
  if [[ "$(compute_classifier_digest "$a")" == "$(compute_classifier_digest "$b")" ]]; then
    fail "the classifier digest cannot see a file missing from sql/; the snapshot check would be vacuous"
    rc=1
  fi
  # (4) a RENAMED file -- same contents, same count -- must compare DIFFERENT.
  # This is the arm that requires the relative name to be in the hashed stream,
  # and it is here because the obvious over-correction for the original defect
  # is to hash content alone, which passes arms (1)-(3) and loses this one.
  cp -a "$a/sql/20_more.sql" "$b/sql/20_more.sql"
  mv "$b/sql/10_seed.sql" "$b/sql/11_seed.sql"
  if [[ "$(compute_classifier_digest "$a")" == "$(compute_classifier_digest "$b")" ]]; then
    fail "the classifier digest cannot see a renamed file in sql/; it is hashing content without names"
    rc=1
  fi
  rm -rf "$a" "$b"
  return "$rc"
}
if ! classifier_digest_selftest; then exit "$EXIT_HARNESS"; fi
CLASSIFIER_DIGEST="$(compute_classifier_digest "$CLASSIFIER_ROOT")"

# ...and it is SNAPSHOTTED, not merely digested. Digesting the live files at the
# start and the end of the run detects drift; it does not prevent the two
# generations from being classified by two different versions, it only tells you
# so twenty-five minutes later. The run now copies the toolchain into the
# artefact directory and `tombstone-binding.sh` reads the copy, so one run uses
# one version, the bytes it used are preserved beside the result, and the
# end-of-run comparison becomes a note about the working tree rather than a
# reason to throw the run away.
CLASSIFIER_SNAPSHOT="$OUT/classifier-snapshot"
mkdir -p "$CLASSIFIER_SNAPSHOT/sql"
# Written as `if`, not `[[ -f x ]] && cp`: an AND-list whose test fails is the
# last command of the loop body, and under errexit that ends the script. The
# same footgun is recorded at the end of this file.
for f in catalogue-classify.sql catalogue-classify.sh extract-tombstone-template.py; do
  if [[ -f "${CLASSIFIER_ROOT}/$f" ]]; then cp "${CLASSIFIER_ROOT}/$f" "$CLASSIFIER_SNAPSHOT/$f"; fi
done
if [[ -d "${CLASSIFIER_ROOT}/sql" ]]; then
  find "${CLASSIFIER_ROOT}/sql" -maxdepth 1 -type f -name '*.sql' -exec cp {} "$CLASSIFIER_SNAPSHOT/sql/" \;
fi
# A snapshot with nothing in it would digest to a constant and compare equal to
# the next empty one. The two files the binding cannot work without are named.
for f in catalogue-classify.sql extract-tombstone-template.py; do
  if [[ ! -s "$CLASSIFIER_SNAPSHOT/$f" ]]; then
    fail "the classifier snapshot is missing ${f}; ${CLASSIFIER_ROOT} is not a classifier checkout"
    exit "$EXIT_HARNESS"
  fi
done
# The copy must be the thing that was digested. A snapshot taken while the file
# was being rewritten is exactly the hazard this exists to remove, so it is
# checked rather than assumed.
CLASSIFIER_SNAPSHOT_DIGEST="$(compute_classifier_digest "$CLASSIFIER_SNAPSHOT")"
if [[ "$CLASSIFIER_SNAPSHOT_DIGEST" != "$CLASSIFIER_DIGEST" ]]; then
  fail "the classifier toolchain changed while it was being snapshotted:"
  fail "  live at read : $CLASSIFIER_DIGEST"
  fail "  snapshot     : $CLASSIFIER_SNAPSHOT_DIGEST"
  fail "  a concurrent session is editing ${CLASSIFIER_ROOT}; wait for it to settle."
  exit "$EXIT_CONTROL"
fi
export NT_CANARY_CLASSIFIER_SNAPSHOT="$CLASSIFIER_SNAPSHOT"

info "trusted checkout : $TRUSTED_ROOT @ $TRUSTED_SHA"
info "target  checkout : $TARGET_ROOT @ $TARGET_SHA"
info "trusted digest   : $TRUSTED_DIGEST"
info "bootstrap        : $BOOTSTRAP_FILE ($(sha256sum "$BOOTSTRAP_FILE" | cut -c1-16))"
info "seed             : $SEED_FILE ($(sha256sum "$SEED_FILE" | cut -c1-16))"
info "verifier digest  : matches expected/trusted-digest.txt"

# --- the image, the source tree, and the commit, bound to EACH OTHER -------
# Audit finding B7. `--target-sha` was compared with a LABEL, and the label is
# whatever string the operator typed at `build-image.sh --sha`. `--source` — the
# tree `driver/enumerate-routes.mjs` reads to decide which endpoints exist, and
# therefore what the matrix drives — was bound to nothing at all. An image built
# from a tree more frozen than the target commit, tagged with the target sha,
# would have certified the target commit.
#
# Two comparisons close the triangle:
#   image  <-> --source        a digest of the build context, stamped by
#                              build-image.sh as org.nt.canary.source-digest;
#   --source <-> --target-sha  --source against `git archive <sha> dashboard`.
# shellcheck source=lib-source-digest.sh
. "${HERE}/lib-source-digest.sh"
if ! SOURCE_DIGEST="$(nt_source_digest "$SOURCE")"; then
  fail "could not digest the source tree $SOURCE"; exit "$EXIT_HARNESS"
fi
SOURCE_FILES="$(nt_source_file_count "$SOURCE")"
if ! img_src_digest="$(docker image inspect --format '{{index .Config.Labels "org.nt.canary.source-digest"}}' "$IMAGE" 2>/dev/null)"; then
  fail "could not read the source-digest label of $IMAGE"; exit "$EXIT_HARNESS"
fi
if [[ -z "$img_src_digest" || "$img_src_digest" == "<no value>" ]]; then
  fail "the image under test carries no org.nt.canary.source-digest label"
  fail "  rebuild it with build-image.sh; an image whose CONTENT is bound to nothing cannot"
  fail "  certify a source tree, and the revision label is only a string someone typed."
  exit "$EXIT_CONTROL"
fi
if [[ "$img_src_digest" != "$SOURCE_DIGEST" ]]; then
  fail "the image under test was NOT built from --source:"
  fail "  image label : $img_src_digest"
  fail "  --source    : $SOURCE_DIGEST  (${SOURCE_FILES} files, ${SOURCE})"
  fail "  The route surface this run drives is enumerated from --source. If the image is a"
  fail "  different tree, the matrix is a statement about the wrong artifact."
  exit "$EXIT_CONTROL"
fi
COMMIT_TREE_DIR="$(mktemp -d /tmp/nt-canary-committree-XXXXXX)"
if ! git -C "$TARGET_ROOT" archive --format=tar "$TARGET_SHA" dashboard 2>/dev/null | tar -x -C "$COMMIT_TREE_DIR"; then
  fail "could not extract dashboard/ from $TARGET_SHA in $TARGET_ROOT"
  rm -rf "$COMMIT_TREE_DIR"; exit "$EXIT_HARNESS"
fi
if ! COMMIT_TREE_DIGEST="$(nt_source_digest "$COMMIT_TREE_DIR/dashboard")"; then
  fail "the commit's dashboard/ tree could not be digested"
  rm -rf "$COMMIT_TREE_DIR"; exit "$EXIT_HARNESS"
fi
MUTATED_PATHS_FILE="$OUT/source-vs-commit.txt"
set +e
diff -rq --exclude=node_modules --exclude=.next --exclude=.git \
  "$COMMIT_TREE_DIR/dashboard" "$SOURCE" > "$MUTATED_PATHS_FILE" 2>&1
set -e
rm -rf "$COMMIT_TREE_DIR"
# `grep -c` exits 1 for a zero count, which is a RESULT; `|| true` here would
# also swallow exit 2 (unreadable file) and report "no differences" for a file
# it could not read. Same reasoning as the target-worktree count above.
set +e
MUTATED_COUNT="$(grep -c . "$MUTATED_PATHS_FILE")"
mut_rc=$?
set -e
case "$mut_rc" in
  0) ;;
  1) MUTATED_COUNT=0 ;;
  *) fail "could not read $MUTATED_PATHS_FILE (grep rc=$mut_rc)"; exit "$EXIT_HARNESS" ;;
esac
case "$MODE" in
  frozen)
    if [[ "$SOURCE_DIGEST" != "$COMMIT_TREE_DIGEST" ]]; then
      fail "--source is NOT the dashboard/ tree at $TARGET_SHA (${MUTATED_COUNT} differing path(s)):"
      sed 's/^/       /' "$MUTATED_PATHS_FILE" | head -20 >&2
      fail "  a frozen run certifies a commit; it cannot do that from a tree the commit does not contain"
      exit "$EXIT_CONTROL"
    fi
    ok "image, --source and $TARGET_SHA agree (${SOURCE_FILES} files, ${SOURCE_DIGEST:0:16})"
    ;;
  mutant)
    # The inverse assertion, so the check cannot be vacuous: the mutant must
    # differ from the commit, and by something.
    if [[ "$SOURCE_DIGEST" == "$COMMIT_TREE_DIGEST" ]]; then
      fail "--mode mutant but --source is byte-identical to the dashboard/ tree at $TARGET_SHA"
      fail "  there is no mutant here; property (B) would be a statement about the frozen image"
      exit "$EXIT_CONTROL"
    fi
    info "mutant source differs from $TARGET_SHA in ${MUTATED_COUNT} path(s) (see source-vs-commit.txt)"
    sed 's/^/       /' "$MUTATED_PATHS_FILE" | head -10
    ;;
esac

# --- control: the tamper-control role list must BE the reachable set -------
# Audit finding B8(ii): `sensor/sql/52_tamper_control.sql` hand-pins four roles
# and `sink/sink.mjs` hand-pins three, and the two lists were never compared —
# the exact shape (a hand-maintained list standing in for a derived one) that
# C5 was fixed for. Outside the list the sensor is defeatable.
if ! role_scope="$("${HERE}/sensor/role-scope.sh" --check 2>&1)"; then
  fail "the tamper control's role list is not the set the gateway can reach:"
  printf '%s\n' "$role_scope" | sed 's/^/       /' >&2
  exit "$EXIT_CONTROL"
fi
info "tamper role scope: $(printf '%s' "$role_scope" | tr '\n' ' ')"

# --- the throwaway identity material ---------------------------------------
eval "$(node "${HERE}/driver/keys.mjs" --print-shell | sed 's/^/export /')"
COOKIE_VALUE="$(node -e 'import("'"${HERE}"'/driver/keys.mjs").then(m=>process.stdout.write(m.sessionCookieValue()))')"
[[ -n "$COOKIE_VALUE" ]] || { fail "could not mint the probe session cookie"; exit "$EXIT_HARNESS"; }

# ---------------------------------------------------------------------------
# 1. the route surface, from the filesystem
# ---------------------------------------------------------------------------
log "1. enumerating every mutating method from the route filesystem"

if ! node "${HERE}/driver/enumerate-routes.mjs" --source "$SOURCE" \
      --account-id "$CANARY_PROBE_ACCOUNT_ID" --inject-selftest \
      --out "$OUT/routes.json" > /dev/null; then
  fail "route enumeration failed or was degenerate"
  exit "$EXIT_CONTROL"
fi
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`   route files: ${r.routeFiles}`);
for (const rt of r.routes) console.log(`     ${rt.url.padEnd(58)} ${JSON.stringify(rt.methods)}`);
console.log(`   mutating methods driven: ${r.mutatingCount}`);
for (const m of r.mutating) console.log(`     ${m.method.padEnd(7)} ${m.url}   [${m.file}]`);
' "$OUT/routes.json"

# ---------------------------------------------------------------------------
# 2. the 24 environment combinations
# ---------------------------------------------------------------------------
log "2. building the freeze-flag matrix"

node -e '
const fs = require("fs");
const routes = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const out = process.argv[2];
const account = process.argv[3];
const M = ["on", "off", "", "__absent__"];
const S = ["on", "off", "__absent__"];
const B = ["__empty__", "__probe__"];
const label = (v) => v === "__absent__" ? "absent" : v === "" ? "empty" : v === "__empty__" ? "empty" : v === "__probe__" ? "probe" : v;
const cells = [];
for (const m of M) for (const s of S) for (const b of B) {
  const id = `m-${label(m)}__s-${label(s)}__b-${label(b)}`;
  const requests = [];
  let i = 0;
  for (const mu of routes.mutating) {
    for (const authed of [false, true]) {
      requests.push({
        id: `${++i}`,
        method: mu.method,
        url: mu.url,
        // The template keeps the dynamic segment, so a per-endpoint payload can
        // be chosen without pattern-matching a uuid back out of the path.
        template: mu.url.replace(account, ":id"),
        file: mu.file,
        authenticated: authed,
      });
    }
  }
  cells.push({ id, env: { DASHBOARD_MAINTENANCE_MODE: m, DASHBOARD_SIDECAR_ONLY: s, DASHBOARD_FREEZE_BYPASS_USERS: b }, requests });
}
fs.writeFileSync(out, JSON.stringify({ cells }, null, 2));
console.log(`   ${cells.length} environment combinations x ${cells[0].requests.length} requests = ${cells.length * cells[0].requests.length} per schema`);
' "$OUT/routes.json" "$OUT/matrix.json" "$CANARY_PROBE_ACCOUNT_ID"

# --- the generated matrix must match the COMMITTED request manifest --------
# The matrix is generated from the route filesystem, which is what keeps it
# honest when a handler is added. The manifest is what keeps the GENERATION
# honest: a run that quietly produced fewer cells, fewer requests per cell, or
# a different endpoint set would otherwise still render a verdict over
# whatever it happened to drive.
[[ -f "$REQUEST_MANIFEST" ]] || { fail "no committed request manifest at $REQUEST_MANIFEST"; exit "$EXIT_HARNESS"; }
if ! node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const w = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const account = process.argv[3];
const problems = [];
if (m.cells.length !== w.cells) problems.push(`generated ${m.cells.length} cells, the manifest requires ${w.cells}`);
// The cell IDENTITIES, and the environment each identity means. The manifest
// used to pin only how many cells there were, which is what let twenty-four
// copies of one combination be certified as twenty-four combinations.
{
  const got = m.cells.map((c) => c.id);
  const want = [...w.cellIds];
  if (new Set(got).size !== got.length) problems.push("the generated matrix repeats a cell id");
  const missing = want.filter((id) => !got.includes(id));
  const extra = got.filter((id) => !want.includes(id));
  if (missing.length) problems.push(`the generator produced no cell for: ${missing.join(", ")}`);
  if (extra.length) problems.push(`the generator produced cells the manifest does not pin: ${extra.join(", ")}`);
  const PROBE = process.argv[4];
  for (const c of m.cells) {
    const pin = w.cellEnv[c.id];
    if (!pin) continue;
    // The sentinel encoding used by the plan, mapped to the raw value the
    // container will actually see, so the manifest pins one thing and not two.
    const raw = {
      DASHBOARD_MAINTENANCE_MODE: c.env.DASHBOARD_MAINTENANCE_MODE === "__absent__" ? null : c.env.DASHBOARD_MAINTENANCE_MODE,
      DASHBOARD_SIDECAR_ONLY: c.env.DASHBOARD_SIDECAR_ONLY === "__absent__" ? null : c.env.DASHBOARD_SIDECAR_ONLY,
      DASHBOARD_FREEZE_BYPASS_USERS: c.env.DASHBOARD_FREEZE_BYPASS_USERS === "__empty__" ? "" : PROBE,
    };
    for (const k of Object.keys(pin)) {
      const wantVal = pin[k] === "__PROBE_USER_ID__" ? PROBE : pin[k];
      if (raw[k] !== wantVal) {
        problems.push(`cell ${c.id}: ${k} would be ${JSON.stringify(raw[k])}, the manifest pins ${JSON.stringify(wantVal)}`);
      }
    }
  }
}
for (const c of m.cells) {
  if (c.requests.length !== w.requestsPerCell) {
    problems.push(`cell ${c.id}: ${c.requests.length} requests, the manifest requires ${w.requestsPerCell}`);
    continue;
  }
  const got = c.requests.map((r) => `${r.method} ${r.template} auth=${r.authenticated}`).sort();
  const want = [...w.endpoints].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    problems.push(`cell ${c.id}: endpoint set differs from the manifest\n    generated: ${got.join("; ")}\n    committed: ${want.join("; ")}`);
    break;
  }
}
const total = m.cells.reduce((a, c) => a + c.requests.length, 0);
if (total !== w.totalRequests) problems.push(`generated ${total} requests, the manifest requires ${w.totalRequests}`);
if (problems.length) { for (const p of problems) console.error("   " + p); process.exit(1); }
console.log(`   matrix matches the committed manifest: ${w.cells} cells x ${w.requestsPerCell} requests = ${w.totalRequests}`);
console.log(`   all ${w.cellIds.length} committed cell IDENTITIES are present, each with the environment the manifest pins for it`);
' "$OUT/matrix.json" "$REQUEST_MANIFEST" "$CANARY_PROBE_ACCOUNT_ID" "$CANARY_PROBE_USER_ID"; then
  fail "the generated matrix does not match the committed request manifest"
  fail "  re-record ${REQUEST_MANIFEST} deliberately if the route surface really changed"
  exit "$EXIT_CONTROL"
fi

mapfile -t CELL_IDS < <(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const c of m.cells) console.log(c.id);' "$OUT/matrix.json")
CELL_TOTAL="${#CELL_IDS[@]}"
if [[ "$CELL_LIMIT" -gt 0 ]]; then
  CELL_IDS=("${CELL_IDS[@]:0:$CELL_LIMIT}")
  info "--cells $CELL_LIMIT: running only ${#CELL_IDS[@]} of ${CELL_TOTAL} combinations"
  info "  a partial run is reported as PARTIAL and exits ${EXIT_PARTIAL}; it can never be a PASS"
fi
CELL_RUN="${#CELL_IDS[@]}"

# ---------------------------------------------------------------------------
# 3. the network and the sink's dependency
# ---------------------------------------------------------------------------
log "3. isolated network"

docker network create --internal "$NET" >/dev/null
net_internal="$(docker network inspect --format '{{.Internal}}' "$NET")"
if [[ "$net_internal" != "true" ]]; then
  fail "the canary network is not internal; a broker call could leave this host"
  exit "$EXIT_CONTROL"
fi
ok "network $NET created, Internal=true"

# --- control: the network really has no way out ----------------------------
# Asserted, not assumed, and asserted on the EXACT failure class: a DNS
# resolution that succeeded, or a connect that returned anything other than
# "no route", would mean the isolation is not what the report claims.
egress_probe="$(docker run --rm --network "$NET" "$NODE_IMAGE" node -e '
const dns = require("dns");
dns.lookup("paper-api.alpaca.markets", (e) => {
  process.stdout.write("dns=" + (e ? e.code : "RESOLVED") + " ");
  fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(4000) })
    .then((r) => process.stdout.write("tcp=HTTP" + r.status))
    .catch((err) => process.stdout.write("tcp=" + (err.cause && err.cause.code ? err.cause.code : err.name)));
});
' 2>&1)"
info "egress control: $egress_probe"
case "$egress_probe" in
  *"dns=EAI_AGAIN"*|*"dns=ENOTFOUND"*) ;;
  *) fail "egress control: name resolution did not fail as expected ($egress_probe)"; exit "$EXIT_CONTROL" ;;
esac
case "$egress_probe" in
  *"tcp=ENETUNREACH"*|*"tcp=EHOSTUNREACH"*|*"tcp=TimeoutError"*) ;;
  *) fail "egress control: an outbound TCP connection was not refused as expected ($egress_probe)"; exit "$EXIT_CONTROL" ;;
esac
ok "the image under test cannot reach a broker even if it tries"

# --- 3c below needs the instrument to be exercised inside the image itself ---

log "3b. the sink's only dependency"
SINKDEPS="$OUT/sinkdeps"
mkdir -p "$SINKDEPS"
if [[ ! -d "$SINKDEPS/node_modules/pg" ]]; then
  ( cd "$SINKDEPS" && npm install --silent --no-audit --no-fund --no-package-lock pg@8 >/dev/null )
fi
[[ -d "$SINKDEPS/node_modules/pg" ]] || { fail "could not install the sink's pg client"; exit "$EXIT_HARNESS"; }
ok "pg client present for the recording sink"

# ---------------------------------------------------------------------------
# 3c. positive control for the egress sensors
#
# The matrix's strongest claims are absences — "no Auth call", "no broker call"
# — and an absence from a detector that has never been seen to fire is not
# evidence. The canary gets its positive control from 25_canary_arm.sql; the
# in-process egress sensors get theirs here, by running the SAME image with the
# SAME instrument and making it do the two things the matrix says never happen.
#
# It is a two-sided control: the broker host must be classified `broker`, and
# the gateway host must NOT be. A classifier that answered "broker" to
# everything would satisfy a one-sided check and make every real run fail.
# ---------------------------------------------------------------------------
# R7-4: instr/egress-control.jsonl and instr/egress-broker.txt are now READ AT
# VERDICT TIME. verdict.mjs re-derives this whole control from them — the
# configured hosts against its own pin, a broker-classified event naming a
# broker host, a sink-classified event naming the gateway, no broker-classified
# gateway, and egress-broker.txt re-extracted line for line — and refuses when
# the evidence is absent. Deleting these two files used to give rc=0 PASS.
log "3c. control — the egress sensors must fire, and must discriminate"
: > "$OUT/instr/egress-control.jsonl"
chmod 0666 "$OUT/instr/egress-control.jsonl"
set +e
docker run --rm --network "$NET" \
  -v "${HERE}/instrument:/canary:ro" \
  -v "$OUT/instr/egress-control.jsonl:/instr/events.jsonl" \
  -e NT_CANARY_INSTR_OUT=/instr \
  -e NT_CANARY_SINK_HOST=nt-canary-sink \
  -e NT_CANARY_CTL_PORT=3998 \
  -e NODE_OPTIONS="--require /canary/instrument.cjs" \
  --entrypoint node "$IMAGE" \
  -e '
    const done = (p) => p.then(() => {}, () => {});
    Promise.all([
      done(fetch("https://paper-api.alpaca.markets/v2/account", { signal: AbortSignal.timeout(4000) })),
      done(fetch("http://nt-canary-sink:8000/__canary/health", { signal: AbortSignal.timeout(4000) })),
    ]).then(() => setTimeout(() => process.exit(0), 300));
  ' >/dev/null 2>&1
egress_rc=$?
set -e
# The broker fetch is EXPECTED to fail (there is no route), so a non-zero exit
# is tolerated — but only after proving the instrument actually loaded. Without
# that check a container that never started would leave an empty log and the
# tolerance would hide it.
if ! grep -Fq '"kind":"instrument.loaded"' "$OUT/instr/egress-control.jsonl"; then
  fail "egress control: the instrument never loaded in the control container (docker rc=$egress_rc)"
  exit "$EXIT_CONTROL"
fi

if ! grep -Fq '"hostClass":"broker"' "$OUT/instr/egress-control.jsonl"; then
  fail "egress control: a real broker fetch produced no broker-classified event"
  fail "  the 'no broker call' column of the matrix would be meaningless this run"
  sed 's/^/       /' "$OUT/instr/egress-control.jsonl" >&2
  exit "$EXIT_CONTROL"
fi
if ! grep -Fq '"hostClass":"supabase-sink"' "$OUT/instr/egress-control.jsonl"; then
  fail "egress control: a fetch to the recording gateway was not recognised as one"
  sed 's/^/       /' "$OUT/instr/egress-control.jsonl" >&2
  exit "$EXIT_CONTROL"
fi
# ...and the discrimination is real: the gateway must never be called a broker.
#
# Written as two separate greps over a file rather than `grep | grep -q`: the
# reader of such a pipeline exits on its first match, the upstream grep takes
# SIGPIPE, and under `pipefail` the pipeline's status is then the OPPOSITE of
# what the test means.
grep -F '"hostClass":"broker"' "$OUT/instr/egress-control.jsonl" > "$OUT/instr/egress-broker.txt"
if grep -Fq 'nt-canary-sink' "$OUT/instr/egress-broker.txt"; then
  fail "egress control: the gateway host was classified as a broker; the classifier is not discriminating"
  exit "$EXIT_CONTROL"
fi
n_broker="$(grep -c '"hostClass":"broker"' "$OUT/instr/egress-control.jsonl")"
n_sink="$(grep -c '"hostClass":"supabase-sink"' "$OUT/instr/egress-control.jsonl")"
ok "egress sensors fire and discriminate (broker events: $n_broker, gateway events: $n_sink)"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

psql_read()  { docker exec "$PG_C" psql -U postgres -d postgres -X -tA "$@"; }

# `PSQL_AS` selects the connection role for the next call only. It defaults to
# `postgres`, which is what the migrations run as; `supabase_admin` is needed
# for the handful of objects the image reserves to a superuser.
PSQL_AS="postgres"
copy_and_run() {  # local-file, label, [extra psql args...]
  local f="$1" label="$2"; shift 2
  local base; base="$(basename "$f")"
  local as="$PSQL_AS"; PSQL_AS="postgres"
  docker cp "$f" "$PG_C:/canary_$base" >/dev/null
  local err="$OUT/sql/${label}.err" outf="$OUT/sql/${label}.out"
  set +e
  docker exec -i "$PG_C" psql -U "$as" -d postgres -X -q -v ON_ERROR_STOP=1 "$@" -f "/canary_$base" \
    >"$outf" 2>"$err"
  local rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    fail "$label failed (rc=$rc)"
    sed 's/^/       /' "$err" >&2
    return 1
  fi
  return 0
}

# 5 CONSECUTIVE semantic queries as supabase_admin. Never pg_isready: this
# image restarts postgres in the middle of its own bootstrap, and a socket
# probe answers happily from the temporary server that is about to be shut down.
wait_pg_ready() {
  local streak=0 waited=0 out
  while (( waited < 240 )); do
    if out="$(docker exec "$PG_C" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -X -tA \
              -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage','vault')" 2>/dev/null)"; then
      if [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "5" ]]; then
        streak=$(( streak + 1 ))
        if (( streak >= 5 )); then
          info "$PG_C ready (5 consecutive semantic queries as supabase_admin, ${waited}s)"
          return 0
        fi
      else
        streak=0
      fi
    else
      streak=0
    fi
    sleep 1; waited=$(( waited + 1 ))
  done
  fail "$PG_C never reached 5 consecutive successful queries in 240s"
  docker logs --tail 40 "$PG_C" >&2 || true
  return 1
}

wait_app_ready() {
  local streak=0 waited=0 out state
  while (( waited < 90 )); do
    # A container that has already exited will never become ready, and polling
    # a dead name is slow (each probe pays a failed DNS lookup). Fail on the
    # first observation instead, and say why.
    state="$(docker inspect --format '{{.State.Running}}' "$APP_C" 2>/dev/null || echo missing)"
    if [[ "$state" != "true" ]]; then
      fail "the image under test exited before becoming ready (state=$state, exit=$(docker inspect --format '{{.State.ExitCode}}' "$APP_C" 2>/dev/null || echo '?'))"
      docker logs --tail 40 "$APP_C" >&2 || true
      return 1
    fi
    if out="$(docker exec "$SINK_C" node -e '
      fetch("http://nt-canary-app:3000/api/health", { signal: AbortSignal.timeout(3000) })
        .then(async (r) => { const j = await r.json(); process.stdout.write(r.status + ":" + (j.artifact_role || "-")); })
        .catch(() => process.stdout.write("down"));' 2>/dev/null)"; then
      case "$out" in
        200:*) streak=$(( streak + 1 )); (( streak >= 3 )) && return 0 ;;
        *) streak=0 ;;
      esac
    else
      streak=0
    fi
    sleep 1; waited=$(( waited + 1 ))
  done
  fail "the image under test never became ready (last probe: ${out:-none})"
  docker logs --tail 40 "$APP_C" >&2 || true
  return 1
}

commitments() {  # label -> writes $OUT/sql/commit-<label>.txt
  local label="$1"
  copy_and_run "${HERE}/sql/30_commitments.sql" "commit-${label}" || return 1
  if ! grep -E '^(NT_COMMIT_|NT_CANARY_)' "$OUT/sql/commit-${label}.out" > "$OUT/sql/commit-${label}.txt"; then
    fail "the commitment file for ${label} is empty; nothing could be compared"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# per-schema run
# ---------------------------------------------------------------------------
SENSOR_VERDICTS=()
SENSOR_HITS=()
SENSOR_STATE=""
EXTRA_HITS_PER_WRAPPER=0

SCHEMAS=()
case "$SCHEMA" in
  both) SCHEMAS=(0008 0023) ;;
  *)    SCHEMAS=("$SCHEMA") ;;
esac

# --- provenance, written INTO the artefacts, before anything is driven -----
# Audit finding B3: the run printed all of this to stdout and wrote none of it,
# and verdict.mjs took the probe id and the dirty count as command-line
# arguments. So the artefacts recorded no image, no probe identity and no run,
# and a directory assembled from two invocations certified silently.
P_RUN_NONCE="$RUN_NONCE" P_MODE="$MODE" P_BREAK="$BREAK_SENSOR" \
P_SCHEMAS="$(IFS=,; echo "${SCHEMAS[*]}")" \
P_CELLS_RUN="$CELL_RUN" P_CELLS_TOTAL="$CELL_TOTAL" \
P_IMAGE="$IMAGE" P_IMAGE_ID="$app_image_id" P_IMAGE_REV="$app_image_rev" \
P_IMAGE_SRC_DIGEST="$img_src_digest" \
P_SOURCE="$SOURCE" P_SOURCE_DIGEST="$SOURCE_DIGEST" P_COMMIT_TREE_DIGEST="$COMMIT_TREE_DIGEST" \
P_PG_IMAGE="$PG_IMAGE" P_PG_IMAGE_ID="$pg_image_id" \
P_PG_PINNED="$( [[ "$PG_IMAGE" == "$PG_IMAGE_DEFAULT" ]] && echo 1 || echo 0 )" \
P_TARGET_ROOT="$TARGET_ROOT" P_TARGET_SHA="$TARGET_SHA" P_TARGET_DIRTY="$TARGET_DIRTY" \
P_TRUSTED_ROOT="$TRUSTED_ROOT" P_TRUSTED_SHA="$TRUSTED_SHA" P_TRUSTED_DIGEST="$TRUSTED_DIGEST" \
P_CLASSIFIER_DIGEST="$CLASSIFIER_DIGEST" \
P_CLASSIFIER_SNAPSHOT="$CLASSIFIER_SNAPSHOT" \
P_PROBE_USER_ID="$CANARY_PROBE_USER_ID" P_PROBE_ACCOUNT_ID="$CANARY_PROBE_ACCOUNT_ID" \
node -e '
const fs = require("node:fs");
const e = process.env;
const o = {
  note: "Written by run.sh before the matrix is driven. verdict.mjs reads the probe id, the dirty count and the run nonce OUT OF HERE rather than from its own argv, and requires every cell result to carry this runNonce.",
  runNonce: e.P_RUN_NONCE,
  startedAt: new Date().toISOString(),
  mode: e.P_MODE,
  breakSensor: e.P_BREAK,
  schemas: e.P_SCHEMAS.split(",").filter(Boolean),
  cellsRun: Number(e.P_CELLS_RUN),
  cellsTotal: Number(e.P_CELLS_TOTAL),
  image: e.P_IMAGE,
  imageId: e.P_IMAGE_ID,
  imageRevision: e.P_IMAGE_REV,
  imageSourceDigest: e.P_IMAGE_SRC_DIGEST,
  sourceTree: e.P_SOURCE,
  sourceDigest: e.P_SOURCE_DIGEST,
  commitTreeDigest: e.P_COMMIT_TREE_DIGEST,
  pgImage: e.P_PG_IMAGE,
  pgImageId: e.P_PG_IMAGE_ID,
  pgImagePinned: e.P_PG_PINNED === "1",
  targetRoot: e.P_TARGET_ROOT,
  targetSha: e.P_TARGET_SHA,
  targetDirty: Number(e.P_TARGET_DIRTY),
  trustedRoot: e.P_TRUSTED_ROOT,
  trustedSha: e.P_TRUSTED_SHA,
  trustedDigest: e.P_TRUSTED_DIGEST,
  classifierDigest: e.P_CLASSIFIER_DIGEST,
  classifierSnapshot: e.P_CLASSIFIER_SNAPSHOT,
  probeUserId: e.P_PROBE_USER_ID,
  probeAccountId: e.P_PROBE_ACCOUNT_ID,
};
fs.writeFileSync(process.argv[1], JSON.stringify(o, null, 2));
' "$OUT/provenance.json" || { fail "could not write the run provenance"; exit "$EXIT_HARNESS"; }
[[ -s "$OUT/provenance.json" ]] || { fail "provenance.json was written empty"; exit "$EXIT_HARNESS"; }
ok "provenance recorded (run nonce ${RUN_NONCE:0:8}…, image ${app_image_id:0:19})"

run_schema() {
  local schema="$1"
  PG_C="nt-canary-pg-${schema}-${RUN_ID}"

  # The network alias is PER GENERATION, and the gateway is pointed at the
  # container NAME, not at a shared alias.
  #
  # Both generations used to be given the same `--network-alias nt-canary-pg`
  # and the 0008 server was never torn down before the 0023 server started, so
  # for the whole of the second generation two live databases answered to the
  # one name the gateway was configured with (SINK_PGHOST=nt-canary-pg) and
  # docker's embedded DNS round-robined between them. Every 0023 cell — its
  # requests, its commitments and, worst of all, B1's generation witness — could
  # have been served by the 0008 database. That is not a theoretical ordering
  # hazard: it is the exact contamination the two-generation matrix exists to
  # rule out, running inside the harness that reports it ruled out.
  #
  # Two independent changes, because one of them is a guard and the other
  # removes the ambiguity:
  #   * nothing shares a name any more (alias and SINK_PGHOST are both
  #     generation-specific), so there is no name for DNS to be ambiguous about;
  #   * the previous generation's server is removed before this one starts, so a
  #     stale generation is not even on the network.
  if [[ "$KEEP" -ne 1 ]]; then
    local prior
    for prior in 0008 0023; do
      [[ "$prior" == "$schema" ]] && continue
      docker rm -f "nt-canary-pg-${prior}-${RUN_ID}" >/dev/null 2>&1 || true
    done
  fi

  log "4.${schema} starting ${PG_IMAGE}"
  docker run -d --name "$PG_C" --network "$NET" --network-alias "nt-canary-pg-${schema}" \
    -e POSTGRES_PASSWORD=runtime-canary-throwaway \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$PG_IMAGE" >/dev/null
  wait_pg_ready || return "$EXIT_HARNESS"

  # Positive check, from inside the network the gateway lives on, that the name
  # the gateway is configured with resolves to exactly ONE address and that the
  # address is this generation's server. This is the check the old shared alias
  # would have failed: `nt-canary-pg` resolved to two addresses for the whole of
  # the second generation. It is asserted rather than assumed because "docker
  # DNS gave the right answer" is not something a run may take on trust.
  local pg_ip pg_resolved
  if ! pg_ip="$(docker inspect --format "{{ (index .NetworkSettings.Networks \"${NET}\").IPAddress }}" "$PG_C")"; then
    fail "could not read $PG_C's address on $NET"; return "$EXIT_HARNESS"
  fi
  pg_resolved="$(docker run --rm --network "$NET" "$NODE_IMAGE" node -e '
    require("dns").promises.lookup(process.argv[1], { all: true })
      .then(a => process.stdout.write(a.map(x => x.address).sort().join(",")))
      .catch(e => process.stdout.write("UNRESOLVED:" + (e && e.code)));' "$PG_C" 2>/dev/null || true)"
  if [[ "$pg_resolved" != "$pg_ip" ]]; then
    fail "the database name the gateway will use does not resolve to this generation's server:"
    fail "  name        : $PG_C"
    fail "  resolves to : ${pg_resolved:-nothing}"
    fail "  expected    : $pg_ip"
    fail "  More than one address means two canary databases answer to one name, and a"
    fail "  ${schema} cell can be served by the other generation."
    return "$EXIT_CONTROL"
  fi
  ok "${schema} database reachable at one address only ($PG_C -> $pg_ip)"

  # Status-checked: errexit is off inside this function (see the note on the
  # per-cell environment below), so an unchecked substitution here would
  # compare an empty string with the pinned id and fail with a confusing
  # message instead of the real one.
  local running
  if ! running="$(docker inspect --format '{{.Image}}' "$PG_C")"; then
    fail "could not inspect $PG_C to confirm which image it is running"; return "$EXIT_HARNESS"
  fi
  if [[ "$running" != "$pg_image_id" ]]; then
    fail "$PG_C runs image $running, not the resolved $pg_image_id"; return "$EXIT_CONTROL"
  fi
  # This line used to read "confirmed running the pinned production image id"
  # unconditionally. It is only true when --pg-image was not used: with a
  # substituted image the check still passes (the container does run the image
  # the run resolved) but the image is not the pinned production digest, and the
  # report said it was.
  if [[ "$PG_IMAGE" == "$PG_IMAGE_DEFAULT" ]]; then
    ok "confirmed running the pinned production image id"
  else
    printf '\033[1;33m warn\033[0m running %s, which is NOT the pinned production digest (--pg-image was given)\n' "$PG_IMAGE"
    printf '        pinned: %s\n' "$PG_IMAGE_DEFAULT"
  fi

  # --- bootstrap ------------------------------------------------------------
  log "5.${schema} environment bootstrap (reused, drift-checked)"
  docker cp "$BOOTSTRAP_FILE" "$PG_C:/canary_bootstrap.sql" >/dev/null
  if ! docker exec -i "$PG_C" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 -f /canary_bootstrap.sql; then
    fail "bootstrap failed"; return "$EXIT_HARNESS"
  fi
  local n_public
  if ! n_public="$(psql_read -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f')")"; then
    fail "could not count the relations the bootstrap left in public"; return "$EXIT_HARNESS"
  fi
  n_public="${n_public//[[:space:]]/}"
  # A query that returned nothing is not a query that returned zero.
  if [[ ! "$n_public" =~ ^[0-9]+$ ]]; then
    fail "the public-relation count is not a number: '${n_public}'"; return "$EXIT_CONTROL"
  fi
  if [[ "$n_public" != "0" ]]; then
    fail "the bootstrap left $n_public relations in public; it must touch only storage"; return "$EXIT_CONTROL"
  fi
  ok "bootstrap applied, public schema still empty"

  # --- control: ON_ERROR_STOP really stops, with the exact error class -------
  # R7-4: sql/on-error-stop-<schema>.err is READ AT VERDICT TIME and must name
  # the exact class. The applier's EXIT STATUS is not written into the artefact,
  # so that half stays here; see the `run-controls` scope statement.
  log "5b.${schema} control — a broken statement must abort with its own error"
  local cerr="$OUT/sql/on-error-stop-${schema}.err" crc
  set +e
  printf 'select 1;\nselect 1/0;\nselect 2;\n' \
    | docker exec -i "$PG_C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - >/dev/null 2>"$cerr"
  crc=$?
  set -e
  if [[ "$crc" -eq 0 ]]; then
    fail "control: a division-by-zero script exited 0 — ON_ERROR_STOP is not in effect"; return "$EXIT_CONTROL"
  fi
  if ! grep -Fq 'division by zero' "$cerr"; then
    fail "control: the applier failed (rc=$crc) but not with the expected error class"
    cat "$cerr" >&2; return "$EXIT_CONTROL"
  fi
  ok "control: rc=$crc and stderr names the exact failure"

  # --- migrations -----------------------------------------------------------
  log "6.${schema} applying migrations"
  mapfile -t ALL_MIG < <(find "$MIGRATIONS" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort)
  [[ "${#ALL_MIG[@]}" -gt 0 ]] || { fail "no migrations in $MIGRATIONS"; return "$EXIT_HARNESS"; }
  local SET=() m
  for m in "${ALL_MIG[@]}"; do
    if [[ "$schema" == "0008" && "${m:0:4}" > "0008" ]]; then continue; fi
    SET+=("$m")
  done
  if [[ "$schema" == "0008" ]]; then
    local expected="0001 0002 0003 0004 0005 0006 0007 0008" got=""
    for m in "${SET[@]}"; do got+="${m:0:4} "; done
    if [[ "${got% }" != "$expected" ]]; then
      fail "the 0001-0008 range is not contiguous: [${got% }]"; return "$EXIT_HARNESS"
    fi
  fi
  docker cp "$MIGRATIONS" "$PG_C:/mig" >/dev/null
  for m in "${SET[@]}"; do
    local merr="$OUT/sql/mig-${schema}-${m}.err" mrc
    set +e
    docker exec -i "$PG_C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f "/mig/$m" \
      >"$OUT/sql/mig-${schema}-${m}.out" 2>"$merr"
    mrc=$?
    set -e
    if [[ "$mrc" -ne 0 ]]; then
      fail "migration $m failed on the $schema database (rc=$mrc)"
      sed 's/^/       /' "$merr" >&2
      return "$EXIT_HARNESS"
    fi
  done
  info "applied ${#SET[@]} migrations (${SET[0]} .. ${SET[-1]})"

  # --- seed + probe identity ------------------------------------------------
  log "7.${schema} seed and the disposable probe identity"
  docker cp "$SEED_FILE" "$PG_C:/canary_seed.sql" >/dev/null
  if ! docker exec -i "$PG_C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f /canary_seed.sql \
       >"$OUT/sql/seed-${schema}.out" 2>"$OUT/sql/seed-${schema}.err"; then
    fail "seed failed"; sed 's/^/       /' "$OUT/sql/seed-${schema}.err" >&2; return "$EXIT_HARNESS"
  fi
  sed 's/^/   /' "$OUT/sql/seed-${schema}.err"
  copy_and_run "${HERE}/sql/15_probe_identity.sql" "probe-${schema}" || return "$EXIT_HARNESS"
  sed 's/^/   /' "$OUT/sql/probe-${schema}.err"

  # --- what the wrappers do before anything is installed --------------------
  log "7b.${schema} baseline — the wrappers' own behaviour, before the canary"
  copy_and_run "${HERE}/sql/18_prewrapper_baseline.sql" "baseline-${schema}" \
    || { fail "the pre-canary baseline probe failed"; return "$EXIT_HARNESS"; }
  if ! baseline_line="$(grep -m1 -F 'BASELINE_OUTCOME=' "$OUT/sql/baseline-${schema}.out")"; then
    fail "the baseline probe printed no outcome line"; return "$EXIT_CONTROL"
  fi
  info "${baseline_line}"
  # ...and it must be what this checkout says this schema does. The file's own
  # prose used to claim that on 0001-0008 "update and delete raise", while the
  # observed baseline was all three returning; nothing compared the two, so the
  # documentation was free to be wrong indefinitely.
  local expected_baseline_file="${HERE}/sql/expected-baseline.${schema}.txt"
  if [[ ! -f "$expected_baseline_file" ]]; then
    fail "this checkout records no expected baseline for schema ${schema} (${expected_baseline_file})"
    return "$EXIT_CONTROL"
  fi
  local expected_baseline; expected_baseline="$(tr -d '\r' < "$expected_baseline_file" | head -1)"
  if [[ "$baseline_line" != "$expected_baseline" ]]; then
    fail "the ${schema} schema does not behave as this checkout records:"
    fail "  observed: ${baseline_line}"
    fail "  recorded: ${expected_baseline}"
    fail "  re-record sql/expected-baseline.${schema}.txt deliberately, and fix the prose in 18_prewrapper_baseline.sql with it"
    return "$EXIT_CONTROL"
  fi
  ok "the baseline matches sql/expected-baseline.${schema}.txt"

  # --- the tombstone classification, from the REAL classifier ---------------
  # Runs BEFORE the canary is installed, so it classifies the schema's own
  # wrappers rather than the harness's clones. `CANARY_TOMBSTONED` used to be a
  # prosrc substring test printed here and asserted on by nothing.
  # R7-4: tombstone-<schema>.txt is READ AT VERDICT TIME and must classify all
  # three instrumented wrappers, record result=PASS, and agree with
  # expected/tombstone-state.<schema>.txt.
  log "7c.${schema} tombstone classification, bound to catalogue-classify.sql"
  set +e
  "$TOMB_BINDING" --pg "$PG_C" --schema "$schema" --out "$OUT/sql/classify-${schema}.txt" \
    > "$OUT/tombstone-${schema}.txt" 2>&1
  local tomb_rc=$?
  set -e
  sed 's/^/   /' "$OUT/tombstone-${schema}.txt"
  if [[ "$tomb_rc" -ne 0 ]]; then
    fail "the tombstone binding refused this schema (rc=${tomb_rc})"
    return "$EXIT_CONTROL"
  fi
  if ! grep -Fq 'CANARY_TOMBSTONED=' "$OUT/tombstone-${schema}.txt"; then
    fail "the tombstone binding produced no classification"; return "$EXIT_CONTROL"
  fi

  # --- the canary, installed by the TRUSTED RUNNER --------------------------
  # `verify-sensor.sh arm` verifies the install SQL's digest against this
  # checkout, installs it, draws a per-run nonce AFTER the artifact under test
  # is fixed, seals a keyed manifest over the complete normalised definitions,
  # proves no role the image can arrive as can modify the sensor, and fires
  # every wrapper once under the nonce. Nothing here is supplied by, or
  # reachable from, the candidate.
  log "8.${schema} arming the sensor (trusted runner)"
  SENSOR_STATE="$OUT/sensor-state-${schema}"
  set +e
  "$SENSOR" arm --pg "$PG_C" --schema "$schema" --state "$SENSOR_STATE" \
    --artifact-digest "${app_image_id}" > "$OUT/sensor-arm-${schema}.txt" 2>&1
  local arm_rc=$?
  set -e
  sed 's/^/   /' "$OUT/sensor-arm-${schema}.txt"
  if [[ "$arm_rc" -ne 0 ]]; then
    fail "the sensor did not arm; no absence measured on this database would mean anything"
    return "$EXIT_CONTROL"
  fi
  cp "$OUT/sensor-arm-${schema}.txt" "$OUT/canary-install-${schema}.txt"

  # R7-4: canary-arm-<schema>.txt, sql/arm-<schema>.out and sql/baseline-<schema>.out
  # are READ AT VERDICT TIME; the fidelity comparison below is recomputed there,
  # and the baseline additionally checked against sql/expected-baseline.<schema>.txt
  # so the two artefacts cannot agree with each other while both are wrong.
  log "8b.${schema} FIDELITY CONTROL — the canary must not change what the wrappers do"
  if ! copy_and_run "${HERE}/sql/25_canary_arm.sql" "arm-${schema}"; then
    fail "the canary did not fire when called directly; no zero from this run means anything"
    return "$EXIT_CONTROL"
  fi
  if ! grep -E 'CANARY_(ARMED|BASELINE|ROWS_AFTER_ARM)=' "$OUT/sql/arm-${schema}.out" > "$OUT/canary-arm-${schema}.txt"; then
    fail "the arming probe printed no verdict lines"; return "$EXIT_CONTROL"
  fi
  sed 's/^/   /' "$OUT/canary-arm-${schema}.txt"
  # The outcome line records WHAT each wrapper did (returned vs raised, and with
  # which SQLSTATE) — the schema-dependent half the probe deliberately does not
  # assert on. `grep` finding nothing is a real failure, so it is checked.
  if ! grep -F 'ARMING_OUTCOMES' "$OUT/sql/arm-${schema}.err" | sed 's/^/   /'; then
    fail "the arming probe recorded no per-wrapper outcome"; return "$EXIT_CONTROL"
  fi
  if ! grep -Fq 'CANARY_ARMED=yes' "$OUT/canary-arm-${schema}.txt"; then
    fail "the arming probe did not confirm the sensor"; return "$EXIT_CONTROL"
  fi
  # This probe is kept for the FIDELITY comparison below, not as arming
  # evidence: its cell tag is the fixed literal `arming-probe`, and a sensor
  # rigged to record only that literal passes it while being blind to
  # everything else (see tests/k1-sensor-negative-controls.sh case 4). It moves
  # each counter by exactly one, which the sensor runner is told to expect.
  EXTRA_HITS_PER_WRAPPER=1
  ok "the canary records one hit per wrapper when called (fidelity probe)"

  # --- fidelity control: the canary must not have changed the behaviour -----
  # "It behaves as the schema's real version would" is the load-bearing claim
  # of the whole design. Here it is checked rather than asserted: the same
  # three calls, before and after installation, must have the same observable
  # outcome — returned, or raised with the same SQLSTATE.
  log "8b2.${schema} control — the canary must preserve what the wrappers do"
  if ! arming_line="$(grep -m1 -F 'ARMING_OUTCOME=' "$OUT/sql/arm-${schema}.out")"; then
    fail "the arming probe printed no comparable outcome line"; return "$EXIT_CONTROL"
  fi
  base_val="${baseline_line#BASELINE_OUTCOME=}"
  arm_val="${arming_line#ARMING_OUTCOME=}"
  if [[ "$base_val" != "$arm_val" ]]; then
    fail "the canary CHANGED the wrappers' behaviour — the delegate is not the original"
    fail "  before: $base_val"
    fail "  after : $arm_val"
    return "$EXIT_CONTROL"
  fi
  ok "behaviour preserved through the canary: $arm_val"

  if [[ "$BREAK_SENSOR" == "drop" || "$BREAK_SENSOR" == "mute" ]]; then
    log "8c.${schema} SABOTAGE (property C): --break-sensor $BREAK_SENSOR"
    copy_and_run "${HERE}/sql/22_canary_break.sql" "sabotage-${schema}" -v "mode=$BREAK_SENSOR" \
      || { fail "the sabotage itself failed"; return "$EXIT_HARNESS"; }
    if ! grep -E 'CANARY_SABOTAGE=' "$OUT/sql/sabotage-${schema}.out" | sed 's/^/   /'; then
      fail "the sabotage produced no verdict line"; return "$EXIT_HARNESS"
    fi
  fi

  # --- the sink -------------------------------------------------------------
  log "9.${schema} recording Supabase gateway"
  PSQL_AS=supabase_admin \
  copy_and_run "${HERE}/sql/05_sink_role.sql" "sinkrole-${schema}" \
    || { fail "could not prepare the gateway's connection role"; return "$EXIT_HARNESS"; }
  docker rm -f "$SINK_C" >/dev/null 2>&1 || true
  : > "$OUT/sink-${schema}.jsonl"
  chmod 0666 "$OUT/sink-${schema}.jsonl"
  docker run -d --name "$SINK_C" --network "$NET" --network-alias nt-canary-sink \
    -v "${HERE}/sink:/canary:ro" \
    -v "${SINKDEPS}/node_modules:/node_modules:ro" \
    -v "$OUT/sink-${schema}.jsonl:/out/sink.jsonl" \
    -e SINK_PGHOST="$PG_C" \
    -e SINK_PGPASSWORD='nt-runtime-canary-not-a-credential' \
    -e SINK_JWT_SECRET="nt-runtime-canary-not-a-secret-signing-key" \
    -e SINK_PROBE_USER_ID="$CANARY_PROBE_USER_ID" \
    "$NODE_IMAGE" node /canary/sink.mjs >/dev/null
  local waited=0 health=""
  while (( waited < 60 )); do
    health="$(docker exec "$SINK_C" node -e '
      fetch("http://127.0.0.1:8000/__canary/health",{signal:AbortSignal.timeout(3000)})
        .then(r=>r.json()).then(j=>process.stdout.write(String(j.ok)))
        .catch(()=>process.stdout.write("down"));' 2>/dev/null || true)"
    [[ "$health" == "true" ]] && break
    sleep 1; waited=$(( waited + 1 ))
  done
  if [[ "$health" != "true" ]]; then
    fail "the recording sink never reached the database (last: ${health:-none})"
    docker logs --tail 30 "$SINK_C" >&2 || true
    return "$EXIT_HARNESS"
  fi
  ok "sink up and forwarding to the $schema clone"

  # --- control: the gateway is talking to the generation we think it is -----
  # Audit finding B1. The generation used to exist only as a filename prefix, so
  # one generation's cells under the other's names were indistinguishable. The
  # gateway now reads a structural fingerprint of `public` out of the running
  # server; the driver records it in every cell result and the gateway logs its
  # own copy. This checks it ONCE here as well, so a mispinned or wrongly
  # migrated database fails five minutes in rather than twenty-five.
  local gen_json gen_fp want_fp
  if ! gen_json="$(docker exec "$SINK_C" node -e '
      fetch("http://127.0.0.1:8000/__canary/generation",{signal:AbortSignal.timeout(15000)})
        .then(r=>r.text()).then(t=>process.stdout.write(t))
        .catch(e=>{process.stdout.write(JSON.stringify({error:String(e.message||e)}));process.exitCode=1;});' 2>/dev/null)"; then
    fail "could not read the generation witness from the gateway"; return "$EXIT_CONTROL"
  fi
  if ! gen_fp="$(node -e '
      const j = JSON.parse(process.argv[1]);
      if (!j.fingerprint) { console.error(j.error || "no fingerprint"); process.exit(1); }
      process.stdout.write(j.fingerprint);' "$gen_json")"; then
    fail "the gateway returned no generation fingerprint: $gen_json"; return "$EXIT_CONTROL"
  fi
  if ! want_fp="$(node -e '
      const m = require(process.argv[1]);
      const w = m.schemaWitness && m.schemaWitness[process.argv[2]];
      if (!w || !w.fingerprint) { console.error("no pinned fingerprint"); process.exit(1); }
      process.stdout.write(w.fingerprint);' "$REQUEST_MANIFEST" "$schema")"; then
    fail "the committed manifest pins no generation fingerprint for ${schema}"; return "$EXIT_CONTROL"
  fi
  if [[ "$gen_fp" != "$want_fp" ]]; then
    fail "the ${schema} database is not the generation this checkout pins:"
    fail "  observed: $gen_fp   ($gen_json)"
    fail "  pinned  : $want_fp"
    fail "  Either the migrations changed — re-record expected/request-manifest.json"
    fail "  schemaWitness.${schema} deliberately — or this run applied the wrong set."
    return "$EXIT_CONTROL"
  fi
  ok "generation witness for ${schema}: ${gen_fp} (matches the committed manifest)"

  # --- commitments before ---------------------------------------------------
  commitments "before-${schema}" || return "$EXIT_HARNESS"
  info "commitment lines recorded: $(wc -l < "$OUT/sql/commit-before-${schema}.txt")"

  # --- drive the matrix -----------------------------------------------------
  #
  # The sensor is challenged again at UNPREDICTABLE points during the matrix,
  # not only before and after it. The schedule is drawn from /dev/urandom after
  # the nonce, so neither the schedule nor the tag a challenge will carry is
  # anything the artifact under test could have been built to anticipate.
  log "10.${schema} driving the matrix (${#CELL_IDS[@]} environment combinations)"
  local n_cells="${#CELL_IDS[@]}"
  local n_interleave=2
  (( n_cells < 2 )) && n_interleave=1
  local -A CHALLENGE_AT=()
  local pick tries=0
  # Distinct points: two draws that collide would leave one interleaved round,
  # which is legal but weaker than intended, and silently so.
  while (( ${#CHALLENGE_AT[@]} < n_interleave && tries < 100 )); do
    pick=$(( $(od -An -N4 -tu4 < /dev/urandom | tr -d ' ') % n_cells ))
    CHALLENGE_AT["$pick"]=1
    tries=$(( tries + 1 ))
  done
  info "interleaved sensor challenges after cell index: $(IFS=,; echo "${!CHALLENGE_AT[*]}")"

  local mid_round=0
  local prev_commit="$OUT/sql/commit-before-${schema}.txt"
  local cell_index=-1
  local cell
  for cell in "${CELL_IDS[@]}"; do
    cell_index=$(( cell_index + 1 ))
    # The mutant really deletes; without a reset only the first cell could
    # reach the wrapper. The frozen run never calls this.
    if [[ "$MODE" == "mutant" ]]; then
      copy_and_run "${HERE}/sql/16_reset_probe_account.sql" "reset-${schema}-${cell}" \
        || { fail "probe account reset failed before cell $cell"; return "$EXIT_HARNESS"; }
    fi

    if ! node -e '
      const fs = require("fs");
      const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const c = m.cells.find((x) => x.id === process.argv[2]);
      if (!c) { console.error("no such cell"); process.exit(2); }
      fs.writeFileSync(process.argv[3], JSON.stringify(c, null, 2));
    ' "$OUT/matrix.json" "$cell" "$OUT/cells/plan-${cell}.json"; then
      fail "the plan for cell ${cell} could not be extracted from the matrix"
      return "$EXIT_HARNESS"
    fi

    # --- the cell's environment, with every status checked -------------------
    #
    # `run_schema` is called with errexit DISABLED, on purpose, so a non-zero
    # return can be turned into an exit code rather than killing the script. The
    # consequence is that an unchecked command substitution in here does not
    # stop anything: it assigns the empty string and the run carries on. That is
    # exactly how a cell could be started with the WRONG freeze flags — an empty
    # DASHBOARD_MAINTENANCE_MODE where the plan said `on`, or the flag omitted
    # where the plan said empty — and still be recorded under the plan's name.
    # The audit reached the same end state by hand; this is the path that
    # reaches it by accident.
    #
    # So each of the three is status-checked, and then its VALUE is checked
    # against the domain the generator can legally produce. An empty string is a
    # legal value for two of them, so "non-empty" would not be a test.
    local envargs=()
    local mm ss bb
    if ! mm="$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.env.DASHBOARD_MAINTENANCE_MODE)' "$OUT/cells/plan-${cell}.json")"; then
      fail "cell ${cell}: DASHBOARD_MAINTENANCE_MODE could not be read from the plan"; return "$EXIT_HARNESS"
    fi
    if ! ss="$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.env.DASHBOARD_SIDECAR_ONLY)' "$OUT/cells/plan-${cell}.json")"; then
      fail "cell ${cell}: DASHBOARD_SIDECAR_ONLY could not be read from the plan"; return "$EXIT_HARNESS"
    fi
    if ! bb="$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.env.DASHBOARD_FREEZE_BYPASS_USERS)' "$OUT/cells/plan-${cell}.json")"; then
      fail "cell ${cell}: DASHBOARD_FREEZE_BYPASS_USERS could not be read from the plan"; return "$EXIT_HARNESS"
    fi
    case "$mm" in on|off|""|__absent__) ;; *) fail "cell ${cell}: DASHBOARD_MAINTENANCE_MODE is not a value the generator produces: '${mm}'"; return "$EXIT_HARNESS" ;; esac
    case "$ss" in on|off|__absent__)     ;; *) fail "cell ${cell}: DASHBOARD_SIDECAR_ONLY is not a value the generator produces: '${ss}'";     return "$EXIT_HARNESS" ;; esac
    case "$bb" in __empty__|__probe__)   ;; *) fail "cell ${cell}: DASHBOARD_FREEZE_BYPASS_USERS is not a value the generator produces: '${bb}'"; return "$EXIT_HARNESS" ;; esac
    # ...and the triple must be the one this cell's NAME claims, so a plan that
    # was extracted for the wrong cell cannot be started under the right label.
    local lm ls lb want_id
    case "$mm" in __absent__) lm=absent ;; "") lm=empty ;; *) lm="$mm" ;; esac
    case "$ss" in __absent__) ls=absent ;; *) ls="$ss" ;; esac
    case "$bb" in __empty__) lb=empty ;; __probe__) lb=probe ;; esac
    want_id="m-${lm}__s-${ls}__b-${lb}"
    if [[ "$want_id" != "$cell" ]]; then
      fail "cell ${cell}: the extracted plan describes ${want_id}"
      return "$EXIT_HARNESS"
    fi
    [[ "$mm" != "__absent__" ]] && envargs+=(-e "DASHBOARD_MAINTENANCE_MODE=$mm")
    [[ "$ss" != "__absent__" ]] && envargs+=(-e "DASHBOARD_SIDECAR_ONLY=$ss")
    case "$bb" in
      __empty__) envargs+=(-e "DASHBOARD_FREEZE_BYPASS_USERS=") ;;
      __probe__) envargs+=(-e "DASHBOARD_FREEZE_BYPASS_USERS=$CANARY_PROBE_USER_ID") ;;
    esac

    docker rm -f "$APP_C" >/dev/null 2>&1 || true
    : > "$OUT/instr/${schema}-${cell}.jsonl"
    chmod 0666 "$OUT/instr/${schema}-${cell}.jsonl"
    docker run -d --name "$APP_C" --network "$NET" --network-alias nt-canary-app \
      -v "${HERE}/instrument:/canary:ro" \
      -v "$OUT/instr/${schema}-${cell}.jsonl:/instr/events.jsonl" \
      -e NODE_OPTIONS="--require /canary/instrument.cjs" \
      -e NT_CANARY_INSTR_OUT=/instr \
      -e NT_CANARY_SINK_HOST=nt-canary-sink \
      -e SUPABASE_SERVER_URL="http://nt-canary-sink:8000" \
      -e NEXT_PUBLIC_SUPABASE_URL="http://nt-canary-sink:8000" \
      -e NEXT_PUBLIC_SUPABASE_ANON_KEY="$CANARY_ANON_KEY" \
      -e SUPABASE_SERVICE_ROLE_KEY="$CANARY_SERVICE_ROLE_KEY" \
      -e NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME="$CANARY_COOKIE_NAME" \
      "${envargs[@]}" \
      "$IMAGE" >/dev/null
    if ! wait_app_ready; then return "$EXIT_HARNESS"; fi

    docker run --rm --network "$NET" \
      -v "${HERE}/driver:/canary:ro" \
      -v "$OUT/cells:/out" \
      -e NT_CELL="$cell" \
      -e NT_SCHEMA="$schema" \
      -e NT_RUN_NONCE="$RUN_NONCE" \
      -e NT_PLAN="/out/plan-${cell}.json" \
      -e NT_OUT="/out/result-${schema}-${cell}.json" \
      -e NT_COOKIE_NAME="$CANARY_COOKIE_NAME" \
      -e NT_COOKIE_VALUE="$COOKIE_VALUE" \
      "$NODE_IMAGE" node /canary/drive.mjs >/dev/null

    # THE IMAGE'S OWN STDOUT. Round 7: a literal scan of driver/ and tests/ for
    # the string "applog" found exactly one hit — this line, the one that WRITES
    # it — while canary-<gen>, pglog-hits-, sink-<gen> and tombstone- all
    # resolved to real readers, so "collected and never read" was an answer the
    # scan could distinguish from "not found". MEASURED: two lines appended to
    # one cell's applog, one recording a 200 OK from paper-api.alpaca.markets
    # and one a successful vault_create_secret rpc, certified rc=0 PASS.
    # verdict.mjs now requires one of these per driven cell, refuses an applog
    # no cell result claims, and refuses any line naming a pinned broker host or
    # an instrumented wrapper; the counts are published in
    # verdict-scope.json controlEvidence.perSchema.<gen>.applogScan. It is a
    # keyword tripwire over free text, not a containment claim — see the
    # `run-controls` scope statement.
    docker logs "$APP_C" > "$OUT/instr/${schema}-${cell}.applog" 2>&1 || true
    docker rm -f "$APP_C" >/dev/null 2>&1 || true

    commitments "after-${schema}-${cell}" || return "$EXIT_HARNESS"
    # Only the DATABASE's commitments must hold still. The sensor's own reading
    # (NT_CANARY_*) is deliberately moved by the interleaved challenges, so it
    # is compared by the sensor runner's accounting rather than by this diff.
    grep '^NT_COMMIT_' "$prev_commit" > "$OUT/sql/db-prev.txt" || true
    grep '^NT_COMMIT_' "$OUT/sql/commit-after-${schema}-${cell}.txt" > "$OUT/sql/db-now.txt" || true
    if ! diff -q "$OUT/sql/db-prev.txt" "$OUT/sql/db-now.txt" >/dev/null; then
      printf '   %-46s \033[1;31mCOMMITMENTS MOVED\033[0m\n' "$cell"
      diff "$OUT/sql/db-prev.txt" "$OUT/sql/db-now.txt" \
        | sed 's/^/        /' >> "$OUT/commit-deltas-${schema}.txt" || true
    else
      printf '   %-46s commitments unchanged\n' "$cell"
    fi
    prev_commit="$OUT/sql/commit-after-${schema}-${cell}.txt"

    if [[ -n "${CHALLENGE_AT[$cell_index]:-}" ]]; then
      mid_round=$(( mid_round + 1 ))
      set +e
      "$SENSOR" challenge --pg "$PG_C" --state "$SENSOR_STATE" \
        --phase mid --round "$mid_round" >> "$OUT/sensor-mid-${schema}.txt" 2>&1
      local mid_rc=$?
      set -e
      if [[ "$mid_rc" -ne 0 ]]; then
        fail "the sensor failed its interleaved challenge after cell ${cell} (round ${mid_round})"
        sed 's/^/       /' "$OUT/sensor-mid-${schema}.txt" >&2
        return "$EXIT_CONTROL"
      fi
      printf '   %-46s \033[1;32msensor challenged mid-matrix (round %s)\033[0m\n' "" "$mid_round"
    fi
  done

  # Guarantee at least one interleaved round even if the schedule collided.
  if [[ "$mid_round" -eq 0 ]]; then
    mid_round=1
    set +e
    "$SENSOR" challenge --pg "$PG_C" --state "$SENSOR_STATE" \
      --phase mid --round 1 >> "$OUT/sensor-mid-${schema}.txt" 2>&1
    local mid_rc=$?
    set -e
    [[ "$mid_rc" -eq 0 ]] || { fail "the interleaved sensor challenge failed"; return "$EXIT_CONTROL"; }
  fi

  # --- the sensor, after the matrix -----------------------------------------
  log "10z.${schema} POST-MATRIX sensor challenge and report"
  set +e
  "$SENSOR" challenge --pg "$PG_C" --state "$SENSOR_STATE" --phase post --round 0 \
    > "$OUT/sensor-post-${schema}.txt" 2>&1
  local post_rc=$?
  set -e
  sed 's/^/   /' "$OUT/sensor-post-${schema}.txt"
  if [[ "$post_rc" -ne 0 ]]; then
    fail "the sensor failed its post-matrix challenge; the run's zeroes are not evidence"
    return "$EXIT_CONTROL"
  fi

  local extra_hits=$(( ${EXTRA_HITS_PER_WRAPPER:-0} ))
  local hits_policy=zero
  [[ "$MODE" == "mutant" ]] && hits_policy=any
  set +e
  "$SENSOR" report --pg "$PG_C" --state "$SENSOR_STATE" \
    --extra-hits "$hits_policy" --expected-extra-hits "$extra_hits" \
    > "$OUT/sensor-report-${schema}.txt" 2>&1
  local rep_rc=$?
  set -e
  sed 's/^/   /' "$OUT/sensor-report-${schema}.txt"
  if [[ "$rep_rc" -ne 0 ]]; then
    fail "the trusted sensor runner reported the sensor UNTRUSTWORTHY"
    SENSOR_VERDICTS+=("${schema}=UNTRUSTWORTHY")
    return "$EXIT_CONTROL"
  fi
  SENSOR_VERDICTS+=("${schema}=TRUSTWORTHY")
  # The baseline commitment is taken after `arm` and after the fidelity probe,
  # so the challenge hits this run caused AFTER it are the interleaved rounds
  # plus the single post-matrix round, one per wrapper.
  SENSOR_HITS+=("${schema}=$(( (mid_round + 1) * 3 ))")

  # --- what the sensor saw --------------------------------------------------
  log "11.${schema} the canary's reading"
  copy_and_run "${HERE}/sql/40_canary_dump.sql" "canary-dump-${schema}" \
    || { fail "the canary dump failed — the sensor may have been removed mid-run"; return "$EXIT_CONTROL"; }
  if ! grep -E 'NT_CANARY_' "$OUT/sql/canary-dump-${schema}.out" > "$OUT/canary-${schema}.txt"; then
    fail "the canary dump produced no readings"; return "$EXIT_CONTROL"
  fi
  sed 's/^/   /' "$OUT/canary-${schema}.txt"

  # The server log is the second, independent, non-transactional channel.
  # Anchored on the log line PostgreSQL actually emits. A bare substring match
  # also catches the STATEMENT echo of the function source, which contains the
  # marker text and is not a hit — that discrepancy is what the counter/log
  # cross-check below caught the first time this ran.
  set +e
  docker logs "$PG_C" 2>&1 | grep -E 'LOG: +NT_CANARY_HIT fn=' > "$OUT/pglog-hits-${schema}.txt"
  set -e
  info "server-log hit lines: $(wc -l < "$OUT/pglog-hits-${schema}.txt")"

  docker rm -f "$SINK_C" >/dev/null 2>&1 || true
  return 0
}

for s in "${SCHEMAS[@]}"; do
  set +e
  run_schema "$s"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then exit "$rc"; fi
done

# ---------------------------------------------------------------------------
# 12. verdict
# ---------------------------------------------------------------------------
log "12. verdict"

verdict_args=(
  --out "$OUT"
  --mode "$MODE"
  --break-sensor "$BREAK_SENSOR"
  --schemas "$(IFS=,; echo "${SCHEMAS[*]}")"
  --manifest "$REQUEST_MANIFEST"
  --cells-run "$CELL_RUN"
  --cells-total "$CELL_TOTAL"
  --probe-user-id "$CANARY_PROBE_USER_ID"
  --target-dirty "$TARGET_DIRTY"
)
if [[ "$PG_IMAGE" != "$PG_IMAGE_DEFAULT" ]]; then
  verdict_args+=(--pg-image-substituted "$PG_IMAGE")
fi
for v in "${SENSOR_VERDICTS[@]}"; do verdict_args+=(--sensor-verdict "$v"); done
for v in "${SENSOR_HITS[@]}"; do verdict_args+=(--sensor-hits "$v"); done
set +e
node "${HERE}/driver/verdict.mjs" "${verdict_args[@]}"
VRC=$?
set -e

# `[[ -f x ]] && y=...` as a statement is an AND-list whose status is the test's
# when the test fails — which under errexit exits the script, at the very last
# step, with a bare 1. Written as an `if` so the absent case is a value, not an
# exit.
CLASSIFIER_DIGEST_END="$(compute_classifier_digest "$CLASSIFIER_ROOT")"
if [[ "$CLASSIFIER_DIGEST_END" != "$CLASSIFIER_DIGEST" ]]; then
  # Both generations used the SNAPSHOT, so this does not invalidate the run —
  # it says the working tree moved on while the run was going, and which bytes
  # the run actually used. That distinction is the point of snapshotting.
  printf '\033[1;33m note\033[0m the live classifier toolchain changed during this run:\n'
  printf '        at start: %s\n' "$CLASSIFIER_DIGEST"
  printf '        at end  : %s\n' "$CLASSIFIER_DIGEST_END"
  printf '        this run used the snapshot in %s (digest %s), which is preserved beside the result.\n' \
    "$CLASSIFIER_SNAPSHOT" "$CLASSIFIER_SNAPSHOT_DIGEST"
fi

printf '\nrun provenance\n'
printf '  trusted checkout : %s @ %s\n' "$TRUSTED_ROOT" "$TRUSTED_SHA"
printf '  classifier       : %s (snapshotted into %s and read from there)\n' \
  "$CLASSIFIER_DIGEST" "$(basename "$CLASSIFIER_SNAPSHOT")"
printf '  target  checkout : %s @ %s\n' "$TARGET_ROOT" "$TARGET_SHA"
printf '  trusted digest   : %s\n' "$TRUSTED_DIGEST"
printf '  run nonce        : %s (stamped into every cell result)\n' "$RUN_NONCE"
printf '  image under test : %s (%s)\n' "$IMAGE" "$app_image_id"
printf '  image revision   : %s (label, matched against --target-sha)\n' "$app_image_rev"
printf '  image source     : %s (label, recomputed over --source)\n' "$img_src_digest"
printf '  --source tree    : %s (%s files)\n' "$SOURCE_DIGEST" "$SOURCE_FILES"
printf '  commit tree      : %s (git archive %s dashboard)\n' "$COMMIT_TREE_DIGEST" "${TARGET_SHA:0:12}"
printf '  target worktree  : %s modified path(s) (see target-worktree-status.txt)\n' "$TARGET_DIRTY"
printf '  postgres image   : %s%s\n' "$PG_IMAGE" \
  "$( [[ "$PG_IMAGE" == "$PG_IMAGE_DEFAULT" ]] && echo '  (the pinned production digest)' || echo '  (SUBSTITUTED, not the pinned digest)')"
printf '  cells driven     : %s of %s\n' "$CELL_RUN" "$CELL_TOTAL"
printf '  schemas driven   : %s\n' "$(IFS=,; echo "${SCHEMAS[*]}")"
printf '  sensor verdicts  : %s\n' "$(IFS=' '; echo "${SENSOR_VERDICTS[*]}")"
printf '\nartefacts: %s\n' "$OUT"
exit "$VRC"
