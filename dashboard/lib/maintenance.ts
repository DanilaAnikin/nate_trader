import "server-only";
import { NextResponse } from "next/server";
import { mayBypassFreeze } from "./isolated-smoke";

/**
 * The deployment write freeze, enforced inside this image.
 *
 * This build is the **bridge**: it reads correctly on both the pre-`0011` and
 * the post-`0019` schema, which is what makes it the one image that can serve
 * while the migrations are applied and the one image a rollback can land on
 * from either side. What it is *not*, as tagged, is write-safe:
 *
 *   * its account lifecycle operations are a sequence of separate Vault and
 *     row writes, so a failure between them leaves a new key beside the old
 *     secret with the previous key value already overwritten — unrecoverable;
 *   * and those operations do **not** start failing after the migrations. This
 *     build never calls `0013`/`0014`'s transactional RPCs; it performs the
 *     same individual writes it always did, and every one still succeeds. The
 *     window is not self-protecting. It looks like it works.
 *
 * So the freeze is a control in the code, not a note in a runbook.
 * `DASHBOARD_MAINTENANCE_MODE=on` makes every mutating path return `503`
 * before it touches Alpaca, the Vault or the database.
 *
 * **Including the reads.** In this build `GET /api/accounts/[id]/equity` and
 * `GET .../performance` call `backfillEquity` and `backfillCashFlows`, which
 * write `equity_snapshots` and `cash_flows` as a side effect of being read. A
 * freeze that covered only `POST`, `PATCH` and `DELETE` would leave the
 * financial mirrors moving on every page poll while the schema underneath them
 * changed — the largest write in the application, unfrozen. `maintenanceBlock`
 * is therefore called from those two handlers as well, which is the difference
 * between this commit and setting an environment variable on `fc73acaae`.
 *
 * It is an environment variable rather than a database flag on purpose: the
 * freeze must hold while the database is being migrated, and a flag stored in
 * the thing being migrated cannot do that.
 */
const ENABLED_VALUES: ReadonlySet<string> = new Set(["on", "1", "true", "yes"]);

export function maintenanceModeEnabled(): boolean {
  const raw = process.env.DASHBOARD_MAINTENANCE_MODE?.trim().toLowerCase();
  return raw !== undefined && ENABLED_VALUES.has(raw);
}

/**
 * The 503 a mutating handler returns during a freeze, or null when no freeze
 * is in force.
 */
/**
 * The 503, unless this user is an allowlisted operator on an isolated sidecar.
 *
 * The disposable-observer mutation tests need writes to work *for the
 * operator* while staying blocked for everyone else, which one global flag
 * cannot express. `mayBypassFreeze` requires both halves — sidecar isolation
 * *and* a named user — so the bypass cannot exist on a publicly reachable
 * image.
 */
export function maintenanceBlock(userId?: string | null): NextResponse | null {
  if (!maintenanceModeEnabled()) return null;
  if (mayBypassFreeze(userId)) return null;
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

/**
 * The same freeze, expressed for a read handler whose *side effect* must be
 * skipped while the read itself continues to be served.
 *
 * Returning 503 from `GET /equity` would blank the chart for the whole
 * maintenance window, which helps nobody: the stored rows are still readable
 * and still true. What must stop is the backfill. Callers use this to skip the
 * write and attach a reason to the response.
 */
export function backfillFrozen(): string | null {
  if (!maintenanceModeEnabled()) return null;
  return "MAINTENANCE_MODE: the broker mirrors were not refreshed because a schema migration or rollback is in progress. The stored history below is unchanged.";
}
