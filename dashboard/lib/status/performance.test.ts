import { describe, expect, it } from "vitest";
import {
  alignSeries,
  computeForwardPerformance,
  nySessionDate,
  parseEpochBaseline,
  timeWeightedReturn,
  type V11EpochBaseline,
} from "./performance";
import { APPROVED_SHA } from "@/test/fixtures";

const BASELINE_JSON = {
  schemaVersion: 1,
  strategyVersion: "v11-adaptive-momentum",
  releaseSha: APPROVED_SHA,
  accountId: "acc-1",
  startedAt: "2026-08-03T13:30:00Z",
  startSessionDate: "2026-08-03",
  startingEquity: 1_000_000,
  benchmarkSymbol: "SPY",
  benchmarkBaselineDate: "2026-08-03",
  benchmarkBaselineClose: 700,
  note: "first guarded paper cycle under the approved release",
};

const BASELINE = parseEpochBaseline(BASELINE_JSON) as V11EpochBaseline;

describe("nySessionDate", () => {
  it("buckets an evening UTC timestamp into the correct New York session", () => {
    // 2026-08-04T00:30Z is still 2026-08-03 in America/New_York.
    expect(nySessionDate("2026-08-04T00:30:00Z")).toBe("2026-08-03");
    expect(nySessionDate("2026-08-04T14:30:00Z")).toBe("2026-08-04");
  });
});

describe("parseEpochBaseline", () => {
  it("accepts a complete baseline", () => {
    expect(BASELINE).not.toBeNull();
    expect(BASELINE.releaseSha).toBe(APPROVED_SHA);
    expect(BASELINE.startingEquity).toBe(1_000_000);
  });

  it("rejects a baseline missing any auditable field", () => {
    for (const key of [
      "releaseSha",
      "accountId",
      "startedAt",
      "startSessionDate",
      "startingEquity",
      "benchmarkBaselineDate",
      "benchmarkBaselineClose",
    ]) {
      const broken = { ...BASELINE_JSON, [key]: undefined };
      expect(parseEpochBaseline(broken), `missing ${key}`).toBeNull();
    }
    expect(parseEpochBaseline({ ...BASELINE_JSON, releaseSha: "main" })).toBeNull();
    expect(parseEpochBaseline({ ...BASELINE_JSON, schemaVersion: 2 })).toBeNull();
    expect(parseEpochBaseline(null)).toBeNull();
  });

  it.each(["startSessionDate", "benchmarkBaselineDate"])(
    "rejects an impossible %s rather than rolling it forward",
    (key) => {
      // `new Date("2026-02-30")` is 2 March. Anchoring a published return to a
      // day the baseline never named is worse than having no baseline.
      const rolled = {
        ...BASELINE_JSON,
        startSessionDate: "2026-02-30",
        benchmarkBaselineDate: "2026-02-30",
        startedAt: "2026-02-30T13:30:00Z",
      };
      expect(parseEpochBaseline({ ...BASELINE_JSON, [key]: "2026-02-30" })).toBeNull();
      expect(parseEpochBaseline(rolled)).toBeNull();
      expect(parseEpochBaseline({ ...BASELINE_JSON, [key]: "2026-04-31" })).toBeNull();
    },
  );
});

describe("timeWeightedReturn", () => {
  it("matches the simple return when there are no cash flows", () => {
    const twr = timeWeightedReturn([
      { date: "2026-08-03", equity: 100 },
      { date: "2026-08-04", equity: 110 },
    ]);
    expect(twr).toBeCloseTo(0.1, 10);
  });

  it("does not count a deposit as profit", () => {
    const twr = timeWeightedReturn(
      [
        { date: "2026-08-03", equity: 100_000 },
        { date: "2026-08-04", equity: 210_000 },
      ],
      [{ date: "2026-08-04", amount: 100_000 }],
    );
    // Investment return is 10%, not 110%.
    expect(twr).toBeCloseTo(0.1, 10);
  });

  it("does not count a withdrawal as a loss", () => {
    const twr = timeWeightedReturn(
      [
        { date: "2026-08-03", equity: 200_000 },
        { date: "2026-08-04", equity: 110_000 },
      ],
      [{ date: "2026-08-04", amount: -100_000 }],
    );
    expect(twr).toBeCloseTo(0.05, 10);
  });

  it("attributes a flow dated inside a gap to the interval that ends after it", () => {
    const twr = timeWeightedReturn(
      [
        { date: "2026-08-03", equity: 100_000 },
        { date: "2026-08-06", equity: 160_000 },
      ],
      [{ date: "2026-08-05", amount: 50_000 }],
    );
    expect(twr).toBeCloseTo(0.1, 10);
  });

  it("ignores a flow dated on or before the first retained session", () => {
    const twr = timeWeightedReturn(
      [
        { date: "2026-08-03", equity: 100_000 },
        { date: "2026-08-04", equity: 110_000 },
      ],
      [{ date: "2026-08-03", amount: 100_000 }],
    );
    expect(twr).toBeCloseTo(0.1, 10);
  });

  it("returns null rather than 0 when there is nothing to measure", () => {
    expect(timeWeightedReturn([])).toBeNull();
    expect(timeWeightedReturn([{ date: "2026-08-03", equity: 1 }])).toBeNull();
    expect(
      timeWeightedReturn([
        { date: "2026-08-03", equity: 0 },
        { date: "2026-08-04", equity: 10 },
      ]),
    ).toBeNull();
  });
});

describe("alignSeries", () => {
  const portfolio = [
    { date: "2026-08-03", equity: 100 },
    { date: "2026-08-04", equity: 101 },
    { date: "2026-08-05", equity: 102 },
    { date: "2026-08-06", equity: 103 },
  ];

  it("keeps only sessions present in both series", () => {
    const aligned = alignSeries(portfolio, [
      { date: "2026-08-03", close: 700 },
      { date: "2026-08-04", close: 705 },
      { date: "2026-08-05", close: 710 },
    ]);
    expect(aligned?.dates).toEqual(["2026-08-03", "2026-08-04", "2026-08-05"]);
    expect(aligned?.endDate).toBe("2026-08-05");
  });

  it("never extends the benchmark past its last real bar", () => {
    const aligned = alignSeries(portfolio, [
      { date: "2026-08-03", close: 700 },
      { date: "2026-08-04", close: 705 },
    ]);
    expect(aligned?.endDate).toBe("2026-08-04");
    expect(aligned?.benchmark).toHaveLength(2);
  });

  it("honours the epoch start date", () => {
    const aligned = alignSeries(
      portfolio,
      [
        { date: "2026-08-03", close: 700 },
        { date: "2026-08-05", close: 710 },
        { date: "2026-08-06", close: 715 },
      ],
      "2026-08-05",
    );
    expect(aligned?.startDate).toBe("2026-08-05");
  });

  it("returns null when fewer than two sessions are shared", () => {
    expect(
      alignSeries(portfolio, [{ date: "2026-08-03", close: 700 }]),
    ).toBeNull();
    expect(
      alignSeries(portfolio, [{ date: "2020-01-02", close: 300 }]),
    ).toBeNull();
  });
});

describe("computeForwardPerformance", () => {
  const equity = [
    { date: "2026-08-03", equity: 1_000_000 },
    { date: "2026-08-04", equity: 1_010_000 },
    { date: "2026-08-05", equity: 1_020_000 },
  ];
  const benchmark = [
    { date: "2026-08-03", close: 700 },
    { date: "2026-08-04", close: 707 },
    { date: "2026-08-05", close: 714 },
  ];

  function run(overrides: Partial<Parameters<typeof computeForwardPerformance>[0]> = {}) {
    return computeForwardPerformance({
      baseline: BASELINE,
      accountId: "acc-1",
      equity,
      cashFlows: [],
      benchmark,
      ...overrides,
    });
  }

  it("computes TWR and benchmark return over the same sessions", () => {
    const result = run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const performance = result.performance;
    expect(performance.startDate).toBe("2026-08-03");
    expect(performance.endDate).toBe("2026-08-05");
    expect(performance.sessions).toBe(3);
    expect(performance.portfolioTwrPct).toBeCloseTo(2, 4);
    expect(performance.benchmarkReturnPct).toBeCloseTo(2, 4);
    expect(performance.excessReturnPct).toBeCloseTo(0, 4);
    expect(performance.series[0]).toEqual({
      date: "2026-08-03",
      portfolioIndex: 100,
      benchmarkIndex: 100,
    });
  });

  it("withholds the return rather than approximating around a deposit", () => {
    // `timeWeightedReturn` would give exactly +1% here by booking the deposit
    // at the close. That is Modified Dietz with an end-of-period assumption,
    // not time-weighted return: a deposit received at the open needs
    // `E_{t−1} + flow` as the denominator and yields a different figure.
    // Daily equity cannot distinguish the two, so the number is withheld.
    const result = run({
      equity: [
        { date: "2026-08-03", equity: 1_000_000 },
        { date: "2026-08-04", equity: 1_510_000 },
        { date: "2026-08-05", equity: 1_510_000 },
      ],
      cashFlows: [{ date: "2026-08-04", amount: 500_000 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("CASH_FLOW_TIMING_UNVERIFIABLE");
    expect(result.detail).toContain("1 external cash movement");
  });

  it("still computes exactly when the window has no external movement", () => {
    const result = run({
      equity: [
        { date: "2026-08-03", equity: 1_000_000 },
        { date: "2026-08-04", equity: 1_010_000 },
        { date: "2026-08-05", equity: 1_020_000 },
      ],
      cashFlows: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.performance.portfolioTwrPct).toBeCloseTo(2, 4);
    expect(result.performance.cashFlowCount).toBe(0);
  });

  it("refuses a cash movement dated on the baseline session", () => {
    const result = run({
      cashFlows: [{ date: "2026-08-03", amount: 10_000 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_SESSION_HAS_CASH_FLOW");
  });

  it("refuses an unusable ledger row instead of filtering it away", () => {
    for (const flow of [
      { date: "not-a-date", amount: 1 },
      { date: "2026-08-04", amount: Number.NaN },
      { date: "2026-08-04", amount: Number.POSITIVE_INFINITY },
    ]) {
      const result = run({ cashFlows: [flow] });
      expect(result.ok, JSON.stringify(flow)).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("CASH_FLOW_UNUSABLE");
    }
  });

  it("refuses a baseline that belongs to another account", () => {
    const result = run({ accountId: "acc-2" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_ACCOUNT_MISMATCH");
  });

  it("refuses when the baseline start session has no equity observation", () => {
    const result = run({ equity: equity.slice(1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_OBSERVATION_MISSING");
    expect(result.detail).toContain("2026-08-03");
  });

  it("refuses when the starting equity disagrees with the baseline", () => {
    const result = run({
      equity: [{ date: "2026-08-03", equity: 999_000 }, ...equity.slice(1)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_OBSERVATION_MISMATCH");
  });

  it("refuses when the benchmark baseline bar is absent", () => {
    const result = run({ benchmark: benchmark.slice(1) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_OBSERVATION_MISSING");
  });

  it("refuses when the benchmark baseline close disagrees", () => {
    const result = run({
      benchmark: [{ date: "2026-08-03", close: 690 }, ...benchmark.slice(1)],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_OBSERVATION_MISMATCH");
  });

  it("never silently starts at the first later shared session", () => {
    // Equity exists on the baseline day but the benchmark does not, so the
    // first shared day is later. That must fail, not quietly re-anchor.
    const result = run({
      benchmark: [
        { date: "2026-08-04", close: 707 },
        { date: "2026-08-05", close: 714 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_OBSERVATION_MISSING");
  });

  it("refuses when the two series share no window at all", () => {
    const result = run({
      benchmark: [
        { date: "2027-01-04", close: 800 },
        { date: "2027-01-05", close: 805 },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BASELINE_OBSERVATION_MISSING");
  });

  it("truncates to the last shared session instead of forward-filling", () => {
    const result = run({ benchmark: benchmark.slice(0, 2) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.performance.endDate).toBe("2026-08-04");
    expect(result.performance.sessions).toBe(2);
    expect(result.performance.endEquity).toBe(1_010_000);
  });

  it("tolerates rounding but not a real difference in the anchors", () => {
    const rounded = run({
      equity: [{ date: "2026-08-03", equity: 1_000_000.004 }, ...equity.slice(1)],
    });
    expect(rounded.ok).toBe(true);
  });
});
