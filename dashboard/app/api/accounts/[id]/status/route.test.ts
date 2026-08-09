import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGithubCache } from "@/lib/status/github-api";
import {
  APPROVED_SHA,
  DASHBOARD_SHA,
  lastRunJson,
  performanceJson,
  positionsJson,
  preflightJson,
  REPO_SHA,
  tournamentJson,
  validationJson,
} from "@/test/fixtures";
import { buildZip } from "@/test/zip-builder";

/**
 * Route-level cross-tenant regression.
 *
 * User A is the configured production owner; user B is an ordinary tenant with
 * their own paper account. B must receive no plan, no pending actions, no
 * preflight, no executor record and no production operations — and the private
 * GitHub Actions API must not be called on their behalf at all.
 */

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const PROD_ACCOUNT_ID = "acc-prod";
const TENANT_ACCOUNT_ID = "acc-tenant";

const SECRET_BROKER_NUMBER = "PA-SECRET-ACCT-7788";
const PLAN_ID = "f8756105eb63dde2";

let currentUserId: string | null = OWNER_ID;

const ACCOUNTS: Record<
  string,
  { id: string; nickname: string; mode: "paper" | "live"; owner_id: string }
> = {
  [PROD_ACCOUNT_ID]: {
    id: PROD_ACCOUNT_ID,
    nickname: "Paper production",
    mode: "paper",
    owner_id: OWNER_ID,
  },
  [TENANT_ACCOUNT_ID]: {
    id: TENANT_ACCOUNT_ID,
    nickname: "Tenant paper",
    mode: "paper",
    owner_id: TENANT_ID,
  },
};

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServer: async () => ({
    auth: {
      getUser: async () => ({
        data: { user: currentUserId ? { id: currentUserId } : null },
      }),
    },
    from: () => {
      const builder = {
        _id: "",
        select() {
          return builder;
        },
        eq(_column: string, value: string) {
          builder._id = value;
          return builder;
        },
        is() {
          return builder;
        },
        async single() {
          const row = ACCOUNTS[builder._id];
          // Mirror RLS: a row belonging to another user is simply not visible.
          if (!row || row.owner_id !== currentUserId) {
            return { data: null, error: { message: "not found" } };
          }
          return { data: row, error: null };
        },
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  }),
}));

vi.mock("@/lib/status/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/status/broker")>();
  return {
    ...actual,
    loadCredentials: async () => ({ apiKey: "k", apiSecret: "s" }),
    fetchBrokerSnapshot: async () => ({
      ok: true as const,
      fetchedAt: "2026-08-07T17:00:00.000Z",
      accountNumber: SECRET_BROKER_NUMBER,
      snapshot: {
        equity: 1_000_000,
        cash: 600_000,
        cashPct: 60,
        dailyPnl: 0,
        dailyPnlPct: 0,
        grossExposure: 400_000,
        grossExposurePct: 40,
        positionCount: 0,
        positions: [],
        shortSymbols: [],
      },
    }),
  };
});

const { GET } = await import("./route");

function runtimeZip(): Buffer {
  return buildZip([
    { name: "performance.json", content: JSON.stringify(performanceJson()) },
    { name: "positions.json", content: JSON.stringify(positionsJson()) },
    {
      name: "production/last_run.json",
      content: JSON.stringify(lastRunJson()),
    },
  ]);
}

function diagnosticsZip(): Buffer {
  return buildZip([
    {
      name: "production-preflight.json",
      content: JSON.stringify(preflightJson()),
    },
  ]);
}

function stubGithub() {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const zip = (body: Buffer) =>
    new Response(new Uint8Array(body), {
      headers: { "content-length": String(body.byteLength) },
    });

  const handler = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/environments/paper-production/variables/")) {
      return json({ value: APPROVED_SHA });
    }
    if (url.includes("/commits/main")) {
      return json({ sha: REPO_SHA, commit: { committer: { date: null } } });
    }
    if (url.includes("/workflows/paper-production.yml/runs")) {
      return json({
        workflow_runs: [
          {
            id: 900,
            run_number: 43,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
            event: "schedule",
            head_sha: REPO_SHA,
            created_at: "2026-08-07T16:06:00Z",
            updated_at: "2026-08-07T16:06:00Z",
            html_url: "https://github.com/x/y/actions/runs/900",
          },
        ],
      });
    }
    if (url.includes("/workflows/v11-release.yml/runs")) {
      return json({
        workflow_runs: [
          {
            id: 700,
            run_number: 12,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
            event: "push",
            head_sha: APPROVED_SHA,
            updated_at: "2026-08-02T15:58:00Z",
            html_url: "https://github.com/x/y/actions/runs/700",
          },
        ],
      });
    }
    if (url.includes("/actions/runs/900/jobs")) {
      return json({ jobs: [{ steps: [{ name: "checkout" }] }] });
    }
    if (url.includes("/actions/runs/900/artifacts")) {
      return json({
        artifacts: [
          {
            id: 1,
            name: `paper-runtime-state-${APPROVED_SHA}`,
            size_in_bytes: 4271,
            expired: false,
            created_at: "2026-08-07T16:06:00Z",
          },
          {
            id: 2,
            name: "paper-diagnostics",
            size_in_bytes: 1584,
            expired: false,
            created_at: "2026-08-07T16:06:00Z",
          },
        ],
      });
    }
    if (url.includes("/actions/artifacts/1/zip")) return zip(runtimeZip());
    if (url.includes("/actions/artifacts/2/zip")) return zip(diagnosticsZip());
    if (url.includes("/contents/state/backtest/v11_validation.json")) {
      return new Response(JSON.stringify(validationJson()));
    }
    if (url.includes("/contents/state/backtest/strategy_tournament_epoch_1.json")) {
      return new Response(JSON.stringify(tournamentJson()));
    }
    return json({ message: "not found" }, 404);
  });
  vi.stubGlobal("fetch", handler);
  return handler;
}

function request(id: string) {
  return GET(new Request(`http://localhost/api/accounts/${id}/status`), {
    params: Promise.resolve({ id }),
  });
}

function privateApiCalls(handler: ReturnType<typeof stubGithub>): string[] {
  return handler.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("/actions/") || url.includes("/environments/"));
}

beforeEach(() => {
  clearGithubCache();
  currentUserId = OWNER_ID;
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  vi.stubEnv("BUILD_SHA", DASHBOARD_SHA);
  vi.stubEnv("PRODUCTION_OWNER_USER_ID", OWNER_ID);
  vi.stubEnv("PRODUCTION_ACCOUNT_ID", PROD_ACCOUNT_ID);
  vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", "");
});

describe("GET /api/accounts/[id]/status", () => {
  it("refuses an unauthenticated caller", async () => {
    currentUserId = null;
    stubGithub();
    const response = await request(PROD_ACCOUNT_ID);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("gives the production owner the full runtime", async () => {
    currentUserId = OWNER_ID;
    const handler = stubGithub();
    const response = await request(PROD_ACCOUNT_ID);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.authorization.data.productionRuntimeAuthorized).toBe(true);
    expect(body.strategy.data.plan.planId).toBe(PLAN_ID);
    expect(body.preflight.data).not.toBeNull();
    expect(body.execution.data).not.toBeNull();
    expect(body.operations.data).not.toBeNull();
    expect(privateApiCalls(handler).length).toBeGreaterThan(0);
  });

  it("gives a second tenant none of the production runtime", async () => {
    currentUserId = TENANT_ID;
    const handler = stubGithub();
    const response = await request(TENANT_ACCOUNT_ID);
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.authorization.data.productionRuntimeAuthorized).toBe(false);
    expect(body.authorization.data.denialReason).toBe("NOT_PRODUCTION_OWNER");
    expect(body.strategy.data).toBeNull();
    expect(body.preflight.data).toBeNull();
    expect(body.execution.data).toBeNull();
    expect(body.operations.data).toBeNull();
    expect(body.convergence.data).toBeNull();
    expect(body.universe.data).toBeNull();
    expect(body.release.data.approvedPaperReleaseSha).toBeNull();
    expect(body.validationGate.effective).toBe("NOT_APPLICABLE");

    // No private GitHub Actions traffic happens for a non-production viewer.
    expect(privateApiCalls(handler)).toEqual([]);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(PLAN_ID);
    expect(serialized).not.toContain(APPROVED_SHA);
    expect(serialized).not.toContain("ADAPTIVE_TRIM");
    expect(serialized).not.toContain(SECRET_BROKER_NUMBER);
  });

  it("hides another tenant's account entirely", async () => {
    currentUserId = TENANT_ID;
    const handler = stubGithub();
    const response = await request(PROD_ACCOUNT_ID);
    expect(response.status).toBe(404);
    expect(privateApiCalls(handler)).toEqual([]);
  });

  it("withholds the runtime from the owner on a non-production account", async () => {
    currentUserId = OWNER_ID;
    vi.stubEnv("PRODUCTION_ACCOUNT_ID", "acc-somewhere-else");
    const handler = stubGithub();
    const response = await request(PROD_ACCOUNT_ID);
    const body = await response.json();
    expect(body.authorization.data.denialReason).toBe("NOT_PRODUCTION_ACCOUNT");
    expect(body.strategy.data).toBeNull();
    expect(privateApiCalls(handler)).toEqual([]);
  });

  it("never returns the full broker account number to any viewer", async () => {
    currentUserId = OWNER_ID;
    stubGithub();
    const body = await (await request(PROD_ACCOUNT_ID)).json();
    expect(JSON.stringify(body)).not.toContain(SECRET_BROKER_NUMBER);
    expect(body.accountBinding.data.brokerAccountMask).toBe("••••7788");
  });
});
