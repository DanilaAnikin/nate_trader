import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillCashFlows, backfillEquity } from "./equity-backfill";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Cash-flow completeness is what keeps a deposit from being reported as
 * profit, so "we skipped something we did not understand" is never acceptable.
 */

type Row = Database["public"]["Tables"]["cash_flows"]["Insert"];

const OWNER_ID = "99999999-9999-9999-9999-999999999999";

/**
 * A service double for the two atomic RPCs the walk now calls.
 *
 * The mirror is no longer read and rewritten from here: `reconcile_cash_flow_mirror`
 * and `replace_equity_snapshots` do the upsert *and* the set difference inside
 * one transaction, so this double records what was handed to them.
 */
function service(
  options: {
    /** Fail the cash-flow reconciliation RPC. */
    reconcileError?: string;
    /** Fail the equity reconciliation RPC. */
    equityError?: string;
    /** What the RPC reports it removed, so the caller's handling is testable. */
    removed?: number;
  } = {},
) {
  const upserted: Row[] = [];
  const equityRows: Record<string, unknown>[] = [];
  let reconcileCalls = 0;
  const svc = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "get_account_credentials") {
        return { data: [{ api_key: "k", api_secret: "s" }], error: null };
      }
      if (name === "reconcile_cash_flow_mirror") {
        reconcileCalls++;
        if (options.reconcileError) {
          return { data: null, error: { message: options.reconcileError } };
        }
        const rows = (args.p_rows ?? []) as Record<string, unknown>[];
        upserted.push(
          ...rows.map((row) => ({
            account_id: args.p_account as string,
            external_id: row.external_id as string,
            flow_date: row.flow_date as string,
            amount: row.amount as number,
            kind: row.kind as string,
            source: "alpaca_activities",
          })),
        );
        return {
          data: { written: rows.length, removed: options.removed ?? 0 },
          error: null,
        };
      }
      if (name === "replace_equity_snapshots") {
        if (options.equityError) {
          return { data: null, error: { message: options.equityError } };
        }
        equityRows.push(...((args.p_rows ?? []) as Record<string, unknown>[]));
        return { data: { written: equityRows.length, removed: 0 }, error: null };
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient<Database>;
  return {
    svc,
    upserted,
    equityRows,
    reconcileCalls: () => reconcileCalls,
  };
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: `act-${Math.random().toString(36).slice(2)}`,
    activity_type: "CSD",
    date: "2026-08-04",
    net_amount: "1000",
    ...overrides,
  };
}

/** Serve fixed pages, keyed by the `page_token` query parameter. */
function stubPages(pages: Record<string, unknown[]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const token = new URL(url).searchParams.get("page_token") ?? "";
      const body = pages[token] ?? [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("backfillCashFlows", () => {
  it("records a deposit and a withdrawal with the right sign", async () => {
    stubPages({
      "": [
        activity({ id: "dep", activity_type: "CSD", net_amount: "2500.50" }),
        activity({ id: "wd", activity_type: "CSW", net_amount: "-750.25" }),
      ],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");

    expect(result.complete).toBe(true);
    expect(result.written).toBe(2);
    expect(upserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ external_id: "dep", amount: 2500.5, kind: "deposit" }),
        expect.objectContaining({ external_id: "wd", amount: -750.25, kind: "withdrawal" }),
      ]),
    );
  });

  it("records an ACAT cash transfer", async () => {
    stubPages({
      "": [activity({ id: "acat", activity_type: "ACATC", net_amount: "5000" })],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    expect(upserted[0]).toMatchObject({ external_id: "acat", amount: 5000 });
  });

  it("requests every cash type and every non-cash transfer type", async () => {
    const calls = stubPages({ "": [] });
    const { svc } = service();
    await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    const types = new URL(calls[0]).searchParams.get("activity_types");
    // The securities transfers are requested so they can be *detected*: they
    // move equity with no cash leg and must block any reported return.
    expect(types?.split(",").sort()).toEqual([
      "ACATC",
      "ACATS",
      "CSD",
      "CSW",
      "FOPT",
      "JNLC",
      "JNLS",
    ]);
  });

  it("pages past 100 activities and keeps them all", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      activity({ id: `p1-${index}`, net_amount: "10" }),
    );
    const second = Array.from({ length: 30 }, (_, index) =>
      activity({ id: `p2-${index}`, net_amount: "10" }),
    );
    stubPages({ "": first, "p1-99": second });

    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");

    expect(result.complete).toBe(true);
    expect(result.pagesRead).toBe(2);
    expect(upserted).toHaveLength(130);
  });

  it("is incomplete when a full page yields no pagination id", async () => {
    // 100 items whose last entry has no usable id cannot be paged past.
    const page = Array.from({ length: 99 }, (_, index) =>
      activity({ id: `p-${index}` }),
    );
    page.push(activity({ id: "", net_amount: "10" }));
    stubPages({ "": page });

    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    // The blank id is itself malformed, which is caught first and is equally
    // fatal: either way the walk is not complete.
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("MALFORMED_ACTIVITY");
  });

  it("is incomplete rather than silently skipping a malformed activity", async () => {
    for (const broken of [
      { id: undefined },
      { activity_type: undefined },
      { date: undefined, transaction_time: undefined },
      { net_amount: "not-a-number" },
      { date: "not-a-date" },
    ]) {
      stubPages({ "": [activity(broken)] });
      const { svc, upserted } = service();
      const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
      expect(result.complete, JSON.stringify(broken)).toBe(false);
      expect(result.incompleteReason).toBe("MALFORMED_ACTIVITY");
      expect(upserted).toHaveLength(0);
    }
  });

  it("is incomplete when Alpaca returns a type that was not requested", async () => {
    stubPages({ "": [activity({ id: "fill", activity_type: "FILL" })] });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("UNEXPECTED_ACTIVITY_TYPE");
  });

  it("throws on a broker outage so the caller can fail closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 503 })),
    );
    const { svc } = service();
    await expect(backfillCashFlows(svc, "acc-1", OWNER_ID, "paper")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("is incomplete when the reconciliation transaction fails", async () => {
    stubPages({ "": [activity({ id: "dep" })] });
    const { svc } = service({ reconcileError: "db exploded" });
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("LEDGER_RECONCILE_FAILED");
    expect(result.detail).toContain("db exploded");
  });

  it("reports the newest *real* timestamp for freshness", async () => {
    // A date-only activity has no time of day. Reporting a fabricated midday
    // instant would make it look hours into the future to any clock check.
    stubPages({
      "": [
        activity({
          id: "old",
          date: "2026-08-01",
          transaction_time: "2026-08-01T14:00:00Z",
        }),
        activity({
          id: "new",
          date: "2026-08-06",
          transaction_time: "2026-08-06T14:00:00Z",
        }),
      ],
    });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.latestActivityAt).toBe("2026-08-06T14:00:00.000Z");
  });

  it("reports no timestamp at all when every activity is date-only", async () => {
    stubPages({ "": [activity({ id: "dated", date: "2026-08-04" })] });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    // Better honestly absent than a midday instant a caller would clock-check.
    expect(result.latestActivityAt).toBeNull();
  });

  it("reads the whole history rather than a finite window", async () => {
    const calls = stubPages({ "": [] });
    const { svc } = service();
    await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "2026-08-03T13:30:00.000Z",
    });
    // No server-side date filter at all. Alpaca's `after` applies to the
    // activity record rather than the settlement date the ledger books
    // against, so any finite lookback has an edge a late or amended activity
    // can cross unseen. The baseline is applied afterwards, to each activity's
    // real occurrence date.
    const params = new URL(calls[0]).searchParams;
    expect(params.get("after")).toBeNull();
    expect(params.get("until")).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * A securities transfer moves equity without any cash to book. No time-weighted
 * return can neutralise it from the activity record, so it is not an
 * approximation problem — the number is simply not attributable.
 * ------------------------------------------------------------------------- */

describe("non-cash external transfers", () => {
  it.each(["ACATS", "JNLS", "FOPT"])(
    "refuses to report anything once a %s settles after the baseline",
    async (type) => {
      stubPages({
        "": [
          activity({ id: "dep", activity_type: "CSD", net_amount: "1000" }),
          activity({ id: "xfer", activity_type: type, date: "2026-08-05" }),
        ],
      });
      const { svc, upserted } = service();
      const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
        since: "2026-08-01T00:00:00.000Z",
      });

      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe("NON_CASH_EXTERNAL_TRANSFER");
      expect(result.detail).toContain(type);
      expect(result.detail).toContain("2026-08-05");
      // Nothing is written: a partial ledger would look complete next time.
      expect(upserted).toHaveLength(0);
    },
  );

  it("ignores a securities transfer that predates the baseline", async () => {
    // Inside the overlap window, but before the epoch — it belongs to the
    // pre-V11 account history the baseline exists to exclude.
    stubPages({
      "": [
        activity({ id: "old-xfer", activity_type: "ACATS", date: "2026-07-28" }),
        activity({ id: "dep", activity_type: "CSD", date: "2026-08-04" }),
      ],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
    expect(result.incompleteReason).toBeNull();
    expect(upserted.map((row) => row.external_id)).toEqual(["dep"]);
  });
});

describe("net_amount is accepted only in the expected shape", () => {
  it.each([
    ["null", null],
    ["missing", undefined],
    ["boolean true", true],
    ["boolean false", false],
    ["empty string", ""],
    ["whitespace", "   "],
    ["NaN string", "NaN"],
    ["Infinity string", "Infinity"],
    ["-Infinity string", "-Infinity"],
    ["NaN number", Number.NaN],
    ["Infinity number", Number.POSITIVE_INFINITY],
    ["thousands separator", "1,000.00"],
    ["currency", "$1000"],
    ["hex", "0x10"],
    ["exponent", "1e3"],
    ["object", { amount: 10 }],
    ["array", [10]],
  ])("is incomplete when net_amount is %s", async (_label, value) => {
    // `Number()` turns null, "", "   " and false into 0 and true into 1, so
    // each of these once looked like "understood, moved no money".
    stubPages({ "": [activity({ id: "bad", net_amount: value })] });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("MALFORMED_ACTIVITY");
    expect(result.detail).toContain("net_amount");
    expect(upserted).toHaveLength(0);
  });

  it.each([
    ["a decimal string", "2500.50", 2500.5],
    ["a negative string", "-750.25", -750.25, "CSW"],
    ["an explicit plus", "+42", 42],
    ["a bare integer string", "1000", 1000],
    ["a JSON number", 1234.56, 1234.56],
    ["a negative JSON number", -99, -99, "CSW"],
  ])("accepts %s", async (_label, value, expected, type = "CSD") => {
    stubPages({
      "": [activity({ id: "ok", net_amount: value, activity_type: type })],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    expect(upserted[0]).toMatchObject({ amount: expected });
  });

  it("treats an exact zero as understood but writes no flow", async () => {
    stubPages({ "": [activity({ id: "zero", net_amount: "0.00" })] });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    expect(upserted).toHaveLength(0);
  });
});

describe("occurrence date, not record-creation time", () => {
  it("books a flow on its settlement date, not its transaction_time", async () => {
    // Created just after midnight UTC on the 5th; the activity is dated the 4th.
    stubPages({
      "": [
        activity({
          id: "late",
          date: "2026-08-04",
          transaction_time: "2026-08-05T00:30:00Z",
        }),
      ],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    expect(upserted[0]).toMatchObject({ flow_date: "2026-08-04" });
  });

  it("falls back to transaction_time in market time when no date is given", async () => {
    // 01:30 UTC on the 5th is 21:30 ET on the 4th.
    stubPages({
      "": [
        activity({
          id: "tt",
          date: undefined,
          transaction_time: "2026-08-05T01:30:00Z",
        }),
      ],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    expect(upserted[0]).toMatchObject({ flow_date: "2026-08-04" });
  });

  it("filters the overlap window by the real activity date", async () => {
    stubPages({
      "": [
        activity({ id: "before", date: "2026-07-30", net_amount: "500" }),
        activity({ id: "on", date: "2026-08-01", net_amount: "600" }),
        activity({ id: "after", date: "2026-08-04", net_amount: "700" }),
      ],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "2026-08-01T13:30:00.000Z",
    });
    expect(result.complete).toBe(true);
    // The baseline day itself counts; earlier days do not.
    expect(upserted.map((row) => row.external_id).sort()).toEqual(["after", "on"]);
  });

  it("deduplicates an activity that appears on two pages", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      activity({ id: `p1-${index}`, net_amount: "10" }),
    );
    // The overlap and the token-based walk can both surface the same row.
    stubPages({
      "": first,
      "p1-99": [
        activity({ id: "p1-0", net_amount: "10" }),
        activity({ id: "fresh", net_amount: "10" }),
      ],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    expect(upserted).toHaveLength(101);
    expect(new Set(upserted.map((row) => row.external_id)).size).toBe(101);
  });

  it("is incomplete when the baseline boundary itself is unusable", async () => {
    stubPages({ "": [] });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "not-a-timestamp",
    });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("MALFORMED_ACTIVITY");
  });
});

/* ---------------------------------------------------------------------------
 * An upsert-only mirror can only ever add and amend. Alpaca can withdraw an
 * activity — a reversed transfer, a correction re-issued under a new id — and
 * the row written for it would otherwise subtract a deposit forever.
 * ------------------------------------------------------------------------- */

describe("reconciling corrected and withdrawn activities", () => {
  it("hands the whole current activity set to one atomic RPC", async () => {
    // The set difference happens in the database. Computing it here would need
    // an unpaged `select` of the mirrored ledger, which a server truncates
    // silently — and reconciling against a truncated list is worse than not
    // reconciling at all.
    stubPages({ "": [activity({ id: "still-there", net_amount: "100" })] });
    const { svc, upserted, reconcileCalls } = service({ removed: 1 });
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
    expect(reconcileCalls()).toBe(1);
    expect(upserted.map((row) => row.external_id)).toEqual(["still-there"]);
  });

  it("passes an amended activity through under its own id", async () => {
    stubPages({
      "": [activity({ id: "amended", net_amount: "250", date: "2026-08-05" })],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
    expect(upserted).toEqual([
      expect.objectContaining({
        external_id: "amended",
        amount: 250,
        flow_date: "2026-08-05",
      }),
    ]);
  });

  it("bounds the reconciliation window at the baseline", async () => {
    // Rows before the baseline are not the walk's to claim anything about, so
    // the RPC is told where the caller's authority starts.
    stubPages({ "": [] });
    const calls: Record<string, unknown>[] = [];
    const svc = {
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "get_account_credentials") {
          return { data: [{ api_key: "k", api_secret: "s" }], error: null };
        }
        calls.push({ name, ...args });
        return { data: { written: 0, removed: 0 }, error: null };
      },
    } as unknown as SupabaseClient<Database>;
    // A real baseline instant is market open, 13:30Z. The boundary is its
    // *market-time* date, because that is how activities are dated.
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "2026-08-03T13:30:00.000Z",
    });
    expect(result.complete).toBe(true);
    expect(calls[0]).toMatchObject({
      name: "reconcile_cash_flow_mirror",
      p_account: "acc-1",
      p_owner: OWNER_ID,
      p_from: "2026-08-03",
    });
  });

  it("is incomplete when the reconciliation is refused", async () => {
    stubPages({ "": [activity({ id: "dep" })] });
    const { svc, upserted } = service({ reconcileError: "delete refused" });
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("LEDGER_RECONCILE_FAILED");
    expect(upserted).toHaveLength(0);
  });
});

describe("an activity must agree with its own direction and the calendar", () => {
  it.each([
    ["CSD", "-1000"],
    ["CSW", "1000"],
  ])("is incomplete when a %s is booked with the wrong sign", async (type, amount) => {
    stubPages({
      "": [activity({ id: "wrong", activity_type: type, net_amount: amount })],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("MALFORMED_ACTIVITY");
    expect(result.detail).toContain("contradicts its own direction");
    expect(upserted).toHaveLength(0);
  });

  it("still allows a journal or ACAT cash transfer in either direction", async () => {
    stubPages({
      "": [
        activity({ id: "in", activity_type: "JNLC", net_amount: "500" }),
        activity({ id: "out", activity_type: "JNLC", net_amount: "-500" }),
        activity({ id: "acat-out", activity_type: "ACATC", net_amount: "-25" }),
      ],
    });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(true);
    expect(upserted).toHaveLength(3);
  });

  it("refuses an activity dated after today's New York session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T16:00:00Z"));
    try {
      stubPages({ "": [activity({ id: "future", date: "2026-08-07" })] });
      const { svc } = service();
      const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe("FUTURE_DATED_ACTIVITY");
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts today's own session under the clock-skew tolerance", async () => {
    vi.useFakeTimers();
    // 01:00Z on the 7th is still the 6th in New York, so an activity dated the
    // 6th is today's, not tomorrow's — even though its fabricated midday
    // instant is eleven hours ahead of this clock.
    vi.setSystemTime(new Date("2026-08-07T01:00:00Z"));
    try {
      stubPages({ "": [activity({ id: "today", date: "2026-08-06" })] });
      const { svc } = service();
      const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
      expect(result.complete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["7 hours", 7 * 60 * 60 * 1000],
    ["1 hour", 60 * 60 * 1000],
    ["6 minutes", 6 * 60 * 1000],
  ])("refuses a real timestamp %s in the future", async (_label, aheadMs) => {
    vi.useFakeTimers();
    const now = new Date("2026-08-06T16:00:00Z");
    vi.setSystemTime(now);
    try {
      stubPages({
        "": [
          activity({
            id: "ahead",
            date: "2026-08-06",
            transaction_time: new Date(now.getTime() + aheadMs).toISOString(),
          }),
        ],
      });
      const { svc } = service();
      const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe("FUTURE_DATED_ACTIVITY");
      expect(result.detail).toContain("five minutes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a real timestamp inside the five-minute tolerance", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-06T16:00:00Z");
    vi.setSystemTime(now);
    try {
      stubPages({
        "": [
          activity({
            id: "skewed",
            date: "2026-08-06",
            transaction_time: new Date(now.getTime() + 60_000).toISOString(),
          }),
        ],
      });
      const { svc } = service();
      const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
      expect(result.complete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["2026-02-30", "a day that does not exist"],
    ["2026-13-01", "a month that does not exist"],
  ])("refuses %s (%s)", async (date) => {
    stubPages({ "": [activity({ id: "bad-date", date })] });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", OWNER_ID, "paper");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("MALFORMED_ACTIVITY");
  });
});

describe("backfillEquity rejects an unusable portfolio-history payload", () => {
  function stubHistory(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );
  }

  it("refuses an empty payload instead of reporting zero days written", async () => {
    stubHistory({ timestamp: [], equity: [] });
    const { svc } = service();
    await expect(backfillEquity(svc, "acc-1", OWNER_ID, "paper")).rejects.toThrow(
      /no observations/,
    );
  });

  it("refuses columns of mismatched length", async () => {
    // Positional arrays: a length disagreement pairs one day's timestamp with
    // another day's equity, which is worse than no data.
    stubHistory({
      timestamp: [1_754_000_000, 1_754_086_400, 1_754_172_800],
      equity: [1000, 1010],
    });
    const { svc } = service();
    await expect(backfillEquity(svc, "acc-1", OWNER_ID, "paper")).rejects.toThrow(
      /inconsistent/,
    );
  });

  it("refuses a mismatched profit_loss column", async () => {
    stubHistory({
      timestamp: [1_754_000_000, 1_754_086_400],
      equity: [1000, 1010],
      profit_loss: [10],
    });
    const { svc } = service();
    await expect(backfillEquity(svc, "acc-1", OWNER_ID, "paper")).rejects.toThrow(
      /profit_loss/,
    );
  });

  it("refuses a non-numeric timestamp", async () => {
    stubHistory({ timestamp: ["yesterday"], equity: [1000] });
    const { svc } = service();
    await expect(backfillEquity(svc, "acc-1", OWNER_ID, "paper")).rejects.toThrow(
      /non-numeric timestamp/,
    );
  });

  it("accepts a well-formed payload", async () => {
    stubHistory({
      timestamp: [1_754_000_000, 1_754_086_400],
      equity: [1000, 1010],
      profit_loss: [0, 10],
      profit_loss_pct: [0, 0.01],
    });
    const { svc } = service();
    await expect(backfillEquity(svc, "acc-1", OWNER_ID, "paper")).resolves.toBe(2);
  });
});
