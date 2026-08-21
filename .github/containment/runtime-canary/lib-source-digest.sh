#!/usr/bin/env bash
# ============================================================================
# lib-source-digest.sh — one content digest over a dashboard source tree,
#                        computed the same way by the builder and the runner
#
# WHY THIS EXISTS (audit finding B7)
# ----------------------------------
# `run.sh` binds the image under test to `--target-sha` by reading the image's
# `org.opencontainers.image.revision` label. That label is whatever string the
# operator typed at `build-image.sh --sha`. Nothing digested the build context,
# and `--source` — the tree that decides which routes the matrix drives, via
# `driver/enumerate-routes.mjs` — was bound to nothing at all. An image built
# from a tree MORE frozen than the target commit, tagged with the target sha,
# would have certified the target commit.
#
# So there are now two bindings, and this file is the half they share:
#
#   image  <-> --source        `build-image.sh` stamps this digest as
#                              `org.nt.canary.source-digest`; `run.sh`
#                              recomputes it over --source and requires
#                              equality.
#   --source <-> --target-sha  `run.sh` compares --source file by file against
#                              the tree `git` reports at --target-sha.
#
# The digest deliberately excludes `node_modules`, `.next` and `.git`, which is
# exactly what `.dockerignore` excludes from the build context, so the digest is
# over the bytes the build actually saw.
#
# Sourced, not executed:  . lib-source-digest.sh  &&  nt_source_digest DIR
# ============================================================================

# Print the digest of $1 on stdout. Non-zero, with a message on stderr, if the
# tree is missing or EMPTY — an empty scan must never be reported as a digest,
# because "no files matched" and "these files matched" would then be the same
# 64 hex characters for every empty directory on the machine.
nt_source_digest() {
  local root="$1"
  if [[ -z "$root" || ! -d "$root" ]]; then
    printf 'nt_source_digest: %s is not a directory\n' "${root:-<empty>}" >&2
    return 2
  fi
  local -a files=()
  mapfile -t files < <(
    find "$root" \
      -type d \( -name node_modules -o -name .next -o -name .git \) -prune -o \
      -type f -printf '%P\n' | LC_ALL=C sort
  )
  if [[ "${#files[@]}" -eq 0 ]]; then
    printf 'nt_source_digest: %s contains no files after pruning node_modules/.next/.git\n' "$root" >&2
    return 2
  fi
  local f line
  {
    for f in "${files[@]}"; do
      if ! line="$(sha256sum "$root/$f")"; then
        printf 'nt_source_digest: could not hash %s\n' "$root/$f" >&2
        return 2
      fi
      printf '%s  %s\n' "${line%% *}" "$f"
    done
  } | sha256sum | cut -d' ' -f1
}

# How many files went into the digest — printed alongside it so a reader can
# tell a real tree from a nearly-empty one.
nt_source_file_count() {
  local root="$1"
  find "$root" \
    -type d \( -name node_modules -o -name .next -o -name .git \) -prune -o \
    -type f -print | wc -l
}
