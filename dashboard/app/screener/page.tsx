import { fetchStateFile } from "@/lib/github";
import type { ScreenerData } from "@/lib/types";
import ScreenerTable from "@/components/ScreenerTable";

export default async function ScreenerPage() {
  const data = await fetchStateFile<ScreenerData>("screener.json");
  const updatedAt = data?.updated_at ?? "N/A";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Stock Screener</h2>
        <p className="text-xs text-muted mt-0.5">Last updated: {updatedAt}</p>
      </div>
      <ScreenerTable
        mostActive={data?.most_active ?? []}
        topMovers={data?.top_movers ?? []}
        trending={data?.trending ?? []}
        scoredCandidates={data?.scored_candidates ?? {}}
      />
    </div>
  );
}
