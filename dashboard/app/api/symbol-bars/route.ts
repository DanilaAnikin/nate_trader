import { NextResponse } from "next/server";
import { fetchStateFile } from "@/lib/github";

/**
 * Serves cached daily bars for a single symbol from the backtest data
 * cache (state/backtest/bars/{symbol}.json — populated by the backtest
 * "download" mode and the per-symbol fetcher inside the engine).
 *
 * Query: ?symbol=SYM
 */

export const revalidate = 600; // 10 min — bars file changes daily at most

interface BarFile {
  symbol: string;
  updated_at: string;
  from: string;
  to: string;
  count: number;
  bars: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase().trim();
  if (!symbol) {
    return NextResponse.json(
      { error: "Missing ?symbol parameter" },
      { status: 400 }
    );
  }
  if (!/^[A-Z][A-Z0-9.]{0,6}$/.test(symbol)) {
    return NextResponse.json(
      { error: `Invalid symbol: ${symbol}` },
      { status: 400 }
    );
  }
  const data = await fetchStateFile<BarFile>(`backtest/bars/${symbol}.json`);
  if (!data || !data.bars) {
    return NextResponse.json(
      {
        configured: false,
        error: `No cached bars for ${symbol}. Run the Backtest workflow with mode=download first.`,
      },
      { status: 404 }
    );
  }
  return NextResponse.json(data);
}
