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
 * disagrees, every dependent section is withheld — strategy, universe,
 * preflight, execution and convergence become null/MISMATCH and the effective
 * validation gate cannot be PASS.
 */

import type { LastRunSnapshot, PerformanceRuntimeSnapshot } from "./parse";
import type { PreflightInfo } from "./types";

export const V11_STRATEGY_VERSION = "v11-adaptive-momentum";

export type LineageField =
  | "approvedReleaseSha"
  | "strategyIdentity"
  | "strategyVersion"
  | "rankingUniverseHash"
  | "signalDate";

export interface LineageConflict {
  readonly field: LineageField;
  readonly detail: string;
}

export interface LineageVerdict {
  readonly ok: boolean;
  readonly conflicts: readonly LineageConflict[];
  /** Human-readable summary, safe to show in provenance. */
  readonly detail: string | null;
}

export const LINEAGE_OK: LineageVerdict = {
  ok: true,
  conflicts: [],
  detail: null,
};

function conflict(field: LineageField, detail: string): LineageConflict {
  return { field, detail };
}

/**
 * Cross-check every mandatory lineage field across the selected documents.
 *
 * Missing documents are *not* a conflict — that is an availability problem the
 * caller reports as UNAVAILABLE. Only genuine disagreement between two present
 * values is a MISMATCH.
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
  const plan = input.performance?.plan ?? null;

  // --- approved release -----------------------------------------------------
  if (
    input.runtimeArtifactName !== null &&
    input.expectedRuntimeArtifactName !== null &&
    input.runtimeArtifactName !== input.expectedRuntimeArtifactName
  ) {
    conflicts.push(
      conflict(
        "approvedReleaseSha",
        "the runtime artifact is not named for the approved paper release",
      ),
    );
  }
  if (
    input.approvedReleaseSha !== null &&
    input.lastRun?.releaseSha != null &&
    input.lastRun.releaseSha !== input.approvedReleaseSha
  ) {
    conflicts.push(
      conflict(
        "approvedReleaseSha",
        "the executor run record names a different release than the approved paper release",
      ),
    );
  }

  // --- strategy version -----------------------------------------------------
  if (
    input.lastRun !== null &&
    input.lastRun.strategyVersion !== V11_STRATEGY_VERSION
  ) {
    conflicts.push(
      conflict(
        "strategyVersion",
        `the executor run record reports strategy version ${input.lastRun.strategyVersion}, not ${V11_STRATEGY_VERSION}`,
      ),
    );
  }

  // --- strategy identity ----------------------------------------------------
  const planIdentity = plan?.strategyIdentityValue ?? null;
  const preflightIdentity = input.preflight?.strategyIdentity ?? null;
  if (
    planIdentity !== null &&
    preflightIdentity !== null &&
    planIdentity !== preflightIdentity
  ) {
    conflicts.push(
      conflict(
        "strategyIdentity",
        "the preflight strategy identity does not match the frozen plan's identity",
      ),
    );
  }

  // --- ranking universe -----------------------------------------------------
  const planUniverse = plan?.rankingUniverseSha256 ?? null;
  const preflightUniverse = input.preflight?.universeSha256 ?? null;
  if (
    planUniverse !== null &&
    preflightUniverse !== null &&
    planUniverse !== preflightUniverse
  ) {
    conflicts.push(
      conflict(
        "rankingUniverseHash",
        "the preflight ranking-universe hash does not match the frozen plan's hash",
      ),
    );
  }

  // --- signal date ----------------------------------------------------------
  // The plan's signal date must be a completed session no later than the run
  // that produced it; a plan dated after its own execution is incoherent.
  if (plan?.signalDate && input.lastRun?.completedAt) {
    const signal = Date.parse(`${plan.signalDate}T00:00:00Z`);
    const completed = Date.parse(input.lastRun.completedAt);
    if (
      Number.isFinite(signal) &&
      Number.isFinite(completed) &&
      signal > completed
    ) {
      conflicts.push(
        conflict(
          "signalDate",
          "the frozen plan's signal date is later than the cycle that produced it",
        ),
      );
    }
  }

  if (conflicts.length === 0) return LINEAGE_OK;
  return {
    ok: false,
    conflicts,
    detail: conflicts.map((entry) => entry.detail).join("; "),
  };
}
