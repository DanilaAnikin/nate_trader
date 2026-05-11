"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";
import type { DailyHistory } from "@/lib/types";

interface Props {
  portfolioHistory: DailyHistory[];
}

interface SpyBar {
  date: string;
  close: number;
}

interface ChartRow {
  date: string;
  spy: number;
  portfolio: number | null;
}

/**
 * Historical performance chart: S&P 500 (SPY) from 2020 to today with the
 * user's portfolio overlaid from their start date. SPY is rebased so the
 * two lines start at the same value on the user's start date — making it
 * visually obvious whether the portfolio is beating SPY since launch.
 *
 * Math:
 *   start_date    = first date in portfolioHistory
 *   anchor_equity = portfolioHistory[0].equity (typically $1,000,000)
 *   scale         = anchor_equity / spy[start_date].close
 *   spy_rebased   = spy.close * scale   (for every date)
 *   portfolio     = actual equity from history (null before start_date)
 */
export default function HistoricalComparisonChart({ portfolioHistory }: Props) {
  const [spyData, setSpyData] = useState<SpyBar[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/spy-history", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setErrorMsg("SPY history file not generated yet. Run the 'Update SPY History' GitHub Actions workflow (Actions → Update SPY History → Run workflow) to backfill from 2020.");
          setSpyData([]);
          return;
        }
        if (!res.ok) {
          setErrorMsg(`Failed to load SPY history (HTTP ${res.status})`);
          setSpyData([]);
          return;
        }
        const data = await res.json();
        setSpyData(data.bars ?? []);
      })
      .catch((err) => {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
          setSpyData([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { chartRows, anchorEquity, startDate, spyTotalReturn, portfolioTotalReturn } = useMemo(() => {
    const empty = { chartRows: [] as ChartRow[], anchorEquity: 0, startDate: "", spyTotalReturn: 0, portfolioTotalReturn: 0 };
    if (!spyData || spyData.length === 0 || !portfolioHistory || portfolioHistory.length === 0) {
      return empty;
    }
    const firstPortfolio = portfolioHistory[0];
    const lastPortfolio = portfolioHistory[portfolioHistory.length - 1];
    const anchor = firstPortfolio.equity;
    if (anchor <= 0) return empty;

    // Find SPY close on (or just after) the user's start date
    const startSpy = spyData.find((b) => b.date >= firstPortfolio.date);
    if (!startSpy) return empty;
    const scale = anchor / startSpy.close;

    // Portfolio map for quick lookups
    const portfolioByDate = new Map(portfolioHistory.map((p) => [p.date, p.equity]));

    const rows: ChartRow[] = spyData.map((b) => ({
      date: b.date,
      spy: b.close * scale,
      portfolio: portfolioByDate.get(b.date) ?? null,
    }));

    // Ensure the anchor date has both values aligned (user's portfolio starts here)
    const anchorIdx = rows.findIndex((r) => r.date === startSpy.date);
    if (anchorIdx >= 0 && rows[anchorIdx].portfolio === null) {
      rows[anchorIdx].portfolio = anchor;
    }

    // Carry the last known portfolio value forward to today's last SPY date
    // so the line ends at the right place even if today's portfolio entry
    // hasn't been written yet.
    const lastSpyDate = rows[rows.length - 1]?.date;
    if (lastSpyDate && portfolioByDate.size > 0) {
      const lastPortfolioRowIdx = rows.findIndex((r) => r.date === lastPortfolio.date);
      // If our last portfolio entry is older than the last SPY date, extend it
      if (lastPortfolioRowIdx >= 0 && lastPortfolioRowIdx < rows.length - 1) {
        rows[rows.length - 1].portfolio = lastPortfolio.equity;
      }
    }

    const lastSpy = rows[rows.length - 1]?.spy ?? anchor;
    const lastPort = lastPortfolio.equity;
    return {
      chartRows: rows,
      anchorEquity: anchor,
      startDate: firstPortfolio.date,
      spyTotalReturn: ((lastSpy - anchor) / anchor) * 100,
      portfolioTotalReturn: ((lastPort - anchor) / anchor) * 100,
    };
  }, [spyData, portfolioHistory]);

  if (loading) {
    return (
      <div className="glass-card p-6 h-[480px] flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted text-sm">
          <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          Loading historical SPY data…
        </div>
      </div>
    );
  }

  if (errorMsg || chartRows.length === 0) {
    return (
      <div className="glass-card p-6 h-[200px] flex items-center justify-center">
        <div className="text-center max-w-md">
          <p className="text-sm text-secondary font-medium mb-1">Historical chart unavailable</p>
          <p className="text-xs text-muted">{errorMsg ?? "No SPY data returned."}</p>
        </div>
      </div>
    );
  }

  // Pick tick interval so we show ~12 labels regardless of dataset size
  const tickInterval = Math.max(1, Math.floor(chartRows.length / 12));

  const alpha = portfolioTotalReturn - spyTotalReturn;

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between mb-1">
        <div>
          <h3 className="text-sm font-medium text-secondary">Historical Performance vs S&amp;P 500</h3>
          <p className="text-xs text-muted mt-1">
            SPY rebased to ${anchorEquity.toLocaleString()} at {startDate}. Both lines start at the same value so divergence shows alpha.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="text-right">
            <p className="text-muted uppercase tracking-wider text-[10px]">Portfolio since start</p>
            <p className={`text-sm font-semibold ${portfolioTotalReturn >= 0 ? "text-blue" : "text-red"}`}>
              {portfolioTotalReturn >= 0 ? "+" : ""}{portfolioTotalReturn.toFixed(2)}%
            </p>
          </div>
          <div className="text-right">
            <p className="text-muted uppercase tracking-wider text-[10px]">SPY since start</p>
            <p className={`text-sm font-semibold ${spyTotalReturn >= 0 ? "text-secondary" : "text-red"}`}>
              {spyTotalReturn >= 0 ? "+" : ""}{spyTotalReturn.toFixed(2)}%
            </p>
          </div>
          <div className="text-right">
            <p className="text-muted uppercase tracking-wider text-[10px]">Alpha</p>
            <p className={`text-sm font-semibold ${alpha >= 0 ? "text-green" : "text-red"}`}>
              {alpha >= 0 ? "+" : ""}{alpha.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={400}>
        <AreaChart data={chartRows} margin={{ top: 20, right: 20, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="spyGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#86868b" stopOpacity={0.15} />
              <stop offset="100%" stopColor="#86868b" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="portfolioGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#007aff" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#007aff" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#f0f0f2" strokeDasharray="none" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#86868b", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval={tickInterval}
            tickFormatter={(date: string) => {
              // YYYY-MM-DD → Mmm 'YY for compact labels (e.g. "Jan '20")
              const d = new Date(date);
              if (Number.isNaN(d.getTime())) return date;
              return `${d.toLocaleString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
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
          <ReferenceLine
            x={startDate}
            stroke="#007aff"
            strokeDasharray="3 3"
            label={{ value: "Portfolio Start", fill: "#007aff", fontSize: 10, position: "top" }}
          />
          <Tooltip
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #e5e5e7",
              borderRadius: 10,
              fontSize: 12,
              boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            }}
            formatter={(value, name) => {
              if (value === null || value === undefined) return ["—", String(name)];
              const n = typeof value === "number" ? value : Number(value);
              if (Number.isNaN(n)) return ["—", String(name)];
              return [
                `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
                String(name),
              ];
            }}
            labelFormatter={(date) => `Date: ${String(date)}`}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
            iconType="line"
          />
          <Area
            type="monotone"
            dataKey="spy"
            name="S&P 500 (rebased)"
            stroke="#86868b"
            strokeWidth={1.5}
            fill="url(#spyGrad)"
            dot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="portfolio"
            name="Your Portfolio"
            stroke="#007aff"
            strokeWidth={2.5}
            fill="url(#portfolioGrad)"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
