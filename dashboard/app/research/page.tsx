import { fetchStateFile } from "@/lib/github";
import type { ResearchData } from "@/lib/types";
import ResearchTable from "@/components/ResearchTable";

export default async function ResearchPage() {
  const data = await fetchStateFile<ResearchData>("research.json");
  const symbols = data?.symbols ?? {};
  const updatedAt = data?.updated_at ?? "N/A";
  const perplexityAt = data?.perplexity_enhanced_at;
  const spy = data?.spy;

  const symbolEntries = Object.values(symbols).filter((s) => !s.error && s.confidence);
  const buyCount = symbolEntries.filter((s) => s.confidence.action === "BUY").length;
  const holdCount = symbolEntries.filter((s) => s.confidence.action === "HOLD").length;
  const sellCount = symbolEntries.filter((s) => s.confidence.action === "SELL").length;
  const avgScore = symbolEntries.length > 0
    ? Math.round(symbolEntries.reduce((sum, s) => sum + s.confidence.total, 0) / symbolEntries.length)
    : 0;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Research Signals</h2>
          <p className="text-xs text-muted mt-0.5">
            Last updated: {updatedAt}
            {perplexityAt && ` | Perplexity: ${perplexityAt}`}
          </p>
        </div>
      </div>

      {/* Summary row — compact horizontal strip */}
      <div className="glass-card rounded-lg p-4">
        <div className="flex items-center gap-6 flex-wrap">
          {/* SPY Benchmark */}
          {spy && (
            <div className="flex items-center gap-4 pr-6 border-r border-white/[0.06]">
              <div>
                <p className="text-[10px] text-muted uppercase tracking-wider mb-0.5">SPY</p>
                <p className="text-xl font-bold">${spy.price?.toFixed(2)}</p>
              </div>
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                spy.market_regime === "BULL"
                  ? "bg-green/15 text-green"
                  : spy.market_regime === "BEAR"
                  ? "bg-red/15 text-red"
                  : "bg-amber/15 text-amber"
              }`}>
                {spy.market_regime}
              </span>
              <div className="flex gap-3 text-xs">
                <div className="text-center">
                  <p className="text-muted text-[10px]">RSI</p>
                  <p className="text-secondary font-semibold">{spy.rsi_14?.toFixed(1) ?? "—"}</p>
                </div>
                <div className="text-center">
                  <p className="text-muted text-[10px]">5d</p>
                  <p className={`font-semibold ${(spy.five_day_return ?? 0) >= 0 ? "text-green" : "text-red"}`}>
                    {(spy.five_day_return ?? 0) >= 0 ? "+" : ""}{spy.five_day_return?.toFixed(2)}%
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-muted text-[10px]">Month</p>
                  <p className={`font-semibold ${spy.monthly_return >= 0 ? "text-green" : "text-red"}`}>
                    {spy.monthly_return >= 0 ? "+" : ""}{spy.monthly_return?.toFixed(2)}%
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Signal counts */}
          <div className="flex items-center gap-5">
            <div className="text-center">
              <p className="text-lg font-bold">{symbolEntries.length}</p>
              <p className="text-[10px] text-muted uppercase tracking-wider">Symbols</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-green">{buyCount}</p>
              <p className="text-[10px] text-muted uppercase tracking-wider">Buy</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-amber">{holdCount}</p>
              <p className="text-[10px] text-muted uppercase tracking-wider">Hold</p>
            </div>
            <div className="text-center">
              <p className="text-lg font-bold text-red">{sellCount}</p>
              <p className="text-[10px] text-muted uppercase tracking-wider">Sell</p>
            </div>
          </div>

          {/* Avg score */}
          <div className="ml-auto text-center pl-6 border-l border-white/[0.06]">
            <p className="text-[10px] text-muted uppercase tracking-wider mb-0.5">Avg Score</p>
            <p className={`text-xl font-bold ${avgScore >= 65 ? "text-green" : avgScore >= 40 ? "text-amber" : "text-red"}`}>{avgScore}</p>
          </div>
        </div>
      </div>

      <ResearchTable symbols={symbols} />
    </div>
  );
}
