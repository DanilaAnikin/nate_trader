#!/usr/bin/env bash
# ============================================================================
# build-schema-base.sh — a committed clone at a named migration generation
#
# The sensor tests need a 0001-0008 and a 0001-0023 database dozens of times.
# Re-applying the migrations for each case costs minutes per case, so the
# result is committed to an image and reused.
#
# The tag is OWNED BY THIS SUITE (`nt-canary-sensor-base:<gen>-<contentkey>`).
# An earlier revision of these tests borrowed the catalogue classifier's cache
# tag instead, and a concurrent session that re-keyed that cache deleted the tag
# mid-run: the suite then tried to pull `nt-catalogue-classify-base` from a
# registry and died at case 1. A test fixture must not be addressable by
# anything outside the test.
#
# THE TAG IS CONTENT-KEYED, AND IT WAS NOT
# ----------------------------------------
# The tag used to be the constant `<gen>-v1`, and a cache hit on it skipped the
# build entirely. So every suite that quoted results "against 0001-0023" was
# quoting results against whatever migrations, bootstrap and seed happened to be
# on disk the first time anyone ran this — silently, and with no way to notice.
# Editing a migration and re-running the suite reused the stale fixture and
# reported PASS.
#
# The tag now carries a digest over everything that decides what the fixture
# contains: the postgres image reference, the generation, the exact set and
# CONTENT of the migrations applied, the resolved bootstrap and seed, and this
# script. Changing any of them changes the tag, so a cache hit is a content
# match rather than a name match. The key is also stamped into the image as a
# label and re-read on a cache hit, so a tag re-pointed by hand is caught too.
#
# The bootstrap and seed are resolved through reuse-guard.sh, so this fixture
# is built from the bridge checkout's real files or not at all.
#
# Usage:
#   build-schema-base.sh --generation 0008|0023 \
#                        --target-root DIR [--target-sha SHA] [--force]
#   build-schema-base.sh --generation 0008|0023 --target-root DIR --print-tag
#
# `--print-tag` resolves and prints the content-keyed tag without building, so
# a consumer names the fixture the same way this script does rather than
# hard-coding a string that can go stale.
# ============================================================================

set -Eeuo pipefail

readonly EXIT_HARNESS=2

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
TRUSTED_ROOT="$(cd "${RC}/../../.." && pwd)"
MIGRATIONS="${TRUSTED_ROOT}/supabase/migrations"
PG_IMAGE="supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00"

GEN=""
TARGET_ROOT=""
TARGET_SHA=""
FORCE=0
PRINT_TAG=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --generation)  GEN="${2:?}";         shift 2 ;;
    --target-root) TARGET_ROOT="${2:?}"; shift 2 ;;
    --target-sha)  TARGET_SHA="${2:?}";  shift 2 ;;
    --force)       FORCE=1;              shift ;;
    --print-tag)   PRINT_TAG=1;          shift ;;
    # Only for testing the content key itself: point the key computation at a
    # different migration set and the tag must change. Without it the key's
    # sensitivity to migration CONTENT can only be asserted, not demonstrated.
    --migrations)  MIGRATIONS="${2:?}";  shift 2 ;;
    *) printf 'build-schema-base.sh: unknown argument: %s\n' "$1" >&2; exit "$EXIT_HARNESS" ;;
  esac
done
case "$GEN" in 0008|0023) ;; *) printf 'build-schema-base.sh: --generation must be 0008 or 0023\n' >&2; exit "$EXIT_HARNESS" ;; esac
[[ -n "$TARGET_ROOT" ]] || { printf 'build-schema-base.sh: --target-root is required\n' >&2; exit "$EXIT_HARNESS"; }
TARGET_SHA="${TARGET_SHA:-$(git -C "$TARGET_ROOT" rev-parse HEAD)}"
TRUSTED_SHA="$(git -C "$TRUSTED_ROOT" rev-parse HEAD)"

# --- the reused files, through the two-checkout guard ----------------------
# Resolved BEFORE the cache is consulted, because their contents are part of
# what decides whether the cached fixture is the right one.
resolve() {  # label, target-relative file, trusted-relative digest
  local out
  out="$("${RC}/reuse-guard.sh" --label "$1" \
        --trusted-root "$TRUSTED_ROOT" --trusted-sha "$TRUSTED_SHA" \
        --target-root  "$TARGET_ROOT"  --target-sha  "$TARGET_SHA" \
        --file "$2" --digest-file "$3")" || exit $?
  awk '{print $3}' <<< "$out"
}
BOOTSTRAP="$(resolve bootstrap \
  dashboard/test/schema-compat/sql/00_env_bootstrap.sql \
  .github/containment/runtime-canary/expected/00_env_bootstrap.sha256)"
SEED="$(resolve seed \
  dashboard/test/schema-compat/sql/10_seed.sql \
  .github/containment/runtime-canary/expected/10_seed.sha256)"

# --- the content key -------------------------------------------------------
# Everything that decides what ends up inside the fixture, hashed. `find | sort`
# then `sha256sum` per file, so both the SET of migrations and their CONTENT are
# covered: adding a migration and editing one must both re-key.
mapfile -t KEY_MIG < <(find "$MIGRATIONS" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | LC_ALL=C sort)
[[ "${#KEY_MIG[@]}" -gt 0 ]] || { printf 'build-schema-base.sh: no migrations in %s\n' "$MIGRATIONS" >&2; exit "$EXIT_HARNESS"; }
KEY_INPUT="$(mktemp)"
trap 'rm -f "$KEY_INPUT"' EXIT
{
  printf 'schema-base-v2\n'
  printf 'generation=%s\n' "$GEN"
  printf 'pg_image=%s\n'   "$PG_IMAGE"
  printf 'builder=%s\n'    "$(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)"
  printf 'bootstrap=%s\n'  "$(sha256sum "$BOOTSTRAP" | cut -d' ' -f1)"
  printf 'seed=%s\n'       "$(sha256sum "$SEED"      | cut -d' ' -f1)"
  for m in "${KEY_MIG[@]}"; do
    # The generation decides WHICH migrations are applied, so only those count.
    if [[ "$GEN" == "0008" && "${m:0:4}" > "0008" ]]; then continue; fi
    printf 'migration=%s %s\n' "$m" "$(sha256sum "${MIGRATIONS}/${m}" | cut -d' ' -f1)"
  done
} > "$KEY_INPUT"
CONTENT_KEY="$(sha256sum "$KEY_INPUT" | cut -c1-16)"
TAG="nt-canary-sensor-base:${GEN}-${CONTENT_KEY}"

if [[ "$PRINT_TAG" -eq 1 ]]; then
  printf '%s\n' "$TAG"
  exit 0
fi

if [[ "$FORCE" -eq 0 ]] && docker image inspect --format '{{.Id}}' "$TAG" >/dev/null 2>&1; then
  # A name match is not a content match until the image says so itself: a tag
  # can be re-pointed at any image on the host with one `docker tag`.
  stamped="$(docker image inspect --format '{{index .Config.Labels "nt.canary.schema-base.key"}}' "$TAG" 2>/dev/null || true)"
  if [[ "$stamped" != "$CONTENT_KEY" ]]; then
    printf 'build-schema-base.sh: %s is tagged for content key %s but carries %s; rebuilding\n' \
      "$TAG" "$CONTENT_KEY" "${stamped:-<none>}" >&2
  else
    printf 'BASE_READY=%s (cached, content key %s verified on the image)\n' "$TAG" "$CONTENT_KEY"
    exit 0
  fi
fi
printf '  content key %s over %s applied migrations + bootstrap + seed + %s\n' \
  "$CONTENT_KEY" "$(grep -c '^migration=' "$KEY_INPUT")" "$PG_IMAGE"

C="nt-canary-basebuild-${GEN}-$$"
# One trap, replacing the key-input-only one above: a second `trap ... EXIT`
# REPLACES the first, so the two cleanups have to be in the same handler or the
# earlier one silently stops running.
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -f "$KEY_INPUT"; }
trap cleanup EXIT

docker image inspect --format '{{.Id}}' "$PG_IMAGE" >/dev/null 2>&1 || docker pull "$PG_IMAGE" >/dev/null
docker rm -f "$C" >/dev/null 2>&1 || true
docker run -d --name "$C" -e POSTGRES_PASSWORD=runtime-canary-throwaway \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMAGE" >/dev/null

streak=0; waited=0
while (( waited < 300 )); do
  if out="$(docker exec "$C" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -X -tA \
            -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage','vault')" 2>/dev/null)"; then
    if [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "5" ]]; then
      streak=$(( streak + 1 )); (( streak >= 5 )) && break
    else streak=0; fi
  else streak=0; fi
  sleep 1; waited=$(( waited + 1 ))
done
(( streak >= 5 )) || { printf 'build-schema-base.sh: %s never became ready\n' "$C" >&2; exit "$EXIT_HARNESS"; }
printf '  ready after %ss\n' "$waited"

docker cp "$BOOTSTRAP" "$C:/bootstrap.sql" >/dev/null
docker exec -i "$C" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 -f /bootstrap.sql \
  || { printf 'build-schema-base.sh: bootstrap failed\n' >&2; exit "$EXIT_HARNESS"; }

docker cp "$MIGRATIONS" "$C:/mig" >/dev/null
applied=0
for m in "${KEY_MIG[@]}"; do
  if [[ "$GEN" == "0008" && "${m:0:4}" > "0008" ]]; then continue; fi
  docker exec -i "$C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f "/mig/$m" >/dev/null \
    || { printf 'build-schema-base.sh: migration %s failed\n' "$m" >&2; exit "$EXIT_HARNESS"; }
  applied=$(( applied + 1 ))
done

docker cp "$SEED" "$C:/seed.sql" >/dev/null
docker exec -i "$C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f /seed.sql >/dev/null \
  || { printf 'build-schema-base.sh: seed failed\n' >&2; exit "$EXIT_HARNESS"; }

# Assert the fixture is what it claims before it is cached under a name.
n_wrap="$(docker exec "$C" psql -U postgres -d postgres -X -tA -c \
  "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'vault\_%'" | tr -d '[:space:]')"
[[ "$n_wrap" == "3" ]] || { printf 'build-schema-base.sh: expected 3 public vault_* wrappers, found %s\n' "$n_wrap" >&2; exit "$EXIT_HARNESS"; }

# The applied count must be the count the key was computed over, or the tag
# names a fixture that was not built.
key_count="$(grep -c '^migration=' "$KEY_INPUT")"
[[ "$applied" == "$key_count" ]] || {
  printf 'build-schema-base.sh: applied %s migrations but the content key covers %s\n' "$applied" "$key_count" >&2
  exit "$EXIT_HARNESS"; }

docker stop "$C" >/dev/null
# The key is stamped INTO the image, so a cache hit can be verified against the
# image rather than against the string someone tagged it with.
docker commit \
  --change "LABEL nt.canary.schema-base.key=${CONTENT_KEY}" \
  --change "LABEL nt.canary.schema-base.generation=${GEN}" \
  "$C" "$TAG" >/dev/null
stamped="$(docker image inspect --format '{{index .Config.Labels "nt.canary.schema-base.key"}}' "$TAG")"
[[ "$stamped" == "$CONTENT_KEY" ]] || {
  printf 'build-schema-base.sh: the committed image does not carry its content key (%s)\n' "${stamped:-<none>}" >&2
  exit "$EXIT_HARNESS"; }
printf 'BASE_READY=%s (content key %s, migrations applied: %s, bootstrap %s, seed %s)\n' \
  "$TAG" "$CONTENT_KEY" "$applied" "$(sha256sum "$BOOTSTRAP" | cut -c1-12)" "$(sha256sum "$SEED" | cut -c1-12)"
