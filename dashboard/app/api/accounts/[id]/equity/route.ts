import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { backfillEquity } from "@/lib/accounts/equity-backfill";
import { readAccountHistory } from "@/lib/accounts/history";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/accounts/[id]/equity — the account's daily equity curve.
 *
 * Refreshes the idempotent Alpaca Portfolio History mirror on each validated
 * account refresh, then reads the curve and the cash-flow ledger from a single
 * database snapshot. Existing rows remain a clearly warned fallback if Alpaca
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
    // Idempotent: keeps the curve current on every validated account refresh
    // instead of freezing it after the first-ever dashboard visit.
    backfilled = await backfillEquity(svc, id, account.owner_id, account.mode);
  } catch (e) {
    refreshWarning = e instanceof Error ? e.message : "equity refresh failed";
  }

  // One request, one database snapshot, both datasets. Reading them as two
  // paged walks could return an equity curve and a ledger from two different
  // states of the database, and the chart annotates one with the other.
  const historyResult = await readAccountHistory(svc, id, account.owner_id, null);
  if (!historyResult.ok) {
    return NextResponse.json(
      { error: `could not load account history: ${historyResult.detail}` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { equity, cashFlows, snapshot, capturedAt } = historyResult.history;

  if (equity.length === 0 && refreshWarning) {
    return NextResponse.json(
      { error: refreshWarning },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      accountId: id,
      backfilled,
      refreshedAt: new Date().toISOString(),
      warning: refreshWarning,
      // The database snapshot both series came from, so a client-side
      // comparison can be audited back to one state.
      snapshot,
      capturedAt,
      snapshots: equity.map((point) => ({
        date: point.date,
        equity: point.equity,
        cash: point.cash,
        pnl: point.profitLoss,
        pnl_pct: point.profitLossPct,
        num_positions: point.numPositions,
      })),
      cashFlows: cashFlows.map((flow) => ({
        date: flow.date,
        amount: flow.amount,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
