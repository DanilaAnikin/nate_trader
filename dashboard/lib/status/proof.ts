/**
 * Proofs that can only be minted by looking at the evidence.
 *
 * `AuthorizedExecutionEvidence` requires twenty conditions to be `true`. That
 * closed the gap where a *missing* condition passed silently, but not the one
 * where a condition is simply asserted: two of them — `runtimeArtifactComplete`
 * and `frozenPlanValid` — were passed as the literal `true`, on the reasoning
 * that reaching that branch already established both. The reasoning was
 * correct when it was written and is exactly the kind that rots: if either
 * upstream guard is ever relaxed, the literal keeps saying `true` and no test
 * can tell, because the mutation tests only check that `establish()` rejects a
 * `false` — not that anything ever computes one.
 *
 * So a proof is no longer a boolean. It is a value carrying a module-private
 * symbol, and the only functions that produce one take the parsed documents as
 * arguments. `true` does not type-check, and — because the symbol is not
 * exported and is not `Symbol.for` — it cannot be forged at runtime either.
 *
 * Each proof also carries why it does *not* hold, so a refusal can name the
 * document that failed rather than only the condition.
 */

import type { ValidationInfo, PreflightInfo } from "./types";
import type { LastRunSnapshot, PerformanceRuntimeSnapshot } from "./parse";
import type { PositionsRuntimeSnapshot } from "./positions";
import type { AuthorizationProof } from "./authorization";
import { assessPerformanceCoherence, type CycleContext } from "./coherence";
import { TERMINAL_ACTIONS } from "./actions";
import { isCalendarDate, parseRfc3339 } from "@/lib/calendar-date";

/**
 * Not exported, not `Symbol.for`. A caller outside this module cannot obtain
 * it, so it cannot build something `establish()` will accept.
 */
const PROOF_TAG = Symbol("nate-trader.authorization-proof");

/**
 * Order-attempt statuses that mean the book is still being reconciled.
 *
 * A cancellation in flight is the state the V11 rules single out: new exposure
 * requires a reconciled book, and a plan still carrying one describes a cycle
 * that had not got there.
 */
const CANCELLING_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "pending_cancel",
  "pending_replace",
  "canceled",
  "cancelled",
  "expired",
  "rejected",
  "suspended",
  "stopped",
]);

/**
 * The statuses an ordinary attempt may hold. Deliberately closed: an
 * unrecognised status might be a cancellation this build has not seen, and the
 * safe reading of "might be" is the same as everywhere else here.
 */
const KNOWN_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "new",
  "accepted",
  "pending_new",
  "submitted",
  "partially_filled",
  "filled",
  "done_for_day",
  "calculated",
  "accepted_for_bidding",
  "held",
  "replaced",
  "unknown",
]);

export interface Proof<K extends AuthorizationProof> {
  readonly tag: typeof PROOF_TAG;
  readonly name: K;
  readonly held: boolean;
  /** Why not, when `held` is false. Null when it holds. */
  readonly detail: string | null;
}

/** The only way to make one, and it is private to this module. */
function mint<K extends AuthorizationProof>(
  name: K,
  held: boolean,
  detail: string,
): Proof<K> {
  return { tag: PROOF_TAG, name, held, detail: held ? null : detail };
}

/**
 * Runtime validation for `establish()`. Exported so the authorization module
 * can check the brand without being able to create one.
 */
export function isHeldProof(value: unknown, name: AuthorizationProof): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Proof<AuthorizationProof>>;
  return (
    candidate.tag === PROOF_TAG && candidate.name === name && candidate.held === true
  );
}

/** The unmet proofs in a claim set, for reporting. */
export function unmetProofs(claims: Record<string, unknown>): string[] {
  const unmet: string[] = [];
  for (const value of Object.values(claims)) {
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as Partial<Proof<AuthorizationProof>>;
    if (candidate.tag !== PROOF_TAG) continue;
    if (candidate.held !== true) {
      unmet.push(`${candidate.name}: ${candidate.detail ?? "not established"}`);
    }
  }
  return unmet.sort();
}

/* ------------------------------------------------------------- runtime */

/**
 * The runtime artifact, read whole.
 *
 * "Complete" is no longer "the selector did not error". It is: all three
 * documents parsed, they agree with each other about how many positions the
 * account holds, every position is long, and they were all written in the
 * same cycle.
 */
export function proveRuntimeArtifact(input: {
  readonly lastRun: LastRunSnapshot | null;
  readonly performance: PerformanceRuntimeSnapshot | null;
  readonly positions: PositionsRuntimeSnapshot | null;
}): Proof<"runtimeArtifactComplete"> {
  const { lastRun, performance, positions } = input;
  if (!lastRun) {
    return mint("runtimeArtifactComplete", false, "last_run.json did not parse");
  }
  if (!performance) {
    return mint("runtimeArtifactComplete", false, "performance.json did not parse");
  }
  if (!positions) {
    return mint("runtimeArtifactComplete", false, "positions.json did not parse");
  }
  // Two documents written from one broker snapshot. A disagreement means the
  // artifact is a mixture, and the position count is the one number both
  // state independently.
  if (performance.numPositions !== positions.positions.length) {
    return mint(
      "runtimeArtifactComplete",
      false,
      `performance.num_positions is ${performance.numPositions} but positions.json holds ${positions.positions.length}`,
    );
  }
  // A short is a blocking reconciliation state in V11. An artifact recording
  // one is not evidence that the cycle was free to trade.
  if (!positions.allLong) {
    const shorts = positions.positions
      .filter((position) => position.side === "short")
      .map((position) => position.symbol)
      .join(", ");
    return mint(
      "runtimeArtifactComplete",
      false,
      `the runtime state records a short position (${shorts})`,
    );
  }
  return mint("runtimeArtifactComplete", true, "");
}

/**
 * A frozen plan that is present must be fully valid.
 *
 * `parsePerformanceRuntime` refuses a document whose plan is present and
 * unreadable, so a parsed performance already implies this — which is exactly
 * why it used to be passed as a literal. Deriving it from the parsed
 * performance instead costs nothing and stops being a claim about code that
 * lives somewhere else.
 */
export function proveFrozenPlan(
  performance: PerformanceRuntimeSnapshot | null,
): Proof<"frozenPlanValid"> {
  if (!performance) {
    return mint("frozenPlanValid", false, "no runtime performance state to read a plan from");
  }
  const plan = performance.plan;
  if (plan === null) {
    // Genuinely absent, which is normal between rebalances.
    return mint("frozenPlanValid", true, "");
  }
  if (!isCalendarDate(plan.signalDate)) {
    return mint("frozenPlanValid", false, "the plan's signal date is unreadable");
  }
  if (parseRfc3339(plan.createdAt) === null) {
    return mint("frozenPlanValid", false, "the plan has no usable creation time");
  }
  if (plan.targets.length === 0 && !plan.riskOff) {
    return mint("frozenPlanValid", false, "a risk-on plan holds no targets");
  }
  // An ordinary unfilled order attempt is *normal*: V11 sells, waits for the
  // fill, and defers the replacement buys to a later boundary — that is the
  // whole D+1/D+2 rule, and a plan in that state is valid.
  //
  // What is not normal is a cancellation still in flight. The safety rules
  // require a reconciled order book before new exposure, so a plan carrying
  // one describes a cycle that had not finished reconciling. An attempt whose
  // status this build cannot classify is treated the same way, for the same
  // reason every other unknown here is: it might be one.
  for (const action of plan.pendingActions) {
    const status = action.status.toLowerCase();
    if (CANCELLING_ORDER_STATUSES.has(status)) {
      return mint(
        "frozenPlanValid",
        false,
        `the plan carries an order attempt in "${status}", so the book was still being reconciled`,
      );
    }
    if (!KNOWN_ORDER_STATUSES.has(status)) {
      return mint(
        "frozenPlanValid",
        false,
        `the plan carries an order attempt in "${status}", which this build does not classify`,
      );
    }
  }
  return mint("frozenPlanValid", true, "");
}

/**
 * The executor's own record of the cycle.
 *
 * `passWorthy` already folds in the blocking counts, the terminal proof and
 * the unclassified names. Two things are added here that it cannot see.
 */
export function proveExecutionRecord(input: {
  readonly lastRun: LastRunSnapshot | null;
  readonly performance: PerformanceRuntimeSnapshot | null;
}): {
  readonly lastRunStatusPass: Proof<"lastRunStatusPass">;
  readonly marketEntryAllowed: Proof<"marketEntryAllowed">;
  readonly noBlockingOrUnclassifiedAction: Proof<"noBlockingOrUnclassifiedAction">;
  readonly riskTierAgrees: Proof<"riskTierAgrees">;
} {
  const { lastRun, performance } = input;
  if (!lastRun) {
    const absent = "no executor record";
    return {
      lastRunStatusPass: mint("lastRunStatusPass", false, absent),
      marketEntryAllowed: mint("marketEntryAllowed", false, absent),
      noBlockingOrUnclassifiedAction: mint(
        "noBlockingOrUnclassifiedAction",
        false,
        absent,
      ),
      riskTierAgrees: mint("riskTierAgrees", false, absent),
    };
  }

  // A deferred infrastructure cancellation *is* a terminal action — the cycle
  // reached its own end — but what it says it reached the end of is a
  // cancellation it could not complete. It ends a cycle; it does not authorize
  // the next one.
  const deferredCancellation =
    (lastRun.actionCounts.ADAPTIVE_DEFERRED_INFRASTRUCTURE_CANCELLATION ?? 0) > 0;
  const pendingCancellation = Object.entries(lastRun.actionCounts).some(
    ([action, count]) => count > 0 && action.includes("PENDING_CANCELLATION"),
  );
  const blocking = lastRun.blockingActions.length > 0 || !lastRun.passWorthy;
  const nonAuthorizing = deferredCancellation || pendingCancellation;

  return {
    lastRunStatusPass: mint(
      "lastRunStatusPass",
      lastRun.status === "PASS",
      `the executor recorded ${lastRun.status}`,
    ),
    marketEntryAllowed: mint(
      "marketEntryAllowed",
      lastRun.marketEntryAllowed === true,
      "the executor did not record market_entry_allowed = true",
    ),
    noBlockingOrUnclassifiedAction: mint(
      "noBlockingOrUnclassifiedAction",
      !blocking && !nonAuthorizing,
      blocking
        ? `the record is blocked or self-contradictory (${lastRun.contradictions.join(", ") || lastRun.blockingActionNames.join(", ")})`
        : deferredCancellation
          ? "the cycle ended on a deferred infrastructure cancellation, which completes a cycle without authorizing the next"
          : "the cycle left a cancellation pending",
    ),
    riskTierAgrees: proveRiskTierAgreement(lastRun, performance),
  };
}

/**
 * The two documents must agree about what tier the account is in.
 *
 * They are written from one snapshot seconds apart, so a disagreement is not a
 * race — it is two different cycles in one artifact. It matters in both
 * directions and the dangerous one is not obvious: `last_run` saying `NORMAL`
 * beside a `performance` saying `HALT` is the artifact that authorizes a buy
 * on an account the risk policy has halted.
 */
function proveRiskTierAgreement(
  lastRun: LastRunSnapshot,
  performance: PerformanceRuntimeSnapshot | null,
): Proof<"riskTierAgrees"> {
  if (!performance) {
    return mint("riskTierAgrees", false, "no runtime performance state to compare against");
  }
  if (lastRun.riskTier === null || performance.riskTier === null) {
    return mint("riskTierAgrees", false, "one of the documents states no risk tier");
  }
  if (lastRun.riskTier !== performance.riskTier) {
    return mint(
      "riskTierAgrees",
      false,
      `last_run says ${lastRun.riskTier} and performance says ${performance.riskTier}`,
    );
  }
  // Agreement is necessary but not sufficient: HALT exits directional
  // exposure on every cycle, so a HALT artifact never authorizes a buy however
  // consistent it is with itself.
  if (lastRun.riskTier === "HALT") {
    return mint("riskTierAgrees", false, "the account is in the HALT tier");
  }
  return mint("riskTierAgrees", true, "");
}

/** Performance placed in its cycle, from the documents and the step window. */
export function provePerformanceCoherence(
  performance: PerformanceRuntimeSnapshot | null,
  context: CycleContext,
): {
  readonly performanceCurrentAndConsistent: Proof<"performanceCurrentAndConsistent">;
  readonly cycleTimestampsExact: Proof<"cycleTimestampsExact">;
} {
  if (!performance) {
    return {
      performanceCurrentAndConsistent: mint(
        "performanceCurrentAndConsistent",
        false,
        "no runtime performance state",
      ),
      cycleTimestampsExact: mint("cycleTimestampsExact", false, "no runtime performance state"),
    };
  }
  const problems = assessPerformanceCoherence(performance, context);
  const timing = problems.filter(
    (problem) =>
      problem === "PERFORMANCE_OUTSIDE_STEP_WINDOW" ||
      problem === "EXECUTE_STEP_WINDOW_UNKNOWN" ||
      problem === "PERFORMANCE_AFTER_RUN",
  );
  return {
    performanceCurrentAndConsistent: mint(
      "performanceCurrentAndConsistent",
      problems.length === 0,
      problems.join(", ") || "not coherent",
    ),
    cycleTimestampsExact: mint(
      "cycleTimestampsExact",
      timing.length === 0,
      timing.join(", ") || "the cycle could not be placed in time",
    ),
  };
}

/** Positions and performance must be the same cycle's, too. */
export function provePositionsInCycle(
  positions: PositionsRuntimeSnapshot | null,
  performance: PerformanceRuntimeSnapshot | null,
  toleranceMs: number,
): Proof<"positionsInCycle"> {
  if (!positions || !performance) {
    return mint("positionsInCycle", false, "a runtime document is missing");
  }
  const a = parseRfc3339(positions.updatedAt);
  const b = parseRfc3339(performance.updatedAt);
  if (a === null || b === null) {
    return mint("positionsInCycle", false, "a runtime timestamp is unreadable");
  }
  return mint(
    "positionsInCycle",
    Math.abs(a - b) <= toleranceMs,
    "positions.json and performance.json are stamped in different cycles",
  );
}

/* ---------------------------------------------------- run and lineage */

export function proveRun(
  runId: number | null,
  attempt: number | null,
): {
  readonly runIdentified: Proof<"runIdentified">;
  readonly attemptIdentified: Proof<"attemptIdentified">;
} {
  return {
    runIdentified: mint(
      "runIdentified",
      typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0,
      "no workflow run backs the runtime state",
    ),
    attemptIdentified: mint(
      "attemptIdentified",
      typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt > 0,
      "the run's attempt is unknown",
    ),
  };
}

/**
 * Lineage.
 *
 * This used to be `lineageOk?: boolean` with `!== false` as the test, so a
 * caller that forgot the field got the answer "consistent" — an optional
 * safety condition defaulting to safe. It is required now, and the proof is
 * derived from the verdict rather than from its absence.
 */
export function proveLineage(lineageOk: boolean): Proof<"lineageConsistent"> {
  return mint(
    "lineageConsistent",
    lineageOk,
    "the preflight, frozen plan and executor record do not agree",
  );
}

/* ------------------------------------------------------------- report */

const SHA256_RE = /^[0-9a-f]{64}$/;

export function proveCanonicalReport(input: {
  readonly report: ValidationInfo;
  readonly paperEligibleMode: string;
  readonly approvedReleaseSha: string | null;
  readonly approvedReleaseAuthoritative: boolean;
  readonly now: Date;
}): Record<string, Proof<AuthorizationProof>> {
  const { report, now } = input;
  const nowMs = now.getTime();
  const generatedAtMs = parseRfc3339(report.generatedAt);
  const boundaryMs = isCalendarDate(report.barBoundaryDate)
    ? Date.parse(`${report.barBoundaryDate}T00:00:00Z`)
    : Number.NaN;
  const expiresAtMs = parseRfc3339(report.expiresAt);

  return {
    approvedReleaseAuthoritative: mint(
      "approvedReleaseAuthoritative",
      Boolean(input.approvedReleaseSha && input.approvedReleaseAuthoritative),
      "the approved paper release is unknown or not authoritative",
    ),
    canonicalReportPass: mint(
      "canonicalReportPass",
      report.status === "PASS",
      `the stored assessment is ${report.status}`,
    ),
    canonicalReportPaperEligible: mint(
      "canonicalReportPaperEligible",
      report.allowedMode === input.paperEligibleMode,
      `allowed_mode is ${report.allowedMode ?? "absent"}`,
    ),
    canonicalReportContractIntact: mint(
      "canonicalReportContractIntact",
      report.contractSchemaVersion === 1 &&
        report.contractAlgorithm === "sha256" &&
        SHA256_RE.test(report.reportSha256 ?? ""),
      "the whole-report contract digest is missing or malformed",
    ),
    canonicalReportEvidenceComplete: mint(
      "canonicalReportEvidenceComplete",
      SHA256_RE.test(report.strategyIdentityValue ?? "") &&
        SHA256_RE.test(report.rankingUniverseSha256 ?? "") &&
        SHA256_RE.test(report.barSnapshotSha256 ?? ""),
      "a mandatory evidence hash is missing",
    ),
    canonicalReportChecksCounted: mint(
      "canonicalReportChecksCounted",
      report.checksEvaluated !== null &&
        report.checksEvaluated > 0 &&
        report.checksPassed !== null &&
        report.checksPassed > 0 &&
        report.checksPassed === report.checksEvaluated,
      "the report's check counts are absent, zero or unequal",
    ),
    canonicalReportFresh: mint(
      "canonicalReportFresh",
      generatedAtMs !== null &&
        generatedAtMs <= nowMs &&
        Number.isFinite(boundaryMs) &&
        boundaryMs <= nowMs &&
        expiresAtMs !== null &&
        nowMs <= expiresAtMs,
      "the report is undated, future-dated or past its freshness deadline",
    ),
    canonicalReportBoundToRuntime: mint(
      "canonicalReportBoundToRuntime",
      report.identityMatchesRuntime === "PASS" &&
        report.universeMatchesRuntime === "PASS",
      "the report's strategy identity or ranking universe does not match the runtime",
    ),
  };
}

export function provePreflightContract(input: {
  readonly preflight: PreflightInfo | null;
  readonly preflightProblems: readonly string[];
  readonly preflightRunId: number | null;
  readonly preflightAttempt: number | null;
  readonly executionRunId: number | null;
  readonly executionAttempt: number | null;
}): {
  readonly preflightContractComplete: Proof<"preflightContractComplete">;
  readonly preflightCycleExact: Proof<"preflightCycleExact">;
} {
  const complete =
    input.preflight !== null && input.preflightProblems.length === 0;
  const cycleExact =
    input.preflight !== null &&
    input.preflightRunId !== null &&
    input.executionRunId !== null &&
    input.preflightRunId === input.executionRunId &&
    input.preflightAttempt !== null &&
    input.executionAttempt !== null &&
    input.preflightAttempt === input.executionAttempt;
  return {
    preflightContractComplete: mint(
      "preflightContractComplete",
      complete,
      input.preflight === null
        ? "no production preflight report is available"
        : input.preflightProblems.join(", "),
    ),
    preflightCycleExact: mint(
      "preflightCycleExact",
      cycleExact,
      "the preflight is from a different run or attempt than the runtime state",
    ),
  };
}

/** Every terminal action this build recognises, for the tests to pin. */
export const TERMINAL_ACTION_NAMES = TERMINAL_ACTIONS;

/* -------------------------------------------------------- the whole set */

/** Everything the twenty-two proofs are derived from. Nothing is optional. */
export interface AuthorizationEvidence {
  readonly report: ValidationInfo;
  readonly paperEligibleMode: string;
  readonly approvedReleaseSha: string | null;
  readonly approvedReleaseAuthoritative: boolean;
  /**
   * Required, not optional. It used to be `lineageOk?: boolean` tested with
   * `!== false`, so a caller that forgot the field got "consistent" — a safety
   * condition whose default was safe.
   */
  readonly lineageOk: boolean;
  readonly preflight: PreflightInfo | null;
  readonly preflightProblems: readonly string[];
  readonly preflightRunId: number | null;
  readonly preflightAttempt: number | null;
  readonly executionRunId: number | null;
  readonly executionAttempt: number | null;
  readonly lastRun: LastRunSnapshot | null;
  readonly performance: PerformanceRuntimeSnapshot | null;
  readonly positions: PositionsRuntimeSnapshot | null;
  readonly cycle: CycleContext;
  readonly sameCycleToleranceMs: number;
  readonly now: Date;
}

/**
 * Derive every proof from the documents, in one place.
 *
 * The gate and the tests both go through here, so there is no path that
 * assembles a claim set by hand — which is how two literals got in.
 */
export function deriveAuthorizationClaims(
  evidence: AuthorizationEvidence,
): Record<string, unknown> {
  const run = proveRun(evidence.executionRunId, evidence.executionAttempt);
  const record = proveExecutionRecord({
    lastRun: evidence.lastRun,
    performance: evidence.performance,
  });
  const coherence = provePerformanceCoherence(evidence.performance, evidence.cycle);
  const preflight = provePreflightContract(evidence);

  return {
    runId: evidence.executionRunId ?? 0,
    attempt: evidence.executionAttempt ?? 0,
    ...proveCanonicalReport(evidence),
    ...preflight,
    lineageConsistent: proveLineage(evidence.lineageOk),
    ...run,
    runtimeArtifactComplete: proveRuntimeArtifact({
      lastRun: evidence.lastRun,
      performance: evidence.performance,
      positions: evidence.positions,
    }),
    ...record,
    ...coherence,
    frozenPlanValid: proveFrozenPlan(evidence.performance),
    positionsInCycle: provePositionsInCycle(
      evidence.positions,
      evidence.performance,
      evidence.sameCycleToleranceMs,
    ),
  };
}
