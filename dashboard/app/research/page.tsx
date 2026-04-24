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

      {/* Summary row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {/* SPY Benchmark Card */}
        {spy && (
          <div className="glass-card rounded-lg p-4 col-span-2">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-secondary">SPY Benchmark</h3>
              <span
                className={`text-xs font-semibold px-2 py-0.5 rounded ${
                  spy.market_regime === "BULL"
                    ? "bg-green/15 text-green"
                    : spy.market_regime === "BEAR"
                    ? "bg-red/15 text-red"
                    : "bg-amber/15 text-amber"
                }`}
              >
                {spy.market_regime}
              </span>
            </div>
            <div className="flex items-end gap-4">
              <div>
                <p className="text-2xl font-bold">${spy.price?.toFixed(2)}</p>
              </div>
              <div className="flex gap-4 text-xs text-muted">
                <div>
                  <span className="block">RSI</span>
                  <span className="text-secondary font-medium">{spy.rsi_14?.toFixed(1) ?? "N/A"}</span>
                </div>
                <div>
                  <span className="block">5d</span>
                  <span className={`font-medium ${(spy.five_day_return ?? 0) >= 0 ? "text-green" : "text-red"}`}>
                    {(spy.five_day_return ?? 0) >= 0 ? "+" : ""}{spy.five_day_return?.toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="block">Month</span>
                  <span className={`font-medium ${spy.monthly_return >= 0 ? "text-green" : "text-red"}`}>
                    {spy.monthly_return >= 0 ? "+" : ""}{spy.monthly_return?.toFixed(2)}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Summary stat badges */}
        <div className="glass-card rounded-lg p-4 flex flex-col items-center justify-center">
          <p className="text-2xl font-bold">{symbolEntries.length}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Symbols</p>
        </div>
        <div className="glass-card rounded-lg p-4 flex flex-col items-center justify-center">
          <p className="text-2xl font-bold text-green">{buyCount}</p>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Buy</p>
        </div>
        <div className="glass-card rounded-lg p-4 flex flex-col items-center justify-center">
          <div className="flex gap-3">
            <div className="text-center">
              <p className="text-lg font-bold text-amber">{holdCount}</p>
              <p className="text-[10px] text-muted uppercase">Hold</p>
            </div>
            <div className="w-px bg-border" />
            <div className="text-center">
              <p className="text-lg font-bold text-red">{sellCount}</p>
              <p className="text-[10px] text-muted uppercase">Sell</p>
            </div>
          </div>
        </div>
      </div>

      <ResearchTable symbols={symbols} />
    </div>
  );
}
