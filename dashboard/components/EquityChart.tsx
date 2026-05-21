"use client";

import { useMemo, useState } from "react";
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
import { simpleReturn } from "@/lib/returns";

interface EquityChartProps {
  data: DailyHistory[];
}

type RangeKey = "1W" | "1M" | "3M" | "YTD" | "1Y" | "ALL";
const RANGES: RangeKey[] = ["1W", "1M", "3M", "YTD", "1Y", "ALL"];

function cutoffFor(range: RangeKey): string {
  if (range === "ALL") return "0000-00-00";
  const now = new Date();
  if (range === "YTD") return `${now.getFullYear()}-01-01`;
  const days: Record<string, number> = { "1W": 7, "1M": 30, "3M": 90, "1Y": 365 };
  now.setDate(now.getDate() - days[range]);
  return now.toISOString().slice(0, 10);
}

export default function EquityChart({ data }: EquityChartProps) {
  const [range, setRange] = useState<RangeKey>("ALL");

  // Slice by DATE, not array index — a 1M view is the last 30 calendar days,
  // whatever the sampling density (fixes DEF-10).
  const sliced = useMemo(() => {
    if (!data || data.length === 0) return [];
    const cutoff = cutoffFor(range);
    const filtered = data.filter((d) => d.date >= cutoff);
    return filtered.length >= 2 ? filtered : data;
  }, [data, range]);

  if (!data || data.length === 0) {
    return (
      <div className="glass-card p-6 h-80 flex items-center justify-center">
        <div className="text-center">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="mx-auto mb-3 opacity-30">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
            <polyline points="16 7 22 7 22 13" />
          </svg>
          <p className="text-secondary text-sm font-medium">No equity history yet</p>
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
        <p className="text-4xl font-semibold text-blue">${eq.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        <p className="text-xs text-muted mt-3">Tracking begins &mdash; chart will populate with daily data</p>
        <div className="flex items-center gap-1.5 mt-4 text-xs text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-blue animate-pulse-dot" />
          Recording since {data[0].date}
        </div>
      </div>
    );
  }

  const formatted = sliced.map((d) => ({ ...d, label: d.date.slice(5) }));
  const startingEquity = sliced[0].equity;
  const periodReturn = simpleReturn(
    sliced.map((d) => ({ date: d.date, equity: d.equity })),
  );
  const up = periodReturn >= 0;

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-medium text-secondary">Equity Curve</h3>
          <span className={`text-xs font-semibold ${up ? "text-green" : "text-red"}`}>
            {up ? "+" : ""}
            {(periodReturn * 100).toFixed(2)}%
          </span>
        </div>
        <div className="flex gap-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`text-[11px] px-2 py-1 rounded-md transition-colors ${
                range === r
                  ? "bg-blue/10 text-blue font-medium"
                  : "text-muted hover:text-foreground hover:bg-surface"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={formatted}>
          <defs>
            <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#007aff" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#007aff" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#f0f0f2" strokeDasharray="none" />
          <XAxis
            dataKey="label"
            tick={{ fill: "#86868b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            tick={{ fill: "#86868b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(0)}k`}
            domain={["dataMin - 500", "dataMax + 500"]}
          />
          <ReferenceLine
            y={startingEquity}
            stroke="#d2d2d7"
            strokeDasharray="4 4"
            label={{ value: "Start", fill: "#86868b", fontSize: 10, position: "insideTopRight" }}
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
            formatter={(value) => [`$${Number(value).toLocaleString()}`, "Equity"]}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#007aff"
            strokeWidth={2}
            fill="url(#eqGrad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
