"use client";

import { useState } from "react";
import type { SymbolResearch } from "@/lib/types";

interface ResearchTableProps {
  symbols: Record<string, SymbolResearch>;
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    BUY: "bg-green/15 text-green",
    HOLD: "bg-amber/15 text-amber",
    SELL: "bg-red/15 text-red",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${styles[action] || ""}`}>
      {action}
    </span>
  );
}

function ScoreBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 bg-border/50 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-secondary tabular-nums">{value}/{max}</span>
    </div>
  );
}

function ConfidenceGauge({ score }: { score: number }) {
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(score / 100, 1);
  const offset = circumference * (1 - pct);
  const color = score >= 65 ? "var(--accent-green)" : score >= 40 ? "var(--accent-amber)" : "var(--accent-red)";

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="40" height="40" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="3" />
        <circle
          cx="20" cy="20" r={radius} fill="none" stroke={color} strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 20 20)"
        />
      </svg>
      <span className="absolute text-xs font-bold" style={{ color }}>{score}</span>
    </div>
  );
}

type FilterAction = "ALL" | "BUY" | "HOLD" | "SELL";

export default function ResearchTable({ symbols }: ResearchTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterAction>("ALL");

  if (!symbols || Object.keys(symbols).length === 0) {
    return (
      <div className="glass-card rounded-lg p-8 text-center">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 opacity-40">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <p className="text-secondary font-medium">No research data available</p>
        <p className="text-xs text-muted mt-1">Run the pre-market research routine to populate signals</p>
      </div>
    );
  }

  const entries = Object.entries(symbols)
    .filter(([, data]) => !data.error)
    .sort(([, a], [, b]) => (b.confidence?.total ?? 0) - (a.confidence?.total ?? 0));

  const filtered = filter === "ALL" ? entries : entries.filter(([, d]) => d.confidence?.action === filter);

  const filters: { key: FilterAction; label: string; count: number }[] = [
    { key: "ALL", label: "All", count: entries.length },
    { key: "BUY", label: "Buy", count: entries.filter(([, d]) => d.confidence?.action === "BUY").length },
    { key: "HOLD", label: "Hold", count: entries.filter(([, d]) => d.confidence?.action === "HOLD").length },
    { key: "SELL", label: "Sell", count: entries.filter(([, d]) => d.confidence?.action === "SELL").length },
  ];

  return (
    <div className="glass-card rounded-lg overflow-hidden">
      {/* Filter buttons */}
      <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
              filter === f.key
                ? f.key === "BUY" ? "bg-green/15 text-green"
                  : f.key === "SELL" ? "bg-red/15 text-red"
                  : f.key === "HOLD" ? "bg-amber/15 text-amber"
                  : "bg-blue/15 text-blue"
                : "text-muted hover:text-secondary hover:bg-white/[0.03]"
            }`}
          >
            {f.label} ({f.count})
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted uppercase tracking-wider border-b border-white/5">
              <th className="text-left px-4 py-2.5">Symbol</th>
              <th className="text-right px-4 py-2.5">Price</th>
              <th className="text-left px-4 py-2.5">Technical</th>
              <th className="text-left px-4 py-2.5">News</th>
              <th className="text-left px-4 py-2.5">Perplexity</th>
              <th className="text-center px-4 py-2.5">Score</th>
              <th className="text-center px-4 py-2.5">Action</th>
              <th className="text-right px-4 py-2.5">RSI</th>
              <th className="text-right px-4 py-2.5">5d Ret</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(([symbol, data]) => {
              const c = data.confidence;
              const t = data.technicals;
              const isExpanded = expanded === symbol;
              return (
                <tr key={symbol} className="border-b border-white/[0.03] group">
                  <td colSpan={9} className="p-0">
                    <div
                      className="grid hover:bg-white/[0.02] cursor-pointer transition-colors items-center"
                      style={{ gridTemplateColumns: "1fr auto auto auto auto auto auto auto auto" }}
                      onClick={() => setExpanded(isExpanded ? null : symbol)}
                    >
                      <span className="px-4 py-3 font-medium flex items-center gap-2">
                        {symbol}
                        <svg
                          width="12" height="12" viewBox="0 0 12 12"
                          className={`text-muted transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                        >
                          <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                      <span className="px-4 py-3 text-right">${t.price.toFixed(2)}</span>
                      <span className="px-4 py-3">
                        <ScoreBar value={c.technical_score} max={35} color="bg-blue" />
                      </span>
                      <span className="px-4 py-3">
                        <ScoreBar value={c.news_score} max={35} color="bg-purple" />
                      </span>
                      <span className="px-4 py-3">
                        <ScoreBar value={c.perplexity_score} max={30} color="bg-cyan" />
                      </span>
                      <span className="px-4 py-3 text-center">
                        <ConfidenceGauge score={c.total} />
                      </span>
                      <span className="px-4 py-3 text-center">
                        <ActionBadge action={c.action} />
                      </span>
                      <span className="px-4 py-3 text-right text-secondary">
                        {t.rsi_14?.toFixed(1) ?? "N/A"}
                      </span>
                      <span
                        className={`px-4 py-3 text-right ${
                          t.five_day_return >= 0 ? "text-green" : "text-red"
                        }`}
                      >
                        {t.five_day_return >= 0 ? "+" : ""}
                        {t.five_day_return.toFixed(2)}%
                      </span>
                    </div>
                    {/* Expanded detail */}
                    <div
                      className={`overflow-hidden transition-all duration-300 ${
                        isExpanded ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
                      }`}
                    >
                      <div className="px-4 py-4 bg-surface border-t border-white/[0.03] text-xs">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {/* Technical Details */}
                          <div className="space-y-1.5">
                            <p className="text-muted uppercase tracking-wider font-medium mb-2">Technicals</p>
                            <div className="flex justify-between">
                              <span className="text-muted">SMA 20:</span>
                              <span className="text-secondary">
                                {t.sma_20 ? `$${t.sma_20.toFixed(2)}` : "N/A"}
                                {t.above_sma20 != null && (
                                  <span className={t.above_sma20 ? "text-green ml-1" : "text-red ml-1"}>
                                    {t.above_sma20 ? "above" : "below"}
                                  </span>
                                )}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted">SMA 50:</span>
                              <span className="text-secondary">{t.sma_50 ? `$${t.sma_50.toFixed(2)}` : "N/A"}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted">MACD:</span>
                              <span className="text-secondary">{t.macd?.toFixed(2) ?? "N/A"} / {t.macd_signal?.toFixed(2) ?? "N/A"}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted">Vol Ratio:</span>
                              <span className="text-secondary">{t.volume_ratio?.toFixed(2) ?? "N/A"}x</span>
                            </div>
                          </div>

                          {/* News */}
                          <div>
                            <p className="text-muted uppercase tracking-wider font-medium mb-2">Headlines</p>
                            {data.news_headlines && data.news_headlines.length > 0 ? (
                              <div className="space-y-1">
                                {data.news_headlines.slice(0, 3).map((h, i) => (
                                  <p key={i} className="text-secondary truncate">
                                    {h}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <p className="text-muted/60">No recent headlines</p>
                            )}
                          </div>

                          {/* Perplexity */}
                          <div>
                            <p className="text-muted uppercase tracking-wider font-medium mb-2">Perplexity Analysis</p>
                            {data.perplexity ? (
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-2">
                                  <span className="text-muted">Sentiment:</span>
                                  <span className={
                                    data.perplexity.sentiment === "bullish" ? "text-green"
                                    : data.perplexity.sentiment === "bearish" ? "text-red"
                                    : "text-amber"
                                  }>
                                    {data.perplexity.sentiment}
                                  </span>
                                </div>
                                <p className="text-secondary">{data.perplexity.key_catalyst}</p>
                                <p className="text-red/70">Risk: {data.perplexity.risk}</p>
                              </div>
                            ) : (
                              <p className="text-muted/60">Not yet analyzed</p>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
