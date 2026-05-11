import { NextResponse } from "next/server";

/**
 * Daily SPY bars from 2020-01-01 to today, sourced from Alpaca market data.
 * Cached for 1 hour at the edge so the historical chart doesn't slam Alpaca.
 *
 * GET /api/spy-history → { bars: [{ date, close }, ...] }
 *
 * Returns 503 if ALPACA_API_KEY isn't set in Vercel env — caller falls
 * back to "history unavailable" message in the chart component.
 */

// Don't prerender at build time (no Alpaca creds in build env). Cache at
// the fetch layer instead via `next: { revalidate }` on the actual fetch.
export const dynamic = "force-dynamic";

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export async function GET() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_SECRET_KEY;

  if (!key || !secret) {
    return NextResponse.json(
      { configured: false, error: "Alpaca credentials not set in environment" },
      { status: 503 }
    );
  }

  const start = "2020-01-01";
  const end = new Date().toISOString().split("T")[0];
  const baseUrl = "https://data.alpaca.markets/v2/stocks/SPY/bars";

  const headers = {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };

  try {
    // Alpaca paginates — loop on next_page_token until exhausted
    const allBars: Array<{ date: string; close: number }> = [];
    let pageToken: string | undefined = undefined;
    let safetyLimit = 20; // ~20 pages × 1000 bars = 20000 bars (enough for 78 years)

    do {
      const params = new URLSearchParams({
        timeframe: "1Day",
        start,
        end,
        adjustment: "all", // splits + dividends
        limit: "10000",
      });
      if (pageToken) params.set("page_token", pageToken);

      const res = await fetch(`${baseUrl}?${params}`, {
        headers,
        next: { revalidate: 3600 },
      });

      if (!res.ok) {
        return NextResponse.json(
          { error: `Alpaca bars API error: ${res.status}` },
          { status: 502 }
        );
      }

      const data: { bars?: AlpacaBar[]; next_page_token?: string | null } = await res.json();
      const bars = data.bars ?? [];
      for (const b of bars) {
        allBars.push({ date: b.t.split("T")[0], close: b.c });
      }
      pageToken = data.next_page_token ?? undefined;
      safetyLimit -= 1;
    } while (pageToken && safetyLimit > 0);

    return NextResponse.json({
      configured: true,
      from: start,
      to: end,
      count: allBars.length,
      bars: allBars,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
