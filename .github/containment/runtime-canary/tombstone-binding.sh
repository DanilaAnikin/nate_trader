#!/usr/bin/env bash
# ============================================================================
# tombstone-binding.sh — CANARY_TOMBSTONED, from the real classifier
#
# WHAT IT REPLACES
# ----------------
# `20_canary_install.sql` used to end with this:
#
#     select 'CANARY_TOMBSTONED=' || string_agg(fn || '=' ||
#       case when body like '%superseded and must not be called%'
#            then 'raises-P0001' else 'live' end, …)
#
# a substring test over `prosrc`, printed into the transcript and asserted on
# by nothing at all. It was wrong in both directions — a genuine tombstone
# whose message was reworded read "live", and any function containing the
# phrase read "raises-P0001" — and no run could fail because of it. Decoration
# that looks like a check is worse than no check, because a reader counts it.
#
# WHAT THIS DOES
# --------------
# It runs the project's REAL classifier, `.github/containment/catalogue-classify.sql`,
# against the same clone the canary is about to be installed on. That
# classifier decides nothing from a SQLSTATE or a substring: it compares the
# full catalogue record for an exact signature — owner, language, security
# mode, volatility, search_path, arguments, return type, overloads,
# cross-schema shadows, explicit and effective EXECUTE, default-privilege
# drift — against a tombstone contract DERIVED FROM migration 0022 at run time,
# and then invokes the routine from a privileged path and requires the exact
# SQLSTATE, the exact message and zero side effects.
#
# `CANARY_TOMBSTONED` is now that classifier's per-object verdict, and it is
# ASSERTED: the classifier must report PASS, it must have classified exactly
# the three watched wrappers, and each must be in the state this schema
# requires — LIVE on 0001-0008, INTENTIONALLY_TOMBSTONED on 0001-0023.
# Anything else stops the run.
#
# Usage:
#   tombstone-binding.sh --pg <container> --schema 0008|0023 [--out <file>]
#
# Exit: 0 bound and asserted   2 harness failure   3 the binding disagrees
# ============================================================================

set -Eeuo pipefail

readonly EXIT_HARNESS=2
readonly EXIT_CONTROL=3

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINMENT="$(cd "${HERE}/.." && pwd)"
REPO="$(cd "${CONTAINMENT}/../.." && pwd)"
# THE CLASSIFIER TOOLCHAIN IS READ FROM A SNAPSHOT WHEN THE RUNNER MADE ONE.
#
# `catalogue-classify.sql`, `extract-tombstone-template.py` and the fixture SQL
# beside them live OUTSIDE this directory and have their own development going
# on. Reading them live means the two migration generations of one run can be
# classified by two different versions — and that is not hypothetical: a
# concurrent session rewrote the extractor's interface between two attempts of
# the same run, and then rewrote the classifier again seven seconds before a
# third. `run.sh` therefore copies the toolchain into
# `$OUT/classifier-snapshot` before it drives anything and points this script at
# the copy, so a run uses ONE version, that version is preserved in the
# artefacts, and its digest is in provenance.json.
#
# This replaces detection with prevention: the old guard digested the live file
# at the start and the end of the run and failed if it had moved, which caught
# the drift but only after twenty-five minutes.
CC_ROOT="${NT_CANARY_CLASSIFIER_SNAPSHOT:-$CONTAINMENT}"
if [[ -n "${NT_CANARY_CLASSIFIER_SNAPSHOT-}" && ! -d "$NT_CANARY_CLASSIFIER_SNAPSHOT" ]]; then
  printf 'tombstone-binding.sh: NT_CANARY_CLASSIFIER_SNAPSHOT=%s is not a directory\n' \
    "$NT_CANARY_CLASSIFIER_SNAPSHOT" >&2
  exit "$EXIT_HARNESS"
fi
CLASSIFIER="${CC_ROOT}/catalogue-classify.sql"
EXTRACTOR="${CC_ROOT}/extract-tombstone-template.py"
# The extractor takes the WHOLE MIGRATION SET, not one file.
#
# It used to take `0022_..._token_generations.sql`, because the tombstone
# contract was believed to live in that migration's section 5 loop. An audit
# then showed that 0022 tombstones a sixth routine INLINE in section 2
# (`resolve_create_operation(uuid,uuid)`) and that 0017 tombstones two more by
# the same mechanism, so a file-scoped — indeed a section-scoped — derivation
# was a subset reporting itself whole. The extractor now scans the set and takes
# the union by MECHANISM; passing it a single file is refused, loudly, which is
# how this line was found to be stale.
TOMB_MIGRATIONS="${REPO}/supabase/migrations"

PG_C=""
SCHEMA=""
OUTFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pg)     PG_C="${2:?}";    shift 2 ;;
    --schema) SCHEMA="${2:?}";  shift 2 ;;
    --out)    OUTFILE="${2:?}"; shift 2 ;;
    *) printf 'tombstone-binding.sh: unknown argument: %s\n' "$1" >&2; exit "$EXIT_HARNESS" ;;
  esac
done
[[ -n "$PG_C" ]] || { printf 'tombstone-binding.sh: --pg is required\n' >&2; exit "$EXIT_HARNESS"; }
case "$SCHEMA" in
  0008) GENERATION=0008 ;;
  0023) GENERATION=latest ;;
  *) printf 'tombstone-binding.sh: --schema must be 0008 or 0023\n' >&2; exit "$EXIT_HARNESS" ;;
esac

# The state name this schema must come back as is RECORDED, not hard-coded.
# The classifier is a live file with its own development going on; when it
# renames or splits a state, this binding must fail loudly and be re-recorded
# deliberately, rather than quietly compare against a name that no longer
# exists and accept whatever it finds.
STATE_FILE="${HERE}/expected/tombstone-state.${SCHEMA}.txt"
[[ -f "$STATE_FILE" ]] || {
  printf 'CANARY_TOMBSTONED_FAIL=REQUIRED_STATE_UNPINNED this checkout records no required classifier state for schema %s (%s)\n' \
    "$SCHEMA" "$STATE_FILE" >&2; exit "$EXIT_CONTROL"; }
REQUIRED_STATE="$(tr -d '[:space:]' < "$STATE_FILE")"
[[ -n "$REQUIRED_STATE" ]] || {
  printf 'CANARY_TOMBSTONED_FAIL=REQUIRED_STATE_EMPTY %s is empty\n' "$STATE_FILE" >&2; exit "$EXIT_CONTROL"; }
for f in "$CLASSIFIER" "$EXTRACTOR"; do
  [[ -f "$f" ]] || { printf 'tombstone-binding.sh: missing %s\n' "$f" >&2; exit "$EXIT_HARNESS"; }
done
[[ -d "$TOMB_MIGRATIONS" ]] || { printf 'tombstone-binding.sh: missing %s\n' "$TOMB_MIGRATIONS" >&2; exit "$EXIT_HARNESS"; }

WORK="$(mktemp -d /tmp/nt-tombbind-XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# --- the tombstone contract, derived from migration 0022 -------------------
python3 "$EXTRACTOR" "$TOMB_MIGRATIONS" > "$WORK/tomb.env" \
  || { printf 'tombstone-binding.sh: could not derive the tombstone contract from %s\n' "$TOMB_MIGRATIONS" >&2; exit "$EXIT_HARNESS"; }
# shellcheck disable=SC1091
source "$WORK/tomb.env"
for v in NT_CC_TOMB_NAMES NT_CC_TOMB_POSTCOND_NAMES NT_CC_TOMB_LANG NT_CC_TOMB_SEARCHPATH \
         NT_CC_TOMB_SECDEF NT_CC_TOMB_VOLATILITY NT_CC_TOMB_ERRCODE NT_CC_TOMB_MSG_TEMPLATE \
         NT_CC_TOMB_BODY_TEMPLATE NT_CC_TOMB_BODY_SHAPE NT_CC_TOMB_REVOKE_ROLES; do
  [[ -n "${!v-}" ]] || { printf 'tombstone-binding.sh: the extractor produced an empty %s\n' "$v" >&2; exit "$EXIT_HARNESS"; }
done

IMAGE_ID="$(docker inspect --format '{{.Image}}' "$PG_C")"

# --- the fixtures the classifier's own controls depend on -------------------
# The classifier refuses to render a verdict unless its controls pass, and some
# of them need fixtures that live beside it (a second account owner, for one).
# The canary's clone is seeded from the bridge's 10_seed.sql only, so those are
# applied here. Skipping them would turn every run into CONTROL_FAILED, which
# is the classifier correctly refusing to answer — not something to work
# around.
shopt -s nullglob
for fixture in "${CC_ROOT}"/sql/[2-9][0-9]_*.sql; do
  base="$(basename "$fixture")"
  docker cp "$fixture" "$PG_C:/nt_fix_${base}" >/dev/null
  if ! docker exec -i "$PG_C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 \
        -f "/nt_fix_${base}" > "$WORK/${base}.out" 2> "$WORK/${base}.err"; then
    printf 'CANARY_TOMBSTONED_FAIL=FIXTURE_FAILED %s could not be applied\n' "$base" >&2
    sed 's/^/    /' "$WORK/${base}.err" >&2
    exit "$EXIT_HARNESS"
  fi
done
shopt -u nullglob

# --- the classifier's variable contract, checked before it is run ----------
# The classifier is a live file with its own development going on. When it grew
# a new required psql variable (`tomb_postcond_names`), this script kept passing
# the old set and the run died on
#
#     ERROR:  syntax error at or near ":"
#     LINE 5:   ('tomb_postcond_names', :'tomb_postcond_names'),
#
# — a message about punctuation, three layers below the actual fact, which is
# that two ends of a contract have drifted apart. So the contract is asserted:
# every `:'name'` the classifier reads must be one this script supplies.
SUPPLIED_VARS="generation probe_mode tomb_names tomb_postcond_names tomb_lang
tomb_searchpath tomb_secdef tomb_volatility tomb_errcode tomb_msg_template
tomb_body_template tomb_body_shape tomb_revoke_roles image_id
base_inputs_sha256 mutation_label ON_ERROR_STOP
tomb_targets_json tomb_template_names tomb_acl_by_target tomb_mechanisms
tomb_names_by_source tomb_sources tomb_migration_count live_body_json"

# `live_body_json` is generation-dependent: the extractor emits one map per
# generation and the classifier reads whichever one applies. Choosing it here,
# by the generation this binding was asked about, is the only place that knows.
case "$SCHEMA" in
  0008) NT_CC_LIVE_BODY_JSON="${NT_CC_LIVE_BODY_0008_JSON-}" ;;
  *)    NT_CC_LIVE_BODY_JSON="${NT_CC_LIVE_BODY_LATEST_JSON-}" ;;
esac
for v in NT_CC_TOMB_TARGETS_JSON NT_CC_TOMB_TEMPLATE_NAMES NT_CC_TOMB_ACL_BY_TARGET \
         NT_CC_TOMB_MECHANISMS NT_CC_TOMB_NAMES_BY_SOURCE NT_CC_TOMB_SOURCES \
         NT_CC_TOMB_MIGRATION_COUNT NT_CC_LIVE_BODY_JSON; do
  [[ -n "${!v-}" ]] || { printf 'tombstone-binding.sh: the extractor produced an empty %s\n' "$v" >&2; exit "$EXIT_HARNESS"; }
done
if ! REFERENCED="$(grep -oE ":'[a-z_][a-z0-9_]*'" "$CLASSIFIER" | tr -d ":'" | LC_ALL=C sort -u)"; then
  printf 'CANARY_TOMBSTONED_FAIL=CLASSIFIER_UNREADABLE could not read %s\n' "$CLASSIFIER" >&2
  exit "$EXIT_HARNESS"
fi
MISSING=""
while IFS= read -r ref; do
  [[ -n "$ref" ]] || continue
  case " $(tr '\n' ' ' <<< "$SUPPLIED_VARS") " in
    *" $ref "*) ;;
    *) MISSING="${MISSING:+$MISSING }$ref" ;;
  esac
done <<< "$REFERENCED"
if [[ -n "$MISSING" ]]; then
  printf 'CANARY_TOMBSTONED_FAIL=CLASSIFIER_CONTRACT_DRIFT the real classifier now reads psql variables this binding does not supply: %s\n' "$MISSING" >&2
  printf '    %s has changed its interface; add them here deliberately (the extractor produces NT_CC_TOMB_*).\n' "$CLASSIFIER" >&2
  exit "$EXIT_CONTROL"
fi
# ...and the check must be able to find anything at all: a grep that matched
# nothing would make the loop above vacuously happy.
if [[ -z "$REFERENCED" ]]; then
  printf 'CANARY_TOMBSTONED_FAIL=CLASSIFIER_CONTRACT_UNREADABLE %s references no psql variables at all; the contract check cannot work\n' "$CLASSIFIER" >&2
  exit "$EXIT_CONTROL"
fi

docker cp "$CLASSIFIER" "$PG_C:/nt_classify.sql" >/dev/null
set +e
docker exec -i "$PG_C" psql -U supabase_admin -d postgres -X -v ON_ERROR_STOP=1 \
  -v generation="$GENERATION" \
  -v probe_mode=normal \
  -v tomb_names="$NT_CC_TOMB_NAMES" \
  -v tomb_postcond_names="$NT_CC_TOMB_POSTCOND_NAMES" \
  -v tomb_lang="$NT_CC_TOMB_LANG" \
  -v tomb_searchpath="$NT_CC_TOMB_SEARCHPATH" \
  -v tomb_secdef="$NT_CC_TOMB_SECDEF" \
  -v tomb_volatility="$NT_CC_TOMB_VOLATILITY" \
  -v tomb_errcode="$NT_CC_TOMB_ERRCODE" \
  -v tomb_msg_template="$NT_CC_TOMB_MSG_TEMPLATE" \
  -v tomb_body_template="$NT_CC_TOMB_BODY_TEMPLATE" \
  -v tomb_body_shape="$NT_CC_TOMB_BODY_SHAPE" \
  -v tomb_revoke_roles="$NT_CC_TOMB_REVOKE_ROLES" \
  -v tomb_targets_json="$NT_CC_TOMB_TARGETS_JSON" \
  -v tomb_template_names="$NT_CC_TOMB_TEMPLATE_NAMES" \
  -v tomb_acl_by_target="$NT_CC_TOMB_ACL_BY_TARGET" \
  -v tomb_mechanisms="$NT_CC_TOMB_MECHANISMS" \
  -v tomb_names_by_source="$NT_CC_TOMB_NAMES_BY_SOURCE" \
  -v tomb_sources="$NT_CC_TOMB_SOURCES" \
  -v tomb_migration_count="$NT_CC_TOMB_MIGRATION_COUNT" \
  -v live_body_json="$NT_CC_LIVE_BODY_JSON" \
  -v image_id="$IMAGE_ID" \
  -v base_inputs_sha256="runtime-canary-clone" \
  -v mutation_label="" \
  -f /nt_classify.sql > "$WORK/classify.txt" 2>&1
rc=$?
set -e
[[ -n "$OUTFILE" ]] && cp "$WORK/classify.txt" "$OUTFILE"
if [[ "$rc" -ne 0 ]]; then
  printf 'CANARY_TOMBSTONED_FAIL=CLASSIFIER_DID_NOT_RUN the real classifier did not complete (psql rc=%s)\n' "$rc" >&2
  tail -25 "$WORK/classify.txt" | sed 's/^/    /' >&2
  exit "$EXIT_CONTROL"
fi

# --- the classifier's own overall result ------------------------------------
if ! grep -F 'CATALOGUE_CLASSIFY_RESULT=' "$WORK/classify.txt" > "$WORK/result.txt"; then
  printf 'CANARY_TOMBSTONED_FAIL=CLASSIFIER_SILENT the classifier printed no result line\n' >&2
  exit "$EXIT_CONTROL"
fi
RESULT="$(sed 's/^CATALOGUE_CLASSIFY_RESULT=//' "$WORK/result.txt" | tr -d '[:space:]')"
if [[ "$RESULT" != "PASS" ]]; then
  printf 'CANARY_TOMBSTONED_FAIL=CLASSIFIER_%s the real classifier does not accept this schema\n' "$RESULT" >&2
  grep -F 'CATALOGUE_CLASSIFY_OBJECT=' "$WORK/classify.txt" | sed 's/^/    /' >&2 || true
  grep -F 'CATALOGUE_CLASSIFY_CONTROL=' "$WORK/classify.txt" | sed 's/^/    /' >&2 || true
  exit "$EXIT_CONTROL"
fi

# --- the per-object verdicts, for exactly the three watched wrappers --------
if ! grep -F 'CATALOGUE_CLASSIFY_OBJECT=' "$WORK/classify.txt" > "$WORK/objects.txt"; then
  printf 'CANARY_TOMBSTONED_FAIL=CLASSIFIER_SILENT the classifier classified no objects\n' >&2
  exit "$EXIT_CONTROL"
fi

WANTED=(vault_create_secret vault_delete_secret vault_update_secret)
bound=""
for fn in "${WANTED[@]}"; do
  line="$(awk -F'|' -v k="CATALOGUE_CLASSIFY_OBJECT=${fn}" '$1 == k { print; exit }' "$WORK/objects.txt")"
  if [[ -z "$line" ]]; then
    printf 'CANARY_TOMBSTONED_FAIL=NOT_CLASSIFIED the real classifier did not classify %s\n' "$fn" >&2
    exit "$EXIT_CONTROL"
  fi
  final="$(awk -F'|' '{print $4}' <<< "$line")"
  reasons="$(awk -F'|' '{print $5}' <<< "$line")"
  if [[ "$final" != "$REQUIRED_STATE" ]]; then
    printf 'CANARY_TOMBSTONED_FAIL=STATE_MISMATCH %s is %s on schema %s; this schema requires %s (%s)\n' \
      "$fn" "$final" "$SCHEMA" "$REQUIRED_STATE" "${reasons:-no reasons}" >&2
    exit "$EXIT_CONTROL"
  fi
  bound+="${bound:+,}${fn}=${final}"
done

printf 'CANARY_TOMBSTONED=%s\n' "$bound"
printf 'CANARY_TOMBSTONED_SOURCE=catalogue-classify.sql|result=%s|generation=%s|required=%s\n' \
  "$RESULT" "$GENERATION" "$REQUIRED_STATE"
