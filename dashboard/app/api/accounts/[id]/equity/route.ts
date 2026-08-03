import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";
import { backfillEquity } from "@/lib/accounts/equity-backfill";

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
  const supa = await getSupabaseServer();
  const {
    data: { user },
  } = await supa.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // RLS scopes this to the caller's own accounts.
  const { data: account } = await supa
    .from("accounts")
    .select("id,mode")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
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

  const { data: snapshots, error } = await svc
    .from("equity_snapshots")
    .select(
      "snapshot_date,equity,cash,profit_loss,profit_loss_pct,num_positions",
    )
    .eq("account_id", id)
    .order("snapshot_date", { ascending: true });
  if (error) {
    return NextResponse.json(
      { error: "could not load equity snapshots" },
      { status: 500 },
    );
  }

  if ((snapshots?.length ?? 0) === 0 && refreshWarning) {
    return NextResponse.json(
      { error: refreshWarning },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { data: flows } = await svc
    .from("cash_flows")
    .select("flow_date,amount")
    .eq("account_id", id);

  return NextResponse.json(
    {
      accountId: id,
      backfilled,
      refreshedAt: new Date().toISOString(),
      warning: refreshWarning,
      snapshots: (snapshots ?? []).map((s) => ({
        date: s.snapshot_date,
        equity: s.equity,
        cash: s.cash,
        pnl: s.profit_loss,
        pnl_pct: s.profit_loss_pct,
        num_positions: s.num_positions,
      })),
      cashFlows: (flows ?? []).map((f) => ({
        date: f.flow_date,
        amount: f.amount,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
