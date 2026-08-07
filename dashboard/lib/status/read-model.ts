import "server-only";
import { V11_POLICY } from "@/lib/v11-policy";
import {
  LEGACY_DASHBOARD_ALLOWED,
  SUPABASE_CONFIGURED,
} from "@/lib/supabase/config";
import { readBindingConfig, resolveAccountBinding } from "./binding";
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
import { loadRuntimeBundle, RUNTIME_ARTIFACT_PREFIX, type RuntimeBundle } from "./runtime";
import type {
  BrokerInfo,
  ConvergenceInfo,
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
  classifyAge,
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
  readonly brokerAccountNumber: string | null;
}

function webInfo(): WebInfo {
  const accountBackendConfigured =
    SUPABASE_CONFIGURED && Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const explicitLegacyMode = !SUPABASE_CONFIGURED && LEGACY_DASHBOARD_ALLOWED;
  const buildSha =
    process.env.BUILD_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null;
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
 * runtime artifact name and labelled as such, so the UI never presents a
 * guess as the authoritative approval.
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
          "Derived from the runtime artifact name because the approved GitHub environment variable could not be read.",
      };
    }
  }

  return { sha: null, source: null, detail: null };
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

async function loadEpochBaseline(
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

/** Load the persisted V11 forward-validation epoch baseline, if one exists. */
export async function getEpochBaseline(
  approvedSha: string | null,
): Promise<V11EpochBaseline | null> {
  return loadEpochBaseline(approvedSha);
}

function buildStrategySection(
  bundle: RuntimeBundle,
  approvedSha: string | null,
  now: Date,
): Section<StrategyRuntimeInfo> {
  const scope = approvedSha
    ? `approved paper release ${approvedSha.slice(0, 12)} · production executor account`
    : "production executor account";
  const source = "github-actions artifact paper-runtime-state (server-only)";

  if (!bundle.performance || !bundle.lastRun) {
    const detail =
      bundle.errors[0] ??
      "the private V11 runtime state could not be read safely";
    return unavailable<StrategyRuntimeInfo>(
      source,
      scope,
      detail,
      bundle.lineageMismatch ? "MISMATCH" : "UNAVAILABLE",
    );
  }

  const performance = bundle.performance;
  const lastRun = bundle.lastRun;
  const plan = performance.plan;

  const executionRiskTier = lastRun.riskTier
    ? {
        tier: lastRun.riskTier,
        reason:
          bundle.preflight?.riskSnapshotReason ??
          "captured from a fresh broker account and rolling-history snapshot",
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
  const prov = provenance({
    source,
    scope,
    asOf,
    now,
    freshness: bundle.lineageMismatch
      ? "MISMATCH"
      : classifyAge(
          asOf === null ? null : Math.round((now.getTime() - Date.parse(asOf)) / 1000),
          CONTRACTS.runtime,
        ),
    detail: bundle.errors.length > 0 ? bundle.errors.join("; ") : null,
  });

  return section(prov, {
    strategyVersion: lastRun.strategyVersion,
    paperOnly: true,
    marketGate: plan ? (plan.riskOff ? "RISK_OFF" : "RISK_ON") : null,
    marketGateSource: plan
      ? "frozen V11 plan risk_off flag recorded by the runner at the signal close"
      : null,
    // The runner does not persist the SPY close, its SMA200 or the breadth
    // census. Recomputing them in TypeScript would duplicate the strategy, so
    // they stay explicitly unavailable until the runner exports them.
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
  });
}

function buildUniverseSection(
  bundle: RuntimeBundle,
  now: Date,
): Section<UniverseInfo> {
  const preflight = bundle.preflight;
  const plan = bundle.performance?.plan ?? null;
  if (!preflight && !plan) {
    return unavailable<UniverseInfo>(
      "github-actions artifact paper-diagnostics (server-only)",
      "ranking universe resolved by the production runner",
      "no preflight report or frozen plan is available",
    );
  }

  const asOf = preflight?.checkedAt ?? plan?.createdAt ?? null;
  const cacheState =
    preflight?.universeSource === "alpaca-cache"
      ? ("alpaca-cache" as const)
      : preflight?.universeSource === "validated-watchlist-fallback"
        ? ("validated-watchlist-fallback" as const)
        : null;

  const hashMismatch =
    preflight?.universeSha256 &&
    plan?.rankingUniverseSha256 &&
    preflight.universeSha256 !== plan.rankingUniverseSha256;

  return section(
    provenance({
      source: "production preflight report + frozen V11 plan",
      scope: "ranking universe used by the production executor",
      asOf,
      now,
      freshness: hashMismatch
        ? "MISMATCH"
        : classifyAge(
            asOf === null
              ? null
              : Math.round((now.getTime() - Date.parse(asOf)) / 1000),
            CONTRACTS.runtime,
          ),
      detail: hashMismatch
        ? "the preflight ranking-universe hash differs from the frozen plan's hash"
        : null,
    }),
    {
      source:
        preflight?.universeSource ??
        "unknown (recorded only in the preflight report)",
      symbolCount: preflight?.universeCount ?? null,
      rankingUniverseSha256:
        plan?.rankingUniverseSha256 ?? preflight?.universeSha256 ?? null,
      eligibleCount: plan?.eligibleCount ?? null,
      selectedCount: plan?.targets.length ?? null,
      cacheState,
    },
  );
}

function buildValidationSection(
  report: Omit<
    ValidationInfo,
    "identityMatchesRuntime" | "universeMatchesRuntime"
  > | null,
  bundle: RuntimeBundle,
  ref: string,
  now: Date,
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

  const runtimeIdentity =
    bundle.performance?.plan?.strategyIdentityValue ??
    bundle.preflight?.strategyIdentity ??
    null;
  const runtimeUniverse =
    bundle.performance?.plan?.rankingUniverseSha256 ??
    bundle.preflight?.universeSha256 ??
    null;

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

  return section(
    provenance({
      source,
      scope,
      asOf: report.generatedAt,
      now,
      freshness: mismatch
        ? "MISMATCH"
        : expired
          ? "EXPIRED"
          : nearExpiry
            ? "STALE"
            : "CURRENT",
      detail: mismatch
        ? "the promotion evidence does not match the running strategy or ranking universe"
        : expired
          ? "the promotion evidence is past its 35-day freshness deadline and can no longer authorize a paper buy"
          : nearExpiry
            ? "the promotion evidence expires within seven days"
            : null,
    }),
    { ...report, identityMatchesRuntime, universeMatchesRuntime },
  );
}

/** Assemble the complete, sanitized read model for one selected account. */
export async function buildStrategyStatus(input: {
  account: StatusAccount;
  broker: BrokerResult;
  now?: Date;
}): Promise<StrategyStatusPayload> {
  const now = input.now ?? new Date();
  const collectedAt = now.toISOString();
  const warnings: string[] = [];

  const web = section(
    provenance({
      source: "dashboard runtime configuration",
      scope: "this web deployment",
      asOf: collectedAt,
      now,
      freshness: "CURRENT",
    }),
    webInfo(),
  );

  if (!githubReadConfigured()) {
    warnings.push(
      "GITHUB_TOKEN is not configured on the dashboard server, so release, workflow, runtime and validation evidence cannot be read.",
    );
  }

  const [paperRuns, repositoryCommit] = await Promise.all([
    fetchWorkflowRuns(PAPER_WORKFLOW, { perPage: 20 }),
    fetchRefCommit(GITHUB_STATE_REF),
  ]);

  const latestRun = paperRuns?.[0] ?? null;
  const latestSuccessfulRun =
    paperRuns?.find((run) => run.conclusion === "success") ?? null;

  const approved = await resolveApprovedSha(latestSuccessfulRun);
  const approvedSha = approved.sha;

  const [releaseGateRuns, bundle, latestJobs] = await Promise.all([
    approvedSha
      ? fetchWorkflowRuns(RELEASE_WORKFLOW, { perPage: 10, headSha: approvedSha })
      : Promise.resolve(null),
    loadRuntimeBundle(approvedSha, latestSuccessfulRun),
    latestRun ? fetchRunJobs(latestRun.id) : Promise.resolve(null),
  ]);

  const gateRun = releaseGateRuns?.find((run) => run.conclusion === "success") ?? null;
  const releaseGate: CheckState = !approvedSha
    ? "UNAVAILABLE"
    : releaseGateRuns === null
      ? "UNAVAILABLE"
      : gateRun
        ? "PASS"
        : releaseGateRuns.some((run) => run.status !== "completed")
          ? "PENDING"
          : "FAIL";

  const buildSha = webInfo().dashboardBuildSha;
  const release = section(
    provenance({
      source:
        approved.source === "github-environment-variable"
          ? "GitHub paper-production environment variable"
          : approved.source === "server-environment"
            ? "dashboard server environment"
            : approved.source === "derived-from-runtime-artifact"
              ? "runtime artifact name"
              : "GitHub API",
      scope: "approved paper release and repository reference",
      asOf: gateRun?.updatedAt ?? repositoryCommit?.committedAt ?? collectedAt,
      now,
      freshness: approvedSha ? "CURRENT" : "UNAVAILABLE",
      detail:
        approved.detail ??
        (approvedSha ? null : "the approved paper release SHA could not be read"),
    }),
    approvedSha || repositoryCommit
      ? ({
          repositoryRefSha: repositoryCommit?.sha ?? null,
          repositoryRef: GITHUB_STATE_REF,
          repositoryRefCommittedAt: repositoryCommit?.committedAt ?? null,
          approvedPaperReleaseSha: approvedSha,
          approvedShaSource: approved.source,
          releaseGate,
          releaseGateRunUrl: gateRun?.url ?? null,
          releaseGateCompletedAt: gateRun?.updatedAt ?? null,
          dashboardMatchesApprovedRelease:
            buildSha && approvedSha ? buildSha === approvedSha : null,
        } satisfies ReleaseInfo)
      : null,
  );

  const binding = resolveAccountBinding({
    accountId: input.account.id,
    nickname: input.account.nickname,
    mode: input.account.mode,
    brokerAccountNumber: input.account.brokerAccountNumber,
    config: readBindingConfig(),
  });
  const accountBinding = section(
    provenance({
      source: "dashboard server binding configuration + Supabase account record",
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

  const strategy = buildStrategySection(bundle, approvedSha, now);
  const universe = buildUniverseSection(bundle, now);

  const validationRef = approvedSha ?? GITHUB_STATE_REF;
  const validationDocument = await fetchRepoJson<unknown>(
    "state/backtest/v11_validation.json",
    validationRef,
    600,
  );
  const validation = buildValidationSection(
    validationDocument ? parseValidation(validationDocument, validationRef) : null,
    bundle,
    validationRef,
    now,
  );

  const preflight: Section<PreflightInfo> = bundle.preflight
    ? section(
        provenance({
          source: "github-actions artifact paper-diagnostics (server-only)",
          scope: "last successful production preflight",
          asOf: bundle.preflight.checkedAt,
          now,
          freshness: classifyAge(
            bundle.preflight.checkedAt === null
              ? null
              : Math.round(
                  (now.getTime() - Date.parse(bundle.preflight.checkedAt)) / 1000,
                ),
            CONTRACTS.runtime,
          ),
          detail: null,
        }),
        bundle.preflight,
      )
    : unavailable<PreflightInfo>(
        "github-actions artifact paper-diagnostics (server-only)",
        "last successful production preflight",
        bundle.errors.find((error) => error.includes("preflight")) ??
          "no preflight report is available",
      );

  const execution: Section<ExecutionInfo> = bundle.lastRun
    ? section(
        provenance({
          source: "github-actions artifact paper-runtime-state (server-only)",
          scope: `last successful executor cycle · release ${(approvedSha ?? "").slice(0, 12)}`,
          asOf: bundle.lastRun.completedAt,
          now,
          freshness: classifyAge(
            bundle.lastRun.completedAt === null
              ? null
              : Math.round(
                  (now.getTime() - Date.parse(bundle.lastRun.completedAt)) / 1000,
                ),
            CONTRACTS.runtime,
          ),
          detail: null,
        }),
        executionFromLastRun(
          bundle.lastRun,
          latestSuccessfulRun ? actionsRunUrl(latestSuccessfulRun.id) : null,
        ),
      )
    : unavailable<ExecutionInfo>(
        "github-actions artifact paper-runtime-state (server-only)",
        "last successful executor cycle",
        bundle.errors[0] ?? "no executor run record is available",
      );

  const operations: Section<OperationsInfo> = paperRuns
    ? section(
        provenance({
          source: "GitHub Actions workflow runs",
          scope: PAPER_WORKFLOW,
          asOf: latestRun?.updatedAt ?? latestRun?.createdAt ?? null,
          now,
          freshness: classifyAge(
            latestRun?.updatedAt
              ? Math.round((now.getTime() - Date.parse(latestRun.updatedAt)) / 1000)
              : null,
            CONTRACTS.workflow,
          ),
          detail: null,
        }),
        {
          latestAttempt: latestRun ? toAttempt(latestRun, latestJobs) : null,
          lastSuccessfulRun: latestSuccessfulRun
            ? toAttempt(latestSuccessfulRun, null)
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
    "state/backtest/strategy_tournament_epoch_1.json",
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

  // Convergence compares the *production* plan with *this account's* holdings.
  // That is only meaningful for an account proven to be the executor's.
  const convergenceScope = `frozen plan vs ${input.account.nickname}`;
  const convergence = !binding.productionBound
    ? unavailable<ConvergenceInfo>(
        "frozen V11 plan + broker snapshot",
        convergenceScope,
        "this account is not proven to be the production executor account, so V11 target compliance does not apply to it",
        "NOT_APPLICABLE",
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

  if (bundle.lineageMismatch) {
    warnings.push(
      "A runtime artifact was found but its release lineage does not match the approved paper release. Strategy runtime data is withheld.",
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
    web,
    release,
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
    warnings,
  };
}
