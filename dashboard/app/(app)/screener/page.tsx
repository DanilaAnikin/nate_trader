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
        <h2 className="text-2xl font-semibold text-foreground">Legacy Market Screener</h2>
        <p className="text-xs text-muted mt-0.5">Last updated: {updatedAt}</p>
      </div>

      <div className="rounded-xl border border-amber/25 bg-amber/5 px-4 py-3 text-xs text-amber">
        This page preserves V10 discovery diagnostics only. V11 production
        selection comes from its separate validated 12–1 momentum universe;
        a score of 65 here does not authorize a trade.
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-semibold text-foreground">{totalCandidates}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Candidates</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-semibold text-foreground">{scoredEntries.length}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Scored</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-semibold text-blue">{highestScore}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Highest Score</p>
        </div>
        <div className="glass-card p-4 text-center">
          <p className="text-2xl font-semibold text-green">{buyThresholdCount}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Legacy score 65+</p>
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
