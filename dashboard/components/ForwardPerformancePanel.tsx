"use client";

import { useEffect, useState } from "react";
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
import type { PerformanceResponse } from "@/app/api/accounts/[id]/performance/route";
import { money, percent, points } from "@/lib/status/client";
import { Metric, MetricGrid, Panel, UnavailableBlock } from "./status/primitives";
import { useStrategyStatus } from "./status/StatusProvider";

/**
 * V11 forward paper-validation performance.
 *
 * Shown only from a persisted, auditable V11 epoch baseline, using
 * cash-flow-adjusted time-weighted return over exactly the sessions the
 * portfolio and the benchmark share. Anything else is `UNAVAILABLE` — account
 * history that predates the V11 cutover is never relabelled as V11 alpha, and
 * a deposit is never presented as profit.
 */
export default function ForwardPerformancePanel() {
  const { selectedAccount } = useStrategyStatus();
  const accountId = selectedAccount?.id ?? null;
  // The result carries the account it belongs to, so a response for the
  // previously selected account can never be rendered after a switch.
  const [result, setResult] = useState<{
    accountId: string;
    value:
      | { kind: "error"; message: string }
      | { kind: "ready"; body: PerformanceResponse };
  } | null>(null);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    fetch(`/api/accounts/${encodeURIComponent(accountId)}/performance`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | PerformanceResponse
          | null;
        if (!response.ok || !body || body.accountId !== accountId) {
          setResult({
            accountId,
            value: {
              kind: "error",
              message:
                "Forward performance could not be loaded for the selected account.",
            },
          });
          return;
        }
        setResult({ accountId, value: { kind: "ready", body } });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          accountId,
          value: {
            kind: "error",
            message:
              caught instanceof Error
                ? caught.message
                : "Forward performance request failed.",
          },
        });
      });
    return () => controller.abort();
  }, [accountId]);

  const state =
    !accountId
      ? ({ kind: "error", message: "No account selected." } as const)
      : result?.accountId === accountId
        ? result.value
        : ({ kind: "loading" } as const);

  if (state.kind === "loading") {
    return (
      <Panel title="E · Forward paper-validation performance">
        <span className="skeleton block h-32 w-full" />
      </Panel>
    );
  }
  if (state.kind === "error") {
    return (
      <Panel title="E · Forward paper-validation performance">
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
    return (
      <Panel
        title="E · Forward paper-validation performance"
        subtitle="Only measured from a persisted V11 epoch baseline"
      >
        <UnavailableBlock
          state="UNAVAILABLE"
          title={
            body.reason === "NO_BASELINE"
              ? "V11 forward performance unavailable — baseline not persisted"
              : "V11 forward performance unavailable"
          }
          detail={body.detail ?? undefined}
          source={body.provenance.source}
        />
        {body.reason && (
          <p className="mt-3 text-[11px] text-muted">
            Reason code: <code className="font-mono">{body.reason}</code>
          </p>
        )}
        <p className="mt-3 text-xs text-secondary max-w-prose">
          All-time account equity contains pre-V11 (V10 / TQQQ / UPRO) history
          and must not be relabelled as V11 performance. Record an epoch
          baseline containing the approved release SHA, start time, starting
          equity and the benchmark baseline close to enable this panel.
        </p>
      </Panel>
    );
  }

  const performance = body.performance;
  const baseline = body.baseline;
  return (
    <Panel
      title="E · Forward paper-validation performance"
      subtitle={`Cash-flow-adjusted TWR vs ${performance.benchmarkSymbol} over ${performance.sessions} shared sessions (${performance.startDate} → ${performance.endDate})`}
    >
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
              name="V11 paper (TWR index)"
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
            <th scope="col">V11 paper index</th>
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
          This is a forward paper result, not a backtest and not a guarantee.
        </p>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Source: {body.provenance.source} · {body.provenance.scope} · through{" "}
        {body.provenance.asOf ?? "unknown"}.
      </p>
    </Panel>
  );
}
