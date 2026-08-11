/**
 * Runtime parsers for every V11 observability source.
 *
 * These are pure so the schema contract can be unit-tested without a network,
 * a GitHub token or a browser. They are also the sanitization boundary: broker
 * order identifiers, client order identifiers and any unexpected extra field
 * are dropped here rather than deeper in the stack.
 */

import type {
  ExecutionInfo,
  FrozenPlanInfo,
  PendingOrderIntent,
  PreflightCheck,
  PreflightInfo,
  RiskTier,
  TargetHolding,
  TournamentCandidate,
  TournamentInfo,
  ValidationInfo,
  ValidationSegmentMetric,
} from "./types";
import { normalizeInstant, runnerZoneDate } from "./vocab";
import { isCalendarDate } from "@/lib/calendar-date";
import { ACTION_NAME_PATTERN, classifyAction, isBlockingAction } from "./actions";

const RISK_TIERS = new Set<RiskTier>(["NORMAL", "CAUTIOUS", "HALT"]);

/** The producer's own bound on how many blockers one summary may name. */
export const MAX_BLOCKING_ACTIONS = 32;

/** `YYYY-MM`, exactly — the shape a monthly rebalance identifier takes. */
const CALENDAR_MONTH_PATTERN = /^\d{4}-\d{2}$/;

/** A US equity ticker as the universe admits them, including class suffixes. */
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/i;

/**
 * The most order attempts one frozen plan may carry: at most ten targets, and
 * a bounded number of retries against each.
 */
const MAX_ORDER_ATTEMPTS = 64;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function riskTier(value: unknown): RiskTier | null {
  return typeof value === "string" && RISK_TIERS.has(value as RiskTier)
    ? (value as RiskTier)
    : null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/* ------------------------------------------------------- production run */

/** Why a document's own `status` cannot be taken at face value. */
export type LastRunContradiction =
  /** A non-zero abort or error count, however the producer summarized it. */
  | "BLOCKING_ACTION_COUNT"
  /** No action says the cycle reached its end. */
  | "NO_TERMINAL_PROOF"
  /** More than one terminal action; a cycle completes once. */
  | "AMBIGUOUS_TERMINAL_PROOF"
  /** An action name this build has never classified. */
  | "UNCLASSIFIED_ACTION"
  /** A disabled sleeve or a dry-run marker in a production summary. */
  | "NON_V11_ACTION";

export interface LastRunSnapshot {
  readonly completedAt: string | null;
  readonly releaseSha: string | null;
  readonly strategyVersion: string;
  /** What the document claims. Not the verdict. */
  readonly status: "PASS" | "DEGRADED" | "FAIL";
  readonly paperOnly: boolean;
  readonly marketEntryAllowed: boolean | null;
  readonly riskTier: RiskTier | null;
  readonly actionCounts: Record<string, number>;
  readonly blockingActions: { action: string; symbol: string }[];
  readonly failureType: string | null;
  /** Blocking names derived from `action_counts`, not from the producer. */
  readonly blockingActionNames: readonly string[];
  /** Names no classification covers. Any of these refuses a pass. */
  readonly unknownActions: readonly string[];
  /** Total occurrences of terminal actions. Exactly 1 is required. */
  readonly terminalProofCount: number;
  readonly contradictions: readonly LastRunContradiction[];
  /**
   * The verdict: the document says PASS *and* the counts agree. Everything the
   * gate is allowed to build a pass on comes from here.
   */
  readonly passWorthy: boolean;
}

/**
 * Parse `state/production/last_run.json`. The release lineage is verified by
 * the caller against the approved SHA; a mismatch is a MISMATCH state, never a
 * silently accepted value.
 */
export function parseLastRun(value: unknown): LastRunSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== 1) return null;
  if (value.kind !== "v11_paper_production_run") return null;
  const status = value.status;
  if (status !== "PASS" && status !== "DEGRADED" && status !== "FAIL") {
    return null;
  }
  if (value.paper_only !== true) return null;

  // `failure_type` belongs to the crash path, which writes FAIL and nothing
  // else. A PASS carrying one is a document assembled from two different
  // outcomes, and we do not get to choose which half to believe.
  const failureType = value.failure_type;
  if (failureType !== undefined && failureType !== null) {
    if (status !== "FAIL") return null;
    if (typeof failureType !== "string" || failureType.trim() === "") return null;
  }

  // Both fields are mandatory and parsed whole. Skipping a malformed entry
  // would silently turn a document we cannot read into a shorter document we
  // can — and the entries most likely to be malformed are the blockers.
  if (!isRecord(value.action_counts)) return null;
  const actionCounts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.action_counts)) {
    if (!ACTION_NAME_PATTERN.test(key)) return null;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      return null;
    }
    actionCounts[key] = count;
  }

  if (!Array.isArray(value.blocking_actions)) return null;
  // A 33rd blocker is not a document to truncate; it is a document that does
  // not match the producer's contract.
  if (value.blocking_actions.length > MAX_BLOCKING_ACTIONS) return null;
  const blockingActions: { action: string; symbol: string }[] = [];
  for (const record of value.blocking_actions) {
    if (!isRecord(record)) return null;
    const action = str(record.action);
    if (!action || !ACTION_NAME_PATTERN.test(action)) return null;
    if (!isBlockingAction(action)) return null;
    // A named blocker that the counts never recorded means the two halves of
    // the document disagree about what happened.
    if (!(action in actionCounts) || actionCounts[action] === 0) return null;
    if (record.symbol !== undefined && typeof record.symbol !== "string") {
      return null;
    }
    blockingActions.push({
      action,
      symbol: (str(record.symbol) ?? "V11").slice(0, 16),
    });
  }

  // A run that reached a verdict computed a risk tier on the way. Only the
  // crash path, which never got that far, may omit it.
  const tier = riskTier(value.risk_tier);
  if (tier === null && status !== "FAIL") return null;

  const blockingActionNames: string[] = [];
  const unknownActions: string[] = [];
  const contradictions = new Set<LastRunContradiction>();
  let terminalProofCount = 0;
  for (const [action, count] of Object.entries(actionCounts)) {
    if (count === 0) continue;
    switch (classifyAction(action)) {
      case "blocking":
        blockingActionNames.push(action);
        contradictions.add("BLOCKING_ACTION_COUNT");
        break;
      case "terminal":
        terminalProofCount += count;
        break;
      case "non-v11":
        contradictions.add("NON_V11_ACTION");
        break;
      case "unknown":
        unknownActions.push(action);
        contradictions.add("UNCLASSIFIED_ACTION");
        break;
      case "neutral":
        break;
    }
  }
  if (terminalProofCount === 0) contradictions.add("NO_TERMINAL_PROOF");
  if (terminalProofCount > 1) contradictions.add("AMBIGUOUS_TERMINAL_PROOF");

  // A DEGRADED with nothing in it to explain the degradation is a document we
  // do not understand, and an unexplained downgrade is the same shape as a
  // truncated one.
  if (status === "DEGRADED" && contradictions.size === 0) return null;

  return {
    completedAt: normalizeInstant(value.completed_at),
    releaseSha: str(value.release_sha),
    strategyVersion: str(value.strategy_version) ?? "unknown",
    status,
    paperOnly: true,
    marketEntryAllowed:
      typeof value.market_entry_allowed === "boolean"
        ? value.market_entry_allowed
        : null,
    riskTier: tier,
    actionCounts,
    blockingActions,
    failureType: str(value.failure_type),
    blockingActionNames: blockingActionNames.sort(),
    unknownActions: unknownActions.sort(),
    terminalProofCount,
    contradictions: [...contradictions].sort(),
    passWorthy: status === "PASS" && contradictions.size === 0,
  };
}

export function executionFromLastRun(
  run: LastRunSnapshot,
  runUrl: string | null,
): ExecutionInfo {
  // Prefer the producer's own named blockers, which carry symbols. Fall back
  // to the names we derived from the counts — that is the case where the
  // producer failed to flag its own abort, so it is exactly the one the
  // operator most needs to see.
  const named =
    run.blockingActions.length > 0
      ? run.blockingActions
          .map((entry) => `${entry.action} (${entry.symbol})`)
          .join(", ")
      : run.blockingActionNames.join(", ");
  const blockingReason =
    named ||
    (run.failureType ? `runner failed with ${run.failureType}` : null) ||
    (run.contradictions.length > 0 ? run.contradictions.join(", ") : null);

  const hardContradiction = run.contradictions.some(
    (reason) =>
      reason === "BLOCKING_ACTION_COUNT" ||
      reason === "UNCLASSIFIED_ACTION" ||
      reason === "NON_V11_ACTION",
  );
  return {
    status: run.passWorthy
      ? "PASS"
      : run.status === "FAIL" || hardContradiction
        ? "FAIL"
        : "WARN",
    completedAt: run.completedAt,
    releaseSha: run.releaseSha,
    strategyVersion: run.strategyVersion,
    paperOnly: run.paperOnly,
    marketEntryAllowed: run.marketEntryAllowed,
    riskTier: run.riskTier,
    actionCounts: run.actionCounts,
    blockingReason,
    runUrl,
  };
}

/* ----------------------------------------------------- frozen plan/state */

/**
 * Parse the schema-v3 `adaptive_rebalance_pending` plan.
 *
 * Order attempts are reduced to a sanitized intent summary: broker order IDs
 * and deterministic client order IDs are execution-control identifiers and are
 * never exposed to the browser.
 */
export function parseFrozenPlan(value: unknown): FrozenPlanInfo | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== 3) return null;
  const planId = str(value.plan_id);
  const rebalanceMonth = str(value.rebalance_month);
  const constructionRiskTier = riskTier(value.construction_risk_tier);
  const strategyIdentityValue = str(value.strategy_identity_value);
  const rankingUniverseSha256 = str(value.ranking_universe_sha256);
  if (
    !planId ||
    !constructionRiskTier ||
    !strategyIdentityValue ||
    !rankingUniverseSha256 ||
    typeof value.risk_off !== "boolean" ||
    !isRecord(value.target_weights) ||
    !isRecord(value.sector_by_symbol)
  ) {
    return null;
  }

  // The rebalance cadence is monthly, and this field is what says which month
  // the plan belongs to. `"2026-13"` and `"August 2026"` are not months, and a
  // full date is a different kind of value wearing the same name.
  if (!rebalanceMonth || !CALENDAR_MONTH_PATTERN.test(rebalanceMonth)) return null;
  const month = Number(rebalanceMonth.slice(5, 7));
  if (month < 1 || month > 12) return null;

  // A plan is bound to the completed close it read and to the moment it was
  // frozen. Neither may be absent or unreadable: without them the D/D+1 timing
  // rule has nothing to check against.
  const signalDate = str(value.signal_date);
  if (!isCalendarDate(signalDate)) return null;
  const createdAt = normalizeInstant(value.created_at);
  if (createdAt === null) return null;
  // The signal is a *completed* close, so it cannot postdate the freeze.
  if (Date.parse(`${signalDate}T00:00:00Z`) > Date.parse(createdAt)) return null;

  // The count of names that survived the eligibility filters. Zero is a real
  // observation; a missing or fractional one used to become zero, which reads
  // identically on screen and is a different claim.
  if (
    typeof value.eligible_count !== "number" ||
    !Number.isSafeInteger(value.eligible_count) ||
    value.eligible_count < 0
  ) {
    return null;
  }

  const sectors = value.sector_by_symbol;
  const targets: TargetHolding[] = [];
  for (const [symbol, weight] of Object.entries(value.target_weights)) {
    if (!SYMBOL_PATTERN.test(symbol)) return null;
    const parsed = num(weight);
    if (parsed === null || parsed < 0 || parsed > 1) return null;
    // The 20% sector cap is enforced against this map. A target with no entry
    // used to be labelled "Unknown" — a sector that no cap can bind, which is
    // exactly the fabricated classification the strategy rules forbid.
    const sector = str(sectors[symbol]);
    if (!sector) return null;
    targets.push({
      symbol: symbol.toUpperCase(),
      weightPct: round(parsed * 100, 4),
      sector,
    });
  }
  targets.sort((a, b) => a.symbol.localeCompare(b.symbol));

  // The two maps describe one plan. A sector for a name that is not targeted
  // means they were built from different target sets.
  if (Object.keys(sectors).length !== targets.length) return null;

  // Only a risk-off plan legitimately holds nothing. An empty target set on a
  // risk-on plan is an allocation that never happened.
  if (targets.length === 0 && !value.risk_off) return null;

  const targetGrossPct = round(
    targets.reduce((total, target) => total + target.weightPct, 0),
    4,
  );
  if (targetGrossPct > 100.0001) return null;

  // Order attempts are the record of what was submitted against this plan.
  // Skipping an unreadable one published a plan showing fewer pending orders
  // than exist, which reads as "nothing outstanding" — the opposite of the
  // truth, and the state in which a replacement buy is unsafe.
  const pendingActions: PendingOrderIntent[] = [];
  if (value.order_attempts !== undefined && value.order_attempts !== null) {
    if (!isRecord(value.order_attempts)) return null;
    const attempts = Object.values(value.order_attempts);
    if (attempts.length > MAX_ORDER_ATTEMPTS) return null;
    for (const record of attempts) {
      if (!isRecord(record)) return null;
      const symbol = str(record.symbol);
      const side = record.side;
      const quantity = num(record.quantity);
      const targetWeight = num(record.target_weight);
      const attempt = num(record.attempt);
      if (!symbol || !SYMBOL_PATTERN.test(symbol)) return null;
      if (side !== "buy" && side !== "sell") return null;
      // A zero-quantity order is not an order, and a negative one is not a
      // side.
      if (quantity === null || quantity <= 0) return null;
      if (targetWeight === null || targetWeight < 0 || targetWeight > 1) return null;
      if (attempt === null || !Number.isSafeInteger(attempt) || attempt < 1) {
        return null;
      }
      if (record.status !== undefined && str(record.status) === null) return null;
      const submittedAt =
        record.submitted_at === undefined || record.submitted_at === null
          ? null
          : normalizeInstant(record.submitted_at);
      if (record.submitted_at !== undefined && record.submitted_at !== null && submittedAt === null) {
        return null;
      }
      pendingActions.push({
        symbol: symbol.toUpperCase(),
        side,
        quantity,
        targetWeightPct: round(targetWeight * 100, 4),
        status: (str(record.status) ?? "unknown").slice(0, 32),
        attempt,
        submittedAt,
      });
    }
  }
  pendingActions.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    planId,
    rebalanceMonth,
    signalDate,
    riskOff: value.risk_off,
    constructionRiskTier,
    eligibleCount: value.eligible_count,
    targets,
    targetGrossPct,
    targetCashPct: round(100 - targetGrossPct, 4),
    strategyIdentityValue,
    rankingUniverseSha256,
    createdAt,
    pendingActions,
  };
}

export interface PerformanceRuntimeSnapshot {
  readonly updatedAt: string | null;
  readonly equity: number | null;
  readonly cash: number | null;
  readonly numPositions: number | null;
  readonly riskTier: RiskTier | null;
  readonly riskTierUpdated: string | null;
  readonly riskTierReason: string | null;
  readonly rollingDrawdownPct: number | null;
  readonly rollingPeakEquity: number | null;
  readonly riskLookbackSessions: number | null;
  readonly recoveryLatchArmed: boolean | null;
  readonly plan: FrozenPlanInfo | null;
  readonly dailyHistory: { date: string; equity: number }[];
}

/**
 * The most sessions a runtime `daily_history` may carry.
 *
 * The runner keeps a rolling window measured in tens of sessions; anything
 * near this is a document that has stopped being a rolling window.
 */
export const MAX_DAILY_HISTORY_ROWS = 2000;

/**
 * How far the last history equity may sit from the scalar equity.
 *
 * The producer writes the same float into both, so the only legitimate
 * difference is JSON round-tripping. One cent is far above that and far below
 * any real change in account value.
 */
const EQUITY_AGREEMENT_TOLERANCE = 0.01;

/**
 * Parse the runtime `state/performance.json` from the private artifact.
 *
 * **Atomic.** Either the whole document is understood or nothing is returned.
 *
 * `daily_history` used to be built with `continue`: a malformed row, an
 * unusable equity or an impossible date was skipped and the *rest* was
 * published. That is the worst available behaviour for this particular field,
 * because it is what the rolling drawdown and the risk tier are computed from
 * — a history quietly missing its worst day reports a smaller drawdown and a
 * calmer tier than the account actually experienced, and nothing anywhere says
 * a row was dropped.
 *
 * Duplicates and out-of-order rows are refused for the same reason: the window
 * is a time series, and a series with two entries for one session or with
 * yesterday after today is not one. Every consumer treats consecutive entries
 * as consecutive sessions.
 */
export function parsePerformanceRuntime(
  value: unknown,
): PerformanceRuntimeSnapshot | null {
  if (!isRecord(value)) return null;

  // `daily_history` is mandatory. It is the series the rolling drawdown and
  // the risk tier are computed from; a runtime state without it cannot answer
  // the question the risk view exists to ask, and an empty screen is a better
  // answer than a confident one built on nothing.
  const raw = value.daily_history;
  const dailyHistory: { date: string; equity: number }[] = [];
  {
    if (!Array.isArray(raw)) return null;
    // Zero rows is not a quiet account. The runner appends one row per cycle,
    // so a history with none means the series was never built — and an empty
    // series produces a zero drawdown and a NORMAL tier out of nothing.
    if (raw.length === 0) return null;
    if (raw.length > MAX_DAILY_HISTORY_ROWS) return null;
    let previousDate: string | null = null;
    for (const entry of raw) {
      if (!isRecord(entry)) return null;
      const date = str(entry.date);
      const equity = num(entry.equity);
      // A session's equity is a market value: it cannot be negative, and a
      // zero is the runner failing to read it rather than an observation.
      if (!isCalendarDate(date) || equity === null) return null;
      if (!Number.isFinite(equity) || equity <= 0) return null;
      if (previousDate !== null && date <= previousDate) return null;
      previousDate = date;
      dailyHistory.push({ date, equity });
    }
  }

  // The scalar state the risk view is built from. A document that cannot
  // state its own equity, cash or position count is not a runtime state, and
  // publishing it with nulls in place of numbers reads on screen as a genuine
  // observation of zero.
  const equity = num(value.equity);
  const cash = num(value.cash);
  const numPositions = num(value.num_positions);
  const updatedAt = normalizeInstant(value.updated_at);
  if (equity === null || cash === null || numPositions === null) return null;
  if (updatedAt === null) return null;
  // Ranges, not just types. A negative equity, a fractional position count or
  // a negative one are each a document this build does not understand, and
  // each renders on screen as an ordinary observation.
  if (!Number.isFinite(equity) || equity <= 0) return null;
  if (!Number.isFinite(cash)) return null;
  if (!Number.isInteger(numPositions) || numPositions < 0) return null;

  // The risk tier drives what the strategy is allowed to do next. An
  // unrecognised one is not a tier.
  const tier = riskTier(value.risk_tier);
  if (tier === null) return null;

  // `update_performance_state` writes both halves of this document from one
  // snapshot: `updated_at` from `get_now_str()`, the last history row from
  // `get_today_str()` and `current["equity"]`. They are the same moment and
  // the same number by construction, so any disagreement means the file is a
  // mixture — most plausibly a restored artifact with today's scalar fields
  // written over yesterday's series, which reads on screen as one coherent
  // account state.
  const last = dailyHistory[dailyHistory.length - 1];
  const session = runnerZoneDate(updatedAt);
  if (session === null || last.date !== session) return null;
  if (Math.abs(last.equity - equity) >= EQUITY_AGREEMENT_TOLERANCE) return null;

  // Present-but-unreadable optional metrics are refused too: `null` beside a
  // parsed document reads as "not measured", which is a different claim from
  // "measured and unintelligible".
  for (const key of [
    "rolling_drawdown_pct",
    "rolling_peak_equity",
    "risk_lookback_sessions",
  ] as const) {
    if (value[key] !== undefined && value[key] !== null && num(value[key]) === null) {
      return null;
    }
  }
  if (
    value.risk_tier_updated !== undefined &&
    value.risk_tier_updated !== null &&
    normalizeInstant(value.risk_tier_updated) === null
  ) {
    return null;
  }

  // A frozen plan that is *present* must be usable. `parseFrozenPlan` returns
  // null both for "absent" and for "present and unreadable", and treating the
  // second as the first published a runtime state claiming there is no pending
  // rebalance when there is one nobody can read.
  const rawPlan = value.adaptive_rebalance_pending;
  const planPresent = rawPlan !== undefined && rawPlan !== null;
  const plan = planPresent ? parseFrozenPlan(rawPlan) : null;
  if (planPresent && plan === null) return null;

  const recoveryLatchArmed =
    typeof value.adaptive_risk_off_latched === "boolean"
      ? value.adaptive_risk_off_latched
      : value.adaptive_risk_off_latched === undefined
        ? false
        : null;
  if (recoveryLatchArmed === null) return null;

  return {
    updatedAt,
    equity,
    cash,
    numPositions,
    riskTier: tier,
    riskTierUpdated: normalizeInstant(value.risk_tier_updated),
    riskTierReason: str(value.risk_tier_reason),
    rollingDrawdownPct: num(value.rolling_drawdown_pct),
    rollingPeakEquity: num(value.rolling_peak_equity),
    riskLookbackSessions: num(value.risk_lookback_sessions),
    recoveryLatchArmed,
    plan,
    dailyHistory,
  };
}

/* ------------------------------------------------------------- preflight */

/**
 * The most checks a preflight report may contain.
 *
 * A bound is needed so a hostile or corrupt document cannot make the parser
 * allocate without limit. Exceeding it rejects the **whole document**: the old
 * code took the first 64 and carried on, which silently discarded evidence and
 * would have hidden a failing check placed past the cut.
 */
export const MAX_PREFLIGHT_CHECKS = 64;

/** A non-negative integer, stated explicitly. Nothing is inferred. */
function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * Parse `production-preflight.json` from the diagnostics artifact.
 *
 * Strict throughout: this is the document the effective validation gate defers
 * to, so anything it cannot fully understand it refuses. Every earlier
 * leniency here was a way for a broken report to look healthy —
 *
 *   * a non-array `checks` left the list empty and the report still parsed;
 *   * `.slice(0, 64)` truncated silently;
 *   * a check with no name or a non-boolean `passed` was skipped with
 *     `continue`, so the parsed report described fewer checks than the file;
 *   * `checks_passed ?? 0` invented a count the document never stated.
 *
 * Every one of those now returns null, which the caller reports as an
 * unreadable preflight rather than a passing one.
 */
export function parsePreflight(
  value: unknown,
  runUrl: string | null,
): PreflightInfo | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== 1) return null;
  if (value.kind !== "v11_paper_production_preflight") return null;
  const status = value.status;
  if (status !== "PASS" && status !== "FAIL") return null;

  // The mode is part of the contract, not a free-text label, and it must agree
  // with the status: the runner emits `paper` only when every check passed.
  const allowedMode = str(value.allowed_mode);
  if (allowedMode !== "paper" && allowedMode !== "no-execution") return null;
  if ((status === "PASS") !== (allowedMode === "paper")) return null;

  if (!Array.isArray(value.checks)) return null;
  if (value.checks.length > MAX_PREFLIGHT_CHECKS) return null;

  const checks: PreflightCheck[] = [];
  for (const check of value.checks) {
    if (!isRecord(check)) return null;
    const name = str(check.name);
    if (!name || typeof check.passed !== "boolean") return null;
    const detail = check.detail;
    if (detail !== undefined && detail !== null && typeof detail !== "string") {
      return null;
    }
    checks.push({
      name,
      passed: check.passed,
      detail: (str(detail) ?? "").slice(0, 300),
    });
  }

  // Counts are stated by the document or the document is unusable. Defaulting
  // them made a report with no counts indistinguishable from a complete one.
  const checksPassed = nonNegativeInteger(value.checks_passed);
  const checksEvaluated = nonNegativeInteger(value.checks_evaluated);
  if (checksPassed === null || checksEvaluated === null) return null;

  // The timestamp anchors the whole freshness contract.
  const checkedAt = normalizeInstant(value.checked_at);
  if (checkedAt === null) return null;

  const details = isRecord(value.details) ? value.details : {};
  const universeCheck = checks.find((check) => check.name === "ranking_universe");
  const universeSha256 =
    universeCheck?.detail.match(/hash=([0-9a-f]{64})/)?.[1] ?? null;

  let runtimeVersions: Record<string, string> | null = null;
  if (isRecord(details.runtime_versions)) {
    runtimeVersions = {};
    for (const [key, version] of Object.entries(details.runtime_versions)) {
      const parsed = str(version);
      if (parsed) runtimeVersions[key] = parsed;
    }
  }

  const universeSource = str(details.universe_source);
  return {
    status,
    checkedAt,
    checksPassed,
    checksEvaluated,
    allowedMode,
    marketOpen:
      typeof details.market_open === "boolean" ? details.market_open : null,
    accountStatus: str(details.account_status),
    positionCount: num(details.position_count),
    openOrderCount: num(details.open_order_count),
    openBuyCount: num(details.open_buy_count),
    shortCount: num(details.short_count),
    strategyIdentity: str(details.strategy_identity),
    universeCount: num(details.universe_count),
    universeSource,
    universeSha256,
    barSnapshotThroughDate: isCalendarDate(details.bar_snapshot_through_date)
      ? details.bar_snapshot_through_date
      : null,
    validationStatus: str(details.validation_status),
    riskTier: riskTier(details.risk_tier),
    riskSnapshotReason: str(details.risk_snapshot_reason),
    runtimeVersions,
    checks,
    runUrl,
  };
}

/* ------------------------------------------------------------ validation */

const SEGMENTS = [
  { key: "development", fallbackLabel: "DEVELOPMENT / model-building period" },
  {
    key: "temporal_check",
    fallbackLabel: "REUSED TEMPORAL CHECK / not fresh OOS",
  },
] as const;

/** Parse the canonical `state/backtest/v11_validation.json` promotion report. */
export function parseValidation(
  value: unknown,
  readAtRef: string,
): Omit<ValidationInfo, "identityMatchesRuntime" | "universeMatchesRuntime"> | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== 1) return null;
  if (value.kind !== "v11_fixed_strategy_validation") return null;

  const assessment = isRecord(value.assessment) ? value.assessment : {};
  // All-or-nothing: a valid total beside an unreadable pass count is not a
  // partial fact, it is a ratio with one half missing.
  const rawEvaluated = nonNegativeInteger(assessment.checks_evaluated);
  const rawPassed = nonNegativeInteger(assessment.checks_passed);
  const assessmentCounts =
    rawEvaluated === null || rawPassed === null
      ? { evaluated: null, passed: null }
      : { evaluated: rawEvaluated, passed: rawPassed };
  const evidence = isRecord(value.evidence) ? value.evidence : {};
  const strategy = isRecord(value.strategy) ? value.strategy : {};
  const identity = isRecord(strategy.identity) ? strategy.identity : {};
  const profile = isRecord(value.promotion_profile) ? value.promotion_profile : {};
  const contract = isRecord(value.contract) ? value.contract : {};
  const periods = isRecord(value.periods) ? value.periods : {};

  const rawStatus = str(assessment.status);
  const status =
    rawStatus === "PASS" ? "PASS" : rawStatus === "FAIL" ? "FAIL" : "UNAVAILABLE";

  const generatedAt = normalizeInstant(value.generated_at);
  // A boundary that is not a real day is no boundary. Reporting it as absent
  // makes the report expire on `generated_at` alone rather than on a date two
  // days later than the one it states.
  const rawBoundary = evidence.bar_snapshot_through_date;
  const barBoundaryDate = isCalendarDate(rawBoundary) ? rawBoundary : null;
  const { expiresAt, expiryBasis } = validationExpiry(
    generatedAt,
    barBoundaryDate,
  );

  const slippageScenariosBps = Array.isArray(value.slippage_scenarios_bps)
    ? value.slippage_scenarios_bps.filter(
        (entry): entry is number => num(entry) !== null,
      )
    : [];

  const metrics: ValidationSegmentMetric[] = [];
  if (Array.isArray(value.results)) {
    for (const result of value.results) {
      if (!isRecord(result)) continue;
      const slippageBps = num(result.slippage_bps);
      if (slippageBps === null || !isRecord(result.segments)) continue;
      for (const { key, fallbackLabel } of SEGMENTS) {
        const segment = result.segments[key];
        if (!isRecord(segment)) continue;
        const config = isRecord(segment.config) ? segment.config : {};
        const m = isRecord(segment.metrics) ? segment.metrics : {};
        const period = isRecord(periods[key]) ? periods[key] : {};
        metrics.push({
          slippageBps,
          segment: key,
          segmentLabel: str(segment.label) ?? fallbackLabel,
          startDate: str(config.start_date) ?? str(period.start_date) ?? "",
          endDate: str(config.end_date) ?? str(period.end_date) ?? "",
          sessions: num(period.sessions) ?? num(m.n_trading_days) ?? 0,
          cagrPct: num(m.annual_return_pct),
          spyCagrPct: num(m.spy_annual_return_pct),
          excessCagrPct: num(m.excess_cagr_pct),
          jensenAlphaPct: num(m.jensen_alpha_annual_pct),
          sharpe: num(m.sharpe_ratio),
          betaToSpy: num(m.beta_to_spy),
          informationRatio: num(m.information_ratio),
          maxDrawdownPct: num(m.max_drawdown_pct),
        });
      }
    }
  }

  const warnings: { code: string; message: string }[] = [];
  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings.slice(0, 32)) {
      if (!isRecord(warning)) continue;
      const code = str(warning.code);
      const message = str(warning.message);
      if (code && message) warnings.push({ code, message: message.slice(0, 400) });
    }
  }

  return {
    status,
    allowedMode: str(assessment.allowed_mode),
    generatedAt,
    barBoundaryDate,
    expiresAt,
    expiryBasis,
    // Counts, not measurements: 0.5 evaluated and 0.5 passed used to satisfy
    // the gate's "positive and equal" test, which is how a report with no
    // checks at all could read as fully checked. The pair is all-or-nothing —
    // a valid total beside an unreadable pass count is not a partial fact, it
    // is a ratio with one half missing.
    checksPassed: assessmentCounts.passed,
    checksEvaluated: assessmentCounts.evaluated,
    strategyIdentityValue: str(identity.value),
    rankingUniverseSha256: str(evidence.ranking_universe_sha256),
    rankingUniverseCount: num(evidence.ranking_universe_count),
    startingCapital: num(profile.canonical_starting_cash) ?? num(profile.starting_cash),
    slippageScenariosBps,
    reportSha256: str(contract.report_sha256),
    barSnapshotSha256: str(evidence.bar_snapshot_sha256),
    contractSchemaVersion: num(contract.schema_version),
    contractAlgorithm: str(contract.algorithm),
    metrics,
    warnings,
    readAtRef,
  };
}

export const VALIDATION_MAX_AGE_DAYS = 35;

/**
 * The report and its adjusted-bar boundary both expire after 35 days; the
 * earlier of the two is the binding constraint, exactly as the Python gate
 * enforces it.
 */
export function validationExpiry(
  generatedAt: string | null,
  barBoundaryDate: string | null,
): { expiresAt: string | null; expiryBasis: "report" | "bar-boundary" | null } {
  const windowMs = VALIDATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const candidates: { at: number; basis: "report" | "bar-boundary" }[] = [];
  if (generatedAt) {
    const parsed = Date.parse(generatedAt);
    if (Number.isFinite(parsed)) {
      candidates.push({ at: parsed + windowMs, basis: "report" });
    }
  }
  // The 35-day expiry is computed from this date. `2026-02-30` used to pass
  // the shape test and become 2 March, buying the report two days it was
  // never granted.
  if (isCalendarDate(barBoundaryDate)) {
    const parsed = Date.parse(`${barBoundaryDate}T00:00:00Z`);
    if (Number.isFinite(parsed)) {
      candidates.push({ at: parsed + windowMs, basis: "bar-boundary" });
    }
  }
  if (candidates.length === 0) return { expiresAt: null, expiryBasis: null };
  candidates.sort((a, b) => a.at - b.at);
  return {
    expiresAt: new Date(candidates[0].at).toISOString(),
    expiryBasis: candidates[0].basis,
  };
}

/* ------------------------------------------------------------ tournament */

const TOURNAMENT_PRIMARY_COST_BPS = 15;

/** Parse the epoch-1 tournament evidence into a compact, display-safe DTO. */
export function parseTournament(
  value: unknown,
  readAtRef: string,
): TournamentInfo | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== 1) return null;
  const selection = isRecord(value.selection) ? value.selection : null;
  if (!selection) return null;
  const decision = str(selection.decision);
  if (!decision) return null;

  const costResults = isRecord(value.cost_results) ? value.cost_results : {};
  const primary = isRecord(costResults[String(TOURNAMENT_PRIMARY_COST_BPS)])
    ? (costResults[String(TOURNAMENT_PRIMARY_COST_BPS)] as Record<string, unknown>)
    : {};
  const gates = isRecord(selection.candidate_gate_decisions)
    ? selection.candidate_gate_decisions
    : {};

  const candidates: TournamentCandidate[] = [];
  for (const [name, result] of Object.entries(primary)) {
    if (!isRecord(result)) continue;
    const development = isRecord(result.development) ? result.development : {};
    const reused = isRecord(result.reused_temporal) ? result.reused_temporal : {};
    const gate = isRecord(gates[name]) ? gates[name] : {};
    candidates.push({
      name,
      developmentCagrPct: num(development.annual_return_pct),
      developmentExcessCagrPct: num(development.excess_cagr_pct),
      developmentSharpe: num(development.sharpe_ratio),
      developmentMaxDrawdownPct: num(development.max_drawdown_pct),
      reusedExcessCagrPct: num(reused.excess_cagr_pct),
      eligibleChallenger: gate.eligible_challenger === true,
      isIncumbent: name === "v11_incumbent",
    });
  }
  candidates.sort((a, b) => {
    if (a.isIncumbent !== b.isIncumbent) return a.isIncumbent ? -1 : 1;
    return (
      (b.developmentExcessCagrPct ?? -Infinity) -
      (a.developmentExcessCagrPct ?? -Infinity)
    );
  });

  const warnings: { code: string; message: string }[] = [];
  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings.slice(0, 32)) {
      if (!isRecord(warning)) continue;
      const code = str(warning.code);
      const message = str(warning.message);
      if (code && message) warnings.push({ code, message: message.slice(0, 400) });
    }
  }

  const protocol = isRecord(value.protocol) ? value.protocol : {};
  const eligible = Array.isArray(selection.statistically_eligible_challengers)
    ? selection.statistically_eligible_challengers.length
    : 0;

  return {
    epoch: 1,
    status: str(value.status) ?? "UNKNOWN",
    decision,
    productionChanged: selection.production_changed === true,
    researchOnly: value.research_only === true,
    generatedAt: normalizeInstant(value.generated_at),
    eligibleChallengerCount: eligible,
    shadowChallenger: str(selection.shadow_challenger),
    primaryCostBps: TOURNAMENT_PRIMARY_COST_BPS,
    candidates,
    warnings,
    protocolPath: str(protocol.path) ?? "strategy/strategy_tournament_epoch_1.md",
    readAtRef,
  };
}
