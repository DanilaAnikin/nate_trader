#!/usr/bin/env bash
# ============================================================================
# build-image.sh — build a dashboard image from a source tree, for the canary.
#
# The runtime canary tests an IMAGE. This script is the only supported way to
# turn a source tree into one for that purpose, and it exists so that the
# frozen artifact and the deliberately-unfrozen mutant of property (B) are
# built by exactly the same procedure from exactly the same Dockerfile: if the
# mutant were built differently, "the mutant reaches the canary and the frozen
# image does not" would be a statement about two build pipelines rather than
# about two source trees.
#
# It never reads, writes or builds anything inside a git worktree. Give it a
# scratch copy.
#
# WHAT `--sha` IS, AND WHAT IT IS NOT (audit finding B7)
# ------------------------------------------------------
# `--sha` becomes `org.opencontainers.image.revision`, and `run.sh` requires it
# to equal `--target-sha`. That binding is only as strong as an operator's
# typing: nothing about the string is derived from the tree being built. An
# image built from a source tree MORE frozen than the target commit, tagged with
# the target sha, would have certified the target commit.
#
# So this script also stamps `org.nt.canary.source-digest`, a content digest
# over the build context computed by `lib-source-digest.sh`. `run.sh` recomputes
# that digest over its own `--source` and refuses an image whose label does not
# match, and separately compares `--source` with `git archive <target-sha>
# dashboard`. The three are then bound to each other rather than to memory.
#
# Usage:
#   ./build-image.sh --source <dir> --tag <image:tag> [--sha <label>]
#
# Exit codes:
#   0  built, and `docker image inspect` confirms the tag resolves AND carries
#      the source digest of the tree it was built from
#   2  harness failure (bad arguments, missing source, build failed)
# ============================================================================

set -Eeuo pipefail
shopt -s inherit_errexit

EXIT_HARNESS=2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCE=""
TAG=""
SHA="canary-local"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="${2:?--source needs a directory}"; shift 2 ;;
    --tag)    TAG="${2:?--tag needs an image reference}";  shift 2 ;;
    --sha)    SHA="${2:?--sha needs a value}";             shift 2 ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'build-image.sh: unknown argument: %s\n' "$1" >&2; exit "$EXIT_HARNESS" ;;
  esac
done

if [[ -z "$SOURCE" || -z "$TAG" ]]; then
  printf 'build-image.sh: --source and --tag are both required\n' >&2
  exit "$EXIT_HARNESS"
fi
if [[ ! -f "$SOURCE/Dockerfile" || ! -f "$SOURCE/package.json" ]]; then
  printf 'build-image.sh: %s does not look like a dashboard source tree\n' "$SOURCE" >&2
  exit "$EXIT_HARNESS"
fi
# A build context inside a git worktree would be one `docker build` away from
# writing into it (BuildKit does not, but the operator's next reflex does).
if [[ -e "$SOURCE/../.git" || -e "$SOURCE/.git" ]]; then
  printf 'build-image.sh: refusing to build from a git worktree (%s); copy it to a scratch dir first\n' "$SOURCE" >&2
  exit "$EXIT_HARNESS"
fi

# These are not credentials and are not secret. The canary stack has no real
# Supabase project: the URL points at the recording sink and both "keys" are
# JWTs minted by the harness with a throwaway signing secret. They are build
# arguments only because the Dockerfile requires them to be.
: "${CANARY_SUPABASE_URL:?CANARY_SUPABASE_URL must be exported by run.sh}"
: "${CANARY_ANON_KEY:?CANARY_ANON_KEY must be exported by run.sh}"
: "${CANARY_COOKIE_NAME:?CANARY_COOKIE_NAME must be exported by run.sh}"

# The content of the tree being built, digested the same way run.sh will
# recompute it. `node_modules`, `.next` and `.git` are excluded — which is
# exactly what this Dockerfile's .dockerignore excludes — so the digest is over
# the bytes the build actually sees.
# shellcheck source=lib-source-digest.sh
. "${HERE}/lib-source-digest.sh"
if ! SOURCE_DIGEST="$(nt_source_digest "$SOURCE")"; then
  printf 'build-image.sh: could not digest the build context %s\n' "$SOURCE" >&2
  exit "$EXIT_HARNESS"
fi
SOURCE_FILES="$(nt_source_file_count "$SOURCE")"

printf '== building %s from %s\n' "$TAG" "$SOURCE"
printf '   source digest %s (%s files)\n' "$SOURCE_DIGEST" "$SOURCE_FILES"

DOCKER_BUILDKIT=1 docker build \
  --file "$SOURCE/Dockerfile" \
  --tag "$TAG" \
  --label "org.nt.canary.source-digest=${SOURCE_DIGEST}" \
  --label "org.nt.canary.source-files=${SOURCE_FILES}" \
  --build-arg "NEXT_PUBLIC_SUPABASE_URL=${CANARY_SUPABASE_URL}" \
  --build-arg "NEXT_PUBLIC_SUPABASE_ANON_KEY=${CANARY_ANON_KEY}" \
  --build-arg "NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME=${CANARY_COOKIE_NAME}" \
  --build-arg "BUILD_SHA=${SHA}" \
  "$SOURCE"

# `docker build` exiting 0 is not proof the tag resolves: assert it.
if ! id="$(docker image inspect --format '{{.Id}}' "$TAG" 2>/dev/null)"; then
  printf 'build-image.sh: %s reported success but the tag does not resolve\n' "$TAG" >&2
  exit "$EXIT_HARNESS"
fi
# ...and neither is it proof the labels survived. A `--label` silently dropped
# by a builder that reused a cached final stage would leave run.sh unable to
# bind the image to anything, which is the state B7 found.
if ! got="$(docker image inspect --format '{{index .Config.Labels "org.nt.canary.source-digest"}}' "$TAG" 2>/dev/null)"; then
  printf 'build-image.sh: could not read back the labels of %s\n' "$TAG" >&2
  exit "$EXIT_HARNESS"
fi
if [[ "$got" != "$SOURCE_DIGEST" ]]; then
  printf 'build-image.sh: %s carries source-digest %s, not %s\n' "$TAG" "${got:-<none>}" "$SOURCE_DIGEST" >&2
  exit "$EXIT_HARNESS"
fi
printf '   built %s -> %s\n' "$TAG" "$id"
printf '   labels: revision=%s source-digest=%s\n' "$SHA" "$SOURCE_DIGEST"
