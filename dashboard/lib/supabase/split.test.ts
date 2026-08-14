import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The public-Auth / internal-data split.
 *
 * Two failure modes motivate this file, and neither is visible by reading the
 * app source, because the app source never names a cookie and never names a
 * gateway:
 *
 *  1. supabase-js derives its session storage key from the first DNS label of
 *     the URL it is given. Point the server clients at a different host and
 *     they silently start looking for a different cookie than the browser
 *     writes, so every signed-in user is redirected to /login.
 *
 *  2. Six tenants' Kong containers share the dokploy-network and all claim the
 *     alias `kong`. Sending server traffic to the short name round-robins
 *     across other tenants' gateways — with the service-role key attached.
 *
 * These tests pin both properties.
 */

const PUBLIC_URL = "https://ntapi.anikin.cz";
const INTERNAL_URL = "http://natetrader-supabase-kong:8000";

type ClientOpts = { cookieOptions?: { name?: string } } | undefined;

// Typed with an explicit rest parameter so `mock.calls[n][2]` is a legal index;
// a zero-arg `vi.fn(() => …)` infers a 0-tuple and the assertions below would
// not typecheck.
const browserFactory = vi.fn((...args: unknown[]) => ({ kind: "browser", args }));
const serverFactory = vi.fn((...args: unknown[]) => ({ kind: "server", args }));
const plainFactory = vi.fn((...args: unknown[]) => ({ kind: "service", args }));

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => browserFactory(...args),
  createServerClient: (...args: unknown[]) => serverFactory(...args),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => plainFactory(...args),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: () => {} }),
}));

beforeEach(() => {
  vi.resetModules();
  browserFactory.mockClear();
  serverFactory.mockClear();
  plainFactory.mockClear();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PUBLIC_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
  vi.stubEnv("SUPABASE_SERVER_URL", INTERNAL_URL);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME", "");
});

describe("auth cookie name", () => {
  it("derives the name the browser already uses, from the PUBLIC host", async () => {
    const { getAuthCookieName } = await import("./config");
    expect(getAuthCookieName()).toBe("sb-ntapi-auth-token");
  });

  it("never derives the name from the internal host", async () => {
    const { getAuthCookieName } = await import("./config");
    expect(getAuthCookieName()).not.toContain("natetrader-supabase-kong");
    expect(getAuthCookieName()).not.toContain("kong");
  });

  it("honours an explicit override", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME", "sb-legacy-auth-token");
    const { getAuthCookieName } = await import("./config");
    expect(getAuthCookieName()).toBe("sb-legacy-auth-token");
  });
});

describe("server URL", () => {
  it("returns the internal origin", async () => {
    const { getSupabaseServerUrl } = await import("./config");
    expect(getSupabaseServerUrl()).toBe(INTERNAL_URL);
  });

  it("fails closed when unset rather than falling back to the public origin", async () => {
    vi.stubEnv("SUPABASE_SERVER_URL", "");
    const { getSupabaseServerUrl } = await import("./config");
    expect(() => getSupabaseServerUrl()).toThrow(/SUPABASE_SERVER_URL/);
  });

  it("is never the ambiguous short alias shared by six tenants", async () => {
    const { getSupabaseServerUrl } = await import("./config");
    expect(new URL(getSupabaseServerUrl()).hostname).not.toBe("kong");
  });
});

describe("client construction", () => {
  it("browser client keeps the PUBLIC origin (edge allows Auth there)", async () => {
    const { getSupabaseBrowser } = await import("./client");
    getSupabaseBrowser();
    expect(browserFactory).toHaveBeenCalledOnce();
    expect(browserFactory.mock.calls[0][0]).toBe(PUBLIC_URL);
  });

  it("server client uses the INTERNAL origin", async () => {
    const { getSupabaseServer } = await import("./server");
    await getSupabaseServer();
    expect(serverFactory.mock.calls[0][0]).toBe(INTERNAL_URL);
  });

  it("service-role client uses the INTERNAL origin", async () => {
    const { getSupabaseService } = await import("./service");
    getSupabaseService();
    expect(plainFactory.mock.calls[0][0]).toBe(INTERNAL_URL);
  });

  it("service-role key is never sent to the public origin", async () => {
    const { getSupabaseService } = await import("./service");
    getSupabaseService();
    const [url, key] = plainFactory.mock.calls[0] as [string, string];
    expect(key).toBe("service-key");
    expect(url).not.toBe(PUBLIC_URL);
    expect(url.startsWith("http://")).toBe(true);
  });

  it("browser and server clients agree on ONE cookie name", async () => {
    const { getSupabaseBrowser } = await import("./client");
    const { getSupabaseServer } = await import("./server");
    getSupabaseBrowser();
    await getSupabaseServer();

    const browserOpts = browserFactory.mock.calls[0][2] as ClientOpts;
    const serverOpts = serverFactory.mock.calls[0][2] as ClientOpts;

    expect(browserOpts?.cookieOptions?.name).toBe("sb-ntapi-auth-token");
    expect(serverOpts?.cookieOptions?.name).toBe("sb-ntapi-auth-token");
    expect(serverOpts?.cookieOptions?.name).toBe(
      browserOpts?.cookieOptions?.name,
    );
  });

  it("both clients pin the name explicitly rather than leaving it derived", async () => {
    const { getSupabaseBrowser } = await import("./client");
    const { getSupabaseServer } = await import("./server");
    getSupabaseBrowser();
    await getSupabaseServer();
    for (const call of [
      browserFactory.mock.calls[0],
      serverFactory.mock.calls[0],
    ]) {
      expect((call[2] as ClientOpts)?.cookieOptions?.name).toBeTruthy();
    }
  });
});
