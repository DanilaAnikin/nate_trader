import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The verify route re-checks stored credentials against Alpaca. It must store
 * the broker account number server-side (the production binding compares a
 * freshly read one against it) and return only a four-character mask.
 */

const CANARY_ACCOUNT_NUMBER = "PA-VERIFY-CANARY-8811";
const OWNER_ID = "11111111-1111-1111-1111-111111111111";

let currentUserId: string | null = OWNER_ID;
const updates: Record<string, unknown>[] = [];
/** Every RPC the route makes, so the audited command path can be asserted. */
const rpcCalls: { name: string; args: unknown }[] = [];

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
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      if (name === "get_account_credentials") {
        return { data: [{ api_key: "k", api_secret: "s" }], error: null };
      }
      return { data: null, error: null };
    },
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

function request() {
  return POST(new Request("http://localhost/api/accounts/acc-1/verify", {
    method: "POST",
  }), { params: Promise.resolve({ id: "acc-1" }) });
}

beforeEach(() => {
  currentUserId = OWNER_ID;
  updates.length = 0;
  rpcCalls.length = 0;
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

describe("POST /api/accounts/[id]/verify", () => {
  it("returns only a masked broker account number", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body).toEqual({
      ok: true,
      status: "connected",
      brokerAccountMask: "••••8811",
    });
    expect(body).not.toHaveProperty("accountNumber");
  });

  it("never puts the full account number in the JSON body", async () => {
    const serialized = await (await request()).text();
    expect(serialized).not.toContain(CANARY_ACCOUNT_NUMBER);
    expect(serialized).not.toContain("PA-VERIFY-CANARY");
  });

  it("still stores the full number server-side for the production binding", async () => {
    await request();
    // The binding is written by the atomic, audited RPC — not by a bare
    // `.update()`, which recorded a status change with no record of who made
    // it and was reachable from two GET handlers.
    const recorded = rpcCalls.find(
      (call) => call.name === "record_account_verification",
    );
    expect(recorded).toBeDefined();
    expect(
      (recorded?.args as Record<string, unknown>).p_account_number,
    ).toBe(CANARY_ACCOUNT_NUMBER);
    expect((recorded?.args as Record<string, unknown>).p_status).toBe(
      "connected",
    );
    expect(updates).toHaveLength(0);
  });

  it("is no-store so a mask is never cached by a proxy", async () => {
    const response = await request();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses an unauthenticated caller", async () => {
    currentUserId = null;
    const response = await request();
    expect(response.status).toBe(401);
  });
});
