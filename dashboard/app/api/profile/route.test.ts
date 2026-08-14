import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The profile boundary.
 *
 * Two properties matter more than the happy path, because both are what the
 * browser used to enforce for itself and no longer can:
 *
 *   1. The row is chosen by the verified session, not by the request. There is
 *      no `id` in the payload, so a caller has no way to name another row.
 *   2. `default_account_id` must be an account this user actually owns.
 *      Without that check the field is an arbitrary uuid write, and the value
 *      is read straight back out and displayed as the user's default.
 */

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const OWNED_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let currentUserId: string | null = OWNER_ID;
let frozen = false;

/** Rows the service client can see, keyed by table. */
const ACCOUNTS = [
  { id: OWNED_ACCOUNT, owner_id: OWNER_ID, deleted_at: null },
  { id: FOREIGN_ACCOUNT, owner_id: OTHER_ID, deleted_at: null },
];
const PROFILES: Record<string, { display_name: string | null; default_account_id: string | null }> =
  {
    [OWNER_ID]: { display_name: "Ada", default_account_id: null },
  };

/** Records every update the route attempts, so a blocked write is provable. */
const updates: Array<{ patch: Record<string, unknown>; id: string }> = [];

vi.mock("@/lib/maintenance", () => ({
  maintenanceBlock: () =>
    frozen ? new Response(JSON.stringify({ error: "frozen" }), { status: 503 }) : null,
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: currentUserId ? { id: currentUserId, email: "a@b.c" } : null },
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/service", () => {
  // A deliberately small PostgREST stand-in: enough to record filters and
  // return matching rows, so ownership filtering is observable.
  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      is: (col: string, val: unknown) => {
        filters[col] = val;
        return api;
      },
      maybeSingle: async () => {
        if (table === "accounts") {
          const row = ACCOUNTS.find(
            (a) =>
              a.id === filters.id &&
              (filters.owner_id === undefined || a.owner_id === filters.owner_id) &&
              a.deleted_at === null,
          );
          return { data: row ?? null, error: null };
        }
        const p = PROFILES[filters.id as string];
        return { data: p ?? null, error: null };
      },
      update: (patch: Record<string, unknown>) => {
        const u = {
          eq: async (col: string, val: unknown) => {
            if (col === "id") updates.push({ patch, id: String(val) });
            return { error: null };
          },
        };
        return u;
      },
    };
    return api;
  }
  return { getSupabaseService: () => ({ from: (t: string) => builder(t) }) };
});

const { GET, PATCH } = await import("./route");

function patchReq(body: unknown) {
  return new Request("http://localhost/api/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  currentUserId = OWNER_ID;
  frozen = false;
  updates.length = 0;
  PROFILES[OWNER_ID] = { display_name: "Ada", default_account_id: null };
});

describe("GET /api/profile", () => {
  it("returns only the readable fields for the signed-in user", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toEqual({ display_name: "Ada", default_account_id: null });
  });

  it("401s when there is no session", async () => {
    currentUserId = null;
    expect((await GET()).status).toBe(401);
  });
});

describe("PATCH /api/profile", () => {
  it("writes display_name to the session's own row", async () => {
    const res = await PATCH(patchReq({ display_name: "  Grace  " }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ patch: { display_name: "Grace" }, id: OWNER_ID }]);
  });

  it("accepts a default account the user owns", async () => {
    const res = await PATCH(patchReq({ default_account_id: OWNED_ACCOUNT }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ patch: { default_account_id: OWNED_ACCOUNT }, id: OWNER_ID }]);
  });

  it("refuses a default account owned by someone else, and writes nothing", async () => {
    const res = await PATCH(patchReq({ default_account_id: FOREIGN_ACCOUNT }));
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("gives the same answer for a foreign account and a missing one", async () => {
    const foreign = await PATCH(patchReq({ default_account_id: FOREIGN_ACCOUNT }));
    const missing = await PATCH(patchReq({ default_account_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }));
    expect(foreign.status).toBe(missing.status);
    expect(await foreign.json()).toEqual(await missing.json());
  });

  it("rejects a field that is not on the allowlist", async () => {
    const res = await PATCH(patchReq({ id: OTHER_ID }));
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("rejects an attempt to retarget the row via a smuggled id", async () => {
    const res = await PATCH(patchReq({ display_name: "x", id: OTHER_ID }));
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("rejects a non-uuid default account without querying", async () => {
    const res = await PATCH(patchReq({ default_account_id: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("rejects a wrong-typed display_name", async () => {
    expect((await PATCH(patchReq({ display_name: 42 }))).status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("rejects an empty patch", async () => {
    expect((await PATCH(patchReq({}))).status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const bad = new Request("http://localhost/api/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect((await PATCH(bad)).status).toBe(400);
  });

  it("401s when there is no session", async () => {
    currentUserId = null;
    expect((await PATCH(patchReq({ display_name: "x" }))).status).toBe(401);
    expect(updates).toEqual([]);
  });

  it("is blocked by the write freeze before it authenticates or writes", async () => {
    frozen = true;
    expect((await PATCH(patchReq({ display_name: "x" }))).status).toBe(503);
    expect(updates).toEqual([]);
  });

  it("clears the default account when given null", async () => {
    const res = await PATCH(patchReq({ default_account_id: null }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([{ patch: { default_account_id: null }, id: OWNER_ID }]);
  });
});
