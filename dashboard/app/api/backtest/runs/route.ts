import { NextResponse } from "next/server";
import { fetchStateFile } from "@/lib/github";

/**
 * Returns the manifest of all backtest runs that have been recorded.
 *
 * GET /api/backtest/runs
 *
 * Response shape: { updated_at, runs: [{id, kind, generated_at, ...summary}] }
 *
 * The manifest is written by scripts/backtest/manifest.record_run() at the
 * end of every backtest CLI command — so it's always up to date with what's
 * been archived in state/backtest/runs/.
 */

export const revalidate = 30;

interface ManifestEntry {
  id: string;
  kind: string;
  generated_at: string;
  start_date?: string;
  end_date?: string;
  filename?: string;
  summary?: Record<string, unknown>;
}

interface Manifest {
  updated_at?: string;
  runs?: ManifestEntry[];
}

export async function GET() {
  const data = await fetchStateFile<Manifest>("backtest/manifest.json");
  if (!data) {
    return NextResponse.json(
      {
        configured: false,
        error: "No backtest manifest yet. Trigger the Backtest workflow at least once.",
        runs: [],
      },
      { status: 404 }
    );
  }
  return NextResponse.json({
    updated_at: data.updated_at ?? null,
    runs: data.runs ?? [],
  });
}
