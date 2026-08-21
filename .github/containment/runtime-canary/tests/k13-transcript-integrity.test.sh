#!/usr/bin/env bash
# ============================================================================
# k13-transcript-integrity.test.sh — the verdict's transcript must not be lossy
#
# WHAT THIS CLOSES
# ----------------
# Node writes to a PIPE asynchronously, and `process.exit()` discards whatever
# is still queued. driver/verdict.mjs ends every path in `process.exit()`, and
# every suite that reads it captures it with
#
#     OUTPUT="$(node …/verdict.mjs … 2>&1)"
#
# which is a pipe. So the transcript silently lost a contiguous middle chunk of
# itself, at random. Eight identical captures of one refusal measured
#
#     330509  270514  312498  92082  165554  330509  330509  161618  bytes
#
# The 92082-byte capture had lost 177 of the 280 matrix rows AND the whole
# "WHAT THIS VERDICT DOES NOT SAY" block. Redirected to a FILE the same run was
# 330574 bytes every time, so nothing about the verdict differed — only what
# survived the pipe. Make the reader slow (the pipe fills, the writer queues,
# `process.exit` throws the queue away) and the loss becomes total and
# repeatable: 62308 bytes of 330574, four times out of four.
#
# WHY IT IS A CORRECTNESS DEFECT, NOT A COSMETIC ONE
# --------------------------------------------------
# Several suites assert that a string is ABSENT from this transcript — k4's
# `no_pass_banner` over cases 1 and 4, and k9's equivalents. An absence
# assertion over output that can lose 81% of itself is satisfied BY THE LOSS,
# so a negative control could pass for the one reason it must never pass for:
# nothing was read. In the other direction it makes a presence assertion flake
# RED, which is how this was found — one live k2-sensor-removal run reported
# "a result with no sensor block was accepted" for a run that had in fact
# refused it, with nine green runs either side.
#
# THE CASES
# ---------
#   C1  RED-BEFORE, EXECUTED AND DETERMINISTIC. The real verdict, run with the
#       NT_VERDICT_ASYNC_STDIO=1 seam (which restores the old asynchronous
#       writer) into a deliberately SLOW reader, must come back massively
#       short. Without this the P-cases could pass on a platform that never
#       loses anything and would prove nothing about the repair.
#   P1  The shipped writer, same slow reader, same number of attempts: every
#       capture byte-complete against the file reference, and all identical.
#   P2  The shipped writer read the ordinary way — command substitution, which
#       is what every suite does — likewise complete and identical every time.
#   P3  The scope block survives every shipped capture, and is provably ABSENT
#       from the truncated async capture. It is written last on stdout, right
#       before process.exit, so it is the first thing the defect removes — and
#       it is the part of the output that states what a PASS does not claim.
#   N1  A reader that closes the pipe early (`| head -3`) gets its three lines
#       and no stack trace: EPIPE is handled, not crashed on.
#
# The transcript is made LARGE on purpose: the defect does not appear on a
# 70 KB clean PASS. This suite strips the sensor blocks out of a COPY of the
# artefact directory, which makes the verdict refuse with ~481 hard failures
# and print ~330 KB. The input directory is copied first and never modified.
#
# Usage:  k13-transcript-integrity.test.sh --out DIR [--schema 0023]
# ============================================================================
set -Eeuo pipefail
shopt -s inherit_errexit 2>/dev/null || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
VERDICT="${RC}/driver/verdict.mjs"
MANIFEST="${RC}/expected/request-manifest.json"

SRC_OUT=""
SCHEMA=0023
ATTEMPTS=4
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)      SRC_OUT="${2:?}";  shift 2 ;;
    --schema)   SCHEMA="${2:?}";   shift 2 ;;
    --attempts) ATTEMPTS="${2:?}"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -d "$SRC_OUT" ]] || { printf 'k13: --out must be a run.sh artefact directory\n' >&2; exit 2; }

WORK="$(mktemp -d /tmp/nt-k13-XXXXXX)"
pass=0; fail=0
CASES_INTENDED=(C1 P1 P2 P3 N1)
CASES_SEEN=()
COMPLETED=0
cleanup() {
  local rc=$?
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk13: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    rm -rf "$WORK"
    exit "$(( rc == 0 ? 2 : rc ))"
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }
harness() { printf 'k13 harness: %s\n' "$*" >&2; rm -rf "$WORK"; trap - EXIT; exit 2; }

# --- a copy of the evidence, made large on purpose ---------------------------
OUT="$WORK/out"
cp -a "$SRC_OUT" "$OUT"
chmod -R u+w "$OUT"
rm -f "$OUT/verdict-scope.json"
node -e '
  const fs = require("node:fs"), path = require("node:path");
  const dir = process.argv[1], schema = process.argv[2];
  let n = 0;
  for (const f of fs.readdirSync(path.join(dir, "cells"))) {
    if (!f.startsWith(`result-${schema}-`) || !f.endsWith(".json")) continue;
    const p = path.join(dir, "cells", f);
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const r of j.results) { delete r.sensors; n++; }
    fs.rmSync(p, { force: true });
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  }
  if (n === 0) { console.error("no request records were edited"); process.exit(1); }
' "$OUT" "$SCHEMA" 2> "$WORK/prep.err" \
  || harness "could not prepare a large-transcript artefact copy: $(cat "$WORK/prep.err")"

VERDICT_ARGS=(--out "$OUT" --mode frozen --break-sensor none --schemas "$SCHEMA"
              --manifest "$MANIFEST" --cells-run 24 --cells-total 24
              --sensor-verdict "${SCHEMA}=TRUSTWORTHY" --sensor-hits "${SCHEMA}=0")

# The reference: the same run with stdout and stderr redirected to FILES, which
# is the one destination Node writes synchronously whatever it does.
set +e
node "$VERDICT" "${VERDICT_ARGS[@]}" > "$WORK/file.out" 2> "$WORK/file.err"
FRC=$?
set -e
FILE_BYTES=$(( $(stat -c%s "$WORK/file.out") + $(stat -c%s "$WORK/file.err") ))
[[ "$FILE_BYTES" -ge 100000 ]] \
  || harness "the reference transcript is only ${FILE_BYTES} bytes; too small to demonstrate anything (rc=${FRC})"

# A SLOW reader: the pipe fills while it sleeps, so an asynchronous writer must
# queue and then lose the queue at process.exit. This is what turns a race into
# a repeatable measurement.
slow_capture() {  # dest, [env assignments…]
  local dest="$1"; shift
  set +e
  { env "$@" node "$VERDICT" "${VERDICT_ARGS[@]}" 2>&1; } | { sleep 2; cat; } > "$dest"
  set -e
}
# …and the ordinary way, exactly as every suite reads it: command substitution.
subst_capture() {  # dest
  local dest="$1" o
  set +e
  o="$(node "$VERDICT" "${VERDICT_ARGS[@]}" 2>&1)"
  set -e
  printf '%s' "$o" > "$dest"     # command substitution strips trailing newlines
}
# Command substitution eats the final newline; nothing else. Four bytes of
# slack, no more — the losses this file exists for are tens of kilobytes.
SLACK=4

printf '\n== K13 the verdict transcript must survive the pipe every suite reads it through ==\n\n'
printf '   reference transcript (stdout+stderr to files): %s bytes, rc=%s\n\n' "$FILE_BYTES" "$FRC"

# --- C1 the red-before, executed ---------------------------------------------
async_sizes=""; async_short=0
for i in $(seq 1 "$ATTEMPTS"); do
  slow_capture "$WORK/async-$i.txt" NT_VERDICT_ASYNC_STDIO=1
  s=$(stat -c%s "$WORK/async-$i.txt")
  async_sizes="${async_sizes}${s} "
  if [[ "$s" -lt $(( FILE_BYTES / 2 )) ]]; then async_short=$(( async_short + 1 )); fi
done
if [[ "$async_short" -eq "$ATTEMPTS" ]]; then
  ok "C1 red-before: the asynchronous writer lost more than half the transcript in ${async_short}/${ATTEMPTS} attempts (${async_sizes% } of ${FILE_BYTES})"
elif [[ "$async_short" -gt 0 ]]; then
  ok "C1 red-before: the asynchronous writer lost more than half the transcript in ${async_short}/${ATTEMPTS} attempts (${async_sizes% } of ${FILE_BYTES})"
else
  bad "C1 the asynchronous writer lost nothing in ${ATTEMPTS} attempts against a slow reader (${async_sizes% } of ${FILE_BYTES}); this platform cannot demonstrate the defect, so P1/P2 below are untested here"
fi

# --- P1 the shipped writer against the same slow reader ----------------------
declare -A slow_hashes=()
slow_bad=""
for i in $(seq 1 "$ATTEMPTS"); do
  slow_capture "$WORK/slow-$i.txt"
  s=$(stat -c%s "$WORK/slow-$i.txt")
  [[ "$s" -eq "$FILE_BYTES" ]] || slow_bad="${slow_bad} run${i}=${s}"
  slow_hashes["$(sha256sum < "$WORK/slow-$i.txt")"]=1
done
if [[ -n "$slow_bad" ]]; then
  bad "P1 the shipped writer lost bytes against a slow reader (want ${FILE_BYTES}):${slow_bad}"
elif [[ "${#slow_hashes[@]}" -ne 1 ]]; then
  bad "P1 ${ATTEMPTS} slow-reader captures of one run produced ${#slow_hashes[@]} distinct transcripts"
else
  ok "P1 the shipped writer delivers all ${FILE_BYTES} bytes to a slow reader, identically, ${ATTEMPTS}/${ATTEMPTS} times"
fi

# --- P2 the shipped writer, read the way the suites read it ------------------
declare -A subst_hashes=()
subst_bad=""
for i in $(seq 1 "$ATTEMPTS"); do
  subst_capture "$WORK/subst-$i.txt"
  s=$(stat -c%s "$WORK/subst-$i.txt")
  [[ "$s" -ge $(( FILE_BYTES - SLACK )) ]] || subst_bad="${subst_bad} run${i}=${s}"
  subst_hashes["$(sha256sum < "$WORK/subst-$i.txt")"]=1
done
if [[ -n "$subst_bad" ]]; then
  bad "P2 \$( … 2>&1 ) captures fall short of the ${FILE_BYTES}-byte reference:${subst_bad}"
elif [[ "${#subst_hashes[@]}" -ne 1 ]]; then
  bad "P2 ${ATTEMPTS} command-substitution captures produced ${#subst_hashes[@]} distinct transcripts"
else
  ok "P2 \$( … 2>&1 ) — how every suite reads this file — is complete and identical ${ATTEMPTS}/${ATTEMPTS} times"
fi

# --- P3 the block the defect removes first, in both directions ---------------
SCOPE_MARK='WHAT THIS VERDICT DOES NOT SAY'
scope_missing=0
for i in $(seq 1 "$ATTEMPTS"); do
  grep -qF "$SCOPE_MARK" "$WORK/slow-$i.txt"  || scope_missing=$(( scope_missing + 1 ))
  grep -qF "$SCOPE_MARK" "$WORK/subst-$i.txt" || scope_missing=$(( scope_missing + 1 ))
done
async_scope_missing=0
for i in $(seq 1 "$ATTEMPTS"); do
  grep -qF "$SCOPE_MARK" "$WORK/async-$i.txt" || async_scope_missing=$(( async_scope_missing + 1 ))
done
if [[ "$scope_missing" -ne 0 ]]; then
  bad "P3 the scope block is missing from ${scope_missing} shipped captures"
elif [[ "$async_scope_missing" -eq 0 && "$async_short" -gt 0 ]]; then
  bad "P3 the truncated async captures still contained the scope block; this detector is not discriminating"
else
  ok "P3 the scope block is in all $(( ATTEMPTS * 2 )) shipped captures and absent from ${async_scope_missing}/${ATTEMPTS} truncated ones"
fi

# --- N1 a reader that leaves early -------------------------------------------
set +e
n1="$( { node "$VERDICT" "${VERDICT_ARGS[@]}" 2>/dev/null; } | head -3 2>&1 )"
n1rc=$?
set -e
if grep -qE 'EPIPE|^Error:|at .*\(node:' <<< "$n1"; then
  bad "N1 a reader that closes early produced an error trace"
  printf '%s\n' "$n1" | head -5 | sed 's/^/       /'
elif [[ -z "$n1" ]]; then
  bad "N1 a reader that closes early got nothing at all"
else
  ok "N1 a reader that closes the pipe after 3 lines gets 3 lines and no stack trace (rc=$n1rc)"
fi

# --- the closed-set check on this suite's own coverage -----------------------
missing_cases=()
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && { found=1; break; }; done
  [[ "$found" -eq 1 ]] || missing_cases+=("$c")
done
if [[ "${#missing_cases[@]}" -ne 0 ]]; then
  printf '  \033[1;31mFAIL\033[0m COVERAGE these intended cases never reported: %s\n' "${missing_cases[*]}"
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
