import { beforeEach, describe, expect, it, vi } from "vitest";
import { backfillCashFlows } from "./equity-backfill";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Cash-flow completeness is what keeps a deposit from being reported as
 * profit, so "we skipped something we did not understand" is never acceptable.
 */

type Row = Database["public"]["Tables"]["cash_flows"]["Insert"];

function service(options: { upsertError?: string } = {}) {
  const upserted: Row[] = [];
  const svc = {
    rpc: async () => ({
      data: [{ api_key: "k", api_secret: "s" }],
      error: null,
    }),
    from: () => ({
      upsert: async (rows: Row[]) => {
        upserted.push(...rows);
        return options.upsertError
          ? { error: { message: options.upsertError } }
          : { error: null };
      },
    }),
  } as unknown as SupabaseClient<Database>;
  return { svc, upserted };
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

  it("asks for a window that starts before the baseline", async () => {
    const calls = stubPages({ "": [] });
    const { svc } = service();
    await backfillCashFlows(svc, "acc-1", "paper", {
      since: "2026-08-03T13:30:00.000Z",
    });
    // Alpaca filters on the activity's own date, which a late settlement or a
    // correction can move. The overlap makes such a shift visible.
    expect(new URL(calls[0]).searchParams.get("after")).toBe(
      "2026-07-24T13:30:00.000Z",
    );
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
    ["a negative string", "-750.25", -750.25],
    ["an explicit plus", "+42", 42],
    ["a bare integer string", "1000", 1000],
    ["a JSON number", 1234.56, 1234.56],
    ["a negative JSON number", -99, -99],
  ])("accepts %s", async (_label, value, expected) => {
    stubPages({ "": [activity({ id: "ok", net_amount: value })] });
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
