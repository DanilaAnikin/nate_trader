import { NextResponse } from "next/server";
import { fetchStateFile } from "@/lib/github";

/**
 * Serves the SPY daily-close history that lives at state/spy_history.json
 * in the repo. The file is maintained by scripts/update_spy_history.py via
 * the "Update SPY History" GitHub Actions workflow (runs 16:45 ET on
 * weekdays).
 *
 * Why read from GitHub instead of hitting Alpaca live:
 *   • No ALPACA_API_KEY needed in Vercel env
 *   • Single round-trip (no Alpaca pagination)
 *   • Cached at the edge for 5 min, behind GitHub's CDN, very fast
 *   • Works even if Alpaca's market-data API is having a bad day
 *
 * The file format mirrors what the chart already consumes:
 *   { configured: true, from, to, count, bars: [{ date, close }, ...] }
 */

interface SpyHistory {
  updated_at: string;
  symbol: string;
  from: string;
  to: string;
  count: number;
  bars: Array<{ date: string; close: number }>;
}

export const revalidate = 300; // 5 min — file updates once per day anyway

export async function GET() {
  const data = await fetchStateFile<SpyHistory>("spy_history.json");
  if (!data || !data.bars || data.bars.length === 0) {
    return NextResponse.json(
      {
        configured: false,
        error:
          "spy_history.json missing or empty. Trigger the 'Update SPY History' GitHub Actions workflow to backfill (workflow_dispatch).",
      },
      { status: 404 }
    );
  }

  return NextResponse.json({
    configured: true,
    from: data.from,
    to: data.to,
    count: data.count,
    updated_at: data.updated_at,
    bars: data.bars,
  });
}
