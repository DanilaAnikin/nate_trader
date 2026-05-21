"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";
import MetricCard from "@/components/MetricCard";

type Trade = {
  id: number;
  filled_at: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  notional: number;
  realized_pnl: number | null;
};

function money(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function TradesClient({
  accountId,
}: {
  accountId: string | null;
}) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(accountId != null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        const supabase = getSupabaseBrowser();
        const { data, error } = await supabase
          .from("trades")
          .select("id,filled_at,symbol,side,qty,price,notional,realized_pnl")
          .eq("account_id", accountId)
          .order("filled_at", { ascending: false })
          .limit(300);
        if (cancelled) return;
        if (error) {
          setError(true);
        } else {
          setTrades((data ?? []) as Trade[]);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const summary = useMemo(() => {
    const buys = trades.filter((t) => t.side === "buy");
    const sells = trades.filter((t) => t.side === "sell");
    const realized = trades.filter((t) => t.realized_pnl != null);
    const realizedTotal = realized.reduce(
      (s, t) => s + (t.realized_pnl ?? 0),
      0,
    );
    const wins = realized.filter((t) => (t.realized_pnl ?? 0) > 0).length;
    return {
      total: trades.length,
      buyNotional: buys.reduce((s, t) => s + t.notional, 0),
      sellNotional: sells.reduce((s, t) => s + t.notional, 0),
      realizedCount: realized.length,
      realizedTotal,
      winRate: realized.length > 0 ? (wins / realized.length) * 100 : null,
    };
  }, [trades]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Trades</h2>
        <p className="text-xs text-muted mt-0.5">
          Realized trade log for the selected account.
        </p>
      </div>

      {!accountId ? (
        <div className="glass-card p-10 text-center">
          <p className="text-sm text-muted">
            Select an account to see its trades.
          </p>
        </div>
      ) : loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red">Could not load trades.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              label="Total Trades"
              value={`${summary.total}`}
              accent="blue"
              index={0}
            />
            <MetricCard
              label="Buy Volume"
              value={money(summary.buyNotional)}
              accent="purple"
              index={1}
            />
            <MetricCard
              label="Sell Volume"
              value={money(summary.sellNotional)}
              accent="amber"
              index={2}
            />
            <MetricCard
              label="Realized P&L"
              value={
                summary.realizedCount > 0
                  ? money(summary.realizedTotal)
                  : "—"
              }
              subValue={
                summary.winRate != null
                  ? `${summary.winRate.toFixed(0)}% win rate`
                  : "populates with the agent refactor"
              }
              trend={summary.realizedTotal >= 0 ? "up" : "down"}
              accent={summary.realizedTotal >= 0 ? "green" : "red"}
              index={3}
            />
          </div>

          <div className="glass-card p-5">
            <h3 className="text-sm font-medium text-secondary mb-3">
              Trade History
            </h3>
            {trades.length === 0 ? (
              <p className="text-sm text-muted py-6 text-center">
                No trades recorded yet. The Supabase Sync routine populates
                this from Alpaca fills.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-muted uppercase tracking-wider border-b border-border">
                      <th className="text-left font-medium py-2">Date</th>
                      <th className="text-left font-medium py-2">Symbol</th>
                      <th className="text-left font-medium py-2">Side</th>
                      <th className="text-right font-medium py-2">Qty</th>
                      <th className="text-right font-medium py-2">Price</th>
                      <th className="text-right font-medium py-2">Notional</th>
                      <th className="text-right font-medium py-2">Realized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr
                        key={t.id}
                        className="border-b border-border/50 last:border-0"
                      >
                        <td className="py-2 text-muted">
                          {t.filled_at.slice(0, 10)}
                        </td>
                        <td className="py-2 font-medium text-foreground">
                          {t.symbol}
                        </td>
                        <td className="py-2">
                          <span
                            className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ${
                              t.side === "buy"
                                ? "bg-green/10 text-green"
                                : "bg-red/10 text-red"
                            }`}
                          >
                            {t.side.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2 text-right tabular-nums text-foreground">
                          {t.qty}
                        </td>
                        <td className="py-2 text-right tabular-nums text-foreground">
                          {money(t.price)}
                        </td>
                        <td className="py-2 text-right tabular-nums text-foreground">
                          {money(t.notional)}
                        </td>
                        <td
                          className={`py-2 text-right tabular-nums ${
                            t.realized_pnl == null
                              ? "text-muted"
                              : t.realized_pnl >= 0
                                ? "text-green"
                                : "text-red"
                          }`}
                        >
                          {t.realized_pnl == null
                            ? "—"
                            : money(t.realized_pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
