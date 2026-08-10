import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGithubCache } from "@/lib/status/github-api";
import { APPROVED_SHA, OTHER_SHA } from "@/test/fixtures";
import { fakeTable } from "@/test/supabase-fake";

/**
 * Forward performance is the one place a wrong number would be published as
 * alpha, so the route is tested as a whole: authorization, baseline anchoring,
 * cash-flow completeness, database failures and staleness.
 */

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";
const ACCOUNT_ID = "acc-prod";
const BROKER_NUMBER = "PA-PERF-CANARY-3344";
const START_SESSION = "2026-08-03";

let currentUserId: string | null = OWNER_ID;
let accountOwner = OWNER_ID;

/* ------------------------------------------------------------- test doubles */

let equityRows: { snapshot_date: string; equity: number }[] = [];
let flowRows: { flow_date: string; amount: number }[] = [];
let equityError: { message: string } | null = null;
let flowError: { message: string } | null = null;
/** Every `.range()` the route asked for, so paging can be asserted. */
let equityRanges: [number, number][] = [];
let flowRanges: [number, number][] = [];

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
          data: {
            id: ACCOUNT_ID,
            mode: "paper" as const,
            owner_id: accountOwner,
          },
          error: null,
        }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  getSupabaseService: () => ({
    rpc: async () => ({ data: [{ api_key: "k", api_secret: "s" }], error: null }),
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        order: async () => ({ data: equityRows, error: equityError }),
        then: undefined,
      };
      if (table === "accounts") {
        // Since 0011 the account row is read with the service role and the
        // ownership check happens in `loadOwnedAccount`.
        const account = {
          select: () => account,
          eq: () => account,
          is: () => account,
          maybeSingle: async () => ({
            data: {
              id: ACCOUNT_ID,
              mode: "paper" as const,
              nickname: "Paper production",
              owner_id: accountOwner,
              deleted_at: null,
            },
            error: null,
          }),
        };
        return account;
      }
      if (table === "cash_flows") {
        return fakeTable({
          rows: flowRows,
          error: flowError,
          ranges: flowRanges,
        });
      }
      if (table === "equity_snapshots") {
        return fakeTable({
          rows: equityRows,
          error: equityError,
          ranges: equityRanges,
        });
      }
      return builder;
    },
  }),
}));

let equityBackfillError: Error | null = null;
let cashFlowResult: {
  complete: boolean;
  incompleteReason: string | null;
  detail: string | null;
  latestActivityAt: string | null;
} = {
  complete: true,
  incompleteReason: null,
  detail: null,
  latestActivityAt: "2026-08-05T20:00:00.000Z",
};
let cashFlowError: Error | null = null;

vi.mock("@/lib/accounts/equity-backfill", () => ({
  backfillEquity: async () => {
    if (equityBackfillError) throw equityBackfillError;
    return equityRows.length;
  },
  backfillCashFlows: async () => {
    if (cashFlowError) throw cashFlowError;
    return { written: 0, pagesRead: 1, refreshedAt: "", ...cashFlowResult };
  },
}));

let benchmarkBars: { date: string; close: number }[] | null = null;

vi.mock("@/lib/status/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/status/broker")>();
  return {
    ...actual,
    loadCredentials: async () => ({ apiKey: "k", apiSecret: "s" }),
    fetchBrokerSnapshot: async () => ({
      ok: true as const,
      fetchedAt: "2026-08-07T17:00:00.000Z",
      accountNumber: BROKER_NUMBER,
      snapshot: {
        equity: 1_000_000,
        cash: 0,
        cashPct: 0,
        dailyPnl: 0,
        dailyPnlPct: 0,
        grossExposure: 0,
        grossExposurePct: 0,
        positionCount: 0,
        positions: [],
        shortSymbols: [],
      },
    }),
    fetchBenchmarkBars: async () => benchmarkBars,
  };
});

let baselineDocument: Record<string, unknown> | null = null;

vi.mock("@/lib/status/read-model", () => ({
  getApprovedReleaseSha: async () => ({
    sha: APPROVED_SHA,
    source: "github-environment-variable" as const,
    detail: null,
    authoritative: true,
  }),
  getEpochBaseline: async () => {
    const { parseEpochBaseline } = await import("@/lib/status/performance");
    return baselineDocument ? parseEpochBaseline(baselineDocument) : null;
  },
}));

const { GET } = await import("./route");

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    strategyVersion: "v11-adaptive-momentum",
    releaseSha: APPROVED_SHA,
    accountId: ACCOUNT_ID,
    startedAt: "2026-08-03T13:30:00.000Z",
    startSessionDate: START_SESSION,
    startingEquity: 1_000_000,
    benchmarkSymbol: "SPY",
    benchmarkBaselineDate: START_SESSION,
    benchmarkBaselineClose: 700,
    note: null,
    ...overrides,
  };
}

async function request() {
  const response = await GET(
    new Request(`http://localhost/api/accounts/${ACCOUNT_ID}/performance`),
    { params: Promise.resolve({ id: ACCOUNT_ID }) },
  );
  return { response, body: await response.json() };
}

beforeEach(() => {
  clearGithubCache();
  currentUserId = OWNER_ID;
  accountOwner = OWNER_ID;
  equityError = null;
  flowError = null;
  equityRanges = [];
  flowRanges = [];
  equityBackfillError = null;
  cashFlowError = null;
  cashFlowResult = {
    complete: true,
    incompleteReason: null,
    detail: null,
    latestActivityAt: "2026-08-05T20:00:00.000Z",
  };
  baselineDocument = baseline();
  equityRows = [
    { snapshot_date: "2026-08-03", equity: 1_000_000 },
    { snapshot_date: "2026-08-04", equity: 1_010_000 },
    { snapshot_date: "2026-08-05", equity: 1_020_000 },
  ];
  flowRows = [];
  benchmarkBars = [
    { date: "2026-08-03", close: 700 },
    { date: "2026-08-04", close: 707 },
    { date: "2026-08-05", close: 714 },
  ];
  vi.stubEnv("PRODUCTION_OWNER_USER_ID", OWNER_ID);
  vi.stubEnv("PRODUCTION_ACCOUNT_ID", ACCOUNT_ID);
  vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", BROKER_NUMBER);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-06T12:00:00Z"));
});

describe("GET /api/accounts/[id]/performance", () => {
  it("reports a cash-flow-adjusted return for the production account", async () => {
    const { body } = await request();
    expect(body.status).toBe("CURRENT");
    expect(body.performance.startDate).toBe(START_SESSION);
    expect(body.performance.endDate).toBe("2026-08-05");
    expect(body.performance.portfolioTwrPct).toBeCloseTo(2, 4);
    expect(body.provenance.freshness).toBe("CURRENT");
    expect(body.provenance.asOf).toBe("2026-08-05");
  });

  it("excludes a deposit from the return", async () => {
    equityRows = [
      { snapshot_date: "2026-08-03", equity: 1_000_000 },
      { snapshot_date: "2026-08-04", equity: 1_510_000 },
      { snapshot_date: "2026-08-05", equity: 1_510_000 },
    ];
    flowRows = [{ flow_date: "2026-08-04", amount: 500_000 }];
    const { body } = await request();
    expect(body.status).toBe("CURRENT");
    expect(body.performance.portfolioTwrPct).toBeCloseTo(1, 4);
    expect(body.performance.netCashFlow).toBe(500_000);
  });

  it("excludes a withdrawal from the return", async () => {
    equityRows = [
      { snapshot_date: "2026-08-03", equity: 1_000_000 },
      { snapshot_date: "2026-08-04", equity: 910_000 },
      { snapshot_date: "2026-08-05", equity: 910_000 },
    ];
    flowRows = [{ flow_date: "2026-08-04", amount: -100_000 }];
    const { body } = await request();
    expect(body.performance.portfolioTwrPct).toBeCloseTo(1, 4);
  });

  it("refuses a viewer who is not the production owner", async () => {
    currentUserId = OTHER_USER_ID;
    accountOwner = OTHER_USER_ID;
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("NOT_PRODUCTION_VIEWER");
    expect(body.provenance.freshness).toBe("NOT_APPLICABLE");
  });

  it("refuses a baseline bound to a different release", async () => {
    baselineDocument = baseline({ releaseSha: OTHER_SHA });
    const { body } = await request();
    expect(body.reason).toBe("BASELINE_RELEASE_MISMATCH");
  });

  it("refuses a baseline with no explicit strategy version or benchmark", async () => {
    for (const broken of [
      { strategyVersion: undefined },
      { benchmarkSymbol: undefined },
      { benchmarkSymbol: "QQQ" },
      { strategyVersion: "v10-legacy" },
    ]) {
      baselineDocument = baseline(broken);
      const { body } = await request();
      // The parser rejects it outright, so no baseline exists at all.
      expect(body.reason, JSON.stringify(broken)).toBe("NO_BASELINE");
    }
  });

  it("refuses a baseline whose two anchors describe different sessions", async () => {
    baselineDocument = baseline({ benchmarkBaselineDate: "2026-08-04" });
    const { body } = await request();
    expect(body.reason).toBe("NO_BASELINE");
  });

  it("refuses a future-dated baseline", async () => {
    baselineDocument = baseline({
      startedAt: "2027-01-04T14:30:00.000Z",
      startSessionDate: "2027-01-04",
      benchmarkBaselineDate: "2027-01-04",
    });
    const { body } = await request();
    expect(body.reason).toBe("NO_BASELINE");
  });

  it("refuses when the baseline session has no equity observation", async () => {
    equityRows = equityRows.slice(1);
    const { body } = await request();
    expect(body.reason).toBe("BASELINE_OBSERVATION_MISSING");
  });

  it("refuses when the recorded starting equity disagrees", async () => {
    equityRows[0] = { snapshot_date: START_SESSION, equity: 999_000 };
    const { body } = await request();
    expect(body.reason).toBe("BASELINE_OBSERVATION_MISMATCH");
  });

  it("refuses when the recorded benchmark close disagrees", async () => {
    benchmarkBars![0] = { date: START_SESSION, close: 690 };
    const { body } = await request();
    expect(body.reason).toBe("BASELINE_OBSERVATION_MISMATCH");
  });

  it("refuses an equity refresh failure instead of reporting a number", async () => {
    equityBackfillError = new Error("Alpaca portfolio history HTTP 503");
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("EQUITY_REFRESH_FAILED");
  });

  it("refuses a cash-flow outage instead of reporting a number", async () => {
    cashFlowError = new Error("Alpaca activities HTTP 503");
    const { body } = await request();
    expect(body.reason).toBe("CASH_FLOW_REFRESH_FAILED");
  });

  it("refuses an incomplete cash-flow walk", async () => {
    cashFlowResult = {
      complete: false,
      incompleteReason: "NO_PAGINATION_TOKEN",
      detail: "A full page of activities produced no usable pagination id.",
      latestActivityAt: null,
    };
    const { body } = await request();
    expect(body.reason).toBe("CASH_FLOW_INCOMPLETE");
    expect(body.detail).toContain("pagination id");
  });

  it("refuses a database error on the equity query", async () => {
    equityError = { message: "connection reset" };
    const { body } = await request();
    expect(body.reason).toBe("EQUITY_QUERY_FAILED");
  });

  it("refuses a database error on the cash-flow query", async () => {
    flowError = { message: "connection reset" };
    const { body } = await request();
    expect(body.reason).toBe("CASH_FLOW_QUERY_FAILED");
  });

  it("refuses a future-dated broker activity", async () => {
    cashFlowResult = {
      complete: true,
      incompleteReason: null,
      detail: null,
      latestActivityAt: "2027-01-04T20:00:00.000Z",
    };
    const { body } = await request();
    expect(body.reason).toBe("FUTURE_DATED");
    expect(body.provenance.freshness).toBe("MISMATCH");
  });

  it("marks an old last-shared session STALE at the root, not CURRENT", async () => {
    vi.setSystemTime(new Date("2026-08-14T12:00:00Z"));
    const { body } = await request();
    // The root status must not disagree with the provenance: a caller reading
    // only `status` would otherwise publish a nine-day-old number as current.
    expect(body.status).toBe("STALE");
    expect(body.provenance.freshness).toBe("STALE");
    expect(body.detail).toMatch(/not be read as today's performance/);
  });

  it("marks a very old last-shared session EXPIRED at the root too", async () => {
    vi.setSystemTime(new Date("2026-09-20T12:00:00Z"));
    const { body } = await request();
    expect(body.status).toBe("EXPIRED");
    expect(body.provenance.freshness).toBe("EXPIRED");
    // The numbers are still returned, but never labelled current.
    expect(body.performance).not.toBeNull();
  });

  it("does not call a session dated after today's market date CURRENT", async () => {
    // 2026-08-06T01:00Z is still 2026-08-05 in New York, so a session dated
    // 2026-08-06 is in the future. The old ±1 day slack called this CURRENT.
    vi.setSystemTime(new Date("2026-08-06T01:00:00Z"));
    equityRows = [
      { snapshot_date: "2026-08-03", equity: 1_000_000 },
      { snapshot_date: "2026-08-06", equity: 1_020_000 },
    ];
    benchmarkBars = [
      { date: "2026-08-03", close: 700 },
      { date: "2026-08-06", close: 714 },
    ];
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("FUTURE_DATED");
    expect(body.provenance.freshness).toBe("MISMATCH");
  });

  it("still accepts today's own session under the clock-skew tolerance", async () => {
    // 16:00Z is midday in New York on the same date, the ordinary case.
    vi.setSystemTime(new Date("2026-08-05T16:00:00Z"));
    const { body } = await request();
    expect(body.status).toBe("CURRENT");
    expect(body.performance.endDate).toBe("2026-08-05");
  });

  it("never leaks the broker account number", async () => {
    const { body } = await request();
    expect(JSON.stringify(body)).not.toContain(BROKER_NUMBER);
    expect(JSON.stringify(body)).not.toContain("PA-PERF-CANARY");
  });

  it("refuses an external securities transfer instead of reporting alpha", async () => {
    cashFlowResult = {
      complete: false,
      incompleteReason: "NON_CASH_EXTERNAL_TRANSFER",
      detail:
        "An external securities transfer (ACATS, 2026-08-04) settled in this account after the V11 epoch baseline.",
      latestActivityAt: "2026-08-04T20:00:00.000Z",
    };
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("NON_CASH_EXTERNAL_TRANSFER");
    expect(body.performance).toBeNull();
    expect(body.detail).toContain("ACATS");
  });
});

/* ---------------------------------------------------------------------------
 * Supabase caps a response at 1000 rows *without* an error. An unpaged read
 * therefore returns a shorter — and wrong — history that still looks valid.
 * ------------------------------------------------------------------------- */

describe("history is read completely, not to the first Supabase page", () => {
  function tradingDays(count: number, from: string): string[] {
    const dates: string[] = [];
    const cursor = new Date(`${from}T00:00:00Z`);
    while (dates.length < count) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  }

  it("pages past 1000 equity rows and keeps the oldest and newest", async () => {
    const dates = tradingDays(1_250, START_SESSION);
    const end = dates[dates.length - 1];
    equityRows = dates.map((date, index) => ({
      snapshot_date: date,
      // A steady climb, so a truncated read would give a visibly wrong TWR.
      equity: 1_000_000 + index * 1_000,
    }));
    benchmarkBars = dates.map((date, index) => ({
      date,
      close: 700 + index * 0.7,
    }));
    vi.setSystemTime(new Date(`${end}T20:00:00Z`));

    const { body } = await request();

    // Two ranges: 0–999 came back exactly full, so a second was required.
    expect(equityRanges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(body.performance.sessions).toBe(1_250);
    expect(body.performance.startDate).toBe(START_SESSION);
    expect(body.performance.endDate).toBe(end);
    // 1_000_000 → 2_249_000 is +124.9%. Truncating at the first 1000 rows
    // would report +99.9% — plausible, and wrong by 25 points.
    expect(body.performance.portfolioTwrPct).toBeCloseTo(124.9, 4);
  });

  it("pages past 1000 cash-flow rows so no deposit is dropped", async () => {
    const dates = tradingDays(1_100, START_SESSION);
    const end = dates[dates.length - 1];
    equityRows = dates.map((date) => ({
      snapshot_date: date,
      equity: 1_000_000,
    }));
    benchmarkBars = dates.map((date) => ({ date, close: 700 }));
    // One $1 deposit per session: the last 100 live on the second page.
    flowRows = dates.map((date) => ({ flow_date: date, amount: 1 }));
    vi.setSystemTime(new Date(`${end}T20:00:00Z`));

    const { body } = await request();

    expect(flowRanges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    // The flow dated on the baseline session itself is at the window's edge,
    // not inside it, so 1_099 of the 1_100 count — 99 of them from page two.
    expect(body.performance.cashFlowCount).toBe(1_099);
    expect(body.performance.netCashFlow).toBeCloseTo(1_099, 6);
  });
});
