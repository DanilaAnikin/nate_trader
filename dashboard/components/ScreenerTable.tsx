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
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="flex border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm transition-colors ${
              tab === t.key
                ? "text-blue border-b-2 border-blue font-medium"
                : "text-muted hover:text-secondary"
            }`}
          >
            {t.label} ({t.count})
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

function ScoredTable({ data }: { data: Record<string, SymbolResearch> }) {
  if (!data || Object.keys(data).length === 0) {
    return <p className="p-6 text-center text-muted">No scored candidates</p>;
  }

  const sorted = Object.entries(data)
    .filter(([, d]) => d.confidence)
    .sort(([, a], [, b]) => (b.confidence?.total ?? 0) - (a.confidence?.total ?? 0));

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted uppercase tracking-wider border-b border-border">
          <th className="text-left px-4 py-2">Symbol</th>
          <th className="text-right px-4 py-2">Price</th>
          <th className="text-right px-4 py-2">Score</th>
          <th className="text-center px-4 py-2">Action</th>
          <th className="text-right px-4 py-2">RSI</th>
          <th className="text-right px-4 py-2">5d Ret</th>
          <th className="text-right px-4 py-2">Vol Ratio</th>
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
            <tr key={symbol} className="border-b border-border/50 hover:bg-card-hover">
              <td className="px-4 py-2.5 font-medium">{symbol}</td>
              <td className="px-4 py-2.5 text-right">${d.technicals.price.toFixed(2)}</td>
              <td className="px-4 py-2.5 text-right font-semibold">{d.confidence.total}</td>
              <td className="px-4 py-2.5 text-center">
                <span className={`px-2 py-0.5 rounded text-xs font-semibold ${actionColor}`}>
                  {d.confidence.action}
                </span>
              </td>
              <td className="px-4 py-2.5 text-right text-secondary">
                {d.technicals.rsi_14?.toFixed(1) ?? "N/A"}
              </td>
              <td
                className={`px-4 py-2.5 text-right ${
                  d.technicals.five_day_return >= 0 ? "text-green" : "text-red"
                }`}
              >
                {d.technicals.five_day_return >= 0 ? "+" : ""}
                {d.technicals.five_day_return.toFixed(2)}%
              </td>
              <td className="px-4 py-2.5 text-right text-secondary">
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
    return <p className="p-6 text-center text-muted">No data</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted uppercase tracking-wider border-b border-border">
          <th className="text-left px-4 py-2">Symbol</th>
          <th className="text-right px-4 py-2">Volume</th>
          <th className="text-right px-4 py-2">Trades</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.symbol} className="border-b border-border/50 hover:bg-card-hover">
            <td className="px-4 py-2.5 font-medium">{d.symbol}</td>
            <td className="px-4 py-2.5 text-right text-secondary">
              {d.volume.toLocaleString()}
            </td>
            <td className="px-4 py-2.5 text-right text-secondary">
              {d.trade_count.toLocaleString()}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MoversTable({ data }: { data: TopMover[] }) {
  if (!data || data.length === 0) {
    return <p className="p-6 text-center text-muted">No data</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted uppercase tracking-wider border-b border-border">
          <th className="text-left px-4 py-2">Symbol</th>
          <th className="text-right px-4 py-2">Price</th>
          <th className="text-right px-4 py-2">Change %</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d, i) => (
          <tr key={`${d.symbol}-${i}`} className="border-b border-border/50 hover:bg-card-hover">
            <td className="px-4 py-2.5 font-medium">{d.symbol}</td>
            <td className="px-4 py-2.5 text-right">${d.price.toFixed(2)}</td>
            <td
              className={`px-4 py-2.5 text-right font-medium ${
                d.change_pct >= 0 ? "text-green" : "text-red"
              }`}
            >
              {d.change_pct >= 0 ? "+" : ""}
              {d.change_pct.toFixed(2)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrendingList({ data }: { data: string[] }) {
  if (!data || data.length === 0) {
    return <p className="p-6 text-center text-muted">No trending tickers</p>;
  }
  return (
    <div className="p-4 flex flex-wrap gap-2">
      {data.map((t) => (
        <span
          key={t}
          className="px-3 py-1.5 bg-purple/10 text-purple border border-purple/20 rounded-md text-sm font-medium"
        >
          {t}
        </span>
      ))}
    </div>
  );
}
