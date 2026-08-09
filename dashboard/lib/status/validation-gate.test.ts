import { describe, expect, it } from "vitest";
import {
  computeEffectiveValidationGate,
  NOT_APPLICABLE_GATE,
} from "./validation-gate";
import type { ValidationInfo } from "./types";
import { APPROVED_SHA, UNIVERSE_HASH } from "@/test/fixtures";

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
    strategyIdentityValue: "identity",
    rankingUniverseSha256: UNIVERSE_HASH,
    rankingUniverseCount: 540,
    startingCapital: 1_000_000,
    slippageScenariosBps: [7, 15],
    identityMatchesRuntime: "PASS",
    universeMatchesRuntime: "PASS",
    reportSha256: "digest",
    metrics: [],
    warnings: [],
    readAtRef: APPROVED_SHA,
    ...overrides,
  };
}

function gate(
  overrides: Partial<ValidationInfo> = {},
  options: { approvedReleaseSha?: string | null; authoritative?: boolean } = {},
) {
  return computeEffectiveValidationGate({
    report: report(overrides),
    approvedReleaseSha:
      options.approvedReleaseSha === undefined
        ? APPROVED_SHA
        : options.approvedReleaseSha,
    approvedReleaseAuthoritative: options.authoritative ?? true,
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
