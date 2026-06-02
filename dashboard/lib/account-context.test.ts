import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory below can close over it safely.
const { getSupabaseServerMock } = vi.hoisted(() => ({
  getSupabaseServerMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("./supabase/server", () => ({
  getSupabaseServer: getSupabaseServerMock,
}));

import { getUserAccounts, getSelectedAccount } from "./account-context";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A Supabase client whose every query rejects with `fetch failed` — exactly
 * what happens when the free-tier project auto-pauses. Before the resilience
 * fix this bubbled up and 504'd the whole dashboard.
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
  it("getUserAccounts returns [] instead of throwing", async () => {
    getSupabaseServerMock.mockResolvedValue(unreachableClient());
    await expect(getUserAccounts()).resolves.toEqual([]);
  });

  it("getSelectedAccount returns an empty selection instead of throwing", async () => {
    getSupabaseServerMock.mockResolvedValue(unreachableClient());
    await expect(getSelectedAccount()).resolves.toEqual({
      accounts: [],
      selected: null,
    });
  });
});
