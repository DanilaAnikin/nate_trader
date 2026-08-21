#!/usr/bin/env bash
# ============================================================================
# catalogue-classify.sh — run the catalogue classifier against a disposable
# clone of one schema generation.
#
# WHAT IT DOES
# ------------
#   1. derives the refusal-shim ("tombstone") contract FROM THE WHOLE
#      supabase/migrations set — never from a copy kept in this directory, and
#      never from one section of one file. extract-tombstone-template.py scans
#      both mechanisms that produce a shim (an inline `create or replace
#      function` whose whole body is a `raise`, and migration 0022's format()
#      loop) across every migration, and refuses to emit a result unless BOTH
#      arms are non-empty and the union spans at least two files;
#   2. computes a digest over the EXACT set of inputs the base image is built
#      from — every migration file that will be applied, byte for byte, plus
#      the bootstrap and both fixture files — and keys the cached base image on
#      it. A migration added, edited or removed changes the digest, so the
#      cache misses and the image is rebuilt. There is no way to run against a
#      base image that does not correspond to the migrations on disk;
#   3. starts a FRESH container from that base image for every run, so a
#      mutation can never leak into the next run;
#   4. optionally applies a mutation SQL file;
#   5. runs catalogue-classify.sql and reports.
#
# WHAT IT NEVER DOES
# ------------------
#   * touch a natetrader-* container, Traefik, a broker, or any workflow;
#   * write to supabase/migrations — the migration directory is read-only here
#     and is copied into a throwaway container;
#   * accept a real credential. Every value the probes write is the literal
#     string CC-PROBE-NOT-A-CREDENTIAL.
#
# Usage:
#   catalogue-classify.sh --generation 0008|latest [options]
#
#     --mutate FILE        SQL applied (as supabase_admin) after the clone is
#                          up and before classification
#     --mutate-label TEXT  recorded in the JSON report
#     --probe-mode MODE    normal | skip | break   (test seam; anything other
#                          than normal can never produce PASS)
#     --classifier FILE    classifier SQL to run (default catalogue-classify.sql).
#                          Exists so the mutation suite can demonstrate that a
#                          weaker classifier turns the suite red.
#     --json FILE          write the JSON report here
#     --out FILE           write the full psql transcript here
#     --keep               leave the clone container running
#     --rebuild-base       rebuild the base image for this generation
#     --print-base-digest  print the base-input digest and exit
#     --quiet              suppress the transcript on stdout
#
# Exit codes:
#   0  PASS          every object classified exactly as expected
#   1  FAIL          at least one blocker, or a non-normal probe mode
#   2  harness error (docker, image, migration, seed, parse, stale cache)
#   3  control failure — the classifier could not be trusted this run
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

# The exact production image, addressed BY DIGEST. The tag is recorded for
# humans only; nothing here ever resolves it.
readonly IMAGE_DIGEST="supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00"
readonly IMAGE_TAG_FYI="supabase/postgres:17.6.1.136"

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO="$(cd "${HERE}/../.." && pwd)"
readonly MIGRATIONS="${REPO}/supabase/migrations"
readonly SQLDIR="${HERE}/sql"
readonly TOMB_MIGRATION="${MIGRATIONS}/0022_fingerprint_binding_and_token_generations.sql"

# The bootstrap and the first fixture are the schema-compat harness's own
# files. They live on the bridge branch, which is not always checked out, so a
# copy is vendored here AND checked against the branch whenever the branch is
# present. 20_seed_probe_accounts.sql is this directory's own and has no
# upstream.
readonly UPSTREAM_REF="bridge/pre-migration-containment"
readonly UPSTREAM_DIR="dashboard/test/schema-compat/sql"
readonly VENDORED_FILES=(00_env_bootstrap.sql 10_seed.sql)
readonly LOCAL_FIXTURES=(20_seed_probe_accounts.sql)

# Where the base image records the digest of the inputs it was built from. A
# clone that cannot show this file, or shows a different one, is not usable.
readonly STAMP_PATH="/nt-catalogue-classify-base.inputs.sha256"
readonly STAMP_LABEL="nt.catalogue-classify.base-inputs-sha256"

readonly EXIT_FAIL=1
readonly EXIT_HARNESS=2
readonly EXIT_CONTROL=3

GENERATION=""
MUTATE=""
MUTATE_LABEL=""
PROBE_MODE="normal"
CLASSIFIER="${HERE}/catalogue-classify.sql"
JSON_OUT=""
TRANSCRIPT_OUT=""
KEEP=0
REBUILD_BASE=0
QUIET=0
PRINT_DIGEST=0

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --generation)   GENERATION="${2:?--generation needs a value}"; shift 2 ;;
    --mutate)       MUTATE="${2:?--mutate needs a path}"; shift 2 ;;
    --mutate-label) MUTATE_LABEL="${2-}"; shift 2 ;;
    --probe-mode)   PROBE_MODE="${2:?--probe-mode needs a value}"; shift 2 ;;
    --classifier)   CLASSIFIER="${2:?--classifier needs a path}"; shift 2 ;;
    --json)         JSON_OUT="${2:?--json needs a path}"; shift 2 ;;
    --out)          TRANSCRIPT_OUT="${2:?--out needs a path}"; shift 2 ;;
    --keep)         KEEP=1; shift ;;
    --rebuild-base) REBUILD_BASE=1; shift ;;
    --print-base-digest) PRINT_DIGEST=1; QUIET=1; shift ;;
    --quiet)        QUIET=1; shift ;;
    --check-counter-scan-declaration)
                    CHECK_DECL_FILE="${2:?--check-counter-scan-declaration needs a path}"; shift 2 ;;
    --check-is-default-classifier)
                    CHECK_DECL_DEFAULT="${2:?needs yes|no}"; shift 2 ;;
    -h|--help)      sed -n '2,60p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) fail "unknown argument: $1"; exit "$EXIT_HARNESS" ;;
  esac
done

# ---------------------------------------------------------------------------
# THE COUNTER-SCAN DECLARATION CONTRACT
#
# The driver used to require `schema_scan.kinds` to have >= 2 entries from
# EVERY classifier it ran, so that "no findings printed" could never mean "this
# build has no counter-scan". That rule is right for the shipped classifier and
# wrong for `tests/naive-oracle.sql`, the name-only straw man that models the
# OLD harness and performs no counter-scan on purpose: every straw-man cell,
# both pristine runs included, exited 2. The mutation suite correctly refuses to
# score a driver refusal as "the straw man is blind to this mutant", so the
# load-bearing "the strong classifier buys something" demonstration could not
# run at all.
#
# The resolution is NOT to let the straw man emit an empty scan — an absent
# counter-scan reading as a clean counter-scan is the exact failure the rule
# exists to prevent. It is to make the classifier SAY which it is, and to give
# the two answers different consequences:
#
#   counter_scan_declared absent  -> harness error. A classifier that does not
#                                    say is refused; a build that silently drops
#                                    the whole schema_scan block lands here.
#   counter_scan_declared = true  -> schema_scan.kinds must hold >= 2 entries.
#                                    Claimed one and produced nothing is still a
#                                    harness error.
#   counter_scan_declared = false -> the run is explicitly NOT A CERTIFICATION.
#                                    It runs, it prints verdicts, and its PASS is
#                                    labelled. Permitted ONLY for a classifier
#                                    supplied with --classifier; the shipped
#                                    default may never declare itself
#                                    non-certifying.
#
# `--check-counter-scan-declaration FILE` runs exactly this decision over a JSON
# file and exits with the code the real run would use. It is a test seam and it
# cannot make a real run pass: it exits before anything is classified.
# ---------------------------------------------------------------------------
CLASSIFIER_IS_DEFAULT=no
[[ "$CLASSIFIER" == "${HERE}/catalogue-classify.sql" ]] && CLASSIFIER_IS_DEFAULT=yes

# Prints one of: CERTIFYING | NON_CERTIFYING | UNDECLARED | CLAIMED_BUT_EMPTY:<n>
# | UNPARSEABLE, reading the JSON document on stdin.
counter_scan_declaration() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("UNPARSEABLE"); sys.exit(0)
if not isinstance(d, dict):
    print("UNPARSEABLE"); sys.exit(0)
if "counter_scan_declared" not in d:
    print("UNDECLARED"); sys.exit(0)
decl = d["counter_scan_declared"]
if decl is False:
    print("NON_CERTIFYING"); sys.exit(0)
if decl is not True:
    print("UNDECLARED"); sys.exit(0)
kinds = (d.get("schema_scan") or {}).get("kinds") or []
if len(kinds) < 2:
    print("CLAIMED_BUT_EMPTY:%d" % len(kinds)); sys.exit(0)
print("CERTIFYING")
' 2>/dev/null || printf 'UNPARSEABLE\n'
}

# Applies the consequences. Sets NON_CERTIFYING_RUN=1 when the classifier has
# declared itself out of the gate; exits otherwise on every bad answer.
enforce_counter_scan_declaration() {  # decision, is-default(yes|no)
  local decision="$1" is_default="$2"
  case "$decision" in
    CERTIFYING) NON_CERTIFYING_RUN=0 ;;
    NON_CERTIFYING)
      if [[ "$is_default" == yes ]]; then
        fail "the shipped classifier declares counter_scan_declared=false"
        fail "  The default classifier may not declare itself out of the gate. If its"
        fail "  whole-schema counter-scan has genuinely been removed, that is the finding."
        exit "$EXIT_HARNESS"
      fi
      NON_CERTIFYING_RUN=1 ;;
    UNDECLARED)
      fail "the classifier does not declare whether it performs a whole-schema counter-scan"
      fail "  Every classifier must publish counter_scan_declared: true or false."
      fail "  Silence is refused: a build that dropped its schema_scan block would"
      fail "  otherwise read exactly like one that never had a counter-scan."
      exit "$EXIT_HARNESS" ;;
    CLAIMED_BUT_EMPTY:*)
      fail "the classifier declares a whole-schema counter-scan and reported ${decision#*:} scan kind(s); 2 are required"
      fail "  an absent counter-scan must never read as a clean counter-scan"
      exit "$EXIT_HARNESS" ;;
    *)
      fail "the classifier emitted no parseable schema_scan declaration"
      exit "$EXIT_HARNESS" ;;
  esac
}

if [[ -n "${CHECK_DECL_FILE:-}" ]]; then
  d="$(counter_scan_declaration < "$CHECK_DECL_FILE")"
  printf 'decision: %s\n' "$d"
  enforce_counter_scan_declaration "$d" "${CHECK_DECL_DEFAULT:-no}"
  printf 'non_certifying_run: %s\n' "${NON_CERTIFYING_RUN}"
  exit 0
fi

case "$GENERATION" in
  0008|latest) ;;
  *) fail "--generation must be 0008 or latest (got '${GENERATION}')"; exit "$EXIT_HARNESS" ;;
esac
case "$PROBE_MODE" in
  normal|skip|break) ;;
  *) fail "--probe-mode must be normal, skip or break (got '${PROBE_MODE}')"; exit "$EXIT_HARNESS" ;;
esac

readonly RUN_NAME="nt-catclassify-run-${GENERATION}-$$"
readonly BUILD_NAME="nt-catclassify-build-${GENERATION}-$$"

WORK="$(mktemp -d)"
cleanup() {
  local rc=$?
  if [[ "$KEEP" -eq 1 ]]; then
    printf '\n--keep: clone left running: %s   work dir: %s\n' "$RUN_NAME" "$WORK"
  else
    docker rm -f "$RUN_NAME" "$BUILD_NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 0. preflight
# ---------------------------------------------------------------------------
command -v docker   >/dev/null 2>&1 || { fail "docker is not on PATH";   exit "$EXIT_HARNESS"; }
command -v python3  >/dev/null 2>&1 || { fail "python3 is not on PATH";  exit "$EXIT_HARNESS"; }
command -v sha256sum >/dev/null 2>&1 || { fail "sha256sum is not on PATH"; exit "$EXIT_HARNESS"; }

FIXTURE_FILES=("${VENDORED_FILES[@]}" "${LOCAL_FIXTURES[@]}")
for f in "$CLASSIFIER" "$TOMB_MIGRATION"; do
  [[ -f "$f" ]] || { fail "missing required file: $f"; exit "$EXIT_HARNESS"; }
done
for f in "${FIXTURE_FILES[@]}"; do
  [[ -f "$SQLDIR/$f" ]] || { fail "missing required file: $SQLDIR/$f"; exit "$EXIT_HARNESS"; }
done
[[ -d "$MIGRATIONS" ]] || { fail "missing migrations directory: $MIGRATIONS"; exit "$EXIT_HARNESS"; }
if [[ -n "$MUTATE" && ! -f "$MUTATE" ]]; then
  fail "mutation file does not exist: $MUTATE"; exit "$EXIT_HARNESS"
fi

# The vendored harness files must not have drifted from the harness they came
# from. If the branch is fetched, compare; if it is not, say so rather than
# pretending the comparison happened.
BOOTSTRAP_PROVENANCE="vendored copy only (${UPSTREAM_REF} not present locally)"
if git -C "$REPO" rev-parse --verify --quiet "${UPSTREAM_REF}^{commit}" >/dev/null; then
  drift=0
  for f in "${VENDORED_FILES[@]}"; do
    if ! git -C "$REPO" show "${UPSTREAM_REF}:${UPSTREAM_DIR}/${f}" > "$WORK/upstream.$f" 2>/dev/null; then
      fail "cannot read ${UPSTREAM_REF}:${UPSTREAM_DIR}/${f}"; exit "$EXIT_HARNESS"
    fi
    if ! cmp -s "$WORK/upstream.$f" "$SQLDIR/$f"; then
      fail "vendored $f has drifted from ${UPSTREAM_REF}:${UPSTREAM_DIR}/${f}"
      diff -u "$WORK/upstream.$f" "$SQLDIR/$f" >&2 || true
      drift=1
    fi
  done
  [[ "$drift" -eq 0 ]] || exit "$EXIT_HARNESS"
  BOOTSTRAP_PROVENANCE="byte-identical to ${UPSTREAM_REF}:${UPSTREAM_DIR}"
fi

# ---------------------------------------------------------------------------
# 0b. the migration set, and the digest the base image is keyed on
#
# This is computed BEFORE the cache is consulted, because it is what decides
# which cache entry is even eligible. Keying the cache on the generation NAME
# alone made a genuine regression added to supabase/migrations invisible: the
# name did not change, the cached image was reused, and the driver reported
# PASS over a database that had never seen the new migration.
#
# The digest is only worth what the input LIST is worth, so selection uses the
# same glob as every other applier. supabase/tests/run_integration.sh,
# run_postgrest.sh, run_concurrency.sh and run_vault_integrity.sh all apply
# "$MIGRATIONS"/*.sql. This function used to select with
# `find -name '[0-9][0-9][0-9][0-9]_*.sql'`, a NARROWER set: a migration named
# the way `supabase migration new` names them — a 14-digit timestamp prefix —
# matched the appliers' glob and not this one, so it was excluded from the
# applied set AND from the digest. The digest was unchanged, the cached base
# image was reused, and the classifier returned PASS over a schema the
# migration had never touched. Same failure, different key.
#
# So: the appliers' glob, then REFUSE anything that does not fit the ordering
# this driver relies on. A file that cannot be placed in the sequence is a
# harness error, never a silent omission.
# ---------------------------------------------------------------------------
select_migration_set() {   # -> MIGRATION_SET (array of basenames)
  local m base
  local -a candidates=() rejected=()
  # Same glob as the appliers. nullglob so a genuinely empty directory yields
  # an empty array rather than the literal pattern.
  local restore_nullglob=0
  shopt -q nullglob || restore_nullglob=1
  shopt -s nullglob
  for m in "$MIGRATIONS"/*.sql; do
    candidates+=("${m##*/}")
  done
  [[ "$restore_nullglob" -eq 0 ]] || shopt -u nullglob

  if [[ "${#candidates[@]}" -eq 0 ]]; then
    fail "no migrations found in $MIGRATIONS"; exit "$EXIT_HARNESS"
  fi

  # Every file the appliers would apply must be one this driver can order.
  # Anything else is named loudly and stops the run.
  for base in "${candidates[@]}"; do
    if [[ ! "$base" =~ ^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$ ]]; then
      rejected+=("$base")
    fi
  done
  if [[ "${#rejected[@]}" -gt 0 ]]; then
    fail "migration file(s) the appliers would apply but this driver cannot order:"
    printf '       %s\n' "${rejected[@]}" >&2
    fail "every file in $MIGRATIONS must be NNNN_name.sql (four digits, contiguous)."
    fail "refusing to classify against a migration set that silently omits a file"
    exit "$EXIT_HARNESS"
  fi

  MIGRATION_SET=()
  while IFS= read -r base; do
    if [[ "$GENERATION" == "0008" && "${base:0:4}" > "0008" ]]; then continue; fi
    MIGRATION_SET+=("$base")
  done < <(printf '%s\n' "${candidates[@]}" | LC_ALL=C sort)

  if [[ "${#MIGRATION_SET[@]}" -eq 0 ]]; then
    fail "no migrations selected for generation $GENERATION"; exit "$EXIT_HARNESS"
  fi
  # contiguity: a gap would quietly shrink the generation under test
  local n=1 want
  for base in "${MIGRATION_SET[@]}"; do
    want="$(printf '%04d' "$n")"
    if [[ "${base:0:4}" != "$want" ]]; then
      fail "migration sequence is not contiguous: expected ${want}_*, found ${base}"
      exit "$EXIT_HARNESS"
    fi
    n=$(( n + 1 ))
  done
  if [[ "$GENERATION" == "0008" && "${#MIGRATION_SET[@]}" -ne 8 ]]; then
    fail "the 0008 generation must be exactly 8 migrations, found ${#MIGRATION_SET[@]}"
    exit "$EXIT_HARNESS"
  fi
}

MIGRATION_SET=()
select_migration_set

# The manifest is the audit trail behind the digest: it names every input by
# path and content hash, in a fixed order, so a digest mismatch can always be
# explained by diffing two manifests.
{
  printf 'catalogue-classify base manifest v1\n'
  printf 'generation\t%s\n' "$GENERATION"
  printf 'image\t%s\n' "$IMAGE_DIGEST"
  printf 'migration-count\t%s\n' "${#MIGRATION_SET[@]}"
  for base in "${MIGRATION_SET[@]}"; do
    printf 'migration\t%s\t%s\n' "$base" \
      "$(sha256sum "$MIGRATIONS/$base" | cut -d' ' -f1)"
  done
  for f in "${FIXTURE_FILES[@]}"; do
    printf 'fixture\t%s\t%s\n' "$f" "$(sha256sum "$SQLDIR/$f" | cut -d' ' -f1)"
  done
} > "$WORK/base-manifest.txt"

BASE_INPUTS_SHA256="$(sha256sum "$WORK/base-manifest.txt" | cut -d' ' -f1)"
if [[ ! "$BASE_INPUTS_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  fail "the base-input digest is not a sha256: '${BASE_INPUTS_SHA256}'"
  exit "$EXIT_HARNESS"
fi
# A manifest that listed nothing would hash just as happily as a real one.
if [[ "$(grep -c $'^migration\t' "$WORK/base-manifest.txt")" -lt 8 ]]; then
  fail "the base manifest lists fewer than 8 migrations; it is not describing a real generation"
  cat "$WORK/base-manifest.txt" >&2
  exit "$EXIT_HARNESS"
fi
if [[ "$(grep -c $'^fixture\t' "$WORK/base-manifest.txt")" -ne "${#FIXTURE_FILES[@]}" ]]; then
  fail "the base manifest does not list every fixture file"
  cat "$WORK/base-manifest.txt" >&2
  exit "$EXIT_HARNESS"
fi

readonly BASE_REPO="nt-catalogue-classify-base"
readonly BASE_IMAGE="${BASE_REPO}:g${GENERATION}-${BASE_INPUTS_SHA256:0:16}"

if [[ "$PRINT_DIGEST" -eq 1 ]]; then
  printf '%s\n' "$BASE_INPUTS_SHA256"
  exit 0
fi

# Pull by digest if absent. Never by tag: the tag is mutable, the digest is not.
if ! IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_DIGEST" 2>/dev/null)"; then
  info "image absent locally; pulling by digest"
  docker pull "$IMAGE_DIGEST" >/dev/null || { fail "pull by digest failed"; exit "$EXIT_HARNESS"; }
  IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE_DIGEST")"
fi

log "0. preflight"
info "image (digest)     : $IMAGE_DIGEST"
info "image (tag, fyi)   : $IMAGE_TAG_FYI"
info "image id           : $IMAGE_ID"
info "generation         : $GENERATION"
info "migrations applied : ${#MIGRATION_SET[@]} (${MIGRATION_SET[0]} .. ${MIGRATION_SET[-1]})"
info "base inputs sha256 : $BASE_INPUTS_SHA256"
info "base image tag     : $BASE_IMAGE"
info "classifier         : $CLASSIFIER"
info "probe mode         : $PROBE_MODE"
info "mutation           : ${MUTATE:-<none>}${MUTATE_LABEL:+  ($MUTATE_LABEL)}"
info "bootstrap/fixture  : $BOOTSTRAP_PROVENANCE"

# ---------------------------------------------------------------------------
# 1. the refusal-shim contract, derived from the WHOLE migration set
#
# Round 2 derived this from migration 0022 SECTION 5 alone. Section 5 is one
# mechanism, not the definition of a tombstone: 0022 also tombstones
# resolve_create_operation(uuid,uuid) inline with a different message, and 0017
# does the same to reconcile_cash_flow_mirror and replace_equity_snapshots.
# None of the three was derived, so none carried an expectation row, so
# granting EXECUTE on one of them to anon produced PASS. The extractor now
# scans every migration for BOTH mechanisms and refuses a single-arm or
# single-file result.
# ---------------------------------------------------------------------------
log "1. deriving the refusal-shim contract from all of $(basename "$MIGRATIONS")/"
if ! python3 "$HERE/extract-tombstone-template.py" "$MIGRATIONS" > "$WORK/tomb.env"; then
  fail "could not derive the refusal-shim contract from the migration set"
  exit "$EXIT_HARNESS"
fi
# shellcheck disable=SC1090
source "$WORK/tomb.env"
for v in NT_CC_TOMB_NAMES NT_CC_TOMB_TEMPLATE_NAMES NT_CC_TOMB_POSTCOND_NAMES \
         NT_CC_TOMB_NAMES_BY_SOURCE NT_CC_TOMB_MECHANISMS NT_CC_TOMB_SOURCES \
         NT_CC_TOMB_TARGETS_JSON NT_CC_TOMB_ACL_BY_TARGET NT_CC_TOMB_SIGS \
         NT_CC_LIVE_BODY_0008_JSON NT_CC_LIVE_BODY_LATEST_JSON \
         NT_CC_TOMB_LANG NT_CC_TOMB_SEARCHPATH NT_CC_TOMB_SECDEF \
         NT_CC_TOMB_VOLATILITY NT_CC_TOMB_ERRCODE NT_CC_TOMB_MSG_TEMPLATE \
         NT_CC_TOMB_BODY_TEMPLATE NT_CC_TOMB_BODY_SHAPE NT_CC_TOMB_REVOKE_ROLES; do
  if [[ -z "${!v-}" ]]; then fail "extractor produced an empty $v"; exit "$EXIT_HARNESS"; fi
done

# The live-body map is generation specific: the last live definition of
# vault_delete_secret on the 0001-0008 chain is 0008's, on the full chain it is
# migration 0020's FK-aware rewrite. Picking the wrong one would make the
# classifier's cross-check compare a pin against the wrong migration.
case "$GENERATION" in
  0008)  NT_CC_LIVE_BODY_JSON="$NT_CC_LIVE_BODY_0008_JSON" ;;
  latest) NT_CC_LIVE_BODY_JSON="$NT_CC_LIVE_BODY_LATEST_JSON" ;;
  *) fail "no live-body map for generation ${GENERATION}"; exit "$EXIT_HARNESS" ;;
esac
# The JSON must parse and must be a non-empty array here, before psql sees it:
# a malformed blob would otherwise surface as an opaque classifier error.
if ! N_TARGETS="$(printf '%s' "$NT_CC_TOMB_TARGETS_JSON" | python3 -c \
      'import json,sys; t=json.load(sys.stdin); assert isinstance(t,list) and t; print(len(t))')"; then
  fail "the derived target set is not a non-empty JSON array"
  exit "$EXIT_HARNESS"
fi
info "derived from : $NT_CC_TOMB_MIGRATION_COUNT migration file(s); shims in $NT_CC_TOMB_SOURCES"
info "mechanisms   : $NT_CC_TOMB_MECHANISMS   (${N_TARGETS} target(s))"
info "names (union): $NT_CC_TOMB_NAMES"
info "by source    : $NT_CC_TOMB_NAMES_BY_SOURCE"
info "0022 loop    : $NT_CC_TOMB_TEMPLATE_NAMES"
info "0022 post-cond: $NT_CC_TOMB_POSTCOND_NAMES"
info "template     : lang=$NT_CC_TOMB_LANG security_definer=$NT_CC_TOMB_SECDEF volatility=$NT_CC_TOMB_VOLATILITY errcode=$NT_CC_TOMB_ERRCODE"
info "template msg : $NT_CC_TOMB_MSG_TEMPLATE"
info "template sha : $NT_CC_TOMB_BODY_SHA256"

# ---------------------------------------------------------------------------
# 2. plumbing shared by the base build and the run
# ---------------------------------------------------------------------------
readonly READY_STREAK=5
readonly READY_TIMEOUT_S=240

# Semantic readiness, never pg_isready: this image runs a temporary
# socket-only server during init and then restarts, so a socket probe can
# succeed against a database that is about to be reinitialised. Go over TCP,
# connect as supabase_admin, ask a question about the schema layout, and
# require five CONSECUTIVE correct answers.
db_ready_probe() {
  local name="$1" out
  out="$(docker exec "$name" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -X -tA \
        -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage')" \
        2>/dev/null)" || return 1
  [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "4" ]]
}

wait_ready() {
  local name="$1" streak=0 waited=0
  while (( waited < READY_TIMEOUT_S )); do
    if db_ready_probe "$name"; then
      streak=$(( streak + 1 ))
      if (( streak >= READY_STREAK )); then
        info "$name: ready (${streak} consecutive semantic queries, ${waited}s)"
        return 0
      fi
    else
      streak=0
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  fail "$name never reached ${READY_STREAK} consecutive successful queries in ${READY_TIMEOUT_S}s"
  docker logs --tail 60 "$name" >&2 || true
  return 1
}

# ---------------------------------------------------------------------------
# 3. the base image for this generation and this exact input set
# ---------------------------------------------------------------------------
build_base() {
  log "2. building base image $BASE_IMAGE (migrations + bootstrap + fixtures)"
  docker rm -f "$BUILD_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$BUILD_NAME" \
    -e POSTGRES_PASSWORD=catalogue-classify-throwaway \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$IMAGE_DIGEST" >/dev/null
  wait_ready "$BUILD_NAME" || exit "$EXIT_HARNESS"

  local running
  running="$(docker inspect --format '{{.Image}}' "$BUILD_NAME")"
  if [[ "$running" != "$IMAGE_ID" ]]; then
    fail "$BUILD_NAME runs image $running, not the digest-pinned $IMAGE_ID"
    exit "$EXIT_HARNESS"
  fi

  docker cp "$MIGRATIONS" "$BUILD_NAME:/mig" >/dev/null
  local f
  for f in "${FIXTURE_FILES[@]}"; do
    docker cp "$SQLDIR/$f" "$BUILD_NAME:/$f" >/dev/null
  done
  docker cp "$WORK/base-manifest.txt" "$BUILD_NAME:/nt-catalogue-classify-base.manifest.txt" >/dev/null
  printf '%s\n' "$BASE_INPUTS_SHA256" > "$WORK/stamp"
  docker cp "$WORK/stamp" "$BUILD_NAME:${STAMP_PATH}" >/dev/null

  # --- negative control: does ON_ERROR_STOP really stop, with the exact
  #     failure class? Not "some non-zero exit" — the stderr must name
  #     division by zero, or the migration applier below proves nothing.
  local cerr="$WORK/on-error-stop.err" crc=0
  set +e
  printf 'select 1;\nselect 1/0;\nselect 2;\n' \
    | docker exec -i "$BUILD_NAME" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - \
      >/dev/null 2>"$cerr"
  crc=$?
  set -e
  if [[ "$crc" -eq 0 ]]; then
    fail "control: a division-by-zero script exited 0 — ON_ERROR_STOP is not in effect"
    exit "$EXIT_CONTROL"
  fi
  if ! grep -F -q 'division by zero' "$cerr"; then
    fail "control: applier failed rc=$crc but not with the expected failure class"
    cat "$cerr" >&2
    exit "$EXIT_CONTROL"
  fi
  info "control ok: ON_ERROR_STOP aborts, stderr names the exact class (division by zero)"

  # --- storage bootstrap, as its real owner
  if ! docker exec -i "$BUILD_NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 \
        -f /00_env_bootstrap.sql > "$WORK/bootstrap.out" 2>&1; then
    fail "environment bootstrap failed"; sed 's/^/       /' "$WORK/bootstrap.out" >&2
    exit "$EXIT_HARNESS"
  fi
  local n_public
  n_public="$(docker exec "$BUILD_NAME" psql -U postgres -d postgres -X -tA -c \
    "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f')")"
  if [[ "$(printf '%s' "$n_public" | tr -d '[:space:]')" != "0" ]]; then
    fail "bootstrap left ${n_public} relations in public; it must touch only storage"
    exit "$EXIT_HARNESS"
  fi
  info "bootstrap applied; public schema still empty"

  # --- migrations: exactly the set the digest was computed over
  info "applying ${#MIGRATION_SET[@]} migrations (${MIGRATION_SET[0]} .. ${MIGRATION_SET[-1]})"
  local base
  for base in "${MIGRATION_SET[@]}"; do
    if ! docker exec -i "$BUILD_NAME" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 \
          -f "/mig/$base" > "$WORK/$base.out" 2> "$WORK/$base.err"; then
      fail "migration $base failed"; sed 's/^/       /' "$WORK/$base.err" >&2
      exit "$EXIT_HARNESS"
    fi
  done
  info "migrations applied"

  # --- fixtures
  for f in "${FIXTURE_FILES[@]}"; do
    case "$f" in 00_env_bootstrap.sql) continue ;; esac
    if ! docker exec -i "$BUILD_NAME" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 \
          -f "/$f" > "$WORK/$f.out" 2> "$WORK/$f.err"; then
      fail "fixture $f failed"; sed 's/^/       /' "$WORK/$f.err" >&2
      exit "$EXIT_HARNESS"
    fi
  done
  grep -F 'seed ok:' "$WORK/10_seed.sql.err" | sed 's/^/   /' || {
    fail "the fixture seed did not report success"; cat "$WORK/10_seed.sql.err" >&2
    exit "$EXIT_HARNESS"; }
  grep -F 'probe seed ok:' "$WORK/20_seed_probe_accounts.sql.err" | sed 's/^/   /' || {
    fail "the ownership-probe fixture did not report success"
    cat "$WORK/20_seed_probe_accounts.sql.err" >&2
    exit "$EXIT_HARNESS"; }

  # --- clean shutdown, then snapshot, labelled with the digest it was built for
  docker stop -t 60 "$BUILD_NAME" >/dev/null
  docker commit --change "LABEL ${STAMP_LABEL}=${BASE_INPUTS_SHA256}" \
    "$BUILD_NAME" "$BASE_IMAGE" >/dev/null
  docker rm -f "$BUILD_NAME" >/dev/null
  info "base image committed: $BASE_IMAGE"
}

if [[ "$REBUILD_BASE" -eq 1 ]]; then
  docker image rm -f "$BASE_IMAGE" >/dev/null 2>&1 || true
fi
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  build_base
else
  log "2. base image $BASE_IMAGE already present (use --rebuild-base to force)"
fi
BASE_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$BASE_IMAGE")"
info "base image id: $BASE_IMAGE_ID"

# The tag already carries the digest, so a changed migration set cannot hit
# this cache entry. The label is the second lock: an image hand-tagged into
# this slot, or committed by an older driver, is refused rather than trusted.
LABEL_DIGEST="$(docker image inspect --format "{{index .Config.Labels \"${STAMP_LABEL}\"}}" "$BASE_IMAGE")"
if [[ "$LABEL_DIGEST" != "$BASE_INPUTS_SHA256" ]]; then
  fail "base image $BASE_IMAGE is labelled '${LABEL_DIGEST:-<none>}' but this run's inputs hash to $BASE_INPUTS_SHA256"
  fail "refusing to classify against a base image that does not match supabase/migrations"
  exit "$EXIT_HARNESS"
fi

# Stale siblings are only disk, not a correctness risk — the tag they carry can
# never be selected again — but say so rather than let them pile up unexplained.
STALE="$(docker image ls --format '{{.Repository}}:{{.Tag}}' "$BASE_REPO" \
         | grep -E "^${BASE_REPO}:g${GENERATION}(-|$)" | grep -v -x "$BASE_IMAGE" || true)"
if [[ -n "$STALE" ]]; then
  info "note: superseded base image(s) for this generation still on disk:"
  printf '     %s\n' $STALE
fi

# ---------------------------------------------------------------------------
# 4. a fresh clone for this run
# ---------------------------------------------------------------------------
log "3. fresh clone from $BASE_IMAGE"
docker rm -f "$RUN_NAME" >/dev/null 2>&1 || true
docker run -d --name "$RUN_NAME" \
  -e POSTGRES_PASSWORD=catalogue-classify-throwaway \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$BASE_IMAGE" >/dev/null
wait_ready "$RUN_NAME" || exit "$EXIT_HARNESS"

running="$(docker inspect --format '{{.Image}}' "$RUN_NAME")"
if [[ "$running" != "$BASE_IMAGE_ID" ]]; then
  fail "$RUN_NAME runs image $running, not $BASE_IMAGE_ID"; exit "$EXIT_HARNESS"
fi

# Third lock, inside the running container: the filesystem the database sits on
# has to carry the same stamp. A missing stamp is a harness error, never a pass.
if ! CLONE_STAMP="$(docker exec "$RUN_NAME" cat "$STAMP_PATH" 2>/dev/null)"; then
  fail "the clone carries no ${STAMP_PATH}; it was not built by this driver"
  exit "$EXIT_HARNESS"
fi
CLONE_STAMP="$(printf '%s' "$CLONE_STAMP" | tr -d '[:space:]')"
if [[ "$CLONE_STAMP" != "$BASE_INPUTS_SHA256" ]]; then
  fail "the clone was built from inputs ${CLONE_STAMP}, this run's inputs hash to ${BASE_INPUTS_SHA256}"
  exit "$EXIT_HARNESS"
fi
info "clone input stamp verified: $CLONE_STAMP"

# Non-vacuity: the clone must actually carry the generation it claims.
n_pub="$(docker exec "$RUN_NAME" psql -U postgres -d postgres -X -tA -c \
  "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")"
n_pub="$(printf '%s' "$n_pub" | tr -d '[:space:]')"
if [[ "$n_pub" -lt 5 ]]; then
  fail "the clone has only ${n_pub} public routines; the migrations did not survive the snapshot"
  exit "$EXIT_CONTROL"
fi
info "clone carries ${n_pub} public routines"

# ---------------------------------------------------------------------------
# 5. mutation
# ---------------------------------------------------------------------------
if [[ -n "$MUTATE" ]]; then
  log "4. applying mutation: $(basename "$MUTATE")${MUTATE_LABEL:+  — $MUTATE_LABEL}"
  docker cp "$MUTATE" "$RUN_NAME:/mutate.sql" >/dev/null
  if ! docker exec -i "$RUN_NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 \
        -f /mutate.sql > "$WORK/mutate.out" 2> "$WORK/mutate.err"; then
    fail "the mutation itself failed to apply — the mutant proves nothing"
    sed 's/^/       /' "$WORK/mutate.err" >&2
    exit "$EXIT_HARNESS"
  fi
  sed 's/^/   /' "$WORK/mutate.err"
fi

# ---------------------------------------------------------------------------
# 6. classify
# ---------------------------------------------------------------------------
log "5. classification"
docker cp "$CLASSIFIER" "$RUN_NAME:/classify.sql" >/dev/null

TRANSCRIPT="$WORK/classify.txt"
set +e
docker exec -i "$RUN_NAME" psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 \
  -v generation="$GENERATION" \
  -v probe_mode="$PROBE_MODE" \
  -v tomb_names="$NT_CC_TOMB_NAMES" \
  -v tomb_postcond_names="$NT_CC_TOMB_POSTCOND_NAMES" \
  -v tomb_template_names="$NT_CC_TOMB_TEMPLATE_NAMES" \
  -v tomb_names_by_source="$NT_CC_TOMB_NAMES_BY_SOURCE" \
  -v tomb_mechanisms="$NT_CC_TOMB_MECHANISMS" \
  -v tomb_sources="$NT_CC_TOMB_SOURCES" \
  -v tomb_migration_count="$NT_CC_TOMB_MIGRATION_COUNT" \
  -v tomb_targets_json="$NT_CC_TOMB_TARGETS_JSON" \
  -v tomb_acl_by_target="$NT_CC_TOMB_ACL_BY_TARGET" \
  -v live_body_json="$NT_CC_LIVE_BODY_JSON" \
  -v tomb_lang="$NT_CC_TOMB_LANG" \
  -v tomb_searchpath="$NT_CC_TOMB_SEARCHPATH" \
  -v tomb_secdef="$NT_CC_TOMB_SECDEF" \
  -v tomb_volatility="$NT_CC_TOMB_VOLATILITY" \
  -v tomb_errcode="$NT_CC_TOMB_ERRCODE" \
  -v tomb_msg_template="$NT_CC_TOMB_MSG_TEMPLATE" \
  -v tomb_body_template="$NT_CC_TOMB_BODY_TEMPLATE" \
  -v tomb_body_shape="$NT_CC_TOMB_BODY_SHAPE" \
  -v tomb_revoke_roles="$NT_CC_TOMB_REVOKE_ROLES" \
  -v image_id="$IMAGE_ID" \
  -v base_inputs_sha256="$BASE_INPUTS_SHA256" \
  -v mutation_label="$MUTATE_LABEL" \
  -f /classify.sql > "$TRANSCRIPT" 2>&1
psql_rc=$?
set -e

[[ "$QUIET" -eq 1 ]] || sed 's/^/   /' "$TRANSCRIPT"
[[ -z "$TRANSCRIPT_OUT" ]] || cp "$TRANSCRIPT" "$TRANSCRIPT_OUT"

if [[ "$psql_rc" -ne 0 ]]; then
  fail "the classifier did not run to completion (psql rc=$psql_rc)"
  exit "$EXIT_HARNESS"
fi

# ---------------------------------------------------------------------------
# 7. parse — a missing sentinel is a harness error, never a pass
# ---------------------------------------------------------------------------
if ! RESULT_LINE="$(grep -m1 -F 'CATALOGUE_CLASSIFY_RESULT=' "$TRANSCRIPT")"; then
  fail "the classifier emitted no CATALOGUE_CLASSIFY_RESULT line"
  exit "$EXIT_HARNESS"
fi
RESULT="${RESULT_LINE#*=}"

if ! JSON_LINE="$(grep -m1 -F 'CATALOGUE_CLASSIFY_JSON=' "$TRANSCRIPT")"; then
  fail "the classifier emitted no CATALOGUE_CLASSIFY_JSON line"
  exit "$EXIT_HARNESS"
fi
if [[ -n "$JSON_OUT" ]]; then
  printf '%s\n' "${JSON_LINE#*=}" | python3 -m json.tool > "$JSON_OUT" || {
    fail "the classifier emitted malformed JSON"; exit "$EXIT_HARNESS"; }
fi

OBJECT_LINES="$(grep -F 'CATALOGUE_CLASSIFY_OBJECT=' "$TRANSCRIPT" || true)"
if [[ -z "$OBJECT_LINES" ]]; then
  fail "the classifier classified zero objects; that is not a pass"
  exit "$EXIT_CONTROL"
fi

log "6. verdict"
printf '%s\n' "$OBJECT_LINES" | sed 's/CATALOGUE_CLASSIFY_OBJECT=//' \
  | awk -F'|' '{printf "   %-22s expected=%-12s observed=%-12s final=%-26s %s\n", $1,$2,$3,$4,$5}'

# ---------------------------------------------------------------------------
# Run-level findings from the whole-schema counter-scan. These have no
# catalogue key, so they are NOT in OBJECT_LINES and a reader who only skimmed
# the per-object table would not see them. "No findings printed" must mean the
# scan ran and found nothing, never "the scan is missing from this build", so
# the presence of the scan itself is asserted before its emptiness is believed.
# ---------------------------------------------------------------------------
SCAN_DECISION="$(printf '%s\n' "${JSON_LINE#*=}" | counter_scan_declaration)"
enforce_counter_scan_declaration "$SCAN_DECISION" "$CLASSIFIER_IS_DEFAULT"

SCHEMA_FINDING_LINES="$(grep -F 'CATALOGUE_CLASSIFY_SCHEMA_FINDING=' "$TRANSCRIPT" || true)"
if [[ "${NON_CERTIFYING_RUN:-0}" -eq 1 ]]; then
  printf '\n\033[1;33m   NOT A CERTIFICATION\033[0m %s declares counter_scan_declared=false:\n' \
    "$(basename "$CLASSIFIER")"
  printf '   it performs no whole-schema counter-scan, so this run says nothing about\n'
  printf '   whether a NEW privileged routine exists. Its verdicts cover the catalogued\n'
  printf '   objects only. This classifier is not the gate.\n'
elif [[ -n "$SCHEMA_FINDING_LINES" ]]; then
  printf '\n   \033[1;31mwhole-schema counter-scan findings (run-level, no catalogue key):\033[0m\n'
  printf '%s\n' "$SCHEMA_FINDING_LINES" | sed 's/CATALOGUE_CLASSIFY_SCHEMA_FINDING=//' \
    | awk -F'|' '{printf "   %-46s %s\n", $1, $2}'
else
  SCAN_KINDS="$(printf '%s\n' "${JSON_LINE#*=}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len((d.get("schema_scan") or {}).get("kinds") or []))' 2>/dev/null || printf '?')"
  info "whole-schema counter-scan: ${SCAN_KINDS} dimension(s) scanned, no findings"
fi
info "result: $RESULT"

case "$RESULT" in
  PASS)
    if [[ "${NON_CERTIFYING_RUN:-0}" -eq 1 ]]; then
      printf '\n\033[1;33mPASS (NOT A CERTIFICATION)\033[0m  every catalogued object on the %s schema classified as %s expects.\n' \
        "$GENERATION" "$(basename "$CLASSIFIER")"
      printf '   This classifier declares no whole-schema counter-scan and is not the gate.\n'
      exit 0
    fi
    printf '\n\033[1;32mPASS\033[0m  every object classified exactly as expected on the %s schema.\n' "$GENERATION"; exit 0 ;;
  FAIL)           fail "at least one object is a blocker on the ${GENERATION} schema"; exit "$EXIT_FAIL" ;;
  CONTROL_FAILED) fail "a classifier control failed; this run is not a verdict"; exit "$EXIT_CONTROL" ;;
  *)              fail "unrecognised result '${RESULT}'"; exit "$EXIT_HARNESS" ;;
esac
