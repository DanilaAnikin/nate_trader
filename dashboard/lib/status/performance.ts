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

export const BASELINE_STRATEGY_VERSION = "v11-adaptive-momentum";
export const BASELINE_BENCHMARK_SYMBOL = "SPY";

/**
 * Parse and validate a persisted epoch baseline document.
 *
 * Nothing is defaulted. A baseline that does not *state* its strategy version
 * or its benchmark is not an auditable baseline, and silently assuming V11 and
 * SPY would let an unrelated document anchor a published return. Every field
 * is required, the benchmark must be SPY, both dates must describe the same
 * session, and no date may lie in the future.
 */
export function parseEpochBaseline(
  value: unknown,
  now: Date = new Date(),
): V11EpochBaseline | null {
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
  const benchmarkSymbol = text("benchmarkSymbol");
  const benchmarkBaselineDate = text("benchmarkBaselineDate");
  const benchmarkBaselineClose = number("benchmarkBaselineClose");
  const strategyVersion = text("strategyVersion");

  if (
    raw.schemaVersion !== 1 ||
    !releaseSha ||
    !/^[0-9a-f]{40}$/.test(releaseSha) ||
    !accountId ||
    // The strategy version must be stated explicitly, never assumed.
    strategyVersion !== BASELINE_STRATEGY_VERSION ||
    // The benchmark must be stated explicitly and must be SPY.
    benchmarkSymbol !== BASELINE_BENCHMARK_SYMBOL ||
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

  // The portfolio anchor and the benchmark anchor must be the same session,
  // otherwise the two series are anchored a day apart.
  if (benchmarkBaselineDate !== startSessionDate) return null;

  // `startedAt` must fall on the session it claims, in exchange time.
  if (nySessionDate(startedAt) !== startSessionDate) return null;

  // Nothing may be dated in the future.
  const nowMs = now.getTime();
  if (Date.parse(startedAt) > nowMs) return null;
  const sessionMs = Date.parse(`${startSessionDate}T00:00:00Z`);
  if (!Number.isFinite(sessionMs) || sessionMs > nowMs) return null;

  return {
    schemaVersion: 1,
    strategyVersion,
    releaseSha,
    accountId,
    startedAt: new Date(Date.parse(startedAt)).toISOString(),
    startSessionDate,
    startingEquity,
    benchmarkSymbol,
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

export type ForwardPerformanceFailure =
  | "BASELINE_ACCOUNT_MISMATCH"
  | "BASELINE_OBSERVATION_MISSING"
  | "BASELINE_OBSERVATION_MISMATCH"
  | "BASELINE_SESSION_HAS_CASH_FLOW"
  | "CASH_FLOW_UNUSABLE"
  | "CASH_FLOW_TIMING_UNVERIFIABLE"
  | "NO_COMMON_SESSIONS"
  | "UNCOMPUTABLE";

export type ForwardPerformanceResult =
  | { ok: true; performance: ForwardPerformance }
  | { ok: false; reason: ForwardPerformanceFailure; detail: string };

/**
 * Relative tolerance for anchoring the baseline. Equity and closes are stored
 * rounded, so an exact float comparison would be brittle; anything beyond this
 * means the baseline describes a different series.
 */
const ANCHOR_RELATIVE_TOLERANCE = 1e-6;

function anchorsMatch(recorded: number, observed: number): boolean {
  if (!(recorded > 0) || !Number.isFinite(observed)) return false;
  return Math.abs(observed - recorded) <= Math.abs(recorded) * ANCHOR_RELATIVE_TOLERANCE + 0.01;
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
 * exactly shared interval.
 *
 * The baseline must genuinely anchor the calculation: the recorded start
 * session must exist in the equity series with the recorded starting equity,
 * and the recorded benchmark session must exist with the recorded close. The
 * window may not silently begin at the first later common day — that would
 * quietly measure a different period than the one the baseline claims.
 */
export function computeForwardPerformance(input: {
  baseline: V11EpochBaseline;
  accountId: string;
  equity: readonly EquityPoint[];
  cashFlows: readonly CashFlow[];
  benchmark: readonly BenchmarkBar[];
}): ForwardPerformanceResult {
  const { baseline } = input;
  if (baseline.accountId !== input.accountId) {
    return {
      ok: false,
      reason: "BASELINE_ACCOUNT_MISMATCH",
      detail:
        "The persisted V11 epoch baseline belongs to a different account than the one being measured.",
    };
  }

  const startEquityObservation = input.equity.find(
    (point) => point.date === baseline.startSessionDate,
  );
  if (!startEquityObservation) {
    return {
      ok: false,
      reason: "BASELINE_OBSERVATION_MISSING",
      detail: `No equity observation exists for the baseline start session ${baseline.startSessionDate}.`,
    };
  }
  if (!anchorsMatch(baseline.startingEquity, startEquityObservation.equity)) {
    return {
      ok: false,
      reason: "BASELINE_OBSERVATION_MISMATCH",
      detail: `Equity on ${baseline.startSessionDate} does not match the baseline starting equity.`,
    };
  }

  const benchmarkObservation = input.benchmark.find(
    (bar) => bar.date === baseline.benchmarkBaselineDate,
  );
  if (!benchmarkObservation) {
    return {
      ok: false,
      reason: "BASELINE_OBSERVATION_MISSING",
      detail: `No ${baseline.benchmarkSymbol} bar exists for the baseline session ${baseline.benchmarkBaselineDate}.`,
    };
  }
  if (
    !anchorsMatch(baseline.benchmarkBaselineClose, benchmarkObservation.close)
  ) {
    return {
      ok: false,
      reason: "BASELINE_OBSERVATION_MISMATCH",
      detail: `The ${baseline.benchmarkSymbol} close on ${baseline.benchmarkBaselineDate} does not match the baseline close.`,
    };
  }

  const aligned = alignSeries(
    input.equity,
    input.benchmark,
    baseline.startSessionDate,
  );
  if (!aligned) {
    return {
      ok: false,
      reason: "NO_COMMON_SESSIONS",
      detail:
        "The portfolio and benchmark series do not share at least two sessions since the baseline.",
    };
  }
  if (aligned.startDate !== baseline.startSessionDate) {
    return {
      ok: false,
      reason: "BASELINE_OBSERVATION_MISSING",
      detail: `The first session shared by the portfolio and the benchmark is ${aligned.startDate}, not the baseline session ${baseline.startSessionDate}.`,
    };
  }

  // A malformed ledger row is not something to filter away quietly: it means
  // the ledger cannot be trusted to be complete for this window.
  const malformed = input.cashFlows.find(
    (flow) => !ISO_DATE.test(flow.date) || !Number.isFinite(flow.amount),
  );
  if (malformed) {
    return {
      ok: false,
      reason: "CASH_FLOW_UNUSABLE",
      detail:
        "A recorded cash flow has an unusable date or amount, so external movements cannot be removed from the return.",
    };
  }

  // A flow dated on the baseline session itself is ambiguous: the recorded
  // starting equity may be the value before it or after it, and nothing in the
  // ledger says which. Folding it into the opening balance would silently pick
  // one. The safe contract is a flow-free baseline session; anything else means
  // the baseline must be re-anchored to a clean session.
  const baselineSessionFlows = input.cashFlows.filter(
    (flow) => flow.date === aligned.startDate,
  );
  if (baselineSessionFlows.length > 0) {
    return {
      ok: false,
      reason: "BASELINE_SESSION_HAS_CASH_FLOW",
      detail: `An external cash movement is dated on the baseline session ${aligned.startDate}, so the recorded starting equity cannot be read as an opening balance. Re-anchor the epoch baseline to a completed, flow-free session.`,
    };
  }

  const relevantFlows = input.cashFlows.filter(
    (flow) => flow.date > aligned.startDate && flow.date <= aligned.endDate,
  );

  // Daily equity is the only valuation available. With no external flow inside
  // the window, chaining daily returns *is* exact time-weighted return.
  //
  // With a flow, it is not. `(E_t − flow) / E_{t−1}` places every movement at
  // the end of its session; a morning deposit would need `E_{t−1} + flow` as
  // the denominator instead. Without a valuation at the moment of the flow the
  // two cannot be told apart, and the difference is real money. Reporting
  // either as "cash-flow-adjusted TWR" would be presenting an approximation as
  // an exact figure, so the number is withheld until intraday valuation
  // evidence exists.
  if (relevantFlows.length > 0) {
    return {
      ok: false,
      reason: "CASH_FLOW_TIMING_UNVERIFIABLE",
      detail: `${relevantFlows.length} external cash movement(s) fall inside the measured window, and no portfolio valuation exists at the moment of each. An exact time-weighted return cannot be evidenced, and an end-of-day approximation must not be presented as one.`,
    };
  }

  const portfolioTwr = timeWeightedReturn(aligned.portfolio, relevantFlows);
  if (portfolioTwr === null) {
    return {
      ok: false,
      reason: "UNCOMPUTABLE",
      detail: "The equity series contains a non-positive value, so no return can be computed.",
    };
  }

  const benchmarkStart = aligned.benchmark[0].close;
  const benchmarkEnd = aligned.benchmark[aligned.benchmark.length - 1].close;
  if (!(benchmarkStart > 0)) {
    return {
      ok: false,
      reason: "UNCOMPUTABLE",
      detail: "The benchmark baseline close is not usable.",
    };
  }
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
    ok: true,
    performance: {
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
      benchmarkSymbol: baseline.benchmarkSymbol,
      series,
    },
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
