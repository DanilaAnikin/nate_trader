#!/usr/bin/env bash
# ============================================================================
# trusted-policy.sh — the identity boundary for the dashboard containment gate.
#
# WHAT THIS IS FOR
# ----------------
# The containment gate exists so a frozen, non-trading dashboard image can be
# reviewed and shipped WITHOUT the strategy promotion gate being green. That is
# only safe if the candidate provably cannot change anything that decides
# trading behaviour. This script is where "provably" lives.
#
# IT RUNS FROM MAIN, NEVER FROM THE CANDIDATE.
# The workflow checks out main into a trusted directory and executes THIS copy.
# A candidate that edits .github/containment/** changes its own scanner, which
# is precisely the attack this ordering prevents — and which the allowlist below
# rejects anyway, belt and braces.
#
# Usage: trusted-policy.sh <trusted_dir> <candidate_sha> <out_json>
#   trusted_dir   a checkout of the TRUSTED ref (main) with full history
#   candidate_sha a full 40-character commit SHA, already fetched into that repo
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

TRUSTED_DIR="${1:?usage: trusted-policy.sh <trusted_dir> <candidate_sha> <out_json>}"
CANDIDATE="${2:?candidate sha required}"
OUT="${3:?output json path required}"

# The audited pre-migration bridge. The candidate MUST descend from this.
BRIDGE_BASE=7b9c55806ec79e2f56b5831063fea4c613e62d50
# The candidate line whose read path calls account_history_snapshot (migration
# 0014). Production's schema is attested only around 0001-0008, so anything
# descending from this would 404 the equity and performance routes.
FORBIDDEN_LINE=0f6c415324625767f4b03c0cbfeda63b37d8c753

FAILURES=()
fail(){ FAILURES+=("$1"); printf '  FAIL  %s\n' "$1"; }
ok(){   printf '  ok    %s\n' "$1"; }

cd "$TRUSTED_DIR"

# ── 0. the candidate SHA must be exactly a full commit id ───────────────────
# A short SHA, a branch name or a ref is not acceptable: all three are mutable
# or ambiguous, and the whole point is to bind one immutable tree.
if [[ ! "$CANDIDATE" =~ ^[0-9a-f]{40}$ ]]; then
  fail "candidate '$CANDIDATE' is not a full 40-character lowercase SHA"
  printf '{"result":"FAIL","reason":"malformed candidate sha"}\n' > "$OUT"
  exit 1
fi
# A 40-hex string that is not a commit in this repository used to be RECORDED
# and then carried on into `git diff`, `git ls-tree` and finally
# `git rev-parse "$CANDIDATE^{tree}"`, which is unguarded — so the script died
# there under `set -e` with exit 128 and wrote NO attestation at all. Measured:
# `trusted-policy.sh . 0000…0000 out.json` exited 128 and out.json was never
# created, while the workflow's upload step (if-no-files-found: warn) reported
# only a warning. The gate still failed closed, but an uninterpreted 128 with no
# attestation is a crash, not a verdict. It is now a verdict.
CAND_TYPE="$(git cat-file -t "$CANDIDATE" 2>/dev/null || true)"
if [[ "$CAND_TYPE" != commit ]]; then
  fail "candidate $CANDIDATE is not a commit object in this repository (got: ${CAND_TYPE:-<absent>})"
  python3 - "$OUT" "$CANDIDATE" "${CAND_TYPE:-absent}" <<'PY'
import json, sys
out, cand, got = sys.argv[1:4]
doc = {
    "gate": "dashboard-containment-gate/identity-boundary",
    "result": "FAIL",
    "reason": "candidate is not a commit object",
    "paper_promotable": False,
    "dashboard_containment_promotable": False,
    "paper_validation_required": False,
    "paper_validation_result": "NOT_APPLICABLE",
    "strategy_identity_unchanged": False,
    "containment_scope_valid": False,
    "candidate_sha": cand,
    "candidate_object_type": got,
    "failures": ["candidate %s is not a commit object in this repository (got: %s)" % (cand, got)],
}
with open(out, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write("\n")
print(json.dumps(doc, indent=2, sort_keys=True))
PY
  printf '\nIDENTITY BOUNDARY FAILED (1 finding(s))\n'
  exit 1
fi
ok "candidate is a full commit SHA"

# ── 1. ancestry ─────────────────────────────────────────────────────────────
if git merge-base --is-ancestor "$BRIDGE_BASE" "$CANDIDATE" 2>/dev/null; then
  ok "descends from the audited bridge base $BRIDGE_BASE"
else
  fail "candidate does NOT descend from the audited bridge base $BRIDGE_BASE"
fi
if git merge-base --is-ancestor "$FORBIDDEN_LINE" "$CANDIDATE" 2>/dev/null; then
  fail "candidate descends from $FORBIDDEN_LINE, the post-0014 candidate line"
else
  ok "does not descend from the post-0014 candidate line"
fi

# ── 2. the changed-path allowlist ───────────────────────────────────────────
# Everything the containment work legitimately touches lives under dashboard/.
# Anything else is out of scope for a containment change by definition.
ALLOW_PREFIXES=( "dashboard/" )

mapfile -t CHANGED < <(git diff --name-only "$BRIDGE_BASE" "$CANDIDATE")
mapfile -t CHANGED_STATUS < <(git diff --name-status -M -C "$BRIDGE_BASE" "$CANDIDATE")

# non-vacuity: a containment candidate that changed nothing is not a candidate,
# and an empty diff here would make every assertion below trivially true
if [[ ${#CHANGED[@]} -eq 0 ]]; then
  fail "candidate changes NOTHING relative to the bridge base — refusing to attest an empty diff"
else
  ok "candidate changes ${#CHANGED[@]} path(s)"
fi

n_outside=0
for p in "${CHANGED[@]}"; do
  allowed=0
  for pre in "${ALLOW_PREFIXES[@]}"; do [[ "$p" == "$pre"* ]] && allowed=1; done
  if [[ $allowed -ne 1 ]]; then
    fail "changed path outside the containment allowlist: $p"
    n_outside=$(( n_outside + 1 ))
  fi
done
# Scoped to THIS check. It used to read `[[ ${#FAILURES[@]} -eq 0 ]]`, the
# GLOBAL failure list, so an unrelated ancestry failure silently suppressed the
# allowlist's own verdict line and a reader could not tell "the allowlist was
# clean" from "the allowlist never reported".
if [[ "$n_outside" -eq 0 ]]; then
  ok "every one of the ${#CHANGED[@]} changed path(s) is under the allowlist"
else
  ok "allowlist check reported ${n_outside} path(s) outside ${ALLOW_PREFIXES[*]}"
fi

# renames and copies are rejected outright: a rename can move a trading-relevant
# file into an allowlisted prefix, and --name-only would not show the source
while IFS=$'\t' read -r st rest; do
  case "$st" in
    R*|C*) fail "rename/copy detected ($st): $rest — not permitted in a containment change" ;;
  esac
done < <(printf '%s\n' "${CHANGED_STATUS[@]}")

# ── 3. symlinks and submodules ──────────────────────────────────────────────
# mode 120000 is a symlink, 160000 a gitlink. Either can redirect a scanner or
# smuggle content that never appears in the diff.
#
# THIS USED TO BE AN ABSENCE CLAIM FROM AN UNPROVEN SCAN. The loop below read
#     git ls-tree -r "$CANDIDATE" -- dashboard/ 2>/dev/null || true
# and then printed `ok  no symlinks or submodules under dashboard/`
# UNCONDITIONALLY — including when the scan produced zero rows. Measured
# directly, against this repository's root commit d2bbd8a5 (which has no
# dashboard/ at all): `git ls-tree -r d2bbd8a5 -- dashboard/ | wc -l` is 0, and
# the script printed that `ok` line anyway. `2>/dev/null || true` additionally
# turned a git failure into the same silent nothing. A scan that cannot
# distinguish "I looked and found none" from "I did not look" is not evidence.
#
# So there are now three things instead of one: the scan's exit status is kept,
# it must have produced at least one row, and the MATCHER ITSELF is proved live
# on a planted input before its verdict on the real tree is believed.
scan_special_modes() {  # reads ls-tree rows on stdin, prints one finding per line
  local mode _type _obj path
  while read -r mode _type _obj path; do
    case "$mode" in
      120000) printf 'symlink introduced or present in a changed path: %s\n' "$path" ;;
      160000) printf 'submodule (gitlink) in a changed path: %s\n' "$path" ;;
    esac
  done
}

# POSITIVE CONTROL on the matcher, before it is used to certify an absence. Two
# rows are planted — one of each mode — and both must be reported; a regular
# blob planted beside them must not be. A matcher that silently matched nothing
# would otherwise make the real scan below unconditionally clean.
#
# Counting is done with `mapfile`, never `grep -c`: `grep -c` exits 1 on a zero
# count, which under `set -Eeuo pipefail` kills the script mid-check — measured,
# in the first draft of this very repair, which exited silently at exactly this
# line and never wrote the attestation at all.
CTL_ROWS=$'120000 blob aaaa\tdashboard/planted-symlink\n160000 commit bbbb\tdashboard/planted-submodule\n100644 blob cccc\tdashboard/planted-regular'
ctl_hits=()
mapfile -t ctl_hits < <(printf '%s\n' "$CTL_ROWS" | scan_special_modes)
ctl_joined="$(printf '%s\n' "${ctl_hits[@]+"${ctl_hits[@]}"}")"
if [[ "${#ctl_hits[@]}" -ne 2 ]] \
   || [[ "$ctl_joined" != *"dashboard/planted-symlink"* ]] \
   || [[ "$ctl_joined" != *"dashboard/planted-submodule"* ]] \
   || [[ "$ctl_joined" == *"dashboard/planted-regular"* ]]; then
  fail "the symlink/submodule matcher failed its own positive control (${#ctl_hits[@]} hit(s)); its verdict on the real tree means nothing"
else
  ok "symlink/submodule matcher proved live on a planted 120000 and 160000 row"
fi

LS_TREE_OUT=""
if ! LS_TREE_OUT="$(git ls-tree -r "$CANDIDATE" -- dashboard/)"; then
  fail "could not list the candidate's dashboard/ tree; the symlink scan did not happen"
  LS_TREE_OUT=""
fi
ls_rows=()
[[ -z "$LS_TREE_OUT" ]] || mapfile -t ls_rows <<< "$LS_TREE_OUT"
LS_TREE_ROWS="${#ls_rows[@]}"
if [[ "$LS_TREE_ROWS" -lt 1 ]]; then
  # Non-vacuity floor. Every candidate this gate exists for is a dashboard
  # change, so a candidate with no dashboard/ tree is not a candidate — and an
  # empty scan must never be reported as a clean one.
  fail "the candidate has NO files under dashboard/ (scan returned 0 rows); refusing to report an empty scan as 'no symlinks'"
else
  SPECIAL="$(printf '%s\n' "$LS_TREE_OUT" | scan_special_modes)"
  if [[ -n "$SPECIAL" ]]; then
    while IFS= read -r finding; do [[ -z "$finding" ]] || fail "$finding"; done <<< "$SPECIAL"
  else
    ok "no symlinks or submodules among the ${LS_TREE_ROWS} entries under dashboard/"
  fi
fi

# ── 4. trading-relevant trees must be byte-identical ────────────────────────
# Compared as TREE OBJECTS, not file-by-file. A tree hash covers names, modes
# and content for the whole subtree at once, so an added file cannot slip past
# a per-file loop that only iterates over paths it already knows about.
TREE_PATHS=( scripts strategy state supabase/migrations .github/workflows )
for t in "${TREE_PATHS[@]}"; do
  a="$(git rev-parse "$BRIDGE_BASE:$t" 2>/dev/null || echo missing-base)"
  b="$(git rev-parse "$CANDIDATE:$t" 2>/dev/null || echo missing-candidate)"
  if [[ "$a" == "$b" && "$a" != missing-base ]]; then ok "tree unchanged: $t ($a)"
  else fail "tree CHANGED: $t  base=$a candidate=$b"; fi
done

BLOB_PATHS=( requirements.txt requirements.lock watchlist.json )
for f in "${BLOB_PATHS[@]}"; do
  a="$(git rev-parse "$BRIDGE_BASE:$f" 2>/dev/null || echo missing-base)"
  b="$(git rev-parse "$CANDIDATE:$f" 2>/dev/null || echo missing-candidate)"
  if [[ "$a" == "$b" && "$a" != missing-base ]]; then ok "blob unchanged: $f"
  else fail "blob CHANGED: $f  base=$a candidate=$b"; fi
done

# ── 5. migrations 0001-0023, individually ───────────────────────────────────
# The tree check above already covers this, but a per-file digest is what the
# attestation records, and it localises a failure to one migration.
MIG_MANIFEST=""
# LC_ALL=C throughout. Collation is locale-dependent, and a digest computed over
# a locale-sorted list is not a property of the tree — it is a property of the
# machine that computed it. Measured: the changed-file manifest digest below
# came out 722c768a… locally and efb3e11c… on the CI runner for the identical
# candidate, because paths like dashboard/app/(app)/settings/page.tsx collate
# differently under en_US.UTF-8 than under C. An attestation digest that cannot
# be reproduced on another host is worse than no digest, because it looks like
# one.
for m in $(git ls-tree --name-only "$CANDIDATE" supabase/migrations/ | LC_ALL=C sort); do
  a="$(git rev-parse "$BRIDGE_BASE:$m" 2>/dev/null || echo absent)"
  b="$(git rev-parse "$CANDIDATE:$m" 2>/dev/null || echo absent)"
  [[ "$a" == "$b" ]] || fail "migration changed: $m"
  MIG_MANIFEST+="$b  $m"$'\n'
done
MIG_DIGEST="$(printf '%s' "$MIG_MANIFEST" | sha256sum | cut -d' ' -f1)"
ok "migrations digest $MIG_DIGEST"

PAPER_WF_DIGEST="$(git rev-parse "$CANDIDATE:.github/workflows/paper-production.yml" 2>/dev/null || echo absent)"
PAPER_WF_BASE="$(git rev-parse "$BRIDGE_BASE:.github/workflows/paper-production.yml" 2>/dev/null || echo absent)"
[[ "$PAPER_WF_DIGEST" == "$PAPER_WF_BASE" && "$PAPER_WF_DIGEST" != absent ]] \
  && ok "paper-production workflow unchanged" \
  || fail "paper-production workflow CHANGED: base=$PAPER_WF_BASE candidate=$PAPER_WF_DIGEST"

# ── 6. the changed-file manifest, digested ──────────────────────────────────
CHANGED_MANIFEST="$(printf '%s\n' "${CHANGED[@]}" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)"
CANDIDATE_TREE="$(git rev-parse "$CANDIDATE^{tree}")"

# ── 7. verdict ──────────────────────────────────────────────────────────────
if [[ ${#FAILURES[@]} -eq 0 ]]; then RESULT=PASS; else RESULT=FAIL; fi

python3 - "$OUT" "$RESULT" "$CANDIDATE" "$CANDIDATE_TREE" "$BRIDGE_BASE" \
                 "$MIG_DIGEST" "$PAPER_WF_DIGEST" "$CHANGED_MANIFEST" \
                 "${#CHANGED[@]}" "$(printf '%s\n' "${FAILURES[@]+"${FAILURES[@]}"}" | sed '/^$/d' | paste -sd'|' -)" <<'PY'
import json, sys
out, result, cand, tree, base, mig, paper, manifest, nchanged, failures = sys.argv[1:11]
doc = {
    "gate": "dashboard-containment-gate/identity-boundary",
    "result": result,
    # The four claims that must never be confused with each other.
    "paper_promotable": False,
    "dashboard_containment_promotable": result == "PASS",
    "paper_validation_required": False,
    "paper_validation_result": "NOT_APPLICABLE",
    "strategy_identity_unchanged": result == "PASS",
    "containment_scope_valid": result == "PASS",
    "note": "NOT_APPLICABLE is not PASS. This attestation can never authorize paper-production.",
    "bridge_base_sha": base,
    "candidate_sha": cand,
    "candidate_tree_sha": tree,
    "migrations_digest": mig,
    "paper_workflow_blob": paper,
    "changed_file_manifest_digest": manifest,
    "changed_file_count": int(nchanged),
    "failures": [f for f in failures.split("|") if f],
}
with open(out, "w") as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    # Trailing newline, deliberately. Without it a $GITHUB_OUTPUT heredoc puts
    # its delimiter on the same line as the closing brace and Actions rejects
    # the whole step with "Matching delimiter not found" — after the policy has
    # already passed, which is the most confusing possible way to fail.
    fh.write("\n")
print(json.dumps(doc, indent=2, sort_keys=True))
PY

if [[ "$RESULT" != PASS ]]; then
  printf '\nIDENTITY BOUNDARY FAILED (%d finding(s))\n' "${#FAILURES[@]}"
  exit 1
fi
printf '\nIDENTITY BOUNDARY PASSED\n'
