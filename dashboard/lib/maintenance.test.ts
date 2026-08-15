import { afterEach, describe, expect, it, vi } from "vitest";
import * as smokeModule from "./isolated-smoke";
import { backfillFrozen, maintenanceBlock, maintenanceModeEnabled } from "./maintenance";
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

  // SUPERSEDED, and deliberately strengthened rather than deleted.
  //
  // This used to assert "every mutating handler calls maintenanceBlock()".
  // That was correct for a flag-gated freeze, and it is satisfied by a handler
  // that consults the flag and then writes. The bridge no longer has a flag to
  // consult: each mutating handler is a constant refusal, so the guard count is
  // now zero and the old assertion would fail on code that is strictly safer.
  //
  // The replacement asserts the stronger property directly. It would also have
  // caught the original bug, which is the bar a superseding test has to clear.
  it.each([
    ["accounts/route.ts", "POST /api/accounts"],
    ["accounts/[id]/route.ts", "PATCH and DELETE /api/accounts/[id]"],
    ["accounts/[id]/verify/route.ts", "POST /api/accounts/[id]/verify"],
    ["profile/route.ts", "PATCH /api/profile"],
  ])("%s refuses every mutation unconditionally", (file, label) => {
    const source = read(file);
    const handlers =
      source.match(/export async function (POST|PATCH|PUT|DELETE)\b/g) ?? [];
    expect(handlers.length, `${label} declares no mutating handler`).toBeGreaterThan(0);
    const refusals = source.match(/return frozenResponse\(\);/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(handlers.length);
    // and no branch remains that could reach a write
    expect(source).not.toMatch(/maintenanceBlock\(/);
    expect(source).not.toMatch(/from ["']@\/lib\/accounts\/service["']/);
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

  it("does not decide isolation from a request header", () => {
    // There is no `isLoopback` any more, and there must not be one. It read
    // the `Host` header, which the caller chooses: anything that could reach
    // the port could send `Host: localhost`, so it refused honest remote
    // clients and admitted the single attacker it was written for. Isolation
    // is a deployment fact — a port bound to 127.0.0.1, a firewall, a tunnel —
    // and no header can stand in for it.
    const smoke = smokeModule as Record<string, unknown>;
    expect(smoke.isLoopback).toBeUndefined();
  });

  it("keeps the bypass keyed on the authenticated user, not on a header", () => {
    // The one control this module still asserts. A forged header cannot reach
    // it: the user id comes from a Supabase session the server verified.
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    vi.stubEnv("DASHBOARD_SIDECAR_ONLY", "on");
    vi.stubEnv("DASHBOARD_FREEZE_BYPASS_USERS", "operator-1");
    expect(maintenanceBlock("operator-1")).toBeNull();
    expect(maintenanceBlock("Operator-1")).not.toBeNull();
    expect(maintenanceBlock(" operator-1 ")).not.toBeNull();
  });
});
