#!/usr/bin/env bash
# ============================================================================
# k3-reuse-guard.test.sh — the reuse guard must compare two different things
#
# Every case here asserts the EXACT reason code, never merely "non-zero". A
# guard that crashed on startup would exit non-zero for all ten and a
# status-only test would call that a pass.
#
# Case P is the positive control: with everything honest the guard must succeed
# and print the digest. Without it, "refuse everything" scores ten out of ten.
#
# The fixtures are throwaway git repositories built under /tmp; no checkout the
# operator cares about is touched.
#
# Exit: 0 all cases behaved, 1 otherwise.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="${HERE}/../reuse-guard.sh"

WORK="$(mktemp -d /tmp/nt-k3-XXXXXX)"
# ---------------------------------------------------------------------------
# THIS SUITE HAD NO SELF-ACCOUNTING.
#
# `rc=0` meant "nothing that ran objected", not "everything ran": deleting a
# case, or an early `exit` in the middle of one, left a SHORTER "N passed, 0
# failed" and nothing anywhere saying a case had gone. k11's own header records
# measuring exactly that on itself — deleting its N2 block left it printing
# "K11 GREEN" over ten of eleven cases. A count is not a roster.
#
# So the case tokens are a closed set, every ok/bad records the token it
# reported, the reported set is reconciled against the closed set at the end,
# and an EXIT trap turns "died before the summary" into a harness failure.
# ---------------------------------------------------------------------------
CASES_INTENDED=(P 1 2 3 4 5 6 7 8 9 10 11 12)
CASES_SEEN=()
COMPLETED=0
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }

cleanup() {
  local __rc=$?
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk3: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$__rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( __rc == 0 ? 2 : __rc ))"
  fi
}
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }

REL_FILE="dashboard/test/schema-compat/sql/00_env_bootstrap.sql"
REL_DIGEST="harness/expected/00_env_bootstrap.sha256"

# --- fixtures ---------------------------------------------------------------
build_fixture() {  # $1 = base dir -> creates $1/trusted and $1/target
  local base="$1"
  rm -rf "$base"; mkdir -p "$base"

  mkdir -p "$base/target/$(dirname "$REL_FILE")"
  printf -- '-- the canonical bootstrap, on the bridge branch\ncreate schema if not exists storage;\n' \
    > "$base/target/$REL_FILE"
  git -C "$base/target" init -q .
  git -C "$base/target" -c user.email=t@x -c user.name=t add -A
  git -C "$base/target" -c user.email=t@x -c user.name=t commit -qm target

  mkdir -p "$base/trusted/$(dirname "$REL_DIGEST")"
  sha256sum "$base/target/$REL_FILE" | cut -d' ' -f1 > "$base/trusted/$REL_DIGEST"
  git -C "$base/trusted" init -q .
  git -C "$base/trusted" -c user.email=t@x -c user.name=t add -A
  git -C "$base/trusted" -c user.email=t@x -c user.name=t commit -qm trusted
}

run_guard() {  # trusted-root trusted-sha target-root target-sha [extra args...]
  local tr="$1" ts="$2" ta="$3" tas="$4"; shift 4
  set +e
  "$GUARD" --label bootstrap \
    --trusted-root "$tr" --trusted-sha "$ts" \
    --target-root "$ta"  --target-sha "$tas" \
    --file "$REL_FILE" --digest-file "$REL_DIGEST" "$@" 2>&1
  local rc=$?
  set -e
  printf '__RC__%s\n' "$rc"
}

expect_code() {  # label, expected-reason-code, output-blob
  local label="$1" want="$2" out="$3" rc
  rc="$(sed -n 's/^__RC__//p' <<< "$out")"
  out="$(grep -v '^__RC__' <<< "$out" || true)"
  if [[ "$rc" == "0" ]]; then
    bad "$label: exited 0; expected refusal REUSE_FAIL=$want"
    printf '%s\n' "$out" | sed 's/^/       /'
    return
  fi
  if ! grep -Fq "REUSE_FAIL=$want" <<< "$out"; then
    bad "$label: rc=$rc but not REUSE_FAIL=$want"
    printf '%s\n' "$out" | sed 's/^/       /'
    return
  fi
  ok "$label -> REUSE_FAIL=$want (rc=$rc)"
}

printf '\n== K3 reuse guard: two physically distinct checkouts ==\n\n'

B="$WORK/f"; build_fixture "$B"
TRU="$B/trusted"; TAR="$B/target"
TS="$(git -C "$TRU" rev-parse HEAD)"; AS="$(git -C "$TAR" rev-parse HEAD)"

# --- P. POSITIVE CONTROL ----------------------------------------------------
out="$(run_guard "$TRU" "$TS" "$TAR" "$AS")"
rc="$(sed -n 's/^__RC__//p' <<< "$out")"
if [[ "$rc" == "0" ]] && grep -q '^REUSE_OK bootstrap ' <<< "$out"; then
  ok "P positive control: honest fixture accepted ($(grep '^REUSE_OK' <<< "$out" | awk '{print substr($4,1,16)}'))"
else
  bad "P positive control: an honest fixture was refused (rc=$rc)"
  printf '%s\n' "$out" | sed 's/^/       /'
fi

# --- 1. missing canonical ---------------------------------------------------
B1="$WORK/f1"; build_fixture "$B1"
rm -f "$B1/target/$REL_FILE"
expect_code "1 canonical file absent from the target checkout" CANONICAL_MISSING \
  "$(run_guard "$B1/trusted" "$(git -C "$B1/trusted" rev-parse HEAD)" "$B1/target" "$(git -C "$B1/target" rev-parse HEAD)")"

# --- 2. the expected digest resolving into the target -----------------------
B2="$WORK/f2"; build_fixture "$B2"
ln -sfn "$B2/target/$REL_FILE.digest" "$B2/trusted/$REL_DIGEST"
sha256sum "$B2/target/$REL_FILE" | cut -d' ' -f1 > "$B2/target/$REL_FILE.digest"
expect_code "2 the expected digest resolves into the TARGET checkout" EXPECTED_SOURCE_UNTRUSTED \
  "$(run_guard "$B2/trusted" "$(git -C "$B2/trusted" rev-parse HEAD)" "$B2/target" "$(git -C "$B2/target" rev-parse HEAD)")"

# --- 3. same inode (the two roots are the same directory) -------------------
B3="$WORK/f3"; build_fixture "$B3"
mkdir -p "$B3/both/$(dirname "$REL_FILE")" "$B3/both/$(dirname "$REL_DIGEST")"
cp "$B3/target/$REL_FILE" "$B3/both/$REL_FILE"
sha256sum "$B3/both/$REL_FILE" | cut -d' ' -f1 > "$B3/both/$REL_DIGEST"
git -C "$B3/both" init -q .
git -C "$B3/both" -c user.email=t@x -c user.name=t add -A
git -C "$B3/both" -c user.email=t@x -c user.name=t commit -qm both
BS="$(git -C "$B3/both" rev-parse HEAD)"
# a symlinked alias so the two arguments are different STRINGS
ln -sfn "$B3/both" "$B3/both-alias"
expect_code "3 both roots are the same directory behind an alias" TRUSTED_ROOT_IS_TARGET \
  "$(run_guard "$B3/both-alias" "$BS" "$B3/both" "$BS")"

# --- 4. symlink substitution of the reused file -----------------------------
B4="$WORK/f4"; build_fixture "$B4"
printf -- '-- somebody ELSE bootstrap\n' > "$WORK/outside-bootstrap.sql"
ln -sfn "$WORK/outside-bootstrap.sql" "$B4/target/$REL_FILE"
expect_code "4 the reused file is a symlink out of the target checkout" CANONICAL_ESCAPES_TARGET \
  "$(run_guard "$B4/trusted" "$(git -C "$B4/trusted" rev-parse HEAD)" "$B4/target" "$(git -C "$B4/target" rev-parse HEAD)")"

# --- 5. modified canonical (the target's file changed) ----------------------
B5="$WORK/f5"; build_fixture "$B5"
printf -- '\n-- drift introduced in the bridge checkout\n' >> "$B5/target/$REL_FILE"
expect_code "5 the target's canonical file drifted" CANONICAL_DRIFT \
  "$(run_guard "$B5/trusted" "$(git -C "$B5/trusted" rev-parse HEAD)" "$B5/target" "$(git -C "$B5/target" rev-parse HEAD)")"

# --- 6. modified trusted expectation ---------------------------------------
B6="$WORK/f6"; build_fixture "$B6"
printf '%064d\n' 0 > "$B6/trusted/$REL_DIGEST"
expect_code "6 the trusted checkout's recorded digest changed" CANONICAL_DRIFT \
  "$(run_guard "$B6/trusted" "$(git -C "$B6/trusted" rev-parse HEAD)" "$B6/target" "$(git -C "$B6/target" rev-parse HEAD)")"

# --- 7. candidate-supplied digest ------------------------------------------
B7="$WORK/f7"; build_fixture "$B7"
expect_code "7 a digest passed as an argument" CANDIDATE_SUPPLIED_DIGEST \
  "$(run_guard "$B7/trusted" "$(git -C "$B7/trusted" rev-parse HEAD)" "$B7/target" "$(git -C "$B7/target" rev-parse HEAD)" \
      --expected-digest "$(sha256sum "$B7/target/$REL_FILE" | cut -d' ' -f1)")"

# --- 8. missing digest ------------------------------------------------------
B8="$WORK/f8"; build_fixture "$B8"
rm -f "$B8/trusted/$REL_DIGEST"
expect_code "8 the trusted checkout states no digest" EXPECTED_DIGEST_MISSING \
  "$(run_guard "$B8/trusted" "$(git -C "$B8/trusted" rev-parse HEAD)" "$B8/target" "$(git -C "$B8/target" rev-parse HEAD)")"

# --- 9. stale trusted ref ---------------------------------------------------
B9="$WORK/f9"; build_fixture "$B9"
STALE_TS="$(git -C "$B9/trusted" rev-parse HEAD)"
printf -- '-- a later trusted commit\n' > "$B9/trusted/NOTES.md"
git -C "$B9/trusted" -c user.email=t@x -c user.name=t add -A
git -C "$B9/trusted" -c user.email=t@x -c user.name=t commit -qm later
expect_code "9 the caller asserted a stale trusted commit" TRUSTED_REF_STALE \
  "$(run_guard "$B9/trusted" "$STALE_TS" "$B9/target" "$(git -C "$B9/target" rev-parse HEAD)")"

# --- 10. wrong checked-out SHA on the target -------------------------------
B10="$WORK/f10"; build_fixture "$B10"
WRONG="$(printf '%040d' 1)"
expect_code "10 the target checkout is not at the asserted commit" TARGET_SHA_MISMATCH \
  "$(run_guard "$B10/trusted" "$(git -C "$B10/trusted" rev-parse HEAD)" "$B10/target" "$WRONG")"

# --- 11. the roots share an inode (hard link / bind style alias) ------------
# Distinct from case 3: different paths, different names, same inode.
B11="$WORK/f11"; build_fixture "$B11"
if mount 2>/dev/null | grep -q " $WORK "; then :; fi
# A directory hard link is not creatable portably, so this is exercised through
# a bind-mount-equivalent: a second path to the same dir via a symlinked parent.
mkdir -p "$B11/alias-parent"
ln -sfn "$B11/trusted" "$B11/alias-parent/trusted"
out="$(run_guard "$B11/alias-parent/trusted" "$(git -C "$B11/trusted" rev-parse HEAD)" "$B11/target" "$(git -C "$B11/target" rev-parse HEAD)")"
rc="$(sed -n 's/^__RC__//p' <<< "$out")"
if [[ "$rc" == "0" ]] && grep -q '^REUSE_OK' <<< "$out"; then
  ok "11 an alias of the TRUSTED root is still trusted (it resolves to the trusted checkout)"
else
  bad "11 an honest symlinked alias of the trusted root was refused (rc=$rc)"
  printf '%s\n' "$out" | grep -v '^__RC__' | sed 's/^/       /'
fi

# --- 12. the vendored reference copies are bound, not floating -------------
# `sql/*.vendored.sql` are no longer consulted by anything: the reused files
# come from the target checkout. A copy that nothing reads is a copy that can
# rot into a misleading reference, so it is pinned to the same digest the guard
# enforces. (This is also why reuse-guard.sh refuses a --file that resolves
# inside the trusted checkout: the vendored copies must not be usable as a
# stand-in for the real thing.)
#
# ABSENCE IS A FAILURE, NOT A PASS. This loop used to answer a missing vendored
# copy with `ok "12 ${label}: no vendored reference copy present (nothing to
# drift)"`. That is the shape this whole programme keeps finding: the check's
# PASSING value was also its FAILURE-TO-RUN value. Delete both vendored files
# and case 12 reported ok twice, the distinct-case ledger still read 13 of 13,
# and "the vendored reference copies are bound, not floating" went green having
# compared nothing. The pair list below is a hardcoded contract — these two
# files are expected to exist — so a missing one is drift of exactly the kind
# the case exists to catch, and it is now `bad`.
vendored_compared=0
for pair in "00_env_bootstrap:sql/00_env_bootstrap.vendored.sql" "10_seed:sql/10_seed.vendored.sql"; do
  label="${pair%%:*}"; rel="${pair#*:}"
  vend="${HERE}/../${rel}"
  pin="${HERE}/../expected/${label}.sha256"
  if [[ ! -f "$vend" ]]; then
    bad "12 ${label}: the vendored reference copy ${rel} is ABSENT; this case's pair list is a contract, and a copy that is gone cannot be shown to be pinned"
    continue
  fi
  if [[ ! -f "$pin" ]]; then
    bad "12 ${label}: a vendored copy exists but no digest is recorded for it"
    continue
  fi
  if [[ "$(sha256sum "$vend" | cut -d' ' -f1)" == "$(tr -d '[:space:]' < "$pin")" ]]; then
    ok "12 ${label}: the unused vendored reference still matches the recorded digest"
    vendored_compared=$(( vendored_compared + 1 ))
  else
    bad "12 ${label}: the vendored reference has drifted from the recorded digest"
  fi
done
# And the count, in its own right. Both branches above are reachable without
# comparing anything, and `ok` twice is what a reader takes as proof. This says
# how many digests were actually compared, so a green that compared none — or
# one — is a failure with a number in it rather than a silence.
if [[ "$vendored_compared" -ne 2 ]]; then
  bad "12 NON-VACUITY: ${vendored_compared} of 2 vendored reference digests were actually compared"
else
  ok "12 NON-VACUITY: both vendored reference digests were actually compared"
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
  printf '  \033[1;31mFAIL\033[0m COVERAGE these intended cases never reported: %s\n' "${missing_cases[*]}"
  fail=$(( fail + 1 ))
fi
if [[ "${#unknown_cases[@]}" -ne 0 ]]; then
  printf '  \033[1;31mFAIL\033[0m COVERAGE these cases reported but are not in CASES_INTENDED: %s\n' "${unknown_cases[*]}"
  fail=$(( fail + 1 ))
fi
# DISTINCT, not the raw count: a case that legitimately reports more than once
# (k3's case 12 runs for the bootstrap and for the seed) would otherwise print
# "14 of 13 intended cases reported", which reads as a defect and is not one.
DISTINCT_SEEN="$(printf '%s\n' "${CASES_SEEN[@]}" | LC_ALL=C sort -u | wc -l)"
COMPLETED=1
printf '\n  %s passed, %s failed (%s of %s intended cases reported)\n\n' \
  "$pass" "$fail" "$DISTINCT_SEEN" "${#CASES_INTENDED[@]}"
[[ "$fail" -eq 0 ]]
