"use client";

import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import type { DailyHistory } from "@/lib/types";

interface EquityChartProps {
  data: DailyHistory[];
}

/**
 * Three-curve portfolio chart on a shared X-axis:
 *
 *   • Equity    — blue,  filled area, left $ Y-axis
 *   • Cash      — amber, line,        left $ Y-axis
 *   • Positions — purple, stepped,    right count Y-axis
 *
 * Colors match the Portfolio Allocation card on the dashboard so the
 * visual language is consistent. Positions live on a second Y-axis
 * because they're a count (0–15) and would otherwise be flattened
 * against the dollar scale.
 *
 * Older daily_history entries (written before cash/num_positions
 * tracking landed) come through with those fields undefined — recharts
 * skips them and the lines just start where the data starts.
 */
export default function EquityChart({ data }: EquityChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="glass-card p-6 h-80 flex items-center justify-center">
        <div className="text-center">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto mb-3 opacity-30"
          >
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
            <polyline points="16 7 22 7 22 13" />
          </svg>
          <p className="text-secondary text-sm font-medium">No history yet</p>
          <p className="text-muted text-xs mt-1">Data will appear after the first trading day</p>
        </div>
      </div>
    );
  }

  if (data.length === 1) {
    const eq = data[0].equity;
    return (
      <div className="glass-card p-6 h-80 flex flex-col items-center justify-center">
        <p className="text-xs text-muted uppercase tracking-wider mb-2">Portfolio Equity</p>
        <p className="text-4xl font-semibold text-blue">
          ${eq.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </p>
        <p className="text-xs text-muted mt-3">
          Tracking begins — chart will populate with daily data
        </p>
        <div className="flex items-center gap-1.5 mt-4 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-blue animate-pulse-dot" />
          Recording since {data[0].date}
        </div>
      </div>
    );
  }

  const formatted = data.map((d) => ({
    date: d.date.slice(5), // MM-DD
    equity: d.equity,
    cash: typeof d.cash === "number" ? d.cash : null,
    positions: typeof d.num_positions === "number" ? d.num_positions : null,
  }));

  const startingEquity = data[0].equity;

  // Compact dollar formatter for axis labels
  const fmtDollars = (v: number) => {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  };

  return (
    <div className="glass-card p-5">
      <h3 className="text-sm font-medium text-secondary mb-4">Portfolio Curves</h3>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={formatted} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#007aff" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#007aff" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#f0f0f2" strokeDasharray="none" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#86868b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          {/* Left axis: dollars (equity + cash) */}
          <YAxis
            yAxisId="dollars"
            tick={{ fill: "#86868b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={fmtDollars}
            domain={["dataMin - 5000", "dataMax + 5000"]}
          />
          {/* Right axis: position count */}
          <YAxis
            yAxisId="positions"
            orientation="right"
            tick={{ fill: "#86868b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${Math.round(v)}`}
            domain={[0, "dataMax + 2"]}
            allowDecimals={false}
            width={36}
          />
          <ReferenceLine
            yAxisId="dollars"
            y={startingEquity}
            stroke="#d2d2d7"
            strokeDasharray="4 4"
            label={{
              value: "Start",
              fill: "#86868b",
              fontSize: 10,
              position: "insideTopRight",
            }}
          />
          <Tooltip
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #e5e5e7",
              borderRadius: 10,
              color: "#1d1d1f",
              fontSize: 12,
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            }}
            formatter={(value, name) => {
              if (value === null || value === undefined) return ["—", String(name)];
              const n = typeof value === "number" ? value : Number(value);
              if (Number.isNaN(n)) return ["—", String(name)];
              if (name === "Positions") return [Math.round(n).toString(), String(name)];
              return [`$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, String(name)];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} iconType="line" />
          <Area
            yAxisId="dollars"
            type="monotone"
            dataKey="equity"
            name="Equity"
            stroke="#007aff"
            strokeWidth={2}
            fill="url(#eqGrad)"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="dollars"
            type="monotone"
            dataKey="cash"
            name="Cash"
            stroke="#ff9500"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="positions"
            type="stepAfter"
            dataKey="positions"
            name="Positions"
            stroke="#af52de"
            strokeWidth={2}
            dot={{ r: 2, fill: "#af52de", strokeWidth: 0 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
