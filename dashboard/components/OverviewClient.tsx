"use client";

import Link from "next/link";
import { integer, money, percent } from "@/lib/status/client";
import type { StrategyStatusPayload } from "@/lib/status/types";
import ForwardPerformancePanel from "./ForwardPerformancePanel";
import PageState from "./status/PageState";
import {
  Fact,
  FactList,
  Metric,
  MetricGrid,
  Panel,
  Sha,
  StatePill,
  Timestamp,
  UnavailableBlock,
} from "./status/primitives";

export default function OverviewClient() {
  return (
    <PageState>
      {(payload) => (
        <div className="space-y-5">
          <BrokerPanel payload={payload} />
          <MarketRiskPanel payload={payload} />
          <ConvergencePanel payload={payload} />
          <OperationsPanel payload={payload} />
          <ForwardPerformancePanel />
          <EvidencePanel payload={payload} />
        </div>
      )}
    </PageState>
  );
}

function BrokerPanel({ payload }: { payload: StrategyStatusPayload }) {
  const broker = payload.broker.data;
  const binding = payload.accountBinding.data;
  return (
    <Panel
      id="broker"
      title="A · Broker account"
      subtitle={
        binding
          ? `${binding.selectedAccountNickname} · ${binding.mode.toUpperCase()}${
              binding.brokerAccountMask ? ` · ${binding.brokerAccountMask}` : ""
            }`
          : undefined
      }
      provenance={payload.broker.provenance}
    >
      {broker ? (
        <MetricGrid>
          <Metric label="Equity" value={money(broker.equity)} />
          <Metric
            label="Cash"
            value={money(broker.cash)}
            hint={`${percent(broker.cashPct)} of equity`}
          />
          <Metric
            label="Daily P&L"
            value={money(broker.dailyPnl)}
            tone={broker.dailyPnl >= 0 ? "positive" : "negative"}
            hint={percent(broker.dailyPnlPct, 2, true)}
          />
          <Metric
            label="Actual gross exposure"
            value={percent(broker.grossExposurePct)}
            hint={money(broker.grossExposure)}
          />
          <Metric
            label="Actual positions"
            value={integer(broker.positionCount)}
            hint={
              broker.shortSymbols.length > 0
                ? `${broker.shortSymbols.length} short position(s): reconciliation state`
                : "no short positions"
            }
            state={broker.shortSymbols.length > 0 ? "FAIL" : undefined}
          />
        </MetricGrid>
      ) : (
        <UnavailableBlock
          state={payload.broker.provenance.freshness}
          title="Broker snapshot unavailable"
          detail={payload.broker.provenance.detail}
          source={payload.broker.provenance.source}
        />
      )}
    </Panel>
  );
}

function MarketRiskPanel({ payload }: { payload: StrategyStatusPayload }) {
  const strategy = payload.strategy.data;
  if (!strategy) {
    return (
      <Panel
        id="market"
        title="B · V11 market and risk state"
        provenance={payload.strategy.provenance}
      >
        <UnavailableBlock
          state={payload.strategy.provenance.freshness}
          title="V11 runtime state unavailable"
          detail={payload.strategy.provenance.detail}
          source={payload.strategy.provenance.source}
        />
      </Panel>
    );
  }

  const plan = strategy.plan;
  const execTier = strategy.executionRiskTier;
  return (
    <Panel
      id="market"
      title="B · V11 market and risk state"
      subtitle="Recorded by the production executor. Not recomputed in the browser."
      provenance={payload.strategy.provenance}
    >
      <MetricGrid>
        <Metric
          label="Signal session (D)"
          value={plan?.signalDate ?? "—"}
          hint={plan ? `rebalance month ${plan.rebalanceMonth}` : undefined}
        />
        <Metric
          label="SPY market gate"
          value={strategy.marketGate ?? "—"}
          tone={
            strategy.marketGate === "RISK_ON"
              ? "positive"
              : strategy.marketGate === "RISK_OFF"
                ? "negative"
                : "neutral"
          }
          state={strategy.marketGate ? undefined : "UNAVAILABLE"}
          hint={strategy.marketGateSource ?? undefined}
        />
        <Metric
          label="SPY close vs SMA200"
          value="—"
          state="UNAVAILABLE"
          hint="The runner does not persist the SPY close or its SMA200; the gate outcome above is the recorded fact."
        />
        <Metric
          label="Risk tier (execution)"
          value={execTier?.tier ?? "—"}
          state={
            execTier
              ? execTier.tier === "NORMAL"
                ? "PASS"
                : execTier.tier === "CAUTIOUS"
                  ? "WARN"
                  : "FAIL"
              : "UNAVAILABLE"
          }
          hint={execTier?.reason ?? undefined}
        />
        <Metric
          label="Rolling drawdown"
          value={percent(strategy.rollingDrawdownPct)}
          hint={
            strategy.riskLookbackSessions
              ? `${strategy.riskLookbackSessions}-session window · peak ${money(strategy.rollingPeakEquity, true)}`
              : undefined
          }
          tone={
            typeof strategy.rollingDrawdownPct === "number" &&
            strategy.rollingDrawdownPct <= -10
              ? "negative"
              : "neutral"
          }
        />
        <Metric
          label="Breadth"
          value="—"
          state="UNAVAILABLE"
          hint="Breadth census and its numerator/denominator are not persisted by the runner."
        />
        <Metric
          label="Breadth multiplier"
          value="—"
          state="UNAVAILABLE"
          hint="Not persisted. It is never inferred from the target weights."
        />
        <Metric
          label="Target gross (frozen plan)"
          value={plan ? percent(plan.targetGrossPct) : "—"}
          state={plan ? undefined : "UNAVAILABLE"}
          hint={plan ? `target cash ${percent(plan.targetCashPct)}` : undefined}
        />
        <Metric
          label="Recovery latch"
          value={
            strategy.recoveryLatchArmed === null
              ? "—"
              : strategy.recoveryLatchArmed
                ? "ARMED"
                : "NOT ARMED"
          }
          state={strategy.recoveryLatchArmed === null ? "UNAVAILABLE" : undefined}
          hint="Permits one fresh target after SPY closes back above SMA200."
        />
      </MetricGrid>

      {strategy.riskTierConflict && strategy.persistedRiskTier && execTier && (
        <div
          className="mt-4 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--accent-amber)",
            background: "var(--tint-amber)",
            color: "var(--text-primary)",
          }}
        >
          <strong className="font-semibold">Risk-tier source conflict.</strong>{" "}
          The cycle that made the decision captured{" "}
          <strong>{execTier.tier}</strong> from a fresh broker and rolling-history
          snapshot ({execTier.source}). The saved runtime file records{" "}
          <strong>{strategy.persistedRiskTier.tier}</strong> (
          {strategy.persistedRiskTier.source}
          {strategy.persistedRiskTier.reason
            ? `: ${strategy.persistedRiskTier.reason}`
            : ""}
          ). Both are shown; neither is silently preferred.
        </div>
      )}
    </Panel>
  );
}

function ConvergencePanel({ payload }: { payload: StrategyStatusPayload }) {
  const convergence = payload.convergence.data;
  const plan = payload.strategy.data?.plan ?? null;
  return (
    <Panel
      id="convergence"
      title="C · Target convergence"
      subtitle="Order submission is intent, never proof of a fill."
      actions={
        <Link
          href="/positions"
          className="text-xs text-blue hover:underline whitespace-nowrap"
        >
          Full portfolio →
        </Link>
      }
      provenance={payload.convergence.provenance}
    >
      {convergence ? (
        <>
          <MetricGrid>
            <Metric
              label="Frozen plan"
              value={plan ? plan.planId : "—"}
              hint={
                plan
                  ? `signal ${plan.signalDate ?? "unknown"} · construction tier ${plan.constructionRiskTier}`
                  : undefined
              }
            />
            <Metric
              label="Target / actual names"
              value={`${convergence.targetCount} / ${convergence.actualCount}`}
              hint={`${convergence.convergedCount} inside the drift band`}
            />
            <Metric
              label="Target vs actual gross"
              value={`${percent(convergence.targetGrossPct)} / ${percent(convergence.actualGrossPct)}`}
            />
            <Metric
              label="Target vs actual cash"
              value={`${percent(convergence.targetCashPct)} / ${percent(convergence.actualCashPct)}`}
            />
            <Metric
              label="Submitted, not proven filled"
              value={integer(convergence.pendingCount)}
              state={convergence.pendingCount > 0 ? "PENDING" : undefined}
            />
          </MetricGrid>
          <p className="mt-4 text-xs text-secondary max-w-prose">
            <span className="font-semibold text-foreground">
              Next safe action:{" "}
            </span>
            {convergence.nextSafeAction}
          </p>
          {convergence.legacyExcludedSymbols.length > 0 && (
            <p className="mt-2 text-xs" style={{ color: "var(--accent-amber)" }}>
              Legacy/excluded holdings still present:{" "}
              {convergence.legacyExcludedSymbols.join(", ")} — V11 target 0%.
            </p>
          )}
        </>
      ) : (
        <UnavailableBlock
          state={payload.convergence.provenance.freshness}
          title={
            payload.convergence.provenance.freshness === "NOT_APPLICABLE"
              ? "Target compliance does not apply to this account"
              : "Convergence unavailable"
          }
          detail={payload.convergence.provenance.detail}
          source={payload.convergence.provenance.source}
        />
      )}
    </Panel>
  );
}

function OperationsPanel({ payload }: { payload: StrategyStatusPayload }) {
  const operations = payload.operations.data;
  const execution = payload.execution.data;
  const preflight = payload.preflight.data;
  const release = payload.release.data;
  const latest = operations?.latestAttempt ?? null;

  return (
    <Panel
      id="operations"
      title="D · Operations"
      actions={
        <Link
          href="/operations"
          className="text-xs text-blue hover:underline whitespace-nowrap"
        >
          Operations detail →
        </Link>
      }
      provenance={payload.operations.provenance}
    >
      <div className="grid gap-x-8 gap-y-1 md:grid-cols-2">
        <FactList>
          <Fact label="Latest scheduled attempt">
            {latest ? (
              <span className="inline-flex items-center gap-2">
                <StatePill
                  size="xs"
                  state={
                    latest.status !== "completed"
                      ? "PENDING"
                      : latest.conclusion === "success"
                        ? "PASS"
                        : latest.infrastructureFailure
                          ? "WARN"
                          : "FAIL"
                  }
                  label={
                    latest.status !== "completed"
                      ? "RUNNING"
                      : latest.conclusion === "success"
                        ? "SUCCESS"
                        : latest.infrastructureFailure
                          ? "INFRASTRUCTURE FAILURE"
                          : "FAILED"
                  }
                />
                <Timestamp iso={latest.completedAt ?? latest.startedAt} />
              </span>
            ) : (
              "—"
            )}
          </Fact>
          {latest?.infrastructureFailure && (
            <Fact label="Failure kind">
              GitHub could not run the job; no strategy, preflight or broker
              execution happened in that attempt.
            </Fact>
          )}
          <Fact label="Last successful preflight">
            {preflight ? (
              <span className="inline-flex items-center gap-2">
                <StatePill size="xs" state={preflight.status} />
                <span className="numeric">
                  {preflight.checksPassed}/{preflight.checksEvaluated} checks
                </span>
                <Timestamp iso={preflight.checkedAt} />
              </span>
            ) : (
              "—"
            )}
          </Fact>
          <Fact label="Last successful execution">
            {execution ? (
              <span className="inline-flex items-center gap-2">
                <StatePill size="xs" state={execution.status} />
                <Timestamp iso={execution.completedAt} />
              </span>
            ) : (
              "—"
            )}
          </Fact>
        </FactList>

        <FactList>
          <Fact label="Approved paper release" mono>
            <Sha value={release?.approvedPaperReleaseSha} />
          </Fact>
          <Fact label="Release gate">
            {release ? <StatePill size="xs" state={release.releaseGate} /> : "—"}
          </Fact>
          <Fact label="Validation gate (effective)">
            <StatePill
              size="xs"
              state={payload.validationGate.effective}
              title={payload.validationGate.details.join(" ")}
            />
          </Fact>
          <Fact label="Market entry allowed">
            {execution?.marketEntryAllowed === null ||
            execution?.marketEntryAllowed === undefined ? (
              "—"
            ) : (
              <StatePill
                size="xs"
                state={execution.marketEntryAllowed ? "PASS" : "NOT_APPLICABLE"}
                label={execution.marketEntryAllowed ? "ALLOWED" : "BLOCKED"}
              />
            )}
          </Fact>
          <Fact label="Blocking reason">
            {execution?.blockingReason ?? "none recorded"}
          </Fact>
        </FactList>
      </div>
    </Panel>
  );
}

function EvidencePanel({ payload }: { payload: StrategyStatusPayload }) {
  const validation = payload.validation.data;
  return (
    <Panel
      id="evidence"
      title="F · Promotion evidence"
      actions={
        <Link
          href="/research"
          className="text-xs text-blue hover:underline whitespace-nowrap"
        >
          Validation & research →
        </Link>
      }
      provenance={payload.validation.provenance}
    >
      {validation ? (
        <>
          <MetricGrid>
            <Metric
              label="Effective paper-buy gate"
              value={payload.validationGate.effective}
              state={payload.validationGate.effective}
              hint={
                payload.validationGate.details[0] ??
                (validation.allowedMode ?? undefined)
              }
            />
            <Metric
              label="Stored report assessment"
              value={payload.validationGate.reportAssessment}
              state={payload.validationGate.reportAssessment}
              hint="Historical conclusion; not an authorization on its own"
            />
            <Metric
              label="Generated"
              value={validation.generatedAt?.slice(0, 10) ?? "—"}
              hint={`bar boundary ${validation.barBoundaryDate ?? "unknown"}`}
            />
            <Metric
              label="Expires"
              value={validation.expiresAt?.slice(0, 10) ?? "—"}
              hint={
                validation.expiryBasis
                  ? `binding constraint: ${validation.expiryBasis}`
                  : undefined
              }
              state={
                payload.validation.provenance.freshness === "EXPIRED"
                  ? "EXPIRED"
                  : undefined
              }
            />
            <Metric
              label="Identity / universe match"
              value={`${validation.identityMatchesRuntime} / ${validation.universeMatchesRuntime}`}
              state={
                validation.identityMatchesRuntime === "PASS" &&
                validation.universeMatchesRuntime === "PASS"
                  ? "PASS"
                  : "UNAVAILABLE"
              }
            />
          </MetricGrid>
          <p className="mt-4 text-xs text-secondary max-w-prose">
            A <strong>PASS</strong> makes the unchanged code and this exact
            ranking universe eligible for forward <em>paper</em> validation
            only. It is not a claim of future alpha, not fresh out-of-sample
            evidence, and never authorizes live money.
          </p>
        </>
      ) : (
        <UnavailableBlock
          state={payload.validation.provenance.freshness}
          title="Canonical validation evidence unavailable"
          detail={payload.validation.provenance.detail}
          source={payload.validation.provenance.source}
        />
      )}
    </Panel>
  );
}
