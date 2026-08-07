"use client";

import { integer, money, percent, points } from "@/lib/status/client";
import { DRIFT_BAND_PCT } from "@/lib/status/convergence";
import type {
  PortfolioRow,
  PositionClassification,
  PositionLifecycle,
  StrategyStatusPayload,
} from "@/lib/status/types";
import PageState from "./status/PageState";
import {
  Dash,
  Fact,
  FactList,
  Panel,
  StatePill,
  TableScroll,
  UnavailableBlock,
} from "./status/primitives";

const CLASS_LABEL: Record<PositionClassification, string> = {
  TARGET: "TARGET",
  LEGACY_EXCLUDED: "LEGACY/EXCLUDED",
  HELD_ONLY: "HELD-ONLY",
  UNMANAGED: "UNMANAGED",
};

const CLASS_TONE: Record<PositionClassification, string> = {
  TARGET: "var(--accent-blue)",
  LEGACY_EXCLUDED: "var(--accent-red)",
  HELD_ONLY: "var(--accent-amber)",
  UNMANAGED: "var(--accent-slate)",
};

const LIFECYCLE_TONE: Record<PositionLifecycle, string> = {
  KEEP: "var(--accent-slate)",
  CONVERGED: "var(--accent-green)",
  BUY: "var(--accent-blue)",
  TOP_UP: "var(--accent-blue)",
  TRIM: "var(--accent-amber)",
  EXIT: "var(--accent-red)",
  PENDING: "var(--accent-purple)",
};

const LIFECYCLE_LABEL: Record<PositionLifecycle, string> = {
  KEEP: "KEEP",
  CONVERGED: "CONVERGED",
  BUY: "BUY",
  TOP_UP: "TOP-UP",
  TRIM: "TRIM",
  EXIT: "EXIT",
  PENDING: "PENDING",
};

export default function PortfolioClient() {
  return (
    <PageState>
      {(payload) => (
        <div className="space-y-5">
          <PlanContext payload={payload} />
          <Holdings payload={payload} />
          <PendingIntents payload={payload} />
        </div>
      )}
    </PageState>
  );
}

function PlanContext({ payload }: { payload: StrategyStatusPayload }) {
  const plan = payload.strategy.data?.plan ?? null;
  const convergence = payload.convergence.data;
  return (
    <Panel
      title="Frozen V11 plan"
      subtitle="Target construction context for the rows below"
      provenance={payload.strategy.provenance}
    >
      {plan ? (
        <div className="grid gap-x-8 md:grid-cols-2">
          <FactList>
            <Fact label="Plan ID" mono>
              {plan.planId}
            </Fact>
            <Fact label="Signal date (D)">{plan.signalDate ?? <Dash />}</Fact>
            <Fact label="Rebalance month">{plan.rebalanceMonth}</Fact>
            <Fact label="Construction risk tier">
              <StatePill
                size="xs"
                state={
                  plan.constructionRiskTier === "NORMAL"
                    ? "PASS"
                    : plan.constructionRiskTier === "CAUTIOUS"
                      ? "WARN"
                      : "FAIL"
                }
                label={plan.constructionRiskTier}
              />
            </Fact>
          </FactList>
          <FactList>
            <Fact label="Eligible candidates at D">
              {integer(plan.eligibleCount)}
            </Fact>
            <Fact label="Selected targets">{integer(plan.targets.length)}</Fact>
            <Fact label="Target gross / cash">
              {percent(plan.targetGrossPct)} / {percent(plan.targetCashPct)}
            </Fact>
            <Fact label="Convergence">
              {convergence
                ? `${convergence.convergedCount}/${convergence.targetCount} inside the drift band · ${convergence.pendingCount} pending`
                : "NOT APPLICABLE for this account"}
            </Fact>
          </FactList>
        </div>
      ) : (
        <UnavailableBlock
          state={payload.strategy.provenance.freshness}
          title="No frozen V11 plan available"
          detail={payload.strategy.provenance.detail}
          source={payload.strategy.provenance.source}
        />
      )}
      <p className="mt-4 text-xs text-secondary max-w-prose">
        Top-10, the 9% single-name cap and the 20% sector cap are{" "}
        <strong>target-construction</strong> rules. A temporary 9-of-10 book or
        a weight slightly above 9% after a price move is drift, not a strategy
        failure. V11 has no fixed per-position stop-loss; exits come from
        reranking, monthly convergence, the SPY trend gate and{" "}
        <code className="font-mono">HALT</code>.
      </p>
    </Panel>
  );
}

/** Rows for an account with no proven production binding: actual data only. */
function brokerOnlyRows(payload: StrategyStatusPayload): PortfolioRow[] {
  const broker = payload.broker.data;
  if (!broker) return [];
  return broker.positions.map((position) => ({
    symbol: position.symbol,
    qty: position.qty,
    marketValue: position.marketValue,
    actualWeightPct:
      broker.equity > 0 ? (position.marketValue / broker.equity) * 100 : null,
    targetWeightPct: null,
    deltaPct: null,
    deltaValue: null,
    sector: null,
    unrealizedPl: position.unrealizedPl,
    unrealizedPlPct: position.unrealizedPlPct,
    classification: "UNMANAGED",
    lifecycle: "KEEP",
    pendingSide: null,
  }));
}

function Holdings({ payload }: { payload: StrategyStatusPayload }) {
  const convergence = payload.convergence.data;
  const bound = payload.accountBinding.data?.productionBound === true;
  const rows = convergence ? [...convergence.rows] : brokerOnlyRows(payload);
  const provenance = convergence
    ? payload.convergence.provenance
    : payload.broker.provenance;

  return (
    <Panel
      title="Holdings and V11 targets"
      subtitle={
        bound
          ? `Actual broker state vs the frozen plan. Drift band ±${DRIFT_BAND_PCT} pp of equity.`
          : "This account is not proven to be the production executor account, so V11 target compliance is NOT APPLICABLE. Actual broker holdings are still shown in full."
      }
      provenance={provenance}
    >
      {rows.length === 0 ? (
        <UnavailableBlock
          state={
            payload.broker.data
              ? payload.strategy.data?.plan?.riskOff
                ? "NOT_APPLICABLE"
                : "CURRENT"
              : payload.broker.provenance.freshness
          }
          title={
            payload.broker.data
              ? payload.strategy.data?.plan?.riskOff
                ? "No positions — SPY risk-off target is zero"
                : "No positions held and no targets planned"
              : "Holdings unavailable"
          }
          detail={
            payload.broker.data
              ? "An empty book here reflects an actual broker snapshot, not missing data."
              : payload.broker.provenance.detail
          }
          source={provenance.source}
        />
      ) : (
        <TableScroll>
          <table className="data">
            <caption className="sr-only">
              Actual holdings against V11 target weights
            </caption>
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Classification</th>
                <th scope="col">Lifecycle</th>
                <th scope="col" className="num">Qty</th>
                <th scope="col" className="num">Market value</th>
                <th scope="col" className="num">Actual %</th>
                <th scope="col" className="num">V11 target %</th>
                <th scope="col" className="num">Δ pp</th>
                <th scope="col" className="num">Δ $</th>
                <th scope="col">Target sector</th>
                <th scope="col" className="num">Unrealized P&amp;L</th>
                <th scope="col" className="num">P&amp;L %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.symbol}>
                  <th scope="row" className="font-mono font-semibold text-left">
                    {row.symbol}
                  </th>
                  <td>
                    <span
                      className="text-[10px] font-semibold tracking-wide"
                      style={{ color: CLASS_TONE[row.classification] }}
                    >
                      {bound || row.classification !== "UNMANAGED"
                        ? CLASS_LABEL[row.classification]
                        : "NOT APPLICABLE"}
                    </span>
                  </td>
                  <td>
                    {bound ? (
                      <span
                        className="text-[10px] font-semibold tracking-wide"
                        style={{ color: LIFECYCLE_TONE[row.lifecycle] }}
                      >
                        {LIFECYCLE_LABEL[row.lifecycle]}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted">
                        NOT APPLICABLE
                      </span>
                    )}
                  </td>
                  <td className="num">{row.qty ?? <Dash />}</td>
                  <td className="num">{money(row.marketValue)}</td>
                  <td className="num">{percent(row.actualWeightPct)}</td>
                  <td className="num">
                    {row.targetWeightPct === null ? (
                      <Dash />
                    ) : (
                      percent(row.targetWeightPct)
                    )}
                  </td>
                  <td
                    className="num"
                    style={{
                      color:
                        row.deltaPct === null
                          ? undefined
                          : Math.abs(row.deltaPct) > DRIFT_BAND_PCT
                            ? "var(--accent-amber)"
                            : "var(--text-muted)",
                    }}
                  >
                    {row.deltaPct === null ? <Dash /> : points(row.deltaPct)}
                  </td>
                  <td className="num">
                    {row.deltaValue === null ? <Dash /> : money(row.deltaValue)}
                  </td>
                  <td>{row.sector ?? <Dash />}</td>
                  <td
                    className="num"
                    style={{
                      color:
                        row.unrealizedPl === null
                          ? undefined
                          : row.unrealizedPl >= 0
                            ? "var(--accent-green)"
                            : "var(--accent-red)",
                    }}
                  >
                    {money(row.unrealizedPl)}
                  </td>
                  <td className="num">
                    {percent(row.unrealizedPlPct, 2, true)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      <p className="mt-3 text-[11px] text-muted max-w-prose">
        Unrealized P&amp;L is broker accounting for the selected account. It is
        not the strategy&apos;s forward performance and is not benchmark-relative.
      </p>
    </Panel>
  );
}

function PendingIntents({ payload }: { payload: StrategyStatusPayload }) {
  const plan = payload.strategy.data?.plan ?? null;
  const actions = plan?.pendingActions ?? [];
  if (!plan) return null;

  return (
    <Panel
      title="Order intents recorded in the frozen plan"
      subtitle="Submitted is not filled. Broker and client order identifiers are never exposed."
      provenance={payload.strategy.provenance}
    >
      {actions.length === 0 ? (
        <p className="text-xs text-secondary">
          No outstanding order intents are recorded in this plan.
        </p>
      ) : (
        <TableScroll>
          <table className="data">
            <caption className="sr-only">
              Sanitized order intents for plan {plan.planId}
            </caption>
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Side</th>
                <th scope="col" className="num">Quantity</th>
                <th scope="col" className="num">Target %</th>
                <th scope="col">Recorded status</th>
                <th scope="col" className="num">Attempt</th>
                <th scope="col">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((action) => (
                <tr key={`${action.symbol}-${action.side}-${action.attempt}`}>
                  <th scope="row" className="font-mono font-semibold text-left">
                    {action.symbol}
                  </th>
                  <td
                    style={{
                      color:
                        action.side === "buy"
                          ? "var(--accent-blue)"
                          : "var(--accent-amber)",
                    }}
                  >
                    {action.side.toUpperCase()}
                  </td>
                  <td className="num">{action.quantity}</td>
                  <td className="num">{percent(action.targetWeightPct)}</td>
                  <td>
                    <StatePill size="xs" state="PENDING" label={action.status} />
                  </td>
                  <td className="num">{action.attempt}</td>
                  <td className="numeric">
                    {action.submittedAt?.replace("T", " ").slice(0, 19) ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}
