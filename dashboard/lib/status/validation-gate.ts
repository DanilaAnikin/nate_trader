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
 *
 * ## Why this defers to Python
 *
 * `scripts/execute_trades.py::_v11_validation_gate` is the real gate. It
 * recomputes things this process structurally cannot: the whole-report SHA-256
 * over the canonical serialization, the adjusted-bar prefix digest for the
 * recorded boundary, the canonical period payload resolved from local history,
 * and the current ranking-universe hash. Re-deriving any of that in TypeScript
 * would produce a *second, weaker* gate that could show PASS while the executor
 * refuses to buy — the failure mode this module exists to prevent.
 *
 * So the split is explicit:
 *
 *  * **Checked here** — what the dashboard can verify from documents it has
 *    read: the stored assessment, `allowed_mode`, the presence and shape of the
 *    mandatory contract and evidence fields, freshness, and the identity and
 *    universe bindings against the running runtime.
 *  * **Deferred to the persisted Python verdict** — everything else, via the
 *    preflight's own `canonical_validation_gate` check. That check *is* the
 *    Python gate's answer, captured for a specific cycle, and it must be
 *    present, passing, and from the same runtime cycle as the state on screen.
 *
 * Nothing here can turn a Python `FAIL` into a UI `PASS`, and every condition
 * is an AND.
 */

import type { EffectiveValidationGate, PreflightInfo, ValidationInfo } from "./types";
import type { CheckState } from "./vocab";

export type ValidationGateReason =
  | "REPORT_UNAVAILABLE"
  | "REPORT_NOT_PASS"
  | "NOT_PAPER_VALIDATION_ELIGIBLE"
  | "MISSING_CONTRACT_DIGEST"
  | "MISSING_EVIDENCE"
  | "NO_CHECKS_RECORDED"
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
  | "LINEAGE_MISMATCH"
  | "PREFLIGHT_UNAVAILABLE"
  | "PREFLIGHT_GATE_MISSING"
  | "PREFLIGHT_GATE_FAILED"
  | "PREFLIGHT_CYCLE_MISMATCH";

/** SHA-256 as the artifacts record it: 64 lower-case hex characters. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The one `allowed_mode` that authorizes a paper buy.
 *
 * The validator emits a different value for any shadow-only run — custom
 * dates, custom capital or a non-canonical cost set — and the Python gate
 * rejects anything else outright. A report can therefore be `PASS` and still be
 * shadow-only, which must never light this gate green.
 */
export const PAPER_ELIGIBLE_MODE = "paper-validation-eligible";

/** The preflight check that carries the Python gate's own verdict. */
export const PYTHON_GATE_CHECK = "canonical_validation_gate";

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
  NOT_PAPER_VALIDATION_ELIGIBLE: `The report's allowed_mode is not "${PAPER_ELIGIBLE_MODE}", so it is shadow-only evidence and cannot authorize a paper buy.`,
  MISSING_CONTRACT_DIGEST:
    "The report carries no well-formed whole-report contract digest, so it cannot be checked for tampering.",
  MISSING_EVIDENCE:
    "The report is missing a mandatory evidence hash (strategy identity, ranking universe or adjusted-bar prefix).",
  NO_CHECKS_RECORDED:
    "The report records no evaluated checks, so its PASS is not backed by anything.",
  PREFLIGHT_UNAVAILABLE:
    "No production preflight report is available, so the executor's own validation gate result is unknown.",
  PREFLIGHT_GATE_MISSING: `The preflight report does not contain the ${PYTHON_GATE_CHECK} check, so the executor's gate result was never captured.`,
  PREFLIGHT_GATE_FAILED:
    "The executor's own canonical validation gate failed in production, whatever the stored report says.",
  PREFLIGHT_CYCLE_MISMATCH:
    "The available preflight is from a different cycle than the runtime state on screen, so its gate result does not authorize this state.",
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
  /** The persisted Python verdict for a cycle, or null when unavailable. */
  preflight?: PreflightInfo | null;
  /** Workflow run the preflight came from. */
  preflightRunId?: number | null;
  /** Workflow run the displayed runtime state came from. */
  executionRunId?: number | null;
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

  // A shadow-only run (custom dates, capital or cost set) can still be PASS.
  if (report.allowedMode !== PAPER_ELIGIBLE_MODE) {
    reasons.push("NOT_PAPER_VALIDATION_ELIGIBLE");
  }

  // The report contract must at least be *shaped* like the one Python verifies.
  // Its digest cannot be recomputed here, so its absence is fatal rather than
  // ignorable — an object with no contract block is not a canonical report.
  if (
    report.contractSchemaVersion !== 1 ||
    report.contractAlgorithm !== "sha256" ||
    !SHA256_RE.test(report.reportSha256 ?? "")
  ) {
    reasons.push("MISSING_CONTRACT_DIGEST");
  }

  // Mandatory evidence. Python recomputes each of these; the dashboard can only
  // insist that they exist and are digests.
  if (
    !SHA256_RE.test(report.strategyIdentityValue ?? "") ||
    !SHA256_RE.test(report.rankingUniverseSha256 ?? "") ||
    !SHA256_RE.test(report.barSnapshotSha256 ?? "")
  ) {
    reasons.push("MISSING_EVIDENCE");
  }

  // A PASS with zero evaluated checks is an assertion, not evidence.
  if (
    report.checksEvaluated === null ||
    report.checksEvaluated <= 0 ||
    report.checksPassed === null ||
    report.checksPassed <= 0 ||
    report.checksPassed !== report.checksEvaluated
  ) {
    reasons.push("NO_CHECKS_RECORDED");
  }

  if (!input.approvedReleaseSha || !input.approvedReleaseAuthoritative) {
    reasons.push("APPROVED_RELEASE_UNKNOWN");
  }
  if (input.lineageOk === false) reasons.push("LINEAGE_MISMATCH");

  // The executor's own gate, as it actually ran in production. This is the
  // authority for every condition above that TypeScript cannot recompute.
  const preflight = input.preflight ?? null;
  if (!preflight) {
    reasons.push("PREFLIGHT_UNAVAILABLE");
  } else {
    const pythonGate = preflight.checks.find(
      (check) => check.name === PYTHON_GATE_CHECK,
    );
    if (!pythonGate) {
      reasons.push("PREFLIGHT_GATE_MISSING");
    } else if (!pythonGate.passed) {
      reasons.push("PREFLIGHT_GATE_FAILED");
    }
    // A preflight from a different cycle answered a different question. The
    // read model deliberately lets a newer preflight sit beside an older
    // execution for *display*; it must not silently authorize it.
    if (
      input.preflightRunId == null ||
      input.executionRunId == null ||
      input.preflightRunId !== input.executionRunId
    ) {
      reasons.push("PREFLIGHT_CYCLE_MISMATCH");
    }
  }

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
