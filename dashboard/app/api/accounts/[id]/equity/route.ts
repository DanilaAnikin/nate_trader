import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { refreshBrokerDatasets } from "@/lib/accounts/broker-refresh";
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

  // Both broker datasets are fetched, validated and published as one
  // generation. A failed refresh writes nothing at all, so the stored mirror
  // stays exactly as it was and is served with the reason attached.
  let backfilled = 0;
  let refreshWarning: string | null = null;
  const refresh = await refreshBrokerDatasets(
    svc,
    id,
    account.owner_id,
    account.mode,
  );
  if (refresh.ok) {
    backfilled = refresh.equityWritten;
  } else {
    refreshWarning = `${refresh.reason}: ${refresh.detail}`;
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
