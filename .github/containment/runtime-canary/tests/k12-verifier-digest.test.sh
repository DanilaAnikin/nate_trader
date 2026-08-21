#!/usr/bin/env bash
# ============================================================================
# k12-verifier-digest.test.sh — the verifier's own pin, and what it really covers
#
# WHAT THIS CLOSES (audit finding B8(i), and a gap found while closing it)
# ------------------------------------------------------------------------
# B8(i) was "TRUSTED_DIGEST is computed and printed, and nothing refuses an
# edited verifier". run.sh now compares it with expected/trusted-digest.txt and
# exits 3 on a mismatch. But the comment above that computation said it covered
# "every executable and every expectation in this directory", and it did not:
# the glob was .sh/.mjs/.cjs/.sql/.json/.sha256*, and SIX expectation files kept
# as .txt were outside it —
#
#     expected/tombstone-state.0008.txt      expected/tombstone-state.0023.txt
#     sensor/expected/sensor-objects.0008.txt sensor/expected/sensor-objects.0023.txt
#     sql/expected-baseline.0008.txt          sql/expected-baseline.0023.txt
#
# Editing any of them changed what the harness would ACCEPT while the run still
# printed "verifier digest : matches expected/trusted-digest.txt". Measured
# directly: under the old glob, appending a newline to
# expected/tombstone-state.0008.txt left the digest bit-for-bit identical.
#
# A pin whose stated coverage is wider than its real coverage is worse than no
# pin, because the banner is believed. So this file does not test "the digest
# exists". It tests, file by file, that every input the harness reads to decide
# an outcome is INSIDE the digest, and that the two documented exclusions are
# exclusions on purpose.
#
#   P1  the digest is a 64-hex string and matches the recorded pin
#   P2  COVERAGE, named file by named file: editing each of the six .txt
#       expectations, and one file of each covered code extension, MUST move
#       the digest. This is the positive control the old glob would have failed.
#   P2b COVERAGE, EXHAUSTIVELY. P2's list is hand-written, and a hand-written
#       list cannot notice a file nobody thought of. Every file in the tree is
#       therefore probed one at a time, and the set that does NOT move the
#       digest must be exactly the two exclusions run.sh documents — compared
#       in both directions, so a documented exclusion that is secretly inside
#       the digest is also a failure.
#   P3  the digest is CONTENT-addressed: a byte-identical copy at a different
#       path computes the same value. It used to hash absolute paths, so two
#       identical checkouts disagreed for no content reason.
#   N1  the pin file itself is NOT in the digest — no tail-chasing
#   N2  *.md is NOT in the digest, which is the documented scope; if that ever
#       changes, the documentation and this assertion must change together
#   E1  ENFORCEMENT, actually executed: a copy with one byte changed and the pin
#       left alone must exit 3 with the exact refusal, and a copy with the pin
#       file deleted must exit 3 with the exact "records no expected verifier
#       digest" message. Not "some non-zero exit".
#   C1  positive control on E1's own reachability: the same invocation against
#       an UNdoctored copy must NOT produce that refusal, so E1 is not passing
#       because every invocation prints it.
#
# No container, no database, no bridge checkout: the digest check runs
# immediately after argument parsing, which is what makes this testable at all.
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANARY="$(cd "${HERE}/.." && pwd)"
RUNNER="${CANARY}/run.sh"
PIN="${CANARY}/expected/trusted-digest.txt"
[[ -x "$RUNNER" ]] || { printf 'k12: no run.sh at %s\n' "$RUNNER" >&2; exit 2; }

WORK="$(mktemp -d)"
cleanup() {
  local __rc=$?
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk12: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$__rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( __rc == 0 ? 2 : __rc ))"
  fi
}
trap cleanup EXIT

rc=0
# ---------------------------------------------------------------------------
# THIS SUITE HAD NO SELF-ACCOUNTING.
#
# It printed "K12 GREEN" whenever nothing that ran objected — which is not the
# same as everything running. Deleting a case, or an early exit inside one,
# removed a green line and changed nothing else. k11's own header records
# measuring exactly that shape on itself. So the case token is now an explicit
# FIRST ARGUMENT to pass/fail rather than a word in the prose, the reported set
# is reconciled against a closed set, and an EXIT trap turns "died before the
# summary" into a harness failure rather than a short list.
# ---------------------------------------------------------------------------
CASES_INTENDED=(P1 P2 P2b P3 N1 N2 C1 E1 E2)
CASES_SEEN=()
COMPLETED=0
pass() { CASES_SEEN+=("$1"); printf '   \033[1;32mgreen\033[0m %s %s\n' "$1" "${*:2}"; }
fail() { CASES_SEEN+=("$1"); printf '   \033[1;31mRED\033[0m   %s %s\n' "$1" "${*:2}" >&2; rc=1; }
hdr()  { printf '\n\033[1m-- %s\033[0m\n' "$*"; }

digest_of() { ( cd "$1" && ./run.sh --print-trusted-digest ); }

fresh_copy() {  # dest
  rm -rf "$1"; cp -a "$CANARY" "$1"
}

# ---------------------------------------------------------------------------
hdr "P1. the digest is well formed and matches the recorded pin"
D="$(digest_of "$CANARY")"
if [[ ! "$D" =~ ^[0-9a-f]{64}$ ]]; then
  fail P1 "the computed digest is not 64 hex characters: ${D}"
elif [[ ! -f "$PIN" ]]; then
  fail P1 "there is no pin at ${PIN}"
elif [[ "$D" != "$(tr -d '[:space:]' < "$PIN")" ]]; then
  fail P1 "the working tree does not match its own pin"
  fail P1 "  computed: ${D}"
  fail P1 "  pinned  : $(tr -d '[:space:]' < "$PIN")"
  fail P1 "  re-record it DELIBERATELY: ./run.sh --print-trusted-digest > expected/trusted-digest.txt"
else
  pass P1 "64-hex, and the tree matches expected/trusted-digest.txt"
fi

# ---------------------------------------------------------------------------
hdr "P2. every input the harness decides an outcome from is inside the digest"
BASE="$WORK/base"; fresh_copy "$BASE"
BASE_D="$(digest_of "$BASE")"
if [[ "$BASE_D" != "$D" ]]; then
  fail P2 "a copy of the tree already disagrees with the original; P2 cannot be trusted"
fi

MUST_COVER=(
  "expected/tombstone-state.0008.txt"
  "expected/tombstone-state.0023.txt"
  "sensor/expected/sensor-objects.0008.txt"
  "sensor/expected/sensor-objects.0023.txt"
  "sql/expected-baseline.0008.txt"
  "sql/expected-baseline.0023.txt"
  "expected/request-manifest.json"
  "expected/00_env_bootstrap.sha256"
  "run.sh"
  "driver/verdict.mjs"
  # The two files audit finding D added. Every in-process claim is now decided
  # by observers.mjs from the image's own log, and observation.mjs is the
  # derivation both the driver and the verdict compute an attestation with; an
  # edit to either changes what a PASS means.
  "driver/observers.mjs"
  "driver/observation.mjs"
  # Round-7 audit: the one JSONL reader k14's planting helpers use. It decides
  # whether a corrupt --full-out is REPORTED by the suite or kills it in its
  # first planter, so an edit to it changes what "28 passed" means.
  "tests/k14-jsonl.cjs"
  "driver/drive.mjs"
  # Round-8 audit: the closed claim schema is also where the data plane is
  # DEFINED. classifyGatewayPath and GATEWAY_CLASS_READERS decide which
  # Supabase surface each gateway row is on and which claim reads it, so an
  # edit to this file changes what every noAuthCall/noPostgRESTCall/
  # noDatabaseCall/noVaultCall/noUnexpectedNetworkCall row means.
  "driver/claims.mjs"
  "sink/sink.mjs"
  "instrument/instrument.cjs"
  "sql/20_canary_install.sql"
)
uncovered=""
absent=""
for f in "${MUST_COVER[@]}"; do
  C="$WORK/c"; fresh_copy "$C"
  if [[ ! -f "$C/$f" ]]; then absent="${absent} ${f}"; continue; fi
  printf '\n-- k12 coverage probe\n' >> "$C/$f"
  if [[ "$(digest_of "$C")" == "$BASE_D" ]]; then uncovered="${uncovered} ${f}"; fi
done
rm -rf "$WORK/c"
if [[ -n "$absent" ]]; then
  fail P2 "these files are named by this test but do not exist (the list is stale):${absent}"
fi
if [[ -n "$uncovered" ]]; then
  fail P2 "OUTSIDE the verifier digest, so an edit to them is invisible:${uncovered}"
else
  pass P2 "all ${#MUST_COVER[@]} named inputs move the digest when edited — including the six"
  pass P2 "  .txt expectations the old glob was blind to"
fi

# ---------------------------------------------------------------------------
hdr "P2b. EVERY file in the tree, not twelve chosen by hand"
# MUST_COVER above is a hand-written list, and a hand-written list is checked
# against nothing: it names the six .txt expectations the old glob missed
# because someone already knew about them. A file added later with an
# extension outside the glob — a .py helper, a .yaml expectation, a Dockerfile
# — would sit outside the digest and no assertion above would notice, which is
# the same "roster checked only against itself" defect this programme keeps
# finding. So the FILESYSTEM is enumerated: every file must move the digest
# except the two the scope statement in run.sh names as deliberate exclusions.
EXPECTED_OUTSIDE=(
  "README.md"                      # documentation: does not change what is accepted
  "expected/trusted-digest.txt"    # the pin itself: it cannot hash its own tail
)
outside=()
probed=0
while IFS= read -r f; do
  C="$WORK/x"; fresh_copy "$C"
  printf '\n-- k12 exhaustive probe\n' >> "$C/$f"
  probed=$(( probed + 1 ))
  [[ "$(digest_of "$C")" == "$BASE_D" ]] && outside+=("$f")
done < <(cd "$BASE" && find . -type f -printf '%P\n' | LC_ALL=C sort)
rm -rf "$WORK/x"
# The two sets, compared in BOTH directions.
unexpected=(); missing_exclusion=()
for f in "${outside[@]}"; do
  known=0
  for e in "${EXPECTED_OUTSIDE[@]}"; do [[ "$e" == "$f" ]] && known=1; done
  [[ "$known" -eq 1 ]] || unexpected+=("$f")
done
for e in "${EXPECTED_OUTSIDE[@]}"; do
  found=0
  for f in "${outside[@]}"; do [[ "$e" == "$f" ]] && found=1; done
  [[ "$found" -eq 1 ]] || missing_exclusion+=("$e")
done
if [[ "$probed" -lt 20 ]]; then
  fail P2b "only ${probed} files were probed; an exhaustive scan over almost nothing proves nothing"
elif [[ "${#unexpected[@]}" -gt 0 ]]; then
  fail P2b "${#unexpected[@]} file(s) are OUTSIDE the digest and are not a documented exclusion: ${unexpected[*]}"
  fail P2b "  either bring them inside compute_trusted_digest, or name them in run.sh's scope statement AND here"
elif [[ "${#missing_exclusion[@]}" -gt 0 ]]; then
  fail P2b "these are documented as excluded but are in fact INSIDE the digest: ${missing_exclusion[*]} — the documentation and the code disagree"
else
  pass P2b "all ${probed} files in the tree were probed one at a time; exactly ${#outside[@]} are outside the digest, and they are the two documented exclusions"
fi

# ---------------------------------------------------------------------------
hdr "P3. the digest is content-addressed, not path-addressed"
ELSEWHERE="$WORK/somewhere/else/entirely"; mkdir -p "$(dirname "$ELSEWHERE")"
fresh_copy "$ELSEWHERE"
if [[ "$(digest_of "$ELSEWHERE")" == "$D" ]]; then
  pass P3 "a byte-identical copy at a different absolute path computes the same digest"
else
  fail P3 "the digest depends on where the tree lives; it is not content-addressed"
fi

# ---------------------------------------------------------------------------
hdr "N1/N2. the two documented exclusions are exclusions on purpose"
C="$WORK/n1"; fresh_copy "$C"
printf 'deadbeef\n' >> "$C/expected/trusted-digest.txt"
if [[ "$(digest_of "$C")" == "$BASE_D" ]]; then
  pass N1 "the pin file is not part of what it pins — no tail-chasing"
else
  fail N1 "the pin file is inside the digest; it can never match itself"
fi
C="$WORK/n2"; fresh_copy "$C"
printf '\nan added documentation line\n' >> "$C/README.md"
if [[ "$(digest_of "$C")" == "$BASE_D" ]]; then
  pass N2 "*.md is outside the digest, exactly as the scope statement in run.sh says"
else
  fail N2 "*.md moved the digest; run.sh documents the opposite, so one of them is wrong"
fi

# ---------------------------------------------------------------------------
hdr "E1/C1. the refusal is executed, and asserted by its exact wording"
MISMATCH_MSG="the harness in this checkout is NOT the one expected/trusted-digest.txt pins:"
NOPIN_MSG="this checkout records no expected verifier digest"

try_run() {  # dir -> prints "rc<TAB>output"
  local d="$1" out r
  set +e
  out="$( cd "$d" && ./run.sh --target-root /nonexistent-k12-target 2>&1 )"
  r=$?
  set -e
  printf '%s\t%s' "$r" "$out"
}

# C1 FIRST: an undoctored copy must NOT produce the refusal, or E1 proves nothing.
C="$WORK/e1ctl"; fresh_copy "$C"
ctl="$(try_run "$C")"
if grep -qF -- "$MISMATCH_MSG" <<< "${ctl#*	}"; then
  fail C1 "an UNdoctored copy already prints the mismatch refusal; E1 below is vacuous"
else
  pass C1 "an undoctored copy does not print the mismatch refusal"
fi

C="$WORK/e1a"; fresh_copy "$C"
printf '\n# k12 tamper\n' >> "$C/driver/verdict.mjs"
res="$(try_run "$C")"; r="${res%%	*}"; out="${res#*	}"
if [[ "$r" == 3 ]] && grep -qF -- "$MISMATCH_MSG" <<< "$out"; then
  pass E1 "one edited harness file -> exit 3 with the exact mismatch refusal"
else
  fail E1 "an edited harness file gave exit ${r} without the exact refusal"
  printf '%s\n' "$out" | sed -n '1,12p' >&2
fi

C="$WORK/e1b"; fresh_copy "$C"
rm -f "$C/expected/trusted-digest.txt"
res="$(try_run "$C")"; r="${res%%	*}"; out="${res#*	}"
if [[ "$r" == 3 ]] && grep -qF -- "$NOPIN_MSG" <<< "$out"; then
  pass E2 "a missing pin -> exit 3 saying so; an absent pin is never an absent problem"
else
  fail E2 "a missing pin gave exit ${r} without the exact message"
  printf '%s\n' "$out" | sed -n '1,12p' >&2
fi

# --- the closed-set check on this suite's own coverage -----------------------
missing_cases=()
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && { found=1; break; }; done
  [[ "$found" -eq 1 ]] || missing_cases+=("$c")
done
unknown_cases=()
for s in "${CASES_SEEN[@]}"; do
  known=0
  for c in "${CASES_INTENDED[@]}"; do [[ "$c" == "$s" ]] && { known=1; break; }; done
  [[ "$known" -eq 1 ]] || unknown_cases+=("$s")
done
if [[ "${#missing_cases[@]}" -ne 0 ]]; then
  printf '   \033[1;31mRED\033[0m   COVERAGE these intended cases never reported: %s\n' "${missing_cases[*]}" >&2
  rc=1
fi
if [[ "${#unknown_cases[@]}" -ne 0 ]]; then
  printf '   \033[1;31mRED\033[0m   COVERAGE these cases reported but are not in CASES_INTENDED: %s\n' "${unknown_cases[*]}" >&2
  rc=1
fi
DISTINCT_SEEN="$(printf '%s\n' "${CASES_SEEN[@]}" | LC_ALL=C sort -u | wc -l)"
COMPLETED=1

printf '\n'
if [[ "$rc" -eq 0 ]]; then
  printf '\033[1;32mK12 GREEN\033[0m  the verifier pin covers what it says it covers, and refuses (%s of %s intended cases reported).\n' \
    "$DISTINCT_SEEN" "${#CASES_INTENDED[@]}"
else
  printf '\033[1;31mK12 RED\033[0m  (%s of %s intended cases reported)\n' "$DISTINCT_SEEN" "${#CASES_INTENDED[@]}"
fi
exit "$rc"
