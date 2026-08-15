#!/usr/bin/env python3
"""Put the flag gate back in proxy.ts, and change nothing else.

The mutation for Phase 1E. It restores exactly what commit 86654b552 removed —
the `FREEZE_VALUES` / `maintenanceFrozen()` / `bypassPossible()` helpers and
the four-clause condition — taken verbatim from 86654b552^.

Written as a targeted edit rather than `git apply` of that commit's diff on
purpose. The diff carries the comment rewrite as well, so it stops applying the
moment anyone touches the prose around the condition, and a mutation harness
that breaks on a comment edit is a harness nobody will keep running. This
reproduces the semantic revert and is indifferent to the surrounding text.

Every edit asserts it changed something. A revert that silently no-ops would
leave a copy of the artifact wearing the label "mutated", and the comparison
would report the defect absent for the wrong reason.
"""
import sys
import pathlib

HELPERS = '''
const FREEZE_VALUES: ReadonlySet<string> = new Set(["on", "1", "true", "yes"]);

/**
 * The freeze flag, read here rather than imported from `lib/maintenance` so
 * this file keeps no `server-only` dependency.
 */
function maintenanceFrozen(): boolean {
  const raw = process.env.DASHBOARD_MAINTENANCE_MODE?.trim().toLowerCase();
  return raw !== undefined && FREEZE_VALUES.has(raw);
}

/**
 * True when this image may be carrying an operator freeze bypass.
 */
function bypassPossible(): boolean {
  const sidecar = process.env.DASHBOARD_SIDECAR_ONLY?.trim().toLowerCase();
  if (sidecar === undefined || !FREEZE_VALUES.has(sidecar)) return false;
  const allowlist = process.env.DASHBOARD_FREEZE_BYPASS_USERS?.trim();
  return Boolean(allowlist);
}
'''

ANCHOR = '''const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
'''

OLD_COND = '''  if (isApi && MUTATING_METHODS.has(request.method)) {
    return NextResponse.json(FROZEN_BODY, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Artifact-Role": ARTIFACT_ROLE,
        "X-Writes-Enabled": "false",
      },
    });
  }
'''

NEW_COND = '''  if (
    isApi &&
    MUTATING_METHODS.has(request.method) &&
    maintenanceFrozen() &&
    !bypassPossible()
  ) {
    void ARTIFACT_ROLE;
    void FROZEN_BODY;
    return NextResponse.json(
      {
        code: "MAINTENANCE_MODE",
        error:
          "The dashboard is in maintenance mode: writes are frozen while a schema migration or rollback is in progress.",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "600" },
      },
    );
  }
'''


def main() -> int:
    path = pathlib.Path(sys.argv[1])
    src = path.read_text()

    if ANCHOR not in src:
        print("phase1e: MUTATING_METHODS anchor not found", file=sys.stderr)
        return 1
    if OLD_COND not in src:
        print("phase1e: the unconditional freeze block not found", file=sys.stderr)
        return 1

    out = src.replace(ANCHOR, ANCHOR + HELPERS, 1)
    if out == src:
        print("phase1e: helper insertion was a no-op", file=sys.stderr)
        return 1

    before = out
    out = out.replace(OLD_COND, NEW_COND, 1)
    if out == before:
        print("phase1e: condition replacement was a no-op", file=sys.stderr)
        return 1

    # the property the mutation exists to create
    if "maintenanceFrozen()" not in out or "!bypassPossible()" not in out:
        print("phase1e: the flag gate is not present after the edit", file=sys.stderr)
        return 1

    path.write_text(out)
    print("phase1e: flag gate restored in", path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
