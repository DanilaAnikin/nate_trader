"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { ManifestEntry } from "@/lib/backtest-types";

interface Props {
  runs: ManifestEntry[];
}

const KIND_LABELS: Record<string, string> = {
  single: "Single",
  sweep: "Sweep",
  monte_carlo: "Monte Carlo",
  walk_forward: "Walk-Forward",
  compare: "Compare",
};

const KIND_COLORS: Record<string, string> = {
  single: "bg-blue/10 text-blue",
  sweep: "bg-purple/10 text-purple",
  monte_carlo: "bg-cyan/10 text-cyan",
  walk_forward: "bg-green/10 text-green",
  compare: "bg-amber/10 text-amber",
};

/**
 * Run history list — table of every backtest archived in
 * state/backtest/runs/. Filterable by kind, sorted by date desc.
 * Each row links to /backtest/runs/{id} for the detail view.
 */
export default function RunHistoryTable({ runs }: Props) {
  const [filter, setFilter] = useState<string>("all");

  const kinds = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of runs) counts[r.kind] = (counts[r.kind] || 0) + 1;
    return counts;
  }, [runs]);

  const filtered = useMemo(() => {
    if (filter === "all") return runs;
    return runs.filter((r) => r.kind === filter);
  }, [runs, filter]);

  if (runs.length === 0) {
    return (
      <div className="glass-card p-8 text-center">
        <p className="text-sm text-secondary font-medium mb-2">No backtest runs yet</p>
        <p className="text-xs text-muted">
          Trigger the &ldquo;Backtest&rdquo; GitHub Actions workflow to record the first run.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-secondary">Run History</h3>
          <p className="text-xs text-muted mt-0.5">
            {runs.length} archived run{runs.length === 1 ? "" : "s"} · click any row to view its full result
          </p>
        </div>
        <div className="inline-flex items-center gap-0.5 bg-surface rounded-lg p-1">
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
            All ({runs.length})
          </FilterButton>
          {Object.entries(kinds).map(([k, count]) => (
            <FilterButton
              key={k}
              active={filter === k}
              onClick={() => setFilter(k)}
            >
              {KIND_LABELS[k] ?? k} ({count})
            </FilterButton>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="text-left py-2 px-2">Kind</th>
              <th className="text-left py-2 px-2">Run Date</th>
              <th className="text-left py-2 px-2">Period</th>
              <th className="text-right py-2 px-2">Headline Metric</th>
              <th className="text-right py-2 px-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="border-b border-border/50 hover:bg-surface/50 transition-colors">
                <td className="py-2 px-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${KIND_COLORS[r.kind] ?? "bg-surface text-muted"}`}>
                    {KIND_LABELS[r.kind] ?? r.kind}
                  </span>
                </td>
                <td className="py-2 px-2 text-muted">{r.generated_at}</td>
                <td className="py-2 px-2 text-muted">
                  {r.start_date} → {r.end_date}
                </td>
                <td className="py-2 px-2 text-right">{summaryText(r)}</td>
                <td className="py-2 px-2 text-right">
                  <Link
                    href={`/backtest/runs/${r.id}`}
                    className="text-blue hover:underline text-[11px] font-medium"
                  >
                    View →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all ${
        active ? "bg-white text-foreground shadow-sm" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function summaryText(r: ManifestEntry): React.ReactNode {
  const s = r.summary ?? {};
  if (r.kind === "single") {
    const alpha = s.alpha_annual_pct as number | undefined;
    const total = s.total_return_pct as number | undefined;
    if (alpha === undefined) return <span className="text-muted">—</span>;
    return (
      <span className={alpha >= 0 ? "text-green" : "text-red"}>
        α {alpha >= 0 ? "+" : ""}{alpha.toFixed(2)}%/yr
        {total !== undefined && (
          <span className="text-muted ml-1">({total >= 0 ? "+" : ""}{total.toFixed(1)}% total)</span>
        )}
      </span>
    );
  }
  if (r.kind === "sweep") {
    const best = s.best_alpha_annual_pct as number | undefined;
    const n = s.n_combinations as number | undefined;
    if (best === undefined) return <span className="text-muted">—</span>;
    return (
      <span className={best >= 0 ? "text-green" : "text-red"}>
        best α {best >= 0 ? "+" : ""}{best.toFixed(2)}%/yr <span className="text-muted">({n} combos)</span>
      </span>
    );
  }
  if (r.kind === "monte_carlo") {
    const med = s.median_alpha_pct as number | undefined;
    const prob = s.prob_beat_spy_pct as number | undefined;
    if (med === undefined) return <span className="text-muted">—</span>;
    return (
      <span>
        <span className={med >= 0 ? "text-green" : "text-red"}>median α {med >= 0 ? "+" : ""}{med.toFixed(2)}%</span>
        {prob !== undefined && <span className="text-muted ml-1">(P-beat {prob.toFixed(0)}%)</span>}
      </span>
    );
  }
  if (r.kind === "walk_forward") {
    const oos = s.mean_oos_alpha_annual_pct as number | undefined;
    const n = s.n_windows as number | undefined;
    if (oos === undefined) return <span className="text-muted">—</span>;
    return (
      <span className={oos >= 0 ? "text-green" : "text-red"}>
        OOS α {oos >= 0 ? "+" : ""}{oos.toFixed(2)}%/yr <span className="text-muted">({n} windows)</span>
      </span>
    );
  }
  if (r.kind === "compare") {
    const dAlpha = s.alpha_annual_pp as number | undefined;
    if (dAlpha === undefined) return <span className="text-muted">—</span>;
    return (
      <span className={dAlpha >= 0 ? "text-green" : "text-red"}>
        Δα {dAlpha >= 0 ? "+" : ""}{dAlpha.toFixed(2)}pp
      </span>
    );
  }
  return <span className="text-muted">—</span>;
}
