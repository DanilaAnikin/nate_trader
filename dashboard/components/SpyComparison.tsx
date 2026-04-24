"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from "recharts";

interface SpyComparisonProps {
  portfolioReturn: number;
  spyReturn: number;
}

export default function SpyComparison({ portfolioReturn, spyReturn }: SpyComparisonProps) {
  const alpha = portfolioReturn - spyReturn;
  const data = [
    { name: "Portfolio", value: portfolioReturn },
    { name: "SPY", value: spyReturn },
    { name: "Alpha", value: alpha },
  ];

  const colors = ["#3b82f6", "#64748b", alpha >= 0 ? "#22c55e" : "#ef4444"];

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <h3 className="text-sm font-medium text-secondary mb-3">
        Monthly Return vs SPY
      </h3>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} barSize={48}>
          <XAxis
            dataKey="name"
            tick={{ fill: "#94a3b8", fontSize: 12 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: "#64748b", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `${v.toFixed(1)}%`}
          />
          <Tooltip
            contentStyle={{
              background: "#1a2332",
              border: "1px solid #1e293b",
              borderRadius: 6,
              color: "#f1f5f9",
              fontSize: 12,
            }}
            formatter={(value) => [`${Number(value).toFixed(2)}%`]}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
          <Bar dataKey="value" name="Return %">
            {data.map((_, idx) => (
              <Cell key={idx} fill={colors[idx]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
