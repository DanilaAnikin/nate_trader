"use client";

import { useState } from "react";
import type { MostActive, TopMover, SymbolResearch } from "@/lib/types";

interface ScreenerTableProps {
  mostActive: MostActive[];
  topMovers: TopMover[];
  trending: string[];
  scoredCandidates: Record<string, SymbolResearch>;
}

type Tab = "scored" | "active" | "movers" | "trending";

export default function ScreenerTable({
  mostActive,
  topMovers,
  trending,
  scoredCandidates,
}: ScreenerTableProps) {
  const [tab, setTab] = useState<Tab>("scored");

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "scored", label: "Scored", count: Object.keys(scoredCandidates || {}).length },
    { key: "active", label: "Most Active", count: mostActive?.length || 0 },
    { key: "movers", label: "Top Movers", count: topMovers?.length || 0 },
    { key: "trending", label: "Trending", count: trending?.length || 0 },
  ];

  return (
    <div className="glass-card rounded-lg overflow-hidden">
      {/* Pill-style tabs */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200 ${
              tab === t.key
                ? "bg-blue/15 text-blue"
                : "text-muted hover:text-secondary hover:bg-white/[0.03]"
            }`}
          >
            {t.label}
            <span className={`ml-1.5 ${tab === t.key ? "text-blue/70" : "text-muted/50"}`}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        {tab === "scored" && <ScoredTable data={scoredCandidates} />}
        {tab === "active" && <ActiveTable data={mostActive} />}
        {tab === "movers" && <MoversTable data={topMovers} />}
        {tab === "trending" && <TrendingList data={trending} />}
      </div>
    </div>
  );
}

function ScoreBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="w-12 h-1.5 bg-border/50 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums">{value}</span>
    </div>
  );
}

function ScoredTable({ data }: { data: Record<string, SymbolResearch> }) {
  if (!data || Object.keys(data).length === 0) {
    return <p className="p-8 text-center text-muted">No scored candidates</p>;
  }

  const sorted = Object.entries(data)
    .filter(([, d]) => d.confidence)
    .sort(([, a], [, b]) => (b.confidence?.total ?? 0) - (a.confidence?.total ?? 0));

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted uppercase tracking-wider border-b border-white/5">
          <th className="text-left px-4 py-2.5">Symbol</th>
          <th className="text-right px-4 py-2.5">Price</th>
          <th className="text-left px-4 py-2.5">Score</th>
          <th className="text-center px-4 py-2.5">Action</th>
          <th className="text-right px-4 py-2.5">RSI</th>
          <th className="text-right px-4 py-2.5">5d Ret</th>
          <th className="text-right px-4 py-2.5">Vol Ratio</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(([symbol, d]) => {
          const actionColor =
            d.confidence.action === "BUY"
              ? "bg-green/15 text-green"
              : d.confidence.action === "SELL"
              ? "bg-red/15 text-red"
              : "bg-amber/15 text-amber";
          return (
            <tr key={symbol} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
              <td className="px-4 py-3 font-medium">{symbol}</td>
              <td className="px-4 py-3 text-right">${d.technicals.price.toFixed(2)}</td>
              <td className="px-4 py-3">
                <ScoreBar value={d.confidence.total} max={100} color={
                  d.confidence.total >= 65 ? "bg-green" : d.confidence.total >= 40 ? "bg-amber" : "bg-red"
                } />
              </td>
              <td className="px-4 py-3 text-center">
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${actionColor}`}>
                  {d.confidence.action}
                </span>
              </td>
              <td className="px-4 py-3 text-right text-secondary">
                {d.technicals.rsi_14?.toFixed(1) ?? "N/A"}
              </td>
              <td
                className={`px-4 py-3 text-right ${
                  d.technicals.five_day_return >= 0 ? "text-green" : "text-red"
                }`}
              >
                {d.technicals.five_day_return >= 0 ? "+" : ""}
                {d.technicals.five_day_return.toFixed(2)}%
              </td>
              <td className="px-4 py-3 text-right text-secondary">
                {d.technicals.volume_ratio?.toFixed(2) ?? "N/A"}x
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ActiveTable({ data }: { data: MostActive[] }) {
  if (!data || data.length === 0) {
    return <p className="p-8 text-center text-muted">No data</p>;
  }
  const maxVol = Math.max(...data.map(d => d.volume));
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted uppercase tracking-wider border-b border-white/5">
          <th className="text-left px-4 py-2.5">Symbol</th>
          <th className="text-left px-4 py-2.5">Volume</th>
          <th className="text-right px-4 py-2.5">Trades</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => {
          const volPct = maxVol > 0 ? (d.volume / maxVol) * 100 : 0;
          return (
            <tr key={d.symbol} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
              <td className="px-4 py-3 font-medium">{d.symbol}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 bg-border/50 rounded-full overflow-hidden">
                    <div className="h-full bg-blue rounded-full" style={{ width: `${volPct}%` }} />
                  </div>
                  <span className="text-secondary text-xs">{(d.volume / 1e6).toFixed(1)}M</span>
                </div>
              </td>
              <td className="px-4 py-3 text-right text-secondary">
                {d.trade_count.toLocaleString()}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MoversTable({ data }: { data: TopMover[] }) {
  if (!data || data.length === 0) {
    return <p className="p-8 text-center text-muted">No data</p>;
  }

  const gainers = data.filter(d => d.change_pct >= 0).sort((a, b) => b.change_pct - a.change_pct);
  const losers = data.filter(d => d.change_pct < 0).sort((a, b) => a.change_pct - b.change_pct);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-white/5">
      {/* Gainers */}
      <div>
        <div className="px-4 py-2 border-b border-white/5">
          <span className="text-xs text-green font-medium uppercase tracking-wider">Gainers ({gainers.length})</span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {gainers.map((d, i) => (
              <tr key={`g-${d.symbol}-${i}`} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-2.5 font-medium">{d.symbol}</td>
                <td className="px-4 py-2.5 text-right text-secondary">${d.price.toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-green font-medium">
                  +{d.change_pct.toFixed(2)}%
                </td>
              </tr>
            ))}
            {gainers.length === 0 && (
              <tr><td className="px-4 py-4 text-center text-muted" colSpan={3}>None</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Losers */}
      <div>
        <div className="px-4 py-2 border-b border-white/5">
          <span className="text-xs text-red font-medium uppercase tracking-wider">Losers ({losers.length})</span>
        </div>
        <table className="w-full text-sm">
          <tbody>
            {losers.map((d, i) => (
              <tr key={`l-${d.symbol}-${i}`} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-2.5 font-medium">{d.symbol}</td>
                <td className="px-4 py-2.5 text-right text-secondary">${d.price.toFixed(2)}</td>
                <td className="px-4 py-2.5 text-right text-red font-medium">
                  {d.change_pct.toFixed(2)}%
                </td>
              </tr>
            ))}
            {losers.length === 0 && (
              <tr><td className="px-4 py-4 text-center text-muted" colSpan={3}>None</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TrendingList({ data }: { data: string[] }) {
  if (!data || data.length === 0) {
    return <p className="p-8 text-center text-muted">No trending tickers</p>;
  }
  return (
    <div className="p-5">
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
        {data.map((t, i) => (
          <div
            key={t}
            className="flex flex-col items-center justify-center p-3 rounded-lg bg-purple/[0.06] border border-purple/10 hover:border-purple/25 transition-all duration-200 cursor-default"
          >
            <span className="text-[10px] text-muted mb-0.5">#{i + 1}</span>
            <span className="text-sm font-semibold text-purple">{t}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
