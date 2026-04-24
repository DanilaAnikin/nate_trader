import { fetchStateFile } from "@/lib/github";
import type { PerformanceData, ResearchData } from "@/lib/types";
import MetricCard from "@/components/MetricCard";
import EquityChart from "@/components/EquityChart";
import SpyComparison from "@/components/SpyComparison";
import RiskBadge from "@/components/RiskBadge";

export default async function DashboardPage() {
  const [performance, research] = await Promise.all([
    fetchStateFile<PerformanceData>("performance.json"),
    fetchStateFile<ResearchData>("research.json"),
  ]);

  const equity = performance?.equity ?? 0;
  const cashPct = performance?.cash_pct ?? 0;
  const dailyPnl = performance?.daily_pnl ?? 0;
  const dailyPnlPct = performance?.daily_pnl_pct ?? 0;
  const monthlyPnlPct = performance?.monthly_pnl_pct ?? 0;
  const riskTier = performance?.risk_tier ?? "NORMAL";
  const dailyHistory = performance?.daily_history ?? [];
  const spyMonthly = research?.spy?.monthly_return ?? 0;
  const marketRegime = research?.spy?.market_regime ?? "UNKNOWN";
  const updatedAt = performance?.updated_at ?? "N/A";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Dashboard</h2>
          <p className="text-xs text-muted mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Market:</span>
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded ${
              marketRegime === "BULL"
                ? "bg-green/15 text-green"
                : marketRegime === "BEAR"
                ? "bg-red/15 text-red"
                : "bg-amber/15 text-amber"
            }`}
          >
            {marketRegime}
          </span>
          <RiskBadge tier={riskTier} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Equity"
          value={`$${equity.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          subValue={`${performance?.num_positions ?? 0} positions`}
        />
        <MetricCard
          label="Cash Reserve"
          value={`${cashPct.toFixed(1)}%`}
          subValue={`$${(performance?.cash ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          trend={cashPct >= 20 ? "up" : "down"}
        />
        <MetricCard
          label="Daily P&L"
          value={`${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          subValue={`${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%`}
          trend={dailyPnl >= 0 ? "up" : "down"}
        />
        <MetricCard
          label="Monthly P&L"
          value={`${monthlyPnlPct >= 0 ? "+" : ""}${monthlyPnlPct.toFixed(2)}%`}
          subValue={`SPY: ${spyMonthly >= 0 ? "+" : ""}${spyMonthly.toFixed(2)}%`}
          trend={monthlyPnlPct >= 0 ? "up" : "down"}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <EquityChart data={dailyHistory} />
        <SpyComparison portfolioReturn={monthlyPnlPct} spyReturn={spyMonthly} />
      </div>
    </div>
  );
}
