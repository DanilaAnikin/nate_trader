import { fetchStateFile } from "@/lib/github";
import type {
  PerformanceData,
  ResearchData,
  ResearchSummary,
  SpyBenchmark,
} from "@/lib/types";
import DashboardClient from "@/components/DashboardClient";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";

export default async function DashboardPage() {
  // The dashboard only needs the SPY block, so read the small
  // research_summary.json (~0.5 KB) instead of the full >1 MB research.json.
  const [performance, summary] = await Promise.all([
    SUPABASE_CONFIGURED
      ? Promise.resolve(null)
      : fetchStateFile<PerformanceData>("performance.json"),
    fetchStateFile<ResearchSummary>("research_summary.json"),
  ]);

  let spy: SpyBenchmark | null = summary?.spy ?? null;

  // Fallback for repos whose research routine hasn't written the summary yet.
  if (!spy) {
    const research = await fetchStateFile<ResearchData>("research.json");
    spy = research?.spy ?? null;
  }

  return <DashboardClient performance={performance} spy={spy} />;
}
