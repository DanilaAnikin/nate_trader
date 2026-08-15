#!/usr/bin/env bash
# ============================================================================
# Phase 1E: reverting ONLY the unconditional proxy freeze must reproduce the
# original defect.
#
# The permanent freeze passes its own tests. That is necessary and not
# sufficient: a control can pass while being redundant with some other control,
# in which case the evidence proves nothing about the line that was changed.
# So this restores exactly what commit 86654b552 removed — the flag gate,
# nothing else touched — and requires the ORIGINAL failure back, in its
# original shape: 401 instead of 503, with a Supabase client constructed.
#
# Two trees, one probe, run against both. The real worktree is never modified.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH="$(cd "$HERE/../.." && pwd)"
MUTATOR="$HERE/phase1e-revert-freeze.py"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase1e.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

OK=0; BAD=0
note(){ printf '  %-6s %s\n' "$1" "$2"; }

[[ -f "$MUTATOR" ]] || { echo "missing $MUTATOR"; exit 1; }

# A source-only copy; node_modules is symlinked because the probe needs the
# real next/server and vitest, and copying it would take minutes per tree.
prepare(){
  local d="$WORK/$1"; mkdir -p "$d"
  ( cd "$DASH" && tar --exclude=node_modules --exclude=.next --exclude=.git -cf - . ) | tar -xf - -C "$d"
  ln -s "$DASH/node_modules" "$d/node_modules"
  echo "$d"
}

echo "Phase 1E — reverting the unconditional proxy freeze"
echo

BASE="$(prepare base)"
MUT="$(prepare mutated)"

# ── apply the mutation, and prove it landed ─────────────────────────────────
# A mutation that silently no-ops would make the whole comparison vacuous: the
# 'mutated' tree would just be a second copy of the artifact, and it would
# report 'frozen' for the honest reason rather than the one being tested.
python3 "$MUTATOR" "$MUT/proxy.ts" >/dev/null

if grep -q 'maintenanceFrozen()' "$MUT/proxy.ts" \
   && grep -q '!bypassPossible()' "$MUT/proxy.ts" \
   && ! grep -q 'if (isApi && MUTATING_METHODS.has(request.method)) {' "$MUT/proxy.ts"; then
  OK=$((OK+1)); note ok "mutation landed: the flag gate is back in the condition"
else
  BAD=$((BAD+1)); note NOT-OK "mutation did NOT land — every result below would be vacuous"
  echo; echo "aborting"; exit 1
fi

if diff -q "$BASE/proxy.ts" "$MUT/proxy.ts" >/dev/null; then
  BAD=$((BAD+1)); note NOT-OK "the two trees have identical proxy.ts"
  exit 1
else
  OK=$((OK+1)); note ok "the two trees differ"
fi

# Nothing but proxy.ts may differ, or the comparison measures more than the
# freeze. This is the 'reverting ONLY' half of the requirement.
# diff exits 1 for "they differ", which is the expected case here — so the
# status is inspected rather than discarded. >1 means diff itself failed, and
# an unread tree must not be reported as an unchanged one.
set +e
DIFFOUT="$(diff -rq --exclude=node_modules --exclude=.next "$BASE" "$MUT" 2>&1)"
DIFFRC=$?
set -e
if (( DIFFRC > 1 )); then
  BAD=$((BAD+1)); note NOT-OK "diff failed (rc=$DIFFRC) — cannot establish what differs"
  echo "$DIFFOUT" | head -5
  exit 1
fi
CHANGED="$(printf '%s\n' "$DIFFOUT" | sed -n 's/^Files .* and \(.*\) differ$/\1/p' \
           | xargs -r -n1 basename | LC_ALL=C sort -u | tr '\n' ' ')"
if [[ "$CHANGED" == "proxy.ts " ]]; then
  OK=$((OK+1)); note ok "only proxy.ts differs between the trees"
else
  BAD=$((BAD+1)); note NOT-OK "more than proxy.ts differs: $CHANGED"
fi

# ── run the same probe against both ─────────────────────────────────────────
run_probe(){ # <tree> <expect>
  ( cd "$1" && PHASE1E_EXPECT="$2" npx vitest run test/containment/phase1e-edge-probe.test.ts ) \
    >"$1/probe.log" 2>&1
}

if run_probe "$BASE" frozen; then
  OK=$((OK+1)); note ok "artifact as it stands: 503 FROZEN_CONTAINMENT_BRIDGE, 0 clients constructed"
else
  BAD=$((BAD+1)); note NOT-OK "the current artifact did not refuse at the edge"
  sed -n '/FAIL\|AssertionError/,+3p' "$BASE/probe.log" | head -20
fi

if run_probe "$MUT" defect; then
  OK=$((OK+1)); note ok "freeze reverted: 401 UNAUTHENTICATED, 1 client constructed — DEFECT REPRODUCED"
else
  BAD=$((BAD+1)); note NOT-OK "reverting the freeze did NOT reproduce the defect"
  sed -n '/FAIL\|AssertionError/,+3p' "$MUT/probe.log" | head -20
fi

# ── the cross-check that catches a probe asserting nothing ──────────────────
# If the probe passed in BOTH directions against the SAME tree, it is not
# reading the tree at all.
if ( cd "$BASE" && PHASE1E_EXPECT=defect npx vitest run test/containment/phase1e-edge-probe.test.ts ) \
     >"$BASE/cross.log" 2>&1; then
  BAD=$((BAD+1)); note NOT-OK "the probe reports 'defect' against the UNMUTATED tree — it is not reading the code"
else
  OK=$((OK+1)); note ok "the probe distinguishes the trees (defect expectation fails on the artifact)"
fi

echo
echo "phase 1E: $OK ok, $BAD not-ok"
[[ $BAD -eq 0 ]] && { echo "PHASE 1E GREEN — the unconditional freeze is load-bearing"; exit 0; } \
                 || { echo "PHASE 1E RED"; exit 1; }
