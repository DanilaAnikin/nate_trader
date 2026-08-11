import "server-only";
import { NextResponse } from "next/server";

/**
 * The deployment write freeze, enforced in the application.
 *
 * Section 13 of OVERVIEW.md requires a freeze while the schema migrations are
 * applied, and the previous plan was to announce one. That is not a control:
 * the bridge image's lifecycle operations keep succeeding non-atomically after
 * the migrations, so nothing stops a stray browser tab, a retried request or a
 * second operator from starting one mid-migration.
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
 *   * **`POST .../refresh`** — a broker refresh writes `equity_snapshots`,
 *     `cash_flows`, `broker_refresh_state` and `broker_refresh_token`. A
 *     freeze that let those through would be a freeze on the small tables
 *     while the financial mirrors kept moving.
 *
 * Reads are unaffected: they no longer write anything (see the status, live,
 * equity and performance handlers), so serving them during a freeze is safe
 * and keeps the dashboard legible while the work happens.
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
