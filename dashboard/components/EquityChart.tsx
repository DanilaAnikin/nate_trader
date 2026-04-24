"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import type { DailyHistory } from "@/lib/types";

interface EquityChartProps {
  data: DailyHistory[];
}

export default function EquityChart({ data }: EquityChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="glass-card rounded-lg p-6 h-80 flex items-center justify-center">
        <div className="text-center">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 opacity-40">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
            <polyline points="16 7 22 7 22 13" />
          </svg>
          <p className="text-muted text-sm">No equity history yet</p>
          <p className="text-muted/60 text-xs mt-1">Data will appear after the first trading day</p>
        </div>
      </div>
    );
  }

  // Professional empty state when only 1 data point
  if (data.length === 1) {
    const eq = data[0].equity;
    return (
      <div className="glass-card rounded-lg p-6 h-80 flex flex-col items-center justify-center">
        <p className="text-xs text-muted uppercase tracking-wider mb-2">Portfolio Equity</p>
        <p className="text-4xl font-bold text-blue">${eq.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        <p className="text-xs text-muted mt-3">Tracking begins &mdash; chart will populate with daily data</p>
        <div className="flex items-center gap-1.5 mt-4 text-xs text-muted/60">
          <span className="h-1.5 w-1.5 rounded-full bg-blue animate-pulse-dot" />
          Recording since {data[0].date}
        </div>
      </div>
    );
  }

  const formatted = data.map((d) => ({
    ...d,
    date: d.date.slice(5),
  }));

  const startingEquity = data[0].equity;

  return (
    <div className="glass-card rounded-lg p-4">
      <h3 className="text-sm font-medium text-secondary mb-3">Equity Curve</h3>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={formatted}>
          <defs>
            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.03)" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
            domain={["dataMin - 500", "dataMax + 500"]}
          />
          <ReferenceLine
            y={startingEquity}
            stroke="rgba(148, 163, 184, 0.2)"
            strokeDasharray="4 4"
            label={{ value: "Start", fill: "#64748b", fontSize: 10, position: "insideTopRight" }}
          />
          <Tooltip
            contentStyle={{
              background: "rgba(26, 35, 50, 0.95)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              color: "#f1f5f9",
              fontSize: 12,
              backdropFilter: "blur(8px)",
            }}
            formatter={(value) => [`$${Number(value).toLocaleString()}`, "Equity"]}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#3b82f6"
            strokeWidth={2}
            fill="url(#eqGrad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
