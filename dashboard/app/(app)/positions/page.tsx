import { fetchStateFile } from "@/lib/github";
import type { PositionsData, PerformanceData } from "@/lib/types";
import PositionsClient from "@/components/PositionsClient";
import { SUPABASE_CONFIGURED } from "@/lib/supabase/config";

export default async function PositionsPage() {
  const [positions, performance] = SUPABASE_CONFIGURED
    ? [null, null]
    : await Promise.all([
        fetchStateFile<PositionsData>("positions.json"),
        fetchStateFile<PerformanceData>("performance.json"),
      ]);

  return (
    <PositionsClient
      initialPositions={positions}
      initialPerformance={performance}
    />
  );
}
