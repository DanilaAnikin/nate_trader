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
import { normalizeInstant } from "./vocab";
import { isCalendarDate } from "@/lib/calendar-date";

const RISK_TIERS = new Set<RiskTier>(["NORMAL", "CAUTIOUS", "HALT"]);

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

export interface LastRunSnapshot {
  readonly completedAt: string | null;
  readonly releaseSha: string | null;
  readonly strategyVersion: string;
  readonly status: "PASS" | "DEGRADED" | "FAIL";
  readonly paperOnly: boolean;
  readonly marketEntryAllowed: boolean | null;
  readonly riskTier: RiskTier | null;
  readonly actionCounts: Record<string, number>;
  readonly blockingActions: { action: string; symbol: string }[];
  readonly failureType: string | null;
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

  const actionCounts: Record<string, number> = {};
  if (isRecord(value.action_counts)) {
    for (const [key, count] of Object.entries(value.action_counts)) {
      const parsed = num(count);
      if (parsed !== null && /^[A-Z_]{1,64}$/.test(key)) {
        actionCounts[key] = parsed;
      }
    }
  }

  const blockingActions: { action: string; symbol: string }[] = [];
  if (Array.isArray(value.blocking_actions)) {
    for (const record of value.blocking_actions.slice(0, 32)) {
      if (!isRecord(record)) continue;
      const action = str(record.action);
      if (!action) continue;
      blockingActions.push({
        action: action.slice(0, 64),
        symbol: (str(record.symbol) ?? "V11").slice(0, 16),
      });
    }
  }

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
    riskTier: riskTier(value.risk_tier),
    actionCounts,
    blockingActions,
    failureType: str(value.failure_type),
  };
}

export function executionFromLastRun(
  run: LastRunSnapshot,
  runUrl: string | null,
): ExecutionInfo {
  const blockingReason =
    run.blockingActions.length > 0
      ? run.blockingActions
          .map((entry) => `${entry.action} (${entry.symbol})`)
          .join(", ")
      : run.failureType
        ? `runner failed with ${run.failureType}`
        : null;
  return {
    status:
      run.status === "PASS" ? "PASS" : run.status === "DEGRADED" ? "WARN" : "FAIL",
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
    !rebalanceMonth ||
    !constructionRiskTier ||
    !strategyIdentityValue ||
    !rankingUniverseSha256 ||
    typeof value.risk_off !== "boolean" ||
    !isRecord(value.target_weights) ||
    !isRecord(value.sector_by_symbol)
  ) {
    return null;
  }

  const sectors = value.sector_by_symbol;
  const targets: TargetHolding[] = [];
  for (const [symbol, weight] of Object.entries(value.target_weights)) {
    const parsed = num(weight);
    if (parsed === null || parsed < 0 || parsed > 1) return null;
    targets.push({
      symbol: symbol.toUpperCase(),
      weightPct: round(parsed * 100, 4),
      sector: str(sectors[symbol]) ?? "Unknown",
    });
  }
  targets.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const targetGrossPct = round(
    targets.reduce((total, target) => total + target.weightPct, 0),
    4,
  );
  if (targetGrossPct > 100.0001) return null;

  const pendingActions: PendingOrderIntent[] = [];
  if (isRecord(value.order_attempts)) {
    for (const record of Object.values(value.order_attempts)) {
      if (!isRecord(record)) continue;
      const symbol = str(record.symbol);
      const side = record.side;
      const quantity = num(record.quantity);
      const targetWeight = num(record.target_weight);
      const attempt = num(record.attempt);
      if (
        !symbol ||
        (side !== "buy" && side !== "sell") ||
        quantity === null ||
        targetWeight === null ||
        attempt === null
      ) {
        continue;
      }
      pendingActions.push({
        symbol: symbol.toUpperCase(),
        side,
        quantity,
        targetWeightPct: round(targetWeight * 100, 4),
        status: (str(record.status) ?? "unknown").slice(0, 32),
        attempt,
        submittedAt: normalizeInstant(record.submitted_at),
      });
    }
  }
  pendingActions.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    planId,
    rebalanceMonth,
    signalDate: str(value.signal_date),
    riskOff: value.risk_off,
    constructionRiskTier,
    eligibleCount:
      typeof value.eligible_count === "number" &&
      Number.isInteger(value.eligible_count)
        ? value.eligible_count
        : 0,
    targets,
    targetGrossPct,
    targetCashPct: round(100 - targetGrossPct, 4),
    strategyIdentityValue,
    rankingUniverseSha256,
    createdAt: normalizeInstant(value.created_at),
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

/** Parse the runtime `state/performance.json` from the private artifact. */
export function parsePerformanceRuntime(
  value: unknown,
): PerformanceRuntimeSnapshot | null {
  if (!isRecord(value)) return null;
  const dailyHistory: { date: string; equity: number }[] = [];
  if (Array.isArray(value.daily_history)) {
    for (const entry of value.daily_history) {
      if (!isRecord(entry)) continue;
      const date = str(entry.date);
      const equity = num(entry.equity);
      // Round-tripped, not shape-checked: `2026-02-30` matches the pattern,
      // and every consumer keys risk and drawdown off these dates.
      if (isCalendarDate(date) && equity !== null) {
        dailyHistory.push({ date, equity });
      }
    }
  }
  return {
    updatedAt: normalizeInstant(value.updated_at),
    equity: num(value.equity),
    cash: num(value.cash),
    numPositions: num(value.num_positions),
    riskTier: riskTier(value.risk_tier),
    riskTierUpdated: normalizeInstant(value.risk_tier_updated),
    riskTierReason: str(value.risk_tier_reason),
    rollingDrawdownPct: num(value.rolling_drawdown_pct),
    rollingPeakEquity: num(value.rolling_peak_equity),
    riskLookbackSessions: num(value.risk_lookback_sessions),
    recoveryLatchArmed:
      typeof value.adaptive_risk_off_latched === "boolean"
        ? value.adaptive_risk_off_latched
        : value.adaptive_risk_off_latched === undefined
          ? false
          : null,
    plan: parseFrozenPlan(value.adaptive_rebalance_pending),
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
    checksPassed: num(assessment.checks_passed),
    checksEvaluated: num(assessment.checks_evaluated),
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
