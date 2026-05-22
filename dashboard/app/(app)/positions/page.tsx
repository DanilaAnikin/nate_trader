import { fetchStateFile } from "@/lib/github";
import type { PositionsData, PerformanceData, ResearchData } from "@/lib/types";
import PositionsClient from "@/components/PositionsClient";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";
import { getSelectedAccount } from "@/lib/account-context";

export default async function PositionsPage() {
  const [positions, performance, research] = await Promise.all([
    fetchStateFile<PositionsData>("positions.json"),
    fetchStateFile<PerformanceData>("performance.json"),
    fetchStateFile<ResearchData>("research.json"),
  ]);

  const regime = research?.spy?.market_regime ?? "UNKNOWN";

  let selectedAccountId: string | null = null;
  if (SUPABASE_CONFIGURED) {
    const { selected } = await getSelectedAccount();
    selectedAccountId = selected?.id ?? null;
  }

  return (
    <PositionsClient
      initialPositions={positions}
      initialPerformance={performance}
      initialMarketRegime={regime}
      selectedAccountId={selectedAccountId}
    />
  );
}
