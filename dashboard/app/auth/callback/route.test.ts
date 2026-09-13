import { beforeEach, describe, expect, it, vi } from "vitest";

const { exchangeCodeForSession } = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({ auth: { exchangeCodeForSession } }),
}));

import { GET } from "./route";

beforeEach(() => {
  exchangeCodeForSession.mockReset();
  exchangeCodeForSession.mockResolvedValue({ error: null });
});

describe("authentication callback return path", () => {
  async function callback(next?: string, code: string | null = "auth-code") {
    const url = new URL("https://nate.example/auth/callback");
    if (code) url.searchParams.set("code", code);
    if (next !== undefined) url.searchParams.set("next", next);
    return GET(new Request(url));
  }

  it.each([
    "@attacker.example",
    "https://attacker.example",
    "//attacker.example",
    "/\\attacker.example",
    "javascript:alert(1)",
    "positions",
    "",
  ])("keeps an unsafe destination on the dashboard: %s", async (next) => {
    const response = await callback(next);
    expect(response.headers.get("location")).toBe("https://nate.example/");
    expect(exchangeCodeForSession).toHaveBeenCalledWith("auth-code");
  });

  it("preserves a local path, query and fragment", async () => {
    const response = await callback("/positions?view=target#holdings");
    expect(response.headers.get("location")).toBe(
      "https://nate.example/positions?view=target#holdings",
    );
  });

  it("defaults to the overview", async () => {
    expect((await callback()).headers.get("location")).toBe("https://nate.example/");
  });

  it("returns to sign-in when the exchange fails", async () => {
    exchangeCodeForSession.mockResolvedValue({ error: { message: "invalid code" } });
    expect((await callback("/positions")).headers.get("location")).toBe(
      "https://nate.example/login?error=auth",
    );
  });

  it("does not exchange a missing code", async () => {
    expect((await callback("/positions", null)).headers.get("location")).toBe(
      "https://nate.example/login?error=auth",
    );
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
});
