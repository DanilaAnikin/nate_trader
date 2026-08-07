import { describe, expect, it } from "vitest";
import { buildConvergence, DRIFT_BAND_PCT } from "./convergence";
import { parseFrozenPlan } from "./parse";
import type { BrokerInfo, BrokerPosition, FrozenPlanInfo } from "./types";
import { frozenPlanJson, TARGET_SYMBOLS } from "@/test/fixtures";

function position(
  symbol: string,
  marketValue: number,
  extra: Partial<BrokerPosition> = {},
): BrokerPosition {
  return {
    symbol,
    qty: 10,
    avgEntryPrice: marketValue / 10,
    currentPrice: marketValue / 10,
    marketValue,
    unrealizedPl: 0,
    unrealizedPlPct: 0,
    side: "long",
    ...extra,
  };
}

function broker(positions: BrokerPosition[], equity = 1_000_000): BrokerInfo {
  const gross = positions.reduce((sum, p) => sum + Math.abs(p.marketValue), 0);
  return {
    equity,
    cash: equity - gross,
    cashPct: ((equity - gross) / equity) * 100,
    dailyPnl: 0,
    dailyPnlPct: 0,
    grossExposure: gross,
    grossExposurePct: (gross / equity) * 100,
    positionCount: positions.length,
    positions,
    shortSymbols: positions.filter((p) => p.side === "short").map((p) => p.symbol),
  };
}

function planWithoutPending(overrides: Record<string, unknown> = {}): FrozenPlanInfo {
  return parseFrozenPlan(
    frozenPlanJson({ order_attempts: {}, ...overrides }),
  ) as FrozenPlanInfo;
}

describe("buildConvergence", () => {
  it("marks every on-target leg CONVERGED when the book matches the plan", () => {
    const plan = planWithoutPending();
    const positions = TARGET_SYMBOLS.map((symbol) => position(symbol, 45_000));
    const result = buildConvergence(plan, broker(positions));

    expect(result?.targetCount).toBe(10);
    expect(result?.actualCount).toBe(10);
    expect(result?.pendingCount).toBe(0);
    expect(result?.rows.every((row) => row.lifecycle === "CONVERGED")).toBe(true);
    expect(result?.rows.every((row) => row.classification === "TARGET")).toBe(
      true,
    );
    expect(result?.nextSafeAction).toContain("within the V11 drift band");
  });

  it("reports a nine-of-ten book as one missing BUY, not a strategy failure", () => {
    const plan = planWithoutPending();
    const held = TARGET_SYMBOLS.filter((symbol) => symbol !== "UNH");
    const result = buildConvergence(
      plan,
      broker(held.map((symbol) => position(symbol, 45_000))),
    );

    const unh = result?.rows.find((row) => row.symbol === "UNH");
    expect(unh?.lifecycle).toBe("BUY");
    expect(unh?.classification).toBe("TARGET");
    expect(unh?.actualWeightPct).toBeNull();
    expect(result?.actualCount).toBe(9);
    expect(result?.nextSafeAction).toContain("Buy or top up 1 target name");
  });

  it("keeps a real TQQQ/UPRO legacy holding visible with target 0 and EXIT", () => {
    const plan = planWithoutPending();
    const positions = [
      ...TARGET_SYMBOLS.map((symbol) => position(symbol, 40_000)),
      position("TQQQ", 60_000),
      position("UPRO", 30_000),
    ];
    const result = buildConvergence(plan, broker(positions));

    const tqqq = result?.rows.find((row) => row.symbol === "TQQQ");
    expect(tqqq).toBeDefined();
    expect(tqqq?.classification).toBe("LEGACY_EXCLUDED");
    expect(tqqq?.lifecycle).toBe("EXIT");
    expect(tqqq?.targetWeightPct).toBe(0);
    expect(tqqq?.marketValue).toBe(60_000);
    expect(result?.legacyExcludedSymbols).toEqual(["TQQQ", "UPRO"]);
    expect(result?.nextSafeAction).toContain("Exit 2 non-target holding(s)");
  });

  it("classifies a non-excluded, non-target holding as HELD-ONLY", () => {
    const plan = planWithoutPending();
    const result = buildConvergence(
      plan,
      broker([position("ZZZZ", 20_000)]),
    );
    const row = result?.rows.find((r) => r.symbol === "ZZZZ");
    expect(row?.classification).toBe("HELD_ONLY");
    expect(row?.lifecycle).toBe("EXIT");
  });

  it("distinguishes TRIM, TOP_UP and inside-the-band drift", () => {
    const plan = planWithoutPending();
    const positions = [
      position("ASML", 70_000), // 7.0% vs 4.5% target → +2.5 pp → TRIM
      position("CASY", 20_000), // 2.0% vs 4.5% target → −2.5 pp → TOP_UP
      position("CAT", 47_000), // 4.7% vs 4.5% target → +0.2 pp → inside band
      ...TARGET_SYMBOLS.slice(3).map((symbol) => position(symbol, 45_000)),
    ];
    const result = buildConvergence(plan, broker(positions));

    expect(result?.rows.find((r) => r.symbol === "ASML")?.lifecycle).toBe("TRIM");
    expect(result?.rows.find((r) => r.symbol === "CASY")?.lifecycle).toBe(
      "TOP_UP",
    );
    expect(result?.rows.find((r) => r.symbol === "CAT")?.lifecycle).toBe(
      "CONVERGED",
    );
    expect(
      Math.abs(result!.rows.find((r) => r.symbol === "CAT")!.deltaPct!),
    ).toBeLessThanOrEqual(DRIFT_BAND_PCT);
    expect(result?.nextSafeAction).toContain("Trim 1 overweight name");
  });

  it("marks a submitted intent PENDING and refuses to call it filled", () => {
    const plan = parseFrozenPlan(frozenPlanJson()) as FrozenPlanInfo;
    const positions = TARGET_SYMBOLS.map((symbol) => position(symbol, 45_000));
    const result = buildConvergence(plan, broker(positions));

    const asml = result?.rows.find((row) => row.symbol === "ASML");
    expect(asml?.lifecycle).toBe("PENDING");
    expect(asml?.pendingSide).toBe("sell");
    expect(result?.pendingCount).toBe(1);
    expect(result?.nextSafeAction).toContain("not proven filled");
  });

  it("treats a risk-off plan with a flat account as converged, not as missing data", () => {
    const plan = planWithoutPending({
      risk_off: true,
      target_weights: {},
      sector_by_symbol: {},
    });
    const result = buildConvergence(plan, broker([]));
    expect(result?.rows).toHaveLength(0);
    expect(result?.targetGrossPct).toBe(0);
    expect(result?.targetCashPct).toBe(100);
    expect(result?.nextSafeAction).toContain("risk-off");
  });

  it("marks every holding EXIT under a risk-off plan", () => {
    const plan = planWithoutPending({
      risk_off: true,
      target_weights: {},
      sector_by_symbol: {},
    });
    const result = buildConvergence(plan, broker([position("ASML", 45_000)]));
    expect(result?.rows[0].lifecycle).toBe("EXIT");
    expect(result?.rows[0].targetWeightPct).toBe(0);
  });

  it("returns null when neither a plan nor a broker snapshot exists", () => {
    expect(buildConvergence(null, null)).toBeNull();
  });

  it("leaves actual weights null rather than zero when equity is unusable", () => {
    const plan = planWithoutPending();
    const result = buildConvergence(plan, broker([position("ASML", 45_000)], 0));
    const asml = result?.rows.find((row) => row.symbol === "ASML");
    expect(asml?.actualWeightPct).toBeNull();
    expect(asml?.deltaPct).toBeNull();
  });
});
