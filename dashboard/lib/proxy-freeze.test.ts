import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The write freeze must hold at the proxy, before authentication.
 *
 * Each handler already calls `maintenanceBlock()`, but a handler only runs
 * after the proxy has validated the session — and validating the session
 * means a network call to Supabase Auth. During a schema migration, which is
 * precisely when the freeze exists, that call can fail or hang, and the
 * request then lands on the proxy's fail-closed 503 ("Authentication service
 * temporarily unavailable") instead of the freeze. Same status code, wrong
 * reason, and the freeze is no longer the thing enforcing it.
 *
 * `authCalls` counts how often the proxy tried to reach Auth, so "refused
 * before authentication" is asserted rather than assumed.
 */

let authCalls = 0;

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        authCalls += 1;
        return { data: { user: { id: "u1" } } };
      },
    },
  }),
}));

const { proxy } = await import("../proxy");

function req(method: string, path: string) {
  return new NextRequest(new URL(`http://localhost${path}`), { method });
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  authCalls = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://ntapi.anikin.cz";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVER_URL = "http://natetrader-supabase-kong:8000";
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("proxy write freeze", () => {
  it("503s a mutating API request without contacting Auth", async () => {
    process.env.DASHBOARD_MAINTENANCE_MODE = "on";
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await proxy(req(method, "/api/accounts"));
      expect(res.status, method).toBe(503);
      expect(await res.clone().json()).toMatchObject({ reason: "FROZEN_CONTAINMENT_BRIDGE" });
    }
    expect(authCalls).toBe(0);
  });

  it("still serves reads during a freeze", async () => {
    process.env.DASHBOARD_MAINTENANCE_MODE = "on";
    const res = await proxy(req("GET", "/api/accounts"));
    expect(res.status).not.toBe(503);
    expect(authCalls).toBeGreaterThan(0);
  });

  it("does not freeze mutating requests to non-API paths", async () => {
    process.env.DASHBOARD_MAINTENANCE_MODE = "on";
    const res = await proxy(req("POST", "/login"));
    expect(res.status).not.toBe(503);
  });

  // INVERTED. There is no longer a state in which a mutating API request is
  // let through: the refusal is unconditional in the artifact. This case used
  // to prove the freeze was a flag; it now proves it is not.
  it("refuses a mutating API request even with no freeze flag in force", async () => {
    delete process.env.DASHBOARD_MAINTENANCE_MODE;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await proxy(req(method, "/api/accounts"));
      expect(res.status, method).toBe(503);
      expect(await res.clone().json()).toMatchObject({ reason: "FROZEN_CONTAINMENT_BRIDGE" });
    }
    expect(authCalls, "the refusal must not contact Auth").toBe(0);
  });

  it("keeps /api/health reachable during a freeze", async () => {
    process.env.DASHBOARD_MAINTENANCE_MODE = "on";
    const res = await proxy(req("GET", "/api/health"));
    expect(res.status).toBe(200);
    expect(authCalls).toBe(0);
  });
});
