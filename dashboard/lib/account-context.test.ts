import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory below can close over it safely.
const { getSupabaseServerMock, getSupabaseServiceMock } = vi.hoisted(() => ({
  getSupabaseServerMock: vi.fn(),
  getSupabaseServiceMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("./supabase/server", () => ({
  getSupabaseServer: getSupabaseServerMock,
}));
vi.mock("./supabase/service", () => ({
  getSupabaseService: getSupabaseServiceMock,
}));

import { getUserAccounts, getSelectedAccount } from "./account-context";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A Supabase client whose every query rejects with `fetch failed` — exactly
 * what happens when the free-tier project auto-pauses. The layout catches it
 * and renders an unavailable state rather than an empty account selection.
 */
function unreachableClient() {
  const chain = {
    select: () => chain,
    is: () => chain,
    eq: () => chain,
    order: () => Promise.reject(new TypeError("fetch failed")),
    single: () => Promise.reject(new TypeError("fetch failed")),
  } as const;
  return {
    from: () => chain,
    auth: { getUser: () => Promise.reject(new TypeError("fetch failed")) },
  };
}

describe("account-context resilience to a paused Supabase", () => {
  it("getUserAccounts preserves a backend failure for the layout", async () => {
    getSupabaseServerMock.mockResolvedValue(unreachableClient());
    await expect(getUserAccounts()).rejects.toThrow("fetch failed");
  });

  it("getSelectedAccount cannot mislabel an outage as no selected account", async () => {
    getSupabaseServerMock.mockResolvedValue(unreachableClient());
    await expect(getSelectedAccount()).rejects.toThrow("fetch failed");
  });

  it.each([
    { data: null, error: { message: "private database details" } },
    { data: null, error: null },
  ])("distinguishes a failed account query from an empty book", async (result) => {
    getSupabaseServerMock.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    });
    const chain = { select: () => chain, eq: () => chain, is: () => chain,
      order: async () => result };
    getSupabaseServiceMock.mockReturnValue({ from: () => chain });
    await expect(getSelectedAccount()).rejects.toThrow("Account list is temporarily unavailable.");
  });

  it("keeps an empty selection when the account query really succeeds empty", async () => {
    getSupabaseServerMock.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    });
    const chain = { select: () => chain, eq: () => chain, is: () => chain,
      order: async () => ({ data: [], error: null }) };
    getSupabaseServiceMock.mockReturnValue({ from: () => chain });
    await expect(getSelectedAccount()).resolves.toEqual({ accounts: [], selected: null });
  });
});
