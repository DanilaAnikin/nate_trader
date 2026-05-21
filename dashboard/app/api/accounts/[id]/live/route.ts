import { NextResponse } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";
import { getSupabaseService } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Ctx = { params: Promise<{ id: string }> };

const ALPACA_BASE: Record<string, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

/**
 * GET /api/accounts/[id]/live — live Alpaca account + positions for one
 * account. The account-scoped, multi-account replacement for /api/live.
 * Credentials are decrypted server-side and never appear in the response.
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
  const { data: cred, error: credErr } = await svc.rpc("get_account_credentials", {
    acct: id,
  });
  if (credErr || !cred || cred.length === 0) {
    return NextResponse.json({ error: "no stored credentials" }, { status: 409 });
  }

  const base = ALPACA_BASE[account.mode];
  const headers = {
    "APCA-API-KEY-ID": cred[0].api_key,
    "APCA-API-SECRET-KEY": cred[0].api_secret,
  };

  let accountRes: Response;
  let positionsRes: Response;
  try {
    [accountRes, positionsRes] = await Promise.all([
      fetch(`${base}/account`, { headers, cache: "no-store" }),
      fetch(`${base}/positions`, { headers, cache: "no-store" }),
    ]);
  } catch {
    return NextResponse.json({ error: "could not reach Alpaca" }, { status: 502 });
  }

  if (accountRes.status === 401 || accountRes.status === 403) {
    await svc.from("accounts").update({ status: "auth_failed" }).eq("id", id);
    return NextResponse.json({ error: "alpaca auth failed" }, { status: 502 });
  }
  if (!accountRes.ok || !positionsRes.ok) {
    return NextResponse.json(
      {
        error: `Alpaca API error: account=${accountRes.status}, positions=${positionsRes.status}`,
      },
      { status: 502 },
    );
  }

  const acc = await accountRes.json();
  const positions: Record<string, string>[] = await positionsRes.json();

  const equity = parseFloat(acc.equity ?? "0");
  const lastEquity = parseFloat(acc.last_equity ?? String(equity));
  const cash = parseFloat(acc.cash ?? "0");

  return NextResponse.json({
    accountId: id,
    mode: account.mode,
    timestamp: new Date().toISOString(),
    account: {
      equity,
      cash,
      cash_pct: equity > 0 ? (cash / equity) * 100 : 0,
      daily_pnl: equity - lastEquity,
      daily_pnl_pct: lastEquity > 0 ? ((equity - lastEquity) / lastEquity) * 100 : 0,
      num_positions: positions.length,
    },
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      avg_entry_price: parseFloat(p.avg_entry_price),
      current_price: parseFloat(p.current_price),
      market_value: parseFloat(p.market_value),
      unrealized_pl: parseFloat(p.unrealized_pl),
      unrealized_plpc: parseFloat(p.unrealized_plpc) * 100,
      side: p.side,
    })),
  });
}
