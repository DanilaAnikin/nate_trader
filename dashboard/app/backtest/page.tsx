import { fetchStateFile } from "@/lib/github";
import type {
  SingleResult,
  SweepResult,
  MonteCarloResult,
  WalkForwardResult,
  ComparisonResult,
  Manifest,
} from "@/lib/backtest-types";
import BacktestEquityChart from "@/components/BacktestEquityChart";
import BacktestComparisonChart from "@/components/BacktestComparisonChart";
import PerTradeChart from "@/components/PerTradeChart";
import RunHistoryTable from "@/components/RunHistoryTable";

export const dynamic = "force-dynamic";

export default async function BacktestPage() {
  const [single, sweep, mc, walk, cmp, manifest] = await Promise.all([
    fetchStateFile<SingleResult>("backtest/latest_result.json"),
    fetchStateFile<SweepResult>("backtest/sweep_result.json"),
    fetchStateFile<MonteCarloResult>("backtest/monte_carlo_result.json"),
    fetchStateFile<WalkForwardResult>("backtest/walk_forward_result.json"),
    fetchStateFile<ComparisonResult>("backtest/comparison_result.json"),
    fetchStateFile<Manifest>("backtest/manifest.json"),
  ]);
  const runs = manifest?.runs ?? [];

  if (!single) {
    return (
      <div className="space-y-6 animate-fade-in">
        <h2 className="text-2xl font-semibold text-foreground">Backtest</h2>
        {runs.length > 0 && <RunHistoryTable runs={runs} />}
        <div className="glass-card p-8 text-center">
          <p className="text-sm text-secondary font-medium mb-2">No single backtest yet</p>
          <p className="text-xs text-muted max-w-md mx-auto">
            Trigger the &ldquo;Backtest&rdquo; GitHub Actions workflow (Actions tab → Backtest → Run workflow) with mode=<code>single</code> to generate the first equity curve and metrics. Past runs (if any) appear above.
          </p>
        </div>
      </div>
    );
  }

  const m = single.metrics;
  const sortedSweep = sweep?.results
    ? [...sweep.results].sort(
        (a, b) => (b.metrics.alpha_annual_pct ?? 0) - (a.metrics.alpha_annual_pct ?? 0),
      )
    : [];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Backtest</h2>
          <p className="text-xs text-muted mt-0.5">
            Replay of the live strategy on historical bars · {single.config.start_date} → {single.config.end_date} · slippage {single.config.slippage_bps} bps
          </p>
        </div>
        <p className="text-xs text-muted">Last run: {single.generated_at}</p>
      </div>

      {/* Run history — all archived runs across all modes */}
      <RunHistoryTable runs={runs} />

      {/* Headline metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricTile label="Total Return" value={`${m.total_return_pct >= 0 ? "+" : ""}${m.total_return_pct.toFixed(2)}%`} good={m.total_return_pct >= 0} />
        <MetricTile label="Annualized" value={`${m.annual_return_pct >= 0 ? "+" : ""}${m.annual_return_pct.toFixed(2)}%`} good={m.annual_return_pct >= 0} />
        <MetricTile label="Alpha (Annual)" value={`${m.alpha_annual_pct >= 0 ? "+" : ""}${m.alpha_annual_pct.toFixed(2)}%`} good={m.alpha_annual_pct >= 0} highlight />
        <MetricTile label="Sharpe" value={m.sharpe_ratio.toFixed(2)} good={m.sharpe_ratio >= 1} />
        <MetricTile label="Max Drawdown" value={`${m.max_drawdown_pct.toFixed(2)}%`} good={m.max_drawdown_pct >= -15} />
        <MetricTile label="Win Rate" value={`${m.win_rate_pct.toFixed(0)}%`} good={m.win_rate_pct >= 50} />
      </div>

      {/* Equity curve vs SPY */}
      <BacktestEquityChart daily={single.daily_history} spyBaseline={m.spy_baseline_equity} />

      {/* Trade stats + regime breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-3">Trade Stats</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <StatRow label="Trades" value={m.n_trades.toString()} />
            <StatRow label="Trading days" value={m.n_trading_days.toString()} />
            <StatRow label="Avg win" value={`${m.avg_win_pct.toFixed(2)}%`} good />
            <StatRow label="Avg loss" value={`${m.avg_loss_pct.toFixed(2)}%`} bad />
            <StatRow
              label="Profit factor"
              value={m.profit_factor === null ? "∞" : m.profit_factor.toFixed(2)}
            />
            <StatRow label="Hedge P&L" value={`$${m.hedge_total_pnl.toLocaleString()}`} />
            <StatRow label="Vol (annual)" value={`${m.annual_vol_pct.toFixed(2)}%`} />
            <StatRow label="DD peak→trough" value={`${m.max_drawdown_peak_date ?? "—"} → ${m.max_drawdown_trough_date ?? "—"}`} />
          </div>
        </div>

        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-3">Regime Breakdown</h3>
          <div className="space-y-2 text-xs">
            {Object.entries(m.regime_breakdown).map(([regime, b]) => (
              <div key={regime} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                      regime === "BULL"
                        ? "bg-green/8 text-green"
                        : regime === "BEAR"
                        ? "bg-red/8 text-red"
                        : "bg-amber/8 text-amber"
                    }`}
                  >
                    {regime}
                  </span>
                  <span className="text-muted">{b.days}d ({b.pct_of_time.toFixed(0)}%)</span>
                </div>
                <span className={`font-medium ${b.total_pnl_pct >= 0 ? "text-blue" : "text-red"}`}>
                  {b.total_pnl_pct >= 0 ? "+" : ""}{b.total_pnl_pct.toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Per-symbol P&L */}
      <div className="glass-card p-5">
        <h3 className="text-sm font-medium text-secondary mb-3">Per-Symbol P&amp;L</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted border-b border-border">
              <tr>
                <th className="text-left py-2 px-2">Symbol</th>
                <th className="text-right py-2 px-2">Trades</th>
                <th className="text-right py-2 px-2">Wins</th>
                <th className="text-right py-2 px-2">Win %</th>
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
                  <td className="py-1.5 px-2 text-right text-muted">
                    {s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(0) : 0}%
                  </td>
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

      {/* Sweep summary */}
      {sortedSweep.length > 0 && (
        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-1">Parameter Sweep — Top 10 by annual alpha</h3>
          <p className="text-xs text-muted mb-3">
            {sweep!.results.length} parameter combinations tested. Threshold delta is added to the regime's base score_threshold.
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
                {sortedSweep.slice(0, 10).map((row, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="py-1.5 px-2 text-right">
                      {(row.params.score_threshold_delta ?? 0) > 0 ? "+" : ""}
                      {row.params.score_threshold_delta}
                    </td>
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
      )}

      {/* Per-trade chart */}
      <PerTradeChart trades={single.closed_trades} />

      {/* Walk-forward — out-of-sample robustness */}
      {walk && walk.segments?.length > 0 && (
        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-1">
            Walk-Forward Optimization · {walk.config.train_months}m train / {walk.config.test_months}m test · {walk.aggregate.n_windows} windows
          </h3>
          <p className="text-xs text-muted mb-3">
            Each window picks the best params on the train period, then measures them on the next test period.
            The aggregate row is the strategy&apos;s expected out-of-sample edge.
          </p>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <MetricTile
              label="Mean OOS Alpha"
              value={`${walk.aggregate.mean_oos_alpha_annual_pct >= 0 ? "+" : ""}${walk.aggregate.mean_oos_alpha_annual_pct.toFixed(2)}%`}
              good={walk.aggregate.mean_oos_alpha_annual_pct >= 0}
              highlight
            />
            <MetricTile
              label="Mean OOS Sharpe"
              value={walk.aggregate.mean_oos_sharpe.toFixed(2)}
              good={walk.aggregate.mean_oos_sharpe >= 1}
            />
            <MetricTile
              label="Mean OOS Max DD"
              value={`${walk.aggregate.mean_oos_max_drawdown_pct.toFixed(2)}%`}
              good={walk.aggregate.mean_oos_max_drawdown_pct >= -15}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted border-b border-border">
                <tr>
                  <th className="text-left py-2 px-2">Window</th>
                  <th className="text-left py-2 px-2">Train</th>
                  <th className="text-left py-2 px-2">Test</th>
                  <th className="text-right py-2 px-2">Best Δ</th>
                  <th className="text-right py-2 px-2">Best risk</th>
                  <th className="text-right py-2 px-2">OOS α/yr</th>
                  <th className="text-right py-2 px-2">OOS Sharpe</th>
                  <th className="text-right py-2 px-2">OOS Max DD</th>
                  <th className="text-right py-2 px-2">Trades</th>
                </tr>
              </thead>
              <tbody>
                {walk.segments.map((s) => (
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
                    <td className="py-1.5 px-2 text-right text-muted">{s.test_metrics.n_trades ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Comparison */}
      {cmp && (
        <div className="space-y-4">
          <div className="glass-card p-5">
            <h3 className="text-sm font-medium text-secondary mb-3">
              Side-by-Side · Baseline vs Challenger
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <MetricTile
                label="Annual α Δ"
                value={`${cmp.delta.alpha_annual_pp >= 0 ? "+" : ""}${cmp.delta.alpha_annual_pp.toFixed(2)}pp`}
                good={cmp.delta.alpha_annual_pp >= 0}
                highlight
              />
              <MetricTile
                label="Sharpe Δ"
                value={`${cmp.delta.sharpe >= 0 ? "+" : ""}${cmp.delta.sharpe.toFixed(2)}`}
                good={cmp.delta.sharpe >= 0}
              />
              <MetricTile
                label="Max DD Δ"
                value={`${cmp.delta.max_dd_pp >= 0 ? "+" : ""}${cmp.delta.max_dd_pp.toFixed(2)}pp`}
                good={cmp.delta.max_dd_pp >= 0}
              />
            </div>
            <p className="text-[10px] text-muted mt-3">
              Challenger params: <code>{typeof cmp.challenger.params === "string" ? cmp.challenger.params : JSON.stringify(cmp.challenger.params)}</code>
            </p>
          </div>
          <BacktestComparisonChart
            baseline={cmp.baseline}
            challenger={cmp.challenger}
            spy={cmp.spy_baseline_equity}
          />
        </div>
      )}

      {/* Monte Carlo */}
      {mc && (
        <div className="glass-card p-5">
          <h3 className="text-sm font-medium text-secondary mb-3">
            Monte Carlo Robustness ({mc.n_simulations} simulations)
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <StatRow label="Median alpha" value={`${mc.median_alpha_pct >= 0 ? "+" : ""}${mc.median_alpha_pct.toFixed(2)}%`} good={mc.median_alpha_pct >= 0} />
            <StatRow label="P5 alpha" value={`${mc.p5_alpha_pct >= 0 ? "+" : ""}${mc.p5_alpha_pct.toFixed(2)}%`} bad={mc.p5_alpha_pct < 0} />
            <StatRow label="P95 alpha" value={`${mc.p95_alpha_pct >= 0 ? "+" : ""}${mc.p95_alpha_pct.toFixed(2)}%`} good={mc.p95_alpha_pct >= 0} />
            <StatRow label="P(beat SPY)" value={`${mc.prob_beat_spy_pct.toFixed(1)}%`} good={mc.prob_beat_spy_pct >= 60} />
            <StatRow label="Median DD" value={`${mc.median_max_dd_pct.toFixed(2)}%`} />
            <StatRow label="P5 DD" value={`${mc.p5_max_dd_pct.toFixed(2)}%`} />
            <StatRow label="P95 DD" value={`${mc.p95_max_dd_pct.toFixed(2)}%`} />
            <StatRow label="Median equity" value={`$${mc.median_equity.toLocaleString()}`} />
          </div>
          <p className="text-[10px] text-muted mt-3">
            Bootstrap re-sampling of {mc.n_days_per_sim} daily returns from the baseline backtest. Wider P5↔P95 spread indicates higher variance in possible outcomes — a strategy that&apos;s clearly +alpha across the band is robust.
          </p>
        </div>
      )}
    </div>
  );
}

function MetricTile({
  label, value, good, highlight,
}: {
  label: string;
  value: string;
  good: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={`glass-card p-4 ${highlight ? "ring-2 ring-blue/30" : ""}`}>
      <p className="text-[10px] text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-semibold mt-1 ${good ? "text-blue" : "text-red"}`}>{value}</p>
    </div>
  );
}

function StatRow({
  label, value, good, bad,
}: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  const colorClass = good ? "text-blue" : bad ? "text-red" : "text-foreground";
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-muted">{label}</span>
      <span className={`font-medium ${colorClass}`}>{value}</span>
    </div>
  );
}
