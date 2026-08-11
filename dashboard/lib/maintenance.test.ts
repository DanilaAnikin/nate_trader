import { afterEach, describe, expect, it, vi } from "vitest";
import { backfillFrozen, maintenanceBlock, maintenanceModeEnabled } from "./maintenance";
import { isLoopback } from "./isolated-smoke";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The bridge's write freeze.
 *
 * The point of this commit over the tagged `fc73acaae` is that the freeze
 * exists in the code at all, and that it covers the two **GET** handlers whose
 * side effect is the largest write in the application. An environment variable
 * set on `fc73acaae` would do neither.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("maintenanceModeEnabled", () => {
  it.each(["on", "1", "true", "YES", "On"])("is on for %s", (value) => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", value);
    expect(maintenanceModeEnabled()).toBe(true);
  });

  it.each(["", "off", "false", "0", "maybe"])("is off for %s", (value) => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", value);
    expect(maintenanceModeEnabled()).toBe(false);
  });

  it("is off when the variable is absent", () => {
    expect(maintenanceModeEnabled()).toBe(false);
  });
});

describe("maintenanceBlock", () => {
  it("returns null when no freeze is in force", () => {
    expect(maintenanceBlock()).toBeNull();
    expect(backfillFrozen()).toBeNull();
  });

  it("returns a 503 with a retry hint under a freeze", async () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    const response = maintenanceBlock();
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    expect(response!.headers.get("Retry-After")).toBe("600");
    expect((await response!.json()).code).toBe("MAINTENANCE_MODE");
  });

  it("names the reason a read's backfill was skipped", () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    expect(backfillFrozen()).toContain("MAINTENANCE_MODE");
    expect(backfillFrozen()).toContain("unchanged");
  });
});

/**
 * A source-level guard, because the property is "no handler is missed" and
 * that cannot be observed from any one response.
 */
describe("every write path is behind the freeze", () => {
  const API = join(__dirname, "..", "app", "api");
  const read = (rel: string) =>
    readFileSync(join(API, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it.each([
    ["accounts/route.ts", "POST /api/accounts"],
    ["accounts/[id]/route.ts", "PATCH and DELETE /api/accounts/[id]"],
    ["accounts/[id]/verify/route.ts", "POST /api/accounts/[id]/verify"],
  ])("%s calls maintenanceBlock()", (file, label) => {
    const source = read(file);
    const handlers =
      source.match(/export async function (POST|PATCH|PUT|DELETE)\b/g) ?? [];
    const guards = source.match(/maintenanceBlock\(/g) ?? [];
    expect(handlers.length, `${label} declares no mutating handler`).toBeGreaterThan(0);
    expect(guards.length).toBeGreaterThanOrEqual(handlers.length);
  });

  it.each([
    "accounts/[id]/equity/route.ts",
    "accounts/[id]/performance/route.ts",
    "accounts/[id]/status/route.ts",
    "accounts/[id]/live/route.ts",
  ])("%s runs no backfill at all, frozen or not", (file) => {
    // Freezing the backfill was the previous fix, and it closed the window
    // that mattered most while leaving the write in place the rest of the
    // time. A read does not write; there is nothing left here to freeze.
    // `app/api/route-surface.test.ts` enforces this across every route.
    const source = read(file);
    expect(source).not.toContain("backfillEquity");
    expect(source).not.toContain("backfillCashFlows");
    expect(source).not.toMatch(/\.update\s*\(/);
  });
});


describe("the isolated smoke-test sidecar", () => {
  it("lets nobody through the freeze by default", () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    expect(maintenanceBlock("some-user")).not.toBeNull();
  });

  it("still refuses a named user when the image is not a sidecar", () => {
    // Both halves are required. An allowlist on a publicly reachable image
    // would be a way to write to production during a migration.
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    vi.stubEnv("DASHBOARD_FREEZE_BYPASS_USERS", "operator-1");
    expect(maintenanceBlock("operator-1")).not.toBeNull();
  });

  it("lets exactly the allowlisted operator write on a sidecar", () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    vi.stubEnv("DASHBOARD_SIDECAR_ONLY", "on");
    vi.stubEnv("DASHBOARD_FREEZE_BYPASS_USERS", "operator-1, operator-2");
    expect(maintenanceBlock("operator-1")).toBeNull();
    expect(maintenanceBlock("operator-2")).toBeNull();
    expect(maintenanceBlock("someone-else")).not.toBeNull();
    expect(maintenanceBlock(null)).not.toBeNull();
    expect(maintenanceBlock(undefined)).not.toBeNull();
  });

  it("treats an empty allowlist as nobody", () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    vi.stubEnv("DASHBOARD_SIDECAR_ONLY", "on");
    vi.stubEnv("DASHBOARD_FREEZE_BYPASS_USERS", "  ");
    expect(maintenanceBlock("operator-1")).not.toBeNull();
  });

  it.each([
    ["localhost:3000", null, null, true],
    ["127.0.0.1:3000", null, null, true],
    ["[::1]:3000", null, null, true],
    ["dashboard.example.com", null, null, false],
    // A request that came through a proxy is not loopback, whatever it says.
    ["localhost:3000", "203.0.113.7", null, false],
    ["localhost:3000", null, "dashboard.example.com", false],
  ])(
    "treats host=%s xff=%s xfh=%s as loopback: %s",
    (host, xff, xfh, expected) => {
      const headers = new Map<string, string>([["host", String(host)]]);
      if (xff) headers.set("x-forwarded-for", String(xff));
      if (xfh) headers.set("x-forwarded-host", String(xfh));
      expect(
        isLoopback({
          headers: { get: (n: string) => headers.get(n) ?? null },
          url: "http://x/",
        }),
      ).toBe(expected);
    },
  );
});
