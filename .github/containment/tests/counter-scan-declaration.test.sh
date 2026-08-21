#!/usr/bin/env bash
# ============================================================================
# counter-scan-declaration.test.sh — a classifier must SAY whether it scans
#
# WHAT THIS CLOSES
# ----------------
# `catalogue-classify.sh` required `schema_scan.kinds` to hold at least two
# entries from EVERY classifier it ran, so that "no findings printed" could
# never mean "this build has no counter-scan". Right for the shipped
# classifier; fatal for `tests/naive-oracle.sql`, the name-only straw man that
# models the OLD harness and performs no counter-scan on purpose. Every
# straw-man cell — both pristine runs included — exited 2, and the mutation
# suite (correctly) refuses to score a driver refusal as "the straw man is
# blind to this mutant". The load-bearing "the strong classifier buys
# something" demonstration therefore could not run at all.
#
# The fix is NOT to let the straw man emit an empty scan: an absent
# counter-scan reading as a clean counter-scan is the exact failure the rule
# exists to prevent. The fix is a DECLARATION with three distinct consequences,
# asserted here one by one, each by its exact reason string:
#
#   D1  counter_scan_declared: true  + >= 2 scan kinds -> CERTIFYING, exit 0
#   D2  counter_scan_declared: true  + 1 scan kind     -> exit 2, "declares a
#       whole-schema counter-scan and reported 1 scan kind(s)"
#   D3  counter_scan_declared: true  + no schema_scan  -> exit 2, same class
#   D4  key absent entirely                            -> exit 2, "does not
#       declare whether it performs a whole-schema counter-scan". This is the
#       case a build that silently dropped its schema_scan block lands in.
#   D5  counter_scan_declared: false, non-default classifier -> exit 0,
#       NON_CERTIFYING. This is the straw man, and it is what unblocks it.
#   D6  counter_scan_declared: false, DEFAULT classifier -> exit 2, "the
#       shipped classifier declares counter_scan_declared=false". The escape
#       hatch must not be reachable by the thing being certified.
#   D7  a non-boolean declaration is UNDECLARED, not truthy — `"true"`,
#       `1` and `null` must not buy certification.
#   D8  malformed JSON is refused, not treated as an absent declaration.
#
#   C1  POSITIVE CONTROL on this file's own matcher, run before any assertion
#       that depends on it.
#   C2  the two classifiers that ship here really do declare: the shipped one
#       `true`, the straw man `false`. Without this the six cases above test a
#       decision function nothing calls.
#
# No docker, no database: the decision is reached from a JSON document, and
# `--check-counter-scan-declaration` runs the SAME function the real parse
# stage calls over a file. A contract test that needs a 25-minute clone is a
# contract test that will not be run.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="$(cd "${HERE}/.." && pwd)"
DRIVER="${CC}/catalogue-classify.sh"
[[ -x "$DRIVER" ]] || { printf 'no driver at %s\n' "$DRIVER" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rc=0
pass() { printf '   \033[1;32mgreen\033[0m %s\n' "$*"; }
fail() { printf '   \033[1;31mRED\033[0m   %s\n' "$*" >&2; rc=1; }
hdr()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }

says() { grep -qF -- "$2" <<< "$1"; }

# doc name, is-default(yes|no), json -> sets GOT_RC and GOT_OUT
probe() {
  local name="$1" isdef="$2" json="$3" f="$WORK/$1.json"
  printf '%s' "$json" > "$f"
  set +e
  GOT_OUT="$("$DRIVER" --generation latest \
      --check-counter-scan-declaration "$f" \
      --check-is-default-classifier "$isdef" 2>&1)"
  GOT_RC=$?
  set -e
}

# expect: name, is-default, json, want-rc, want-decision, want-needle
expect() {
  local name="$1" isdef="$2" json="$3" wrc="$4" wdec="$5" needle="$6"
  probe "$name" "$isdef" "$json"
  local why=""
  [[ "$GOT_RC" == "$wrc" ]] || why="${why} [exit ${GOT_RC}, wanted ${wrc}]"
  says "$GOT_OUT" "decision: ${wdec}" || why="${why} [decision line is not '${wdec}']"
  if [[ -n "$needle" ]]; then
    says "$GOT_OUT" "$needle" || why="${why} [the reason string is not '${needle}']"
  fi
  if [[ -n "$why" ]]; then
    fail "${name}:${why}"
    printf '%s\n' "$GOT_OUT" | sed -n '1,8p' | sed 's/^/         /' >&2
  else
    pass "${name}: exit ${wrc}, ${wdec}${needle:+, and the exact reason}"
  fi
}

TWO_KINDS='{"kind":"client_surface","observed":[],"pinned":[]},{"kind":"vault_reacher","observed":[],"pinned":[]}'

# ---------------------------------------------------------------------------
hdr "C1. positive control on this file's own matcher"
if says "decision: CERTIFYING" "decision: CERTIFYING" \
   && ! says "decision: CERTIFYING" "decision: NON_CERTIFYING"; then
  pass "the matcher finds a planted string and refuses one that is absent"
else
  fail "the matcher is broken; every assertion below is void"
  exit 1
fi

# ---------------------------------------------------------------------------
hdr "D1-D3. a classifier that CLAIMS a counter-scan must have produced one"
expect d1 no  "{\"counter_scan_declared\":true,\"schema_scan\":{\"kinds\":[${TWO_KINDS}]}}" \
  0 CERTIFYING ""
expect d2 no  '{"counter_scan_declared":true,"schema_scan":{"kinds":[{"kind":"client_surface"}]}}' \
  2 "CLAIMED_BUT_EMPTY:1" "reported 1 scan kind(s); 2 are required"
expect d3 no  '{"counter_scan_declared":true}' \
  2 "CLAIMED_BUT_EMPTY:0" "an absent counter-scan must never read as a clean counter-scan"

# ---------------------------------------------------------------------------
hdr "D4. silence is refused — this is the stripped-build case"
expect d4 no  "{\"schema_scan\":{\"kinds\":[${TWO_KINDS}]}}" \
  2 UNDECLARED "does not declare whether it performs a whole-schema counter-scan"

# ---------------------------------------------------------------------------
hdr "D5/D6. declaring FALSE is allowed for a straw man and refused for the gate"
expect d5 no  '{"gate":"straw man","counter_scan_declared":false}' \
  0 NON_CERTIFYING ""
if says "$GOT_OUT" "non_certifying_run: 1"; then
  pass "d5: the run is marked non-certifying, so its PASS can be labelled"
else
  fail "d5: the non-certifying flag was not set"
fi
expect d6 yes '{"counter_scan_declared":false}' \
  2 NON_CERTIFYING "the shipped classifier declares counter_scan_declared=false"

# ---------------------------------------------------------------------------
hdr "D7. a non-boolean declaration is not a declaration"
expect d7a no '{"counter_scan_declared":"true","schema_scan":{"kinds":[1,2]}}' \
  2 UNDECLARED "does not declare whether"
expect d7b no '{"counter_scan_declared":1,"schema_scan":{"kinds":[1,2]}}' \
  2 UNDECLARED "does not declare whether"
expect d7c no '{"counter_scan_declared":null}' \
  2 UNDECLARED "does not declare whether"

# ---------------------------------------------------------------------------
hdr "D8. malformed JSON is refused, not read as an absent declaration"
expect d8 no '{"counter_scan_declared":true,' \
  2 UNPARSEABLE "no parseable schema_scan declaration"

# ---------------------------------------------------------------------------
hdr "C2. the two shipped classifiers really do declare"
# The cases above exercise a decision function. This exercises the thing the
# decision is about: without it, both classifiers could have lost the key and
# every case above would still be green.
check_declares() {  # file, want (true|false)
  local f="$1" want="$2" got
  if ! got="$(grep -oE "'counter_scan_declared',[[:space:]]*(true|false)" "$f" | head -1)"; then
    fail "$(basename "$f") publishes no counter_scan_declared key at all"
    return
  fi
  if [[ "$got" == *"$want"* ]]; then
    pass "$(basename "$f") declares counter_scan_declared ${want}"
  else
    fail "$(basename "$f") declares ${got}, expected ${want}"
  fi
}
check_declares "${CC}/catalogue-classify.sql" true
check_declares "${HERE}/naive-oracle.sql"     false
# ...and the driver must actually reach the enforcement from its parse stage,
# not only from the test seam. Asserted on the source, because reaching it for
# real needs a database.
if grep -q 'enforce_counter_scan_declaration "\$SCAN_DECISION" "\$CLASSIFIER_IS_DEFAULT"' "$DRIVER"; then
  pass "the parse stage calls the same enforcement this file drives through the seam"
else
  fail "the parse stage does not call enforce_counter_scan_declaration; the seam tests nothing"
fi

printf '\n'
if [[ "$rc" -eq 0 ]]; then
  printf '\033[1;32mCOUNTER-SCAN DECLARATION GREEN\033[0m  a classifier must say, and the gate may not opt out.\n'
else
  printf '\033[1;31mCOUNTER-SCAN DECLARATION RED\033[0m\n'
fi
exit "$rc"
