"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface DailyPoint {
  date: string;
  equity: number;
}

interface Props {
  baseline: { label: string; daily_history: DailyPoint[] };
  challenger: { label: string; daily_history: DailyPoint[] };
  spy: number[];
}

/**
 * Overlay two backtest equity curves + SPY baseline on a single chart.
 * Used to compare "live default params" vs "sweep-best params" — same
 * timeline, three colors. Divergence reads directly as parameter-tuning
 * delta.
 */
export default function BacktestComparisonChart({ baseline, challenger, spy }: Props) {
  const rows = useMemo(() => {
    const baseMap = new Map(baseline.daily_history.map((d) => [d.date, d.equity]));
    const chalMap = new Map(challenger.daily_history.map((d) => [d.date, d.equity]));
    const allDates = Array.from(new Set([
      ...baseline.daily_history.map((d) => d.date),
      ...challenger.daily_history.map((d) => d.date),
    ])).sort();
    return allDates.map((d, i) => ({
      date: d,
      baseline: baseMap.get(d) ?? null,
      challenger: chalMap.get(d) ?? null,
      spy: spy[i] ?? null,
    }));
  }, [baseline, challenger, spy]);

  const tickInterval = Math.max(1, Math.floor(rows.length / 12));

  if (rows.length === 0) {
    return (
      <div className="glass-card p-6 h-[200px] flex items-center justify-center text-muted text-sm">
        No comparison data
      </div>
    );
  }

  return (
    <div className="glass-card p-6">
      <div>
        <h3 className="text-sm font-medium text-secondary">Comparison — {baseline.label} vs {challenger.label}</h3>
        <p className="text-xs text-muted mt-1 mb-4">
          Same period and starting cash, different parameter sets. SPY baseline shown for context.
        </p>
      </div>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={rows} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#f0f0f2" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#86868b", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval={tickInterval}
            tickFormatter={(d: string) => {
              const dt = new Date(d);
              if (Number.isNaN(dt.getTime())) return d;
              return `${dt.toLocaleString("en-US", { month: "short" })} '${String(dt.getFullYear()).slice(2)}`;
            }}
          />
          <YAxis
            tick={{ fill: "#86868b", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => {
              if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
              if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
              return `$${v.toFixed(0)}`;
            }}
            domain={["dataMin * 0.98", "dataMax * 1.02"]}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #e5e5e7", borderRadius: 10, fontSize: 12 }}
            formatter={(v, n) => {
              if (v === null || v === undefined) return ["—", String(n)];
              const x = typeof v === "number" ? v : Number(v);
              return [`$${x.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, String(n)];
            }}
            labelFormatter={(d) => `Date: ${String(d)}`}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} iconType="line" />
          <Line type="monotone" dataKey="spy" name="SPY baseline" stroke="#86868b" strokeWidth={1.5} dot={false} connectNulls />
          <Line type="monotone" dataKey="baseline" name={baseline.label} stroke="#5ac8fa" strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="challenger" name={challenger.label} stroke="#007aff" strokeWidth={2.5} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
