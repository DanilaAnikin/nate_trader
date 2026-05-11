import { NextResponse } from "next/server";

/**
 * Live data straight from Alpaca paper API — bypasses GitHub state files.
 *
 * Requires ALPACA_API_KEY and ALPACA_SECRET_KEY in the Vercel environment.
 * Returns 503 with `{ configured: false }` if creds are missing — the client
 * UI then knows to fall back to "GitHub state refresh only" mode.
 *
 * GET /api/live → { account, positions, timestamp }
 */

const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets/v2";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;

  if (!key || !secret) {
    return NextResponse.json(
      { configured: false, error: "Alpaca credentials not set in environment" },
      { status: 503 }
    );
  }

  const headers = {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };

  try {
    const [accountRes, positionsRes] = await Promise.all([
      fetch(`${ALPACA_PAPER_URL}/account`, { headers, cache: "no-store" }),
      fetch(`${ALPACA_PAPER_URL}/positions`, { headers, cache: "no-store" }),
    ]);

    if (!accountRes.ok || !positionsRes.ok) {
      return NextResponse.json(
        { error: `Alpaca API error: account=${accountRes.status}, positions=${positionsRes.status}` },
        { status: 502 }
      );
    }

    const account = await accountRes.json();
    const positions = await positionsRes.json();

    const equity = parseFloat(account.equity ?? "0");
    const lastEquity = parseFloat(account.last_equity ?? equity.toString());
    const cash = parseFloat(account.cash ?? "0");

    return NextResponse.json({
      configured: true,
      timestamp: new Date().toISOString(),
      account: {
        equity,
        cash,
        cash_pct: equity > 0 ? (cash / equity) * 100 : 0,
        daily_pnl: equity - lastEquity,
        daily_pnl_pct: lastEquity > 0 ? ((equity - lastEquity) / lastEquity) * 100 : 0,
        num_positions: positions.length,
      },
      positions: positions.map((p: Record<string, string>) => ({
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
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
