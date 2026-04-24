import { fetchStateFile } from "@/lib/github";
import type { ResearchData } from "@/lib/types";
import ResearchTable from "@/components/ResearchTable";

export default async function ResearchPage() {
  const data = await fetchStateFile<ResearchData>("research.json");
  const symbols = data?.symbols ?? {};
  const updatedAt = data?.updated_at ?? "N/A";
  const perplexityAt = data?.perplexity_enhanced_at;
  const spy = data?.spy;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Research Signals</h2>
          <p className="text-xs text-muted mt-0.5">
            Last updated: {updatedAt}
            {perplexityAt && ` | Perplexity: ${perplexityAt}`}
          </p>
        </div>
        {spy && (
          <div className="text-right text-sm">
            <p className="text-secondary">
              SPY ${spy.price?.toFixed(2)} |{" "}
              <span
                className={
                  spy.market_regime === "BULL"
                    ? "text-green"
                    : spy.market_regime === "BEAR"
                    ? "text-red"
                    : "text-amber"
                }
              >
                {spy.market_regime}
              </span>
            </p>
            <p className="text-xs text-muted">
              RSI {spy.rsi_14?.toFixed(1)} | Month{" "}
              {spy.monthly_return >= 0 ? "+" : ""}
              {spy.monthly_return?.toFixed(2)}%
            </p>
          </div>
        )}
      </div>
      <ResearchTable symbols={symbols} />
    </div>
  );
}
