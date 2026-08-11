import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { refreshBrokerDatasets } from "@/lib/accounts/broker-refresh";
import { readAccountHistory } from "@/lib/accounts/history";
import {
  authorizeProductionRuntime,
  readProductionAuthzConfig,
} from "@/lib/status/authz";
import {
  fetchBenchmarkBars,
  fetchBrokerSnapshot,
  loadCredentials,
} from "@/lib/status/broker";
import {
  computeForwardPerformance,
  type CashFlow,
  type EquityPoint,
  type ForwardPerformance,
} from "@/lib/status/performance";
import { getApprovedReleaseSha, getEpochBaseline } from "@/lib/status/read-model";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

export type PerformanceUnavailableReason =
  | "NOT_PRODUCTION_VIEWER"
  | "APPROVED_RELEASE_UNKNOWN"
  | "NO_BASELINE"
  | "BASELINE_RELEASE_MISMATCH"
  | "BASELINE_STRATEGY_MISMATCH"
  | "BASELINE_ACCOUNT_MISMATCH"
  | "BASELINE_OBSERVATION_MISSING"
  | "BASELINE_OBSERVATION_MISMATCH"
  | "NO_CREDENTIALS"
  | "EQUITY_REFRESH_FAILED"
  | "EQUITY_QUERY_FAILED"
  | "CASH_FLOW_REFRESH_FAILED"
  | "CASH_FLOW_QUERY_FAILED"
  | "HISTORY_TOO_LARGE"
  | "HISTORY_UNUSABLE"
  | "REFRESH_SUPERSEDED"
  | "CASH_FLOW_INCOMPLETE"
  | "CASH_FLOW_UNUSABLE"
  | "CASH_FLOW_TIMING_UNVERIFIABLE"
  | "BASELINE_SESSION_HAS_CASH_FLOW"
  | "NON_CASH_EXTERNAL_TRANSFER"
  | "FUTURE_DATED"
  | "NO_EQUITY_HISTORY"
  | "NO_BENCHMARK_HISTORY"
  | "NO_COMMON_SESSIONS"
  | "UNCOMPUTABLE";

export interface PerformanceProvenance {
  readonly source: string;
  readonly scope: string;
  /** Last session both series actually share — the age of the number shown. */
  readonly asOf: string | null;
  readonly freshness:
    | "CURRENT"
    | "STALE"
    | "EXPIRED"
    | "MISMATCH"
    | "UNAVAILABLE"
    | "NOT_APPLICABLE";
}

/**
 * Performance ages with the market, not with the request. A result whose last
 * shared session is old is STALE, and well past that it is EXPIRED.
 */
const STALE_AFTER_DAYS = 5;
const EXPIRED_AFTER_DAYS = 21;

/**
 * The only allowance for a session dated ahead of "now".
 *
 * Sessions are market-time calendar days, so the comparison is made against the
 * current America/New_York date — the timezone offset needs no tolerance. What
 * remains is ordinary clock skew between this server and whatever produced the
 * data, and five minutes covers it. Anything beyond that is a future-dated
 * session: broken data, never fresh data.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

export function classifyPerformanceAge(
  endSessionDate: string,
  now: Date,
): "CURRENT" | "STALE" | "EXPIRED" | "MISMATCH" {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endSessionDate)) return "MISMATCH";
  const end = Date.parse(`${endSessionDate}T00:00:00Z`);
  if (!Number.isFinite(end)) return "MISMATCH";

  // A session cannot be dated after today's market date. The old check allowed
  // a whole day of slack to absorb the UTC/ET offset, which meant a genuinely
  // future-dated session could still be reported as CURRENT.
  const latestAllowed = ET_DATE.format(
    new Date(now.getTime() + CLOCK_SKEW_TOLERANCE_MS),
  );
  if (endSessionDate > latestAllowed) return "MISMATCH";

  const ageDays = (now.getTime() - end) / (24 * 60 * 60 * 1000);
  if (ageDays > EXPIRED_AFTER_DAYS) return "EXPIRED";
  if (ageDays > STALE_AFTER_DAYS) return "STALE";
  return "CURRENT";
}

export interface PerformanceResponse {
  readonly accountId: string;
  readonly refreshedAt: string;
  /**
   * The root status mirrors the provenance freshness exactly.
   *
   * It used to be `CURRENT` whenever a number could be computed at all, so a
   * three-week-old result was labelled current at the top of the response while
   * only the nested provenance said EXPIRED. A stale number presented as a
   * current one is the failure mode this vocabulary exists to prevent.
   */
  readonly status: "CURRENT" | "STALE" | "EXPIRED" | "UNAVAILABLE";
  readonly reason: PerformanceUnavailableReason | null;
  readonly detail: string | null;
  readonly baseline: {
    readonly releaseSha: string;
    readonly startedAt: string;
    readonly startSessionDate: string;
    readonly startingEquity: number;
    readonly benchmarkSymbol: string;
    readonly benchmarkBaselineDate: string;
    readonly benchmarkBaselineClose: number;
    readonly note: string | null;
  } | null;
  readonly performance: ForwardPerformance | null;
  readonly provenance: PerformanceProvenance;
}

function respond(
  accountId: string,
  reason: PerformanceUnavailableReason,
  detail: string,
  baseline: PerformanceResponse["baseline"] = null,
  freshness: PerformanceProvenance["freshness"] = "UNAVAILABLE",
): NextResponse {

  const body: PerformanceResponse = {
    accountId,
    refreshedAt: new Date().toISOString(),
    status: "UNAVAILABLE",
    reason,
    detail,
    baseline,
    performance: null,
    provenance: {
      source: "Supabase equity mirror + Alpaca activities + Alpaca daily bars",
      scope: `account ${accountId}`,
      asOf: null,
      freshness,
    },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/accounts/[id]/performance — cash-flow-adjusted V11 forward
 * performance for the production account.
 *
 * Strictly fail-closed. Every one of these returns `UNAVAILABLE` with a named
 * reason rather than a number: a non-production viewer, an unknown approved
 * release, a baseline bound to a different release, strategy, or account, a
 * baseline whose recorded observations are absent or disagree, an equity or
 * cash-flow refresh or query error, an incomplete activity walk, or a window
 * the two series do not genuinely share. Pre-V11 account history is never
 * relabelled as V11 performance.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const account = await loadOwnedAccount(user.id, id);
  if (!account) {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const svc = getSupabaseService();
  const credentials = await loadCredentials(svc, id);
  if (!credentials) {
    return respond(
      id,
      "NO_CREDENTIALS",
      "This account has no stored Alpaca credentials, so neither its equity mirror nor the benchmark can be refreshed.",
    );
  }

  // Forward V11 performance is a production fact. Authorize before doing any
  // work, using a freshly read broker account number when one is configured.
  const brokerProbe = await fetchBrokerSnapshot(credentials, account.mode);
  const authorization = authorizeProductionRuntime({
    viewerUserId: user.id,
    accountId: id,
    accountOwnerId: account.owner_id,
    mode: account.mode,
    liveBrokerAccountNumber: brokerProbe.ok ? brokerProbe.accountNumber : null,
    config: readProductionAuthzConfig(),
  });
  if (!authorization.authorized) {
    return respond(
      id,
      "NOT_PRODUCTION_VIEWER",
      `${authorization.detail} V11 forward performance is only reported for the production account.`,
      null,
      "NOT_APPLICABLE",
    );
  }

  const approved = await getApprovedReleaseSha();
  if (!approved.sha || !approved.authoritative) {
    return respond(
      id,
      "APPROVED_RELEASE_UNKNOWN",
      "The approved paper release could not be read from an authoritative source, so no baseline can be bound to it.",
    );
  }

  const baseline = await getEpochBaseline(approved.sha);
  if (!baseline) {
    return respond(
      id,
      "NO_BASELINE",
      "No auditable V11 forward-validation epoch baseline is persisted. Account history that predates the V11 cutover must not be presented as V11 performance.",
    );
  }

  const baselineDto: PerformanceResponse["baseline"] = {
    releaseSha: baseline.releaseSha,
    startedAt: baseline.startedAt,
    startSessionDate: baseline.startSessionDate,
    startingEquity: baseline.startingEquity,
    benchmarkSymbol: baseline.benchmarkSymbol,
    benchmarkBaselineDate: baseline.benchmarkBaselineDate,
    benchmarkBaselineClose: baseline.benchmarkBaselineClose,
    note: baseline.note,
  };

  if (baseline.releaseSha !== approved.sha) {
    return respond(
      id,
      "BASELINE_RELEASE_MISMATCH",
      "The persisted epoch baseline was recorded for a different approved release than the one currently in force.",
      baselineDto,
    );
  }
  if (baseline.strategyVersion !== "v11-adaptive-momentum") {
    return respond(
      id,
      "BASELINE_STRATEGY_MISMATCH",
      "The persisted epoch baseline is not a V11 baseline.",
      baselineDto,
    );
  }
  if (baseline.accountId !== id) {
    return respond(
      id,
      "BASELINE_ACCOUNT_MISMATCH",
      "The persisted V11 epoch baseline belongs to a different account.",
      baselineDto,
    );
  }

  // Both broker datasets are fetched, fully validated, and published as one
  // generation. Any failure writes nothing and produces a named UNAVAILABLE —
  // never a number with a warning attached.
  const refresh = await refreshBrokerDatasets(svc, id, account.owner_id, account.mode, {
    flowsFrom: baseline.startedAt,
  });
  if (!refresh.ok) {
    const reason: PerformanceUnavailableReason =
      refresh.reason === "NON_CASH_EXTERNAL_TRANSFER"
        ? "NON_CASH_EXTERNAL_TRANSFER"
        : refresh.reason === "CASH_FLOW_INCOMPLETE"
          ? "CASH_FLOW_INCOMPLETE"
          : refresh.reason === "NO_CREDENTIALS"
            ? "NO_CREDENTIALS"
            : refresh.reason === "STALE_GENERATION"
              ? "REFRESH_SUPERSEDED"
              : "EQUITY_REFRESH_FAILED";
    return respond(id, reason, refresh.detail, baselineDto);
  }
  const latestActivityAt = refresh.latestActivityAt;

  // A broker activity stamped in the future means the feed disagrees with
  // reality; that is a mismatch, not fresh data. The allowance is the same
  // five minutes of clock skew used everywhere else — a whole day of slack
  // let a feed seven hours ahead pass as ordinary.
  if (latestActivityAt !== null) {
    const stamp = Date.parse(latestActivityAt);
    if (Number.isFinite(stamp) && stamp - Date.now() > CLOCK_SKEW_TOLERANCE_MS) {
      return respond(
        id,
        "FUTURE_DATED",
        "An Alpaca cash activity is dated in the future, so the cash-flow history cannot be trusted.",
        baselineDto,
        "MISMATCH",
      );
    }
  }

  // One request, one database snapshot, both datasets. A page walk cannot give
  // this: several requests are several MVCC snapshots, and an UPDATE to a row
  // already read leaves the count unchanged, repeats no key and skips nothing
  // — so a torn read passes every client-side consistency check there is.
  const historyResult = await readAccountHistory(
    svc,
    id,
    account.owner_id,
    baseline.startSessionDate,
  );
  if (!historyResult.ok) {
    return respond(
      id,
      historyResult.reason === "HISTORY_TOO_LARGE"
        ? "HISTORY_TOO_LARGE"
        : historyResult.reason === "MALFORMED_SNAPSHOT"
          ? "HISTORY_UNUSABLE"
          : "EQUITY_QUERY_FAILED",
      `${historyResult.detail} No return can be reported.`,
      baselineDto,
    );
  }
  const history = historyResult.history;

  const equity: EquityPoint[] = history.equity.map((row) => ({
    date: row.date,
    equity: row.equity,
  }));
  if (equity.length < 2) {
    return respond(
      id,
      "NO_EQUITY_HISTORY",
      "Fewer than two equity observations exist since the V11 epoch baseline.",
      baselineDto,
    );
  }

  const cashFlows: CashFlow[] = history.cashFlows.map((row) => ({
    date: row.date,
    amount: row.amount,
  }));

  const bars = await fetchBenchmarkBars(
    credentials,
    baseline.benchmarkSymbol,
    baseline.startSessionDate,
  );
  if (!bars || bars.length < 2) {
    return respond(
      id,
      "NO_BENCHMARK_HISTORY",
      `Benchmark (${baseline.benchmarkSymbol}) daily history could not be loaded for the epoch window.`,
      baselineDto,
    );
  }

  const result = computeForwardPerformance({
    baseline,
    accountId: id,
    equity,
    cashFlows,
    benchmark: bars,
  });
  if (!result.ok) {
    return respond(id, result.reason, result.detail, baselineDto);
  }

  const now = new Date();
  const freshness = classifyPerformanceAge(result.performance.endDate, now);
  if (freshness === "MISMATCH") {
    return respond(
      id,
      "FUTURE_DATED",
      `The last shared session (${result.performance.endDate}) is not a usable past session.`,
      baselineDto,
      "MISMATCH",
    );
  }

  const body: PerformanceResponse = {
    accountId: id,
    refreshedAt: now.toISOString(),
    status: freshness,
    reason: null,
    detail:
      freshness === "CURRENT"
        ? null
        : `The most recent session shared by the account and the benchmark is ${result.performance.endDate}. These figures are ${freshness.toLowerCase()} and must not be read as today's performance.`,
    baseline: baselineDto,
    performance: result.performance,
    provenance: {
      source: "Supabase equity mirror + Alpaca activities + Alpaca daily bars",
      scope: `account ${id} · V11 epoch from ${baseline.startSessionDate}`,
      // Age is the market age of the last shared session, not request time.
      asOf: result.performance.endDate,
      freshness,
    },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
