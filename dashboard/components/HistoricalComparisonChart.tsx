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

type Range = "1W" | "1M" | "1Y" | "YTD" | "ALL_PORTFOLIO" | "FROM_2020";

const RANGE_OPTIONS: Array<{ id: Range; label: string }> = [
  { id: "1W", label: "1W" },
  { id: "1M", label: "1M" },
  { id: "1Y", label: "1Y" },
  { id: "YTD", label: "YTD" },
  { id: "ALL_PORTFOLIO", label: "From Start" },
  { id: "FROM_2020", label: "From 2020" },
];

/**
 * Resolve the filter's starting ISO date relative to a reference "today"
 * (we use the last SPY bar's date so filters align with actual data
 * regardless of the viewer's timezone).
 */
function computeFilterStart(
  range: Range,
  referenceDate: string,
  portfolioStart: string,
): string {
  if (range === "ALL_PORTFOLIO") return portfolioStart;
  if (range === "FROM_2020") return "2020-01-01";
  if (range === "YTD") return `${referenceDate.slice(0, 4)}-01-01`;

  const d = new Date(referenceDate + "T00:00:00Z");
  if (range === "1W") d.setUTCDate(d.getUTCDate() - 7);
  else if (range === "1M") d.setUTCDate(d.getUTCDate() - 30);
  else if (range === "1Y") d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().split("T")[0];
}

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

    // Refresh button (or auto-mount fetch in DashboardClient) dispatches
    // dashboard:live; treat that as a signal to refetch SPY history too
    // so the chart's grey baseline picks up any new bar from today's
    // routine. Silent retry — don't blow away existing data on transient
    // failure.
    const refreshHandler = () => fetchHistory(/* silent */ true);
    window.addEventListener("dashboard:live", refreshHandler);

    return () => {
      cancelled = true;
      window.removeEventListener("dashboard:live", refreshHandler);
    };
  }, []);

  const computed = useMemo(() => {
    const empty = {
      chartRows: [] as ChartRow[],
      anchorEquity: 0,
      anchorDate: "",
      portfolioStartDate: "",
      filterStart: "",
      spyReturn: 0,
      portfolioReturn: 0,
      showStartLine: false,
    };
    if (!spyData || spyData.length === 0 || !portfolioHistory || portfolioHistory.length === 0) {
      return empty;
    }
    const portfolioStart = portfolioHistory[0].date;
    const lastSpyDate = spyData[spyData.length - 1].date;
    const filterStart = computeFilterStart(range, lastSpyDate, portfolioStart);

    // Effective anchor = later of (filterStart, portfolioStart)
    const effectiveAnchorDate =
      filterStart > portfolioStart ? filterStart : portfolioStart;

    // Find first SPY bar ≥ anchor (data may skip weekends/holidays)
    const spyAtAnchor = spyData.find((b) => b.date >= effectiveAnchorDate);
    if (!spyAtAnchor) return empty;

    // Anchor value: prefer exact portfolio entry, else first entry on/after
    const portfolioMap = new Map(portfolioHistory.map((p) => [p.date, p.equity]));
    let anchorValue = portfolioMap.get(effectiveAnchorDate);
    if (anchorValue === undefined) {
      const entry = portfolioHistory.find((p) => p.date >= effectiveAnchorDate);
      anchorValue = entry?.equity ?? portfolioHistory[0].equity;
    }
    if (anchorValue <= 0) return empty;

    const scale = anchorValue / spyAtAnchor.close;

    // Build chart rows: filter SPY to ≥ filterStart, attach portfolio per date
    const rows: ChartRow[] = spyData
      .filter((b) => b.date >= filterStart)
      .map((b) => ({
        date: b.date,
        spy: b.close * scale,
        portfolio: portfolioMap.get(b.date) ?? null,
      }));

    // Make sure anchor row has portfolio = anchorValue (so the two lines
    // visually coincide there even if portfolio's nearest entry was on a
    // different date — e.g. weekend boundaries).
    const anchorIdx = rows.findIndex((r) => r.date === spyAtAnchor.date);
    if (anchorIdx >= 0 && spyAtAnchor.date === effectiveAnchorDate) {
      if (rows[anchorIdx].portfolio === null) {
        rows[anchorIdx].portfolio = anchorValue;
      }
    }

    // Carry the last known portfolio value to the most recent SPY bar so
    // the blue line ends at the right place even if today's portfolio
    // entry hasn't been written yet.
    const lastPortfolio = portfolioHistory[portfolioHistory.length - 1];
    if (lastPortfolio && rows.length > 0) {
      const lastPortfolioRowIdx = rows.findIndex(
        (r) => r.date === lastPortfolio.date,
      );
      if (lastPortfolioRowIdx >= 0 && lastPortfolioRowIdx < rows.length - 1) {
        rows[rows.length - 1].portfolio = lastPortfolio.equity;
      }
    }

    // If the portfolio has a more recent point than the last SPY bar (e.g.
    // today, before SPY history caught up), extend the rows so the blue line
    // reaches its true latest value instead of stopping a day short.
    if (
      lastPortfolio &&
      rows.length > 0 &&
      lastPortfolio.date > rows[rows.length - 1].date
    ) {
      rows.push({
        date: lastPortfolio.date,
        spy: rows[rows.length - 1].spy,
        portfolio: lastPortfolio.equity,
      });
    }

    const lastSpyValue = rows[rows.length - 1]?.spy ?? anchorValue;
    const lastPortValue = lastPortfolio?.equity ?? anchorValue;
    const spyReturn = ((lastSpyValue - anchorValue) / anchorValue) * 100;
    const portfolioReturn = ((lastPortValue - anchorValue) / anchorValue) * 100;

    // Show "Portfolio Start" reference line only when portfolio_start is
    // strictly inside the visible range (otherwise it's redundant at the
    // chart edge or invisible entirely).
    const showStartLine =
      portfolioStart > filterStart &&
      rows.length > 0 &&
      portfolioStart <= rows[rows.length - 1].date;

    return {
      chartRows: rows,
      anchorEquity: anchorValue,
      anchorDate: effectiveAnchorDate,
      portfolioStartDate: portfolioStart,
      filterStart,
      spyReturn,
      portfolioReturn,
      showStartLine,
    };
  }, [spyData, portfolioHistory, range]);

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
