import type { Position } from "@/lib/types";
import { V11_POLICY } from "@/lib/v11-policy";

interface PositionsTableProps {
  positions: Position[];
  equity?: number;
}

export default function PositionsTable({ positions, equity = 0 }: PositionsTableProps) {
  if (!positions || positions.length === 0) {
    return (
      <div className="glass-card p-10 text-center">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-4 opacity-30">
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
          <path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2" />
        </svg>
        <p className="text-foreground font-medium mb-2">No Open Positions</p>
        <p className="text-xs text-muted max-w-sm mx-auto">
          No broker positions are open. V11 forms a diversified top-{V11_POLICY.topN} portfolio from {V11_POLICY.signal} when its trend and risk gates permit exposure.
        </p>
      </div>
    );
  }

  const totalPl = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);
  const totalValue = positions.reduce((sum, p) => sum + p.market_value, 0);

  return (
    <div className="glass-card overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border flex justify-between items-center">
        <h3 className="text-sm font-medium text-secondary">
          Open Positions ({positions.length})
        </h3>
        <span
          className={`text-sm font-semibold ${totalPl >= 0 ? "text-green" : "text-red"}`}
        >
          {totalPl >= 0 ? "+" : ""}${totalPl.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted uppercase tracking-wider border-b border-border">
              <th className="text-left px-5 py-3">Symbol</th>
              <th className="text-right px-4 py-3">Qty</th>
              <th className="text-right px-4 py-3">Avg Cost</th>
              <th className="text-right px-4 py-3">Current</th>
              <th className="text-right px-4 py-3">Weight</th>
              <th className="text-right px-4 py-3">Mkt Value</th>
              <th className="text-right px-4 py-3">P&L</th>
              <th className="text-right px-5 py-3">P&L %</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              // The shared Position contract stores percentage points
              // (1.85 means +1.85%), for both repository and Alpaca sources.
              const plPct = p.unrealized_plpc;
              const isPositive = p.unrealized_pl >= 0;
              const plColor = isPositive ? "text-green" : "text-red";
              const weight = equity > 0 ? (Math.abs(p.market_value) / equity) * 100 : 0;
              const barWidth = Math.min(Math.abs(plPct) * 5, 100);

              return (
                <tr key={p.symbol} className="border-b border-border/50 hover:bg-surface transition-colors">
                  <td className="px-5 py-3 font-medium text-foreground">{p.symbol}</td>
                  <td className="px-4 py-3 text-right text-secondary">{p.qty}</td>
                  <td className="px-4 py-3 text-right text-secondary">${p.avg_entry_price.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right text-foreground">${p.current_price.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={weight > V11_POLICY.maxPositionPct ? "text-amber font-medium" : "text-secondary"}>
                      {weight.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-secondary">
                    ${p.market_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-surface rounded-full overflow-hidden hidden sm:block">
                        <div
                          className={`h-full rounded-full ${isPositive ? "bg-green" : "bg-red"}`}
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                      <span className={`font-medium ${plColor}`}>
                        {isPositive ? "+" : ""}${p.unrealized_pl.toFixed(2)}
                      </span>
                    </div>
                  </td>
                  <td className={`px-5 py-3 text-right font-medium ${plColor}`}>
                    {isPositive ? "+" : ""}{plPct.toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-border bg-surface/50">
              <td className="px-5 py-3 text-xs text-muted font-medium" colSpan={5}>Total</td>
              <td className="px-4 py-3 text-right text-xs font-medium text-secondary">
                ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </td>
              <td className={`px-4 py-3 text-right text-xs font-medium ${totalPl >= 0 ? "text-green" : "text-red"}`}>
                {totalPl >= 0 ? "+" : ""}${totalPl.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </td>
              <td className="px-5 py-3" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
