import { NextResponse } from "next/server";
import { getSupabaseService } from "@/lib/supabase/service";
import {
  getSessionUser,
  loadOwnedAccount,
} from "@/lib/accounts/session";
import { readAccountHistory } from "@/lib/accounts/history";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/accounts/[id]/equity — the account's daily equity curve.
 *
 * **Side-effect free.** This handler used to refresh the Alpaca mirrors on
 * every call, which made a GET write four tables, hit two broker endpoints and
 * consume a sequence value. Three things were wrong with that beyond the
 * verb: a page that polls turns into a write loop; two tabs open on the same
 * account race each other's refreshes; and the write happened with no audit
 * entry and no user intent behind it.
 *
 * Refreshing is now `POST /api/accounts/[id]/refresh`, an explicit command.
 * This reads the stored curve and ledger from one database snapshot.
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

  return NextResponse.json(
    {
      accountId: id,
      // The database snapshot both series came from, so a client-side
      // comparison can be audited back to one state. `capturedAt` is when
      // *this read* ran — deliberately not relabelled as "last published",
      // which it is not: `account_history_snapshot` stamps it with `now()`.
      // The mirror's own freshness is the newest session it contains.
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
