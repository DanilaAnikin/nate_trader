#!/usr/bin/env bash
# ============================================================================
# k9-cell-identity.test.sh — a subset may not be certified as the whole
#
# THE DEFECT THIS CLOSES
# ----------------------
# `driver/verdict.mjs` established cardinality by COUNTING the cell result files
# in `$OUT/cells`. It never read WHICH environment combination each file
# described. An adversarial audit reproduced the consequence three ways, each
# ending in exit 0 under the banner
#
#     PASS all 24 environment combinations x 10 requests x 15 claims ...
#
# over an artefact set in which exactly ONE combination had been driven:
#
#   R1  23 of the 24 cell files overwritten with a copy of the 24th
#   R2  a real `run.sh --cells 1 --schema 0023` whose single cell was copied to
#       all 24 manifest filenames
#   R3  every cell's `instrumentEnv.raw_freeze_flags` collapsed to one triple
#
# The surviving combination in R2 was `m-on__s-on__b-empty` — the most frozen
# one. The combinations that would actually catch a leak are precisely the ones
# the old check could not tell apart from having been driven.
#
# A fourth defect of the same shape lived on the schema axis: the claim covers
# both migration generations, so a `--schema 0023` run drives 24 of 48
# combinations, and it too printed the unqualified PASS banner.
#
# WHAT IS TESTED HERE
# -------------------
#   GREEN  a genuine artefact set — 24 distinct cells, each observed running its
#          own freeze-flag triple — passes the identity gate with ZERO hard
#          failures. Without this, a verdict that refused everything would score
#          full marks below.
#   R1/R2  a copied-cell set is refused, and the message names the copy.
#   R3     an env-collapsed set is refused, and the message names the variable,
#          the value the container was running, and the value pinned for it.
#   R4     an attacker who repairs BOTH the filename and the in-file `cell`
#          field is still refused, on the instrument's reading alone.
#   S1     a full 24-cell run on ONE schema is PARTIAL on the schema axis, exit
#          4, and never prints the PASS banner.
#
# AND THEN THE SAME DEFECT WAS FOUND ONE LEVEL UP
# -----------------------------------------------
# R1-R4 pin WHICH CELL. Nothing pinned WHICH MIGRATION GENERATION, and all four
# statements are generation-independent. A later audit copied one generation's
# twenty-four result files onto the other generation's filenames and obtained
# the full 48-combination PASS from a run in which one generation never booted;
# then went further and repaired `instrumentEnv.raw_freeze_flags` too, which
# defeated the identity gate outright because all three of its "independent"
# statements are fields of ONE file written by ONE process.
#
#   R5     one generation's cells copied onto the other generation's filenames
#          — refused because the generation fingerprint the RECORDING GATEWAY
#          read out of the running database is the other generation's.
#   R6     the strongest single-file forgery there is: filename, `cell` field,
#          cellTags AND raw_freeze_flags all repaired — refused because
#          `sink-<schema>.jsonl` and `$OUT/instr/<schema>-<cell>.jsonl` are
#          written by two OTHER containers and neither mentions the cell.
#   R7     a cell result carrying another run's nonce — refused against
#          provenance.json.
#
# R5 and R6 need an artefact set with BOTH generations in it. If the directory
# has only one, they are reported as FAILURES, not skipped: a certification is
# about both generations, and a skipped attack is not a passed one.
#
# Every case runs the SHIPPED verdict over artefacts produced by a real run;
# nothing here is a mock. The artefact directory is copied before it is
# mutated, so the input evidence is never modified in place.
#
# Usage:
#   k9-cell-identity.test.sh --full-out DIR [--schema 0023] [--probe-user-id ID]
#
#   --full-out  an artefact directory from a run that drove all 24 cells on
#               --schema, e.g. produced by run.sh
#
# Exit: 0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
VERDICT="${RC}/driver/verdict.mjs"
MANIFEST="${RC}/expected/request-manifest.json"

FULL_OUT=""
SCHEMA=0023
PROBE_USER_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full-out)      FULL_OUT="${2:?}";      shift 2 ;;
    --schema)        SCHEMA="${2:?}";        shift 2 ;;
    --probe-user-id) PROBE_USER_ID="${2:?}"; shift 2 ;;
    *) printf 'k9: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ -n "$FULL_OUT" ]] || { printf 'k9: --full-out is required\n' >&2; exit 2; }
[[ -d "$FULL_OUT/cells" ]] || { printf 'k9: %s has no cells/ directory\n' "$FULL_OUT" >&2; exit 2; }

if [[ -z "$PROBE_USER_ID" ]]; then
  PROBE_USER_ID="$(node "${RC}/driver/keys.mjs" --print-shell \
    | sed -n 's/^CANARY_PROBE_USER_ID=//p')"
fi
[[ -n "$PROBE_USER_ID" ]] || { printf 'k9: could not determine the probe user id\n' >&2; exit 2; }

WORK="$(mktemp -d /tmp/nt-k9-XXXXXX)"

# --- this suite may not omit a case, and may not die quietly -----------------
# It did both. `verdict_both` was a call to a function that had been renamed to
# `verdict_present` and never existed; under `set -Eeuo pipefail` the suite died
# rc=127 three cases from the end, printed no summary, and R5, R6, R7 and N1 —
# including R5, the cross-generation attack the 48-combination claim rests on —
# simply never ran. A run that stops early with no summary is the same defect as
# a verdict that certifies a subset, so it is now caught here rather than by
# whoever happens to read the log.
#
# CASES_INTENDED is the closed set. Every ok/bad records the case token it
# reported on, and the tail asserts the recorded set equals this one. The EXIT
# trap turns "never reached the tail" into a loud harness failure.
CASES_INTENDED=(GREEN S1 R1/R2 R3 R4 GREENALL R5 R6 R7 N1)
CASES_SEEN=()
COMPLETED=0
cleanup() {
  local rc=$?
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk9 harness: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'k9 harness: an unfinished suite is not a passing one.\n' >&2
    [[ "$rc" -eq 0 ]] && exit 2
  fi
  exit "$rc"
}
trap cleanup EXIT

pass=0; fail=0

# --- detecting the PASS banner, which is not a plain-text search -------------
# The verdict colours its verdict word, so the bytes are
#   ESC[1;32m PASS ESC[0m " all 24 environment combinations ..."
# and the obvious `grep -q 'PASS all '` NEVER matches. Both this suite and K4
# were briefly written that way, which made every "the banner must not appear"
# assertion vacuously true — a negative control that cannot fail. So the escapes
# are stripped first, and `no_pass_banner` is proved against a planted banner
# before it is trusted.
strip_ansi() { sed -e 's/\x1b\[[0-9;]*m//g'; }
# NOT `strip_ansi | grep -q`. `grep -q` exits at its FIRST match and closes the
# pipe; sed then dies of SIGPIPE with status 141, and under `set -o pipefail`
# the PIPELINE's status is 141 even though grep matched. So this function
# returned "no banner" at random — and `no_pass_banner`, a NEGATIVE CONTROL,
# then passed for precisely the reason it must never pass for: the check did not
# run. MEASURED, on an 85492-byte refusal transcript whose needle is present:
# `sed … | grep -qF` reported it ABSENT in 32 of 200 trials; strip-into-a-
# variable-then-grep reported it absent in 0 of 200. It first showed up as two
# runs of one suite over one artefact directory going red on three different
# cases between them, none of them a real failure. The command substitution
# drains sed to completion before grep sees a byte, so there is no pipe to
# break.
has_pass_banner() {  # reads stdin
  local text; text="$(strip_ansi)"
  grep -qE '^PASS all [0-9]+ environment combinations' <<< "$text"
}
no_pass_banner() { ! has_pass_banner; }
# POSITIVE CONTROL for the detector itself.
if ! printf '\033[1;32mPASS\033[0m all 24 environment combinations x 2 migration generations\n' \
     | has_pass_banner; then
  printf '%s: the PASS-banner detector cannot find a planted banner; every banner assertion below would be vacuous\n' \
    "$(basename "${BASH_SOURCE[0]}")" >&2
  exit 2
fi
if printf 'PARTIAL 24 of 48 environment/schema combinations were driven\n' | has_pass_banner; then
  printf '%s: the PASS-banner detector matches a PARTIAL line\n' "$(basename "${BASH_SOURCE[0]}")" >&2
  exit 2
fi
# The case token is the first word of the message — that is how every message in
# this suite is already written, and recording it here means no call site has to
# repeat itself. If the convention were ever broken the tail below would report
# the case as missing, so this fails closed.
seen() { CASES_SEEN+=("${1%% *}"); }
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }
harness() { printf 'k9 harness: %s\n' "$*" >&2; exit 2; }

# The sensor-hit accounting the artefact set itself records, so the run's own
# challenge rounds are not mistaken for matrix hits.
sensor_hits() {  # out-dir -> the number run.sh would have declared
  local f="$1/sensor-report-${SCHEMA}.txt" rounds
  if [[ -f "$f" ]]; then
    rounds="$(sed -n 's/.*|rounds=\([0-9]*\)|.*/\1/p' "$f" | head -1)"
    [[ -n "$rounds" ]] && { printf '%s' $(( (rounds - 1) * 3 )); return 0; }
  fi
  printf '0'
}

verdict() {  # out-dir, cells-run, schemas -> OUTPUT, RC
  local out="$1" run="$2" schemas="$3"
  set +e
  OUTPUT="$(node "$VERDICT" --out "$out" --mode frozen --break-sensor none \
    --schemas "$schemas" --manifest "$MANIFEST" \
    --cells-run "$run" --cells-total 24 \
    --probe-user-id "$PROBE_USER_ID" \
    --sensor-verdict "${SCHEMA}=TRUSTWORTHY" \
    --sensor-hits "${SCHEMA}=$(sensor_hits "$out")" 2>&1)"
  RC=$?
  set -e
}

n_cells="$(find "$FULL_OUT/cells" -name "result-${SCHEMA}-*.json" | wc -l)"
[[ "$n_cells" == "24" ]] || harness "--full-out has $n_cells cell files for schema $SCHEMA, not 24"

printf '\n== K9 a subset of the matrix may not be certified as the whole ==\n\n'

# EVERY case runs over a private copy, including the positive controls. The
# verdict writes `verdict-scope.json` into whatever directory it is pointed at,
# so pointing it at `--full-out` OVERWRITES the run's own machine-readable
# verdict with this suite's. It did: a real 48-cell PASS directory came back
# from this suite recording `"status": "PARTIAL"`, because the last verdict run
# over it had been S1's single-generation one. The header above promised the
# input evidence was never modified in place, and for the two baseline cases it
# was not true.
fresh() {  # label -> a private copy of the artefact set
  local label="$1"
  rm -rf "${WORK}/${label}"
  cp -a "$FULL_OUT" "${WORK}/${label}"
  printf '%s' "${WORK}/${label}"
}

# --- GREEN: the genuine artefact set clears the identity gate ---------------
# The positive control, over an untouched copy of the run's own output.
verdict "$(fresh baseline)" 24 "$SCHEMA"
if grep -q 'distinct cell identities driven : 24 of 24' <<< "$OUTPUT" \
   && ! grep -q 'INCOMPLETE OBSERVATION' <<< "$OUTPUT"; then
  ok "GREEN a genuine 24-cell set clears the identity gate with no hard failures"
else
  bad "GREEN the genuine artefact set was refused (rc=$RC)"
  grep -E 'distinct cell|INCOMPLETE|hard failures|  - ' <<< "$OUTPUT" | head -8 | sed 's/^/       /'
fi

# --- S1: one schema is half the matrix -------------------------------------
if [[ "$RC" -eq 4 ]] && grep -q 'schema axis' <<< "$OUTPUT" \
   && no_pass_banner <<< "$OUTPUT"; then
  ok "S1 24 of 24 cells on ONE generation is PARTIAL on the schema axis (rc=$RC), never PASS"
else
  bad "S1 a single-generation run was not PARTIAL on the schema axis (rc=$RC)"
  grep -E 'PASS all|PARTIAL|schema axis' <<< "$OUTPUT" | head -5 | sed 's/^/       /'
fi

# --- the three reproductions ------------------------------------------------
# R1/R2: one cell copied over all 24 filenames.
if true; then
  d="$(fresh copy)"
  src="$(find "$d/cells" -name "result-${SCHEMA}-*.json" | sort | head -1)"
  [[ -n "$src" ]] || harness "no cell file to copy"
  keep="$(basename "$src")"
  while IFS= read -r f; do
    [[ "$(basename "$f")" == "$keep" ]] && continue
    cp "$src" "$f"
  done < <(find "$d/cells" -name "result-${SCHEMA}-*.json")
  verdict "$d" 24 "$SCHEMA"
  if [[ "$RC" -eq 3 ]] \
     && grep -q 'distinct cell identities driven : 1 of 24' <<< "$OUTPUT" \
     && grep -q 'a cell result was copied or renamed' <<< "$OUTPUT" \
     && no_pass_banner <<< "$OUTPUT"; then
    ok "R1/R2 24 copies of one cell are refused as 1 distinct identity (rc=$RC)"
  else
    bad "R1/R2 a copied-cell set was not refused (rc=$RC)"
    grep -E 'PASS all|distinct cell|copied or renamed' <<< "$OUTPUT" | head -5 | sed 's/^/       /'
  fi
fi

# R3: the recorded environments collapsed to one triple, filenames untouched.
if true; then
  d="$(fresh envcollapse)"
  src="$(find "$d/cells" -name "result-${SCHEMA}-*.json" | sort | head -1)"
  ref="$(node -e '
    const j = require(process.argv[1]);
    process.stdout.write(JSON.stringify(j.instrumentEnv.raw_freeze_flags));' "$src")"
  while IFS= read -r f; do
    node -e '
      const fs = require("node:fs");
      const p = process.argv[1];
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.instrumentEnv.raw_freeze_flags = JSON.parse(process.argv[2]);
      fs.rmSync(p, { force: true });
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    ' "$f" "$ref"
  done < <(find "$d/cells" -name "result-${SCHEMA}-*.json")
  verdict "$d" 24 "$SCHEMA"
  if [[ "$RC" -eq 3 ]] \
     && grep -q 'the container was NOT running this cell' <<< "$OUTPUT" \
     && grep -q 'the manifest pins' <<< "$OUTPUT" \
     && no_pass_banner <<< "$OUTPUT"; then
    ok "R3 one freeze-flag triple recorded for every cell is refused (rc=$RC)"
  else
    bad "R3 an env-collapsed set was not refused (rc=$RC)"
    grep -E 'PASS all|NOT running|distinct cell' <<< "$OUTPUT" | head -5 | sed 's/^/       /'
  fi
fi

# R4: the strongest forgery short of rewriting the instrument's own reading —
# the copy's filename AND its in-file `cell` field and cellTags are repaired, so
# only what the container was observed running still disagrees.
if true; then
  d="$(fresh repaired)"
  src="$(find "$d/cells" -name "result-${SCHEMA}-*.json" | sort | head -1)"
  keep="$(basename "$src")"
  while IFS= read -r f; do
    [[ "$(basename "$f")" == "$keep" ]] && continue
    id="$(basename "$f")"; id="${id#result-${SCHEMA}-}"; id="${id%.json}"
    cp "$src" "$f"
    node -e '
      const fs = require("node:fs");
      const p = process.argv[1], id = process.argv[2];
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.cell = id;
      for (const r of j.results) r.cellTag = `${id}#${r.id}`;
      fs.rmSync(p, { force: true });
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    ' "$f" "$id"
  done < <(find "$d/cells" -name "result-${SCHEMA}-*.json")
  verdict "$d" 24 "$SCHEMA"
  if [[ "$RC" -eq 3 ]] \
     && grep -q 'the container was NOT running this cell' <<< "$OUTPUT" \
     && no_pass_banner <<< "$OUTPUT"; then
    ok "R4 a copy with its name and cell field repaired is still refused, on the instrument's reading (rc=$RC)"
  else
    bad "R4 a repaired copy was not refused (rc=$RC)"
    grep -E 'PASS all|NOT running|distinct cell|copied or renamed' <<< "$OUTPUT" | head -5 | sed 's/^/       /'
  fi
fi

# --- the generation axis: R5, R6, R7 ----------------------------------------
# These need the OTHER generation as well, because the attack is a swap.
OTHER=""
for g in 0008 0023; do
  [[ "$g" == "$SCHEMA" ]] && continue
  if [[ -n "$(find "$FULL_OUT/cells" -name "result-${g}-*.json" -print -quit)" ]]; then OTHER="$g"; fi
done

sensor_hits_for() {  # out-dir, schema
  local f="$1/sensor-report-$2.txt" rounds
  if [[ -f "$f" ]]; then
    rounds="$(sed -n 's/.*|rounds=\([0-9]*\)|.*/\1/p' "$f" | head -1)"
    [[ -n "$rounds" ]] && { printf '%s' $(( (rounds - 1) * 3 )); return 0; }
  fi
  printf '0'
}
# The verdict over EVERY generation the artefact set holds. With both, a genuine
# set is a PASS over 48; with one, it is PARTIAL on the schema axis. Either way
# a hard failure beats both, which is what the attacks below assert.
verdict_present() {  # out-dir -> OUTPUT, RC
  local out="$1" args=() s
  args=(--out "$out" --mode frozen --break-sensor none
        --schemas "$(IFS=,; echo "${PRESENT[*]}")" --manifest "$MANIFEST"
        --cells-run 24 --cells-total 24 --probe-user-id "$PROBE_USER_ID")
  for s in "${PRESENT[@]}"; do
    args+=(--sensor-verdict "${s}=TRUSTWORTHY" --sensor-hits "${s}=$(sensor_hits_for "$out" "$s")")
  done
  set +e
  OUTPUT="$(node "$VERDICT" "${args[@]}" 2>&1)"
  RC=$?
  set -e
}

PRESENT=("$SCHEMA")
[[ -n "$OTHER" ]] && PRESENT+=("$OTHER")

# BASELINE for the multi-generation verdict, so the attacks below are not scored
# against a checker that refuses everything.
verdict_present "$(fresh baseline-all)"
if [[ "${#PRESENT[@]}" -eq 2 ]]; then
  if [[ "$RC" -eq 0 ]] && has_pass_banner <<< "$OUTPUT"; then
    ok "GREENALL the genuine ${SCHEMA}+${OTHER} artefact set is a PASS over 48 combinations (rc=$RC)"
  else
    bad "GREENALL the genuine two-generation set was refused (rc=$RC)"
    grep -E 'INCOMPLETE|generation|  - ' <<< "$OUTPUT" | head -10 | sed 's/^/       /'
  fi
elif [[ "$RC" -eq 4 ]] && ! grep -q 'INCOMPLETE OBSERVATION' <<< "$OUTPUT"; then
  ok "GREENALL the genuine single-generation set clears every gate and is PARTIAL on the schema axis (rc=$RC)"
else
  bad "GREENALL the genuine single-generation set was refused (rc=$RC)"
  grep -E 'INCOMPLETE|generation|  - ' <<< "$OUTPUT" | head -10 | sed 's/^/       /'
fi

if [[ -z "$OTHER" ]]; then
  # These three need two generations, and R5 is the case the certification
  # exists for. A missing generation is a failure, not a skip — and all three
  # say so, because the header promises they do and only R5 used to. A case that
  # vanishes from the output is indistinguishable from a case that passed.
  bad "R5 the artefact set holds only generation ${SCHEMA}; the cross-generation attack — the one the 48-combination claim rests on — could not be run"
  bad "R6 the artefact set holds only generation ${SCHEMA}; the fully-repaired-forgery attack could not be run"
  bad "R7 the artefact set holds only generation ${SCHEMA}; the foreign-run-nonce attack could not be run"
else
  # R5: every cell of $OTHER copied onto $SCHEMA's filenames. Filename, `cell`
  # field, cellTags and raw_freeze_flags all agree — they are generation-blind.
  # The generation witness does not.
  d="$(fresh schemadup)"
  while IFS= read -r f; do
    id="$(basename "$f")"; id="${id#result-${OTHER}-}"; id="${id%.json}"
    rm -f "$d/cells/result-${SCHEMA}-${id}.json"
    cp "$f" "$d/cells/result-${SCHEMA}-${id}.json"
    node -e '
      const fs = require("node:fs");
      const p = process.argv[1], s = process.argv[2];
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.schema = s;                       // repair the driver`s own statement too
      fs.rmSync(p, { force: true });
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    ' "$d/cells/result-${SCHEMA}-${id}.json" "$SCHEMA"
  done < <(find "$d/cells" -name "result-${OTHER}-*.json")
  verdict_present "$d"
  # THE RED-BEFORE IS ASSERTED IN THE SAME CASE. The point of R5 is not merely
  # that the copy is refused, but that it is refused by something the previous
  # round did not have: every check A1 added — the filename, the driver's `cell`
  # field, the cellTag prefixes and `instrumentEnv.raw_freeze_flags` — is
  # generation-blind and therefore SATISFIED here. If any of those complained,
  # this case would prove nothing about the generation gate.
  if grep -qE 'copied or renamed|the container was NOT running this cell' <<< "$OUTPUT"; then
    bad "R5 the cell-identity gate complained, so this case does not isolate the generation gate"
    grep -E 'copied or renamed|NOT running this cell' <<< "$OUTPUT" | head -3 | sed 's/^/       /'
  elif [[ "$RC" -eq 3 ]] \
     && grep -q "is NOT generation ${SCHEMA}" <<< "$OUTPUT" \
     && grep -q "which is generation ${OTHER}" <<< "$OUTPUT" \
     && no_pass_banner <<< "$OUTPUT"; then
    ok "R5 generation ${OTHER}'s cells filed as ${SCHEMA} satisfy every A1-era identity check and are still refused, by the gateway's reading of the running database (rc=$RC)"
  else
    bad "R5 a cross-generation copy was not refused (rc=$RC)"
    grep -E 'PASS all|NOT generation|generation witness' <<< "$OUTPUT" | head -6 | sed 's/^/       /'
  fi

  # R6: the strongest forgery confined to the cell result — name, `cell`,
  # cellTags, raw_freeze_flags AND schema all repaired. Only the files written
  # by the OTHER TWO containers can still contradict it.
  d="$(fresh forge)"
  src="$(find "$d/cells" -name "result-${SCHEMA}-*.json" | sort | head -1)"
  keep="$(basename "$src")"
  while IFS= read -r f; do
    [[ "$(basename "$f")" == "$keep" ]] && continue
    id="$(basename "$f")"; id="${id#result-${SCHEMA}-}"; id="${id%.json}"
    cp "$src" "$f"
    node -e '
      const fs = require("node:fs");
      const p = process.argv[1], id = process.argv[2], man = process.argv[3], probe = process.argv[4];
      const m = JSON.parse(fs.readFileSync(man, "utf8"));
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.cell = id;
      for (const r of j.results) r.cellTag = `${id}#${r.id}`;
      const want = {};
      for (const [k, v] of Object.entries(m.cellEnv[id])) want[k] = v === "__PROBE_USER_ID__" ? probe : v;
      j.instrumentEnv.raw_freeze_flags = want;   // the fourth field, repaired
      fs.rmSync(p, { force: true });
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    ' "$f" "$id" "$MANIFEST" "$PROBE_USER_ID"
  done < <(find "$d/cells" -name "result-${SCHEMA}-*.json")
  verdict_present "$d"
  # Same red-before assertion: with the fourth field repaired, the A1-era gate
  # is fully satisfied. Only the two files written by OTHER containers are left.
  if grep -qE 'copied or renamed|the container was NOT running this cell' <<< "$OUTPUT"; then
    bad "R6 the cell-identity gate still complained, so this case does not isolate the cross-container evidence"
    grep -E 'copied or renamed|NOT running this cell' <<< "$OUTPUT" | head -3 | sed 's/^/       /'
  elif [[ "$RC" -eq 3 ]] \
     && grep -qE 'never reached the recording gateway|not the one the image under test produced for this cell' <<< "$OUTPUT" \
     && no_pass_banner <<< "$OUTPUT"; then
    ok "R6 a copy with name, cell, cellTags AND raw_freeze_flags repaired defeats the whole A1 gate and is still refused, by files two other containers wrote (rc=$RC)"
  else
    bad "R6 a fully repaired single-file forgery was not refused (rc=$RC)"
    grep -E 'PASS all|recording gateway|ever started|NOT running' <<< "$OUTPUT" | head -6 | sed 's/^/       /'
  fi

  # R7: one cell from a different run, everything else genuine.
  d="$(fresh othernonce)"
  victim="$(find "$d/cells" -name "result-${SCHEMA}-*.json" | sort | head -1)"
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.runNonce = "0123456789abcdef0123456789abcdef";
    fs.rmSync(p, { force: true });
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  ' "$victim"
  verdict_present "$d"
  if [[ "$RC" -eq 3 ]] \
     && grep -q 'produced by a different run' <<< "$OUTPUT" \
     && no_pass_banner <<< "$OUTPUT"; then
    ok "R7 a cell carrying another run's nonce is refused against provenance.json (rc=$RC)"
  else
    bad "R7 a cell from another run was not refused (rc=$RC)"
    grep -E 'PASS all|different run|run nonce' <<< "$OUTPUT" | head -6 | sed 's/^/       /'
  fi
fi

# --- N1: the identity gate must not be satisfiable by a fixture manifest ----
# The k2 fixture manifest is deliberately non-certifying. It must be usable and
# must never print PASS.
if true; then
  d="$(fresh fixture)"
  set +e
  OUT2="$(node "$VERDICT" --out "$d" --mode frozen --break-sensor none \
    --schemas "$SCHEMA" --manifest "${RC}/expected/k2-fixture-manifest.json" \
    --cells-run 24 --cells-total 24 --probe-user-id "$PROBE_USER_ID" \
    --sensor-verdict "${SCHEMA}=TRUSTWORTHY" 2>&1)"
  RC2=$?
  set -e
  if [[ "$RC2" -ne 0 ]] && no_pass_banner <<< "$OUT2"; then
    ok "N1 the non-certifying fixture manifest cannot produce a PASS (rc=$RC2)"
  else
    bad "N1 a fixture manifest produced a certification (rc=$RC2)"
    grep -E 'PASS all|NOT CERTIFYING|PARTIAL' <<< "$OUT2" | head -5 | sed 's/^/       /'
  fi
fi

# --- the closed-set check on this suite's own coverage -----------------------
missing=()
for c in "${CASES_INTENDED[@]}"; do
  found=0
  for s in "${CASES_SEEN[@]}"; do [[ "$s" == "$c" ]] && { found=1; break; }; done
  [[ "$found" -eq 1 ]] || missing+=("$c")
done
if [[ "${#missing[@]}" -ne 0 ]]; then
  printf '  \033[1;31mFAIL\033[0m COVERAGE these intended cases never reported: %s\n' "${missing[*]}"
  fail=$(( fail + 1 ))
fi
COMPLETED=1

printf '\n  %s passed, %s failed (%s of %s intended cases reported)\n\n' \
  "$pass" "$fail" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}"
[[ "$fail" -eq 0 ]]
