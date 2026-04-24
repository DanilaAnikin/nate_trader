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
  const numPositions = performance?.num_positions ?? 0;

  const symbols = research?.symbols ?? {};
  const symbolEntries = Object.values(symbols).filter((s) => !s.error && s.confidence);
  const buyCount = symbolEntries.filter((s) => s.confidence.action === "BUY").length;
  const holdCount = symbolEntries.filter((s) => s.confidence.action === "HOLD").length;
  const sellCount = symbolEntries.filter((s) => s.confidence.action === "SELL").length;

  const rules = [
    { label: "Cash Reserve ≥ 20%", ok: cashPct >= 20 },
    { label: "Max 10 Positions", ok: numPositions <= 10 },
    { label: "Risk Tier: NORMAL", ok: riskTier === "NORMAL" },
    { label: "Daily Loss < 3%", ok: dailyPnlPct > -3 },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Dashboard</h2>
          <p className="text-xs text-muted mt-0.5">Last updated: {updatedAt}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Market:</span>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${
              marketRegime === "BULL"
                ? "bg-green/8 text-green"
                : marketRegime === "BEAR"
                ? "bg-red/8 text-red"
                : "bg-amber/8 text-amber"
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
          subValue={`${numPositions} positions`}
          accent="blue"
          index={0}
        />
        <MetricCard
          label="Cash Reserve"
          value={`${cashPct.toFixed(1)}%`}
          subValue={`$${(performance?.cash ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          trend={cashPct >= 20 ? "up" : "down"}
          accent="amber"
          index={1}
        />
        <MetricCard
          label="Daily P&L"
          value={`${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          subValue={`${dailyPnlPct >= 0 ? "+" : ""}${dailyPnlPct.toFixed(2)}%`}
          trend={dailyPnl >= 0 ? "up" : "down"}
          accent="green"
          index={2}
        />
        <MetricCard
          label="Monthly P&L"
          value={`${monthlyPnlPct >= 0 ? "+" : ""}${monthlyPnlPct.toFixed(2)}%`}
          subValue={`SPY: ${spyMonthly >= 0 ? "+" : ""}${spyMonthly.toFixed(2)}%`}
          trend={monthlyPnlPct >= 0 ? "up" : "down"}
          accent={monthlyPnlPct >= 0 ? "green" : "red"}
          index={3}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3">
          <EquityChart data={dailyHistory} />
        </div>
        <div className="lg:col-span-2">
          <SpyComparison portfolioReturn={monthlyPnlPct} spyReturn={spyMonthly} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-3">Rules Compliance</h3>
          <div className="space-y-3">
            {rules.map((rule) => (
              <div key={rule.label} className="flex items-center gap-2.5 text-sm">
                {rule.ok ? (
                  <svg width="18" height="18" viewBox="0 0 18 18" className="text-green shrink-0">
                    <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M5.5 9l2.5 2.5 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 18 18" className="text-red shrink-0">
                    <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
                <span className={rule.ok ? "text-foreground" : "text-red"}>{rule.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-3">Research Signals</h3>
          <div className="flex items-center justify-around h-[calc(100%-2rem)]">
            <div className="text-center">
              <p className="text-2xl font-semibold text-green">{buyCount}</p>
              <p className="text-xs text-muted uppercase tracking-wider mt-1">Buy</p>
            </div>
            <div className="w-px h-10 bg-border" />
            <div className="text-center">
              <p className="text-2xl font-semibold text-amber">{holdCount}</p>
              <p className="text-xs text-muted uppercase tracking-wider mt-1">Hold</p>
            </div>
            <div className="w-px h-10 bg-border" />
            <div className="text-center">
              <p className="text-2xl font-semibold text-red">{sellCount}</p>
              <p className="text-xs text-muted uppercase tracking-wider mt-1">Sell</p>
            </div>
          </div>
        </div>

        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-3">Portfolio Allocation</h3>
          <div className="space-y-3.5">
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-muted">Invested</span>
                <span className="text-foreground font-medium">{(100 - cashPct).toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-blue rounded-full transition-all" style={{ width: `${100 - cashPct}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-muted">Cash</span>
                <span className="text-foreground font-medium">{cashPct.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-amber rounded-full transition-all" style={{ width: `${cashPct}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-muted">Positions</span>
                <span className="text-foreground font-medium">{numPositions} / 10</span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-purple rounded-full transition-all" style={{ width: `${(numPositions / 10) * 100}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
