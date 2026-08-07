"use client";

import type { ReactNode } from "react";
import { absoluteTimestamps } from "@/lib/status/client";
import { useNowMs } from "@/lib/status/use-now";
import {
  formatAge,
  type CheckState,
  type Freshness,
  type Provenance,
} from "@/lib/status/vocab";

/**
 * Display primitives for the observability UI.
 *
 * Two rules drive every component here:
 *  1. a state is always named, never implied by colour alone; and
 *  2. an absent value renders as an explicit dash or state chip, never as 0.
 */

type AnyState = Freshness | CheckState;

const STATE_STYLE: Record<AnyState, { fg: string; bg: string; label: string }> = {
  CURRENT: { fg: "var(--accent-green)", bg: "var(--tint-green)", label: "CURRENT" },
  PASS: { fg: "var(--accent-green)", bg: "var(--tint-green)", label: "PASS" },
  STALE: { fg: "var(--accent-amber)", bg: "var(--tint-amber)", label: "STALE" },
  WARN: { fg: "var(--accent-amber)", bg: "var(--tint-amber)", label: "WARN" },
  PENDING: { fg: "var(--accent-blue)", bg: "var(--tint-blue)", label: "PENDING" },
  EXPIRED: { fg: "var(--accent-red)", bg: "var(--tint-red)", label: "EXPIRED" },
  FAIL: { fg: "var(--accent-red)", bg: "var(--tint-red)", label: "FAIL" },
  MISMATCH: { fg: "var(--accent-purple)", bg: "var(--tint-purple)", label: "MISMATCH" },
  UNAVAILABLE: { fg: "var(--accent-slate)", bg: "var(--tint-slate)", label: "UNAVAILABLE" },
  NOT_APPLICABLE: {
    fg: "var(--accent-slate)",
    bg: "var(--tint-slate)",
    label: "NOT APPLICABLE",
  },
};

export function StatePill({
  state,
  label,
  title,
  size = "sm",
}: {
  state: AnyState;
  label?: string;
  title?: string;
  size?: "xs" | "sm";
}) {
  const style = STATE_STYLE[state];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded font-semibold tracking-wide whitespace-nowrap ${
        size === "xs" ? "text-[10px] px-1.5 py-0.5" : "text-[11px] px-2 py-0.5"
      }`}
      style={{ color: style.fg, background: style.bg }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full shrink-0"
        style={{ background: style.fg }}
      />
      {label ?? style.label}
    </span>
  );
}

/** Absolute timestamp with a UTC + America/New_York tooltip and relative age. */
export function Timestamp({
  iso,
  ageSeconds,
  className = "",
}: {
  iso: string | null;
  ageSeconds?: number | null;
  className?: string;
}) {
  const nowMs = useNowMs();
  if (!iso) {
    return <span className={`text-muted ${className}`}>no timestamp</span>;
  }
  // `nowMs` is 0 during SSR and the first hydration pass; fall back to the
  // server-computed age so the markup matches and no impure clock is read.
  const age =
    nowMs === 0
      ? (ageSeconds ?? null)
      : Math.round((nowMs - Date.parse(iso)) / 1000);
  return (
    <time
      dateTime={iso}
      title={absoluteTimestamps(iso)}
      className={`numeric cursor-help underline decoration-dotted underline-offset-2 decoration-[color:var(--border-strong)] ${className}`}
    >
      {age === null ? iso.replace("T", " ").slice(0, 16) : formatAge(age)}
    </time>
  );
}

/** The provenance footer every section must carry. */
export function ProvenanceLine({ provenance }: { provenance: Provenance }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted border-t border-border px-4 py-2">
      <StatePill state={provenance.freshness} size="xs" />
      <span className="font-medium text-secondary">{provenance.source}</span>
      <span aria-hidden="true">·</span>
      <span>{provenance.scope}</span>
      <span aria-hidden="true">·</span>
      <Timestamp iso={provenance.asOf} ageSeconds={provenance.ageSeconds} />
      {provenance.detail && (
        <>
          <span aria-hidden="true">·</span>
          <span className="max-w-full">{provenance.detail}</span>
        </>
      )}
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  provenance,
  children,
  id,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  provenance?: Provenance;
  children: ReactNode;
  id?: string;
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section className="panel" aria-labelledby={headingId} id={id}>
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h2
            id={headingId}
            className="text-[13px] font-semibold tracking-wide uppercase text-secondary"
          >
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
          )}
        </div>
        {actions}
      </header>
      <div className="px-4 py-3">{children}</div>
      {provenance && <ProvenanceLine provenance={provenance} />}
    </section>
  );
}

/** A labelled figure. `value` of `null` renders an explicit dash, never `0`. */
export function Metric({
  label,
  value,
  hint,
  tone = "neutral",
  state,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: "neutral" | "positive" | "negative";
  state?: AnyState;
}) {
  const color =
    tone === "positive"
      ? "var(--accent-green)"
      : tone === "negative"
        ? "var(--accent-red)"
        : "var(--text-primary)";
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-2 flex-wrap">
        <span
          className="text-lg font-semibold numeric tabular-nums"
          style={{ color }}
        >
          {value}
        </span>
        {state && <StatePill state={state} size="xs" />}
      </dd>
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
      {children}
    </dl>
  );
}

/** Compact definition row for dense operational facts. */
export function Fact({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5 border-b border-border last:border-b-0">
      <dt className="text-xs text-muted shrink-0">{label}</dt>
      <dd
        className={`text-xs text-foreground text-right break-all ${
          mono ? "font-mono numeric" : ""
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

export function FactList({ children }: { children: ReactNode }) {
  return <dl className="divide-y-0">{children}</dl>;
}

/**
 * The standard empty state. Every page renders this instead of zeros when a
 * source is unavailable, stale beyond use, mismatched or not applicable.
 */
export function UnavailableBlock({
  state,
  title,
  detail,
  source,
}: {
  state: AnyState;
  title: string;
  detail?: string | null;
  source?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface/60 px-4 py-5">
      <StatePill state={state} />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && <p className="text-xs text-secondary max-w-prose">{detail}</p>}
      {source && <p className="text-[11px] text-muted">Source: {source}</p>}
    </div>
  );
}

/** Horizontal scroll container so a dense table never overflows the page. */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="table-scroll -mx-4 px-4" tabIndex={0} role="group">
      {children}
    </div>
  );
}

export function Dash() {
  return (
    <span className="text-muted" title="No value recorded">
      —
    </span>
  );
}

/** Short SHA with the full value available on hover/copy. */
export function Sha({ value }: { value: string | null | undefined }) {
  if (!value) return <Dash />;
  return (
    <code className="font-mono text-[11px]" title={value}>
      {value.slice(0, 12)}
    </code>
  );
}
