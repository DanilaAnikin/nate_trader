/**
 * Forward paper-validation performance math.
 *
 * Rules this module enforces, because getting them wrong fabricates alpha:
 *
 *  - a deposit is not profit and a withdrawal is not a loss (cash-flow
 *    adjusted time-weighted return);
 *  - the portfolio and the benchmark must cover exactly the same sessions;
 *  - the benchmark is never forward-filled past its last real session;
 *  - session dates are America/New_York, matching Alpaca's daily buckets;
 *  - anything that cannot be aligned is `UNAVAILABLE`, never zero.
 */

export interface EquityPoint {
  readonly date: string;
  readonly equity: number;
}

export interface CashFlow {
  readonly date: string;
  readonly amount: number;
}

export interface BenchmarkBar {
  readonly date: string;
  readonly close: number;
}

/** Persisted, auditable start of the V11 forward-validation epoch. */
export interface V11EpochBaseline {
  readonly schemaVersion: 1;
  readonly strategyVersion: string;
  /** Approved paper release in force when the epoch started. */
  readonly releaseSha: string;
  /** Supabase account this baseline belongs to. */
  readonly accountId: string;
  readonly startedAt: string;
  /** America/New_York session date of the first V11 observation. */
  readonly startSessionDate: string;
  readonly startingEquity: number;
  readonly benchmarkSymbol: string;
  readonly benchmarkBaselineDate: string;
  readonly benchmarkBaselineClose: number;
  readonly note: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Format an instant as its America/New_York calendar (session) date. */
export function nySessionDate(instant: Date | string | number): string {
  const date =
    instant instanceof Date
      ? instant
      : new Date(typeof instant === "string" ? Date.parse(instant) : instant);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(date);
}

/** Parse and validate a persisted epoch baseline document. */
export function parseEpochBaseline(value: unknown): V11EpochBaseline | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof raw[key] === "string" && (raw[key] as string).trim() !== ""
      ? (raw[key] as string).trim()
      : null;
  const number = (key: string): number | null =>
    typeof raw[key] === "number" && Number.isFinite(raw[key] as number)
      ? (raw[key] as number)
      : null;

  const releaseSha = text("releaseSha");
  const accountId = text("accountId");
  const startedAt = text("startedAt");
  const startSessionDate = text("startSessionDate");
  const startingEquity = number("startingEquity");
  const benchmarkBaselineDate = text("benchmarkBaselineDate");
  const benchmarkBaselineClose = number("benchmarkBaselineClose");

  if (
    raw.schemaVersion !== 1 ||
    !releaseSha ||
    !/^[0-9a-f]{40}$/.test(releaseSha) ||
    !accountId ||
    !startedAt ||
    !Number.isFinite(Date.parse(startedAt)) ||
    !startSessionDate ||
    !ISO_DATE.test(startSessionDate) ||
    startingEquity === null ||
    startingEquity <= 0 ||
    !benchmarkBaselineDate ||
    !ISO_DATE.test(benchmarkBaselineDate) ||
    benchmarkBaselineClose === null ||
    benchmarkBaselineClose <= 0
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    strategyVersion: text("strategyVersion") ?? "v11-adaptive-momentum",
    releaseSha,
    accountId,
    startedAt: new Date(Date.parse(startedAt)).toISOString(),
    startSessionDate,
    startingEquity,
    benchmarkSymbol: text("benchmarkSymbol") ?? "SPY",
    benchmarkBaselineDate,
    benchmarkBaselineClose,
    note: text("note"),
  };
}

/**
 * Time-weighted return over an ordered equity series.
 *
 * `flows` is the net external cash movement (+ deposit / − withdrawal). A flow
 * dated inside a gap between two retained sessions is attributed to the
 * interval that ends on the later retained session, so aligning the series to
 * a benchmark cannot silently drop a deposit.
 */
export function timeWeightedReturn(
  points: readonly EquityPoint[],
  flows: readonly CashFlow[] = [],
): number | null {
  if (points.length < 2) return null;
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  let factor = 1;
  let flowIndex = 0;
  // Flows dated on or before the first retained session belong to the opening
  // balance, not to any measured interval.
  while (flowIndex < sorted.length && sorted[flowIndex].date <= points[0].date) {
    flowIndex++;
  }
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1].equity;
    if (!(previous > 0)) return null;
    let intervalFlow = 0;
    while (flowIndex < sorted.length && sorted[flowIndex].date <= points[i].date) {
      intervalFlow += sorted[flowIndex].amount;
      flowIndex++;
    }
    factor *= (points[i].equity - intervalFlow) / previous;
  }
  return factor - 1;
}

export interface AlignedSeries {
  readonly dates: readonly string[];
  readonly portfolio: readonly EquityPoint[];
  readonly benchmark: readonly BenchmarkBar[];
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * Restrict both series to the sessions they genuinely share.
 *
 * Returns null when fewer than two common sessions exist — that is an honest
 * `UNAVAILABLE`, not a zero return. The benchmark is never extended past its
 * last real bar and the portfolio is never extended past its last snapshot.
 */
export function alignSeries(
  portfolio: readonly EquityPoint[],
  benchmark: readonly BenchmarkBar[],
  startSessionDate?: string,
): AlignedSeries | null {
  const from = startSessionDate ?? "";
  const portfolioByDate = new Map<string, number>();
  for (const point of portfolio) {
    if (!ISO_DATE.test(point.date) || !(point.equity > 0)) continue;
    if (point.date < from) continue;
    portfolioByDate.set(point.date, point.equity);
  }
  const benchmarkByDate = new Map<string, number>();
  for (const bar of benchmark) {
    if (!ISO_DATE.test(bar.date) || !(bar.close > 0)) continue;
    if (bar.date < from) continue;
    benchmarkByDate.set(bar.date, bar.close);
  }

  const dates = [...portfolioByDate.keys()]
    .filter((date) => benchmarkByDate.has(date))
    .sort();
  if (dates.length < 2) return null;

  return {
    dates,
    portfolio: dates.map((date) => ({
      date,
      equity: portfolioByDate.get(date) as number,
    })),
    benchmark: dates.map((date) => ({
      date,
      close: benchmarkByDate.get(date) as number,
    })),
    startDate: dates[0],
    endDate: dates[dates.length - 1],
  };
}

export interface ForwardPerformance {
  readonly startDate: string;
  readonly endDate: string;
  readonly sessions: number;
  readonly startEquity: number;
  readonly endEquity: number;
  readonly portfolioTwrPct: number;
  readonly benchmarkReturnPct: number;
  readonly excessReturnPct: number;
  readonly netCashFlow: number;
  readonly cashFlowCount: number;
  readonly benchmarkSymbol: string;
  readonly series: readonly {
    date: string;
    portfolioIndex: number;
    benchmarkIndex: number;
  }[];
}

/**
 * Compute cash-flow-adjusted forward performance against a benchmark over one
 * exactly shared interval. `null` means the comparison could not be made
 * honestly and the UI must render `UNAVAILABLE`.
 */
export function computeForwardPerformance(input: {
  baseline: V11EpochBaseline;
  accountId: string;
  equity: readonly EquityPoint[];
  cashFlows: readonly CashFlow[];
  benchmark: readonly BenchmarkBar[];
}): ForwardPerformance | null {
  if (input.baseline.accountId !== input.accountId) return null;
  const aligned = alignSeries(
    input.equity,
    input.benchmark,
    input.baseline.startSessionDate,
  );
  if (!aligned) return null;

  const relevantFlows = input.cashFlows.filter(
    (flow) =>
      ISO_DATE.test(flow.date) &&
      Number.isFinite(flow.amount) &&
      flow.date > aligned.startDate &&
      flow.date <= aligned.endDate,
  );
  const portfolioTwr = timeWeightedReturn(aligned.portfolio, relevantFlows);
  if (portfolioTwr === null) return null;

  const benchmarkStart = aligned.benchmark[0].close;
  const benchmarkEnd = aligned.benchmark[aligned.benchmark.length - 1].close;
  if (!(benchmarkStart > 0)) return null;
  const benchmarkReturn = benchmarkEnd / benchmarkStart - 1;

  // Index both lines from 100 at the shared start so the chart cannot imply a
  // comparison over different windows.
  let cumulative = 1;
  const series = aligned.dates.map((date, index) => {
    if (index > 0) {
      const previous = aligned.portfolio[index - 1].equity;
      const flow = relevantFlows
        .filter(
          (entry) =>
            entry.date > aligned.dates[index - 1] && entry.date <= date,
        )
        .reduce((total, entry) => total + entry.amount, 0);
      cumulative *= (aligned.portfolio[index].equity - flow) / previous;
    }
    return {
      date,
      portfolioIndex: round(cumulative * 100, 4),
      benchmarkIndex: round((aligned.benchmark[index].close / benchmarkStart) * 100, 4),
    };
  });

  return {
    startDate: aligned.startDate,
    endDate: aligned.endDate,
    sessions: aligned.dates.length,
    startEquity: aligned.portfolio[0].equity,
    endEquity: aligned.portfolio[aligned.portfolio.length - 1].equity,
    portfolioTwrPct: round(portfolioTwr * 100, 4),
    benchmarkReturnPct: round(benchmarkReturn * 100, 4),
    excessReturnPct: round((portfolioTwr - benchmarkReturn) * 100, 4),
    netCashFlow: round(
      relevantFlows.reduce((total, flow) => total + flow.amount, 0),
      2,
    ),
    cashFlowCount: relevantFlows.length,
    benchmarkSymbol: input.baseline.benchmarkSymbol,
    series,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
