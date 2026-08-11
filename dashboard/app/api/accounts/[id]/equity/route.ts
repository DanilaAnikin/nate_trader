import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { readAllRows } from "@/lib/accounts/paged";

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

  // **No backfill.** This handler used to refresh the Alpaca mirror on every
  // call, so a page that polled wrote `equity_snapshots` on every poll and two
  // open tabs raced each other — unaudited, with no user intent behind it, and
  // reachable by anything that could hold the page open.
  //
  // Freezing it during maintenance (the previous fix) closed the window that
  // mattered most but left the write in place the rest of the time. This is
  // the bridge: its job is to serve reads correctly on both schemas. Reads do
  // not write. The stored curve below is unchanged and still true; refreshing
  // it is an explicit command in the candidate image.
  const backfilled = 0;
  const refreshWarning: string | null = null;

  // Paged: PostgREST caps a response at 1000 rows silently, which would clip
  // the oldest end of a multi-year curve rather than report an error.
  const snapshotResult = await readAllRows("equity snapshot", (from, to) =>
    svc
      .from("equity_snapshots")
      .select(
        "snapshot_date,equity,cash,profit_loss,profit_loss_pct,num_positions",
      )
      .eq("account_id", id)
      .order("snapshot_date", { ascending: true })
      .range(from, to),
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

  const flowResult = await readAllRows("cash-flow", (from, to) =>
    svc
      .from("cash_flows")
      .select("flow_date,amount")
      .eq("account_id", id)
      .order("flow_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
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
