import { fetchStateFile } from "@/lib/github";
import type { PerformanceData, ResearchData } from "@/lib/types";
import DashboardClient from "@/components/DashboardClient";

export default async function DashboardPage() {
  const [performance, research] = await Promise.all([
    fetchStateFile<PerformanceData>("performance.json"),
    fetchStateFile<ResearchData>("research.json"),
  ]);

  return <DashboardClient performance={performance} research={research} />;
}
