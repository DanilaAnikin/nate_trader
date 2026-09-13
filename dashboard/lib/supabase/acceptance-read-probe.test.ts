import { describe, expect, it, vi } from "vitest";
import { runReadProbes } from "../../test/acceptance/read-probe.mjs";

const COOKIE = "sb-session=PRIVATE-SESSION-CANARY";
const ACCOUNT = "synthetic-owned-account";
const sections = ["web", "release", "authorization", "accountBinding", "broker", "strategy", "universe", "validation", "preflight", "execution", "operations", "tournament", "convergence"];

function requests(leak = false, accountIds = [ACCOUNT]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const authenticated = new Headers(init?.headers).get("Cookie") === COOKIE;
    if (path === "/api/health") return Response.json({ status: "ok" });
    if (path === "/login") return new Response("Login");
    if (!authenticated) return path.startsWith("/api/")
      ? Response.json({ error: "unauthenticated" }, { status: 401 })
      : new Response(null, { status: 307, headers: { Location: "/login" } });
    if (path === "/api/profile") return Response.json({ profile: { display_name: "Synthetic" } });
    if (path === "/api/accounts") return Response.json({ accounts: accountIds.map((id) => ({ id, mode: "live" })) });
    const accountId = path.split("/").at(-2);
    if (path.endsWith("/status")) return Response.json({
      accountId, accountMode: "live",
      ...Object.fromEntries(sections.map((name) => [name, { data: {}, provenance: { freshness: "CURRENT" } }])),
      ...(leak ? { extra: { api_key: "PRIVATE-KEY-CANARY" } } : {}),
    });
    if (path.startsWith("/api/accounts/")) return Response.json({ accountId });
    return new Response("Authenticated dashboard");
  });
}

describe("GET-only release acceptance probe", () => {
  it("tests authenticated and unauthenticated paths without sending writes or printing sensitive context", async () => {
    const request = requests();
    const emit = vi.fn();
    expect(await runReadProbes({ origin: "https://dashboard.example.test", cookie: COOKIE, requireAccounts: true, requireBrokerReady: true }, request, emit)).toBe(true);
    expect(request.mock.calls.every(([, init]) => init?.method === "GET" && init.redirect === "manual")).toBe(true);
    expect(emit.mock.calls.length).toBeGreaterThan(20);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(COOKIE);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(ACCOUNT);
  });

  it("fails a credential leak while keeping the leaked value out of its own output", async () => {
    const emit = vi.fn();
    expect(await runReadProbes({ origin: "http://127.0.0.1:3000", cookie: COOKIE, forbiddenValues: ["PRIVATE-KEY-CANARY"] }, requests(true), emit)).toBe(false);
    expect(emit.mock.calls.some(([row]) => row.check === "owned_account_1_status" && row.result === "FAIL")).toBe(true);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE-KEY-CANARY");
  });

  it("refuses a credential-bearing origin before any request", async () => {
    const request = requests();
    await expect(runReadProbes({ origin: "https://user:pass@dashboard.example.test" }, request, vi.fn())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("always reads the configured account even when it is fourth in the owner's list", async () => {
    const request = requests(false, ["other-a", "other-b", "other-c", ACCOUNT]);
    const emit = vi.fn();
    expect(await runReadProbes({ origin: "https://dashboard.example.test", cookie: COOKIE, expectedAccountId: ACCOUNT }, request, emit)).toBe(true);
    for (const endpoint of ["status", "live", "equity", "performance"]) {
      expect(request.mock.calls.some(([url]) => String(url).endsWith(`/api/accounts/${ACCOUNT}/${endpoint}`))).toBe(true);
    }
    expect(emit).toHaveBeenCalledWith({ check: "configured_account_present", result: "PASS" });
    expect(JSON.stringify(emit.mock.calls)).not.toContain(ACCOUNT);
  });

  it("fails if other owned accounts load but the configured account is absent", async () => {
    const request = requests(false, ["other-a"]);
    const emit = vi.fn();
    expect(await runReadProbes({ origin: "https://dashboard.example.test", cookie: COOKIE, expectedAccountId: ACCOUNT }, request, emit)).toBe(false);
    expect(emit).toHaveBeenCalledWith({ check: "configured_account_present", result: "FAIL" });
    expect(request.mock.calls.some(([url]) => String(url).includes(`/api/accounts/${ACCOUNT}/`))).toBe(false);
  });
});
