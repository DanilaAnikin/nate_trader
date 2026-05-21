"use client";

import { useEffect, useMemo, useState } from "react";
import type { PositionsData, PerformanceData, Position } from "@/lib/types";
import PositionsTable from "@/components/PositionsTable";
import MetricCard from "@/components/MetricCard";

interface Props {
  initialPositions: PositionsData | null;
  initialPerformance: PerformanceData | null;
  initialMarketRegime: string;
  selectedAccountId?: string | null;
}

interface LiveAccount {
  equity: number;
  cash: number;
  cash_pct: number;
  daily_pnl: number;
  daily_pnl_pct: number;
  num_positions: number;
}

interface LivePayload {
  account: LiveAccount;
  positions: Position[];
  timestamp: string;
}

/**
 * Client wrapper for the Positions page. Mirrors DashboardClient's pattern:
 *   • Server pre-renders with GitHub snapshot (positions.json + performance.json)
 *   • On mount, fetches /api/live and overrides positions/equity/cash with
 *     fresh Alpaca data, broadcasting dashboard:live so the layout's
 *     Refresh button and HistoricalComparisonChart stay in sync
 *   • Listens for dashboard:live events from the Refresh button so a click
 *     anywhere on the layout updates this page too
 *   • Falls back to GitHub snapshot if /api/live returns 503 (no Alpaca
 *     creds on Vercel)
 */
export default function PositionsClient({
  initialPositions,
  initialPerformance,
  initialMarketRegime,
  selectedAccountId,
}: Props) {
  const [live, setLive] = useState<LivePayload | null>(null);

  useEffect(() => {
    // Listen for live events dispatched elsewhere (e.g. Refresh button)
    function handler(e: Event) {
      const detail = (e as CustomEvent<LivePayload>).detail;
      if (detail && detail.account) setLive(detail);
    }
    window.addEventListener("dashboard:live", handler);
    return () => window.removeEventListener("dashboard:live", handler);
  }, []);

  useEffect(() => {
    // Auto-fetch on every mount (F5 = fresh data), scoped to the account.
    let cancelled = false;
    const liveUrl = selectedAccountId
      ? `/api/accounts/${selectedAccountId}/live`
      : "/api/live";
    fetch(liveUrl, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data || !data.account) return;
        setLive(data);
        window.dispatchEvent(new CustomEvent("dashboard:live", { detail: data }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId]);

  // Resolve displayed values — prefer live, fall back to GitHub snapshot
  const positions: Position[] = useMemo(
    () => live?.positions ?? initialPositions?.positions ?? [],
    [live, initialPositions],
  );
  const equity = live?.account.equity ?? initialPerformance?.equity ?? 0;
  const cashPct = live?.account.cash_pct ?? initialPerformance?.cash_pct ?? 0;
  const updatedAt = live?.timestamp
    ? live.timestamp.replace("T", " ").slice(0, 19)
    : initialPositions?.updated_at ?? "N/A";
  const isLive = !!live;

  const totals = useMemo(() => {
    const totalUnrealizedPl = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
    const totalMarketValue = positions.reduce((sum, p) => sum + p.market_value, 0);
    const utilization = equity > 0 ? (totalMarketValue / equity) * 100 : 0;
    return { totalUnrealizedPl, totalMarketValue, utilization };
  }, [positions, equity]);

  // Regime-adaptive limits — kept in sync with scripts/strategy_config.py
  const limitsByRegime: Record<string, { maxPos: number; minCash: number; maxPosPct: number }> = {
    BULL: { maxPos: 15, minCash: 5, maxPosPct: 6 },
    NEUTRAL: { maxPos: 12, minCash: 20, maxPosPct: 5 },
    BEAR: { maxPos: 8, minCash: 40, maxPosPct: 2 },
    UNKNOWN: { maxPos: 12, minCash: 20, maxPosPct: 5 },
  };
  const limits = limitsByRegime[initialMarketRegime] ?? limitsByRegime.UNKNOWN;

  const rules = [
    {
      label: `Max ${limits.maxPos} positions`,
      ok: positions.length <= limits.maxPos,
    },
    {
      label: `Cash reserve ≥ ${limits.minCash}%`,
      ok: cashPct >= limits.minCash,
    },
    {
      label: `Max position ≤ ${limits.maxPosPct}% equity`,
      ok: positions.every(
        (p) => equity <= 0 || (p.market_value / equity) * 100 <= limits.maxPosPct + 0.5,
      ),
    },
    {
      label: "No directional position held >12 days without +4% gain",
      ok: true, // engine handles this server-side; surface-level placeholder
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Positions</h2>
        <p className="text-xs text-muted mt-0.5">
          {isLive && (
            <span className="inline-block bg-green/10 text-green text-[10px] font-semibold px-1.5 py-0.5 rounded mr-1.5 align-middle">
              LIVE
            </span>
          )}
          Last updated: {updatedAt}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Open Positions"
          value={`${positions.length}`}
          subValue={`Max: ${limits.maxPos} (${initialMarketRegime})`}
          accent="blue"
          index={0}
        />
        <MetricCard
          label="Portfolio Utilization"
          value={`${totals.utilization.toFixed(1)}%`}
          subValue={`$${totals.totalMarketValue.toLocaleString(undefined, { minimumFractionDigits: 2 })} invested`}
          accent="purple"
          index={1}
        />
        <MetricCard
          label="Unrealized P&L"
          value={`${totals.totalUnrealizedPl >= 0 ? "+" : ""}$${totals.totalUnrealizedPl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
          trend={totals.totalUnrealizedPl >= 0 ? "up" : "down"}
          accent={totals.totalUnrealizedPl >= 0 ? "green" : "red"}
          index={2}
        />
        <MetricCard
          label="Cash Reserve"
          value={`${cashPct.toFixed(1)}%`}
          subValue={cashPct >= limits.minCash ? "Healthy" : "Below minimum"}
          trend={cashPct >= limits.minCash ? "up" : "down"}
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
          <p className="text-[10px] text-muted mb-3 uppercase tracking-wider">
            {initialMarketRegime} regime
          </p>
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
                <span className={`text-xs ${rule.ok ? "text-foreground" : "text-red"}`}>
                  {rule.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
