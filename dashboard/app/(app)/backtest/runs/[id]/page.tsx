import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchStateFile } from "@/lib/github";
import type {
  SingleResult,
  SweepResult,
  MonteCarloResult,
  WalkForwardResult,
  ComparisonResult,
} from "@/lib/backtest-types";
import BacktestEquityChart from "@/components/BacktestEquityChart";
import BacktestComparisonChart from "@/components/BacktestComparisonChart";
import PerTradeChart from "@/components/PerTradeChart";

export const dynamic = "force-dynamic";

/**
 * Detail page for one archived backtest run.
 *
 * Reads state/backtest/runs/{id}.json from GitHub and renders the
 * appropriate UI based on the run's `kind`. Every mode that the
 * Backtest workflow can produce has its own rendering branch.
 */

const ID_REGEX = /^[a-z_]+_\d{8}_\d{6}$/;

interface PageProps {
  params: Promise<{ id: string }>;
}

type AnyRun =
  | (SingleResult & { run_id?: string })
  | (SweepResult & { run_id?: string })
  | (MonteCarloResult & { run_id?: string })
  | (WalkForwardResult & { run_id?: string })
  | (ComparisonResult & { run_id?: string });

export default async function RunDetailPage({ params }: PageProps) {
  const { id } = await params;
  if (!id || !ID_REGEX.test(id)) {
    notFound();
  }
  const run = await fetchStateFile<AnyRun>(`backtest/runs/${id}.json`);
  if (!run) {
    return (
      <div className="space-y-6 animate-fade-in">
        <BackLink />
        <div className="glass-card p-8 text-center">
          <p className="text-sm text-secondary font-medium mb-2">Run not found</p>
          <p className="text-xs text-muted">
            <code>{id}</code> wasn&apos;t found in <code>state/backtest/runs/</code>. It may have been pruned, or the manifest is stale.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <BackLink />
      <div>
        <h2 className="text-2xl font-semibold text-foreground">
          Run: <span className="text-blue">{id}</span>
        </h2>
        <p className="text-xs text-muted mt-0.5">
          Generated {run.generated_at} · kind <code>{run.kind}</code>
        </p>
      </div>
      {renderRun(run)}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/backtest"
      className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground transition-colors"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15 18 9 12 15 6" />
      </svg>
      All backtest runs
    </Link>
  );
}

function renderRun(run: AnyRun) {
  // Every run kind can theoretically be saved with just an `error` field
  // (e.g. compare without a prior sweep, monte-carlo with no history). Short-
  // circuit to a friendly error panel rather than crash on undefined fields.
  const err = (run as unknown as { error?: string }).error;
  if (err) {
    return (
      <div className="glass-card p-5 border border-amber/30">
        <h3 className="text-sm font-medium text-secondary mb-2">This run did not complete</h3>
        <p className="text-xs text-muted">{err}</p>
      </div>
    );
  }
  switch (run.kind) {
    case "single":
      return <SingleView run={run as SingleResult} />;
    case "sweep":
      return <SweepView run={run as SweepResult} />;
    case "monte_carlo":
      return <MonteCarloView run={run as MonteCarloResult} />;
    case "walk_forward":
      return <WalkForwardView run={run as WalkForwardResult} />;
    case "compare":
      return <CompareView run={run as ComparisonResult} />;
    default:
      return (
        <div className="glass-card p-6 text-center text-muted text-sm">
          Unknown run kind: <code>{(run as { kind?: string }).kind}</code>
        </div>
      );
  }
}

function MetricTile({
  label, value, good, highlight,
}: { label: string; value: string; good: boolean; highlight?: boolean }) {
  return (
    <div className={`glass-card p-4 ${highlight ? "ring-2 ring-blue/30" : ""}`}>
      <p className="text-[10px] text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-semibold mt-1 ${good ? "text-blue" : "text-red"}`}>{value}</p>
    </div>
  );
}

function SingleView({ run }: { run: SingleResult }) {
  const m = run.metrics;
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricTile label="Total Return" value={fmtPct(m.total_return_pct)} good={m.total_return_pct >= 0} />
        <MetricTile label="Annualized" value={fmtPct(m.annual_return_pct)} good={m.annual_return_pct >= 0} />
        <MetricTile label="Alpha (Annual)" value={fmtPct(m.alpha_annual_pct)} good={m.alpha_annual_pct >= 0} highlight />
        <MetricTile label="Sharpe" value={m.sharpe_ratio.toFixed(2)} good={m.sharpe_ratio >= 1} />
        <MetricTile label="Max Drawdown" value={`${m.max_drawdown_pct.toFixed(2)}%`} good={m.max_drawdown_pct >= -15} />
        <MetricTile label="Win Rate" value={`${m.win_rate_pct.toFixed(0)}%`} good={m.win_rate_pct >= 50} />
      </div>

      <BacktestEquityChart daily={run.daily_history} spyBaseline={m.spy_baseline_equity} />

      <PerTradeChart trades={run.closed_trades} />

      <div className="glass-card p-5">
        <h3 className="text-sm font-medium text-secondary mb-3">Per-Symbol P&amp;L</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="text-left py-2 px-2">Symbol</th>
                <th className="text-right py-2 px-2">Trades</th>
                <th className="text-right py-2 px-2">Wins</th>
                <th className="text-right py-2 px-2">Avg/Trade</th>
                <th className="text-right py-2 px-2">Total P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {m.per_symbol.map((s) => (
                <tr key={s.symbol} className="border-b border-border/50">
                  <td className="py-1.5 px-2 font-medium">{s.symbol}</td>
                  <td className="py-1.5 px-2 text-right">{s.trades}</td>
                  <td className="py-1.5 px-2 text-right">{s.wins}</td>
                  <td className={`py-1.5 px-2 text-right ${s.avg_pnl_per_trade >= 0 ? "text-blue" : "text-red"}`}>
                    ${s.avg_pnl_per_trade.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                  <td className={`py-1.5 px-2 text-right font-medium ${s.pnl_total >= 0 ? "text-blue" : "text-red"}`}>
                    ${s.pnl_total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function SweepView({ run }: { run: SweepResult }) {
  const sorted = [...run.results].sort(
    (a, b) => (b.metrics.alpha_annual_pct ?? 0) - (a.metrics.alpha_annual_pct ?? 0),
  );
  return (
    <div className="glass-card p-5">
      <h3 className="text-sm font-medium text-secondary mb-1">
        Parameter Sweep · {run.results.length} combinations
      </h3>
      <p className="text-xs text-muted mb-3">
        Period: {run.start_date} → {run.end_date}. Ranked by annual alpha.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="text-right py-2 px-2">Threshold Δ</th>
              <th className="text-right py-2 px-2">Risk %</th>
              <th className="text-right py-2 px-2">Stop %</th>
              <th className="text-right py-2 px-2">Annual α</th>
              <th className="text-right py-2 px-2">Sharpe</th>
              <th className="text-right py-2 px-2">Max DD</th>
              <th className="text-right py-2 px-2">Trades</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="py-1.5 px-2 text-right">{row.params.score_threshold_delta > 0 ? "+" : ""}{row.params.score_threshold_delta}</td>
                <td className="py-1.5 px-2 text-right">{row.params.risk_per_trade_pct}</td>
                <td className="py-1.5 px-2 text-right">{row.params.trailing_stop_pct}</td>
                <td className={`py-1.5 px-2 text-right font-medium ${(row.metrics.alpha_annual_pct ?? 0) >= 0 ? "text-green" : "text-red"}`}>
                  {(row.metrics.alpha_annual_pct ?? 0) >= 0 ? "+" : ""}
                  {(row.metrics.alpha_annual_pct ?? 0).toFixed(2)}%
                </td>
                <td className="py-1.5 px-2 text-right">{(row.metrics.sharpe_ratio ?? 0).toFixed(2)}</td>
                <td className="py-1.5 px-2 text-right text-red">{(row.metrics.max_drawdown_pct ?? 0).toFixed(2)}%</td>
                <td className="py-1.5 px-2 text-right text-muted">{row.metrics.n_trades ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MonteCarloView({ run }: { run: MonteCarloResult }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricTile label="Median α" value={fmtPct(run.median_alpha_pct)} good={run.median_alpha_pct >= 0} highlight />
        <MetricTile label="P5 α" value={fmtPct(run.p5_alpha_pct)} good={run.p5_alpha_pct >= 0} />
        <MetricTile label="P95 α" value={fmtPct(run.p95_alpha_pct)} good={run.p95_alpha_pct >= 0} />
        <MetricTile label="P(beat SPY)" value={`${run.prob_beat_spy_pct.toFixed(1)}%`} good={run.prob_beat_spy_pct >= 60} />
        <MetricTile label="Median DD" value={`${run.median_max_dd_pct.toFixed(2)}%`} good={run.median_max_dd_pct >= -15} />
        <MetricTile label="P5 DD" value={`${run.p5_max_dd_pct.toFixed(2)}%`} good={run.p5_max_dd_pct >= -25} />
        <MetricTile label="P95 DD" value={`${run.p95_max_dd_pct.toFixed(2)}%`} good={run.p95_max_dd_pct >= -10} />
        <MetricTile label="Median Equity" value={`$${run.median_equity.toLocaleString()}`} good={run.median_equity >= 1_000_000} />
      </div>
      <div className="glass-card p-5">
        <p className="text-xs text-muted">
          Bootstrap re-sampling of {run.n_days_per_sim} daily returns from the baseline backtest, {run.n_simulations} simulations.
        </p>
      </div>
    </div>
  );
}

function WalkForwardView({ run }: { run: WalkForwardResult }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <MetricTile label="Mean OOS Alpha" value={fmtPct(run.aggregate.mean_oos_alpha_annual_pct)} good={run.aggregate.mean_oos_alpha_annual_pct >= 0} highlight />
        <MetricTile label="Mean OOS Sharpe" value={run.aggregate.mean_oos_sharpe.toFixed(2)} good={run.aggregate.mean_oos_sharpe >= 1} />
        <MetricTile label="Mean OOS Max DD" value={`${run.aggregate.mean_oos_max_drawdown_pct.toFixed(2)}%`} good={run.aggregate.mean_oos_max_drawdown_pct >= -15} />
      </div>
      <div className="glass-card p-5">
        <h3 className="text-sm font-medium text-secondary mb-3">Windows</h3>
        <table className="w-full text-xs">
          <thead className="text-muted border-b border-border">
            <tr>
              <th className="text-left py-2 px-2">#</th>
              <th className="text-left py-2 px-2">Train</th>
              <th className="text-left py-2 px-2">Test</th>
              <th className="text-right py-2 px-2">Best Δ</th>
              <th className="text-right py-2 px-2">Best risk</th>
              <th className="text-right py-2 px-2">OOS α/yr</th>
              <th className="text-right py-2 px-2">OOS Sharpe</th>
              <th className="text-right py-2 px-2">OOS Max DD</th>
            </tr>
          </thead>
          <tbody>
            {run.segments.map((s) => (
              <tr key={s.window_index} className="border-b border-border/50">
                <td className="py-1.5 px-2 font-medium">#{s.window_index}</td>
                <td className="py-1.5 px-2 text-muted">{s.train_start} → {s.train_end}</td>
                <td className="py-1.5 px-2 text-muted">{s.test_start} → {s.test_end}</td>
                <td className="py-1.5 px-2 text-right">{s.best_params.threshold_delta > 0 ? "+" : ""}{s.best_params.threshold_delta}</td>
                <td className="py-1.5 px-2 text-right">{s.best_params.risk_per_trade_pct}%</td>
                <td className={`py-1.5 px-2 text-right font-medium ${(s.test_metrics.alpha_annual_pct ?? 0) >= 0 ? "text-green" : "text-red"}`}>
                  {(s.test_metrics.alpha_annual_pct ?? 0) >= 0 ? "+" : ""}
                  {(s.test_metrics.alpha_annual_pct ?? 0).toFixed(2)}%
                </td>
                <td className="py-1.5 px-2 text-right">{(s.test_metrics.sharpe_ratio ?? 0).toFixed(2)}</td>
                <td className="py-1.5 px-2 text-right text-red">{(s.test_metrics.max_drawdown_pct ?? 0).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompareView({ run }: { run: ComparisonResult }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <MetricTile label="Annual α Δ" value={`${run.delta.alpha_annual_pp >= 0 ? "+" : ""}${run.delta.alpha_annual_pp.toFixed(2)}pp`} good={run.delta.alpha_annual_pp >= 0} highlight />
        <MetricTile label="Sharpe Δ" value={`${run.delta.sharpe >= 0 ? "+" : ""}${run.delta.sharpe.toFixed(2)}`} good={run.delta.sharpe >= 0} />
        <MetricTile label="Max DD Δ" value={`${run.delta.max_dd_pp >= 0 ? "+" : ""}${run.delta.max_dd_pp.toFixed(2)}pp`} good={run.delta.max_dd_pp >= 0} />
      </div>
      <BacktestComparisonChart
        baseline={run.baseline}
        challenger={run.challenger}
        spy={run.spy_baseline_equity}
      />
    </div>
  );
}

function fmtPct(v: number): string {
  if (v === undefined || v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}
