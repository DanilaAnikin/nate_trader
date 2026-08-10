import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { backfillEquity } from "@/lib/accounts/equity-backfill";
import { cashFlowKey, readAllRows } from "@/lib/accounts/paged";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/accounts/[id]/equity — the account's daily equity curve.
 *
 * Refreshes the idempotent Alpaca Portfolio History mirror on each validated
 * account refresh. Existing rows remain a clearly warned fallback if Alpaca
 * history is temporarily unavailable.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const account = await loadOwnedAccount(user.id, id);
  if (!account) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const svc = getSupabaseService();

  let backfilled = 0;
  let refreshWarning: string | null = null;
  try {
    // Idempotent upsert keeps the curve current on every validated account
    // refresh instead of freezing it after the first-ever dashboard visit.
    backfilled = await backfillEquity(svc, id, account.mode);
  } catch (e) {
    refreshWarning = e instanceof Error ? e.message : "equity refresh failed";
  }

  // Paged: PostgREST caps a response at 1000 rows silently, which would clip
  // the oldest end of a multi-year curve rather than report an error.
  const snapshotResult = await readAllRows(
    "equity snapshot",
    (after, limit) => {
      let query = svc
        .from("equity_snapshots")
        .select(
          "snapshot_date,equity,cash,profit_loss,profit_loss_pct,num_positions",
          { count: "exact" },
        )
        .eq("account_id", id);
      if (after !== null) query = query.gt("snapshot_date", after);
      return query.order("snapshot_date", { ascending: true }).limit(limit);
    },
    (row) => row.snapshot_date,
  );
  if (!snapshotResult.ok) {
    return NextResponse.json(
      { error: `could not load equity snapshots: ${snapshotResult.detail}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  const snapshots = snapshotResult.rows;

  if (snapshots.length === 0 && refreshWarning) {
    return NextResponse.json(
      { error: refreshWarning },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const flowResult = await readAllRows(
    "cash-flow",
    (after, limit) => {
      let query = svc
        .from("cash_flows")
        .select("id,flow_date,amount", { count: "exact" })
        .eq("account_id", id);
      if (after !== null) query = query.gt("id", Number(after));
      return query.order("id", { ascending: true }).limit(limit);
    },
    (row) => cashFlowKey(row.id),
  );
  if (!flowResult.ok) {
    // The chart annotates deposits and withdrawals; a partial ledger would
    // mislabel one as a jump in performance.
    return NextResponse.json(
      { error: `could not load cash flows: ${flowResult.detail}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  const flows = flowResult.rows;

  return NextResponse.json(
    {
      accountId: id,
      backfilled,
      refreshedAt: new Date().toISOString(),
      warning: refreshWarning,
      snapshots: snapshots.map((s) => ({
        date: s.snapshot_date,
        equity: s.equity,
        cash: s.cash,
        pnl: s.profit_loss,
        pnl_pct: s.profit_loss_pct,
        num_positions: s.num_positions,
      })),
      cashFlows: flows.map((f) => ({
        date: f.flow_date,
        amount: f.amount,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
