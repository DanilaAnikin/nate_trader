"use client";

import { useState } from "react";
import type { SymbolResearch } from "@/lib/types";

interface ResearchTableProps {
  symbols: Record<string, SymbolResearch>;
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    BUY: "bg-green/15 text-green border-green/20",
    HOLD: "bg-amber/15 text-amber border-amber/20",
    SELL: "bg-red/15 text-red border-red/20",
  };
  return (
    <span className={`inline-block px-2.5 py-1 rounded border text-xs font-bold tracking-wide ${styles[action] || ""}`}>
      {action}
    </span>
  );
}

function ScoreBar({ value, max, color, label }: { value: number; max: number; color: string; label: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="min-w-[120px]">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-muted uppercase tracking-wider">{label}</span>
        <span className="text-xs font-semibold text-secondary tabular-nums">{value}<span className="text-muted font-normal">/{max}</span></span>
      </div>
      <div className="w-full h-2 bg-white/[0.04] rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ConfidenceScore({ score }: { score: number }) {
  const color = score >= 65 ? "text-green" : score >= 40 ? "text-amber" : "text-red";
  const bg = score >= 65 ? "bg-green/10 border-green/20" : score >= 40 ? "bg-amber/10 border-amber/20" : "bg-red/10 border-red/20";

  return (
    <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl border ${bg}`}>
      <span className={`text-lg font-bold tabular-nums ${color}`}>{score}</span>
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

  const filters: { key: FilterAction; label: string; count: number; activeClass: string }[] = [
    { key: "ALL", label: "All", count: entries.length, activeClass: "bg-blue/15 text-blue border-blue/25" },
    { key: "BUY", label: "Buy", count: entries.filter(([, d]) => d.confidence?.action === "BUY").length, activeClass: "bg-green/15 text-green border-green/25" },
    { key: "HOLD", label: "Hold", count: entries.filter(([, d]) => d.confidence?.action === "HOLD").length, activeClass: "bg-amber/15 text-amber border-amber/25" },
    { key: "SELL", label: "Sell", count: entries.filter(([, d]) => d.confidence?.action === "SELL").length, activeClass: "bg-red/15 text-red border-red/25" },
  ];

  return (
    <div className="glass-card rounded-lg overflow-hidden">
      {/* Filter buttons */}
      <div className="px-5 py-3 border-b border-white/5 flex items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
              filter === f.key
                ? f.activeClass
                : "border-transparent text-muted hover:text-secondary hover:bg-white/[0.03]"
            }`}
          >
            {f.label} <span className="opacity-60 ml-0.5">{f.count}</span>
          </button>
        ))}
      </div>

      {/* Card-based rows instead of table */}
      <div className="divide-y divide-white/[0.04]">
        {filtered.map(([symbol, data]) => {
          const c = data.confidence;
          const t = data.technicals;
          const isExpanded = expanded === symbol;
          return (
            <div key={symbol}>
              <div
                className="px-5 py-4 hover:bg-white/[0.015] cursor-pointer transition-colors"
                onClick={() => setExpanded(isExpanded ? null : symbol)}
              >
                {/* Top row: symbol, price, action, confidence */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-bold">{symbol}</span>
                      <svg
                        width="14" height="14" viewBox="0 0 14 14"
                        className={`text-muted transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                      >
                        <path d="M3.5 5.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <span className="text-sm text-secondary font-mono">${t.price.toFixed(2)}</span>
                    {t.rsi_14 != null && (
                      <span className="text-xs text-muted">RSI <span className="text-secondary font-medium">{t.rsi_14.toFixed(1)}</span></span>
                    )}
                    <span className={`text-xs font-medium ${t.five_day_return >= 0 ? "text-green" : "text-red"}`}>
                      {t.five_day_return >= 0 ? "+" : ""}{t.five_day_return.toFixed(2)}%
                      <span className="text-muted font-normal ml-0.5">5d</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <ActionBadge action={c.action} />
                    <ConfidenceScore score={c.total} />
                  </div>
                </div>

                {/* Score bars row */}
                <div className="grid grid-cols-3 gap-6">
                  <ScoreBar value={c.technical_score} max={35} color="bg-blue" label="Technical" />
                  <ScoreBar value={c.news_score} max={35} color="bg-purple" label="News" />
                  <ScoreBar value={c.perplexity_score} max={30} color="bg-cyan" label="Perplexity" />
                </div>
              </div>

              {/* Expanded detail */}
              <div
                className={`overflow-hidden transition-all duration-300 ${
                  isExpanded ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
                }`}
              >
                <div className="px-5 py-4 bg-surface border-t border-white/[0.04] text-xs">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Technical Details */}
                    <div>
                      <p className="text-[10px] text-muted uppercase tracking-widest font-semibold mb-3">Technical Indicators</p>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-muted">SMA 20</span>
                          <span className="text-secondary font-medium">
                            {t.sma_20 ? `$${t.sma_20.toFixed(2)}` : "N/A"}
                            {t.above_sma20 != null && (
                              <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded ${t.above_sma20 ? "bg-green/10 text-green" : "bg-red/10 text-red"}`}>
                                {t.above_sma20 ? "ABOVE" : "BELOW"}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">SMA 50</span>
                          <span className="text-secondary font-medium">{t.sma_50 ? `$${t.sma_50.toFixed(2)}` : "N/A"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">MACD / Signal</span>
                          <span className="text-secondary font-medium">{t.macd?.toFixed(2) ?? "N/A"} / {t.macd_signal?.toFixed(2) ?? "N/A"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">Volume Ratio</span>
                          <span className={`font-medium ${(t.volume_ratio ?? 0) >= 1.2 ? "text-green" : "text-secondary"}`}>
                            {t.volume_ratio?.toFixed(2) ?? "N/A"}x
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* News */}
                    <div>
                      <p className="text-[10px] text-muted uppercase tracking-widest font-semibold mb-3">Recent Headlines</p>
                      {data.news_headlines && data.news_headlines.length > 0 ? (
                        <div className="space-y-1.5">
                          {data.news_headlines.slice(0, 3).map((h, i) => (
                            <p key={i} className="text-secondary leading-relaxed line-clamp-2">
                              {h}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted/50 italic">No recent headlines</p>
                      )}
                    </div>

                    {/* Perplexity */}
                    <div>
                      <p className="text-[10px] text-muted uppercase tracking-widest font-semibold mb-3">AI Analysis</p>
                      {data.perplexity ? (
                        <div className="space-y-2">
                          <div>
                            <span className="text-muted">Sentiment: </span>
                            <span className={`font-semibold ${
                              data.perplexity.sentiment === "bullish" ? "text-green"
                              : data.perplexity.sentiment === "bearish" ? "text-red"
                              : "text-amber"
                            }`}>
                              {data.perplexity.sentiment}
                            </span>
                          </div>
                          <p className="text-secondary leading-relaxed">{data.perplexity.key_catalyst}</p>
                          <div className="flex items-start gap-1.5 text-red/60">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
                              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                            <span>{data.perplexity.risk}</span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-muted/50 italic">Not yet analyzed</p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
