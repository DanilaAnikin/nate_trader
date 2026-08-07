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

  it("computes TWR and benchmark return over the same sessions", () => {
    const result = computeForwardPerformance({
      baseline: BASELINE,
      accountId: "acc-1",
      equity,
      cashFlows: [],
      benchmark,
    });
    expect(result?.startDate).toBe("2026-08-03");
    expect(result?.endDate).toBe("2026-08-05");
    expect(result?.sessions).toBe(3);
    expect(result?.portfolioTwrPct).toBeCloseTo(2, 4);
    expect(result?.benchmarkReturnPct).toBeCloseTo(2, 4);
    expect(result?.excessReturnPct).toBeCloseTo(0, 4);
    expect(result?.series[0]).toEqual({
      date: "2026-08-03",
      portfolioIndex: 100,
      benchmarkIndex: 100,
    });
  });

  it("removes a deposit from the reported return", () => {
    const result = computeForwardPerformance({
      baseline: BASELINE,
      accountId: "acc-1",
      equity: [
        { date: "2026-08-03", equity: 1_000_000 },
        { date: "2026-08-04", equity: 1_510_000 },
        { date: "2026-08-05", equity: 1_510_000 },
      ],
      cashFlows: [{ date: "2026-08-04", amount: 500_000 }],
      benchmark,
    });
    expect(result?.portfolioTwrPct).toBeCloseTo(1, 4);
    expect(result?.netCashFlow).toBe(500_000);
    expect(result?.cashFlowCount).toBe(1);
  });

  it("refuses to measure a baseline that belongs to another account", () => {
    expect(
      computeForwardPerformance({
        baseline: BASELINE,
        accountId: "acc-2",
        equity,
        cashFlows: [],
        benchmark,
      }),
    ).toBeNull();
  });

  it("refuses to measure when the two series share no window", () => {
    expect(
      computeForwardPerformance({
        baseline: BASELINE,
        accountId: "acc-1",
        equity,
        cashFlows: [],
        benchmark: [
          { date: "2027-01-04", close: 800 },
          { date: "2027-01-05", close: 805 },
        ],
      }),
    ).toBeNull();
  });

  it("truncates to the last shared session instead of forward-filling", () => {
    const result = computeForwardPerformance({
      baseline: BASELINE,
      accountId: "acc-1",
      equity,
      cashFlows: [],
      benchmark: benchmark.slice(0, 2),
    });
    expect(result?.endDate).toBe("2026-08-04");
    expect(result?.sessions).toBe(2);
    expect(result?.endEquity).toBe(1_010_000);
  });
});
