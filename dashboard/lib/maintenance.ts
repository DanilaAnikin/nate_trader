import "server-only";
import { NextResponse } from "next/server";

/**
 * The deployment write freeze, enforced in the application.
 *
 * Hold application writes while migrations or an image rollback are underway.
 * A stray browser tab, retry or second operator must not start a lifecycle
 * operation against a schema in transition. After 0022, the bridge's legacy
 * Vault RPCs are retired; the bridge is a read-only rollback target and must
 * remain frozen against the latest schema.
 *
 * `DASHBOARD_MAINTENANCE_MODE=on` makes every mutating handler return 503
 * before it touches Alpaca, the Vault or the database. It is deliberately an
 * environment variable rather than a database flag: the freeze must hold even
 * while the database is being migrated, and a flag stored in the thing being
 * migrated cannot do that.
 *
 * What it covers, which is more than the lifecycle endpoints:
 *
 *   * account create / update / delete / rotate / verify — the obvious ones;
 *   * profile preferences through `PATCH /api/profile`;
 *   * **`POST .../refresh`** — a broker refresh writes `equity_snapshots`,
 *     `cash_flows`, `broker_refresh_state` and `broker_refresh_token`. A
 *     freeze that let those through would be a freeze on the small tables
 *     while the financial mirrors kept moving.
 *
 * Reads are unaffected: they no longer write anything (see the status, live,
 * equity and performance handlers), so serving them during a freeze is safe
 * and keeps the dashboard legible while the work happens.
 * This does not freeze the separate Auth service (login, password changes,
 * session refresh or logout) or requests that bypass this application.
 */
const ENABLED_VALUES: ReadonlySet<string> = new Set(["on", "1", "true", "yes"]);

export function maintenanceModeEnabled(): boolean {
  const raw = process.env.DASHBOARD_MAINTENANCE_MODE?.trim().toLowerCase();
  return raw !== undefined && ENABLED_VALUES.has(raw);
}

/**
 * The 503 a mutating handler returns during a freeze. Returns null when no
 * freeze is in force, so a handler can `?? continue`.
 */
export function maintenanceBlock(): NextResponse | null {
  if (!maintenanceModeEnabled()) return null;
  return NextResponse.json(
    {
      code: "MAINTENANCE_MODE",
      error:
        "The dashboard is in maintenance mode: writes are frozen while a schema migration or rollback is in progress. Reads are unaffected.",
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "600" },
    },
  );
}
