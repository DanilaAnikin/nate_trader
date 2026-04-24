import type { Position } from "@/lib/types";

interface PositionsTableProps {
  positions: Position[];
}

export default function PositionsTable({ positions }: PositionsTableProps) {
  if (!positions || positions.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 text-center text-muted">
        No open positions
      </div>
    );
  }

  const totalPl = positions.reduce((sum, p) => sum + p.unrealized_pl, 0);

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex justify-between items-center">
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
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-right px-4 py-2">Qty</th>
              <th className="text-right px-4 py-2">Avg Cost</th>
              <th className="text-right px-4 py-2">Current</th>
              <th className="text-right px-4 py-2">Mkt Value</th>
              <th className="text-right px-4 py-2">P&L</th>
              <th className="text-right px-4 py-2">P&L %</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const plColor = p.unrealized_pl >= 0 ? "text-green" : "text-red";
              return (
                <tr key={p.symbol} className="border-b border-border/50 hover:bg-card-hover">
                  <td className="px-4 py-2.5 font-medium">{p.symbol}</td>
                  <td className="px-4 py-2.5 text-right text-secondary">{p.qty}</td>
                  <td className="px-4 py-2.5 text-right text-secondary">
                    ${p.avg_entry_price.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    ${p.current_price.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5 text-right text-secondary">
                    ${p.market_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-medium ${plColor}`}>
                    {p.unrealized_pl >= 0 ? "+" : ""}${p.unrealized_pl.toFixed(2)}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-medium ${plColor}`}>
                    {(p.unrealized_plpc * 100).toFixed(2)}%
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
