import { fetchStateFile } from "@/lib/github";
import type { PositionsData, PerformanceData, ResearchData } from "@/lib/types";
import PositionsClient from "@/components/PositionsClient";

export default async function PositionsPage() {
  const [positions, performance, research] = await Promise.all([
    fetchStateFile<PositionsData>("positions.json"),
    fetchStateFile<PerformanceData>("performance.json"),
    fetchStateFile<ResearchData>("research.json"),
  ]);

  const regime = research?.spy?.market_regime ?? "UNKNOWN";

  return (
    <PositionsClient
      initialPositions={positions}
      initialPerformance={performance}
      initialMarketRegime={regime}
    />
  );
}
