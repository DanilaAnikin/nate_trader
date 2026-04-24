import { fetchStateFile } from "@/lib/github";
import type { PositionsData, PerformanceData } from "@/lib/types";
import PositionsTable from "@/components/PositionsTable";
import MetricCard from "@/components/MetricCard";

export default async function PositionsPage() {
  const [data, performance] = await Promise.all([
    fetchStateFile<PositionsData>("positions.json"),
    fetchStateFile<PerformanceData>("performance.json"),
  ]);

  const positions = data?.positions ?? [];
  const updatedAt = data?.updated_at ?? "N/A";
  const equity = performance?.equity ?? 0;
  const cashPct = performance?.cash_pct ?? 0;

  const totalUnrealizedPl = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const totalMarketValue = positions.reduce((sum, p) => sum + p.market_value, 0);
  const utilization = equity > 0 ? ((totalMarketValue / equity) * 100) : 0;

  const rules = [
    { label: "Max 10 positions", ok: positions.length <= 10 },
    { label: "Cash reserve ≥ 20%", ok: cashPct >= 20 },
    { label: "Max position ≤ 5% equity", ok: positions.every(p => equity <= 0 || (p.market_value / equity) * 100 <= 5.5) },
    { label: "No position held > 10 days without 5%+ gain", ok: true },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Positions</h2>
        <p className="text-xs text-muted mt-0.5">Last updated: {updatedAt}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Open Positions"
          value={`${positions.length}`}
          subValue="Max: 10"
          accent="blue"
          index={0}
        />
        <MetricCard
          label="Portfolio Utilization"
          value={`${utilization.toFixed(1)}%`}
          subValue={`$${totalMarketValue.toLocaleString(undefined, { minimumFractionDigits: 2 })} invested`}
          accent="purple"
          index={1}
        />
        <MetricCard
          label="Unrealized P&L"
          value={`${totalUnrealizedPl >= 0 ? "+" : ""}$${totalUnrealizedPl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          trend={totalUnrealizedPl >= 0 ? "up" : "down"}
          accent={totalUnrealizedPl >= 0 ? "green" : "red"}
          index={2}
        />
        <MetricCard
          label="Cash Reserve"
          value={`${cashPct.toFixed(1)}%`}
          subValue={cashPct >= 20 ? "Healthy" : "Below minimum"}
          trend={cashPct >= 20 ? "up" : "down"}
          accent="amber"
          index={3}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3">
          <PositionsTable positions={positions} equity={equity} />
        </div>
        <div className="glass-card p-5 h-fit">
          <h3 className="text-sm font-medium text-secondary mb-3">Portfolio Rules</h3>
          <div className="space-y-3">
            {rules.map((rule) => (
              <div key={rule.label} className="flex items-center gap-2.5 text-sm">
                {rule.ok ? (
                  <svg width="16" height="16" viewBox="0 0 18 18" className="text-green shrink-0">
                    <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M5.5 9l2.5 2.5 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 18 18" className="text-red shrink-0">
                    <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
                <span className={`text-xs ${rule.ok ? "text-foreground" : "text-red"}`}>{rule.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
