import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { backfillCashFlows, backfillEquity } from "@/lib/accounts/equity-backfill";
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
  | "CASH_FLOW_INCOMPLETE"
  | "NO_EQUITY_HISTORY"
  | "NO_BENCHMARK_HISTORY"
  | "NO_COMMON_SESSIONS"
  | "UNCOMPUTABLE";

export interface PerformanceProvenance {
  readonly source: string;
  readonly scope: string;
  readonly asOf: string | null;
  readonly freshness: "CURRENT" | "UNAVAILABLE" | "NOT_APPLICABLE";
}

export interface PerformanceResponse {
  readonly accountId: string;
  readonly refreshedAt: string;
  readonly status: "CURRENT" | "UNAVAILABLE";
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
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { data: account } = await supa
    .from("accounts")
    .select("id,mode,owner_id")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!account || account.owner_id !== user.id) {
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

  // Any refresh or query error is UNAVAILABLE — never a number with a warning.
  try {
    await backfillEquity(svc, id, account.mode);
  } catch (caught) {
    return respond(
      id,
      "EQUITY_REFRESH_FAILED",
      caught instanceof Error
        ? `The equity mirror could not be refreshed: ${caught.message}`
        : "The equity mirror could not be refreshed.",
      baselineDto,
    );
  }

  let cashFlowsComplete = false;
  try {
    const result = await backfillCashFlows(svc, id, account.mode, {
      since: baseline.startedAt,
    });
    cashFlowsComplete = result.complete;
  } catch (caught) {
    return respond(
      id,
      "CASH_FLOW_REFRESH_FAILED",
      caught instanceof Error
        ? `External cash flows could not be refreshed: ${caught.message}`
        : "External cash flows could not be refreshed.",
      baselineDto,
    );
  }
  if (!cashFlowsComplete) {
    return respond(
      id,
      "CASH_FLOW_INCOMPLETE",
      "The Alpaca activity history could not be walked back to the epoch baseline, so a deposit or withdrawal may be missing from the return.",
      baselineDto,
    );
  }

  const [snapshotResult, flowResult] = await Promise.all([
    svc
      .from("equity_snapshots")
      .select("snapshot_date,equity")
      .eq("account_id", id)
      .gte("snapshot_date", baseline.startSessionDate)
      .order("snapshot_date", { ascending: true }),
    svc
      .from("cash_flows")
      .select("flow_date,amount")
      .eq("account_id", id)
      .gte("flow_date", baseline.startSessionDate),
  ]);

  if (snapshotResult.error) {
    return respond(
      id,
      "EQUITY_QUERY_FAILED",
      "The equity snapshot query failed, so no return can be reported.",
      baselineDto,
    );
  }
  if (flowResult.error) {
    return respond(
      id,
      "CASH_FLOW_QUERY_FAILED",
      "The cash-flow query failed, so a deposit could not be excluded from the return.",
      baselineDto,
    );
  }

  const equity: EquityPoint[] = (snapshotResult.data ?? []).map((row) => ({
    date: row.snapshot_date,
    equity: Number(row.equity),
  }));
  if (equity.length < 2) {
    return respond(
      id,
      "NO_EQUITY_HISTORY",
      "Fewer than two equity observations exist since the V11 epoch baseline.",
      baselineDto,
    );
  }

  const cashFlows: CashFlow[] = (flowResult.data ?? []).map((row) => ({
    date: row.flow_date,
    amount: Number(row.amount),
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

  const body: PerformanceResponse = {
    accountId: id,
    refreshedAt: new Date().toISOString(),
    status: "CURRENT",
    reason: null,
    detail: null,
    baseline: baselineDto,
    performance: result.performance,
    provenance: {
      source: "Supabase equity mirror + Alpaca activities + Alpaca daily bars",
      scope: `account ${id} · V11 epoch from ${baseline.startSessionDate}`,
      asOf: result.performance.endDate,
      freshness: "CURRENT",
    },
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
