/**
 * The proxy's two jobs during a migration window, and the one it must not do.
 *
 * It used to refuse every request whose `Host` header did not look like
 * loopback, on the theory that this kept a smoke-test sidecar unreachable. It
 * did not. `Host` is chosen by the caller: anything that could reach the port
 * could send `Host: localhost`, so the check turned away honest remote clients
 * and admitted the single attacker it was written for.
 *
 * And it refused frozen writes *before* authentication, which meant the
 * operator freeze bypass — the whole mechanism the mutation smoke tests
 * depend on — could never be reached, whoever was asking.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) {
  return new NextRequest(new URL(path, "https://dashboard.example.com"), {
    method: init.method ?? "GET",
    headers: init.headers,
  });
}

/**
 * Load the proxy *after* the environment is stubbed.
 *
 * Some of these flags were read at module load, so importing first and
 * stubbing afterwards would silently test the default configuration.
 */
async function loadProxy() {
  vi.resetModules();
  const mod = await import("./proxy");
  return mod.proxy;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a forged Host header grants nothing", () => {
  /** Everything about the response that a caller could observe. */
  async function outcome(host: string) {
    vi.stubEnv("DASHBOARD_SIDECAR_ONLY", "on");
    const proxy = await loadProxy();
    const response = await proxy(
      request("/api/accounts", { method: "POST", headers: { host } }),
    );
    const body = await response.clone().json().catch(() => ({}));
    return { status: response.status, code: body.code ?? null };
  }

  it.each(["localhost", "localhost:3000", "127.0.0.1", "[::1]:3000"])(
    "treats Host: %s exactly like any other host",
    async (host) => {
      // This is the whole finding. The old gate admitted these four and
      // refused everything else with 403 SIDECAR_ONLY — so the control was a
      // string the caller chose. Anything that could reach the port could
      // send it, which is precisely the caller the gate existed to stop,
      // while an honest remote operator was turned away.
      expect(await outcome(host)).toEqual(await outcome("dashboard.example.com"));
    },
  );

  it("never answers with a host-based sidecar refusal", async () => {
    for (const host of ["localhost", "dashboard.example.com", "10.0.0.5"]) {
      expect((await outcome(host)).code).not.toBe("SIDECAR_ONLY");
    }
  });

  it("serves the health endpoint whatever the Host says", async () => {
    vi.stubEnv("DASHBOARD_SIDECAR_ONLY", "on");
    const proxy = await loadProxy();
    for (const host of ["localhost", "dashboard.example.com"]) {
      const response = await proxy(request("/api/health", { headers: { host } }));
      expect(response.status).toBe(200);
    }
  });
});

describe("the freeze at the edge", () => {
  it("refuses a mutating API request while frozen", async () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    const proxy = await loadProxy();
    const response = await proxy(request("/api/accounts", { method: "POST" }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("MAINTENANCE_MODE");
  });

  it("keeps serving reads while frozen", async () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    const proxy = await loadProxy();
    const response = await proxy(request("/api/accounts"));
    expect(response.status).not.toBe(503);
  });

  it("stands aside when an operator bypass could apply", async () => {
    // The proxy has no authenticated user at this point, so it must not answer
    // for the handler. `maintenanceBlock(userId)` decides, and it still
    // refuses everyone who is not on the list.
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    vi.stubEnv("DASHBOARD_SIDECAR_ONLY", "on");
    vi.stubEnv("DASHBOARD_FREEZE_BYPASS_USERS", "operator-1");
    const proxy = await loadProxy();
    const response = await proxy(request("/api/accounts", { method: "POST" }));
    expect(response.status).not.toBe(503);
  });

  it.each([
    ["the allowlist is empty", { DASHBOARD_SIDECAR_ONLY: "on", DASHBOARD_FREEZE_BYPASS_USERS: "  " }],
    ["the allowlist is absent", { DASHBOARD_SIDECAR_ONLY: "on" }],
    ["the image is not a sidecar", { DASHBOARD_FREEZE_BYPASS_USERS: "operator-1" }],
  ])("still refuses at the edge when %s", async (_label, env) => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const proxy = await loadProxy();
    const response = await proxy(request("/api/accounts", { method: "POST" }));
    expect(response.status).toBe(503);
  });
});
