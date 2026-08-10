/**
 * One shared, fail-closed lineage verdict.
 *
 * The preflight report, the frozen plan and the executor run record are three
 * independently produced documents. They are only meaningful together if they
 * describe the *same* release, the same strategy build and the same ranking
 * universe. Previously each consumer checked a different subset, so a
 * disagreement could leave one section CURRENT while another was MISMATCH.
 *
 * This module cross-checks every mandatory lineage field once. If anything
 * disagrees — or if a document that *is* present cannot prove its own lineage —
 * every dependent section is withheld: strategy, universe, preflight,
 * execution and convergence become null/MISMATCH and the effective validation
 * gate cannot be PASS.
 *
 * Absent evidence is never treated as agreement. A missing hash, an empty
 * identity string, a malformed date and a hash that is 63 characters long all
 * fail exactly like an outright disagreement; only the reported `kind` differs
 * (MISSING_EVIDENCE versus MISMATCH), so provenance can say which happened.
 */

import type { LastRunSnapshot, PerformanceRuntimeSnapshot } from "./parse";
import type { PreflightInfo } from "./types";

export const V11_STRATEGY_VERSION = "v11-adaptive-momentum";

/** Lower-case hex SHA-256, exactly 64 characters. */
const SHA256_RE = /^[0-9a-f]{64}$/;
/** Lower-case hex git object name, exactly 40 characters. */
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
/** Strict `YYYY-MM-DD`; calendar validity is checked separately. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type LineageField =
  | "approvedReleaseSha"
  | "strategyIdentity"
  | "strategyVersion"
  | "rankingUniverseHash"
  | "signalDate";

/**
 * Why a field failed.
 *
 * MISSING_EVIDENCE — the document is present but does not carry a usable value
 * (absent, empty, wrong shape). MISMATCH — two usable values disagree.
 * Both are fail-closed; the distinction exists only so the UI can explain
 * itself accurately.
 */
export type LineageFailureKind = "MISSING_EVIDENCE" | "MISMATCH";

export type LineageStatus = "OK" | LineageFailureKind;

export interface LineageConflict {
  readonly field: LineageField;
  readonly kind: LineageFailureKind;
  readonly detail: string;
}

export interface LineageVerdict {
  readonly ok: boolean;
  readonly status: LineageStatus;
  readonly conflicts: readonly LineageConflict[];
  /** Human-readable summary, safe to show in provenance. */
  readonly detail: string | null;
}

export const LINEAGE_OK: LineageVerdict = {
  ok: true,
  status: "OK",
  conflicts: [],
  detail: null,
};

/**
 * The state a dependent section takes when the verdict is not OK.
 *
 * Both withhold every number. MISMATCH says two documents contradict each
 * other; UNAVAILABLE says the evidence needed to decide was never there. The
 * distinction is reported, never softened — neither can be CURRENT or PASS.
 */
export function lineageWithholdState(
  verdict: LineageVerdict,
): "MISMATCH" | "UNAVAILABLE" {
  return verdict.status === "MISMATCH" ? "MISMATCH" : "UNAVAILABLE";
}

/** A value usable as evidence: a non-empty, untrimmed-safe string. */
function present(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

/**
 * A strict ISO calendar date. `2026-02-30` matches the shape but is not a real
 * date, so the parsed value is round-tripped to reject it.
 */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * Cross-check every mandatory lineage field across the selected documents.
 *
 * A document that is entirely absent is an *availability* problem the caller
 * reports as UNAVAILABLE, not a lineage conflict — there is nothing to
 * contradict. A document that is **present** must, however, carry every
 * lineage field it is responsible for, in a valid format.
 */
export function evaluateLineage(input: {
  approvedReleaseSha: string | null;
  performance: PerformanceRuntimeSnapshot | null;
  lastRun: LastRunSnapshot | null;
  preflight: PreflightInfo | null;
  /** Artifact name the runtime state actually came from, when known. */
  runtimeArtifactName: string | null;
  expectedRuntimeArtifactName: string | null;
}): LineageVerdict {
  const conflicts: LineageConflict[] = [];
  const add = (
    field: LineageField,
    kind: LineageFailureKind,
    detail: string,
  ) => {
    conflicts.push({ field, kind, detail });
  };

  const plan = input.performance?.plan ?? null;
  const preflight = input.preflight;
  const lastRun = input.lastRun;
  const hasRuntimeEvidence = input.performance !== null || lastRun !== null;

  // --- approved release -----------------------------------------------------
  if (input.approvedReleaseSha !== null && !GIT_SHA_RE.test(input.approvedReleaseSha)) {
    add(
      "approvedReleaseSha",
      "MISMATCH",
      "the approved paper release SHA is not a full 40-character commit id",
    );
  } else if (input.approvedReleaseSha === null && hasRuntimeEvidence) {
    // Runtime state exists but there is nothing to attribute it to. Showing it
    // as the approved production run would be a claim we cannot support.
    add(
      "approvedReleaseSha",
      "MISSING_EVIDENCE",
      "runtime state was read but the approved paper release SHA is unknown",
    );
  }

  if (input.performance !== null && input.runtimeArtifactName === null) {
    add(
      "approvedReleaseSha",
      "MISSING_EVIDENCE",
      "the runtime state carries no artifact name to bind it to a release",
    );
  }
  if (
    input.runtimeArtifactName !== null &&
    input.expectedRuntimeArtifactName !== null &&
    input.runtimeArtifactName !== input.expectedRuntimeArtifactName
  ) {
    add(
      "approvedReleaseSha",
      "MISMATCH",
      "the runtime artifact is not named for the approved paper release",
    );
  }

  if (lastRun !== null) {
    if (!present(lastRun.releaseSha)) {
      add(
        "approvedReleaseSha",
        "MISSING_EVIDENCE",
        "the executor run record does not record which release produced it",
      );
    } else if (!GIT_SHA_RE.test(lastRun.releaseSha)) {
      add(
        "approvedReleaseSha",
        "MISMATCH",
        "the executor run record's release id is not a full 40-character commit id",
      );
    } else if (
      input.approvedReleaseSha !== null &&
      lastRun.releaseSha !== input.approvedReleaseSha
    ) {
      add(
        "approvedReleaseSha",
        "MISMATCH",
        "the executor run record names a different release than the approved paper release",
      );
    }
  }

  // --- strategy version -----------------------------------------------------
  if (lastRun !== null && lastRun.strategyVersion !== V11_STRATEGY_VERSION) {
    add(
      "strategyVersion",
      "MISMATCH",
      `the executor run record reports strategy version ${lastRun.strategyVersion}, not ${V11_STRATEGY_VERSION}`,
    );
  }

  // The preflight report does not persist a version string; it persists the
  // `frozen_v11_policy` check, which is exactly the assertion that the running
  // parameters are the V11 policy (`strategy_version == v11-adaptive-momentum`,
  // top-10, 9% name cap, 20% sector cap, 10% cash floor). Requiring that named
  // check to be present and passed is therefore the strategy-version evidence
  // this document actually carries — no claim is made beyond it.
  if (preflight !== null) {
    const policyCheck = preflight.checks.find(
      (check) => check.name === "frozen_v11_policy",
    );
    if (!policyCheck) {
      add(
        "strategyVersion",
        "MISSING_EVIDENCE",
        "the preflight report does not contain the frozen_v11_policy check",
      );
    } else if (!policyCheck.passed) {
      add(
        "strategyVersion",
        "MISMATCH",
        "the preflight reports that the running parameters are not the frozen V11 policy",
      );
    }
  }

  // --- strategy identity ----------------------------------------------------
  const planIdentity = plan?.strategyIdentityValue ?? null;
  const preflightIdentity = preflight?.strategyIdentity ?? null;

  if (preflight !== null && !isSha256(preflightIdentity)) {
    add(
      "strategyIdentity",
      "MISSING_EVIDENCE",
      present(preflightIdentity)
        ? "the preflight strategy identity is not a SHA-256 digest"
        : "the preflight report carries no strategy identity",
    );
  }
  if (preflight !== null) {
    const identityCheck = preflight.checks.find(
      (check) => check.name === "strategy_identity",
    );
    if (!identityCheck) {
      add(
        "strategyIdentity",
        "MISSING_EVIDENCE",
        "the preflight report does not contain the strategy_identity check",
      );
    } else if (!identityCheck.passed) {
      add(
        "strategyIdentity",
        "MISMATCH",
        "the preflight reports that the running code does not match the validated strategy identity",
      );
    }
  }
  if (plan !== null && !isSha256(planIdentity)) {
    add(
      "strategyIdentity",
      "MISSING_EVIDENCE",
      "the frozen plan's strategy identity is not a SHA-256 digest",
    );
  }
  if (
    isSha256(planIdentity) &&
    isSha256(preflightIdentity) &&
    planIdentity !== preflightIdentity
  ) {
    add(
      "strategyIdentity",
      "MISMATCH",
      "the preflight strategy identity does not match the frozen plan's identity",
    );
  }

  // --- ranking universe -----------------------------------------------------
  const planUniverse = plan?.rankingUniverseSha256 ?? null;
  const preflightUniverse = preflight?.universeSha256 ?? null;

  if (preflight !== null && !isSha256(preflightUniverse)) {
    add(
      "rankingUniverseHash",
      "MISSING_EVIDENCE",
      "the preflight report carries no valid ranking-universe SHA-256",
    );
  }
  if (plan !== null && !isSha256(planUniverse)) {
    add(
      "rankingUniverseHash",
      "MISSING_EVIDENCE",
      "the frozen plan's ranking-universe hash is not a SHA-256 digest",
    );
  }
  if (
    isSha256(planUniverse) &&
    isSha256(preflightUniverse) &&
    planUniverse !== preflightUniverse
  ) {
    add(
      "rankingUniverseHash",
      "MISMATCH",
      "the preflight ranking-universe hash does not match the frozen plan's hash",
    );
  }

  // --- signal date ----------------------------------------------------------
  // A frozen plan without a usable signal date cannot be checked for D/D+1
  // causality at all, so it is withheld rather than displayed.
  //
  // Only the plan persists `signal_date`; neither the run record nor the
  // preflight does. The single cross-document check available is therefore
  // coherence against the cycle that wrote the plan: a plan dated after its own
  // execution is impossible. No agreement between two persisted signal dates is
  // claimed anywhere, because no second document records one.
  if (plan !== null) {
    if (!present(plan.signalDate)) {
      add(
        "signalDate",
        "MISSING_EVIDENCE",
        "the frozen plan does not record the completed session it was built from",
      );
    } else if (!isIsoDate(plan.signalDate)) {
      add(
        "signalDate",
        "MISSING_EVIDENCE",
        "the frozen plan's signal date is not a valid YYYY-MM-DD calendar date",
      );
    } else if (lastRun?.completedAt) {
      const completed = Date.parse(lastRun.completedAt);
      const signal = Date.parse(`${plan.signalDate}T00:00:00Z`);
      if (!Number.isFinite(completed)) {
        add(
          "signalDate",
          "MISSING_EVIDENCE",
          "the executor run record has no parseable completion timestamp to check the plan against",
        );
      } else if (signal > completed) {
        add(
          "signalDate",
          "MISMATCH",
          "the frozen plan's signal date is later than the cycle that produced it",
        );
      }
    }
  }

  if (conflicts.length === 0) return LINEAGE_OK;
  return {
    ok: false,
    // A single genuine disagreement dominates: it is the stronger statement.
    status: conflicts.some((entry) => entry.kind === "MISMATCH")
      ? "MISMATCH"
      : "MISSING_EVIDENCE",
    conflicts,
    detail: conflicts.map((entry) => entry.detail).join("; "),
  };
}
