import { beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({
  browser: vi.fn((...args: unknown[]) => args),
  server: vi.fn((...args: unknown[]) => args),
  service: vi.fn((...args: unknown[]) => args),
}));
vi.mock("@supabase/ssr", () => ({
  createBrowserClient: (...args: unknown[]) => factories.browser(...args),
  createServerClient: (...args: unknown[]) => factories.server(...args),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => factories.service(...args),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://public.example.com");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME", "");
  vi.stubEnv("SUPABASE_SERVER_URL", "http://nate-supabase-kong:8000");
});

describe("public Auth and internal server data", () => {
  it("keeps browser traffic public and both server clients internal with the same cookie", async () => {
    const { getSupabaseBrowser } = await import("./client");
    const { getSupabaseServer } = await import("./server");
    const { getSupabaseService } = await import("./service");
    getSupabaseBrowser();
    await getSupabaseServer();
    getSupabaseService();
    expect(factories.browser.mock.calls[0][0]).toBe("https://public.example.com");
    expect(factories.server.mock.calls[0][0]).toBe("http://nate-supabase-kong:8000");
    expect(factories.service.mock.calls[0][0]).toBe("http://nate-supabase-kong:8000");
    for (const factory of [factories.browser, factories.server]) {
      expect(factory.mock.calls[0][2]).toMatchObject({
        cookieOptions: { name: "sb-public-auth-token" },
      });
    }
  });

  it("supports the existing explicitly pinned cookie", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME", "sb-legacy-auth-token");
    const { getAuthCookieName } = await import("./config");
    expect(getAuthCookieName()).toBe("sb-legacy-auth-token");
  });

  it.each(["", "http://kong:8000", "ftp://internal", "https://user:pass@internal", "https://internal/rest/v1"])(
    "rejects missing or unsafe server origin %s before constructing a service client", async (url) => {
      vi.stubEnv("SUPABASE_SERVER_URL", url);
      const { getSupabaseService } = await import("./service");
      expect(() => getSupabaseService()).toThrow();
      expect(factories.service).not.toHaveBeenCalled();
    },
  );
});
