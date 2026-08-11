import "server-only";
import { V11_POLICY } from "@/lib/v11-policy";
import {
  LEGACY_DASHBOARD_ALLOWED,
  SUPABASE_CONFIGURED,
} from "@/lib/supabase/config";
import {
  authorizeProductionRuntime,
  readProductionAuthzConfig,
  type ProductionAuthorization,
} from "./authz";
import { resolveAccountBinding } from "./binding";
import type { BrokerResult } from "./broker";
import { buildConvergence } from "./convergence";
import {
  actionsRunUrl,
  fetchEnvironmentVariable,
  fetchRefCommit,
  fetchRunArtifacts,
  fetchRunJobs,
  fetchRepoJson,
  fetchWorkflowRuns,
  githubReadConfigured,
  GITHUB_STATE_REF,
  workflowUrl,
  type WorkflowRunSummary,
} from "./github-api";
import { executionFromLastRun, parseTournament, parseValidation } from "./parse";
import { parseEpochBaseline, type V11EpochBaseline } from "./performance";
import {
  evaluateLineage,
  lineageWithholdState,
  LINEAGE_OK,
  type LineageVerdict,
} from "./lineage";
import {
  RUN_SCAN_PAGE_SIZE,
  RUNTIME_ARTIFACT_PREFIX,
  selectLatestExecution,
  selectLatestPreflight,
  type ExecutionSelection,
  type PreflightSelection,
  type RunPageSource,
} from "./runtime";
import type {
  AuthorizationInfo,
  BrokerInfo,
  ConvergenceInfo,
  EffectiveValidationGate,
  ExecutionInfo,
  OperationsInfo,
  PreflightInfo,
  ReleaseInfo,
  StrategyRuntimeInfo,
  StrategyStatusPayload,
  TournamentInfo,
  UniverseInfo,
  ValidationInfo,
  WebInfo,
  WorkflowAttemptInfo,
} from "./types";
import {
  STRATEGY_STATUS_SCHEMA_VERSION,
  STRATEGY_STATUS_SOURCE,
} from "./types";
import {
  computeEffectiveValidationGate,
  NOT_APPLICABLE_GATE,
} from "./validation-gate";
import {
  classifyAge,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  DAY,
  HOUR,
  isFullSha,
  MINUTE,
  provenance,
  section,
  unavailable,
  type CheckState,
  type Section,
} from "./vocab";

export const PAPER_WORKFLOW = "paper-production.yml";
export const RELEASE_WORKFLOW = "v11-release.yml";
export const PAPER_ENVIRONMENT = "paper-production";
export const EPOCH_BASELINE_PATH = "state/v11_epoch_baseline.json";
export const VALIDATION_PATH = "state/backtest/v11_validation.json";
export const TOURNAMENT_PATH = "state/backtest/strategy_tournament_epoch_1.json";

const RUNTIME_SOURCE = "github-actions artifact paper-runtime-state (server-only)";
const DIAGNOSTICS_SOURCE =
  "github-actions artifact paper-diagnostics (server-only)";

/** Freshness contracts, one per independently ageing source. */
export const CONTRACTS = {
  broker: { staleAfterSeconds: 5 * MINUTE },
  runtime: { staleAfterSeconds: 36 * HOUR, expiredAfterSeconds: 7 * DAY },
  workflow: { staleAfterSeconds: 36 * HOUR, expiredAfterSeconds: 7 * DAY },
  repository: { staleAfterSeconds: 30 * DAY },
} as const;

export interface StatusAccount {
  readonly id: string;
  readonly nickname: string;
  readonly mode: "paper" | "live";
  /** Service-role read of `accounts.owner_id`; never client-supplied. */
  readonly ownerId: string | null;
}

export interface StatusViewer {
  readonly userId: string;
}

function ageSeconds(asOf: string | null, now: Date): number | null {
  if (!asOf) return null;
  const parsed = Date.parse(asOf);
  if (!Number.isFinite(parsed)) return null;
  return Math.round((now.getTime() - parsed) / 1000);
}

function webInfo(): WebInfo {
  const accountBackendConfigured =
    SUPABASE_CONFIGURED && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const explicitLegacyMode = !SUPABASE_CONFIGURED && LEGACY_DASHBOARD_ALLOWED;
  // The dashboard is self-hosted from `dashboard/Dockerfile`; `BUILD_SHA` is
  // the only supported source. Without it the build SHA is honestly unknown
  // rather than guessed from a hosting provider's variable.
  const buildSha = process.env.BUILD_SHA ?? null;
  return {
    dashboardBuildSha: buildSha && buildSha !== "unknown" ? buildSha : null,
    dataMode: accountBackendConfigured
      ? "account-scoped"
      : explicitLegacyMode
        ? "legacy-explicit"
        : "unavailable",
    status: accountBackendConfigured || explicitLegacyMode ? "ok" : "misconfigured",
    strategyVersion: V11_POLICY.strategyVersion,
  };
}

export interface ApprovedRelease {
  readonly sha: string | null;
  readonly source: ReleaseInfo["approvedShaSource"];
  readonly detail: string | null;
  /**
   * True only for the two sources a human explicitly approved. A SHA derived
   * from an artifact name is a display convenience and can never satisfy the
   * effective validation gate.
   */
  readonly authoritative: boolean;
}

/**
 * The authoritative approval sources only (no artifact-name derivation), for
 * callers that must not pay for a workflow-run lookup.
 */
export async function getApprovedReleaseSha(): Promise<ApprovedRelease> {
  return resolveApprovedSha(null);
}

/**
 * Resolve the approved paper release SHA.
 *
 * The authoritative source is the `paper-production` environment variable. A
 * server env override exists for deployments whose token cannot read
 * environment variables. As a last resort the SHA is *derived* from the
 * runtime artifact name and flagged non-authoritative, so the UI never
 * presents a guess as an approval.
 */
async function resolveApprovedSha(
  latestSuccessfulRun: WorkflowRunSummary | null,
): Promise<ApprovedRelease> {
  if (githubReadConfigured()) {
    const fromEnvironment = await fetchEnvironmentVariable(
      PAPER_ENVIRONMENT,
      "PRODUCTION_RELEASE_SHA",
    );
    if (isFullSha(fromEnvironment)) {
      return {
        sha: fromEnvironment.trim(),
        source: "github-environment-variable",
        detail: null,
        authoritative: true,
      };
    }
  }

  const fromServerEnv = process.env.PRODUCTION_RELEASE_SHA?.trim();
  if (isFullSha(fromServerEnv)) {
    return {
      sha: fromServerEnv,
      source: "server-environment",
      detail:
        "Read from the dashboard's own server configuration, not from the GitHub environment.",
      authoritative: true,
    };
  }

  if (latestSuccessfulRun) {
    const artifacts = await fetchRunArtifacts(latestSuccessfulRun.id);
    const runtimeArtifact = artifacts?.find((artifact) =>
      artifact.name.startsWith(RUNTIME_ARTIFACT_PREFIX),
    );
    const derived = runtimeArtifact?.name.slice(RUNTIME_ARTIFACT_PREFIX.length);
    if (isFullSha(derived)) {
      return {
        sha: derived,
        source: "derived-from-runtime-artifact",
        detail:
          "Derived from the runtime artifact name because the approved GitHub environment variable could not be read. This is not an approval and cannot satisfy the effective validation gate.",
        authoritative: false,
      };
    }
  }

  return { sha: null, source: null, detail: null, authoritative: false };
}

type CanonicalValidation = Omit<
  ValidationInfo,
  "identityMatchesRuntime" | "universeMatchesRuntime"
>;

/**
 * The canonical promotion report at an explicit ref.
 *
 * Read before the preflight selection so its recorded strategy identity and
 * ranking universe can be the authority everything else is compared against —
 * a cycle with no frozen plan still has to describe the validated strategy.
 */
async function readCanonicalValidation(
  approvedSha: string | null,
): Promise<CanonicalValidation | null> {
  const ref = approvedSha ?? GITHUB_STATE_REF;
  const document = await fetchRepoJson<unknown>(VALIDATION_PATH, ref, 600);
  return document ? parseValidation(document, ref) : null;
}

function toAttempt(
  run: WorkflowRunSummary,
  jobs: { stepCount: number }[] | null,
): WorkflowAttemptInfo {
  const succeeded = run.conclusion === "success";
  const noStepsRan =
    jobs !== null && (jobs.length === 0 || jobs.every((job) => job.stepCount === 0));
  const infrastructureFailure = !succeeded && run.status === "completed" && noStepsRan;
  return {
    runId: run.id,
    runNumber: run.runNumber,
    attempt: run.attempt,
    status: run.status,
    conclusion: run.conclusion,
    startedAt: run.runStartedAt,
    completedAt: run.status === "completed" ? run.updatedAt : null,
    triggerSha: run.headSha,
    event: run.event,
    url: run.url,
    infrastructureFailure,
    failureKind: succeeded
      ? null
      : infrastructureFailure
        ? "infrastructure"
        : "strategy-or-broker",
  };
}

/** Load the persisted V11 forward-validation epoch baseline, if one exists. */
export async function getEpochBaseline(
  approvedSha: string | null,
): Promise<V11EpochBaseline | null> {
  const inline = process.env.V11_EPOCH_BASELINE?.trim();
  if (inline) {
    try {
      const parsed = parseEpochBaseline(JSON.parse(inline));
      if (parsed) return parsed;
    } catch {
      // Malformed server configuration must not fabricate a baseline.
    }
  }
  const ref = approvedSha ?? GITHUB_STATE_REF;
  const document = await fetchRepoJson<unknown>(EPOCH_BASELINE_PATH, ref, 600);
  return document ? parseEpochBaseline(document) : null;
}

/* ------------------------------------------------------------- sections */

function strategySection(
  execution: ExecutionSelection,
  approvedSha: string | null,
  lineage: LineageVerdict,
  now: Date,
): Section<StrategyRuntimeInfo> {
  const scope = approvedSha
    ? `approved paper release ${approvedSha.slice(0, 12)} · production executor account`
    : "production executor account";

  // A lineage disagreement is fail-closed: no plan, no risk state, no numbers.
  if (!lineage.ok) {
    return unavailable<StrategyRuntimeInfo>(
      RUNTIME_SOURCE,
      scope,
      lineage.detail ??
        execution.errors[0] ??
        "the runtime artifact does not belong to the approved paper release",
      lineageWithholdState(lineage),
    );
  }
  if (!execution.performance || !execution.lastRun) {
    return unavailable<StrategyRuntimeInfo>(
      RUNTIME_SOURCE,
      scope,
      execution.errors[0] ?? "the private V11 runtime state could not be read safely",
    );
  }

  const { performance, lastRun } = execution;
  const plan = performance.plan;

  const executionRiskTier = lastRun.riskTier
    ? {
        tier: lastRun.riskTier,
        reason: "captured from a fresh broker account and rolling-history snapshot",
        source: "production run record (authoritative for that cycle)",
        asOf: lastRun.completedAt,
      }
    : null;
  const persistedRiskTier = performance.riskTier
    ? {
        tier: performance.riskTier,
        reason: performance.riskTierReason,
        source: "saved runtime performance.json",
        asOf: performance.riskTierUpdated ?? performance.updatedAt,
      }
    : null;

  const asOf = lastRun.completedAt ?? performance.updatedAt;
  return section(
    provenance({
      source: RUNTIME_SOURCE,
      scope: execution.run
        ? `${scope} · run #${execution.run.runNumber}`
        : scope,
      asOf,
      now,
      freshness: classifyAge(ageSeconds(asOf, now), CONTRACTS.runtime),
      detail: execution.errors.length > 0 ? execution.errors.join("; ") : null,
    }),
    {
      strategyVersion: lastRun.strategyVersion,
      paperOnly: true,
      marketGate: plan ? (plan.riskOff ? "RISK_OFF" : "RISK_ON") : null,
      marketGateSource: plan
        ? "frozen V11 plan risk_off flag recorded by the runner at the signal close"
        : null,
      // The runner does not persist the SPY close, its SMA200 or the breadth
      // census. Recomputing them here would duplicate the strategy.
      spyClose: null,
      spySma200: null,
      breadthPct: null,
      breadthNumerator: null,
      breadthDenominator: null,
      breadthMultiplierPct: null,
      recoveryLatchArmed: performance.recoveryLatchArmed,
      rollingDrawdownPct: performance.rollingDrawdownPct,
      rollingPeakEquity: performance.rollingPeakEquity,
      riskLookbackSessions: performance.riskLookbackSessions,
      executionRiskTier,
      persistedRiskTier,
      riskTierConflict:
        executionRiskTier !== null &&
        persistedRiskTier !== null &&
        executionRiskTier.tier !== persistedRiskTier.tier,
      plan,
      runtimeEquity: performance.equity,
      runtimeCash: performance.cash,
      runtimePositionCount: performance.numPositions,
      runtimeSnapshotAt: performance.updatedAt,
    },
  );
}

function universeSection(
  execution: ExecutionSelection,
  preflight: PreflightSelection,
  lineage: LineageVerdict,
  now: Date,
): Section<UniverseInfo> {
  const scope = "ranking universe used by the production executor";
  const source = "production preflight report + frozen V11 plan";

  if (!lineage.ok) {
    return unavailable<UniverseInfo>(
      source,
      scope,
      lineage.detail ??
        "the ranking universe cannot be attributed while release lineage disagrees",
      lineageWithholdState(lineage),
    );
  }

  const report = preflight.preflight;
  const plan = execution.performance?.plan ?? null;
  if (!report && !plan) {
    return unavailable<UniverseInfo>(
      source,
      scope,
      "no preflight report or frozen plan is available",
    );
  }

  const asOf = report?.checkedAt ?? plan?.createdAt ?? null;
  const cacheState =
    report?.universeSource === "alpaca-cache"
      ? ("alpaca-cache" as const)
      : report?.universeSource === "validated-watchlist-fallback"
        ? ("validated-watchlist-fallback" as const)
        : null;

  return section(
    provenance({
      source,
      scope,
      asOf,
      now,
      freshness: classifyAge(ageSeconds(asOf, now), CONTRACTS.runtime),
      detail: null,
    }),
    {
      source:
        report?.universeSource ?? "unknown (recorded only in the preflight report)",
      symbolCount: report?.universeCount ?? null,
      rankingUniverseSha256:
        plan?.rankingUniverseSha256 ?? report?.universeSha256 ?? null,
      eligibleCount: plan?.eligibleCount ?? null,
      selectedCount: plan?.targets.length ?? null,
      cacheState,
    },
  );
}

function validationSection(
  report: Omit<
    ValidationInfo,
    "identityMatchesRuntime" | "universeMatchesRuntime"
  > | null,
  execution: ExecutionSelection,
  preflight: PreflightSelection,
  ref: string,
  now: Date,
  authorized: boolean,
  lineage: LineageVerdict,
): Section<ValidationInfo> {
  const source = "repository state/backtest/v11_validation.json";
  const scope = `canonical fixed-strategy promotion evidence · read at ${ref.slice(0, 12)}`;
  if (!report) {
    return unavailable<ValidationInfo>(
      source,
      scope,
      "the canonical validation report could not be read or failed schema validation",
    );
  }

  // Identity/universe matching is only meaningful against a runtime the viewer
  // is allowed to see. Otherwise both stay explicitly unknown.
  const comparable = authorized && lineage.ok;
  const runtimeIdentity = comparable
    ? (execution.performance?.plan?.strategyIdentityValue ??
      preflight.preflight?.strategyIdentity ??
      null)
    : null;
  const runtimeUniverse = comparable
    ? (execution.performance?.plan?.rankingUniverseSha256 ??
      preflight.preflight?.universeSha256 ??
      null)
    : null;

  const identityMatchesRuntime: CheckState =
    runtimeIdentity === null || report.strategyIdentityValue === null
      ? "UNAVAILABLE"
      : runtimeIdentity === report.strategyIdentityValue
        ? "PASS"
        : "FAIL";
  const universeMatchesRuntime: CheckState =
    runtimeUniverse === null || report.rankingUniverseSha256 === null
      ? "UNAVAILABLE"
      : runtimeUniverse === report.rankingUniverseSha256
        ? "PASS"
        : "FAIL";

  const expiresAtMs = report.expiresAt ? Date.parse(report.expiresAt) : NaN;
  const expired = Number.isFinite(expiresAtMs) && now.getTime() > expiresAtMs;
  const nearExpiry =
    Number.isFinite(expiresAtMs) &&
    !expired &&
    expiresAtMs - now.getTime() < 7 * DAY * 1000;
  const mismatch =
    identityMatchesRuntime === "FAIL" || universeMatchesRuntime === "FAIL";

  // The report must be able to say when it was produced, and that must not be
  // in the future. Without a usable `generated_at` the whole freshness
  // calculation — including the 35-day deadline — rests on nothing, so the
  // section cannot be CURRENT however green its contents look.
  const generatedAtMs = report.generatedAt ? Date.parse(report.generatedAt) : NaN;
  const generatedAtMissing = !Number.isFinite(generatedAtMs);
  const generatedAtFuture =
    Number.isFinite(generatedAtMs) &&
    generatedAtMs - now.getTime() > CLOCK_SKEW_TOLERANCE_SECONDS * 1000;

  return section(
    provenance({
      source,
      scope,
      asOf: report.generatedAt,
      now,
      freshness: mismatch || generatedAtFuture
        ? "MISMATCH"
        : generatedAtMissing
          ? "UNAVAILABLE"
          : expired
            ? "EXPIRED"
            : nearExpiry
              ? "STALE"
              : "CURRENT",
      detail: mismatch
        ? "the promotion evidence does not match the running strategy or ranking universe"
        : generatedAtFuture
          ? "the promotion evidence claims to have been generated in the future"
          : generatedAtMissing
            ? "the promotion evidence has no usable generation timestamp, so its freshness cannot be established"
            : expired
              ? "the promotion evidence is past its 35-day freshness deadline and can no longer authorize a paper buy"
              : nearExpiry
                ? "the promotion evidence expires within seven days"
                : null,
    }),
    { ...report, identityMatchesRuntime, universeMatchesRuntime },
  );
}

/* ------------------------------------------------------------- assembly */

/** Assemble the complete, sanitized read model for one viewer and account. */
export async function buildStrategyStatus(input: {
  viewer: StatusViewer;
  account: StatusAccount;
  broker: BrokerResult;
  now?: Date;
}): Promise<StrategyStatusPayload> {
  const now = input.now ?? new Date();
  const collectedAt = now.toISOString();
  const warnings: string[] = [];
  const web = webInfo();

  const webSection = section(
    provenance({
      source: "dashboard runtime configuration",
      scope: "this web deployment",
      asOf: collectedAt,
      now,
      freshness: "CURRENT",
    }),
    web,
  );

  // ---- authorization decides everything below, before any Actions call ----
  const authorization: ProductionAuthorization = authorizeProductionRuntime({
    viewerUserId: input.viewer.userId,
    accountId: input.account.id,
    accountOwnerId: input.account.ownerId,
    mode: input.account.mode,
    liveBrokerAccountNumber: input.broker.ok ? input.broker.accountNumber : null,
    config: readProductionAuthzConfig(),
  });
  const authorized = authorization.authorized;

  const authorizationSection = section(
    provenance({
      source: "dashboard server authorization configuration",
      scope: `viewer ${input.viewer.userId.slice(0, 8)}… · account ${input.account.nickname}`,
      asOf: collectedAt,
      now,
      freshness: authorized ? "CURRENT" : "NOT_APPLICABLE",
      detail: authorization.detail,
    }),
    {
      productionRuntimeAuthorized: authorized,
      denialReason: authorization.reason,
      detail: authorization.detail,
    } satisfies AuthorizationInfo,
  );

  const binding = resolveAccountBinding({
    accountId: input.account.id,
    nickname: input.account.nickname,
    mode: input.account.mode,
    liveBrokerAccountNumber: input.broker.ok ? input.broker.accountNumber : null,
    authorization,
  });
  const accountBinding = section(
    provenance({
      source: "dashboard server authorization + fresh Alpaca account read",
      scope: `selected account ${input.account.nickname}`,
      asOf: collectedAt,
      now,
      freshness: "CURRENT",
      detail: binding.bindingDetail,
    }),
    binding,
  );

  const broker: Section<BrokerInfo> = input.broker.ok
    ? section(
        provenance({
          source: `Alpaca ${input.account.mode} REST snapshot`,
          scope: `selected account ${input.account.nickname}`,
          asOf: input.broker.fetchedAt,
          now,
          freshness: classifyAge(0, CONTRACTS.broker),
          detail: null,
        }),
        input.broker.snapshot,
      )
    : unavailable(
        `Alpaca ${input.account.mode} REST snapshot`,
        `selected account ${input.account.nickname}`,
        input.broker.detail,
      );

  if (authorized && !githubReadConfigured()) {
    warnings.push(
      "GITHUB_TOKEN is not configured on the dashboard server, so release, workflow, runtime and validation evidence cannot be read.",
    );
  }

  // Repository metadata is public and viewer-independent.
  const repositoryCommit = await fetchRefCommit(GITHUB_STATE_REF);

  const notAuthorizedDetail = authorization.detail;
  const withheld = <T,>(source: string, scope: string): Section<T> =>
    unavailable<T>(source, scope, notAuthorizedDetail, "NOT_APPLICABLE");

  let approved: ApprovedRelease = {
    sha: null,
    source: null,
    detail: null,
    authoritative: false,
  };
  let paperRuns: readonly WorkflowRunSummary[] | null = null;
  let latestRun: WorkflowRunSummary | null = null;
  let latestJobs: { stepCount: number }[] | null = null;
  let executionSelection: ExecutionSelection = {
    performance: null,
    lastRun: null,
    run: null,
    artifactName: null,
    artifactCreatedAt: null,
    errors: [],
    lineageMismatch: false,
  };
  let preflightSelection: PreflightSelection = {
    preflight: null,
    run: null,
    artifactCreatedAt: null,
    errors: [],
    lineageMismatch: false,
  };
  let releaseGate: CheckState = "NOT_APPLICABLE";
  let gateRun: WorkflowRunSummary | null = null;
  let canonicalReport: CanonicalValidation | null = null;

  if (authorized) {
    // Paged source: a long run of manual preflight-only invocations must not
    // hide a still-valid executor cycle, so the scan pages rather than looking
    // at a fixed prefix.
    const runPage: RunPageSource = (page) =>
      fetchWorkflowRuns(PAPER_WORKFLOW, {
        perPage: RUN_SCAN_PAGE_SIZE,
        page,
      });

    paperRuns = await runPage(1);
    latestRun = paperRuns?.[0] ?? null;
    const latestSuccessfulRun =
      paperRuns?.find((run) => run.conclusion === "success") ?? null;

    approved = await resolveApprovedSha(latestSuccessfulRun);

    // The canonical report is read first, because it — not the frozen plan —
    // is the authority a preflight's identity must agree with. A cycle that
    // produced no plan still has to describe the validated strategy.
    canonicalReport = await readCanonicalValidation(approved.sha);

    // Independent selection: a manual preflight-only run must not hide an
    // older, still-valid execution, and vice versa.
    executionSelection = await selectLatestExecution(approved.sha, runPage, now);
    preflightSelection = await selectLatestPreflight(
      runPage,
      canonicalReport?.strategyIdentityValue ??
        executionSelection.performance?.plan?.strategyIdentityValue ??
        null,
      now,
    );
    latestJobs = latestRun
      ? await fetchRunJobs(latestRun.id, latestRun.attempt)
      : null;

    // A release gate is only a gate when a *push* run for the exact approved
    // commit completed successfully. A pull-request or manual dispatch success
    // never authorizes a release.
    if (approved.sha) {
      const gateRuns = await fetchWorkflowRuns(RELEASE_WORKFLOW, {
        perPage: 20,
        headSha: approved.sha,
        event: "push",
      });
      if (gateRuns === null) {
        releaseGate = "UNAVAILABLE";
      } else {
        const pushRuns = gateRuns.filter(
          (run) => run.event === "push" && run.headSha === approved.sha,
        );
        gateRun =
          pushRuns.find(
            (run) => run.status === "completed" && run.conclusion === "success",
          ) ?? null;
        releaseGate = gateRun
          ? "PASS"
          : pushRuns.some((run) => run.status !== "completed")
            ? "PENDING"
            : "FAIL";
      }
    } else {
      releaseGate = "UNAVAILABLE";
    }
  }

  const release = section(
    provenance({
      source: authorized
        ? approved.source === "github-environment-variable"
          ? "GitHub paper-production environment variable"
          : approved.source === "server-environment"
            ? "dashboard server environment"
            : approved.source === "derived-from-runtime-artifact"
              ? "runtime artifact name"
              : "GitHub API"
        : "GitHub repository metadata",
      scope: "approved paper release and repository reference",
      asOf: gateRun?.updatedAt ?? repositoryCommit?.committedAt ?? collectedAt,
      now,
      freshness: authorized
        ? approved.sha
          ? "CURRENT"
          : "UNAVAILABLE"
        : "NOT_APPLICABLE",
      detail: authorized
        ? (approved.detail ??
          (approved.sha ? null : "the approved paper release SHA could not be read"))
        : notAuthorizedDetail,
    }),
    {
      repositoryRefSha: repositoryCommit?.sha ?? null,
      repositoryRef: GITHUB_STATE_REF,
      repositoryRefCommittedAt: repositoryCommit?.committedAt ?? null,
      approvedPaperReleaseSha: approved.sha,
      approvedShaSource: approved.source,
      releaseGate,
      releaseGateRunUrl: gateRun?.url ?? null,
      releaseGateCompletedAt: gateRun?.updatedAt ?? null,
      dashboardMatchesApprovedRelease:
        web.dashboardBuildSha && approved.sha
          ? web.dashboardBuildSha === approved.sha
          : null,
    } satisfies ReleaseInfo,
  );

  // One shared verdict, cross-checking every mandatory lineage field across
  // the preflight, the frozen plan and the executor record.
  const crossChecked: LineageVerdict = authorized
    ? evaluateLineage({
        approvedReleaseSha: approved.sha,
        performance: executionSelection.performance,
        lastRun: executionSelection.lastRun,
        preflight: preflightSelection.preflight,
        runtimeArtifactName: executionSelection.artifactName,
        expectedRuntimeArtifactName: approved.sha
          ? `${RUNTIME_ARTIFACT_PREFIX}${approved.sha}`
          : null,
        // The canonical report is the authority for identity and universe, and
        // unlike the frozen plan it exists between rebalances too.
        validated: canonicalReport
          ? {
              strategyIdentity: canonicalReport.strategyIdentityValue,
              rankingUniverseSha256: canonicalReport.rankingUniverseSha256,
            }
          : null,
        now,
      })
    : LINEAGE_OK;

  // A selector that already refused a document (wrong artifact name, wrong
  // recorded release, preflight identity conflict) is itself a lineage
  // failure. Fold it into the one verdict every section consumes, so a
  // selector-level refusal can never leave another section CURRENT.
  const selectorRefusal =
    executionSelection.lineageMismatch || preflightSelection.lineageMismatch;
  const lineage: LineageVerdict = selectorRefusal
    ? {
        ok: false,
        status: "MISMATCH",
        conflicts: crossChecked.conflicts,
        detail:
          crossChecked.detail ??
          executionSelection.errors[0] ??
          preflightSelection.errors[0] ??
          "release or strategy lineage does not agree",
      }
    : crossChecked;
  const lineageBroken = !lineage.ok;

  const strategy = authorized
    ? strategySection(executionSelection, approved.sha, lineage, now)
    : withheld<StrategyRuntimeInfo>(RUNTIME_SOURCE, "production executor account");

  const universe = authorized
    ? universeSection(executionSelection, preflightSelection, lineage, now)
    : withheld<UniverseInfo>(
        "production preflight report + frozen V11 plan",
        "ranking universe used by the production executor",
      );

  const validationRef = authorized
    ? (approved.sha ?? GITHUB_STATE_REF)
    : GITHUB_STATE_REF;
  // Authorized viewers already read it above; an unauthorized viewer reads the
  // repository default so the research page still works.
  const parsedValidation = authorized
    ? canonicalReport
    : await readCanonicalValidation(null);
  const validation = validationSection(
    parsedValidation,
    executionSelection,
    preflightSelection,
    validationRef,
    now,
    authorized,
    lineage,
  );

  const validationGate: EffectiveValidationGate = authorized
    ? computeEffectiveValidationGate({
        report: validation.data,
        approvedReleaseSha: approved.sha,
        approvedReleaseAuthoritative: approved.authoritative,
        lineageOk: !lineageBroken,
        // The executor's own gate result, bound to the cycle it ran in.
        preflight: preflightSelection.preflight,
        preflightRunId: preflightSelection.run?.id ?? null,
        preflightAttempt: preflightSelection.run?.attempt ?? null,
        executionRunId: executionSelection.run?.id ?? null,
        executionAttempt: executionSelection.run?.attempt ?? null,
        now,
      })
    : NOT_APPLICABLE_GATE;

  const preflight: Section<PreflightInfo> = !authorized
    ? withheld<PreflightInfo>(
        DIAGNOSTICS_SOURCE,
        "latest completed production preflight",
      )
    : lineageBroken
      ? unavailable<PreflightInfo>(
          DIAGNOSTICS_SOURCE,
          "latest completed production preflight",
          lineage.detail ??
            preflightSelection.errors[0] ??
            "the preflight report does not match the running strategy identity",
          lineageWithholdState(lineage),
        )
      : preflightSelection.preflight
        ? section(
            provenance({
              source: DIAGNOSTICS_SOURCE,
              scope: preflightSelection.run
                ? `latest completed preflight · run #${preflightSelection.run.runNumber} (${preflightSelection.run.event}, ${preflightSelection.run.conclusion ?? "unknown"})`
                : "latest completed production preflight",
              asOf: preflightSelection.preflight.checkedAt,
              now,
              freshness: classifyAge(
                ageSeconds(preflightSelection.preflight.checkedAt, now),
                CONTRACTS.runtime,
              ),
              detail: null,
            }),
            preflightSelection.preflight,
          )
        : unavailable<PreflightInfo>(
            DIAGNOSTICS_SOURCE,
            "latest completed production preflight",
            preflightSelection.errors[0] ?? "no preflight report is available",
          );

  const execution: Section<ExecutionInfo> = !authorized
    ? withheld<ExecutionInfo>(RUNTIME_SOURCE, "last successful executor cycle")
    : lineageBroken
      ? unavailable<ExecutionInfo>(
          RUNTIME_SOURCE,
          "last successful executor cycle",
          lineage.detail ??
            executionSelection.errors[0] ??
            "the executor record does not belong to the approved paper release",
          lineageWithholdState(lineage),
        )
      : executionSelection.lastRun
        ? section(
            provenance({
              source: RUNTIME_SOURCE,
              scope: executionSelection.run
                ? `last successful executor cycle · run #${executionSelection.run.runNumber} · release ${(approved.sha ?? "").slice(0, 12)}`
                : "last successful executor cycle",
              asOf: executionSelection.lastRun.completedAt,
              now,
              freshness: classifyAge(
                ageSeconds(executionSelection.lastRun.completedAt, now),
                CONTRACTS.runtime,
              ),
              detail: null,
            }),
            executionFromLastRun(
              executionSelection.lastRun,
              executionSelection.run
                ? actionsRunUrl(executionSelection.run.id)
                : null,
            ),
          )
        : unavailable<ExecutionInfo>(
            RUNTIME_SOURCE,
            "last successful executor cycle",
            executionSelection.errors[0] ?? "no executor run record is available",
          );

  const operations: Section<OperationsInfo> = !authorized
    ? withheld<OperationsInfo>("GitHub Actions workflow runs", PAPER_WORKFLOW)
    : paperRuns
      ? section(
          provenance({
            source: "GitHub Actions workflow runs",
            scope: PAPER_WORKFLOW,
            asOf: latestRun?.updatedAt ?? latestRun?.createdAt ?? null,
            now,
            freshness: classifyAge(
              ageSeconds(latestRun?.updatedAt ?? null, now),
              CONTRACTS.workflow,
            ),
            detail: null,
          }),
          {
            latestAttempt: latestRun ? toAttempt(latestRun, latestJobs) : null,
            lastSuccessfulRun: executionSelection.run
              ? toAttempt(executionSelection.run, null)
              : null,
            workflowUrl: workflowUrl(PAPER_WORKFLOW),
          } satisfies OperationsInfo,
        )
      : unavailable<OperationsInfo>(
          "GitHub Actions workflow runs",
          PAPER_WORKFLOW,
          "the workflow run history could not be read",
        );

  const tournamentDocument = await fetchRepoJson<unknown>(
    TOURNAMENT_PATH,
    GITHUB_STATE_REF,
    900,
  );
  const tournamentInfo = tournamentDocument
    ? parseTournament(tournamentDocument, GITHUB_STATE_REF)
    : null;
  const tournament: Section<TournamentInfo> = tournamentInfo
    ? section(
        provenance({
          source: "repository state/backtest/strategy_tournament_epoch_1.json",
          scope: `frozen epoch-1 research evidence · read at ${GITHUB_STATE_REF}`,
          asOf: tournamentInfo.generatedAt,
          now,
          freshness: "CURRENT",
          detail:
            "A completed, frozen research experiment. Its methodology and metrics are separate from the canonical validator.",
        }),
        tournamentInfo,
      )
    : unavailable<TournamentInfo>(
        "repository state/backtest/strategy_tournament_epoch_1.json",
        "frozen epoch-1 research evidence",
        "the tournament evidence could not be read or failed schema validation",
      );

  const convergenceScope = `frozen plan vs ${input.account.nickname}`;
  const convergence: Section<ConvergenceInfo> = !authorized
    ? withheld<ConvergenceInfo>("frozen V11 plan + broker snapshot", convergenceScope)
    : lineageBroken
      ? unavailable<ConvergenceInfo>(
          "frozen V11 plan + broker snapshot",
          convergenceScope,
          lineage.detail ??
            "convergence is not computed while release lineage disagrees",
          lineageWithholdState(lineage),
        )
      : strategy.data?.plan && input.broker.ok
        ? section<ConvergenceInfo>(
            provenance({
              source: "frozen V11 plan (runtime artifact) + fresh broker snapshot",
              scope: convergenceScope,
              asOf: input.broker.fetchedAt,
              now,
              freshness:
                strategy.provenance.freshness === "CURRENT" ? "CURRENT" : "STALE",
              detail:
                strategy.provenance.freshness === "CURRENT"
                  ? null
                  : "the broker snapshot is fresh but the frozen plan is older than its contract",
            }),
            buildConvergence(strategy.data.plan, input.broker.snapshot),
          )
        : unavailable<ConvergenceInfo>(
            "frozen V11 plan + broker snapshot",
            convergenceScope,
            !input.broker.ok
              ? input.broker.detail
              : "no frozen V11 plan is available from the private runtime artifact",
          );

  if (lineageBroken) {
    warnings.push(
      `Production lineage does not agree, so every dependent section is withheld: ${lineage.detail}.`,
    );
  }
  if (
    release.data?.dashboardMatchesApprovedRelease === false &&
    release.data.approvedPaperReleaseSha
  ) {
    warnings.push(
      "The deployed dashboard build and the approved paper release are different commits. That is expected: they are independent deployables.",
    );
  }

  return {
    schemaVersion: STRATEGY_STATUS_SCHEMA_VERSION,
    source: STRATEGY_STATUS_SOURCE,
    collectedAt,
    accountId: input.account.id,
    accountNickname: input.account.nickname,
    accountMode: input.account.mode,
    web: webSection,
    release,
    authorization: authorizationSection,
    accountBinding,
    broker,
    strategy,
    universe,
    validation,
    preflight,
    execution,
    operations,
    tournament,
    convergence,
    validationGate,
    warnings,
  };
}
