"use client";

import { type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Themed recharts wrappers for the observability UI.
 *
 * SVG `fill`/`stroke` accept CSS custom properties, so every colour here is a
 * design token and the charts follow the light/dark theme with no JavaScript.
 * All numbers are supplied by the caller from an audited source — these
 * components never derive, forward-fill or fabricate a series.
 */

const AXIS = "var(--text-muted)";
const GRID = "var(--border)";

export const SERIES = {
  primary: "var(--accent-blue)",
  benchmark: "var(--accent-slate)",
  positive: "var(--accent-green)",
  negative: "var(--accent-red)",
  amber: "var(--accent-amber)",
  purple: "var(--accent-purple)",
  cyan: "var(--accent-cyan)",
} as const;

/** Categorical palette for allocation slices — distinct, theme-aware hues. */
export const CATEGORY_COLORS = [
  "var(--accent-blue)",
  "var(--accent-green)",
  "var(--accent-purple)",
  "var(--accent-amber)",
  "var(--accent-cyan)",
  "var(--accent-red)",
  "var(--accent-slate)",
  "#8aa2ff",
  "#4db6a0",
  "#c79a3a",
] as const;

const axisTick = { fill: AXIS, fontSize: 11 } as const;

/** A titled chart frame with a fixed height so ResponsiveContainer can size. */
export function ChartFrame({
  title,
  legend,
  height = 220,
  children,
  ariaLabel,
}: {
  title?: ReactNode;
  legend?: ReactNode;
  height?: number;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <figure className="min-w-0" aria-label={ariaLabel}>
      {(title || legend) && (
        <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2">
          {title && (
            <span className="text-[11px] uppercase tracking-wide text-muted">
              {title}
            </span>
          )}
          {legend}
        </figcaption>
      )}
      <div style={{ width: "100%", height }}>{children}</div>
    </figure>
  );
}

/** Small colour-swatch legend row. */
export function Legend({
  items,
}: {
  items: { name: string; color: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((it) => (
        <span key={it.name} className="flex items-center gap-1.5 text-[11px] text-secondary">
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ background: it.color }}
          />
          {it.name}
        </span>
      ))}
    </div>
  );
}

interface TipRow {
  name?: string;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
}

function ThemedTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string | number;
  labelFormatter?: (l: string | number) => string;
  valueFormatter?: (v: number | string, name?: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border-strong bg-card px-3 py-2 text-xs shadow-lg">
      {label !== undefined && label !== "" && (
        <div className="mb-1 font-medium text-secondary">
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      )}
      {payload.map((row, i) => (
        <div key={i} className="flex items-center gap-2 whitespace-nowrap">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: row.color }}
          />
          {row.name && <span className="text-muted">{row.name}</span>}
          <span className="ml-auto pl-3 font-medium numeric" style={{ color: row.color }}>
            {valueFormatter && row.value !== undefined
              ? valueFormatter(row.value, row.name)
              : String(row.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * An equity / growth line, optionally overlaid with a benchmark line drawn on
 * the same axis. When `benchmark` is given both series should already be
 * indexed to a shared base (e.g. 100 at the anchor session) so the comparison
 * is honest; pass raw currency for a single-series equity curve.
 */
export function GrowthChart({
  data,
  primaryName,
  benchmarkName,
  valueFormatter,
  height = 240,
}: {
  data: { date: string; value: number; benchmark?: number | null }[];
  primaryName: string;
  benchmarkName?: string;
  valueFormatter: (v: number | string) => string;
  height?: number;
}) {
  const hasBenchmark = benchmarkName !== undefined && data.some((d) => d.benchmark != null);
  return (
    <ChartFrame
      height={height}
      ariaLabel={`${primaryName}${hasBenchmark ? ` versus ${benchmarkName}` : ""} over time`}
      legend={
        <Legend
          items={[
            { name: primaryName, color: SERIES.primary },
            ...(hasBenchmark ? [{ name: benchmarkName!, color: SERIES.benchmark }] : []),
          ]}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="growthFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES.primary} stopOpacity={0.28} />
              <stop offset="100%" stopColor={SERIES.primary} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            minTickGap={40}
            tickFormatter={(d: string) => (typeof d === "string" ? d.slice(5) : d)}
          />
          <YAxis
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={54}
            tickFormatter={(v: number) => valueFormatter(v)}
            domain={["auto", "auto"]}
          />
          <Tooltip
            content={
              <ThemedTooltip
                valueFormatter={(v) => valueFormatter(v)}
              />
            }
          />
          {hasBenchmark && (
            <Area
              type="monotone"
              dataKey="benchmark"
              name={benchmarkName}
              stroke={SERIES.benchmark}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              fill="none"
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
          )}
          <Area
            type="monotone"
            dataKey="value"
            name={primaryName}
            stroke={SERIES.primary}
            strokeWidth={2}
            fill="url(#growthFill)"
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * Grouped vertical bars comparing named series across a set of labels — the
 * strategy-vs-benchmark comparison (e.g. V11 CAGR vs SPY CAGR per period).
 */
export function ComparisonBars({
  data,
  series,
  valueFormatter,
  height = 220,
  title,
}: {
  data: Record<string, string | number>[];
  series: { key: string; name: string; color: string }[];
  valueFormatter: (v: number | string) => string;
  height?: number;
  title?: ReactNode;
}) {
  return (
    <ChartFrame
      height={height}
      title={title}
      legend={<Legend items={series.map((s) => ({ name: s.name, color: s.color }))} />}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }} barGap={4}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={axisTick} tickLine={false} axisLine={{ stroke: GRID }} />
          <YAxis
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v: number) => valueFormatter(v)}
          />
          <ReferenceLine y={0} stroke={GRID} />
          <Tooltip
            cursor={{ fill: "var(--bg-hover)", opacity: 0.5 }}
            content={<ThemedTooltip valueFormatter={(v) => valueFormatter(v)} />}
          />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * Horizontal bars, one per row, coloured by the sign of the value — per-holding
 * unrealized P&L, per-candidate excess return, etc.
 */
export function SignedBars({
  data,
  valueFormatter,
  height,
  labelWidth = 64,
}: {
  data: { name: string; value: number; note?: string }[];
  valueFormatter: (v: number) => string;
  height?: number;
  labelWidth?: number;
}) {
  const h = height ?? Math.max(120, data.length * 30 + 24);
  return (
    <ChartFrame height={h} ariaLabel="Per-item values">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 12, bottom: 0, left: 8 }}
        >
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: GRID }}
            tickFormatter={(v: number) => valueFormatter(v)}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: "var(--text-secondary)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={labelWidth}
          />
          <ReferenceLine x={0} stroke={GRID} />
          <Tooltip
            cursor={{ fill: "var(--bg-hover)", opacity: 0.5 }}
            content={<ThemedTooltip valueFormatter={(v) => valueFormatter(Number(v))} />}
          />
          <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.value >= 0 ? SERIES.positive : SERIES.negative} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Allocation donut with an inline legend and total in the centre. */
export function AllocationDonut({
  data,
  valueFormatter,
  centerLabel,
  centerValue,
  height = 240,
}: {
  data: { name: string; value: number; color?: string }[];
  valueFormatter: (v: number) => string;
  centerLabel?: string;
  centerValue?: string;
  height?: number;
}) {
  return (
    <ChartFrame height={height} ariaLabel="Allocation by weight">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={1.5}
            stroke="var(--bg-card)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.color ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
            ))}
          </Pie>
          {centerValue && (
            <text
              x="50%"
              y="50%"
              textAnchor="middle"
              dominantBaseline="middle"
              className="numeric"
              style={{ fill: "var(--text-primary)", fontSize: 18, fontWeight: 600 }}
            >
              {centerValue}
            </text>
          )}
          {centerLabel && (
            <text
              x="50%"
              y="50%"
              dy={20}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ fill: "var(--text-muted)", fontSize: 11 }}
            >
              {centerLabel}
            </text>
          )}
          <Tooltip content={<ThemedTooltip valueFormatter={(v) => valueFormatter(Number(v))} />} />
        </PieChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** A slim proportion bar — exposure vs cash, breadth tier, a funnel stage. */
export function ProportionBar({
  value,
  max = 100,
  tone = "primary",
  label,
  right,
}: {
  value: number | null;
  max?: number;
  tone?: keyof typeof SERIES;
  label?: ReactNode;
  right?: ReactNode;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="min-w-0">
      {(label || right) && (
        <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
          <span className="text-muted">{label}</span>
          <span className="numeric text-secondary">{right}</span>
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--bg-surface)" }}>
        <div
          className="h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, background: value === null ? "var(--border-strong)" : SERIES[tone] }}
        />
      </div>
    </div>
  );
}

/**
 * A collapsible "Why?" disclosure so long, load-bearing explanatory prose stays
 * available without dominating the page. Collapsed by default.
 */
export function Disclosure({
  summary = "Why?",
  children,
  defaultOpen = false,
}: {
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  // A native <details> so the (load-bearing) explanatory text stays in the DOM
  // even when collapsed — it is present and accessible, just not shouting. This
  // keeps the "caveats must accompany the metrics" invariant while cutting the
  // visual wall of text.
  return (
    <details className="group mt-2" open={defaultOpen || undefined}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-secondary hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden="true"
          className="inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        {summary}
      </summary>
      <div className="mt-1.5 space-y-2 text-xs text-secondary max-w-prose">
        {children}
      </div>
    </details>
  );
}
