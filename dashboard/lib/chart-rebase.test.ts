import { describe, it, expect } from "vitest";
import {
  computeFilterStart,
  rebaseComparison,
  EMPTY_REBASE,
  type SpyBar,
} from "./chart-rebase";
import type { DailyHistory } from "./types";

const dh = (date: string, equity: number): DailyHistory => ({
  date,
  equity,
  pnl: 0,
  pnl_pct: 0,
  cash: 0,
  num_positions: 0,
});
const bar = (date: string, close: number): SpyBar => ({ date, close });

describe("computeFilterStart", () => {
  it("ALL_PORTFOLIO returns the portfolio start", () => {
    expect(computeFilterStart("ALL_PORTFOLIO", "2026-06-01", "2026-04-24")).toBe(
      "2026-04-24",
    );
  });
  it("FROM_2020 is fixed", () => {
    expect(computeFilterStart("FROM_2020", "2026-06-01", "2026-04-24")).toBe(
      "2020-01-01",
    );
  });
  it("YTD is Jan 1 of the reference year", () => {
    expect(computeFilterStart("YTD", "2026-06-01", "2026-04-24")).toBe(
      "2026-01-01",
    );
  });
  it("1W is seven days before the reference", () => {
    expect(computeFilterStart("1W", "2026-06-08", "2026-01-01")).toBe(
      "2026-06-01",
    );
  });
});

describe("rebaseComparison", () => {
  it("returns the empty result when data is missing", () => {
    expect(rebaseComparison(null, null, "ALL_PORTFOLIO")).toEqual(EMPTY_REBASE);
    expect(rebaseComparison([], [dh("2026-04-24", 1000)], "ALL_PORTFOLIO")).toEqual(
      EMPTY_REBASE,
    );
  });

  it("rebases SPY to the anchor equity so both lines start together", () => {
    const spy = [bar("2026-04-24", 500), bar("2026-04-25", 550)];
    const port = [dh("2026-04-24", 1000), dh("2026-04-25", 1100)];
    const r = rebaseComparison(spy, port, "ALL_PORTFOLIO");
    expect(r.anchorEquity).toBe(1000);
    expect(r.anchorDate).toBe("2026-04-24");
    // scale = 1000 / 500 = 2
    expect(r.chartRows[0].spy).toBeCloseTo(1000);
    expect(r.chartRows[0].portfolio).toBe(1000);
    expect(r.chartRows[1].spy).toBeCloseTo(1100);
    expect(r.spyReturn).toBeCloseTo(10);
    expect(r.portfolioReturn).toBeCloseTo(10);
  });

  it("shows positive alpha when the portfolio outperforms SPY", () => {
    const spy = [bar("2026-04-24", 100), bar("2026-04-25", 110)]; // +10%
    const port = [dh("2026-04-24", 1000), dh("2026-04-25", 1200)]; // +20%
    const r = rebaseComparison(spy, port, "ALL_PORTFOLIO");
    expect(r.spyReturn).toBeCloseTo(10);
    expect(r.portfolioReturn).toBeCloseTo(20);
  });

  it("attaches a portfolio value to every SPY trading date (no gaps)", () => {
    const spy = [
      bar("2026-04-24", 100),
      bar("2026-04-27", 101),
      bar("2026-04-28", 102),
    ];
    const port = [
      dh("2026-04-24", 1000),
      dh("2026-04-27", 1010),
      dh("2026-04-28", 1020),
    ];
    const r = rebaseComparison(spy, port, "ALL_PORTFOLIO");
    expect(r.chartRows).toHaveLength(3);
    expect(r.chartRows.every((row) => row.portfolio !== null)).toBe(true);
  });

  it("extends the line to a portfolio point newer than the last SPY bar", () => {
    const spy = [bar("2026-04-24", 100), bar("2026-04-27", 110)];
    const port = [
      dh("2026-04-24", 1000),
      dh("2026-04-27", 1100),
      dh("2026-04-28", 1150), // newer than last SPY bar
    ];
    const r = rebaseComparison(spy, port, "ALL_PORTFOLIO");
    const last = r.chartRows[r.chartRows.length - 1];
    expect(last.date).toBe("2026-04-28");
    expect(last.portfolio).toBe(1150);
  });
});
