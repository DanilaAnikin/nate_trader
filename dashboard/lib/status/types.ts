import type { CheckState, Freshness, Section } from "./vocab";

/**
 * The single server-side read model for the V11 observability dashboard.
 *
 * Components must never join unrelated JSON sources themselves. Each section
 * carries its own provenance, so a fresh broker request can never be presented
 * as a fresh strategy run, and an approved trading release can never be
 * confused with the deployed dashboard build.
 */
export const STRATEGY_STATUS_SCHEMA_VERSION = 1 as const;
export const STRATEGY_STATUS_SOURCE = "v11-strategy-status" as const;

export type AccountMode = "paper" | "live";

export type AccountRole =
  | "PRODUCTION_CONTROLLED_PAPER"
  | "OBSERVER_ONLY_PAPER"
  | "READ_ONLY_LIVE";

/* ------------------------------------------------------------------ web */

export interface WebInfo {
  readonly dashboardBuildSha: string | null;
  readonly dataMode: "account-scoped" | "legacy-explicit" | "unavailable";
  readonly status: "ok" | "misconfigured";
  readonly strategyVersion: string;
}

/* -------------------------------------------------------------- release */

export interface ReleaseInfo {
  /** Head of the repository default branch — research/source reference only. */
  readonly repositoryRefSha: string | null;
  readonly repositoryRef: string;
  readonly repositoryRefCommittedAt: string | null;
  /** The only SHA the guarded paper executor is allowed to check out. */
  readonly approvedPaperReleaseSha: string | null;
  readonly approvedShaSource:
    | "github-environment-variable"
    | "server-environment"
    | "derived-from-runtime-artifact"
    | null;
  readonly releaseGate: CheckState;
  readonly releaseGateRunUrl: string | null;
  readonly releaseGateCompletedAt: string | null;
  /**
   * Whether the deployed dashboard build happens to equal the approved paper
   * release. They are independent deployables; a difference is normal and is
   * never rendered as a failure.
   */
  readonly dashboardMatchesApprovedRelease: boolean | null;
}

/* ------------------------------------------------------- account binding */

export interface AccountBindingInfo {
  readonly selectedAccountId: string;
  readonly selectedAccountNickname: string;
  readonly mode: AccountMode;
  readonly role: AccountRole;
  readonly productionBound: boolean;
  /** How the binding was proven, or null when it could not be. */
  readonly bindingProof: "server-authorized-production-owner-and-account" | null;
  readonly bindingDetail: string;
  /** Last four characters only; the full broker account number never leaves the server. */
  readonly brokerAccountMask: string | null;
}

/* --------------------------------------------------------------- broker */

export interface BrokerPosition {
  readonly symbol: string;
  readonly qty: number;
  readonly avgEntryPrice: number;
  readonly currentPrice: number;
  readonly marketValue: number;
  readonly unrealizedPl: number;
  readonly unrealizedPlPct: number;
  readonly side: "long" | "short";
}

export interface BrokerInfo {
  readonly equity: number;
  readonly cash: number;
  readonly cashPct: number;
  readonly dailyPnl: number;
  readonly dailyPnlPct: number;
  readonly grossExposure: number;
  readonly grossExposurePct: number;
  readonly positionCount: number;
  readonly positions: readonly BrokerPosition[];
  readonly shortSymbols: readonly string[];
}

/* ------------------------------------------------------------- strategy */

export type RiskTier = "NORMAL" | "CAUTIOUS" | "HALT";

export interface RiskTierObservation {
  readonly tier: RiskTier;
  readonly reason: string | null;
  readonly source: string;
  readonly asOf: string | null;
}

export interface TargetHolding {
  readonly symbol: string;
  readonly weightPct: number;
  readonly sector: string;
}

export interface PendingOrderIntent {
  readonly symbol: string;
  readonly side: "buy" | "sell";
  readonly quantity: number;
  readonly targetWeightPct: number;
  readonly status: string;
  readonly attempt: number;
  readonly submittedAt: string | null;
}

export interface FrozenPlanInfo {
  readonly planId: string;
  readonly rebalanceMonth: string;
  readonly signalDate: string | null;
  readonly riskOff: boolean;
  readonly constructionRiskTier: RiskTier;
  readonly eligibleCount: number;
  readonly targets: readonly TargetHolding[];
  readonly targetGrossPct: number;
  readonly targetCashPct: number;
  readonly strategyIdentityValue: string;
  readonly rankingUniverseSha256: string;
  readonly createdAt: string | null;
  readonly pendingActions: readonly PendingOrderIntent[];
}

export interface StrategyRuntimeInfo {
  readonly strategyVersion: string;
  readonly paperOnly: true;
  /** V11 SPY/SMA200 gate outcome recorded by the runner, not recomputed here. */
  readonly marketGate: "RISK_ON" | "RISK_OFF" | null;
  readonly marketGateSource: string | null;
  /** SPY close/SMA200 are not persisted by the runner today. */
  readonly spyClose: number | null;
  readonly spySma200: number | null;
  readonly breadthPct: number | null;
  readonly breadthNumerator: number | null;
  readonly breadthDenominator: number | null;
  readonly breadthMultiplierPct: number | null;
  readonly recoveryLatchArmed: boolean | null;
  readonly rollingDrawdownPct: number | null;
  readonly rollingPeakEquity: number | null;
  readonly riskLookbackSessions: number | null;
  /** Risk tier captured by the cycle that actually made the decision. */
  readonly executionRiskTier: RiskTierObservation | null;
  /** Risk tier stored in the saved performance file; may disagree. */
  readonly persistedRiskTier: RiskTierObservation | null;
  readonly riskTierConflict: boolean;
  readonly plan: FrozenPlanInfo | null;
  readonly runtimeEquity: number | null;
  readonly runtimeCash: number | null;
  readonly runtimePositionCount: number | null;
  readonly runtimeSnapshotAt: string | null;
}

/* -------------------------------------------------------------- universe */

export interface UniverseInfo {
  readonly source: string;
  readonly symbolCount: number | null;
  readonly rankingUniverseSha256: string | null;
  readonly eligibleCount: number | null;
  readonly selectedCount: number | null;
  readonly cacheState: "alpaca-cache" | "validated-watchlist-fallback" | null;
}

/* --------------------------------------------------------- authorization */

/**
 * Whether this viewer may see the central production runtime at all.
 *
 * The frozen plan, preflight, executor results and workflow operations belong
 * to one production account, not to whoever is signed in. An unauthorized
 * viewer causes no GitHub Actions call and receives none of that data.
 */
export interface AuthorizationInfo {
  readonly productionRuntimeAuthorized: boolean;
  readonly denialReason: string | null;
  readonly detail: string;
}

/* ------------------------------------------------------------ validation */

export interface ValidationSegmentMetric {
  readonly slippageBps: number;
  readonly segment: "development" | "temporal_check";
  readonly segmentLabel: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly sessions: number;
  readonly cagrPct: number | null;
  readonly spyCagrPct: number | null;
  readonly excessCagrPct: number | null;
  readonly jensenAlphaPct: number | null;
  readonly sharpe: number | null;
  readonly betaToSpy: number | null;
  readonly informationRatio: number | null;
  readonly maxDrawdownPct: number | null;
}

/**
 * The historical report assessment and the currently *effective* paper-buy
 * gate, deliberately kept apart.
 */
export interface EffectiveValidationGate {
  readonly effective: CheckState;
  readonly reportAssessment: CheckState;
  readonly reasons: readonly string[];
  readonly details: readonly string[];
  readonly expiresAt: string | null;
}

export interface ValidationInfo {
  readonly status: CheckState;
  readonly allowedMode: string | null;
  readonly generatedAt: string | null;
  readonly barBoundaryDate: string | null;
  readonly expiresAt: string | null;
  readonly expiryBasis: "report" | "bar-boundary" | null;
  readonly checksPassed: number | null;
  readonly checksEvaluated: number | null;
  readonly strategyIdentityValue: string | null;
  readonly rankingUniverseSha256: string | null;
  readonly rankingUniverseCount: number | null;
  readonly startingCapital: number | null;
  readonly slippageScenariosBps: readonly number[];
  readonly identityMatchesRuntime: CheckState;
  readonly universeMatchesRuntime: CheckState;
  readonly reportSha256: string | null;
  /**
   * Evidence the Python gate recomputes and TypeScript cannot: the adjusted-bar
   * prefix digest and its boundary. The dashboard can only check that they are
   * present and well-formed, and then defer to the persisted preflight verdict.
   */
  readonly barSnapshotSha256: string | null;
  /** The whole-report digest block, as recorded. */
  readonly contractSchemaVersion: number | null;
  readonly contractAlgorithm: string | null;
  readonly metrics: readonly ValidationSegmentMetric[];
  readonly warnings: readonly { code: string; message: string }[];
  readonly readAtRef: string;
}

/* ------------------------------------------------------------ operations */

export interface WorkflowAttemptInfo {
  readonly runId: number;
  readonly runNumber: number;
  readonly attempt: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly triggerSha: string | null;
  readonly event: string;
  readonly url: string;
  /**
   * True when GitHub failed before the job body ran (for example no hosted
   * runner). No strategy, preflight or broker work happened in that attempt.
   */
  readonly infrastructureFailure: boolean;
  readonly failureKind: "infrastructure" | "strategy-or-broker" | null;
}

export interface PreflightCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface PreflightInfo {
  readonly status: CheckState;
  readonly checkedAt: string | null;
  readonly checksPassed: number;
  readonly checksEvaluated: number;
  readonly allowedMode: string | null;
  readonly marketOpen: boolean | null;
  readonly accountStatus: string | null;
  readonly positionCount: number | null;
  readonly openOrderCount: number | null;
  readonly openBuyCount: number | null;
  readonly shortCount: number | null;
  readonly strategyIdentity: string | null;
  readonly universeCount: number | null;
  readonly universeSource: string | null;
  readonly universeSha256: string | null;
  readonly barSnapshotThroughDate: string | null;
  readonly validationStatus: string | null;
  readonly riskTier: RiskTier | null;
  readonly riskSnapshotReason: string | null;
  readonly runtimeVersions: Readonly<Record<string, string>> | null;
  readonly checks: readonly PreflightCheck[];
  readonly runUrl: string | null;
}

export interface ExecutionInfo {
  readonly status: CheckState;
  readonly completedAt: string | null;
  readonly releaseSha: string | null;
  readonly strategyVersion: string;
  readonly paperOnly: boolean;
  readonly marketEntryAllowed: boolean | null;
  readonly riskTier: RiskTier | null;
  readonly actionCounts: Readonly<Record<string, number>>;
  readonly blockingReason: string | null;
  readonly runUrl: string | null;
}

export interface OperationsInfo {
  readonly latestAttempt: WorkflowAttemptInfo | null;
  readonly lastSuccessfulRun: WorkflowAttemptInfo | null;
  readonly workflowUrl: string;
}

/* ------------------------------------------------------------ tournament */

export interface TournamentCandidate {
  readonly name: string;
  readonly developmentCagrPct: number | null;
  readonly developmentExcessCagrPct: number | null;
  readonly developmentSharpe: number | null;
  readonly developmentMaxDrawdownPct: number | null;
  readonly reusedExcessCagrPct: number | null;
  readonly eligibleChallenger: boolean;
  readonly isIncumbent: boolean;
}

export interface TournamentInfo {
  readonly epoch: number;
  readonly status: string;
  readonly decision: string;
  readonly productionChanged: boolean;
  readonly researchOnly: boolean;
  readonly generatedAt: string | null;
  readonly eligibleChallengerCount: number;
  readonly shadowChallenger: string | null;
  readonly primaryCostBps: number;
  readonly candidates: readonly TournamentCandidate[];
  readonly warnings: readonly { code: string; message: string }[];
  readonly protocolPath: string;
  readonly readAtRef: string;
}

/* ----------------------------------------------------------- convergence */

export type PositionClassification =
  | "TARGET"
  | "LEGACY_EXCLUDED"
  | "HELD_ONLY"
  | "UNMANAGED";

export type PositionLifecycle =
  | "KEEP"
  | "BUY"
  | "TOP_UP"
  | "TRIM"
  | "EXIT"
  | "PENDING"
  | "CONVERGED";

export interface PortfolioRow {
  readonly symbol: string;
  readonly qty: number | null;
  readonly marketValue: number | null;
  readonly actualWeightPct: number | null;
  readonly targetWeightPct: number | null;
  readonly deltaPct: number | null;
  readonly deltaValue: number | null;
  readonly sector: string | null;
  readonly unrealizedPl: number | null;
  readonly unrealizedPlPct: number | null;
  readonly classification: PositionClassification;
  readonly lifecycle: PositionLifecycle;
  readonly pendingSide: "buy" | "sell" | null;
}

export interface ConvergenceInfo {
  readonly rows: readonly PortfolioRow[];
  readonly targetCount: number;
  readonly actualCount: number;
  readonly convergedCount: number;
  readonly pendingCount: number;
  readonly targetGrossPct: number;
  readonly actualGrossPct: number | null;
  readonly targetCashPct: number;
  readonly actualCashPct: number | null;
  readonly nextSafeAction: string;
  readonly legacyExcludedSymbols: readonly string[];
}

/* ---------------------------------------------------------------- payload */

export interface StrategyStatusPayload {
  readonly schemaVersion: typeof STRATEGY_STATUS_SCHEMA_VERSION;
  readonly source: typeof STRATEGY_STATUS_SOURCE;
  readonly collectedAt: string;
  readonly accountId: string;
  readonly accountNickname: string;
  readonly accountMode: AccountMode;
  readonly web: Section<WebInfo>;
  readonly release: Section<ReleaseInfo>;
  readonly authorization: Section<AuthorizationInfo>;
  readonly accountBinding: Section<AccountBindingInfo>;
  readonly broker: Section<BrokerInfo>;
  readonly strategy: Section<StrategyRuntimeInfo>;
  readonly universe: Section<UniverseInfo>;
  readonly validation: Section<ValidationInfo>;
  readonly preflight: Section<PreflightInfo>;
  readonly execution: Section<ExecutionInfo>;
  readonly operations: Section<OperationsInfo>;
  readonly tournament: Section<TournamentInfo>;
  readonly convergence: Section<ConvergenceInfo>;
  /** Derived, single source of truth for "may V11 buy right now". */
  readonly validationGate: EffectiveValidationGate;
  readonly warnings: readonly string[];
}

/** Aggregate shell indicator, one per independent subsystem. */
export interface SystemIndicator {
  readonly key: "web" | "broker" | "runtime" | "scheduler" | "validation";
  readonly label: string;
  readonly state: Freshness | CheckState;
  readonly source: string;
  readonly scope: string;
  readonly asOf: string | null;
  readonly ageSeconds: number | null;
  readonly detail: string | null;
}
