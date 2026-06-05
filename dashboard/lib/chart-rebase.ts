import type { DailyHistory } from "@/lib/types";

/**
 * Pure rebasing math for the "Historical Performance vs S&P 500" chart,
 * extracted from the component so it can be unit-tested. Keeping this in one
 * place is what guards the bugs we hit before: anchor selection, the
 * SPY↔portfolio date alignment, and the start/end edge rows.
 */

export type Range = "1W" | "1M" | "1Y" | "YTD" | "ALL_PORTFOLIO" | "FROM_2020";

export interface SpyBar {
  date: string;
  close: number;
}

export interface ChartRow {
  date: string;
  spy: number;
  portfolio: number | null;
}

export interface RebaseResult {
  chartRows: ChartRow[];
  anchorEquity: number;
  anchorDate: string;
  portfolioStartDate: string;
  filterStart: string;
  spyReturn: number;
  portfolioReturn: number;
  showStartLine: boolean;
}

export const EMPTY_REBASE: RebaseResult = {
  chartRows: [],
  anchorEquity: 0,
  anchorDate: "",
  portfolioStartDate: "",
  filterStart: "",
  spyReturn: 0,
  portfolioReturn: 0,
  showStartLine: false,
};

/**
 * Resolve the filter's starting ISO date relative to a reference "today"
 * (the last SPY bar's date, so filters align with actual data regardless of
 * the viewer's timezone).
 */
export function computeFilterStart(
  range: Range,
  referenceDate: string,
  portfolioStart: string,
): string {
  if (range === "ALL_PORTFOLIO") return portfolioStart;
  if (range === "FROM_2020") return "2020-01-01";
  if (range === "YTD") return `${referenceDate.slice(0, 4)}-01-01`;

  const d = new Date(referenceDate + "T00:00:00Z");
  if (range === "1W") d.setUTCDate(d.getUTCDate() - 7);
  else if (range === "1M") d.setUTCDate(d.getUTCDate() - 30);
  else if (range === "1Y") d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().split("T")[0];
}

/**
 * Build the rebased comparison series. SPY is scaled so it equals the
 * portfolio's equity at the effective anchor (max of filterStart and the
 * portfolio's first day); both lines then diverge to show alpha.
 */
export function rebaseComparison(
  spyData: SpyBar[] | null,
  portfolioHistory: DailyHistory[] | null,
  range: Range,
): RebaseResult {
  if (
    !spyData ||
    spyData.length === 0 ||
    !portfolioHistory ||
    portfolioHistory.length === 0
  ) {
    return EMPTY_REBASE;
  }

  const portfolioStart = portfolioHistory[0].date;
  const lastSpyDate = spyData[spyData.length - 1].date;
  const filterStart = computeFilterStart(range, lastSpyDate, portfolioStart);

  // Effective anchor = later of (filterStart, portfolioStart)
  const effectiveAnchorDate =
    filterStart > portfolioStart ? filterStart : portfolioStart;

  // First SPY bar ≥ anchor (data may skip weekends/holidays)
  const spyAtAnchor = spyData.find((b) => b.date >= effectiveAnchorDate);
  if (!spyAtAnchor) return EMPTY_REBASE;

  // Anchor value: prefer exact portfolio entry, else first entry on/after
  const portfolioMap = new Map(portfolioHistory.map((p) => [p.date, p.equity]));
  let anchorValue = portfolioMap.get(effectiveAnchorDate);
  if (anchorValue === undefined) {
    const entry = portfolioHistory.find((p) => p.date >= effectiveAnchorDate);
    anchorValue = entry?.equity ?? portfolioHistory[0].equity;
  }
  if (anchorValue <= 0) return EMPTY_REBASE;

  const scale = anchorValue / spyAtAnchor.close;

  // Filter SPY to ≥ filterStart, attach portfolio per date
  const rows: ChartRow[] = spyData
    .filter((b) => b.date >= filterStart)
    .map((b) => ({
      date: b.date,
      spy: b.close * scale,
      portfolio: portfolioMap.get(b.date) ?? null,
    }));

  // Make sure the anchor row carries portfolio = anchorValue so the two lines
  // visually coincide there even across weekend boundaries.
  const anchorIdx = rows.findIndex((r) => r.date === spyAtAnchor.date);
  if (anchorIdx >= 0 && spyAtAnchor.date === effectiveAnchorDate) {
    if (rows[anchorIdx].portfolio === null) {
      rows[anchorIdx].portfolio = anchorValue;
    }
  }

  // Carry the last known portfolio value to the most recent SPY bar so the
  // blue line ends at the right place even if today's entry isn't written yet.
  const lastPortfolio = portfolioHistory[portfolioHistory.length - 1];
  if (lastPortfolio && rows.length > 0) {
    const lastPortfolioRowIdx = rows.findIndex(
      (r) => r.date === lastPortfolio.date,
    );
    if (lastPortfolioRowIdx >= 0 && lastPortfolioRowIdx < rows.length - 1) {
      rows[rows.length - 1].portfolio = lastPortfolio.equity;
    }
  }

  // If the portfolio has a more recent point than the last SPY bar (today,
  // before SPY history caught up), extend so the blue line reaches its end.
  if (
    lastPortfolio &&
    rows.length > 0 &&
    lastPortfolio.date > rows[rows.length - 1].date
  ) {
    rows.push({
      date: lastPortfolio.date,
      spy: rows[rows.length - 1].spy,
      portfolio: lastPortfolio.equity,
    });
  }

  const lastSpyValue = rows[rows.length - 1]?.spy ?? anchorValue;
  const lastPortValue = lastPortfolio?.equity ?? anchorValue;
  const spyReturn = ((lastSpyValue - anchorValue) / anchorValue) * 100;
  const portfolioReturn = ((lastPortValue - anchorValue) / anchorValue) * 100;

  // "Portfolio Start" line only when that date is strictly inside the view.
  const showStartLine =
    portfolioStart > filterStart &&
    rows.length > 0 &&
    portfolioStart <= rows[rows.length - 1].date;

  return {
    chartRows: rows,
    anchorEquity: anchorValue,
    anchorDate: effectiveAnchorDate,
    portfolioStartDate: portfolioStart,
    filterStart,
    spyReturn,
    portfolioReturn,
    showStartLine,
  };
}
