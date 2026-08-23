"use client";

import { money, percent } from "@/lib/status/client";
import { useAccountEquity, type EquitySnapshot } from "@/lib/status/use-equity";
import { GrowthChart, Disclosure } from "./status/charts";
import { Metric, MetricGrid, Panel, UnavailableBlock } from "./status/primitives";
import { useStrategyStatus } from "./status/StatusProvider";

/** Peak-to-trough of the shown series — descriptive stats of the curve on
 *  screen, not a strategy recomputation. */
function seriesStats(points: EquitySnapshot[]) {
  if (points.length === 0) return null;
  const first = points[0].equity;
  const last = points[points.length - 1].equity;
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, (p.equity - peak) / peak);
  }
  return {
    first,
    last,
    changePct: first > 0 ? ((last - first) / first) * 100 : null,
    maxDrawdownPct: maxDrawdown * 100,
    startDate: points[0].date,
    endDate: points[points.length - 1].date,
    sessions: points.length,
  };
}

export default function EquityPanel() {
  const { selectedAccount } = useStrategyStatus();
  const state = useAccountEquity(selectedAccount?.id ?? null);

  const title = "Account equity curve";
  const subtitle = "Broker accounting for the selected account — not the strategy's forward return";

  if (!selectedAccount || state.kind === "idle") {
    return (
      <Panel title={title} subtitle={subtitle}>
        <UnavailableBlock state="UNAVAILABLE" title="No account selected" />
      </Panel>
    );
  }
  if (state.kind === "loading") {
    return (
      <Panel title={title} subtitle={subtitle}>
        <span className="skeleton block h-56 w-full" />
      </Panel>
    );
  }
  if (state.kind === "error") {
    return (
      <Panel title={title} subtitle={subtitle}>
        <UnavailableBlock state="UNAVAILABLE" title="Equity curve unavailable" detail={state.message} />
      </Panel>
    );
  }

  const points = state.curve.snapshots;
  const stats = seriesStats(points);
  if (!stats || points.length < 2) {
    return (
      <Panel title={title} subtitle={subtitle}>
        <UnavailableBlock
          state="UNAVAILABLE"
          title="Not enough history to draw a curve"
          detail="At least two stored sessions are required."
        />
      </Panel>
    );
  }

  const data = points.map((p) => ({ date: p.date, value: p.equity }));

  return (
    <Panel title={title} subtitle={subtitle}>
      <MetricGrid>
        <Metric label="Latest equity" value={money(stats.last)} />
        <Metric
          label={`Change (${stats.sessions} sessions)`}
          value={percent(stats.changePct, 2, true)}
          tone={stats.changePct !== null && stats.changePct >= 0 ? "positive" : "negative"}
          hint={`${stats.startDate} → ${stats.endDate}`}
        />
        <Metric
          label="Max drawdown (window)"
          value={percent(stats.maxDrawdownPct, 2)}
          tone={stats.maxDrawdownPct < 0 ? "negative" : "neutral"}
        />
        <Metric label="Starting equity (window)" value={money(stats.first)} />
      </MetricGrid>
      <div className="mt-4">
        <GrowthChart data={data} primaryName="Account equity" valueFormatter={(v) => money(Number(v), true)} />
      </div>
      <Disclosure summary="What this curve is (and is not)">
        <p>
          This is the account&apos;s stored daily equity from the broker mirror. It
          is broker accounting for whichever account is selected and can include
          history that predates the V11 cutover, so it is <strong>not</strong> a
          measure of V11 forward alpha and is never relabelled as one. Deposits and
          withdrawals move the line without being profit.
        </p>
        <p>
          The audited V11-versus-SPY comparison lives in{" "}
          <strong>Validation &amp; research</strong> (backtest) and in the forward
          performance panel (only from a persisted V11 epoch baseline).
        </p>
      </Disclosure>
    </Panel>
  );
}
