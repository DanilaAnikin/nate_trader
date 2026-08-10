import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillCashFlows, backfillEquity } from "./equity-backfill";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Cash-flow completeness is what keeps a deposit from being reported as
 * profit, so "we skipped something we did not understand" is never acceptable.
 */

type Row = Database["public"]["Tables"]["cash_flows"]["Insert"];

/**
 * A service double that answers all three calls the walk now makes: the
 * reconciliation read of the mirrored ledger, the removal of rows the broker no
 * longer has, and the upsert.
 */
function service(
  options: {
    upsertError?: string;
    /** Rows already mirrored into `cash_flows` before this walk. */
    mirrored?: { external_id: string; flow_date: string }[];
    selectError?: string;
    deleteError?: string;
  } = {},
) {
  const upserted: Row[] = [];
  const deleted: string[] = [];
  const svc = {
    rpc: async () => ({
      data: [{ api_key: "k", api_secret: "s" }],
      error: null,
    }),
    from: () => {
      const builder = {
        upsert: async (rows: Row[]) => {
          upserted.push(...rows);
          return options.upsertError
            ? { error: { message: options.upsertError } }
            : { error: null };
        },
        // `select(...).eq(...).eq(...)` resolves to the mirrored ledger.
        select: () => {
          const query = {
            eq: () => query,
            then: <R>(
              onFulfilled: (value: {
                data: { external_id: string; flow_date: string }[] | null;
                error: { message: string } | null;
              }) => R,
            ) =>
              Promise.resolve(
                options.selectError
                  ? { data: null, error: { message: options.selectError } }
                  : { data: options.mirrored ?? [], error: null },
              ).then(onFulfilled),
          };
          return query;
        },
        delete: () => {
          const query = {
            eq: () => query,
            in: async (_column: string, ids: string[]) => {
              deleted.push(...ids);
              return options.deleteError
                ? { error: { message: options.deleteError } }
                : { error: null };
            },
          };
          return query;
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient<Database>;
  return { svc, upserted, deleted };
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");

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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
    expect(result.complete).toBe(true);
    expect(upserted[0]).toMatchObject({ external_id: "acat", amount: 5000 });
  });

  it("requests every cash type and every non-cash transfer type", async () => {
    const calls = stubPages({ "": [] });
    const { svc } = service();
    await backfillCashFlows(svc, "acc-1", "paper");
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");

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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
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
      const result = await backfillCashFlows(svc, "acc-1", "paper");
      expect(result.complete, JSON.stringify(broken)).toBe(false);
      expect(result.incompleteReason).toBe("MALFORMED_ACTIVITY");
      expect(upserted).toHaveLength(0);
    }
  });

  it("is incomplete when Alpaca returns a type that was not requested", async () => {
    stubPages({ "": [activity({ id: "fill", activity_type: "FILL" })] });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", "paper");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("UNEXPECTED_ACTIVITY_TYPE");
  });

  it("throws on a broker outage so the caller can fail closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 503 })),
    );
    const { svc } = service();
    await expect(backfillCashFlows(svc, "acc-1", "paper")).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it("throws when the upsert fails", async () => {
    stubPages({ "": [activity({ id: "dep" })] });
    const { svc } = service({ upsertError: "db exploded" });
    await expect(backfillCashFlows(svc, "acc-1", "paper")).rejects.toThrow(
      /db exploded/,
    );
  });

  it("reports the newest activity timestamp for freshness", async () => {
    stubPages({
      "": [
        activity({ id: "old", date: "2026-08-01" }),
        activity({ id: "new", date: "2026-08-06" }),
      ],
    });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", "paper");
    expect(result.latestActivityAt?.slice(0, 10)).toBe("2026-08-06");
  });

  it("reads the whole history rather than a finite window", async () => {
    const calls = stubPages({ "": [] });
    const { svc } = service();
    await backfillCashFlows(svc, "acc-1", "paper", {
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
      const result = await backfillCashFlows(svc, "acc-1", "paper", {
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
    const result = await backfillCashFlows(svc, "acc-1", "paper", {
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
    expect(result.complete).toBe(true);
    expect(upserted[0]).toMatchObject({ amount: expected });
  });

  it("treats an exact zero as understood but writes no flow", async () => {
    stubPages({ "": [activity({ id: "zero", net_amount: "0.00" })] });
    const { svc, upserted } = service();
    const result = await backfillCashFlows(svc, "acc-1", "paper");
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
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
    const result = await backfillCashFlows(svc, "acc-1", "paper", {
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
    expect(result.complete).toBe(true);
    expect(upserted).toHaveLength(101);
    expect(new Set(upserted.map((row) => row.external_id)).size).toBe(101);
  });

  it("is incomplete when the baseline boundary itself is unusable", async () => {
    stubPages({ "": [] });
    const { svc } = service();
    const result = await backfillCashFlows(svc, "acc-1", "paper", {
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
  it("removes a mirrored flow the broker no longer reports", async () => {
    stubPages({ "": [activity({ id: "still-there", net_amount: "100" })] });
    const { svc, upserted, deleted } = service({
      mirrored: [
        { external_id: "still-there", flow_date: "2026-08-04" },
        { external_id: "withdrawn", flow_date: "2026-08-04" },
      ],
    });
    const result = await backfillCashFlows(svc, "acc-1", "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
    expect(deleted).toEqual(["withdrawn"]);
    expect(upserted.map((row) => row.external_id)).toEqual(["still-there"]);
  });

  it("overwrites an amended activity rather than keeping both versions", async () => {
    // Same id, corrected amount and date.
    stubPages({
      "": [activity({ id: "amended", net_amount: "250", date: "2026-08-05" })],
    });
    const { svc, upserted, deleted } = service({
      mirrored: [{ external_id: "amended", flow_date: "2026-08-04" }],
    });
    const result = await backfillCashFlows(svc, "acc-1", "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
    expect(deleted).toEqual([]);
    expect(upserted).toEqual([
      expect.objectContaining({
        external_id: "amended",
        amount: 250,
        flow_date: "2026-08-05",
      }),
    ]);
  });

  it("leaves pre-baseline rows alone — the walk makes no claim about them", async () => {
    stubPages({ "": [] });
    const { svc, deleted } = service({
      mirrored: [{ external_id: "ancient", flow_date: "2026-07-01" }],
    });
    const result = await backfillCashFlows(svc, "acc-1", "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(true);
    expect(deleted).toEqual([]);
  });

  it("is incomplete when the mirror cannot be read for reconciliation", async () => {
    stubPages({ "": [activity({ id: "dep" })] });
    const { svc, upserted } = service({ selectError: "ledger unreadable" });
    const result = await backfillCashFlows(svc, "acc-1", "paper");
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("LEDGER_RECONCILE_FAILED");
    expect(upserted).toHaveLength(0);
  });

  it("is incomplete when a withdrawn row cannot be removed", async () => {
    stubPages({ "": [] });
    const { svc, upserted } = service({
      mirrored: [{ external_id: "withdrawn", flow_date: "2026-08-04" }],
      deleteError: "delete refused",
    });
    const result = await backfillCashFlows(svc, "acc-1", "paper", {
      since: "2026-08-01T00:00:00.000Z",
    });
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("LEDGER_RECONCILE_FAILED");
    // Nothing is written while a stale row survives.
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
    expect(result.complete).toBe(true);
    expect(upserted).toHaveLength(3);
  });

  it("refuses an activity dated after today's New York session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-06T16:00:00Z"));
    try {
      stubPages({ "": [activity({ id: "future", date: "2026-08-07" })] });
      const { svc } = service();
      const result = await backfillCashFlows(svc, "acc-1", "paper");
      expect(result.complete).toBe(false);
      expect(result.incompleteReason).toBe("FUTURE_DATED_ACTIVITY");
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts today's own session under the clock-skew tolerance", async () => {
    vi.useFakeTimers();
    // 01:00Z on the 7th is still the 6th in New York, so an activity dated the
    // 6th is today's, not tomorrow's.
    vi.setSystemTime(new Date("2026-08-07T01:00:00Z"));
    try {
      stubPages({ "": [activity({ id: "today", date: "2026-08-06" })] });
      const { svc } = service();
      const result = await backfillCashFlows(svc, "acc-1", "paper");
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
    const result = await backfillCashFlows(svc, "acc-1", "paper");
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
    await expect(backfillEquity(svc, "acc-1", "paper")).rejects.toThrow(
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
    await expect(backfillEquity(svc, "acc-1", "paper")).rejects.toThrow(
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
    await expect(backfillEquity(svc, "acc-1", "paper")).rejects.toThrow(
      /profit_loss/,
    );
  });

  it("refuses a non-numeric timestamp", async () => {
    stubHistory({ timestamp: ["yesterday"], equity: [1000] });
    const { svc } = service();
    await expect(backfillEquity(svc, "acc-1", "paper")).rejects.toThrow(
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
    await expect(backfillEquity(svc, "acc-1", "paper")).resolves.toBe(2);
  });
});
