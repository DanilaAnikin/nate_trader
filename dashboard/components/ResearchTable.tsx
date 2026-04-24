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

export default function ResearchTable({ symbols }: ResearchTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (!symbols || Object.keys(symbols).length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 text-center text-muted">
        No research data available
      </div>
    );
  }

  const entries = Object.entries(symbols)
    .filter(([, data]) => !data.error)
    .sort(([, a], [, b]) => (b.confidence?.total ?? 0) - (a.confidence?.total ?? 0));

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted uppercase tracking-wider border-b border-border">
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-right px-4 py-2">Price</th>
              <th className="text-right px-4 py-2">Tech</th>
              <th className="text-right px-4 py-2">News</th>
              <th className="text-right px-4 py-2">Perplexity</th>
              <th className="text-right px-4 py-2">Total</th>
              <th className="text-center px-4 py-2">Action</th>
              <th className="text-right px-4 py-2">RSI</th>
              <th className="text-right px-4 py-2">5d Ret</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([symbol, data]) => {
              const c = data.confidence;
              const t = data.technicals;
              const isExpanded = expanded === symbol;
              return (
                <tr key={symbol} className="border-b border-border/50 group">
                  <td colSpan={9} className="p-0">
                    <div
                      className="grid hover:bg-card-hover cursor-pointer"
                      style={{ gridTemplateColumns: "1fr repeat(7, auto) auto" }}
                      onClick={() => setExpanded(isExpanded ? null : symbol)}
                    >
                      <span className="px-4 py-2.5 font-medium">{symbol}</span>
                      <span className="px-4 py-2.5 text-right">
                        ${t.price.toFixed(2)}
                      </span>
                      <span className="px-4 py-2.5 text-right text-secondary">
                        {c.technical_score}/35
                      </span>
                      <span className="px-4 py-2.5 text-right text-secondary">
                        {c.news_score}/35
                      </span>
                      <span className="px-4 py-2.5 text-right text-secondary">
                        {c.perplexity_score}/30
                      </span>
                      <span className="px-4 py-2.5 text-right font-semibold">
                        {c.total}
                      </span>
                      <span className="px-4 py-2.5 text-center">
                        <ActionBadge action={c.action} />
                      </span>
                      <span className="px-4 py-2.5 text-right text-secondary">
                        {t.rsi_14?.toFixed(1) ?? "N/A"}
                      </span>
                      <span
                        className={`px-4 py-2.5 text-right ${
                          t.five_day_return >= 0 ? "text-green" : "text-red"
                        }`}
                      >
                        {t.five_day_return >= 0 ? "+" : ""}
                        {t.five_day_return.toFixed(2)}%
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="px-4 py-3 bg-[var(--bg-secondary)] border-t border-border/50 text-xs space-y-2">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <div>
                            <span className="text-muted">SMA 20:</span>{" "}
                            {t.sma_20 ? `$${t.sma_20.toFixed(2)}` : "N/A"}
                            {t.above_sma20 != null && (
                              <span className={t.above_sma20 ? "text-green" : "text-red"}>
                                {t.above_sma20 ? " (above)" : " (below)"}
                              </span>
                            )}
                          </div>
                          <div>
                            <span className="text-muted">SMA 50:</span>{" "}
                            {t.sma_50 ? `$${t.sma_50.toFixed(2)}` : "N/A"}
                          </div>
                          <div>
                            <span className="text-muted">MACD:</span>{" "}
                            {t.macd?.toFixed(2) ?? "N/A"} / {t.macd_signal?.toFixed(2) ?? "N/A"}
                          </div>
                          <div>
                            <span className="text-muted">Vol Ratio:</span>{" "}
                            {t.volume_ratio?.toFixed(2) ?? "N/A"}x
                          </div>
                        </div>
                        {data.news_headlines && data.news_headlines.length > 0 && (
                          <div>
                            <p className="text-muted mb-1">Headlines:</p>
                            {data.news_headlines.map((h, i) => (
                              <p key={i} className="text-secondary truncate">
                                - {h}
                              </p>
                            ))}
                          </div>
                        )}
                        {data.perplexity && (
                          <div>
                            <p className="text-muted mb-1">
                              Perplexity ({data.perplexity.sentiment}):
                            </p>
                            <p className="text-secondary">{data.perplexity.key_catalyst}</p>
                            <p className="text-red/80 mt-0.5">Risk: {data.perplexity.risk}</p>
                          </div>
                        )}
                      </div>
                    )}
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
