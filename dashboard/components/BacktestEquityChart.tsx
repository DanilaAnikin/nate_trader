"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import type { BacktestDaily } from "@/lib/backtest-types";

interface Props {
  daily: BacktestDaily[];
  spyBaseline: number[];
}

/**
 * Side-by-side equity curve from the backtest: simulated portfolio
 * (blue) vs SPY rebased to the same starting cash (grey).
 *
 * Both lines start at the same value at the backtest's first date —
 * divergence reads as alpha for the period.
 */
export default function BacktestEquityChart({ daily, spyBaseline }: Props) {
  if (!daily || daily.length === 0) {
    return (
      <div className="glass-card p-6 h-[200px] flex items-center justify-center text-muted text-sm">
        No backtest data
      </div>
    );
  }

  const rows = daily.map((d, i) => ({
    date: d.date,
    portfolio: d.equity,
    spy: spyBaseline[i] ?? null,
  }));

  const tickInterval = Math.max(1, Math.floor(rows.length / 12));

  return (
    <div className="glass-card p-6">
      <h3 className="text-sm font-medium text-secondary mb-1">Backtest Equity Curve</h3>
      <p className="text-xs text-muted mb-4">
        Simulated portfolio vs SPY (both rebased to ${daily[0]?.equity.toLocaleString()} at {daily[0]?.date}).
      </p>
      <ResponsiveContainer width="100%" height={380}>
        <AreaChart data={rows} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="bktPortGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#007aff" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#007aff" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="bktSpyGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#86868b" stopOpacity={0.15} />
              <stop offset="100%" stopColor="#86868b" stopOpacity={0} />
            </linearGradient>
          </defs>
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
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #e5e5e7",
              borderRadius: 10,
              fontSize: 12,
            }}
            formatter={(v, n) => {
              if (v === null || v === undefined) return ["—", String(n)];
              const x = typeof v === "number" ? v : Number(v);
              return [`$${x.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, String(n)];
            }}
            labelFormatter={(d) => `Date: ${String(d)}`}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} iconType="line" />
          <Area
            type="monotone"
            dataKey="spy"
            name="SPY (baseline)"
            stroke="#86868b"
            strokeWidth={1.5}
            fill="url(#bktSpyGrad)"
            dot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="portfolio"
            name="Backtest Portfolio"
            stroke="#007aff"
            strokeWidth={2.5}
            fill="url(#bktPortGrad)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
