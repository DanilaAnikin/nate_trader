import { NextResponse } from "next/server";
import { fetchStateFile } from "@/lib/github";

/**
 * Serves backtest results from state/backtest/*.json (written by the
 * "Backtest" GitHub Actions workflow).
 *
 * Query: ?kind=single|sweep|monte-carlo
 * Default: single
 */

export const revalidate = 60;

const FILE_MAP: Record<string, string> = {
  single: "backtest/latest_result.json",
  sweep: "backtest/sweep_result.json",
  "monte-carlo": "backtest/monte_carlo_result.json",
  "walk-forward": "backtest/walk_forward_result.json",
  compare: "backtest/comparison_result.json",
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || "single";
  const filename = FILE_MAP[kind];
  if (!filename) {
    return NextResponse.json(
      { error: `Unknown kind: ${kind}. Use single|sweep|monte-carlo.` },
      { status: 400 }
    );
  }
  const data = await fetchStateFile<unknown>(filename);
  if (!data) {
    return NextResponse.json(
      {
        configured: false,
        error: `${filename} not generated yet. Trigger the 'Backtest' GitHub Actions workflow with mode=${kind}.`,
      },
      { status: 404 }
    );
  }
  return NextResponse.json(data);
}
