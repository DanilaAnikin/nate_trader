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
import {
  type Range,
  type SpyBar,
  rebaseComparison,
} from "@/lib/chart-rebase";

interface Props {
  portfolioHistory: DailyHistory[];
}

const RANGE_OPTIONS: Array<{ id: Range; label: string }> = [
  { id: "1W", label: "1W" },
  { id: "1M", label: "1M" },
  { id: "1Y", label: "1Y" },
  { id: "YTD", label: "YTD" },
  { id: "ALL_PORTFOLIO", label: "From Start" },
  { id: "FROM_2020", label: "From 2020" },
];

/**
 * Historical performance chart with range filters.
 *
 * Rebase logic:
 *   filter_start         = start of selected range (e.g. 7 days ago for 1W,
 *                          portfolio_start for "From Start", 2020-01-01 for
 *                          "From 2020")
 *   effective_anchor     = max(filter_start, portfolio_start) — the date
 *                          where SPY and portfolio coincide visually
 *   anchor_value         = portfolio.equity[effective_anchor] (or earliest
 *                          portfolio entry if filter starts pre-portfolio)
 *   scale                = anchor_value / spy.close[effective_anchor]
 *   spy_rebased(date)    = spy.close[date] * scale
 *   portfolio(date)      = real equity from daily_history (null if pre-portfolio)
 *
 * For ranges starting after portfolio_start (1W/1M/etc on an older account),
 * both lines start at the same value at filter_start. For ranges spanning
 * before portfolio_start (FROM_2020 on a fresh account), SPY shows the
 * historical period in grey and portfolio joins later in blue.
 */
export default function HistoricalComparisonChart({ portfolioHistory }: Props) {
  const [spyData, setSpyData] = useState<SpyBar[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Default to the portfolio's own lifetime: both lines start together at the
  // first trading day and diverge to show alpha. "From 2020" buries the few
  // weeks of real portfolio data under six years of rebased SPY.
  const [range, setRange] = useState<Range>("ALL_PORTFOLIO");

  useEffect(() => {
    let cancelled = false;

    const fetchHistory = (silent = false) => {
      fetch("/api/spy-history", { cache: "no-store" })
        .then(async (res) => {
          if (cancelled) return;
          if (res.status === 404) {
            if (!silent) {
              setErrorMsg(
                "SPY history file not generated yet. Run the 'Update SPY History' GitHub Actions workflow (Actions → Update SPY History → Run workflow) to backfill from 2020.",
              );
              setSpyData([]);
            }
            return;
          }
          if (!res.ok) {
            if (!silent) {
              setErrorMsg(`Failed to load SPY history (HTTP ${res.status})`);
              setSpyData([]);
            }
            return;
          }
          const data = await res.json();
          if (!cancelled) {
            setErrorMsg(null);
            setSpyData(data.bars ?? []);
          }
        })
        .catch((err) => {
          if (!cancelled && !silent) {
            setErrorMsg(err instanceof Error ? err.message : String(err));
            setSpyData([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    // Initial fetch
    fetchHistory();

    // The account provider dispatches dashboard:refreshed after a validated
    // account refresh; use it to pick up a new SPY history bar as well.
    // so the chart's grey baseline picks up any new bar from today's
    // routine. Silent retry — don't blow away existing data on transient
    // failure.
    const refreshHandler = () => fetchHistory(/* silent */ true);
    window.addEventListener("dashboard:refreshed", refreshHandler);

    return () => {
      cancelled = true;
      window.removeEventListener("dashboard:refreshed", refreshHandler);
    };
  }, []);

  const computed = useMemo(
    () => rebaseComparison(spyData, portfolioHistory, range),
    [spyData, portfolioHistory, range],
  );

  if (loading) {
    return (
      <div className="glass-card p-6 h-[480px] flex items-center justify-center">
        <div className="flex items-center gap-3 text-muted text-sm">
          <svg
            className="animate-spin"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          Loading historical SPY data…
        </div>
      </div>
    );
  }

  if (errorMsg || computed.chartRows.length === 0) {
    return (
      <div className="glass-card p-6 h-[200px] flex items-center justify-center">
        <div className="text-center max-w-md">
          <p className="text-sm text-secondary font-medium mb-1">
            Historical chart unavailable
          </p>
          <p className="text-xs text-muted">{errorMsg ?? "No SPY data returned."}</p>
        </div>
      </div>
    );
  }

  const {
    chartRows,
    anchorEquity,
    anchorDate,
    portfolioStartDate,
    spyReturn,
    portfolioReturn,
    showStartLine,
  } = computed;

  const tickInterval = Math.max(1, Math.floor(chartRows.length / 12));
  const spanDays =
    chartRows.length > 1
      ? (new Date(chartRows[chartRows.length - 1].date).getTime() -
          new Date(chartRows[0].date).getTime()) /
        86_400_000
      : 0;
  // Day-level labels for short windows; month + year only for multi-year
  // spans. Stops the "May '26 / May '26 / May '26" duplicate-tick mess that a
  // ~5-week "From Start" range produced.
  const useDayLabels = spanDays <= 120;
  const alpha = portfolioReturn - spyReturn;

  return (
    <div className="glass-card p-6">
      {/* Header: title + per-range alpha */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-medium text-secondary">
            Historical Performance vs S&amp;P 500
          </h3>
          <p className="text-xs text-muted mt-1">
            SPY rebased to ${anchorEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })} at{" "}
            {anchorDate}. Both lines start at the same value so divergence shows alpha.
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="text-right">
            <p className="text-muted uppercase tracking-wider text-[10px]">
              Portfolio since {anchorDate}
            </p>
            <p
              className={`text-sm font-semibold ${portfolioReturn >= 0 ? "text-blue" : "text-red"}`}
            >
              {portfolioReturn >= 0 ? "+" : ""}
              {portfolioReturn.toFixed(2)}%
            </p>
          </div>
          <div className="text-right">
            <p className="text-muted uppercase tracking-wider text-[10px]">
              SPY since {anchorDate}
            </p>
            <p
              className={`text-sm font-semibold ${spyReturn >= 0 ? "text-secondary" : "text-red"}`}
            >
              {spyReturn >= 0 ? "+" : ""}
              {spyReturn.toFixed(2)}%
            </p>
          </div>
          <div className="text-right">
            <p className="text-muted uppercase tracking-wider text-[10px]">Alpha</p>
            <p
              className={`text-sm font-semibold ${alpha >= 0 ? "text-green" : "text-red"}`}
            >
              {alpha >= 0 ? "+" : ""}
              {alpha.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>

      {/* Range filter segmented control */}
      <div className="flex items-center justify-end mb-4">
        <div className="inline-flex items-center gap-0.5 bg-surface rounded-lg p-1">
          {RANGE_OPTIONS.map((opt) => {
            const active = range === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRange(opt.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all duration-150 ${
                  active
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted hover:text-foreground"
                }`}
                aria-pressed={active}
              >
                {opt.label}
              </button>
            );
          })}
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
          <CartesianGrid stroke="rgba(134,134,139,0.18)" strokeDasharray="none" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: "#86868b", fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            interval={tickInterval}
            tickFormatter={(date: string) => {
              const d = new Date(date);
              if (Number.isNaN(d.getTime())) return date;
              return useDayLabels
                ? d.toLocaleString("en-US", { month: "short", day: "numeric" })
                : `${d.toLocaleString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
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
          {showStartLine && (
            <ReferenceLine
              x={portfolioStartDate}
              stroke="#007aff"
              strokeDasharray="3 3"
              label={{
                value: "Portfolio Start",
                fill: "#007aff",
                fontSize: 10,
                position: "top",
              }}
            />
          )}
          <Tooltip
            contentStyle={{
              background: "var(--bg-card)",
              border: "1px solid var(--border)",
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
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 12 }} iconType="line" />
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
            connectNulls
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
