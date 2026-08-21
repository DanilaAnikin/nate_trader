#!/usr/bin/env bash
# ============================================================================
# verify-sensor.sh — the TRUSTED RUNNER for the runtime canary's sensor
#
# WHAT DEFEATED THE OLD DESIGN
# ----------------------------
# The old arming check asked `pg_proc.prosrc LIKE '%NT_CANARY_SENSOR_V1%'` and
# ran once, before the matrix. A sabotage that kept the marker comment, kept
# the delegate, left `nt_canary.log_call` completely intact and deleted the one
# `perform nt_canary.log_call(...)` statement produced a provably dead sensor
# that `assert_armed()` called "armed". Two real calls to tombstoned wrappers
# then moved no counter and the suite printed "PASS … the canary never fired"
# and exited 0.
#
# WHAT THIS DOES INSTEAD
# ----------------------
#  1. THE TRUSTED RUNNER INSTALLS THE INSTRUMENTATION. The install SQL is read
#     only from this checkout, and its digests are verified against
#     `sensor/expected/sql.sha256sums` before a byte of it is copied into the
#     database. The candidate never supplies, and never touches, the sensor.
#
#  2. A PER-RUN NONCE, GENERATED AFTER THE ARTIFACT IS FIXED. `arm` requires
#     `--artifact-digest`, records it, and only then draws 128 bits from
#     /dev/urandom. Nothing that was built, written or committed before the run
#     can predict the tag a challenge will carry.
#
#  3. A KEYED RUN MANIFEST. Expected definition digest, nonce, wrapper
#     identities, overload counts, owners, privileges and catalogue properties
#     are bound into one manifest, HMAC-SHA256'd with a key drawn per run into
#     a 0700 directory that is never mounted into any container. Editing the
#     manifest without the key invalidates it.
#
#  4. COMPLETE NORMALISED DEFINITIONS, NOT MARKERS. `sql/50_sensor_dump.sql`
#     emits every routine in `nt_canary` and every `public.vault_*` routine in
#     full — definition, owner, ACL, volatility, strictness, language, config,
#     argument types, overload and shadow counts — and the whole text is
#     compared, at every phase, against what was recorded at install and
#     against a digest pinned in this checkout.
#
#  5. A FUNCTIONAL CHALLENGE PER WRAPPER, PER PHASE. Each wrapper is really
#     called, through a privileged path the image under test has no route to,
#     tagged with the nonce. Exactly one event must appear, on three channels:
#     the raw catalogue sequence value, `nt_canary.hits()`, and the postgres
#     server log read from OUTSIDE the database. The third is the one a
#     rollback cannot touch, which matters because on the latest schema every
#     one of these calls ends in `raise`.
#
#  6. BEFORE, INTERLEAVED, AND AFTER. The manifest declares which phases must
#     appear; `report` fails if any is missing, out of order, incomplete or
#     duplicated. Turning the post-check off is not a way to pass.
#
# Commands:
#   arm       install, pin, nonce, manifest, tamper control, phase `pre`
#   challenge --phase mid|post [--round N]
#   report    the verdict
#   record-expected   (re)write the pinned digests in this checkout
#
# Machine-readable output: `SENSOR_*=` lines on stdout, `SENSOR_VIOLATION=<code>`
# on stderr. `report` prints every violation it found rather than stopping at
# the first, so a negative control can assert the code it is aiming at.
#
# Exit codes: 0 ok   2 harness failure   3 the sensor cannot be trusted
# ============================================================================

set -Eeuo pipefail

readonly EXIT_HARNESS=2
readonly EXIT_SENSOR=3

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly RC_ROOT="$(cd "${HERE}/.." && pwd)"
readonly SQLDIR="${HERE}/sql"
readonly EXPECTED_DIR="${HERE}/expected"

# The instrumentation the trusted runner installs. Read from this checkout only.
readonly INSTALL_SQL="${RC_ROOT}/sql/20_canary_install.sql"

CMD=""
PG_C=""
SCHEMA=""
STATE=""
ARTIFACT_DIGEST=""
PHASE=""
ROUND="0"
EXTRA_HITS_POLICY="zero"
PHASES_REQUIRED="pre,mid,post"
# Hits the caller can ACCOUNT FOR that are not challenge rounds — the legacy
# fidelity probe fires each wrapper once. Anything beyond baseline + rounds +
# this number is a call the run cannot explain.
EXPECTED_EXTRA_HITS=0

violations=()
violate() { printf 'SENSOR_VIOLATION=%s %s\n' "$1" "${*:2}" >&2; violations+=("$1"); }
dief()    { printf 'SENSOR_VIOLATION=%s %s\n' "$1" "${*:2}" >&2; exit "$EXIT_SENSOR"; }
harness() { printf 'SENSOR_HARNESS_ERROR %s\n' "$*" >&2; exit "$EXIT_HARNESS"; }
say()     { printf '%s\n' "$*"; }

[[ $# -gt 0 ]] || harness "a command is required (arm | challenge | report | record-expected)"
CMD="$1"; shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pg)               PG_C="${2:?}";              shift 2 ;;
    --schema)           SCHEMA="${2:?}";            shift 2 ;;
    --state)            STATE="${2:?}";             shift 2 ;;
    --artifact-digest)  ARTIFACT_DIGEST="${2:?}";   shift 2 ;;
    --phase)            PHASE="${2:?}";             shift 2 ;;
    --round)            ROUND="${2:?}";             shift 2 ;;
    --extra-hits)       EXTRA_HITS_POLICY="${2:?}"; shift 2 ;;
    --phases)           PHASES_REQUIRED="${2:?}";   shift 2 ;;
    --expected-extra-hits) EXPECTED_EXTRA_HITS="${2:?}"; shift 2 ;;
    # Refused by name: a nonce or a digest the caller can state is a nonce or a
    # digest the candidate can state.
    --nonce|--expected-digest|--expected-dump)
      harness "$1 is not accepted: the nonce and the expected definition are produced by this runner, never supplied to it" ;;
    *) harness "unknown argument: $1" ;;
  esac
done

# --- primitives -------------------------------------------------------------

mac() {  # key-hex, file -> hex mac
  local key="$1" file="$2"
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -mac HMAC -macopt "hexkey:${key}" -r "$file" | cut -d' ' -f1
  else
    python3 -c '
import hashlib, hmac, sys
key = bytes.fromhex(sys.argv[1])
with open(sys.argv[2], "rb") as fh:
    sys.stdout.write(hmac.new(key, fh.read(), hashlib.sha256).hexdigest())
' "$key" "$file"
  fi
}

digest_file() { sha256sum -- "$1" | cut -d' ' -f1; }

psql_file() {  # local-sql, out-file, [psql -v args...]
  local f="$1" out="$2"; shift 2
  local base; base="$(basename "$f")"
  docker cp "$f" "${PG_C}:/nts_${base}" >/dev/null \
    || harness "could not copy $f into $PG_C"
  local err="${out}.err" rc
  set +e
  docker exec -i "$PG_C" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@" \
    -f "/nts_${base}" > "$out" 2> "$err"
  rc=$?
  set -e
  if [[ "$rc" -ne 0 ]]; then
    printf 'SENSOR_HARNESS_ERROR %s failed (rc=%s)\n' "$base" "$rc" >&2
    sed 's/^/    /' "$err" >&2
    return 1
  fi
  return 0
}

require_state() {
  [[ -n "$STATE" ]] || harness "--state is required"
  [[ -d "$STATE" ]] || harness "--state $STATE does not exist (run 'arm' first)"
}

# Verifies that the SQL this runner is about to execute is the SQL this
# checkout recorded. Without it, "the trusted runner installs it" is a claim
# about which directory a path string points at.
verify_trusted_sql() {
  local sums="${EXPECTED_DIR}/sql.sha256sums"
  [[ -f "$sums" ]] || dief TRUSTED_SQL_UNPINNED \
    "no $sums in this checkout; run 'record-expected' deliberately"
  local rel path want got n=0
  while IFS=' ' read -r want rel; do
    [[ -n "$want" ]] || continue
    path="${RC_ROOT}/${rel}"
    [[ -f "$path" ]] || dief TRUSTED_SQL_TAMPERED "pinned file is missing: $rel"
    got="$(digest_file "$path")"
    [[ "$got" == "$want" ]] || dief TRUSTED_SQL_TAMPERED \
      "$rel is $got, this checkout pins $want"
    n=$(( n + 1 ))
  done < "$sums"
  [[ "$n" -gt 0 ]] || dief TRUSTED_SQL_UNPINNED "$sums is empty"
  say "SENSOR_TRUSTED_SQL=verified|files=${n}"
}

# --- record-expected --------------------------------------------------------
if [[ "$CMD" == "record-expected" ]]; then
  mkdir -p "$EXPECTED_DIR"
  {
    for f in "$INSTALL_SQL" "$SQLDIR"/*.sql; do
      printf '%s %s\n' "$(digest_file "$f")" "$(realpath --relative-to="$RC_ROOT" "$f")"
    done
  } | sort -k2 > "${EXPECTED_DIR}/sql.sha256sums"
  say "SENSOR_RECORDED=sql.sha256sums|$(wc -l < "${EXPECTED_DIR}/sql.sha256sums") files"
  if [[ -n "$PG_C" && -n "$SCHEMA" ]]; then
    tmp="$(mktemp)"
    psql_file "${SQLDIR}/50_sensor_dump.sql" "$tmp" || harness "the dump failed"
    grep -E '^SENSOR_(OBJ|REL|NSP)=' "$tmp" > "${tmp}.f" \
      || harness "the dump produced no object lines"
    cp "${tmp}.f" "${EXPECTED_DIR}/sensor-objects.${SCHEMA}.txt"
    digest_file "${EXPECTED_DIR}/sensor-objects.${SCHEMA}.txt" \
      > "${EXPECTED_DIR}/sensor-objects.${SCHEMA}.sha256"
    say "SENSOR_RECORDED=sensor-objects.${SCHEMA}|$(wc -l < "${EXPECTED_DIR}/sensor-objects.${SCHEMA}.txt") objects|$(cat "${EXPECTED_DIR}/sensor-objects.${SCHEMA}.sha256")"
    rm -f "$tmp" "${tmp}.f"
  fi
  exit 0
fi

# --- the challenge round ----------------------------------------------------
# Fires all three wrappers under one nonce-derived tag and cross-checks three
# channels, one of which is read from outside the database entirely.
run_challenge() {  # phase, round -> appends to the ledger, returns non-zero on a violation
  local phase="$1" round="$2"
  local nonce; nonce="$(cat "${STATE}/nonce")"
  local key;   key="$(cat "${STATE}/runkey")"
  local prefix="chal:${nonce}:${phase}:${round}"
  local out="${STATE}/chal-${phase}-${round}.out"
  local logf="${STATE}/pglog-${phase}-${round}.txt"
  local bad=0

  psql_file "${SQLDIR}/51_challenge.sql" "$out" -v "tag_prefix=${prefix}" \
    || { violate CHALLENGE_NOT_RUN "the challenge script failed in phase ${phase}/${round}"; return 1; }

  # The external, test-side recorder: the postgres server log, read with
  # `docker logs` from outside the database. A rolled-back transaction cannot
  # retract a line that is already here.
  docker logs "$PG_C" > "$logf" 2>&1 || harness "could not read $PG_C's server log"

  local line fn tag rb ra hb ha
  while IFS= read -r line; do
    [[ "$line" == SENSOR_CHAL=* ]] || continue
    fn="$(sed -n 's/^SENSOR_CHAL=\([^|]*\)|.*/\1/p'          <<< "$line")"
    tag="$(sed -n 's/^SENSOR_CHAL=[^|]*|\([^|]*\)|.*/\1/p'   <<< "$line")"
    rb="$(sed -n 's/.*|raw_before=\([0-9-]*\)|.*/\1/p'       <<< "$line")"
    ra="$(sed -n 's/.*|raw_after=\([0-9-]*\)|.*/\1/p'        <<< "$line")"
    hb="$(sed -n 's/.*|hits_before=\([0-9-]*\)|.*/\1/p'      <<< "$line")"
    ha="$(sed -n 's/.*|hits_after=\([0-9-]*\)|.*/\1/p'       <<< "$line")"

    # channel 3: exact tag, counted in the server log
    local n grc
    set +e
    n="$(grep -F -c "cell=${tag} " "$logf")"
    grc=$?
    set -e
    case "$grc" in
      0) ;; 1) n=0 ;; *) harness "grep failed reading $logf (rc=$grc)" ;;
    esac

    # A count of ALL hit lines used to be taken here, under a comment about
    # distinguishing a stale correlation from silence, and then never read. It
    # is deleted rather than "used": the distinction it claimed to make is
    # already made below, by the `n == 0 && raw_delta != 0` branch, which
    # reports the last hit line it can see. A variable nothing reads is a check
    # nothing performs.

    local raw_delta=$(( ra - rb ))
    local hits_delta=$(( ha - hb ))
    local ok=1

    if [[ "$raw_delta" -eq 0 && "$n" -eq 0 ]]; then
      violate CHALLENGE_MISSING \
        "phase=${phase}/${round} fn=${fn}: the wrapper was called and NOTHING recorded it (raw delta 0, 0 log lines for ${tag})"
      ok=0
    elif [[ "$n" -eq 0 && "$raw_delta" -ne 0 ]]; then
      # the counter moved but the external recorder saw no line with OUR tag —
      # a fixed or replayed correlation rather than silence
      local seen
      seen="$(awk '/NT_CANARY_HIT fn=/ { last = $0 } END { print last }' "$logf")"
      violate CHALLENGE_NONCE_MISMATCH \
        "phase=${phase}/${round} fn=${fn}: an event was recorded but not under the run's nonce tag ${tag} (last hit line: ${seen:-none})"
      ok=0
    elif [[ "$n" -gt 1 || "$raw_delta" -gt 1 ]]; then
      violate CHALLENGE_DUPLICATE \
        "phase=${phase}/${round} fn=${fn}: one call produced ${n} log events and moved the counter by ${raw_delta}; exactly one of each is required"
      ok=0
    elif [[ "$raw_delta" -eq 0 ]]; then
      violate CHANNEL_DISAGREEMENT \
        "phase=${phase}/${round} fn=${fn}: the server log recorded the call but the rollback-proof counter did not move"
      ok=0
    fi
    if [[ "$raw_delta" -ne "$hits_delta" ]]; then
      violate COUNTER_FABRICATED \
        "phase=${phase}/${round} fn=${fn}: nt_canary.hits() moved by ${hits_delta} while the raw sequence moved by ${raw_delta}"
      ok=0
    fi
    [[ "$ok" -eq 1 ]] || bad=1

    # the ledger line, MACed so the caller cannot edit its own result
    local rec="${STATE}/.rec"
    printf '{"phase":"%s","round":%s,"fn":"%s","tag":"%s","rawDelta":%s,"hitsDelta":%s,"logLines":%s,"ok":%s,"ord":%s}' \
      "$phase" "$round" "$fn" "$tag" "$raw_delta" "$hits_delta" "$n" "$ok" \
      "$(date +%s%N)" > "$rec"
    printf '%s %s\n' "$(mac "$key" "$rec")" "$(cat "$rec")" >> "${STATE}/ledger.jsonl"
    rm -f "$rec"

    say "SENSOR_CHALLENGE=${phase}/${round}|${fn}|rawDelta=${raw_delta}|hitsDelta=${hits_delta}|logLines=${n}|ok=${ok}"
  done < "$out"

  local got
  got="$(grep -c '^SENSOR_CHAL=' "$out" || true)"
  if [[ "$got" != "3" ]]; then
    violate CHALLENGE_INCOMPLETE "phase=${phase}/${round}: ${got} of 3 wrappers were challenged"
    bad=1
  fi
  return "$bad"
}

# Re-reads the whole sensor and compares it, in full, with what `arm` recorded.
compare_definitions() {  # label
  local label="$1"
  local now="${STATE}/dump-${label}.txt"
  local raw="${STATE}/dump-${label}.raw"
  if ! psql_file "${SQLDIR}/50_sensor_dump.sql" "$raw"; then
    violate SENSOR_DISAPPEARED "the sensor dump could not run at ${label}: the sensor schema may be gone"
    return 1
  fi
  local grc
  set +e
  grep -E '^SENSOR_(OBJ|REL|NSP)=' "$raw" > "$now"
  grc=$?
  set -e
  if [[ "$grc" -ne 0 ]]; then
    violate SENSOR_DISAPPEARED "the sensor dump at ${label} contains no sensor objects at all"
    return 1
  fi
  # PRESENCE, checked before equality. A dropped sensor and a rewritten one are
  # different failures and deserve different names: `DEFINITION_DRIFT` on a
  # schema that is simply gone reads like an edit, and the operator would go
  # looking for a diff.
  count_lines() {  # pattern, file -> count (0 is a result, not an error)
    local n rc
    set +e
    n="$(grep -c -- "$1" "$2")"
    rc=$?
    set -e
    case "$rc" in 0) ;; 1) n=0 ;; *) harness "grep failed reading $2 (rc=$rc)" ;; esac
    printf '%s' "$n"
  }
  local missing=()
  [[ "$(count_lines '^SENSOR_NSP=nt_canary|' "$now")"                     -ge 1 ]] || missing+=("schema nt_canary")
  [[ "$(count_lines '^SENSOR_OBJ=public|vault_' "$now")"                  -ge 3 ]] || missing+=("the three public.vault_* wrappers")
  [[ "$(count_lines '^SENSOR_OBJ=nt_canary|log_call|' "$now")"            -ge 1 ]] || missing+=("nt_canary.log_call")
  [[ "$(count_lines '^SENSOR_OBJ=nt_canary|hits|' "$now")"                -ge 1 ]] || missing+=("nt_canary.hits")
  [[ "$(count_lines '^SENSOR_REL=nt_canary|calls|' "$now")"               -ge 1 ]] || missing+=("nt_canary.calls")
  [[ "$(count_lines '^SENSOR_REL=nt_canary|hit_vault_' "$now")"           -ge 3 ]] || missing+=("the three rollback-proof hit counters")
  [[ "$(count_lines '^SENSOR_OBJ=nt_canary|real_vault_' "$now")"          -ge 3 ]] || missing+=("the three delegate clones")
  if [[ "${#missing[@]}" -gt 0 ]]; then
    violate SENSOR_DISAPPEARED "at ${label} the sensor is missing: $(IFS='; '; echo "${missing[*]}")"
  fi
  if ! diff -u "${STATE}/expected-dump.txt" "$now" > "${STATE}/diff-${label}.txt"; then
    violate DEFINITION_DRIFT \
      "the sensor's catalogue record changed by ${label} ($(grep -c '^[+-][^+-]' "${STATE}/diff-${label}.txt") changed lines; see ${STATE}/diff-${label}.txt)"
    sed -n '1,40p' "${STATE}/diff-${label}.txt" >&2
    return 1
  fi
  say "SENSOR_DEFINITIONS=${label}|unchanged|objects=$(wc -l < "$now")"
  return 0
}

case "$CMD" in

# ============================================================================
arm)
  [[ -n "$PG_C" ]]   || harness "--pg is required"
  [[ -n "$SCHEMA" ]] || harness "--schema is required"
  [[ -n "$STATE" ]]  || harness "--state is required"
  [[ -n "$ARTIFACT_DIGEST" ]] || harness \
    "--artifact-digest is required: the nonce must be drawn AFTER the artifact under test is fixed"

  rm -rf "$STATE"
  mkdir -p "$STATE"
  chmod 0700 "$STATE"

  verify_trusted_sql

  # 1. the trusted runner installs the instrumentation
  psql_file "$INSTALL_SQL" "${STATE}/install.out" \
    || dief INSTALL_FAILED "the trusted instrumentation did not install"
  grep -Fq 'CANARY_INSTALL=' "${STATE}/install.out" \
    || dief INSTALL_FAILED "the install printed no verdict line"
  say "SENSOR_INSTALL=trusted|$(grep -F 'CANARY_INSTALL=' "${STATE}/install.out" | head -1)"

  # 2. the artifact is fixed; NOW draw the nonce and the run key
  printf '%s' "$ARTIFACT_DIGEST" > "${STATE}/artifact-digest"
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${STATE}/nonce"
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${STATE}/runkey"
  chmod 0600 "${STATE}/nonce" "${STATE}/runkey"
  NONCE="$(cat "${STATE}/nonce")"
  [[ "${#NONCE}" -eq 32 ]] || harness "the nonce is not 128 bits"
  say "SENSOR_NONCE=drawn|after-artifact|bits=128"

  # 3. the complete catalogue record, and the digest pinned in this checkout
  psql_file "${SQLDIR}/50_sensor_dump.sql" "${STATE}/dump-arm.raw" \
    || dief SENSOR_DISAPPEARED "the sensor dump failed immediately after install"
  grep -E '^SENSOR_(OBJ|REL|NSP)=' "${STATE}/dump-arm.raw" > "${STATE}/expected-dump.txt" \
    || dief SENSOR_DISAPPEARED "the install produced no sensor objects"
  DUMP_DIGEST="$(digest_file "${STATE}/expected-dump.txt")"

  PINNED="${EXPECTED_DIR}/sensor-objects.${SCHEMA}.sha256"
  [[ -f "$PINNED" ]] || dief EXPECTED_DEFINITION_UNPINNED \
    "this checkout pins no expected sensor definition for schema ${SCHEMA} (looked for $PINNED); record it deliberately"
  WANT="$(tr -d '[:space:]' < "$PINNED")"
  if [[ "$DUMP_DIGEST" != "$WANT" ]]; then
    printf 'SENSOR_VIOLATION=%s %s\n' EXPECTED_DEFINITION_MISMATCH \
      "the installed sensor is ${DUMP_DIGEST}, this checkout expects ${WANT}" >&2
    if [[ -f "${EXPECTED_DIR}/sensor-objects.${SCHEMA}.txt" ]]; then
      diff -u "${EXPECTED_DIR}/sensor-objects.${SCHEMA}.txt" "${STATE}/expected-dump.txt" \
        | sed -n '1,40p' >&2 || true
    fi
    exit "$EXIT_SENSOR"
  fi
  say "SENSOR_EXPECTED=matched-pin|schema=${SCHEMA}|digest=${DUMP_DIGEST}"

  # 4. the keyed run manifest
  KEY="$(cat "${STATE}/runkey")"
  WRAPPERS="$(grep '^SENSOR_OBJ=public|vault_' "${STATE}/expected-dump.txt" \
              | sed 's/^SENSOR_OBJ=//' \
              | awk -F'|' '{printf "%s%s(%s)", (NR>1?",":""), $2, $3}')"
  {
    printf '{'
    printf '"schema":"%s",'          "$SCHEMA"
    printf '"pgContainer":"%s",'     "$PG_C"
    printf '"artifactDigest":"%s",'  "$ARTIFACT_DIGEST"
    printf '"nonce":"%s",'           "$NONCE"
    printf '"expectedDumpDigest":"%s",' "$DUMP_DIGEST"
    printf '"pinnedDigest":"%s",'    "$WANT"
    printf '"installSqlDigest":"%s",' "$(digest_file "${EXPECTED_DIR}/sql.sha256sums")"
    printf '"requiredPhases":"%s",'  "$PHASES_REQUIRED"
    printf '"wrappers":"%s",'        "$WRAPPERS"
    printf '"createdAt":"%s"'        "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '}'
  } > "${STATE}/manifest.json"
  mac "$KEY" "${STATE}/manifest.json" > "${STATE}/manifest.hmac"
  chmod 0600 "${STATE}/manifest.json" "${STATE}/manifest.hmac"
  say "SENSOR_MANIFEST=sealed|wrappers=${WRAPPERS}"

  # 5. the candidate must not be able to reach any of it
  if ! psql_file "${SQLDIR}/52_tamper_control.sql" "${STATE}/tamper.out"; then
    dief TAMPER_CONTROL_FAILED "the tamper control did not run"
  fi
  TAMPER="$(grep -F 'SENSOR_TAMPER_RESULT=' "${STATE}/tamper.out" | head -1)"
  say "${TAMPER}"
  case "$TAMPER" in
    *"=UNREACHABLE|"*) ;;
    *) grep -F 'SENSOR_TAMPER=' "${STATE}/tamper.out" > "${STATE}/tamper.lines" || true
       grep -F 'refused=f' "${STATE}/tamper.lines" >&2 || true
       dief CANDIDATE_CAN_REACH_SENSOR "a role the image under test can arrive as was able to modify the sensor" ;;
  esac
  # ...and every refusal must be the refusal this control is about. A rename
  # that makes an attempt fail 42P01 — undefined object, i.e. never attempted —
  # used to satisfy `refused=true` and yield UNREACHABLE|succeeded=0. The
  # control then reported a victory over an attack it had not launched.
  case "$TAMPER" in
    *"|wrong_class=0") ;;
    *"|wrong_class="*)
       grep -F 'SENSOR_TAMPER_WRONG_CLASS=' "${STATE}/tamper.out" >&2 || true
       dief TAMPER_WRONG_FAILURE_CLASS \
         "an attempt was refused with a SQLSTATE other than the one it must fail with; a refusal that is not an insufficient_privilege refusal is not evidence that the privilege holds (${TAMPER})" ;;
    *) dief TAMPER_CONTROL_FAILED \
         "the tamper control printed no wrong_class count; this checkout expects the class-checking form of 52_tamper_control.sql (${TAMPER})" ;;
  esac
  TAMPER_ATTEMPTS="$(sed -n 's/.*|attempts=\([0-9]*\)|.*/\1/p' <<< "$TAMPER")"
  # 4 roles x 6 attempts. A control that silently stopped trying is not a
  # control, and "24" is the only number that means it ran.
  [[ "$TAMPER_ATTEMPTS" == "24" ]] || dief TAMPER_CONTROL_FAILED \
    "the tamper control made ${TAMPER_ATTEMPTS:-no} attempts; 4 roles x 6 attacks = 24 are required"
  say "SENSOR_TAMPER_CLASS=all-24-refused-42501"

  # 6. the baseline counters, and the first challenge
  : > "${STATE}/ledger.jsonl"
  psql_file "${SQLDIR}/50_sensor_dump.sql" "${STATE}/dump-baseline.raw" >/dev/null 2>&1 || true
  docker exec "$PG_C" psql -U postgres -d postgres -X -tA -c "
    select string_agg(fn || '=' ||
             coalesce(pg_catalog.pg_sequence_last_value(('nt_canary.hit_' || fn)::regclass), 0)::text,
             ',' order by fn)
      from (values ('vault_create_secret'),('vault_update_secret'),('vault_delete_secret')) v(fn)" \
    | tr -d '[:space:]' > "${STATE}/baseline-counters"
  say "SENSOR_BASELINE=$(cat "${STATE}/baseline-counters")"

  if ! run_challenge pre 0; then
    printf 'SENSOR_VIOLATION=%s %s\n' ARM_CHALLENGE_FAILED \
      "the sensor did not answer its first challenge; no absence from this run means anything" >&2
    exit "$EXIT_SENSOR"
  fi
  say "SENSOR_ARMED=yes|schema=${SCHEMA}"
  exit 0
  ;;

# ============================================================================
challenge)
  require_state
  [[ -n "$PG_C" ]] || harness "--pg is required"
  case "$PHASE" in mid|post|pre) ;; *) harness "--phase must be pre, mid or post" ;; esac
  # A challenge is only meaningful if the sensor is still the sensor.
  drift=0
  compare_definitions "${PHASE}-${ROUND}" || drift=1
  chal=0
  run_challenge "$PHASE" "$ROUND" || chal=1
  if [[ "$drift" -ne 0 || "$chal" -ne 0 ]]; then exit "$EXIT_SENSOR"; fi
  exit 0
  ;;

# ============================================================================
report)
  require_state
  [[ -n "$PG_C" ]] || harness "--pg is required"
  KEY="$(cat "${STATE}/runkey")"
  NONCE="$(cat "${STATE}/nonce")"

  # --- ADV-3. THE REPORT IS SEALED WITH THIS RUN'S KEY ----------------------
  #
  # `verdict.mjs` derives the sensor verdict from this report, which closed
  # audit finding F: asserting --sensor-verdict TRUSTWORTHY on the command line
  # with no runner artefacts present is now refused. An auditor then defeated
  # that by RETYPING the file: delete every trusted-runner artefact and write
  # eight lines of plain text in the documented shape, and the report parses to
  # verdict TRUSTWORTHY, manifestVerified true, with the phase counts chosen to
  # satisfy the counter cross-check. (The cross-check itself works — wrong
  # phase counts ARE refused. What did not work was the artefact's
  # authenticity.)
  #
  # So the body of the report is written to a file here and MACed with
  # `${STATE}/runkey` — the same per-run key that already seals the manifest
  # and every ledger line, drawn from /dev/urandom at `arm` into a directory no
  # container mounts. `verdict.mjs` derives the verdict from the SEALED body,
  # not from the text file, and cross-checks that the two agree.
  #
  # WHAT THIS IS AND IS NOT. The key is written into the artefact directory,
  # because a re-verification of an existing directory has to be able to check
  # the seal, and a key destroyed at the end of the run would make every later
  # re-verification refuse. So this is tamper-EVIDENCE against a partial edit
  # — retyping the report, deleting the state tree, flipping UNTRUSTWORTHY to
  # TRUSTWORTHY — and not a signature against an operator who still holds the
  # whole directory. That residual is the same one the `artefact-forgery` scope
  # statement names, and it is stated there rather than papered over here.
  REPORT_BODY="${STATE}/report-body.txt"
  : > "$REPORT_BODY"
  # Redefined for this command only: every reported line goes to stdout AND
  # into the body that gets sealed, so the seal covers what the reader sees.
  say() { printf '%s\n' "$*"; printf '%s\n' "$*" >> "$REPORT_BODY"; }
  seal_report() {
    mac "$KEY" "$REPORT_BODY" > "${STATE}/report.hmac"
    chmod 0600 "${STATE}/report.hmac"
    printf 'SENSOR_SEAL=%s\n' "$(cat "${STATE}/report.hmac")"
  }

  # 1. the manifest must still be the manifest this run sealed
  if [[ ! -f "${STATE}/manifest.json" || ! -f "${STATE}/manifest.hmac" ]]; then
    dief MANIFEST_MISSING "no sealed manifest in ${STATE}"
  fi
  if [[ "$(mac "$KEY" "${STATE}/manifest.json")" != "$(cat "${STATE}/manifest.hmac")" ]]; then
    dief MANIFEST_HMAC_INVALID "the run manifest was modified after it was sealed"
  fi
  say "SENSOR_MANIFEST=verified"

  # 2. the definitions, one last time
  compare_definitions final || true

  # 3. the ledger: every line MACed by this run's key
  [[ -f "${STATE}/ledger.jsonl" ]] || dief LEDGER_MISSING "no challenge ledger"
  nline=0
  while IFS=' ' read -r m rest; do
    nline=$(( nline + 1 ))
    printf '%s' "$rest" > "${STATE}/.verify"
    if [[ "$(mac "$KEY" "${STATE}/.verify")" != "$m" ]]; then
      violate LEDGER_TAMPERED "challenge ledger line ${nline} does not verify against this run's key"
    fi
    rm -f "${STATE}/.verify"
  done < "${STATE}/ledger.jsonl"
  say "SENSOR_LEDGER=lines=${nline}"

  # 4. every required phase present, complete, in order, and correlated
  IFS=',' read -r -a want_phases <<< "$PHASES_REQUIRED"
  for ph in "${want_phases[@]}"; do
    n=0; grc=0
    set +e
    n="$(grep -c "\"phase\":\"${ph}\"" "${STATE}/ledger.jsonl")"
    grc=$?
    set -e
    case "$grc" in 0) ;; 1) n=0 ;; *) harness "grep failed on the ledger" ;; esac
    if [[ "$n" -eq 0 ]]; then
      violate PHASE_MISSING "no challenge was recorded for the required phase '${ph}'; turning a check off is not a way to pass"
    elif (( n % 3 != 0 )); then
      violate PHASE_INCOMPLETE "phase '${ph}' recorded ${n} challenge events, which is not a whole number of 3-wrapper rounds"
    fi
    say "SENSOR_PHASE=${ph}|events=${n}"
  done
  # ordering: the last `post` event must come after the last `mid` event, which
  # must come after the `pre` event.
  # A single awk pass, deliberately not `grep | sed | sort | tail`: a pipeline
  # whose first stage legitimately finds nothing exits non-zero under
  # `pipefail`, and the command substitution then kills the script mid-report.
  ord_of() {  # phase -> the greatest ordinal recorded for it, or empty
    awk -v ph="\"phase\":\"$1\"" '
      index($0, ph) {
        if (match($0, /"ord":[0-9]+/)) {
          v = substr($0, RSTART + 6, RLENGTH - 6) + 0
          if (v > m) m = v
        }
      }
      END { if (m > 0) print m }
    ' "${STATE}/ledger.jsonl"
  }
  o_pre="$(ord_of pre)"; o_mid="$(ord_of mid)"; o_post="$(ord_of post)"
  if [[ -n "$o_pre" && -n "$o_post" && "$o_post" -le "$o_pre" ]]; then
    violate PHASE_OUT_OF_ORDER "the post-matrix challenge is not after the pre-matrix one"
  fi
  if [[ -n "$o_mid" && -n "$o_post" && "$o_post" -le "$o_mid" ]]; then
    violate PHASE_OUT_OF_ORDER "the post-matrix challenge is not after the interleaved ones"
  fi

  # every recorded event must carry THIS run's nonce
  set +e
  nbad="$(grep -c -v "\"tag\":\"chal:${NONCE}:" "${STATE}/ledger.jsonl")"
  grc=$?
  set -e
  case "$grc" in 0) ;; 1) nbad=0 ;; *) harness "grep failed on the ledger" ;; esac
  [[ "$nbad" -eq 0 ]] || violate STALE_NONCE "${nbad} ledger events are not tagged with this run's nonce"

  # any event that failed its own cross-channel check
  set +e
  nfail="$(grep -c '"ok":0' "${STATE}/ledger.jsonl")"
  grc=$?
  set -e
  case "$grc" in 0) ;; 1) nfail=0 ;; *) harness "grep failed on the ledger" ;; esac
  [[ "$nfail" -eq 0 ]] || violate CHALLENGE_FAILED "${nfail} challenge events did not produce exactly one correlated record"

  # 5. the post-matrix state must be exactly what the challenges explain
  #
  # Read without a pipeline and with the status interpreted: when the sabotage
  # under test is "drop the sensor", this query FAILS, and a `docker … | tr`
  # pipeline under `pipefail` would abort the report with a bare exit 1 —
  # a status that means nothing to the caller and hides the real finding
  # behind a crash.
  rounds=$(( nline / 3 ))
  counters_readable=1
  set +e
  docker exec "$PG_C" psql -U postgres -d postgres -X -tA -c "
    select string_agg(fn || '=' ||
             coalesce(pg_catalog.pg_sequence_last_value(('nt_canary.hit_' || fn)::regclass), 0)::text,
             ',' order by fn)
      from (values ('vault_create_secret'),('vault_update_secret'),('vault_delete_secret')) v(fn)" \
    > "${STATE}/final-counters.raw" 2> "${STATE}/final-counters.err"
  cnt_rc=$?
  set -e
  if [[ "$cnt_rc" -ne 0 ]]; then
    counters_readable=0
    violate SENSOR_DISAPPEARED \
      "the rollback-proof counters could not be read at the end of the run (psql rc=${cnt_rc}); the sensor is not there to be read"
    : > "${STATE}/final-counters"
  else
    tr -d '[:space:]' < "${STATE}/final-counters.raw" > "${STATE}/final-counters"
  fi
  say "SENSOR_FINAL=$(cat "${STATE}/final-counters")|rounds=${rounds}"
  if [[ "$EXTRA_HITS_POLICY" == "zero" && "$counters_readable" -eq 1 ]]; then
    base="$(cat "${STATE}/baseline-counters")"
    fin="$(cat "${STATE}/final-counters")"
    IFS=',' read -r -a bs <<< "$base"
    IFS=',' read -r -a fs <<< "$fin"
    for i in "${!bs[@]}"; do
      bfn="${bs[$i]%%=*}"; bv="${bs[$i]##*=}"; fv="${fs[$i]##*=}"
      exp=$(( bv + rounds + EXPECTED_EXTRA_HITS ))
      if [[ "$fv" -ne "$exp" ]]; then
        violate UNEXPECTED_POST_MATRIX_STATE \
          "${bfn}: the counter is ${fv}; a baseline of ${bv} plus ${rounds} challenges plus ${EXPECTED_EXTRA_HITS} accounted-for hits explain ${exp}. The difference is a call this run cannot account for."
      fi
    done
  fi

  # The RESULT line goes through `say` in both directions, so the seal covers
  # an UNTRUSTWORTHY verdict too. Sealing only the good news would let the one
  # edit that matters — UNTRUSTWORTHY -> TRUSTWORTHY in the text file — pass
  # unnoticed, which is the same defect one level down.
  if [[ "${#violations[@]}" -gt 0 ]]; then
    say "SENSOR_RESULT=UNTRUSTWORTHY|violations=$(IFS=,; echo "${violations[*]}")"
    seal_report
    exit "$EXIT_SENSOR"
  fi
  say "SENSOR_RESULT=TRUSTWORTHY|rounds=${rounds}|phases=${PHASES_REQUIRED}|accountedExtraHits=${EXPECTED_EXTRA_HITS}"
  seal_report
  exit 0
  ;;

*) harness "unknown command: $CMD" ;;
esac
