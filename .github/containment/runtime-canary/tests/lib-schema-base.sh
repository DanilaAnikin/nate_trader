#!/usr/bin/env bash
# ============================================================================
# lib-schema-base.sh — resolve the CONTENT-KEYED schema fixture tag
#
# The fixture image used to be addressed by the constant tag
# `nt-canary-sensor-base:<gen>-v1`, and every suite hard-coded that string. A
# cache hit on it skipped the build, so a suite could quote results "against
# 0001-0023" while running against migrations, a bootstrap and a seed that had
# since changed on disk. The tag is now a digest over exactly those inputs
# (see build-schema-base.sh), which means no caller may spell it by hand.
#
# Source this and call:
#
#     schema_base_image <generation>      # -> prints the tag, or fails loudly
#
# Resolution order, most explicit first:
#   1. NT_CANARY_PG_BASE            — one image for every generation (overrides)
#   2. NT_CANARY_PG_BASE_<gen>      — per generation, as run-all.sh exports them
#   3. build-schema-base.sh --print-tag, which needs a target checkout, taken
#      from --target-root / NT_CANARY_TARGET_ROOT
#
# There is deliberately no fallback to a constant: a suite that cannot say
# WHICH fixture it is about must stop, not guess. Guessing is the defect.
# ============================================================================

schema_base_image() {  # generation -> the image reference on stdout
  local gen="${1:?schema_base_image needs a generation}"
  local here rc var val
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ -n "${NT_CANARY_PG_BASE:-}" ]]; then
    printf '%s' "$NT_CANARY_PG_BASE"; return 0
  fi
  var="NT_CANARY_PG_BASE_${gen}"
  val="${!var:-}"
  if [[ -n "$val" ]]; then
    printf '%s' "$val"; return 0
  fi

  local root="${NT_CANARY_TARGET_ROOT:-}"
  if [[ -z "$root" ]]; then
    printf 'lib-schema-base: cannot resolve the %s fixture image.\n' "$gen" >&2
    printf '  Give --target-root (or export NT_CANARY_TARGET_ROOT), or export NT_CANARY_PG_BASE_%s.\n' "$gen" >&2
    printf '  The tag is content-keyed; a hard-coded name would silently reuse a stale fixture.\n' >&2
    return 2
  fi
  local tag
  if ! tag="$("${here}/build-schema-base.sh" --generation "$gen" --target-root "$root" --print-tag)"; then
    printf 'lib-schema-base: build-schema-base.sh could not resolve the %s fixture tag\n' "$gen" >&2
    return 2
  fi
  [[ -n "$tag" ]] || { printf 'lib-schema-base: an empty %s fixture tag was resolved\n' "$gen" >&2; return 2; }
  printf '%s' "$tag"
}

# The fixture must exist AND carry the content key its name claims. A tag can be
# re-pointed with one `docker tag`; the label cannot be moved without a commit.
schema_base_require() {  # generation, image -> 0 if the image is that fixture
  local gen="$1" img="$2" want stamped
  want="${img##*:}"; want="${want#"${gen}"-}"
  if ! stamped="$(docker image inspect --format '{{index .Config.Labels "nt.canary.schema-base.key"}}' "$img" 2>/dev/null)"; then
    printf 'lib-schema-base: the %s fixture image %s is not present; run build-schema-base.sh\n' "$gen" "$img" >&2
    return 2
  fi
  if [[ -n "${NT_CANARY_PG_BASE:-}" ]]; then
    # An explicitly overridden image is the caller's business, but it is
    # recorded rather than silently accepted as the content-keyed fixture.
    printf 'lib-schema-base: NT_CANARY_PG_BASE overrides the %s fixture (%s, key %s)\n' \
      "$gen" "$img" "${stamped:-<none>}" >&2
    return 0
  fi
  if [[ "$stamped" != "$want" ]]; then
    printf 'lib-schema-base: %s is named for content key %s but carries %s\n' "$img" "$want" "${stamped:-<none>}" >&2
    return 2
  fi
  return 0
}
