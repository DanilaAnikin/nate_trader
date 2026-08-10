import { describe, expect, it } from "vitest";
import { evaluateLineage } from "./lineage";
import {
  parseLastRun,
  parsePerformanceRuntime,
  parsePreflight,
  type LastRunSnapshot,
  type PerformanceRuntimeSnapshot,
} from "./parse";
import type { PreflightInfo } from "./types";
import {
  APPROVED_SHA,
  frozenPlanJson,
  lastRunJson,
  OTHER_SHA,
  performanceJson,
  preflightJson,
  STRATEGY_IDENTITY,
  UNIVERSE_HASH,
} from "@/test/fixtures";

const EXPECTED_ARTIFACT = `paper-runtime-state-${APPROVED_SHA}`;

function performance(
  overrides: Record<string, unknown> = {},
): PerformanceRuntimeSnapshot {
  return parsePerformanceRuntime(
    performanceJson(overrides),
  ) as PerformanceRuntimeSnapshot;
}

function lastRun(overrides: Record<string, unknown> = {}): LastRunSnapshot {
  return parseLastRun(lastRunJson(overrides)) as LastRunSnapshot;
}

function preflight(details: Record<string, unknown> = {}): PreflightInfo {
  const base = preflightJson();
  const baseDetails = base.details as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...base,
    details: { ...baseDetails, ...details },
  };
  if (details.universe_sha_override) {
    merged.checks = [
      {
        name: "ranking_universe",
        passed: true,
        detail: `540 symbols; hash=${details.universe_sha_override as string}`,
      },
    ];
  }
  return parsePreflight(merged, null) as PreflightInfo;
}

function evaluate(overrides: Partial<Parameters<typeof evaluateLineage>[0]> = {}) {
  return evaluateLineage({
    approvedReleaseSha: APPROVED_SHA,
    performance: performance(),
    lastRun: lastRun(),
    preflight: preflight(),
    runtimeArtifactName: EXPECTED_ARTIFACT,
    expectedRuntimeArtifactName: EXPECTED_ARTIFACT,
    ...overrides,
  });
}

describe("evaluateLineage", () => {
  it("agrees when every mandatory field lines up", () => {
    const verdict = evaluate();
    expect(verdict.ok).toBe(true);
    expect(verdict.conflicts).toEqual([]);
    expect(verdict.detail).toBeNull();
  });

  it("treats an absent document as unavailable, not as a conflict", () => {
    expect(evaluate({ preflight: null }).ok).toBe(true);
    expect(evaluate({ performance: null }).ok).toBe(true);
    expect(evaluate({ lastRun: null }).ok).toBe(true);
  });

  it("flags a preflight strategy-identity mismatch", () => {
    const verdict = evaluate({
      preflight: preflight({ strategy_identity: "a-different-identity" }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflicts.map((c) => c.field)).toContain("strategyIdentity");
    expect(verdict.detail).toContain("strategy identity");
  });

  it("flags a preflight ranking-universe mismatch", () => {
    const verdict = evaluate({
      preflight: preflight({ universe_sha_override: "f".repeat(64) }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflicts.map((c) => c.field)).toContain(
      "rankingUniverseHash",
    );
  });

  it("flags an execution record naming a different release", () => {
    const verdict = evaluate({ lastRun: lastRun({ release_sha: OTHER_SHA }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflicts.map((c) => c.field)).toContain(
      "approvedReleaseSha",
    );
  });

  it("flags a runtime artifact named for another release", () => {
    const verdict = evaluate({
      runtimeArtifactName: `paper-runtime-state-${OTHER_SHA}`,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflicts.map((c) => c.field)).toContain(
      "approvedReleaseSha",
    );
  });

  it("flags a non-V11 strategy version", () => {
    const verdict = evaluate({
      lastRun: lastRun({ strategy_version: "v12-experimental" }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflicts.map((c) => c.field)).toContain("strategyVersion");
  });

  it("flags a plan whose signal date is after the cycle that produced it", () => {
    const verdict = evaluate({
      performance: performance({
        adaptive_rebalance_pending: frozenPlanJson({
          signal_date: "2027-01-04",
        }),
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.conflicts.map((c) => c.field)).toContain("signalDate");
  });

  it("reports every conflict, not only the first", () => {
    const verdict = evaluate({
      lastRun: lastRun({ release_sha: OTHER_SHA, strategy_version: "v12" }),
      preflight: preflight({ strategy_identity: "other" }),
    });
    expect(verdict.conflicts.length).toBeGreaterThanOrEqual(3);
    expect(verdict.detail?.split(";").length).toBeGreaterThanOrEqual(3);
  });

  it("uses the plan's own identity and universe as the reference", () => {
    // Sanity: the fixtures really do share the identity and hash.
    expect(performance().plan?.strategyIdentityValue).toBe(STRATEGY_IDENTITY);
    expect(performance().plan?.rankingUniverseSha256).toBe(UNIVERSE_HASH);
    expect(preflight().strategyIdentity).toBe(STRATEGY_IDENTITY);
    expect(preflight().universeSha256).toBe(UNIVERSE_HASH);
  });
});
