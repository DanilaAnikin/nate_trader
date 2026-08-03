import { describe, expect, it } from "vitest";

import type { Position } from "./types";
import { evaluateV11Portfolio, V11_POLICY } from "./v11-policy";

function position(
  symbol: string,
  marketValue: number,
  overrides: Partial<Position> = {},
): Position {
  return {
    symbol,
    qty: 100,
    avg_entry_price: 100,
    current_price: 100,
    market_value: marketValue,
    unrealized_pl: 0,
    unrealized_plpc: 0,
    side: "long",
    ...overrides,
  };
}

describe("V11 dashboard policy contract", () => {
  it("publishes the production strategy limits", () => {
    expect(V11_POLICY).toMatchObject({
      schemaVersion: 1,
      strategyVersion: "v11-adaptive-momentum",
      signal: "12-1 momentum",
      weighting: "equal",
      topN: 10,
      maxPositions: 10,
      minEligiblePositions: 8,
      maxPositionPct: 9,
      minCashPct: 10,
      maxSectorPct: 20,
      maxGrossExposurePct: 90,
      cautiousGrossMultiplier: 0.5,
      breadthScalingEnabled: true,
      riskOnReentryDays: 1,
      productionExecutionMode: "paper-only",
      legacyOverlaysEnabled: false,
      legacyStopsEnabled: false,
      maxLegacyLeveragedEtfTargetPct: 0,
    });
    expect(V11_POLICY.disabledLegacyLeveragedEtfs).toEqual([
      "TQQQ",
      "UPRO",
      "SSO",
    ]);
    expect(V11_POLICY.excludedSymbols).toEqual([
      "SPY",
      "QQQ",
      "SH",
      "SSO",
      "TQQQ",
      "UPRO",
      "SQQQ",
      "SPXU",
      "SPXL",
      "SOXL",
      "SOXS",
      "UVXY",
      "VXX",
    ]);
  });

  it("accepts a fully allocated portfolio exactly on every hard limit", () => {
    const positions = Array.from({ length: 10 }, (_, index) =>
      position(`STOCK${index + 1}`, 90_000),
    );

    const result = evaluateV11Portfolio(positions, 1_000_000, 100_000);

    expect(result).toMatchObject({
      checkedGuardrailsPass: true,
      positionCount: 10,
      cashPct: 10,
      maxPositionWeightPct: 9,
      excludedSymbols: [],
      shortSymbols: [],
    });
    expect(Object.values(result.checks)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("reports each portfolio violation independently", () => {
    const positions = [
      position(" tqqq ", 110_000),
      position("SHORT-SIDE", 70_000, { side: "SHORT" }),
      position("NEGATIVE-QTY", 70_000, { qty: -100 }),
      ...Array.from({ length: 8 }, (_, index) =>
        position(`STOCK${index + 1}`, 70_000),
      ),
    ];

    const result = evaluateV11Portfolio(positions, 1_000_000, 50_000);

    expect(result.checkedGuardrailsPass).toBe(false);
    expect(result.checks).toEqual({
      maxPositions: false,
      minCash: false,
      maxPositionWeight: false,
      noExcludedSymbols: false,
      noShortPositions: false,
    });
    expect(result.excludedSymbols).toEqual(["TQQQ"]);
    expect(result.shortSymbols).toEqual(["NEGATIVE-QTY", "SHORT-SIDE"]);
  });

  it("fails account-derived checks closed when equity is invalid", () => {
    const result = evaluateV11Portfolio([position("AAPL", 1_000)], 0, 0);

    expect(result.cashPct).toBeNull();
    expect(result.maxPositionWeightPct).toBeNull();
    expect(result.checks.minCash).toBe(false);
    expect(result.checks.maxPositionWeight).toBe(false);
    expect(result.checkedGuardrailsPass).toBe(false);
  });
});
