#!/usr/bin/env bash
# ============================================================================
# k6-tombstone-binding.test.sh — CANARY_TOMBSTONED must be a verdict, not a
#                                substring
#
# The line it replaces was `prosrc LIKE '%superseded and must not be called%'`,
# printed into the transcript and asserted on by nothing. It was wrong in both
# directions and no run could fail because of it.
#
# Cases:
#   P1  a pristine 0001-0023 clone binds to INTENTIONALLY_TOMBSTONED and exits 0
#   P2  a pristine 0001-0008 clone binds to LIVE_EXPECTED and exits 0
#       (both positive controls: a binding that refused everything would pass
#        every negative case below and block every honest run)
#   N1  a genuine tombstone whose MESSAGE was reworded — the old substring test
#       calls it "live"; the real classifier calls it UNEXPECTED
#   N2  a wrapper that still contains the magic phrase but does not raise —
#       the old test calls it "raises-P0001"; the real classifier calls it
#       UNEXPECTED
#   N3  a tombstone that was re-granted to service_role — body identical,
#       phrase present, ACL wrong
#
# Exit: 0 all cases behaved, 1 otherwise, 2 harness failure.
# ============================================================================

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RC="$(cd "${HERE}/.." && pwd)"
# shellcheck source=lib-schema-base.sh
. "${HERE}/lib-schema-base.sh"
BIND="${RC}/tombstone-binding.sh"

WORK="$(mktemp -d /tmp/nt-k6-XXXXXX)"
C="nt-canary-k6t-$$"
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
CASES_INTENDED=(P1 P2 N1 N1b N2 N2b N3)
CASES_SEEN=()
COMPLETED=0
seen() { local t="${1%% *}"; CASES_SEEN+=("${t%:}"); }

cleanup() {
  local __rc=$?
  docker rm -f "$C" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  if [[ "$COMPLETED" -ne 1 ]]; then
    printf '\nk6: the suite exited (rc=%s) WITHOUT reaching its summary; %s of %s cases had reported.\n' \
      "$__rc" "${#CASES_SEEN[@]}" "${#CASES_INTENDED[@]}" >&2
    printf 'An unfinished suite is not a passing one.\n' >&2
    exit "$(( __rc == 0 ? 2 : __rc ))"
  fi
}
trap cleanup EXIT

pass=0; fail=0
ok()  { printf '  \033[1;32mok  \033[0m %s\n' "$*"; pass=$(( pass + 1 )); seen "$*"; }
bad() { printf '  \033[1;31mFAIL\033[0m %s\n' "$*"; fail=$(( fail + 1 )); seen "$*"; }

boot() {  # generation
  docker rm -f "$C" >/dev/null 2>&1 || true
  # Resolved into a variable with its status checked, NOT inline in the docker
  # argument list: a command substitution that fails inside a word expansion
  # does not trip errexit, and the container would start on an empty image name
  # (or, worse, the wrong one) with nothing said about it.
  local base
  if ! base="$(schema_base_image "$1")"; then
    printf 'harness: could not resolve the %s fixture image\n' "$1" >&2
    return 1
  fi
  if ! schema_base_require "$1" "$base"; then
    printf 'harness: the %s fixture image is not the content-keyed fixture\n' "$1" >&2
    return 1
  fi
  docker run -d --name "$C" -e POSTGRES_PASSWORD=x -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$base" >/dev/null
  local streak=0 waited=0 out
  while (( waited < 240 )); do
    if out="$(docker exec "$C" psql -h 127.0.0.1 -p 5432 -U supabase_admin -d postgres -X -tA \
              -c "select count(*)::int from pg_namespace where nspname in ('auth','public','extensions','storage','vault')" 2>/dev/null)"; then
      if [[ "$(printf '%s' "$out" | tr -d '[:space:]')" == "5" ]]; then
        streak=$(( streak + 1 )); (( streak >= 5 )) && return 0
      else streak=0; fi
    else streak=0; fi
    sleep 1; waited=$(( waited + 1 ))
  done
  printf 'harness: %s never became ready\n' "$C" >&2; exit 2
}

apply() { printf '%s' "$1" > "$WORK/m.sql"
  docker cp "$WORK/m.sql" "$C:/m.sql" >/dev/null
  docker exec -i "$C" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1 -f /m.sql >/dev/null; }

# The old classifier, reproduced exactly, so each case can show what it WOULD
# have said. Without this the negative cases prove the new check works but not
# that the old one was wrong.
old_verdict() {
  docker exec "$C" psql -U postgres -d postgres -X -tA -c "
    select string_agg(p.proname || '=' ||
             case when p.prosrc like '%superseded and must not be called%'
                  then 'raises-P0001' else 'live' end, ',' order by p.proname)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'vault\_%'" | tr -d '[:space:]'
}

run_bind() {  # schema -> BIND_OUT, BIND_RC
  set +e
  BIND_OUT="$("$BIND" --pg "$C" --schema "$1" --out "$WORK/classify-$1.txt" 2>&1)"
  BIND_RC=$?
  set -e
}

printf '\n== K6 CANARY_TOMBSTONED bound to the real classifier ==\n\n'

# --- P1 ---------------------------------------------------------------------
boot 0023
run_bind 0023
if [[ "$BIND_RC" -eq 0 ]] && grep -q 'CANARY_TOMBSTONED=vault_create_secret=INTENTIONALLY_TOMBSTONED' <<< "$BIND_OUT"; then
  ok "P1 pristine 0001-0023 -> $(grep -o 'CANARY_TOMBSTONED=[^ ]*' <<< "$BIND_OUT" | head -1)"
else
  bad "P1 a pristine latest schema was not bound (rc=$BIND_RC)"
  sed 's/^/       /' <<< "$BIND_OUT" | head -20
fi

# --- P2 ---------------------------------------------------------------------
boot 0008
run_bind 0008
if [[ "$BIND_RC" -eq 0 ]] && grep -q 'CANARY_TOMBSTONED=vault_create_secret=LIVE_EXPECTED' <<< "$BIND_OUT"; then
  ok "P2 pristine 0001-0008 -> $(grep -o 'CANARY_TOMBSTONED=[^ ]*' <<< "$BIND_OUT" | head -1)"
else
  bad "P2 a pristine 0008 schema was not bound (rc=$BIND_RC)"
  sed 's/^/       /' <<< "$BIND_OUT" | head -20
fi

# --- N1 the reworded tombstone ---------------------------------------------
boot 0023
apply "create or replace function public.vault_create_secret(p_secret text, p_name text default null::text)
returns uuid language plpgsql set search_path = public, vault as \$\$
begin
  raise exception 'vault_create_secret has been retired by migration 0022 and must not be called'
    using errcode = 'P0001';
end; \$\$;"
OLD="$(old_verdict)"
run_bind 0023
if [[ "$BIND_RC" -ne 0 ]] && grep -q 'CANARY_TOMBSTONED_FAIL=' <<< "$BIND_OUT"; then
  ok "N1 reworded tombstone: old substring test said '${OLD}', the binding refuses (rc=$BIND_RC, $(grep -o 'CANARY_TOMBSTONED_FAIL=[A-Z_]*' <<< "$BIND_OUT" | head -1))"
else
  bad "N1 a reworded tombstone was accepted (rc=$BIND_RC)"
  sed 's/^/       /' <<< "$BIND_OUT" | head -20
fi
case "$OLD" in
  *vault_create_secret=live*) ok "N1b and the old test really did call the genuine tombstone 'live'" ;;
  *) bad "N1b the old test did not misclassify here; the case is not demonstrating what it claims (${OLD})" ;;
esac

# --- N2 the phrase without the raise ---------------------------------------
boot 0023
apply "create or replace function public.vault_delete_secret(p_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public, vault as \$\$
begin
  -- this routine is superseded and must not be called (says the comment)
  delete from vault.secrets where id = p_id;
end; \$\$;
grant execute on function public.vault_delete_secret(uuid) to service_role;"
OLD="$(old_verdict)"
run_bind 0023
if [[ "$BIND_RC" -ne 0 ]] && grep -q 'CANARY_TOMBSTONED_FAIL=' <<< "$BIND_OUT"; then
  ok "N2 a LIVE deleter carrying the magic phrase: old test said '${OLD}', the binding refuses (rc=$BIND_RC)"
else
  bad "N2 a live wrapper carrying the phrase was accepted (rc=$BIND_RC)"
  sed 's/^/       /' <<< "$BIND_OUT" | head -20
fi
case "$OLD" in
  *vault_delete_secret=raises-P0001*) ok "N2b and the old test really did call the live deleter 'raises-P0001'" ;;
  *) bad "N2b the old test did not misclassify here (${OLD})" ;;
esac

# --- N3 the re-granted tombstone -------------------------------------------
boot 0023
apply "grant execute on function public.vault_create_secret(text, text) to service_role;"
OLD="$(old_verdict)"
run_bind 0023
if [[ "$BIND_RC" -ne 0 ]] && grep -q 'CANARY_TOMBSTONED_FAIL=' <<< "$BIND_OUT"; then
  ok "N3 a tombstone re-granted to service_role: old test said '${OLD}', the binding refuses (rc=$BIND_RC)"
else
  bad "N3 a re-granted tombstone was accepted (rc=$BIND_RC)"
  sed 's/^/       /' <<< "$BIND_OUT" | head -20
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
