"use client";

import { useEffect, useState } from "react";
import type { PerformanceData, ResearchData } from "@/lib/types";
import MetricCard from "@/components/MetricCard";
import EquityChart from "@/components/EquityChart";
import SpyComparison from "@/components/SpyComparison";
import RiskBadge from "@/components/RiskBadge";
import HistoricalComparisonChart from "@/components/HistoricalComparisonChart";

interface Props {
  performance: PerformanceData | null;
  research: ResearchData | null;
}

/**
 * Shape of the data the dashboard actually displays. This may come from
 * the server snapshot (GitHub state file) or from a live Alpaca fetch
 * triggered by the Refresh button.
 */
interface DisplayMetrics {
  equity: number;
  cash: number;
  cashPct: number;
  dailyPnl: number;
  dailyPnlPct: number;
  monthlyPnl: number;
  monthlyPnlPct: number;
  numPositions: number;
  updatedAt: string;
  source: "snapshot" | "live";
}

/**
 * The Refresh button (in the layout top bar) hits /api/live and dispatches
 * a CustomEvent("dashboard:live") with the response payload. We listen
 * for that event here and override the displayed metrics with the live
 * Alpaca values. Without a click, we render the GitHub snapshot.
 */
export default function DashboardClient({ performance, research }: Props) {
  const [live, setLive] = useState<{
    account: {
      equity: number;
      cash: number;
      cash_pct: number;
      daily_pnl: number;
      daily_pnl_pct: number;
      num_positions: number;
    };
    timestamp: string;
  } | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const ce = e as CustomEvent<{
        account: DisplayMetrics & { cash_pct: number; daily_pnl_pct: number; num_positions: number };
        timestamp: string;
      }>;
      if (ce.detail) {
        setLive({
          account: {
            equity: ce.detail.account.equity,
            cash: ce.detail.account.cash,
            cash_pct: ce.detail.account.cash_pct,
            daily_pnl: ce.detail.account.daily_pnl,
            daily_pnl_pct: ce.detail.account.daily_pnl_pct,
            num_positions: ce.detail.account.num_positions,
          },
          timestamp: ce.detail.timestamp,
        });
      }
    }
    window.addEventListener("dashboard:live", handler);
    return () => window.removeEventListener("dashboard:live", handler);
  }, []);

  // Build display metrics — prefer live values when available, fall back to GitHub snapshot
  const snapshotEquity = performance?.equity ?? 0;
  const snapshotCash = performance?.cash ?? 0;
  const dailyHistory = performance?.daily_history ?? [];

  // For monthly P&L we compute from live equity vs the earliest daily_history entry,
  // since /api/live only knows today's account state. Using last-22-day window per
  // the same logic as portfolio.update_performance_state().
  const monthWindow = dailyHistory.length >= 22 ? dailyHistory.slice(-22) : dailyHistory;
  const monthStartEquity = monthWindow[0]?.equity ?? snapshotEquity;

  const liveEquity = live?.account.equity;
  const liveMonthlyPnl =
    liveEquity !== undefined && monthStartEquity > 0
      ? liveEquity - monthStartEquity
      : null;
  const liveMonthlyPnlPct =
    liveMonthlyPnl !== null && monthStartEquity > 0
      ? (liveMonthlyPnl / monthStartEquity) * 100
      : null;

  const display: DisplayMetrics = live
    ? {
        equity: live.account.equity,
        cash: live.account.cash,
        cashPct: live.account.cash_pct,
        dailyPnl: live.account.daily_pnl,
        dailyPnlPct: live.account.daily_pnl_pct,
        monthlyPnl: liveMonthlyPnl ?? performance?.monthly_pnl ?? 0,
        monthlyPnlPct: liveMonthlyPnlPct ?? performance?.monthly_pnl_pct ?? 0,
        numPositions: live.account.num_positions,
        updatedAt: live.timestamp.replace("T", " ").slice(0, 19),
        source: "live",
      }
    : {
        equity: snapshotEquity,
        cash: snapshotCash,
        cashPct: performance?.cash_pct ?? 0,
        dailyPnl: performance?.daily_pnl ?? 0,
        dailyPnlPct: performance?.daily_pnl_pct ?? 0,
        monthlyPnl: performance?.monthly_pnl ?? 0,
        monthlyPnlPct: performance?.monthly_pnl_pct ?? 0,
        numPositions: performance?.num_positions ?? 0,
        updatedAt: performance?.updated_at ?? "N/A",
        source: "snapshot",
      };

  const riskTier = performance?.risk_tier ?? "NORMAL";
  const spyMonthly = research?.spy?.monthly_return ?? 0;
  const marketRegime = research?.spy?.market_regime ?? "UNKNOWN";

  const symbols = research?.symbols ?? {};
  const symbolEntries = Object.values(symbols).filter((s) => !s.error && s.confidence);
  const buyCount = symbolEntries.filter((s) => s.confidence.action === "BUY").length;
  const holdCount = symbolEntries.filter((s) => s.confidence.action === "HOLD").length;
  const sellCount = symbolEntries.filter((s) => s.confidence.action === "SELL").length;

  // Regime-adaptive limits mirror scripts/strategy_config.py
  const limitsByRegime: Record<string, { maxPos: number; minCash: number }> = {
    BULL: { maxPos: 15, minCash: 5 },
    NEUTRAL: { maxPos: 12, minCash: 20 },
    BEAR: { maxPos: 8, minCash: 40 },
    UNKNOWN: { maxPos: 12, minCash: 20 },
  };
  const activeLimits = limitsByRegime[marketRegime] ?? limitsByRegime.UNKNOWN;

  const rules = [
    { label: `Cash Reserve ≥ ${activeLimits.minCash}%`, ok: display.cashPct >= activeLimits.minCash },
    { label: `Max ${activeLimits.maxPos} Positions`, ok: display.numPositions <= activeLimits.maxPos },
    { label: "Risk Tier: NORMAL", ok: riskTier === "NORMAL" },
    { label: "Daily Loss < 3%", ok: display.dailyPnlPct > -3 },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Dashboard</h2>
          <p className="text-xs text-muted mt-0.5">
            {display.source === "live" && (
              <span className="inline-block bg-green/10 text-green text-[10px] font-semibold px-1.5 py-0.5 rounded mr-1.5 align-middle">LIVE</span>
            )}
            Last updated: {display.updatedAt}
          </p>
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
          value={`$${display.equity.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          subValue={`${display.numPositions} positions`}
          accent="blue"
          index={0}
        />
        <MetricCard
          label="Cash Reserve"
          value={`${display.cashPct.toFixed(1)}%`}
          subValue={`$${display.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          trend={display.cashPct >= activeLimits.minCash ? "up" : "down"}
          accent="amber"
          index={1}
        />
        <MetricCard
          label="Daily P&L"
          value={`${display.dailyPnl >= 0 ? "+" : ""}$${display.dailyPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          subValue={`${display.dailyPnlPct >= 0 ? "+" : ""}${display.dailyPnlPct.toFixed(2)}%`}
          trend={display.dailyPnl >= 0 ? "up" : "down"}
          accent="green"
          index={2}
        />
        <MetricCard
          label="Monthly P&L"
          value={`${display.monthlyPnlPct >= 0 ? "+" : ""}${display.monthlyPnlPct.toFixed(2)}%`}
          subValue={`SPY: ${spyMonthly >= 0 ? "+" : ""}${spyMonthly.toFixed(2)}%`}
          trend={display.monthlyPnlPct >= 0 ? "up" : "down"}
          accent={display.monthlyPnlPct >= 0 ? "green" : "red"}
          index={3}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3">
          <EquityChart data={dailyHistory} />
        </div>
        <div className="lg:col-span-2">
          <SpyComparison portfolioReturn={display.monthlyPnlPct} spyReturn={spyMonthly} />
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
                <span className="text-foreground font-medium">{(100 - display.cashPct).toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-blue rounded-full transition-all" style={{ width: `${100 - display.cashPct}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-muted">Cash</span>
                <span className="text-foreground font-medium">{display.cashPct.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-amber rounded-full transition-all" style={{ width: `${display.cashPct}%` }} />
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-muted">Positions</span>
                <span className="text-foreground font-medium">
                  {display.numPositions} / {activeLimits.maxPos}
                </span>
              </div>
              <div className="h-2 bg-surface rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple rounded-full transition-all"
                  style={{ width: `${Math.min(100, (display.numPositions / activeLimits.maxPos) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <HistoricalComparisonChart portfolioHistory={dailyHistory} />
    </div>
  );
}
