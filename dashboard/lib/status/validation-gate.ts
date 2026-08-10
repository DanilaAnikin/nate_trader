/**
 * The one effective validation gate.
 *
 * There are two different questions and the UI previously conflated them:
 *
 *  1. *What did the historical report conclude?* — `reportAssessment`.
 *  2. *Does that report still authorize a paper buy right now?* —
 *     `effective`.
 *
 * Only the second may ever be rendered as a green "Validation gate PASS". An
 * expired, mismatched, undated or unbound report is never effective, however
 * green its stored assessment is.
 */

import type { EffectiveValidationGate, ValidationInfo } from "./types";
import type { CheckState } from "./vocab";

export type ValidationGateReason =
  | "REPORT_UNAVAILABLE"
  | "REPORT_NOT_PASS"
  | "MISSING_GENERATED_AT"
  | "MISSING_BAR_BOUNDARY"
  | "MISSING_EXPIRY"
  | "FUTURE_DATED"
  | "EXPIRED"
  | "STRATEGY_IDENTITY_MISMATCH"
  | "STRATEGY_IDENTITY_UNKNOWN"
  | "UNIVERSE_MISMATCH"
  | "UNIVERSE_UNKNOWN"
  | "APPROVED_RELEASE_UNKNOWN"
  | "LINEAGE_MISMATCH";

const REASON_DETAIL: Record<ValidationGateReason, string> = {
  REPORT_UNAVAILABLE: "The canonical validation report could not be read.",
  REPORT_NOT_PASS: "The canonical report's stored assessment is not PASS.",
  MISSING_GENERATED_AT: "The report has no usable generation timestamp.",
  MISSING_BAR_BOUNDARY: "The report has no adjusted-bar boundary date.",
  MISSING_EXPIRY: "No freshness deadline could be derived from the report.",
  FUTURE_DATED:
    "A critical report date lies in the future, so the evidence cannot be trusted.",
  EXPIRED:
    "The evidence is past its 35-day freshness deadline and can no longer authorize a paper buy.",
  STRATEGY_IDENTITY_MISMATCH:
    "The report's strategy identity does not match the running release.",
  STRATEGY_IDENTITY_UNKNOWN:
    "The running strategy identity is unknown, so the report cannot be bound to it.",
  UNIVERSE_MISMATCH:
    "The report's ranking-universe hash does not match the running ranking universe.",
  UNIVERSE_UNKNOWN:
    "The running ranking universe is unknown, so the report cannot be bound to it.",
  APPROVED_RELEASE_UNKNOWN:
    "The approved paper release is unknown, so no report can be bound to it.",
  LINEAGE_MISMATCH:
    "The preflight, frozen plan and executor record do not agree on the release, strategy or universe they describe.",
};

/**
 * Compute the effective gate. Every condition is an AND; the first failing
 * reasons are all reported so the operator sees why, not just that.
 */
export function computeEffectiveValidationGate(input: {
  report: ValidationInfo | null;
  approvedReleaseSha: string | null;
  /** True when the approved SHA came from an authoritative source. */
  approvedReleaseAuthoritative: boolean;
  /** False when the shared lineage verdict found any conflict. */
  lineageOk?: boolean;
  now: Date;
}): EffectiveValidationGate {
  const { report, now } = input;
  const reasons: ValidationGateReason[] = [];

  if (!report) {
    return {
      effective: "UNAVAILABLE",
      reportAssessment: "UNAVAILABLE",
      reasons: ["REPORT_UNAVAILABLE"],
      details: [REASON_DETAIL.REPORT_UNAVAILABLE],
      expiresAt: null,
    };
  }

  const reportAssessment: CheckState = report.status;
  if (report.status !== "PASS") reasons.push("REPORT_NOT_PASS");

  if (!input.approvedReleaseSha || !input.approvedReleaseAuthoritative) {
    reasons.push("APPROVED_RELEASE_UNKNOWN");
  }
  if (input.lineageOk === false) reasons.push("LINEAGE_MISMATCH");

  const nowMs = now.getTime();
  const generatedAtMs = report.generatedAt ? Date.parse(report.generatedAt) : NaN;
  if (!Number.isFinite(generatedAtMs)) {
    reasons.push("MISSING_GENERATED_AT");
  } else if (generatedAtMs > nowMs) {
    reasons.push("FUTURE_DATED");
  }

  const boundaryMs = report.barBoundaryDate
    ? Date.parse(`${report.barBoundaryDate}T00:00:00Z`)
    : NaN;
  if (!Number.isFinite(boundaryMs)) {
    reasons.push("MISSING_BAR_BOUNDARY");
  } else if (boundaryMs > nowMs) {
    reasons.push("FUTURE_DATED");
  }

  const expiresAtMs = report.expiresAt ? Date.parse(report.expiresAt) : NaN;
  if (!Number.isFinite(expiresAtMs)) {
    reasons.push("MISSING_EXPIRY");
  } else if (nowMs > expiresAtMs) {
    reasons.push("EXPIRED");
  }

  if (report.identityMatchesRuntime === "FAIL") {
    reasons.push("STRATEGY_IDENTITY_MISMATCH");
  } else if (report.identityMatchesRuntime !== "PASS") {
    reasons.push("STRATEGY_IDENTITY_UNKNOWN");
  }

  if (report.universeMatchesRuntime === "FAIL") {
    reasons.push("UNIVERSE_MISMATCH");
  } else if (report.universeMatchesRuntime !== "PASS") {
    reasons.push("UNIVERSE_UNKNOWN");
  }

  const unique = [...new Set(reasons)];
  const effective: CheckState = unique.length === 0 ? "PASS" : "FAIL";

  return {
    effective,
    reportAssessment,
    reasons: unique,
    details: unique.map((reason) => REASON_DETAIL[reason]),
    expiresAt: report.expiresAt,
  };
}

/** The gate to show when the viewer may not see production evidence at all. */
export const NOT_APPLICABLE_GATE: EffectiveValidationGate = {
  effective: "NOT_APPLICABLE",
  reportAssessment: "UNAVAILABLE",
  reasons: [],
  details: [
    "The effective paper-buy gate is a production fact and is not evaluated for a non-production viewer.",
  ],
  expiresAt: null,
};
