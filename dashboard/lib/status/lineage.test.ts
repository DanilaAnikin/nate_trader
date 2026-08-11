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
  if ("universe_sha_override" in details) {
    const override = details.universe_sha_override;
    const base_checks = base.checks as { name: string }[];
    merged.checks = [
      ...base_checks.filter((check) => check.name !== "ranking_universe"),
      ...(override === null
        ? []
        : [
            {
              name: "ranking_universe",
              passed: true,
              detail: `540 symbols; hash=${override as string}`,
            },
          ]),
    ];
  }
  return parsePreflight(merged, null) as PreflightInfo;
}

/** Drop one named check from an otherwise complete preflight report. */
function preflightWithout(name: string): PreflightInfo {
  const base = preflightJson();
  const checks = (base.checks as { name: string }[]).filter(
    (check) => check.name !== name,
  );
  return parsePreflight({ ...base, checks }, null) as PreflightInfo;
}

/** Fail one named check in an otherwise complete preflight report. */
function preflightFailing(name: string): PreflightInfo {
  const base = preflightJson();
  const checks = (base.checks as { name: string; passed: boolean }[]).map(
    (check) => (check.name === name ? { ...check, passed: false } : check),
  );
  return parsePreflight({ ...base, checks }, null) as PreflightInfo;
}

/** The identity and universe the canonical report records. */
const VALIDATED = {
  strategyIdentity: STRATEGY_IDENTITY,
  rankingUniverseSha256: UNIVERSE_HASH,
};

function evaluate(overrides: Partial<Parameters<typeof evaluateLineage>[0]> = {}) {
  return evaluateLineage({
    approvedReleaseSha: APPROVED_SHA,
    performance: performance(),
    lastRun: lastRun(),
    preflight: preflight(),
    runtimeArtifactName: EXPECTED_ARTIFACT,
    expectedRuntimeArtifactName: EXPECTED_ARTIFACT,
    validated: VALIDATED,
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

  it("reports MISMATCH status when any value genuinely disagrees", () => {
    expect(evaluate().status).toBe("OK");
    expect(evaluate({ lastRun: lastRun({ release_sha: OTHER_SHA }) }).status).toBe(
      "MISMATCH",
    );
  });

  it("uses the plan's own identity and universe as the reference", () => {
    // Sanity: the fixtures really do share the identity and hash.
    expect(performance().plan?.strategyIdentityValue).toBe(STRATEGY_IDENTITY);
    expect(performance().plan?.rankingUniverseSha256).toBe(UNIVERSE_HASH);
    expect(preflight().strategyIdentity).toBe(STRATEGY_IDENTITY);
    expect(preflight().universeSha256).toBe(UNIVERSE_HASH);
  });
});

/* ---------------------------------------------------------------------------
 * Absent evidence is not agreement.
 *
 * The earlier implementation only compared two *present* values, so a document
 * that simply omitted its identity, hash or signal date sailed through as
 * CURRENT. Every case below must fail closed instead.
 * ------------------------------------------------------------------------- */

function fields(verdict: ReturnType<typeof evaluate>) {
  return verdict.conflicts.map((entry) => entry.field);
}

describe("a present preflight must prove its own lineage", () => {
  const BAD_IDENTITIES: readonly [string, unknown][] = [
    ["null", null],
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["uppercase hex", "A".repeat(64)],
    ["non-hex", "z".repeat(64)],
    ["prefixed", `sha256:${"a".repeat(64)}`],
  ];

  it.each(BAD_IDENTITIES)(
    "withholds everything when the strategy identity is %s",
    (_label, value) => {
      const verdict = evaluate({
        preflight: preflight({ strategy_identity: value }),
      });
      expect(verdict.ok).toBe(false);
      expect(fields(verdict)).toContain("strategyIdentity");
    },
  );

  it("fails when the preflight carries no ranking-universe hash at all", () => {
    const verdict = evaluate({
      preflight: preflight({ universe_sha_override: null }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("MISSING_EVIDENCE");
    expect(fields(verdict)).toContain("rankingUniverseHash");
  });

  it("fails when the ranking-universe hash is malformed", () => {
    // parsePreflight only accepts `hash=<64 hex>`, so a truncated digest is
    // indistinguishable from an absent one — both must fail closed.
    const verdict = evaluate({
      preflight: preflight({ universe_sha_override: "abc123" }),
    });
    expect(verdict.ok).toBe(false);
    expect(fields(verdict)).toContain("rankingUniverseHash");
  });

  it.each(["frozen_v11_policy", "strategy_identity"])(
    "fails when the %s check is absent from the report",
    (name) => {
      const verdict = evaluate({ preflight: preflightWithout(name) });
      expect(verdict.ok).toBe(false);
      expect(verdict.status).toBe("MISSING_EVIDENCE");
    },
  );

  it.each(["frozen_v11_policy", "strategy_identity"])(
    "fails when the %s check is present but failing",
    (name) => {
      const verdict = evaluate({ preflight: preflightFailing(name) });
      expect(verdict.ok).toBe(false);
      expect(verdict.status).toBe("MISMATCH");
    },
  );
});

describe("a present frozen plan must prove its own lineage", () => {
  it("fails when the plan has no signal date", () => {
    const verdict = evaluate({
      performance: performance({
        adaptive_rebalance_pending: frozenPlanJson({ signal_date: undefined }),
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("MISSING_EVIDENCE");
    expect(fields(verdict)).toContain("signalDate");
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["whitespace", "  "],
    ["a timestamp", "2026-08-03T00:00:00Z"],
    ["US order", "08/03/2026"],
    ["unpadded", "2026-8-3"],
    ["not a real date", "2026-02-30"],
    ["month 13", "2026-13-01"],
    ["garbage", "not-a-date"],
  ])("fails when the signal date is %s", (_label, value) => {
    const verdict = evaluate({
      performance: performance({
        adaptive_rebalance_pending: frozenPlanJson({ signal_date: value }),
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("MISSING_EVIDENCE");
    expect(fields(verdict)).toContain("signalDate");
  });

  it("accepts a leap day that really exists", () => {
    const verdict = evaluate({
      performance: performance({
        adaptive_rebalance_pending: frozenPlanJson({
          signal_date: "2028-02-29",
          created_at: "2028-03-01 12:00:00",
        }),
      }),
      lastRun: lastRun({ completed_at: "2028-03-01T16:05:05+00:00" }),
    });
    expect(verdict.conflicts.map((c) => c.field)).not.toContain("signalDate");
  });

  it("fails when the plan identity is not a SHA-256 digest", () => {
    const verdict = evaluate({
      performance: performance({
        adaptive_rebalance_pending: frozenPlanJson({
          strategy_identity_value: "identity",
        }),
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(fields(verdict)).toContain("strategyIdentity");
  });

  it("fails when the plan's universe hash is not a SHA-256 digest", () => {
    const verdict = evaluate({
      performance: performance({
        adaptive_rebalance_pending: frozenPlanJson({
          ranking_universe_sha256: "deadbeef",
        }),
      }),
    });
    expect(verdict.ok).toBe(false);
    expect(fields(verdict)).toContain("rankingUniverseHash");
  });
});

describe("release attribution is mandatory", () => {
  it("fails when runtime state exists but the approved release is unknown", () => {
    const verdict = evaluate({
      approvedReleaseSha: null,
      expectedRuntimeArtifactName: null,
    });
    expect(verdict.ok).toBe(false);
    expect(fields(verdict)).toContain("approvedReleaseSha");
  });

  it("fails when the approved release SHA is not a full commit id", () => {
    const verdict = evaluate({
      approvedReleaseSha: "0cb02c0",
      expectedRuntimeArtifactName: "paper-runtime-state-0cb02c0",
      runtimeArtifactName: "paper-runtime-state-0cb02c0",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("MISMATCH");
    expect(fields(verdict)).toContain("approvedReleaseSha");
  });

  it("fails when the run record does not say which release produced it", () => {
    const verdict = evaluate({ lastRun: lastRun({ release_sha: null }) });
    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("MISSING_EVIDENCE");
    expect(fields(verdict)).toContain("approvedReleaseSha");
  });

  it("fails when runtime state has no artifact name to bind it", () => {
    const verdict = evaluate({ runtimeArtifactName: null });
    expect(verdict.ok).toBe(false);
    expect(fields(verdict)).toContain("approvedReleaseSha");
  });
});
