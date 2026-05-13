import { NextResponse } from "next/server";
import { fetchStateFile } from "@/lib/github";

/**
 * Returns the alpha tracker history written by the nightly
 * auto-iteration workflow. Used by the dashboard to plot
 * day-over-day alpha progression.
 */

export const revalidate = 300;

interface TrackerRow {
  date: string;
  timestamp: string;
  run_id?: string;
  alpha_annual_pct?: number;
  total_return_pct?: number;
  annual_return_pct?: number;
  sharpe_ratio?: number;
  max_drawdown_pct?: number;
  n_trades?: number;
  ml_test_auc?: number;
  delta_vs_7d_avg?: number;
  regression_flagged?: boolean;
}

interface Tracker {
  last_updated: string;
  n_iterations: number;
  history: TrackerRow[];
  best_run?: TrackerRow;
}

export async function GET() {
  const data = await fetchStateFile<Tracker>("alpha_tracker.json");
  if (!data) {
    return NextResponse.json(
      { configured: false, error: "No alpha tracker yet — auto-iteration hasn't run" },
      { status: 404 }
    );
  }
  return NextResponse.json(data);
}
