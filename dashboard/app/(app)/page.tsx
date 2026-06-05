import { fetchStateFile } from "@/lib/github";
import type {
  PerformanceData,
  ResearchData,
  ResearchSummary,
  SignalCounts,
  SpyBenchmark,
} from "@/lib/types";
import DashboardClient from "@/components/DashboardClient";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import { getSelectedAccount } from "@/lib/account-context";

export default async function DashboardPage() {
  // The dashboard only needs the SPY block + signal counts, so read the small
  // research_summary.json (~0.5 KB) instead of the full >1 MB research.json.
  const [performance, summary] = await Promise.all([
    fetchStateFile<PerformanceData>("performance.json"),
    fetchStateFile<ResearchSummary>("research_summary.json"),
  ]);

  let spy: SpyBenchmark | null = summary?.spy ?? null;
  let signals: SignalCounts | null = summary?.signals ?? null;

  // Fallback for repos whose research routine hasn't written the summary yet:
  // derive it from the full research.json.
  if (!signals) {
    const research = await fetchStateFile<ResearchData>("research.json");
    spy = research?.spy ?? null;
    const scored = Object.values(research?.symbols ?? {}).filter(
      (s) => !s.error && s.confidence,
    );
    signals = {
      buy: scored.filter((s) => s.confidence.action === "BUY").length,
      hold: scored.filter((s) => s.confidence.action === "HOLD").length,
      sell: scored.filter((s) => s.confidence.action === "SELL").length,
      total: scored.length,
      avg_score: scored.length
        ? Math.round(
            scored.reduce((sum, s) => sum + s.confidence.total, 0) /
              scored.length,
          )
        : 0,
    };
  }

  let selectedAccountId: string | null = null;
  if (SUPABASE_CONFIGURED) {
    const { selected } = await getSelectedAccount();
    selectedAccountId = selected?.id ?? null;
  }

  return (
    <DashboardClient
      performance={performance}
      spy={spy}
      signals={signals}
      selectedAccountId={selectedAccountId}
    />
  );
}
