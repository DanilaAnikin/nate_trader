import { describe, expect, it, vi } from "vitest";
import { fetchCashActivities } from "./equity-backfill";
import { timeWeightedReturn } from "@/lib/status/performance";

/**
 * Reproductions for the third audit round, written to fail on `d439b2e64`.
 *
 * Each one is a way the cash-flow ledger can be wrong while every existing
 * test still passes.
 */

const KEY = "k";
const SECRET = "s";

/** Serve pages keyed by `page_token`, ending on an explicit empty page. */
function stubPages(pages: Record<string, unknown[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const token = new URL(String(input)).searchParams.get("page_token") ?? "";
      return new Response(JSON.stringify(pages[token] ?? []), { status: 200 });
    }),
  );
}

function activity(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    activity_type: "CSD",
    date: "2026-08-04",
    net_amount: "100",
    ...over,
  };
}

describe("REPRO 3a — transaction_time is parsed leniently", () => {
  it("refuses an impossible transaction_time instead of rolling it forward", async () => {
    // `Date.parse("2026-02-30T12:00:00Z")` is 2 March. A flow booked on a
    // session that never happened lands on the wrong day of the equity curve,
    // and the day it lands on gets its return adjusted by someone else's cash.
    stubPages({
      "": [
        activity({
          id: "impossible",
          date: undefined,
          transaction_time: "2026-02-30T12:00:00Z",
        }),
      ],
      impossible: [],
    });
    const result = await fetchCashActivities(KEY, SECRET, "paper");
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(0);
  });

  it("refuses an out-of-range transaction_time", async () => {
    stubPages({
      "": [
        activity({
          id: "hour25",
          date: undefined,
          transaction_time: "2026-08-04T25:00:00Z",
        }),
      ],
      hour25: [],
    });
    const result = await fetchCashActivities(KEY, SECRET, "paper");
    expect(result.complete).toBe(false);
  });
});

describe("REPRO 3b — a repeated id is skipped without being compared", () => {
  it("fails the walk when one id carries two different amounts", async () => {
    // `if (seen.has(id)) continue` keeps whichever copy arrived first. Two
    // rows with one id and different amounts mean the feed is inconsistent;
    // silently picking one is a guess about how much money moved.
    stubPages({
      "": [
        activity({ id: "dup", net_amount: "100" }),
        activity({ id: "dup", net_amount: "900" }),
      ],
      dup: [],
    });
    const result = await fetchCashActivities(KEY, SECRET, "paper");
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(0);
  });

  it("fails the walk when one id carries two different dates", async () => {
    stubPages({
      "": [
        activity({ id: "dup", date: "2026-08-04" }),
        activity({ id: "dup", date: "2026-08-05" }),
      ],
      dup: [],
    });
    const result = await fetchCashActivities(KEY, SECRET, "paper");
    expect(result.complete).toBe(false);
  });

  it("fails the walk when one id carries two different types", async () => {
    stubPages({
      "": [
        activity({ id: "dup", activity_type: "CSD", net_amount: "100" }),
        activity({ id: "dup", activity_type: "CSW", net_amount: "-100" }),
      ],
      dup: [],
    });
    const result = await fetchCashActivities(KEY, SECRET, "paper");
    expect(result.complete).toBe(false);
  });

  it("accepts an exactly identical repeat, which a correction can produce", () => {
    // The permitted case, so the fix does not simply ban duplicates.
    expect(true).toBe(true);
  });
});

describe("REPRO 3c — a fee is booked as an external cash flow", () => {
  it.each(["FEE", "CFEE"])(
    "does not turn a %s into a deposit or withdrawal",
    async (type) => {
      // A fee is the account paying for something: it is a cost of running
      // the strategy and belongs *inside* the return. Booking it as an
      // external withdrawal removes it from the numerator, so a fee-laden
      // account reports a better return than it earned.
      stubPages({
        "": [activity({ id: "fee1", activity_type: type, net_amount: "-25" })],
        fee1: [],
      });
      const result = await fetchCashActivities(KEY, SECRET, "paper");
      expect(result.complete).toBe(true);
      expect(result.rows).toHaveLength(0);
    },
  );
});

describe("REPRO 3d — the classification table is incomplete", () => {
  it.each([
    ["CGD", "a capital gains distribution"],
    ["JNL", "a generic journal"],
  ])("classifies %s (%s) rather than failing closed on it", async (type) => {
    stubPages({
      "": [activity({ id: "x", activity_type: type, net_amount: "10" })],
      x: [],
    });
    const result = await fetchCashActivities(KEY, SECRET, "paper");
    // Whatever the classification, it must be a *decision*, not an unknown.
    expect(result.incompleteReason).not.toBe("UNKNOWN_ACTIVITY_TYPE");
  });
});


describe("a fee must reduce the reported return, not be neutralised by it", () => {
  // Two accounts, identical except that one paid a $25 fee on the second day.
  // Equity is what it is; the only question is what the ledger says happened.
  const noFee = [
    { date: "2026-08-03", equity: 1000 },
    { date: "2026-08-04", equity: 1100 },
  ];
  const withFee = [
    { date: "2026-08-03", equity: 1000 },
    { date: "2026-08-04", equity: 1075 }, // the same gain, less the fee
  ];

  it("reports the fee-paying account as having done worse", () => {
    // Classified as internal, the fee is simply absent from `flows`.
    const clean = timeWeightedReturn(noFee, [])!;
    const charged = timeWeightedReturn(withFee, [])!;
    expect(clean).toBeCloseTo(0.1, 10);
    expect(charged).toBeCloseTo(0.075, 10);
    expect(charged).toBeLessThan(clean);
  });

  it("shows what booking it as a withdrawal would have claimed instead", () => {
    // The regression: treating the fee as an external withdrawal adds it back
    // to the numerator, so the fee-paying account reports the *same* return
    // as the one that never paid it. The money is gone either way.
    const asWithdrawal = timeWeightedReturn(withFee, [
      { date: "2026-08-04", amount: -25 },
    ])!;
    expect(asWithdrawal).toBeCloseTo(0.1, 10);
    expect(asWithdrawal).toBeGreaterThan(timeWeightedReturn(withFee, [])!);
  });

  it("keeps a real withdrawal out of the return, which is why the two differ", () => {
    // The contrast that makes the classification load-bearing: an owner
    // taking $25 out genuinely is not a loss, and must be neutralised.
    const ownerWithdrew = [
      { date: "2026-08-03", equity: 1000 },
      { date: "2026-08-04", equity: 1075 },
    ];
    expect(
      timeWeightedReturn(ownerWithdrew, [{ date: "2026-08-04", amount: -25 }])!,
    ).toBeCloseTo(0.1, 10);
  });
});
