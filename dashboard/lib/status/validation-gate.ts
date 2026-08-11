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
import { isCalendarDate, parseRfc3339 } from "@/lib/calendar-date";
import { AuthorizedExecutionEvidence } from "./authorization";

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
  | "EXECUTION_UNAVAILABLE"
  | "EXECUTION_STATUS_NOT_PASS"
  | "MARKET_ENTRY_NOT_ALLOWED"
  | "EXECUTION_BLOCKED"
  | "EXECUTION_SELF_CONTRADICTORY"
  | "PERFORMANCE_CYCLE_MISMATCH"
  | "PERFORMANCE_INCOHERENT"
  | "INVALID_FROZEN_PLAN"
  | "RUNTIME_SCHEMA_INVALID"
  | "AUTHORIZATION_NOT_ESTABLISHED"
  | "PREFLIGHT_UNAVAILABLE"
  | "PREFLIGHT_GATE_MISSING"
  | "PREFLIGHT_GATE_FAILED"
  | "PREFLIGHT_GATE_AMBIGUOUS"
  | "PREFLIGHT_CYCLE_MISMATCH"
  | "PREFLIGHT_NOT_PASS"
  | "PREFLIGHT_CHECK_MISSING"
  | "PREFLIGHT_CONTRACT_DRIFT"
  | "PREFLIGHT_DUPLICATE_CHECK"
  | "PREFLIGHT_COUNTS_INCONSISTENT"
  | "PREFLIGHT_CHECKED_AT_INVALID"
  | "PREFLIGHT_STALE"
  | "PREFLIGHT_MODE_NOT_PAPER";

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

/**
 * The complete production preflight contract: every check
 * `scripts/production_preflight.py` emits, exactly once each, and nothing else.
 *
 * Transcribed from the real PASS artifact of paper-production run
 * `31407157501` (`paper-diagnostics/production-preflight.json`, 18 checks,
 * 18 passed).
 *
 * This list used to hold five names — the ones the dashboard reasons about
 * explicitly. That was a hole, not an economy: a report carrying only those
 * five, all passing, with `status: PASS` and `checks_passed == checks_evaluated
 * == 5`, satisfied every condition and lit the gate green. But a preflight that
 * never checked the paper endpoint, the account status, the broker clock, the
 * short positions or the open-order snapshot has not established that a buy is
 * safe; it has only established the handful of things the dashboard happens to
 * name. Authorization must require the *whole* contract, so a truncated,
 * downgraded or forked runner fails closed instead of passing on a subset.
 *
 * The set is matched exactly. A missing name is `PREFLIGHT_CHECK_MISSING`; an
 * unrecognised one is `PREFLIGHT_CONTRACT_DRIFT`, because a runner emitting a
 * check this build has never seen is a runner this build cannot vouch for.
 */
export const MANDATORY_PREFLIGHT_CHECKS = [
  "trading_mode",
  "alpaca_api_key",
  "alpaca_secret_key",
  "python_runtime",
  "dependency_lock",
  "runtime_alpaca-py",
  "runtime_numpy",
  "runtime_pandas",
  "frozen_v11_policy",
  PYTHON_GATE_CHECK,
  "strategy_identity",
  "ranking_universe",
  "paper_endpoint",
  "paper_account",
  "broker_clock",
  "no_short_positions",
  "open_order_snapshot",
  "fresh_risk_snapshot",
] as const;

const MANDATORY_PREFLIGHT_CHECK_SET: ReadonlySet<string> = new Set(
  MANDATORY_PREFLIGHT_CHECKS,
);

/**
 * How old a preflight may be and still authorize a buy.
 *
 * It describes one cycle's broker and market state — open orders, shorts, the
 * clock, the risk snapshot. Past the runtime freshness contract it is history,
 * not authorization.
 */
export const PREFLIGHT_MAX_AGE_SECONDS = 36 * 60 * 60;

/** The shared allowance for a timestamp ahead of this server's clock. */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

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
  EXECUTION_UNAVAILABLE:
    "No usable executor runtime state is available, so nothing establishes that the approved release actually ran. A preflight describes what a cycle intended to do; only the runtime artifact records what it did.",
  EXECUTION_STATUS_NOT_PASS:
    "The executor recorded a status other than PASS for its last cycle. A readable runtime artifact is not a successful one.",
  MARKET_ENTRY_NOT_ALLOWED:
    "The executor recorded market_entry_allowed = false for its last cycle. That is the runner's own answer to \"may this cycle buy\", and it is no.",
  EXECUTION_BLOCKED:
    "The executor recorded a blocking action for its last cycle — a short, an unreconciled order or a failed check — so it was not free to trade.",
  EXECUTION_SELF_CONTRADICTORY:
    "The executor's own record disagrees with itself: its action counts contain an abort, an error, a disabled sleeve or a name this build cannot classify, whatever status line the producer wrote above them.",
  PERFORMANCE_INCOHERENT:
    "performance.json is not internally consistent — an empty or future-dated history, a last row that disagrees with the scalar equity, or a timestamp outside the execute step that produced it.",
  AUTHORIZATION_NOT_ESTABLISHED:
    "Not every mandatory proof of authorization could be established. A pass is built from the complete proof set, never from the absence of objections.",
  PERFORMANCE_CYCLE_MISMATCH:
    "The runtime artifact's performance.json and last_run.json describe different moments, so the artifact is a mixture and the equity shown is not the equity the recorded cycle ended with.",
  INVALID_FROZEN_PLAN:
    "The runtime state carries an adaptive_rebalance_pending that cannot be read. A plan that is present must be usable; only a genuinely absent one is normal between rebalances.",
  RUNTIME_SCHEMA_INVALID:
    "A runtime document failed schema validation, so nothing in it can be relied on.",
  PREFLIGHT_UNAVAILABLE:
    "No production preflight report is available, so the executor's own validation gate result is unknown.",
  PREFLIGHT_GATE_MISSING: `The preflight report does not contain the ${PYTHON_GATE_CHECK} check, so the executor's gate result was never captured.`,
  PREFLIGHT_GATE_FAILED:
    "The executor's own canonical validation gate failed in production, whatever the stored report says.",
  PREFLIGHT_CYCLE_MISMATCH:
    "The available preflight is from a different cycle than the runtime state on screen, so its gate result does not authorize this state.",
  PREFLIGHT_GATE_AMBIGUOUS: `The preflight report contains more than one ${PYTHON_GATE_CHECK} check, so it does not state a single verdict.`,
  PREFLIGHT_NOT_PASS:
    "The production preflight itself did not pass, so nothing it reports authorizes a buy.",
  PREFLIGHT_CHECK_MISSING: `The preflight report does not contain all ${MANDATORY_PREFLIGHT_CHECKS.length} checks of the production preflight contract.`,
  PREFLIGHT_CONTRACT_DRIFT:
    "The preflight report contains a check this build does not recognise, so the runner it came from is not the one this gate was written against.",
  PREFLIGHT_DUPLICATE_CHECK:
    "The preflight report contains a repeated check name, so its results are ambiguous.",
  PREFLIGHT_COUNTS_INCONSISTENT:
    "The preflight's own summary counts disagree with the checks it actually recorded.",
  PREFLIGHT_CHECKED_AT_INVALID:
    "The preflight has no usable timestamp, or claims to have run in the future.",
  PREFLIGHT_STALE:
    "The preflight is older than its freshness contract; it describes a market and broker state that has moved on.",
  PREFLIGHT_MODE_NOT_PAPER:
    "The preflight did not authorize paper execution; its allowed_mode is not \"paper\".",
};

/**
 * Everything the preflight itself must satisfy before its captured Python
 * verdict counts for anything.
 *
 * A summary line is not evidence. `status: PASS` with 17 of 18 checks passing,
 * a repeated check name, a count that does not match the recorded checks, or
 * two contradictory `canonical_validation_gate` entries all describe a report
 * that cannot be reduced to one answer — so none of them may produce one.
 */
function preflightReasons(
  preflight: PreflightInfo,
  now: Date,
): ValidationGateReason[] {
  const reasons: ValidationGateReason[] = [];

  if (preflight.status !== "PASS") reasons.push("PREFLIGHT_NOT_PASS");

  // The runner's own verdict on whether this cycle may execute. `no-execution`
  // is what it writes when anything refused, and the status alone is not a
  // substitute: both are stated, so both are required.
  if (preflight.allowedMode !== "paper") reasons.push("PREFLIGHT_MODE_NOT_PAPER");

  const byName = new Map<string, { passed: boolean }[]>();
  for (const check of preflight.checks) {
    const bucket = byName.get(check.name) ?? [];
    bucket.push({ passed: check.passed });
    byName.set(check.name, bucket);
  }
  if ([...byName.values()].some((entries) => entries.length > 1)) {
    reasons.push("PREFLIGHT_DUPLICATE_CHECK");
  }

  // The whole contract, exactly. Both directions matter: a subset is an
  // authorization built on checks that never ran, and a superset is a runner
  // this build has not been reconciled against.
  if (MANDATORY_PREFLIGHT_CHECKS.some((required) => !byName.has(required))) {
    reasons.push("PREFLIGHT_CHECK_MISSING");
  }
  if ([...byName.keys()].some((name) => !MANDATORY_PREFLIGHT_CHECK_SET.has(name))) {
    reasons.push("PREFLIGHT_CONTRACT_DRIFT");
  }

  // The Python verdict specifically must be one entry saying one thing.
  const gateEntries = byName.get(PYTHON_GATE_CHECK) ?? [];
  if (gateEntries.length === 0) {
    reasons.push("PREFLIGHT_GATE_MISSING");
  } else if (gateEntries.length > 1) {
    reasons.push("PREFLIGHT_GATE_AMBIGUOUS");
  } else if (!gateEntries[0].passed) {
    reasons.push("PREFLIGHT_GATE_FAILED");
  }

  // The summary must describe the checks that are actually there. A report
  // claiming 18/18 while carrying one failure is the case this catches.
  const recorded = preflight.checks.length;
  const actuallyPassed = preflight.checks.filter((check) => check.passed).length;
  if (
    preflight.checksEvaluated <= 0 ||
    preflight.checksEvaluated !== recorded ||
    preflight.checksPassed !== actuallyPassed ||
    preflight.checksPassed !== preflight.checksEvaluated
  ) {
    reasons.push("PREFLIGHT_COUNTS_INCONSISTENT");
  }

  const checkedAtMs = parseRfc3339(preflight.checkedAt);
  if (checkedAtMs === null) {
    reasons.push("PREFLIGHT_CHECKED_AT_INVALID");
  } else if (checkedAtMs - now.getTime() > CLOCK_SKEW_TOLERANCE_MS) {
    reasons.push("PREFLIGHT_CHECKED_AT_INVALID");
  } else {
    const ageSeconds = (now.getTime() - checkedAtMs) / 1000;
    if (ageSeconds > PREFLIGHT_MAX_AGE_SECONDS) reasons.push("PREFLIGHT_STALE");
  }

  return reasons;
}

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
  /**
   * Attempt of that run. A re-run keeps the run id and increments the attempt,
   * and its preflight describes a different execution of the same workflow.
   */
  preflightAttempt?: number | null;
  /**
   * The cycle the **runtime state** came from — and *only* when that state
   * was read, parsed and lineage-checked successfully.
   *
   * This used to be filled from the selector's run metadata, which is
   * populated even when the selection failed: the selector returns the run it
   * was looking at alongside the reason it could not use it. So a run whose
   * runtime artifact was missing, expired, oversized, undownloadable, corrupt
   * or schema-invalid still supplied a run id here, the cycle check saw the
   * preflight and the "execution" naming the same run, and a genuine 18/18
   * preflight took the gate green with no execution evidence at all.
   *
   * Null now means exactly one thing: there is no execution to authorize.
   */
  executionEvidence?: {
    readonly runId: number;
    readonly attempt: number;
    /**
     * What the cycle actually *recorded*, not merely that it was readable.
     *
     * Everything above this line establishes that the evidence documents can
     * be parsed and belong together. None of it reads what they say — so a
     * cycle that ran, wrote a perfectly well-formed runtime artifact, and
     * recorded `status: "FAIL"` with `market_entry_allowed: false` satisfied
     * every condition and took the gate green.
     */
    readonly status: "PASS" | "FAIL" | "DEGRADED";
    readonly marketEntryAllowed: boolean | null;
    readonly blockingActionCount: number;
    /**
     * True when the runtime artifact was downloaded and *every* document in it
     * parsed. A partially readable artifact is not a cycle record.
     */
    readonly runtimeComplete: boolean;
    /**
     * True when `last_run.json` does not contradict itself: no abort or error
     * count, no disabled sleeve, no unclassified action name, and exactly one
     * terminal completion. The producer's own `status` line is a claim; this
     * is what its counts say.
     */
    readonly selfConsistent: boolean;
    /** True when `performance.json` and `last_run.json` describe one moment. */
    readonly performanceInCycle: boolean;
    /**
     * True when `performance.json` is internally coherent: a non-empty
     * history, no future date, the last row's equity agreeing with the scalar
     * equity, and a timestamp inside the step window that wrote it.
     */
    readonly performanceCoherent: boolean;
    /** True when any `adaptive_rebalance_pending` present is fully valid. */
    readonly frozenPlanValid: boolean;
  } | null;
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
  const execution = input.executionEvidence ?? null;
  if (!execution) {
    reasons.push("EXECUTION_UNAVAILABLE");
  } else {
    if (!execution.runtimeComplete) reasons.push("RUNTIME_SCHEMA_INVALID");
    // What the cycle recorded. A readable artifact is not a successful one.
    if (execution.status !== "PASS") reasons.push("EXECUTION_STATUS_NOT_PASS");
    // `true` and nothing else. `null`, absent, `"yes"` and `1` are all "this
    // build cannot tell", and the safe reading of that is no.
    if (execution.marketEntryAllowed !== true) {
      reasons.push("MARKET_ENTRY_NOT_ALLOWED");
    }
    if (execution.blockingActionCount > 0) reasons.push("EXECUTION_BLOCKED");
    // The producer has been wrong about its own blockers before: it matched
    // only the exact strings `ABORT` and `ERROR` while the executor emits
    // `ABORT_SHORT_RECONCILIATION` and four other suffixed names. So the
    // counts are read here too, independently of what the summary claimed.
    if (!execution.selfConsistent) reasons.push("EXECUTION_SELF_CONTRADICTORY");
    if (!execution.performanceInCycle) reasons.push("PERFORMANCE_CYCLE_MISMATCH");
    if (!execution.performanceCoherent) reasons.push("PERFORMANCE_INCOHERENT");
    if (!execution.frozenPlanValid) reasons.push("INVALID_FROZEN_PLAN");
  }

  const preflight = input.preflight ?? null;
  if (!preflight) {
    reasons.push("PREFLIGHT_UNAVAILABLE");
  } else {
    reasons.push(...preflightReasons(preflight, now));
    // A preflight from a different cycle answered a different question. The
    // read model deliberately lets a newer preflight sit beside an older
    // execution for *display*; it must not silently authorize it.
    if (
      input.preflightRunId == null ||
      execution == null ||
      input.preflightRunId !== execution.runId ||
      // A re-run keeps the id, so the attempt is part of the cycle's identity.
      input.preflightAttempt == null ||
      input.preflightAttempt !== execution.attempt
    ) {
      reasons.push("PREFLIGHT_CYCLE_MISMATCH");
    }
  }

  const nowMs = now.getTime();
  // Strict RFC 3339 throughout. `Date.parse` accepts implementation-defined
  // junk — "2026" and "Aug 7 2026" both produce a number — and every one of
  // these values comes from a file this process did not write.
  const generatedAtMs = parseRfc3339(report.generatedAt);
  if (generatedAtMs === null) {
    reasons.push("MISSING_GENERATED_AT");
  } else if (generatedAtMs > nowMs) {
    reasons.push("FUTURE_DATED");
  }

  const boundaryMs = isCalendarDate(report.barBoundaryDate)
    ? Date.parse(`${report.barBoundaryDate}T00:00:00Z`)
    : NaN;
  if (!Number.isFinite(boundaryMs)) {
    reasons.push("MISSING_BAR_BOUNDARY");
  } else if (boundaryMs > nowMs) {
    reasons.push("FUTURE_DATED");
  }

  const expiresAtMs = parseRfc3339(report.expiresAt);
  if (expiresAtMs === null) {
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

  // ------------------------------------------------------------------------
  // The positive object.
  //
  // Everything above collects *objections*, which is the right thing to show
  // an operator and the wrong thing to authorize on: an empty objection list
  // is also what a condition that forgot to speak produces. So the pass is
  // built here instead, from proofs that each had to be established.
  //
  // The two are cross-checked below: an objection with no corresponding
  // missing proof, or a complete proof set alongside an objection, means this
  // function contradicts itself, and a contradiction is never a pass.
  const preflightOk = preflight !== null && preflightReasons(preflight, now).length === 0;
  const evidence = AuthorizedExecutionEvidence.establish({
    runId: execution?.runId ?? 0,
    attempt: execution?.attempt ?? 0,
    approvedReleaseAuthoritative: Boolean(
      input.approvedReleaseSha && input.approvedReleaseAuthoritative,
    ),
    canonicalReportPass: report.status === "PASS",
    canonicalReportPaperEligible: report.allowedMode === PAPER_ELIGIBLE_MODE,
    canonicalReportContractIntact:
      report.contractSchemaVersion === 1 &&
      report.contractAlgorithm === "sha256" &&
      SHA256_RE.test(report.reportSha256 ?? ""),
    canonicalReportEvidenceComplete:
      SHA256_RE.test(report.strategyIdentityValue ?? "") &&
      SHA256_RE.test(report.rankingUniverseSha256 ?? "") &&
      SHA256_RE.test(report.barSnapshotSha256 ?? ""),
    canonicalReportChecksCounted:
      report.checksEvaluated !== null &&
      report.checksEvaluated > 0 &&
      report.checksPassed !== null &&
      report.checksPassed > 0 &&
      report.checksPassed === report.checksEvaluated,
    canonicalReportFresh:
      generatedAtMs !== null &&
      generatedAtMs <= nowMs &&
      Number.isFinite(boundaryMs) &&
      boundaryMs <= nowMs &&
      expiresAtMs !== null &&
      nowMs <= expiresAtMs,
    canonicalReportBoundToRuntime:
      report.identityMatchesRuntime === "PASS" &&
      report.universeMatchesRuntime === "PASS",
    preflightContractComplete: preflightOk,
    preflightCycleExact:
      preflight !== null &&
      execution !== null &&
      input.preflightRunId != null &&
      input.preflightRunId === execution.runId &&
      input.preflightAttempt != null &&
      input.preflightAttempt === execution.attempt,
    lineageConsistent: input.lineageOk !== false,
    runIdentified: execution !== null && execution.runId > 0,
    attemptIdentified: execution !== null && execution.attempt > 0,
    runtimeArtifactComplete: execution !== null && execution.runtimeComplete,
    lastRunStatusPass: execution !== null && execution.status === "PASS",
    marketEntryAllowed: execution !== null && execution.marketEntryAllowed === true,
    noBlockingOrUnclassifiedAction:
      execution !== null &&
      execution.blockingActionCount === 0 &&
      execution.selfConsistent,
    performanceCurrentAndConsistent:
      execution !== null && execution.performanceCoherent,
    frozenPlanValid: execution !== null && execution.frozenPlanValid,
    cycleTimestampsExact: execution !== null && execution.performanceInCycle,
  });

  if (evidence === null && reasons.length === 0) {
    // A proof failed that nothing objected to. That is the exact gap the
    // positive object exists to close, and it must never resolve to a pass.
    reasons.push("AUTHORIZATION_NOT_ESTABLISHED");
  }

  const unique = [...new Set(reasons)];
  const effective: CheckState =
    evidence !== null && unique.length === 0 ? "PASS" : "FAIL";

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
