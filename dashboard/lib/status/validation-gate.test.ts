import { describe, expect, it } from "vitest";
import {
  computeEffectiveValidationGate,
  NOT_APPLICABLE_GATE,
} from "./validation-gate";
import type { PreflightInfo, ValidationInfo } from "./types";
import { parsePreflight } from "./parse";
import {
  APPROVED_SHA,
  STRATEGY_IDENTITY,
  UNIVERSE_HASH,
  preflightJson,
} from "@/test/fixtures";

const BAR_SNAPSHOT = "b".repeat(64);
const REPORT_DIGEST = "c".repeat(64);
const RUN_ID = 900;

/** A complete preflight whose Python gate check passed. */
function preflight(
  mutate: (checks: { name: string; passed: boolean; detail: string }[]) => void = () => {},
): PreflightInfo {
  const base = preflightJson();
  const checks = (base.checks as { name: string; passed: boolean; detail: string }[]).map(
    (check) => ({ ...check }),
  );
  mutate(checks);
  return parsePreflight({ ...base, checks }, null) as PreflightInfo;
}

const NOW = new Date("2026-08-07T17:00:00Z");

function report(overrides: Partial<ValidationInfo> = {}): ValidationInfo {
  return {
    status: "PASS",
    allowedMode: "paper-validation-eligible",
    generatedAt: "2026-08-02T15:56:49Z",
    barBoundaryDate: "2026-07-10",
    expiresAt: "2026-08-14T00:00:00Z",
    expiryBasis: "bar-boundary",
    checksPassed: 8,
    checksEvaluated: 8,
    strategyIdentityValue: STRATEGY_IDENTITY,
    rankingUniverseSha256: UNIVERSE_HASH,
    rankingUniverseCount: 540,
    startingCapital: 1_000_000,
    slippageScenariosBps: [7, 15],
    identityMatchesRuntime: "PASS",
    universeMatchesRuntime: "PASS",
    reportSha256: REPORT_DIGEST,
    barSnapshotSha256: BAR_SNAPSHOT,
    contractSchemaVersion: 1,
    contractAlgorithm: "sha256",
    metrics: [],
    warnings: [],
    readAtRef: APPROVED_SHA,
    ...overrides,
  };
}

function gate(
  overrides: Partial<ValidationInfo> = {},
  options: {
    approvedReleaseSha?: string | null;
    authoritative?: boolean;
    preflight?: PreflightInfo | null;
    preflightRunId?: number | null;
    executionRunId?: number | null;
  } = {},
) {
  return computeEffectiveValidationGate({
    report: report(overrides),
    approvedReleaseSha:
      options.approvedReleaseSha === undefined
        ? APPROVED_SHA
        : options.approvedReleaseSha,
    approvedReleaseAuthoritative: options.authoritative ?? true,
    preflight:
      options.preflight === undefined ? preflight() : options.preflight,
    preflightRunId:
      options.preflightRunId === undefined ? RUN_ID : options.preflightRunId,
    executionRunId:
      options.executionRunId === undefined ? RUN_ID : options.executionRunId,
    now: NOW,
  });
}

describe("computeEffectiveValidationGate", () => {
  it("is effective only when every condition holds", () => {
    const result = gate();
    expect(result.effective).toBe("PASS");
    expect(result.reportAssessment).toBe("PASS");
    expect(result.reasons).toEqual([]);
  });

  it("separates the stored assessment from the effective gate", () => {
    const expired = gate({ expiresAt: "2026-08-01T00:00:00Z" });
    // The historical conclusion is unchanged...
    expect(expired.reportAssessment).toBe("PASS");
    // ...but it authorizes nothing now.
    expect(expired.effective).toBe("FAIL");
    expect(expired.reasons).toContain("EXPIRED");
  });

  it("fails on a strategy-identity mismatch", () => {
    const result = gate({ identityMatchesRuntime: "FAIL" });
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("STRATEGY_IDENTITY_MISMATCH");
  });

  it("fails on a ranking-universe mismatch", () => {
    const result = gate({ universeMatchesRuntime: "FAIL" });
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("UNIVERSE_MISMATCH");
  });

  it("fails when identity or universe could not be compared at all", () => {
    const result = gate({
      identityMatchesRuntime: "UNAVAILABLE",
      universeMatchesRuntime: "UNAVAILABLE",
    });
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "STRATEGY_IDENTITY_UNKNOWN",
        "UNIVERSE_UNKNOWN",
      ]),
    );
  });

  it("fails on a missing critical date", () => {
    expect(gate({ generatedAt: null }).reasons).toContain("MISSING_GENERATED_AT");
    expect(gate({ barBoundaryDate: null }).reasons).toContain(
      "MISSING_BAR_BOUNDARY",
    );
    expect(gate({ expiresAt: null }).reasons).toContain("MISSING_EXPIRY");
  });

  it("fails on a future-dated report or bar boundary", () => {
    expect(gate({ generatedAt: "2027-01-01T00:00:00Z" }).reasons).toContain(
      "FUTURE_DATED",
    );
    expect(gate({ barBoundaryDate: "2027-01-04" }).reasons).toContain(
      "FUTURE_DATED",
    );
  });

  it("fails when the stored assessment is not PASS", () => {
    const result = gate({ status: "FAIL" });
    expect(result.reportAssessment).toBe("FAIL");
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("REPORT_NOT_PASS");
  });

  it("fails when the approved release is unknown or only derived", () => {
    expect(gate({}, { approvedReleaseSha: null }).reasons).toContain(
      "APPROVED_RELEASE_UNKNOWN",
    );
    // A SHA guessed from an artifact name is not an approval.
    expect(gate({}, { authoritative: false }).reasons).toContain(
      "APPROVED_RELEASE_UNKNOWN",
    );
  });

  it("is UNAVAILABLE, not FAIL, when there is no report", () => {
    const result = computeEffectiveValidationGate({
      report: null,
      approvedReleaseSha: APPROVED_SHA,
      approvedReleaseAuthoritative: true,
      now: NOW,
    });
    expect(result.effective).toBe("UNAVAILABLE");
    expect(result.reasons).toEqual(["REPORT_UNAVAILABLE"]);
  });

  it("reports every failing reason, not just the first", () => {
    const result = gate({
      status: "FAIL",
      expiresAt: "2026-01-01T00:00:00Z",
      identityMatchesRuntime: "FAIL",
    });
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
    expect(result.details.length).toBe(result.reasons.length);
  });

  it("offers a NOT_APPLICABLE gate for a non-production viewer", () => {
    expect(NOT_APPLICABLE_GATE.effective).toBe("NOT_APPLICABLE");
    expect(NOT_APPLICABLE_GATE.reportAssessment).toBe("UNAVAILABLE");
  });
});

/* ---------------------------------------------------------------------------
 * The gate must not be a weaker imitation of `_v11_validation_gate` in
 * `scripts/execute_trades.py`. Everything TypeScript cannot recompute is
 * deferred to the persisted Python verdict; everything it can check, it checks.
 * ------------------------------------------------------------------------- */

describe("the effective gate matches the Python gate's conditions", () => {
  it("refuses a shadow-only report even when its assessment is PASS", () => {
    // A custom-date, custom-capital or non-canonical-cost run still records
    // status PASS; only `allowed_mode` distinguishes it.
    const result = gate({ allowedMode: "shadow-research-only" });
    expect(result.reportAssessment).toBe("PASS");
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("NOT_PAPER_VALIDATION_ELIGIBLE");
  });

  it("refuses a report with no allowed_mode at all", () => {
    expect(gate({ allowedMode: null }).reasons).toContain(
      "NOT_PAPER_VALIDATION_ELIGIBLE",
    );
  });

  it.each([
    ["no digest", { reportSha256: null }],
    ["a non-SHA-256 digest", { reportSha256: "digest" }],
    ["a truncated digest", { reportSha256: "a".repeat(63) }],
    ["the wrong contract schema", { contractSchemaVersion: 2 }],
    ["a missing contract schema", { contractSchemaVersion: null }],
    ["the wrong algorithm", { contractAlgorithm: "md5" }],
  ])("refuses a report with %s", (_label, overrides) => {
    const result = gate(overrides as Partial<ValidationInfo>);
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("MISSING_CONTRACT_DIGEST");
  });

  it.each([
    ["strategy identity", { strategyIdentityValue: null }],
    ["ranking universe", { rankingUniverseSha256: null }],
    ["adjusted-bar prefix", { barSnapshotSha256: null }],
    ["a malformed bar digest", { barSnapshotSha256: "not-a-digest" }],
  ])("refuses a report missing its %s evidence", (_label, overrides) => {
    const result = gate(overrides as Partial<ValidationInfo>);
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("MISSING_EVIDENCE");
  });

  it.each([
    ["zero evaluated", { checksEvaluated: 0, checksPassed: 0 }],
    ["zero passed", { checksPassed: 0 }],
    ["null counts", { checksEvaluated: null, checksPassed: null }],
    ["a partial pass", { checksEvaluated: 8, checksPassed: 7 }],
  ])("refuses a PASS with %s checks", (_label, overrides) => {
    const result = gate(overrides as Partial<ValidationInfo>);
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("NO_CHECKS_RECORDED");
  });

  it("refuses when the executor's own gate check failed in production", () => {
    // The stored report is spotless; production disagreed. Python wins.
    const result = gate(
      {},
      {
        preflight: preflight((checks) => {
          const target = checks.find(
            (check) => check.name === "canonical_validation_gate",
          )!;
          target.passed = false;
        }),
      },
    );
    expect(result.reportAssessment).toBe("PASS");
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("PREFLIGHT_GATE_FAILED");
  });

  it("refuses when the preflight never captured that check", () => {
    const base = preflight();
    const stripped: PreflightInfo = {
      ...base,
      checks: base.checks.filter(
        (check) => check.name !== "canonical_validation_gate",
      ),
    };
    expect(gate({}, { preflight: stripped }).reasons).toContain(
      "PREFLIGHT_GATE_MISSING",
    );
  });

  it("refuses when there is no preflight to defer to", () => {
    expect(gate({}, { preflight: null }).reasons).toContain(
      "PREFLIGHT_UNAVAILABLE",
    );
  });

  it("refuses a preflight from a different cycle than the runtime state", () => {
    // A newer manual preflight may sit beside an older execution for display,
    // but its gate result answered a question about a different cycle.
    const result = gate({}, { preflightRunId: 901, executionRunId: 900 });
    expect(result.effective).toBe("FAIL");
    expect(result.reasons).toContain("PREFLIGHT_CYCLE_MISMATCH");
  });

  it.each([
    ["the preflight run is unknown", { preflightRunId: null }],
    ["the execution run is unknown", { executionRunId: null }],
  ])("refuses when %s", (_label, options) => {
    expect(gate({}, options).reasons).toContain("PREFLIGHT_CYCLE_MISMATCH");
  });

  it("still passes when every condition genuinely holds", () => {
    // Guards against the suite above passing because the base fixture is broken.
    expect(gate().reasons).toEqual([]);
    expect(gate().effective).toBe("PASS");
  });
});
