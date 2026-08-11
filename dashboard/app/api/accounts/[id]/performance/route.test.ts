import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGithubCache } from "@/lib/status/github-api";
import { APPROVED_SHA, OTHER_SHA } from "@/test/fixtures";

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
/** Set to make the snapshot RPC fail, exactly as PostgREST would report it. */
let snapshotError: { message: string; code?: string } | null = null;
/** Every snapshot request the route made, so its arguments can be asserted. */
let snapshotCalls: Record<string, unknown>[] = [];
/** Make the snapshot claim more rows than it carries. */
let inflateSnapshotCounts = false;
/** Make the snapshot arrive without its audit token. */
let dropSnapshotToken = false;

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
    // The route reads both datasets through one snapshot RPC, so the double
    // answers that rather than emulating two paged table walks.
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "get_account_credentials") {
        return { data: [{ api_key: "k", api_secret: "s" }], error: null };
      }
      if (name === "account_history_snapshot") {
        snapshotCalls.push(args);
        if (snapshotError) return { data: null, error: snapshotError };
        const from = (args.p_from as string | null) ?? null;
        const equity = equityRows
          .filter((row) => from === null || row.snapshot_date >= from)
          .map((row) => ({
            date: row.snapshot_date,
            equity: row.equity,
            cash: 0,
            profit_loss: null,
            profit_loss_pct: null,
            num_positions: null,
          }));
        const flows = flowRows
          .filter((row) => from === null || row.flow_date >= from)
          .map((row, index) => ({
            id: String(index + 1),
            date: row.flow_date,
            amount: row.amount,
            kind: row.amount >= 0 ? "deposit" : "withdrawal",
            source: "alpaca_activities",
          }));
        return {
          data: {
            schema_version: 1,
            account_id: args.p_account,
            from_date: from,
            snapshot: dropSnapshotToken ? "" : "10:10:",
            captured_at: new Date().toISOString(),
            equity_count: equity.length + (inflateSnapshotCounts ? 1 : 0),
            cash_flow_count: flows.length,
            equity,
            cash_flows: flows,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
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
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      if (table === "accounts") return account;
      return account;
    },
  }),
}));

/**
 * Both mirrors are refreshed by one call that publishes them together, so the
 * double describes that single outcome rather than two independent backfills.
 */
let refreshResult: {
  ok: boolean;
  reason?: string;
  detail?: string;
  latestActivityAt?: string | null;
} = { ok: true, latestActivityAt: "2026-08-05T20:00:00.000Z" };

vi.mock("@/lib/accounts/broker-refresh", () => ({
  refreshBrokerDatasets: async () =>
    refreshResult.ok
      ? {
          ok: true,
          generation: "1",
          equityWritten: equityRows.length,
          equityRemoved: 0,
          flowsWritten: flowRows.length,
          flowsRemoved: 0,
          latestActivityAt: refreshResult.latestActivityAt ?? null,
        }
      : {
          ok: false,
          reason: refreshResult.reason,
          detail: refreshResult.detail ?? "refresh refused",
          mutated: false,
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
  snapshotError = null;
  snapshotCalls = [];
  inflateSnapshotCounts = false;
  dropSnapshotToken = false;
  refreshResult = { ok: true, latestActivityAt: "2026-08-05T20:00:00.000Z" };
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

  it("refuses rather than approximating a deposit inside the window", async () => {
    equityRows = [
      { snapshot_date: "2026-08-03", equity: 1_000_000 },
      { snapshot_date: "2026-08-04", equity: 1_510_000 },
      { snapshot_date: "2026-08-05", equity: 1_510_000 },
    ];
    flowRows = [{ flow_date: "2026-08-04", amount: 500_000 }];
    const { body } = await request();
    // Daily equity is the only valuation available. `(E_t − flow) / E_{t−1}`
    // books the deposit at the close; a morning deposit would need
    // `E_{t−1} + flow` as the denominator instead, and nothing here can tell
    // the two apart. Publishing either as "cash-flow-adjusted TWR" would
    // present an approximation as an exact figure.
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("CASH_FLOW_TIMING_UNVERIFIABLE");
    expect(body.performance).toBeNull();
    expect(body.detail).toContain("1 external cash movement");
  });

  it("refuses rather than approximating a withdrawal inside the window", async () => {
    equityRows = [
      { snapshot_date: "2026-08-03", equity: 1_000_000 },
      { snapshot_date: "2026-08-04", equity: 910_000 },
      { snapshot_date: "2026-08-05", equity: 910_000 },
    ];
    flowRows = [{ flow_date: "2026-08-04", amount: -100_000 }];
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("CASH_FLOW_TIMING_UNVERIFIABLE");
    expect(body.performance).toBeNull();
  });

  it("refuses a cash movement dated on the baseline session itself", async () => {
    // The recorded starting equity may be the value before the movement or
    // after it, and nothing in the ledger says which. Folding it into the
    // opening balance would silently pick one.
    flowRows = [{ flow_date: START_SESSION, amount: 10_000 }];
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("BASELINE_SESSION_HAS_CASH_FLOW");
    expect(body.detail).toContain("Re-anchor");
  });

  it("refuses a ledger row with an unusable date or amount", async () => {
    // Caught while reading the snapshot rather than while computing: a row the
    // reader cannot parse means the snapshot is not usable, full stop.
    flowRows = [{ flow_date: "not-a-date", amount: 1 }];
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("HISTORY_UNUSABLE");
  });

  it("reports an exact return when the window is genuinely flow-free", async () => {
    // With no external movement, chaining daily returns *is* exact TWR.
    flowRows = [];
    const { body } = await request();
    expect(body.status).toBe("CURRENT");
    expect(body.performance.portfolioTwrPct).toBeCloseTo(2, 4);
    expect(body.performance.netCashFlow).toBe(0);
    expect(body.performance.cashFlowCount).toBe(0);
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

  it("refuses an unreadable portfolio history instead of reporting a number", async () => {
    refreshResult = {
      ok: false,
      reason: "PORTFOLIO_HISTORY_UNREADABLE",
      detail: "Alpaca portfolio history HTTP 503. Nothing was written.",
    };
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("EQUITY_REFRESH_FAILED");
    expect(body.detail).toContain("Nothing was written");
  });

  it("refuses an incomplete cash-flow walk", async () => {
    refreshResult = {
      ok: false,
      reason: "CASH_FLOW_INCOMPLETE",
      detail: "A full page of activities produced no usable pagination id.",
    };
    const { body } = await request();
    expect(body.reason).toBe("CASH_FLOW_INCOMPLETE");
    expect(body.detail).toContain("pagination id");
  });

  it("refuses a refresh that a newer one has superseded", async () => {
    // Two overlapping refreshes: the one that started earlier must not publish
    // over the newer one, and the caller must not present a number from it.
    refreshResult = {
      ok: false,
      reason: "STALE_GENERATION",
      detail:
        "The refresh was refused and rolled back: refresh generation 4 is not newer than the published generation 7",
    };
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("REFRESH_SUPERSEDED");
  });

  it("refuses a database error on the history snapshot", async () => {
    snapshotError = { message: "connection reset" };
    const { body } = await request();
    expect(body.reason).toBe("EQUITY_QUERY_FAILED");
    expect(body.detail).toContain("connection reset");
  });

  it("refuses a history too large to read in one snapshot", async () => {
    // Materialising an unbounded history is its own failure mode; the RPC
    // raises rather than returning a partial answer.
    snapshotError = {
      message: "account history is 30000 rows, above the 20000 row snapshot limit",
    };
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("HISTORY_TOO_LARGE");
  });

  it.each([
    ["seven hours", 7 * 60 * 60 * 1000],
    ["a year", 365 * 24 * 60 * 60 * 1000],
  ])("refuses a broker activity %s in the future", async (_label, aheadMs) => {
    refreshResult = {
      ok: true,
      latestActivityAt: new Date(Date.now() + aheadMs).toISOString(),
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
    // 16:00Z is midday in New York on the same date, the ordinary case. The
    // activity timestamp has to be in the past too, now that a future one is
    // held to five minutes rather than a day.
    refreshResult = { ok: true, latestActivityAt: "2026-08-05T13:45:00.000Z" };
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
    refreshResult = {
      ok: false,
      reason: "NON_CASH_EXTERNAL_TRANSFER",
      detail:
        "An external securities transfer (ACATS, 2026-08-04) settled in this account after the V11 epoch baseline.",
    };
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("NON_CASH_EXTERNAL_TRANSFER");
    expect(body.performance).toBeNull();
    expect(body.detail).toContain("ACATS");
  });
});

/* ---------------------------------------------------------------------------
 * Both datasets come from ONE database snapshot.
 *
 * A page walk cannot give that: several requests are several MVCC snapshots,
 * and an UPDATE to a row already read leaves the count unchanged, repeats no
 * key and skips nothing — so a torn read passes every client-side consistency
 * check there is. The real-PostgREST gate in `supabase/tests/run_postgrest.sh`
 * demonstrates the tear against a live server; this asserts the route asks for
 * the snapshot and uses all of it.
 * ------------------------------------------------------------------------- */

describe("history comes from one snapshot, not a page walk", () => {
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

  it("makes exactly one history request, bounded at the baseline", async () => {
    await request();
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]).toMatchObject({
      p_account: ACCOUNT_ID,
      p_owner: OWNER_ID,
      p_from: START_SESSION,
    });
  });

  it("uses every row of a history far past any server page cap", async () => {
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

    expect(snapshotCalls).toHaveLength(1);
    expect(body.performance.sessions).toBe(1_250);
    expect(body.performance.startDate).toBe(START_SESSION);
    expect(body.performance.endDate).toBe(end);
    // 1_000_000 → 2_249_000 is +124.9%. Truncating at 1000 rows would report
    // +99.9% — plausible, and wrong by 25 points.
    expect(body.performance.portfolioTwrPct).toBeCloseTo(124.9, 4);
  });

  it("reads the whole ledger, then still withholds the number", async () => {
    const dates = tradingDays(1_100, START_SESSION);
    const end = dates[dates.length - 1];
    equityRows = dates.map((date) => ({ snapshot_date: date, equity: 1_000_000 }));
    benchmarkBars = dates.map((date) => ({ date, close: 700 }));
    flowRows = dates.map((date) => ({ flow_date: date, amount: 1 }));
    vi.setSystemTime(new Date(`${end}T20:00:00Z`));

    const { body } = await request();

    expect(snapshotCalls).toHaveLength(1);
    // An external movement inside the window cannot be corrected exactly
    // without an intraday valuation, so no return is published.
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("BASELINE_SESSION_HAS_CASH_FLOW");
  });

  it("refuses a snapshot whose payload disagrees with its own counts", async () => {
    // A snapshot claiming more rows than it carries is not the consistent read
    // it says it is, whatever produced it.
    inflateSnapshotCounts = true;
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("HISTORY_UNUSABLE");
  });

  it("refuses a snapshot with no snapshot identity", async () => {
    dropSnapshotToken = true;
    const { body } = await request();
    expect(body.status).toBe("UNAVAILABLE");
    expect(body.reason).toBe("HISTORY_UNUSABLE");
  });
});
