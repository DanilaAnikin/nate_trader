import type { Position } from "./types";
import policyJson from "./v11-policy.json";

export interface V11Policy {
  readonly schemaVersion: 1;
  readonly strategyVersion: string;
  readonly displayName: string;
  readonly signal: string;
  readonly weighting: "equal";
  readonly topN: number;
  readonly maxPositions: number;
  readonly minEligiblePositions: number;
  readonly maxPositionPct: number;
  readonly minCashPct: number;
  readonly maxSectorPct: number;
  readonly maxGrossExposurePct: number;
  readonly cautiousGrossMultiplier: number;
  readonly breadthScalingEnabled: boolean;
  readonly riskOnReentryDays: number;
  readonly productionExecutionMode: "paper-only";
  readonly riskThresholds: Readonly<{
    dailyCautiousPct: number;
    dailyHaltPct: number;
    rollingDrawdownCautiousPct: number;
  }>;
  readonly disabledLegacyLeveragedEtfs: readonly string[];
  readonly excludedSymbols: readonly string[];
  readonly legacyOverlaysEnabled: boolean;
  readonly legacyStopsEnabled: boolean;
  readonly maxLegacyLeveragedEtfTargetPct: number;
}

export const V11_POLICY: V11Policy = Object.freeze({
  ...policyJson,
  schemaVersion: policyJson.schemaVersion as V11Policy["schemaVersion"],
  weighting: policyJson.weighting as V11Policy["weighting"],
  riskThresholds: Object.freeze({ ...policyJson.riskThresholds }),
  disabledLegacyLeveragedEtfs: Object.freeze([
    ...policyJson.disabledLegacyLeveragedEtfs,
  ]),
  excludedSymbols: Object.freeze([...policyJson.excludedSymbols]),
  productionExecutionMode:
    policyJson.productionExecutionMode as V11Policy["productionExecutionMode"],
});

export interface V11PolicyChecks {
  readonly maxPositions: boolean;
  readonly minCash: boolean;
  readonly maxPositionWeight: boolean;
  readonly noExcludedSymbols: boolean;
  readonly noShortPositions: boolean;
}

export interface V11PolicyEvaluation {
  /** True only for the guardrails evaluable from broker positions/cash. */
  readonly checkedGuardrailsPass: boolean;
  readonly checks: V11PolicyChecks;
  readonly positionCount: number;
  readonly cashPct: number | null;
  readonly maxPositionWeightPct: number | null;
  readonly excludedSymbols: readonly string[];
  readonly shortSymbols: readonly string[];
}

function uniqueSymbols(positions: readonly Position[]): string[] {
  return [
    ...new Set(
      positions
        .map((position) => position.symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Evaluate an account snapshot against the portfolio-wide V11 guardrails.
 *
 * Position weights use absolute market value because the cap is a gross-risk
 * limit. Invalid account equity fails the cash and weight checks closed when
 * positions are present; the symbol/side checks remain independently useful.
 */
export function evaluateV11Portfolio(
  positions: readonly Position[],
  equity: number,
  cash: number,
): V11PolicyEvaluation {
  const validEquity = Number.isFinite(equity) && equity > 0;
  const validCash = Number.isFinite(cash);
  const cashPct = validEquity && validCash ? (cash / equity) * 100 : null;
  const maxPositionWeightPct = validEquity
    ? positions.reduce(
        (largest, position) =>
          Math.max(largest, (Math.abs(position.market_value) / equity) * 100),
        0,
      )
    : null;

  const excludedSet = new Set(
    V11_POLICY.excludedSymbols.map((symbol) => symbol.toUpperCase()),
  );
  const excludedSymbols = uniqueSymbols(
    positions.filter((position) =>
      excludedSet.has(position.symbol.trim().toUpperCase()),
    ),
  );
  const shortSymbols = uniqueSymbols(
    positions.filter(
      (position) =>
        position.side.trim().toLowerCase() === "short" || position.qty < 0,
    ),
  );

  const checks: V11PolicyChecks = {
    maxPositions: positions.length <= V11_POLICY.maxPositions,
    minCash:
      cashPct !== null && cashPct + Number.EPSILON >= V11_POLICY.minCashPct,
    maxPositionWeight:
      (positions.length === 0 || maxPositionWeightPct !== null) &&
      (maxPositionWeightPct ?? 0) <=
        V11_POLICY.maxPositionPct + Number.EPSILON,
    noExcludedSymbols: excludedSymbols.length === 0,
    noShortPositions: shortSymbols.length === 0,
  };

  return {
    checkedGuardrailsPass: Object.values(checks).every(Boolean),
    checks,
    positionCount: positions.length,
    cashPct,
    maxPositionWeightPct,
    excludedSymbols,
    shortSymbols,
  };
}
