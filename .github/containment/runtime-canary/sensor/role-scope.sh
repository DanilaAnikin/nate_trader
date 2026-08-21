#!/usr/bin/env bash
# ============================================================================
# role-scope.sh — the tamper control's role list must BE the reachable set
#
# THE DEFECT THIS CLOSES (audit finding B8(ii))
# ---------------------------------------------
# `sensor/sql/52_tamper_control.sql` proves that no role a request can arrive as
# can disable the canary. It does that against a HAND-PINNED list of four roles:
#
#     roles text[] := array['anon','authenticated','service_role','authenticator'];
#
# `sink/sink.mjs` independently hand-pins the three roles PostgREST switches to:
#
#     const SAFE_ROLES = new Set(["service_role", "authenticated", "anon"]);
#
# and connects as a fourth, `SINK_PGUSER` (`authenticator`). The two lists were
# never compared. That is the exact shape of the defect C5 was fixed for: a
# hand-maintained list standing in for a derived one, where adding a role to one
# side silently narrows the other side's proof. Outside the list the sensor IS
# defeatable — an audit made role `postgres` replace a watched wrapper on an
# armed clone.
#
# So the tamper control's list is now DERIVED here from the gateway's own source
# and compared with what the SQL actually pins. The derivation is
#
#     reachable = SAFE_ROLES  ∪  {the role the gateway connects as}
#
# and the check is set EQUALITY, in both directions: a role in the SQL that the
# gateway cannot reach is dead weight that makes the proof look wider than it
# is, and a role the gateway CAN reach that the SQL omits is a hole.
#
# COMMENTS ARE STRIPPED BEFORE MATCHING. Three guards in this programme have
# fired on their own documentation; the header of this very file contains both
# literals, and so does 52_tamper_control.sql's prose.
#
# Usage:
#   role-scope.sh --check     compare, print both lists, exit 0 iff equal
#   role-scope.sh --sink      print the gateway-reachable roles, one per line
#   role-scope.sh --sql       print the roles the tamper control attempts
#   role-scope.sh --sink-file F --sql-file F   override either source (tests)
#
# Exit: 0 equal / printed, 1 MISMATCH, 2 the extraction itself failed.
# ============================================================================

set -Eeuo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SINK_FILE="${HERE}/../sink/sink.mjs"
SQL_FILE="${HERE}/sql/52_tamper_control.sql"
ACTION="--check"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--sink|--sql) ACTION="$1"; shift ;;
    --sink-file) SINK_FILE="${2:?}"; shift 2 ;;
    --sql-file)  SQL_FILE="${2:?}";  shift 2 ;;
    *) printf 'role-scope.sh: unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

die() { printf 'ROLE_SCOPE_EXTRACTION_FAILED %s\n' "$*" >&2; exit 2; }

[[ -f "$SINK_FILE" ]] || die "no gateway source at $SINK_FILE"
[[ -f "$SQL_FILE"  ]] || die "no tamper control at $SQL_FILE"

# --- the roles the GATEWAY can reach ---------------------------------------
# Parsed from the gateway's own source with comments removed first, and bounded
# by the literal's OWN terminator `])` rather than by whatever comes next.
sink_roles() {
  local roles conn
  roles="$(node -e '
    const fs = require("node:fs");
    let s = fs.readFileSync(process.argv[1], "utf8");
    // Strip comments BEFORE matching. Both literals appear in this file`s own
    // prose, and a guard that reads its own documentation is not a guard.
    s = s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    const m = /SAFE_ROLES\s*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(s);
    if (!m) { console.error("no SAFE_ROLES literal after comment stripping"); process.exit(2); }
    const roles = [...m[1].matchAll(/["\x27]([a-z_][a-z0-9_]*)["\x27]/g)].map((x) => x[1]);
    if (!roles.length) { console.error("SAFE_ROLES literal is empty"); process.exit(2); }
    // The role the pool itself connects as: `set local role` is only reachable
    // from a session already authenticated as this one.
    const c = /SINK_PGUSER\s*\|\|\s*["\x27]([a-z_][a-z0-9_]*)["\x27]/.exec(s);
    if (!c) { console.error("no default SINK_PGUSER after comment stripping"); process.exit(2); }
    process.stdout.write([...new Set([...roles, c[1]])].sort().join("\n"));
  ' "$SINK_FILE")" || die "could not read SAFE_ROLES / SINK_PGUSER from $SINK_FILE"
  printf '%s\n' "$roles"
}

# --- the roles the TAMPER CONTROL actually attempts -------------------------
# Bounded by the array literal's own `]`, after SQL comments are removed.
sql_roles() {
  local roles
  roles="$(node -e '
    const fs = require("node:fs");
    let s = fs.readFileSync(process.argv[1], "utf8");
    s = s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    const m = /roles\s+text\[\]\s*:=\s*array\s*\[([^\]]*)\]/i.exec(s);
    if (!m) { console.error("no `roles text[] := array[...]` after comment stripping"); process.exit(2); }
    const roles = [...m[1].matchAll(/\x27([a-z_][a-z0-9_]*)\x27/g)].map((x) => x[1]);
    if (!roles.length) { console.error("the roles array is empty"); process.exit(2); }
    process.stdout.write([...new Set(roles)].sort().join("\n"));
  ' "$SQL_FILE")" || die "could not read the roles array from $SQL_FILE"
  printf '%s\n' "$roles"
}

case "$ACTION" in
  --sink) sink_roles; exit 0 ;;
  --sql)  sql_roles;  exit 0 ;;
esac

REACHABLE="$(sink_roles)"
ATTEMPTED="$(sql_roles)"

if [[ "$REACHABLE" != "$ATTEMPTED" ]]; then
  printf 'ROLE_SCOPE_MISMATCH the tamper control does not attempt exactly the gateway-reachable roles\n' >&2
  printf '  gateway-reachable (%s): %s\n' "$(basename "$SINK_FILE")" "$(tr '\n' ' ' <<< "$REACHABLE")" >&2
  printf '  tamper attempts   (%s): %s\n' "$(basename "$SQL_FILE")"  "$(tr '\n' ' ' <<< "$ATTEMPTED")"  >&2
  while IFS= read -r r; do
    grep -qxF "$r" <<< "$ATTEMPTED" || printf '  UNPROVEN a request can arrive as %s and nothing proves it cannot disable the sensor\n' "$r" >&2
  done <<< "$REACHABLE"
  while IFS= read -r r; do
    grep -qxF "$r" <<< "$REACHABLE" || printf '  SURPLUS  the control attempts %s, which no request can arrive as; the proof looks wider than it is\n' "$r" >&2
  done <<< "$ATTEMPTED"
  exit 1
fi

printf 'ROLE_SCOPE_OK reachable=attempted=%s\n' "$(tr '\n' ',' <<< "$REACHABLE" | sed 's/,$//')"
