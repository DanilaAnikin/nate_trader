"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { money, percent, points } from "@/lib/status/client";
import type { PerformanceUnavailableReason } from "@/app/api/accounts/[id]/performance/route";
import {
  Metric,
  MetricGrid,
  Panel,
  StatePill,
  UnavailableBlock,
} from "./status/primitives";
import { useStrategyStatus } from "./status/StatusProvider";

/**
 * Account-scoped V11 forward performance.
 *
 * Shown only from a persisted, auditable V11 epoch baseline, using
 * cash-flow-adjusted time-weighted return over exactly the sessions the
 * portfolio and the benchmark share. Anything else is `UNAVAILABLE` — account
 * history that predates the V11 cutover is never relabelled as V11 alpha, and
 * a deposit is never presented as profit.
 */
function unavailableCopy(mode: "paper" | "live", reason: PerformanceUnavailableReason | null) {
  const name = mode === "live" ? "Live" : "Paper";
  if (reason === "NOT_PRODUCTION_VIEWER") {
    return {
      title: `${name} performance is not available for this account`,
      guidance: mode === "live"
        ? "Connecting a live account makes its broker balances available. It does not start a strategy performance record or enable trading. Paper performance belongs to the paper account."
        : "V11 performance belongs to the verified production account. Select that account to view its measured results; this account's balances remain separate.",
    };
  }
  if (reason === "NO_BASELINE") {
    return {
      title: mode === "live"
        ? "No verified live performance window"
        : "V11 forward performance unavailable — baseline not persisted",
      guidance: mode === "live"
        ? "Returns can be shown only after a verified live measurement window and shared account/benchmark observations exist. Connecting or funding an account alone does not establish that window."
        : "Only observations inside a verified V11 measurement window count. Earlier account activity must not be relabelled as V11 performance.",
    };
  }
  if (reason?.startsWith("BASELINE_")) {
    return {
      title: "Performance reference could not be verified",
      guidance: "The saved measurement reference must agree with this account, release and observed history. Existing history is retained; no return is shown while that reference is unresolved.",
    };
  }
  if (["NO_EQUITY_HISTORY", "NO_BENCHMARK_HISTORY", "NO_COMMON_SESSIONS"].includes(reason ?? "")) {
    return {
      title: "Not enough shared performance observations",
      guidance: "Returns need account equity and benchmark prices for the same measured sessions, with external cash flows accounted for. Missing observations are not zero returns.",
    };
  }
  if (reason === "APPROVED_RELEASE_UNKNOWN") {
    return {
      title: "Performance release could not be verified",
      guidance: "The approved trading release must be readable before this account's measurement reference can be checked. Existing performance history is retained.",
    };
  }
  if (reason === "NO_CREDENTIALS") {
    return {
      title: "Account connection is unavailable",
      guidance: "Check this account's connection on the Accounts page. A missing connection is not evidence of a zero balance or a zero return.",
    };
  }
  return {
    title: "Forward performance unavailable",
    guidance: "The recorded data is currently insufficient or could not be verified. No estimated return is substituted, and the existing measurement history is retained.",
  };
}

export default function ForwardPerformancePanel() {
  // The panel does not fetch: it reads the performance slice the shared status
  // provider refreshes in the same cycle, so one Refresh click renews both
  // without a page reload. Provenance stays separate — this is a different
  // source with its own freshness contract.
  const { performance: state, selectedAccount } = useStrategyStatus();
  const mode = selectedAccount?.mode ?? "paper";
  const title = mode === "live"
    ? "E · Forward live performance"
    : "E · Forward paper-validation performance";
  if (!selectedAccount) {
    return (
      <Panel title={title}>
        <UnavailableBlock
          state="UNAVAILABLE"
          title="Forward performance unavailable"
          detail="No account is selected."
        />
      </Panel>
    );
  }

  if (state.kind === "loading") {
    return (
      <Panel title={title}>
        <span className="skeleton block h-32 w-full" />
      </Panel>
    );
  }
  if (state.kind === "error") {
    return (
      <Panel title={title}>
        <UnavailableBlock
          state="UNAVAILABLE"
          title="Forward performance unavailable"
          detail={state.message}
        />
      </Panel>
    );
  }

  const { body } = state;
  if (body.status === "UNAVAILABLE" || !body.performance) {
    const copy = unavailableCopy(mode, body.reason);
    return (
      <Panel
        title={title}
        subtitle="Only measured from a persisted V11 epoch baseline"
      >
        <UnavailableBlock
          state="UNAVAILABLE"
          title={copy.title}
          detail={body.detail ?? undefined}
          source={body.provenance.source}
        />
        {body.reason && (
          <p className="mt-3 text-[11px] text-muted">
            Reason code: <code className="font-mono">{body.reason}</code>
          </p>
        )}
        <p className="mt-3 text-xs text-secondary max-w-prose">
          {copy.guidance}
        </p>
      </Panel>
    );
  }

  const performance = body.performance;
  const baseline = body.baseline;
  // A number that is no longer current must say so where the number is, not
  // only in the provenance footer.
  const outdated = body.status === "STALE" || body.status === "EXPIRED";
  return (
    <Panel
      title={title}
      subtitle={`Cash-flow-adjusted TWR vs ${performance.benchmarkSymbol} over ${performance.sessions} shared sessions (${performance.startDate} → ${performance.endDate})`}
    >
      {outdated && (
        <div
          role="status"
          className="mb-4 flex flex-col items-start gap-2 rounded-md border border-dashed border-border-strong bg-surface/60 px-4 py-3"
        >
          <StatePill state={body.status} />
          <p className="text-sm font-medium text-foreground">
            These figures are not current
          </p>
          <p className="text-xs text-secondary max-w-prose">
            {body.detail ??
              `The most recent session shared by the account and the benchmark is ${performance.endDate}.`}{" "}
            They describe the window ending on that session and say nothing
            about performance since.
          </p>
        </div>
      )}
      <MetricGrid>
        <Metric
          label="Portfolio TWR"
          value={percent(performance.portfolioTwrPct, 2, true)}
          tone={performance.portfolioTwrPct >= 0 ? "positive" : "negative"}
          hint="Time-weighted; external cash flows removed"
        />
        <Metric
          label={`${performance.benchmarkSymbol} return`}
          value={percent(performance.benchmarkReturnPct, 2, true)}
          hint="Same sessions, no forward fill"
        />
        <Metric
          label="Excess"
          value={points(performance.excessReturnPct)}
          tone={performance.excessReturnPct >= 0 ? "positive" : "negative"}
          hint="Raw excess return, not Jensen alpha"
        />
        <Metric
          label="Net external cash flow"
          value={money(performance.netCashFlow)}
          hint={`${performance.cashFlowCount} recorded flow(s) inside the window`}
        />
      </MetricGrid>

      <div className="mt-5 h-64" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={[...performance.series]}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--border)"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "var(--text-muted)" }}
              minTickGap={40}
              stroke="var(--border)"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--text-muted)" }}
              domain={["auto", "auto"]}
              stroke="var(--border)"
              width={44}
            />
            <Tooltip
              contentStyle={{
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Area
              type="monotone"
              dataKey="portfolioIndex"
              name={`V11 ${mode} (TWR index)`}
              stroke="var(--accent-blue)"
              fill="var(--tint-blue)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="benchmarkIndex"
              name={`${performance.benchmarkSymbol} index`}
              stroke="var(--accent-slate)"
              fill="transparent"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <table className="sr-only">
        <caption>
          Indexed forward performance, both series starting at 100 on{" "}
          {performance.startDate}
        </caption>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">V11 {mode} index</th>
            <th scope="col">{performance.benchmarkSymbol} index</th>
          </tr>
        </thead>
        <tbody>
          {performance.series.map((row) => (
            <tr key={row.date}>
              <th scope="row">{row.date}</th>
              <td>{row.portfolioIndex.toFixed(2)}</td>
              <td>{row.benchmarkIndex.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {baseline && (
        <p className="mt-4 text-[11px] text-muted">
          Epoch baseline: release {baseline.releaseSha.slice(0, 12)} ·{" "}
          {baseline.startSessionDate} · starting equity{" "}
          {money(baseline.startingEquity)} · {baseline.benchmarkSymbol} baseline{" "}
          {baseline.benchmarkBaselineClose} on {baseline.benchmarkBaselineDate}.
          This is a forward {mode} result, not a backtest and not a guarantee.
        </p>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Source: {body.provenance.source} · {body.provenance.scope} · last shared
        session {body.provenance.asOf ?? "unknown"} ·{" "}
        {body.provenance.freshness}.
      </p>
    </Panel>
  );
}
