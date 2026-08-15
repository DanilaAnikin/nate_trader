import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The verify route re-checks stored credentials against Alpaca. It must store
 * the broker account number server-side (the production binding compares a
 * freshly read one against it) and return only a four-character mask.
 */

const CANARY_ACCOUNT_NUMBER = "PA-VERIFY-CANARY-8811";
const OWNER_ID = "11111111-1111-1111-1111-111111111111";

let currentUserId: string | null = OWNER_ID;
const updates: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: currentUserId ? { id: currentUserId } : null },
      }),
    },
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        single: async () => ({
          data: { id: "acc-1", mode: "paper" as const },
          error: null,
        }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    rpc: async () => ({
      data: [{ api_key: "k", api_secret: "s" }],
      error: null,
    }),
    from: () => ({
      // Since migration 0011 the account row is read with the service role and
      // the ownership check happens in code, so the service mock must answer
      // the select too.
      select: () => {
        const builder = {
          eq: () => builder,
          is: () => builder,
          maybeSingle: async () => ({
            data: {
              id: "acc-1",
              owner_id: OWNER_ID,
              mode: "paper" as const,
              nickname: "Production",
              deleted_at: null,
            },
            error: null,
          }),
        };
        return builder;
      },
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: async () => ({ error: null }) };
      },
    }),
  }),
}));

const { POST } = await import("./route");

// The old `request()` helper is gone with the handler that accepted a
// request: POST now takes no parameters, which is the point.

beforeEach(() => {
  currentUserId = OWNER_ID;
  updates.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            account_number: CANARY_ACCOUNT_NUMBER,
            status: "ACTIVE",
          }),
          { status: 200 },
        ),
    ),
  );
});

describe("POST /api/accounts/[id]/verify is frozen in the image", () => {
  /**
   * SUPERSEDED. Verification read Vault secrets through get_account_credentials,
   * contacted Alpaca and then persisted a status — a write in every sense that
   * matters here. The frozen bridge does none of it, so the masking and
   * authentication assertions no longer have a code path to exercise.
   *
   * What replaces them is the property that makes those assertions unnecessary:
   * the handler refuses unconditionally, cannot read a body, and imports no
   * credential or broker code at all.
   */
  it("refuses with the constant 503", async () => {
    const res = await POST();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("FROZEN_CONTAINMENT_BRIDGE");
    expect(body.writes_enabled).toBe(false);
  });

  it("refuses identically for an unauthenticated caller", async () => {
    const res = await POST();
    expect(res.status).toBe(503);
  });

  it("cannot read a request body or a route parameter", () => {
    expect(POST.length).toBe(0);
  });

  it("no longer imports any credential or broker code", () => {
    const src = readFileSync(
      join(__dirname, "route.ts"),
      "utf8",
    )
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n");
    expect(src).not.toMatch(/from ["'][^"']*credentials["']/);
    expect(src).not.toMatch(/from ["']@\/lib\/supabase\/service["']/);
  });
});
