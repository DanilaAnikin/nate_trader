import { fetchStateFile } from "@/lib/github";
import type { ScreenerData } from "@/lib/types";
import ScreenerTable from "@/components/ScreenerTable";

export default async function ScreenerPage() {
  const data = await fetchStateFile<ScreenerData>("screener.json");
  const updatedAt = data?.updated_at ?? "N/A";
  const scored = data?.scored_candidates ?? {};

  const scoredEntries = Object.values(scored).filter(s => s.confidence);
  const totalCandidates = (data?.most_active?.length ?? 0) + (data?.top_movers?.length ?? 0) + (data?.trending?.length ?? 0);
  const highestScore = scoredEntries.length > 0
    ? Math.max(...scoredEntries.map(s => s.confidence.total))
    : 0;
  const buyThresholdCount = scoredEntries.filter(s => s.confidence.total >= 65).length;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-bold">Stock Screener</h2>
        <p className="text-xs text-muted mt-0.5">Last updated: {updatedAt}</p>
      </div>

      {/* Summary stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="glass-card rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">{totalCandidates}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Candidates</p>
        </div>
        <div className="glass-card rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">{scoredEntries.length}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Scored</p>
        </div>
        <div className="glass-card rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-blue">{highestScore}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Highest Score</p>
        </div>
        <div className="glass-card rounded-lg p-4 text-center">
          <p className="text-2xl font-bold text-green">{buyThresholdCount}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Above Buy (65+)</p>
        </div>
      </div>

      <ScreenerTable
        mostActive={data?.most_active ?? []}
        topMovers={data?.top_movers ?? []}
        trending={data?.trending ?? []}
        scoredCandidates={scored}
      />
    </div>
  );
}
