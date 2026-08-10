import { describe, expect, it } from "vitest";
import {
  executionFromLastRun,
  parseFrozenPlan,
  parseLastRun,
  parsePerformanceRuntime,
  parsePreflight,
  parseTournament,
  parseValidation,
  validationExpiry,
} from "./parse";
import {
  APPROVED_SHA,
  frozenPlanJson,
  lastRunJson,
  performanceJson,
  preflightJson,
  STRATEGY_IDENTITY,
  tournamentJson,
  UNIVERSE_HASH,
  validationJson,
} from "@/test/fixtures";

describe("parseLastRun", () => {
  it("parses a healthy production run record", () => {
    const run = parseLastRun(lastRunJson());
    expect(run).not.toBeNull();
    expect(run?.status).toBe("PASS");
    expect(run?.releaseSha).toBe(APPROVED_SHA);
    expect(run?.riskTier).toBe("CAUTIOUS");
    expect(run?.actionCounts).toEqual({
      ADAPTIVE_PLAN: 1,
      ADAPTIVE_TRIM: 10,
      REBALANCE_PENDING_SELLS: 1,
    });
  });

  it("rejects a record that is not the paper-only V11 schema", () => {
    expect(parseLastRun(lastRunJson({ schema_version: 2 }))).toBeNull();
    expect(parseLastRun(lastRunJson({ kind: "something_else" }))).toBeNull();
    expect(parseLastRun(lastRunJson({ paper_only: false }))).toBeNull();
    expect(parseLastRun(lastRunJson({ status: "GREEN" }))).toBeNull();
    expect(parseLastRun("not an object")).toBeNull();
  });

  it("surfaces a blocking action as a safe, named reason", () => {
    const run = parseLastRun(
      lastRunJson({
        status: "DEGRADED",
        blocking_actions: [{ action: "ABORT_SHORT_DETECTED", symbol: "TQQQ" }],
      }),
    );
    const execution = executionFromLastRun(run!, null);
    expect(execution.status).toBe("WARN");
    expect(execution.blockingReason).toBe("ABORT_SHORT_DETECTED (TQQQ)");
  });

  it("reports a runner crash as FAIL with its failure type", () => {
    const run = parseLastRun(
      lastRunJson({ status: "FAIL", failure_type: "RuntimeError" }),
    );
    const execution = executionFromLastRun(run!, null);
    expect(execution.status).toBe("FAIL");
    expect(execution.blockingReason).toContain("RuntimeError");
  });
});

describe("parseFrozenPlan", () => {
  it("parses targets and derives gross/cash from the persisted weights", () => {
    const plan = parseFrozenPlan(frozenPlanJson());
    expect(plan).not.toBeNull();
    expect(plan?.targets).toHaveLength(10);
    expect(plan?.targetGrossPct).toBeCloseTo(45, 6);
    expect(plan?.targetCashPct).toBeCloseTo(55, 6);
    expect(plan?.constructionRiskTier).toBe("CAUTIOUS");
    expect(plan?.strategyIdentityValue).toBe(STRATEGY_IDENTITY);
    expect(plan?.rankingUniverseSha256).toBe(UNIVERSE_HASH);
  });

  it("never exposes broker or client order identifiers", () => {
    const plan = parseFrozenPlan(frozenPlanJson());
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("58371aed-250a-40c7-b883-a62c538100b1");
    expect(serialized).not.toContain("nt-adaptive-asml-sell");
    expect(serialized).not.toContain("client_order_id");
    expect(serialized).not.toContain("order_id");
    expect(plan?.pendingActions[0]).toEqual({
      symbol: "ASML",
      side: "sell",
      quantity: 23,
      targetWeightPct: 4.5,
      status: "submitted",
      attempt: 1,
      // 12:05:03 in the runner's America/New_York wall clock is 16:05:03Z.
      submittedAt: "2026-08-07T16:05:03.000Z",
    });
  });

  it("rejects an unknown schema or an impossible weight", () => {
    expect(parseFrozenPlan(frozenPlanJson({ schema_version: 2 }))).toBeNull();
    expect(
      parseFrozenPlan(frozenPlanJson({ target_weights: { AAA: 1.5 } })),
    ).toBeNull();
    expect(
      parseFrozenPlan(
        frozenPlanJson({
          target_weights: Object.fromEntries(
            Array.from({ length: 11 }, (_, i) => [`S${i}`, 0.1]),
          ),
          sector_by_symbol: Object.fromEntries(
            Array.from({ length: 11 }, (_, i) => [`S${i}`, "Technology"]),
          ),
        }),
      ),
    ).toBeNull();
  });

  it("accepts a zero-target risk-off plan", () => {
    const plan = parseFrozenPlan(
      frozenPlanJson({
        risk_off: true,
        target_weights: {},
        sector_by_symbol: {},
        order_attempts: {},
      }),
    );
    expect(plan?.riskOff).toBe(true);
    expect(plan?.targets).toHaveLength(0);
    expect(plan?.targetCashPct).toBe(100);
  });
});

describe("parsePerformanceRuntime", () => {
  it("reads risk state, the rolling window and the frozen plan", () => {
    const runtime = parsePerformanceRuntime(performanceJson());
    expect(runtime?.riskTier).toBe("CAUTIOUS");
    expect(runtime?.rollingDrawdownPct).toBeCloseTo(-17.88);
    expect(runtime?.riskLookbackSessions).toBe(22);
    expect(runtime?.plan?.planId).toBe("f8756105eb63dde2");
  });

  it("treats an absent recovery latch as not armed, and a junk latch as unknown", () => {
    expect(parsePerformanceRuntime(performanceJson())?.recoveryLatchArmed).toBe(
      false,
    );
    expect(
      parsePerformanceRuntime(
        performanceJson({ adaptive_risk_off_latched: true }),
      )?.recoveryLatchArmed,
    ).toBe(true);
    expect(
      parsePerformanceRuntime(
        performanceJson({ adaptive_risk_off_latched: "yes" }),
      )?.recoveryLatchArmed,
    ).toBeNull();
  });

  it("does not invent a plan when the persisted plan is malformed", () => {
    const runtime = parsePerformanceRuntime(
      performanceJson({ adaptive_rebalance_pending: { schema_version: 2 } }),
    );
    expect(runtime?.plan).toBeNull();
  });

  it("keeps missing numbers null rather than zero", () => {
    const runtime = parsePerformanceRuntime({ updated_at: "2026-08-07 12:00:00" });
    expect(runtime?.equity).toBeNull();
    expect(runtime?.rollingDrawdownPct).toBeNull();
  });
});

describe("parsePreflight", () => {
  it("extracts details and the universe hash from the check text", () => {
    const preflight = parsePreflight(preflightJson(), "https://run");
    expect(preflight?.status).toBe("PASS");
    expect(preflight?.checksPassed).toBe(18);
    expect(preflight?.universeCount).toBe(540);
    expect(preflight?.universeSource).toBe("validated-watchlist-fallback");
    expect(preflight?.universeSha256).toBe(UNIVERSE_HASH);
    expect(preflight?.strategyIdentity).toBe(STRATEGY_IDENTITY);
    expect(preflight?.riskTier).toBe("CAUTIOUS");
    expect(preflight?.runUrl).toBe("https://run");
  });

  it("rejects a foreign schema", () => {
    expect(parsePreflight(preflightJson({ kind: "other" }), null)).toBeNull();
    expect(parsePreflight(preflightJson({ status: "OK" }), null)).toBeNull();
  });
});

describe("validationExpiry", () => {
  it("uses the earlier of the report date and the bar boundary", () => {
    const { expiresAt, expiryBasis } = validationExpiry(
      "2026-08-02T15:56:49Z",
      "2026-07-10",
    );
    expect(expiryBasis).toBe("bar-boundary");
    expect(expiresAt).toBe("2026-08-14T00:00:00.000Z");
  });

  it("falls back to the report when there is no bar boundary", () => {
    const { expiryBasis } = validationExpiry("2026-08-02T15:56:49Z", null);
    expect(expiryBasis).toBe("report");
  });

  it("returns no expiry when neither date exists", () => {
    expect(validationExpiry(null, null)).toEqual({
      expiresAt: null,
      expiryBasis: null,
    });
  });
});

describe("parseValidation", () => {
  it("parses the canonical report and both segments", () => {
    const report = parseValidation(validationJson(), "abc123");
    expect(report?.status).toBe("PASS");
    expect(report?.allowedMode).toBe("paper-validation-eligible");
    expect(report?.strategyIdentityValue).toBe(STRATEGY_IDENTITY);
    expect(report?.rankingUniverseSha256).toBe(UNIVERSE_HASH);
    expect(report?.startingCapital).toBe(1_000_000);
    expect(report?.metrics).toHaveLength(2);

    const development = report?.metrics.find(
      (metric) => metric.segment === "development",
    );
    expect(development?.excessCagrPct).toBeCloseTo(8.2824);
    expect(development?.startDate).toBe("2022-01-04");
    expect(development?.sessions).toBe(752);

    const reused = report?.metrics.find(
      (metric) => metric.segment === "temporal_check",
    );
    expect(reused?.segmentLabel).toContain("not fresh OOS");
  });

  it("keeps the mandatory limitation warnings", () => {
    const report = parseValidation(validationJson(), "abc123");
    expect(report?.warnings.map((warning) => warning.code)).toContain(
      "NOT_FRESH_OOS",
    );
  });

  it("reports FAIL and UNAVAILABLE distinctly", () => {
    expect(
      parseValidation(
        validationJson({ assessment: { status: "FAIL" } }),
        "abc",
      )?.status,
    ).toBe("FAIL");
    expect(
      parseValidation(validationJson({ assessment: {} }), "abc")?.status,
    ).toBe("UNAVAILABLE");
    expect(parseValidation({ schema_version: 9 }, "abc")).toBeNull();
  });
});

describe("parseTournament", () => {
  it("parses the decision and the primary 15 bps candidate table", () => {
    const tournament = parseTournament(tournamentJson(), "main");
    expect(tournament?.decision).toBe("RETAIN_V11");
    expect(tournament?.productionChanged).toBe(false);
    expect(tournament?.eligibleChallengerCount).toBe(0);
    expect(tournament?.shadowChallenger).toBeNull();
    expect(tournament?.primaryCostBps).toBe(15);
    expect(tournament?.candidates[0].name).toBe("v11_incumbent");
    expect(tournament?.candidates[0].isIncumbent).toBe(true);
    expect(
      tournament?.candidates.every((candidate) => !candidate.eligibleChallenger),
    ).toBe(true);
  });

  it("rejects an artifact without a selection decision", () => {
    expect(parseTournament(tournamentJson({ selection: {} }), "main")).toBeNull();
  });
});
