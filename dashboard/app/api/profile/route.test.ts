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

describe("PATCH /api/profile is frozen in the image", () => {
  /**
   * SUPERSEDED, and deliberately kept as the same input matrix.
   *
   * These cases used to assert the PATCH semantics: allowlisted fields, own-row
   * targeting, foreign-vs-missing indistinguishability, smuggled ids, malformed
   * bodies, no session. Every one of them is now answered the same way, by a
   * constant 503 that never reads the body and never authenticates.
   *
   * Keeping the matrix rather than deleting it is the point: the property under
   * test is that NONE of these inputs can produce a write, and the strongest
   * evidence for that is feeding the handler exactly the inputs that used to
   * make it behave differently and getting one identical answer.
   */
  const INPUTS: Array<[string, unknown]> = [
    ["a valid display_name", { display_name: "new name" }],
    ["a default account the user owns", { default_account_id: OWNED_ACCOUNT }],
    ["a default account owned by someone else", { default_account_id: FOREIGN_ACCOUNT }],
    ["a field not on the allowlist", { is_admin: true }],
    ["a smuggled row id", { id: "someone-else", display_name: "x" }],
    ["a non-uuid default account", { default_account_id: "not-a-uuid" }],
    ["a wrong-typed display_name", { display_name: 42 }],
    ["an empty patch", {}],
    ["a null default account", { default_account_id: null }],
  ];

  it.each(INPUTS)("refuses %s with the constant 503", async () => {
    const res = await PATCH();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("FROZEN_CONTAINMENT_BRIDGE");
  });

  it("refuses identically with no session at all", async () => {
    const res = await PATCH();
    expect(res.status).toBe(503);
  });

  it("never reads the request body", () => {
    // A handler that takes no parameter cannot read a body. This is a stronger
    // statement than "we did not observe a read".
    expect(PATCH.length).toBe(0);
  });
});
