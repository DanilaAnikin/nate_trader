import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

const state = vi.hoisted(() => ({
  user: { id: "owner" } as { id: string } | null,
  calls: [] as unknown[][],
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, options: {
    cookies: { setAll: (cookies: { name: string; value: string; options: { path: string } }[]) => void };
  }) => {
    state.calls.push([url, key, options]);
    return { auth: { getUser: async () => {
      options.cookies.setAll([{ name: "sb-public-auth-token", value: "refreshed", options: { path: "/" } }]);
      return { data: { user: state.user } };
    } } };
  },
}));
const { proxy, config } = await import("@/proxy");

beforeEach(() => {
  state.calls.length = 0;
  state.user = { id: "owner" };
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://public.example.com");
  vi.stubEnv("SUPABASE_SERVER_URL", "http://nate-supabase-kong:8000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_COOKIE_NAME", "");
});

describe("proxy containment transport", () => {
  it.each(["/api/accounts/a.png", "/api/accounts/a.svg", "/api/profile", "/api"])(
    "authenticates %s according to Next's matcher", (path) => {
      expect(unstable_doesMiddlewareMatch({ config, url: `https://dashboard.example.com${path}` })).toBe(true);
    },
  );
  it("keeps static assets outside the proxy", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "https://dashboard.example.com/logo.png" })).toBe(false);
  });
  it.each([
    ["/login", true, 307], ["/portfolio", false, 307], ["/api/accounts", false, 401],
  ] as const)("preserves refreshed cookies on %s", async (path, loggedIn, expected) => {
    state.user = loggedIn ? { id: "owner" } : null;
    const response = await proxy(new NextRequest(`https://dashboard.example.com${path}`));
    expect(response.status).toBe(expected);
    expect(response.cookies.get("sb-public-auth-token")?.value).toBe("refreshed");
    expect(state.calls[0][0]).toBe("http://nate-supabase-kong:8000");
    expect(state.calls[0][2]).toMatchObject({ cookieOptions: { name: "sb-public-auth-token" } });
  });
  it("fails closed without internal configuration", async () => {
    vi.stubEnv("SUPABASE_SERVER_URL", "");
    const response = await proxy(new NextRequest("https://dashboard.example.com/api/accounts"));
    expect(response.status).toBe(503);
    expect(state.calls).toHaveLength(0);
  });
});
