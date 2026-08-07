/**
 * Target-versus-actual convergence.
 *
 * This module *describes* the difference between the runner's frozen plan and
 * the broker snapshot. It does not decide anything: it never re-ranks, never
 * re-runs eligibility, and never invents an order. Every lifecycle label is a
 * statement about two persisted facts.
 */

import { V11_POLICY } from "@/lib/v11-policy";
import type {
  BrokerInfo,
  ConvergenceInfo,
  FrozenPlanInfo,
  PortfolioRow,
  PositionClassification,
  PositionLifecycle,
} from "./types";

/**
 * V11 trims or tops up a name only when its dollar drift exceeds 0.5% of
 * account equity. The dashboard reuses the same band purely to describe
 * whether a leg is already inside the runner's no-action zone.
 */
export const DRIFT_BAND_PCT = 0.5;

const EXCLUDED = new Set(
  V11_POLICY.excludedSymbols.map((symbol) => symbol.toUpperCase()),
);

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function classify(
  symbol: string,
  isTarget: boolean,
  hasPlan: boolean,
): PositionClassification {
  if (!hasPlan) return "UNMANAGED";
  if (isTarget) return "TARGET";
  if (EXCLUDED.has(symbol)) return "LEGACY_EXCLUDED";
  return "HELD_ONLY";
}

/**
 * Build one row per symbol that is either held at the broker or targeted by
 * the frozen plan. A real legacy holding (TQQQ, UPRO, ...) is never hidden: it
 * appears with a V11 target of 0% and an `EXIT` migration state.
 */
export function buildConvergence(
  plan: FrozenPlanInfo | null,
  broker: BrokerInfo | null,
): ConvergenceInfo | null {
  if (!plan && !broker) return null;

  const hasPlan = plan !== null;
  const equity = broker && broker.equity > 0 ? broker.equity : null;
  const targetBySymbol = new Map(
    (plan?.targets ?? []).map((target) => [target.symbol, target]),
  );
  const pendingBySymbol = new Map(
    (plan?.pendingActions ?? []).map((action) => [action.symbol, action]),
  );
  const positionBySymbol = new Map(
    (broker?.positions ?? []).map((position) => [
      position.symbol.toUpperCase(),
      position,
    ]),
  );

  const symbols = [
    ...new Set([...targetBySymbol.keys(), ...positionBySymbol.keys()]),
  ].sort();

  const planHasPendingActions = (plan?.pendingActions.length ?? 0) > 0;
  const rows: PortfolioRow[] = symbols.map((symbol) => {
    const target = targetBySymbol.get(symbol) ?? null;
    const position = positionBySymbol.get(symbol) ?? null;
    const pending = pendingBySymbol.get(symbol) ?? null;
    const marketValue = position ? position.marketValue : null;
    const actualWeightPct =
      marketValue !== null && equity !== null
        ? round((marketValue / equity) * 100)
        : null;
    const targetWeightPct = target
      ? target.weightPct
      : hasPlan
        ? 0
        : null;
    const deltaPct =
      actualWeightPct !== null && targetWeightPct !== null
        ? round(actualWeightPct - targetWeightPct)
        : null;
    const deltaValue =
      deltaPct !== null && equity !== null
        ? round((deltaPct / 100) * equity, 2)
        : null;

    const classification = classify(symbol, target !== null, hasPlan);
    const lifecycle = resolveLifecycle({
      hasPlan,
      isTarget: target !== null,
      isHeld: position !== null,
      deltaPct,
      pendingSide: pending?.side ?? null,
      planHasPendingActions,
      planIsRiskOff: plan?.riskOff ?? false,
    });

    return {
      symbol,
      qty: position?.qty ?? null,
      marketValue,
      actualWeightPct,
      targetWeightPct,
      deltaPct,
      deltaValue,
      sector: target?.sector ?? null,
      unrealizedPl: position?.unrealizedPl ?? null,
      unrealizedPlPct: position?.unrealizedPlPct ?? null,
      classification,
      lifecycle,
      pendingSide: pending?.side ?? null,
    };
  });

  const targetCount = plan?.targets.length ?? 0;
  const actualCount = broker?.positionCount ?? 0;
  const convergedCount = rows.filter(
    (row) => row.lifecycle === "CONVERGED" || row.lifecycle === "KEEP",
  ).length;
  const pendingCount = rows.filter((row) => row.lifecycle === "PENDING").length;

  const actualGrossPct =
    broker && equity !== null ? round(broker.grossExposurePct) : null;
  const actualCashPct = broker && equity !== null ? round(broker.cashPct) : null;

  return {
    rows,
    targetCount,
    actualCount,
    convergedCount,
    pendingCount,
    targetGrossPct: plan?.targetGrossPct ?? 0,
    actualGrossPct,
    targetCashPct: plan?.targetCashPct ?? 0,
    actualCashPct,
    nextSafeAction: describeNextSafeAction(plan, rows),
    legacyExcludedSymbols: rows
      .filter((row) => row.classification === "LEGACY_EXCLUDED")
      .map((row) => row.symbol),
  };
}

function resolveLifecycle(input: {
  hasPlan: boolean;
  isTarget: boolean;
  isHeld: boolean;
  deltaPct: number | null;
  pendingSide: "buy" | "sell" | null;
  planHasPendingActions: boolean;
  planIsRiskOff: boolean;
}): PositionLifecycle {
  if (input.pendingSide !== null) return "PENDING";
  if (!input.hasPlan) return "KEEP";
  if (input.planIsRiskOff) return input.isHeld ? "EXIT" : "CONVERGED";
  if (!input.isTarget) return input.isHeld ? "EXIT" : "CONVERGED";
  if (!input.isHeld) return "BUY";
  if (input.deltaPct === null) return "KEEP";
  if (input.deltaPct < -DRIFT_BAND_PCT) return "TOP_UP";
  if (input.deltaPct > DRIFT_BAND_PCT) return "TRIM";
  return input.planHasPendingActions ? "KEEP" : "CONVERGED";
}

/**
 * A read-only description of what the *executor* would do next. The dashboard
 * never performs it — it only explains the state the operator is looking at.
 */
function describeNextSafeAction(
  plan: FrozenPlanInfo | null,
  rows: readonly PortfolioRow[],
): string {
  if (!plan) {
    return "No frozen V11 plan is available; convergence cannot be described.";
  }
  const pending = rows.filter((row) => row.lifecycle === "PENDING");
  if (pending.length > 0) {
    const sells = pending.filter((row) => row.pendingSide === "sell").length;
    const buys = pending.length - sells;
    return `${pending.length} order intent(s) submitted (${sells} sell, ${buys} buy) and not proven filled. The executor waits for terminal fills and a fresh broker snapshot before any replacement buy.`;
  }
  if (plan.riskOff) {
    return "SPY risk-off plan: the executor converges directional exposure to cash on every cycle until the account is flat.";
  }
  const exits = rows.filter((row) => row.lifecycle === "EXIT");
  if (exits.length > 0) {
    return `Exit ${exits.length} non-target holding(s) first; replacement buys wait for fill and cash reconciliation.`;
  }
  const trims = rows.filter((row) => row.lifecycle === "TRIM");
  if (trims.length > 0) {
    return `Trim ${trims.length} overweight name(s) before any replacement buy.`;
  }
  const buys = rows.filter(
    (row) => row.lifecycle === "BUY" || row.lifecycle === "TOP_UP",
  );
  if (buys.length > 0) {
    return `Buy or top up ${buys.length} target name(s) at the next permitted execution, subject to the market clock, cash and cap validation.`;
  }
  return "Targets are within the V11 drift band; the next scheduled change is the monthly rebalance.";
}
