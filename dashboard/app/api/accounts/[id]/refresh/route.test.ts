import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The only path that writes the broker mirrors.
 *
 * Two properties are asserted here that a GET handler could never offer: the
 * write freeze stops it before it touches anything, and every refusal reports
 * `mirrorMutated: false` rather than an opaque 500.
 */

const OWNER_ID = "11111111-1111-1111-1111-111111111111";

let currentUserId: string | null = OWNER_ID;
let refreshOutcome: Record<string, unknown> = {
  ok: true,
  generation: "7",
  equityWritten: 12,
  equityRemoved: 0,
  flowsWritten: 3,
  flowsRemoved: 0,
  latestActivityAt: null,
};
let refreshCalls = 0;

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: currentUserId ? { id: currentUserId } : null },
      }),
    },
  }),
}));

vi.mock("@/lib/accounts/session", () => ({
  getSessionUser: async () => (currentUserId ? { id: currentUserId } : null),
  loadOwnedAccount: async () => ({
    id: "acc-1",
    owner_id: OWNER_ID,
    mode: "paper" as const,
    nickname: "Production",
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({}),
}));

vi.mock("@/lib/accounts/broker-refresh", () => ({
  refreshBrokerDatasets: async () => {
    refreshCalls += 1;
    return refreshOutcome;
  },
}));

const { POST } = await import("./route");

async function request() {
  const response = await POST(
    new Request("http://localhost/api/accounts/acc-1/refresh", {
      method: "POST",
    }),
    { params: Promise.resolve({ id: "acc-1" }) },
  );
  return { response, body: await response.json() };
}

beforeEach(() => {
  currentUserId = OWNER_ID;
  refreshCalls = 0;
  vi.unstubAllEnvs();
  refreshOutcome = {
    ok: true,
    generation: "7",
    equityWritten: 12,
    equityRemoved: 0,
    flowsWritten: 3,
    flowsRemoved: 0,
    latestActivityAt: null,
  };
});

describe("POST /api/accounts/[id]/refresh", () => {
  it("publishes and reports what it wrote", async () => {
    const { response, body } = await request();
    expect(response.status).toBe(200);
    expect(body.equityWritten).toBe(12);
    expect(body.flowsWritten).toBe(3);
    // A refresh has no code path that removes a row.
    expect(body.equityRemoved).toBe(0);
    expect(body.flowsRemoved).toBe(0);
  });

  it("refuses an unauthenticated caller", async () => {
    currentUserId = null;
    const { response } = await request();
    expect(response.status).toBe(401);
    expect(refreshCalls).toBe(0);
  });

  it.each([
    ["RECONCILIATION_CONFLICT", 409],
    ["CREDENTIALS_ROTATED", 502],
    ["STALE_GENERATION", 502],
    ["BROKER_UNREACHABLE", 502],
    ["NON_CASH_EXTERNAL_TRANSFER", 502],
  ])("reports %s as a named outcome with the mirror intact", async (reason, status) => {
    refreshOutcome = {
      ok: false,
      reason,
      detail: "refused and rolled back; the stored mirror is unchanged",
      mirrorMutated: false,
      reservationTaken: true,
    };
    const { response, body } = await request();
    expect(response.status).toBe(status);
    expect(body.code).toBe(reason);
    expect(body.mirrorMutated).toBe(false);
    // Reserving a token *is* a database write, and the response says so
    // rather than claiming the whole operation touched nothing.
    expect(body.reservationTaken).toBe(true);
  });
});

describe("the deployment write freeze", () => {
  it.each(["on", "1", "true", "YES"])(
    "blocks the refresh with 503 when the freeze is %s",
    async (value) => {
      vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", value);
      const { response, body } = await request();
      expect(response.status).toBe(503);
      expect(body.code).toBe("MAINTENANCE_MODE");
      expect(response.headers.get("Retry-After")).toBe("600");
      // Blocked before the broker or the database is touched at all.
      expect(refreshCalls).toBe(0);
    },
  );

  it.each(["", "off", "false", "0", "maybe"])(
    "does not block when the flag is %s",
    async (value) => {
      vi.stubEnv("DASHBOARD_MAINTENANCE_MODE", value);
      const { response } = await request();
      expect(response.status).toBe(200);
      expect(refreshCalls).toBe(1);
    },
  );
});
