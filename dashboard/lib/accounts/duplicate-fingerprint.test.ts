/**
 * Two copies of one activity id must be *identical*, not merely
 * indistinguishable to the fields the fingerprint happened to include.
 *
 * The fingerprint covered the activity type, the occurrence date/instant and
 * `net_amount`. Everything else was invisible to it — including `symbol` and
 * `qty`, which are exactly the fields `looksLikeSecurities` classifies on. So
 * a feed could serve the same id twice, once as an ordinary cash row and once
 * carrying instrument fields, and the second copy was dropped as a permitted
 * repeat *before* it was ever classified. The walk then declared itself
 * complete having silently chosen one of two contradictory readings.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCashActivities } from "./equity-backfill";

const KEY = "k";
const SECRET = "s";

function activity(overrides: Record<string, unknown> = {}) {
  return {
    id: "dup",
    activity_type: "CSD",
    date: "2026-08-04",
    net_amount: "1000",
    ...overrides,
  };
}

function stubPages(pages: Record<string, unknown[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const token = new URL(String(input)).searchParams.get("page_token") ?? "";
      return new Response(JSON.stringify(pages[token] ?? []), { status: 200 });
    }),
  );
}

async function walk(first: unknown[]) {
  stubPages({ "": first, dup: [] });
  return fetchCashActivities(KEY, SECRET, "paper");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("duplicate activity ids", () => {
  it("accepts a byte-identical repeat, which paging by id produces", async () => {
    // The cursor row is legitimately re-served on the next page. Banning all
    // repeats would break the ordinary walk.
    const result = await walk([activity(), activity()]);
    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  it.each([
    ["a later symbol", { symbol: "AAPL" }],
    ["a later qty", { qty: 10 }],
    ["a later string qty", { qty: "10" }],
    ["a later side", { side: "buy" }],
    ["a later price", { price: "100.25" }],
    ["a later cusip", { cusip: "037833100" }],
    ["a later per-share amount", { per_share_amount: "0.25" }],
    ["a later status", { status: "corrected" }],
    ["a later description", { description: "amended" }],
    ["a later transaction time", { transaction_time: "2026-08-04T14:00:00Z" }],
  ])("refuses one id served with %s", async (_label, patch) => {
    const result = await walk([activity(), activity(patch)]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("CONTRADICTORY_DUPLICATE");
  });

  it("refuses a copy that drops a field the first copy carried", async () => {
    const result = await walk([activity({ symbol: "AAPL" }), activity()]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("CONTRADICTORY_DUPLICATE");
  });

  it("classifies both copies before deduplicating them", async () => {
    // The second copy is a securities-shaped row: instrument fields and no
    // cash amount. It used to be dropped as a repeat before
    // `looksLikeSecurities` ever saw it. Whichever refusal fires, the walk
    // must not come back complete having booked the first copy's $1000.
    const result = await walk([
      activity(),
      activity({ symbol: "AAPL", qty: "10", net_amount: null }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(0);
  });

  it("refuses an unclassifiable second copy rather than dropping it", async () => {
    const result = await walk([
      activity(),
      activity({ activity_type: "SOMETHING_NEW" }),
    ]);
    expect(result.complete).toBe(false);
  });

  it("treats a numeric and a string amount for one id as contradictory", async () => {
    // They may denote the same money, but a feed that cannot serve one id
    // consistently is not a feed this walk can prove completeness from.
    const result = await walk([
      activity({ net_amount: 1000 }),
      activity({ net_amount: "1000" }),
    ]);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe("CONTRADICTORY_DUPLICATE");
  });
});
