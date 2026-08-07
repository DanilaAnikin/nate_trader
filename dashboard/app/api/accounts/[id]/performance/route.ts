import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { backfillCashFlows, backfillEquity } from "@/lib/accounts/equity-backfill";
import { fetchBenchmarkBars, loadCredentials } from "@/lib/status/broker";
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
  | "NO_BASELINE"
  | "BASELINE_ACCOUNT_MISMATCH"
  | "NO_CREDENTIALS"
  | "NO_EQUITY_HISTORY"
  | "NO_BENCHMARK_HISTORY"
  | "NO_COMMON_SESSIONS";

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
  readonly warning: string | null;
}

function unavailable(
  accountId: string,
  reason: PerformanceUnavailableReason,
  detail: string,
  baseline: PerformanceResponse["baseline"] = null,
  warning: string | null = null,
): NextResponse {
  const body: PerformanceResponse = {
    accountId,
    refreshedAt: new Date().toISOString(),
    status: "UNAVAILABLE",
    reason,
    detail,
    baseline,
    performance: null,
    warning,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * GET /api/accounts/[id]/performance — cash-flow-adjusted V11 forward
 * performance for one account against its benchmark.
 *
 * Deliberately fails to `UNAVAILABLE` rather than producing a number that
 * would be wrong: no persisted V11 epoch baseline, a baseline belonging to a
 * different account, or no shared portfolio/benchmark sessions all return an
 * explicit reason. All-time account history that predates V11 is never used.
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
    .select("id,mode")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!account) {
    return NextResponse.json(
      { error: "not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const approved = await getApprovedReleaseSha();
  const baseline = await getEpochBaseline(approved.sha);
  if (!baseline) {
    return unavailable(
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

  if (baseline.accountId !== id) {
    return unavailable(
      id,
      "BASELINE_ACCOUNT_MISMATCH",
      "The persisted V11 epoch baseline belongs to a different account. Forward performance is only meaningful for the account the baseline was recorded for.",
      baselineDto,
    );
  }

  const svc = getSupabaseService();
  const credentials = await loadCredentials(svc, id);
  if (!credentials) {
    return unavailable(
      id,
      "NO_CREDENTIALS",
      "This account has no stored Alpaca credentials, so neither its equity mirror nor the benchmark can be refreshed.",
      baselineDto,
    );
  }

  let warning: string | null = null;
  try {
    await backfillEquity(svc, id, account.mode);
  } catch (caught) {
    warning = caught instanceof Error ? caught.message : "equity refresh failed";
  }
  try {
    await backfillCashFlows(svc, id, account.mode);
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "cash-flow refresh failed";
    warning = warning ? `${warning}; ${message}` : message;
  }

  const [{ data: snapshots }, { data: flows }] = await Promise.all([
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

  const equity: EquityPoint[] = (snapshots ?? []).map((row) => ({
    date: row.snapshot_date,
    equity: Number(row.equity),
  }));
  if (equity.length < 2) {
    return unavailable(
      id,
      "NO_EQUITY_HISTORY",
      "Fewer than two equity observations exist since the V11 epoch baseline.",
      baselineDto,
      warning,
    );
  }

  const cashFlows: CashFlow[] = (flows ?? []).map((row) => ({
    date: row.flow_date,
    amount: Number(row.amount),
  }));

  const bars = await fetchBenchmarkBars(
    credentials,
    baseline.benchmarkSymbol,
    baseline.startSessionDate,
  );
  if (!bars || bars.length < 2) {
    return unavailable(
      id,
      "NO_BENCHMARK_HISTORY",
      `Benchmark (${baseline.benchmarkSymbol}) daily history could not be loaded for the epoch window.`,
      baselineDto,
      warning,
    );
  }

  const performance = computeForwardPerformance({
    baseline,
    accountId: id,
    equity,
    cashFlows,
    benchmark: bars,
  });
  if (!performance) {
    return unavailable(
      id,
      "NO_COMMON_SESSIONS",
      "The portfolio and benchmark series do not share at least two sessions, so no honest comparison window exists.",
      baselineDto,
      warning,
    );
  }

  const body: PerformanceResponse = {
    accountId: id,
    refreshedAt: new Date().toISOString(),
    status: "CURRENT",
    reason: null,
    detail: null,
    baseline: baselineDto,
    performance,
    warning,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
