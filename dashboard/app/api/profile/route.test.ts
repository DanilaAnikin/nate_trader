import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OWNED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELETED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const state = vi.hoisted(() => ({
  user: "" as string | null,
  tables: {} as Record<string, Record<string, unknown>[]>,
  updates: [] as { table: string; id: unknown; patch: Record<string, unknown> }[],
  calls: [] as string[],
  error: false,
}));
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServer: async () => {
  state.calls.push("auth");
  return { auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null } }) } };
} }));
vi.mock("@/lib/supabase/service", () => ({ getSupabaseService: () => ({
  from: (table: string) => {
    state.calls.push(table);
    const filters: Record<string, unknown> = {};
    let patch: Record<string, unknown> | null = null;
    const query = {
      select: () => query,
      eq: (name: string, value: unknown) => { filters[name] = value; return query; },
      is: (name: string, value: unknown) => { filters[name] = value; return query; },
      update: (values: Record<string, unknown>) => { patch = values; return query; },
      maybeSingle: async () => {
        if (state.error) return { data: null, error: { message: "private-db-canary" } };
        const row = state.tables[table]?.find((candidate) =>
          Object.entries(filters).every(([key, value]) => candidate[key] === value));
        if (patch && row) { state.updates.push({ table, id: row.id, patch }); Object.assign(row, patch); }
        return { data: row ?? null, error: null };
      },
    };
    return query;
  },
}) }));
const { GET, PATCH } = await import("./route");
const request = (body: unknown) => new Request("https://dashboard.example.com/api/profile", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  state.user = OWNER; state.error = false; state.updates.length = 0; state.calls.length = 0;
  vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "off");
  state.tables = {
    profiles: [{ id: OWNER, display_name: "Ada", default_account_id: null, private: "do-not-publish" }],
    accounts: [
      { id: OWNED, owner_id: OWNER, deleted_at: null },
      { id: FOREIGN, owner_id: "someone-else", deleted_at: null },
      { id: DELETED, owner_id: OWNER, deleted_at: "2026-01-01" },
    ],
  };
});

describe("same-origin profile boundary", () => {
  it("only returns the verified user's safe profile fields and never writes", async () => {
    const response = await GET();
    expect(await response.json()).toEqual({ profile: { display_name: "Ada", default_account_id: null } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(state.updates).toHaveLength(0);
  });
  it("denies anonymous reads and writes before looking up data", async () => {
    state.user = null;
    expect((await GET()).status).toBe(401);
    expect((await PATCH(request({ display_name: "new" }))).status).toBe(401);
    expect(state.calls).toEqual(["auth", "auth"]);
  });
  it("freezes profile changes before authentication or body reads", async () => {
    vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", "on");
    const req = request({ display_name: "new" });
    const read = vi.spyOn(req, "json");
    expect((await PATCH(req)).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });
  it("updates only own profile preferences, never the account", async () => {
    const response = await PATCH(request({ display_name: " Grace ", default_account_id: OWNED }));
    expect(response.status).toBe(200);
    expect(state.updates).toEqual([{ table: "profiles", id: OWNER, patch: {
      display_name: "Grace", default_account_id: OWNED,
    } }]);
  });
  it.each([FOREIGN, DELETED, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"])(
    "refuses unavailable default account %s identically", async (id) => {
      const response = await PATCH(request({ default_account_id: id }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid default account." });
      expect(state.updates).toHaveLength(0);
    },
  );
  it.each([null, [], {}, { id: FOREIGN }, { is_admin: true }, { display_name: 7 },
    { display_name: "x".repeat(201) }, { default_account_id: "bad" }])(
    "rejects invalid updates %j", async (body) => {
      expect((await PATCH(request(body))).status).toBe(400);
      expect(state.updates).toHaveLength(0);
    },
  );
  it("does not claim success when the own profile row does not exist", async () => {
    state.tables.profiles = [];
    expect((await PATCH(request({ display_name: "new" }))).status).toBe(503);
    expect(state.updates).toHaveLength(0);
  });
  it("withholds database diagnostics on read and write failure", async () => {
    state.error = true;
    for (const response of [await GET(), await PATCH(request({ display_name: "new" }))]) {
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-db-canary");
    }
  });
});
