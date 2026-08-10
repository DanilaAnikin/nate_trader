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

  it("requests every cash activity type, including ACATC", async () => {
    const calls = stubPages({ "": [] });
    const { svc } = service();
    await backfillCashFlows(svc, "acc-1", "paper");
    const types = new URL(calls[0]).searchParams.get("activity_types");
    expect(types?.split(",").sort()).toEqual(["ACATC", "CSD", "CSW", "JNLC"]);
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

  it("passes the baseline boundary as the `after` filter", async () => {
    const calls = stubPages({ "": [] });
    const { svc } = service();
    await backfillCashFlows(svc, "acc-1", "paper", {
      since: "2026-08-03T13:30:00.000Z",
    });
    expect(new URL(calls[0]).searchParams.get("after")).toBe(
      "2026-08-03T13:30:00.000Z",
    );
  });
});
