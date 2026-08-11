import "server-only";
import {
  artifactSizeIsAcceptable,
  downloadArtifactZip,
  fetchRunArtifacts,
  fetchRunJobs,
  type ArtifactMeta,
  type WorkflowRunSummary,
} from "./github-api";
import {
  parseLastRun,
  parsePerformanceRuntime,
  parsePreflight,
  type LastRunSnapshot,
  type PerformanceRuntimeSnapshot,
} from "./parse";
import type { PreflightInfo } from "./types";
import { readJsonEntries, ZipError } from "./zip";

/**
 * Safe readers for the private V11 runtime artifacts.
 *
 * The executor result and the preflight report are selected **independently**.
 * A manual `operation=preflight` run produces diagnostics but no runtime state,
 * and it must not hide an older, still-valid execution; equally, a newer
 * preflight is the right thing to show next to an older execution. Each
 * selection therefore carries its own run, URL and timestamp.
 *
 * Selection is fail-closed on lineage: the newest successful run that carries
 * *any* runtime-state artifact decides. If that artifact is not named for the
 * approved release, or its recorded release disagrees, nothing is returned and
 * the caller reports MISMATCH — an older artifact is never silently
 * substituted, because a disagreement means production and approval have
 * diverged.
 */

export const RUNTIME_ARTIFACT_PREFIX = "paper-runtime-state-";
export const DIAGNOSTICS_ARTIFACT_NAME = "paper-diagnostics";

/** The runtime artifact must contain exactly these three files. */
const RUNTIME_CONTRACT = {
  required: [
    "performance.json",
    "positions.json",
    "production/last_run.json",
  ],
  exact: true,
} as const;

/** The diagnostics artifact has an explicit required/optional allowlist. */
const DIAGNOSTICS_CONTRACT = {
  required: ["production-preflight.json"],
  optional: ["production-execution.json"],
  ignored: ["production-dry-run.log"],
} as const;

const DIAGNOSTICS_ENTRY = "production-preflight.json";

/**
 * Paging bounds for the scan.
 *
 * A long series of manual preflight-only runs must not hide a still-valid
 * executor cycle, so the scan pages rather than stopping after a fixed count.
 * It stops at an explicit freshness boundary instead: a cycle older than this
 * is outside the runtime contract anyway and would be reported STALE/EXPIRED.
 */
export const RUN_SCAN_MAX_PAGES = 10;
export const RUN_SCAN_PAGE_SIZE = 100;
export const RUN_SCAN_LOOKBACK_DAYS = 45;

/** Supplies successive pages of runs, newest first. Page numbers are 1-based. */
export type RunPageSource = (
  page: number,
) => Promise<readonly WorkflowRunSummary[] | null>;

function olderThanLookback(run: WorkflowRunSummary, now: Date): boolean {
  const stamp = run.updatedAt ?? run.createdAt;
  if (!stamp) return false;
  const parsed = Date.parse(stamp);
  if (!Number.isFinite(parsed)) return false;
  return now.getTime() - parsed > RUN_SCAN_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Walk runs newest-first across pages, calling `visit` on each run `accept`
 * admits, until `visit` returns a result, the freshness boundary is crossed,
 * or pages run out.
 */
async function scanRuns<T>(
  source: RunPageSource,
  now: Date,
  accept: (run: WorkflowRunSummary) => boolean,
  visit: (run: WorkflowRunSummary) => Promise<T | null>,
): Promise<{ result: T | null; listFailed: boolean; exhausted: boolean }> {
  for (let page = 1; page <= RUN_SCAN_MAX_PAGES; page++) {
    const runs = await source(page);
    if (runs === null) return { result: null, listFailed: true, exhausted: false };
    if (runs.length === 0) return { result: null, listFailed: false, exhausted: true };

    for (const run of runs) {
      if (olderThanLookback(run, now)) {
        return { result: null, listFailed: false, exhausted: true };
      }
      if (!accept(run)) continue;
      const found = await visit(run);
      if (found !== null) return { result: found, listFailed: false, exhausted: false };
    }
    if (runs.length < RUN_SCAN_PAGE_SIZE) {
      return { result: null, listFailed: false, exhausted: true };
    }
  }
  return { result: null, listFailed: false, exhausted: false };
}

/** The executor result is only meaningful from a run that actually succeeded. */
const SUCCEEDED = (run: WorkflowRunSummary) =>
  run.status === "completed" && run.conclusion === "success";

/**
 * The workflow step that produces `production-preflight.json`.
 *
 * `.github/workflows/paper-production.yml`, step
 * "Verify paper broker and deployment health". Its diagnostics upload runs
 * `if: always()`, so if this step reached a conclusion a report was written
 * and an artifact should exist.
 */
export const PREFLIGHT_STEP_NAME = "Verify paper broker and deployment health";

/**
 * Whether a run's preflight step actually executed.
 *
 * `DID_NOT_RUN` is the *only* evidence that lets an older preflight stand. A
 * completed run with no diagnostics is not self-explanatory: the step may have
 * run and the upload failed, in which case the newest report exists and is
 * simply unreachable — and showing an older green one instead would be exactly
 * the substitution this module refuses to make.
 */
export type PreflightStepEvidence = "RAN" | "DID_NOT_RUN" | "UNKNOWN";

export async function preflightStepEvidence(
  runId: number,
): Promise<PreflightStepEvidence> {
  const jobs = await fetchRunJobs(runId);
  // Not knowing is not the same as knowing it did not run.
  if (jobs === null) return "UNKNOWN";
  // A completed run that reports no jobs at all is an anomaly, not evidence.
  // Observed live: a cancelled run whose single job carried an empty step
  // list. Neither shape proves the preflight was skipped.
  if (jobs.length === 0) return "UNKNOWN";

  let sawStepList = false;
  for (const job of jobs) {
    if (job.steps.length > 0) sawStepList = true;
    const step = job.steps.find((entry) => entry.name === PREFLIGHT_STEP_NAME);
    if (!step) continue;
    // `skipped` and `cancelled` mean it never produced a report.
    if (step.status === "completed" && step.conclusion !== null &&
        step.conclusion !== "skipped" && step.conclusion !== "cancelled") {
      return "RAN";
    }
    return "DID_NOT_RUN";
  }
  // Jobs exist and their steps are listed, but the preflight step is not among
  // them: the run ended before reaching it. That is provable non-execution.
  return sawStepList ? "DID_NOT_RUN" : "UNKNOWN";
}

/**
 * A preflight is meaningful from *any* completed run.
 *
 * The preflight runs before the executor and writes its report whatever
 * happens afterwards — indeed a run usually fails *because* the preflight
 * refused. Filtering on `conclusion === "success"` therefore skipped exactly
 * the reports that matter and fell back to an older green one, so the screen
 * showed a passing preflight while production had just refused to trade.
 */
const COMPLETED = (run: WorkflowRunSummary) => run.status === "completed";

export interface ExecutionSelection {
  readonly performance: PerformanceRuntimeSnapshot | null;
  readonly lastRun: LastRunSnapshot | null;
  readonly run: WorkflowRunSummary | null;
  readonly artifactName: string | null;
  readonly artifactCreatedAt: string | null;
  readonly errors: readonly string[];
  readonly lineageMismatch: boolean;
}

export interface PreflightSelection {
  readonly preflight: PreflightInfo | null;
  readonly run: WorkflowRunSummary | null;
  readonly artifactCreatedAt: string | null;
  readonly errors: readonly string[];
  readonly lineageMismatch: boolean;
}

export const EMPTY_EXECUTION_SELECTION: ExecutionSelection = {
  performance: null,
  lastRun: null,
  run: null,
  artifactName: null,
  artifactCreatedAt: null,
  errors: [],
  lineageMismatch: false,
};

export const EMPTY_PREFLIGHT_SELECTION: PreflightSelection = {
  preflight: null,
  run: null,
  artifactCreatedAt: null,
  errors: [],
  lineageMismatch: false,
};

function newestUsable(
  artifacts: readonly ArtifactMeta[],
  predicate: (artifact: ArtifactMeta) => boolean,
): ArtifactMeta | null {
  const usable = artifacts
    .filter((artifact) => !artifact.expired && predicate(artifact))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return usable[0] ?? null;
}

/** The newest matching artifact *including* expired ones. */
function newestAny(
  artifacts: readonly ArtifactMeta[],
  predicate: (artifact: ArtifactMeta) => boolean,
): ArtifactMeta | null {
  const all = [...artifacts]
    .filter(predicate)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return all[0] ?? null;
}

/**
 * Slack around a run's own window for an artifact upload.
 *
 * An artifact is created by a step inside the run, so its timestamp must fall
 * within the run — a few minutes either side for the upload itself and for
 * clock differences between GitHub's services.
 */
const ARTIFACT_WINDOW_SLACK_MS = 15 * 60 * 1000;

/**
 * True when the artifact was created inside the run that supposedly produced
 * it. An artifact from outside that window is not this run's output, whatever
 * the API attached it to.
 */
function artifactWithinRunWindow(
  artifact: ArtifactMeta,
  run: WorkflowRunSummary,
): boolean {
  const created = artifact.createdAt ? Date.parse(artifact.createdAt) : NaN;
  if (!Number.isFinite(created)) return false;
  const started = run.runStartedAt ? Date.parse(run.runStartedAt) : NaN;
  const ended = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return false;
  return (
    created >= started - ARTIFACT_WINDOW_SLACK_MS &&
    created <= ended + ARTIFACT_WINDOW_SLACK_MS
  );
}

/**
 * Latest successful executor cycle whose private runtime artifact is bound to
 * the approved release.
 */
export async function selectLatestExecution(
  approvedReleaseSha: string | null,
  source: RunPageSource,
  now: Date = new Date(),
): Promise<ExecutionSelection> {
  if (!approvedReleaseSha) {
    return {
      ...EMPTY_EXECUTION_SELECTION,
      errors: [
        "the approved paper release SHA is unknown, so no artifact can be bound to it",
      ],
    };
  }

  const expectedName = `${RUNTIME_ARTIFACT_PREFIX}${approvedReleaseSha}`;

  const scan = await scanRuns<ExecutionSelection>(
    source,
    now,
    SUCCEEDED,
    async (run) => {
    const artifacts = await fetchRunArtifacts(run.id);
    if (!artifacts) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        errors: ["GitHub Actions artifacts could not be listed"],
      };
    }

    const anyRuntime = newestUsable(artifacts, (artifact) =>
      artifact.name.startsWith(RUNTIME_ARTIFACT_PREFIX),
    );
    // A preflight-only run carries no runtime state at all; keep looking.
    if (!anyRuntime) return null;

    if (anyRuntime.name !== expectedName) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        lineageMismatch: true,
        errors: [
          "the newest runtime artifact is not named for the approved paper release",
        ],
      };
    }
    if (!artifactSizeIsAcceptable(anyRuntime)) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        errors: ["the runtime artifact's advertised size is not acceptable"],
      };
    }

    const zip = await downloadArtifactZip(anyRuntime);
    if (!zip) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        errors: ["the private runtime artifact could not be downloaded"],
      };
    }

    try {
      const entries = readJsonEntries(zip, RUNTIME_CONTRACT);
      const lastRun = parseLastRun(entries["production/last_run.json"]);
      if (!lastRun) {
        return {
          ...EMPTY_EXECUTION_SELECTION,
          run,
          artifactName: anyRuntime.name,
          artifactCreatedAt: anyRuntime.createdAt,
          errors: ["the runtime artifact's run record failed schema validation"],
        };
      }
      if (lastRun.releaseSha !== approvedReleaseSha) {
        return {
          ...EMPTY_EXECUTION_SELECTION,
          run,
          artifactName: anyRuntime.name,
          artifactCreatedAt: anyRuntime.createdAt,
          lineageMismatch: true,
          errors: [
            "the runtime artifact's recorded release does not match the approved paper release",
          ],
        };
      }
      const performance = parsePerformanceRuntime(entries["performance.json"]);
      if (!performance) {
        return {
          ...EMPTY_EXECUTION_SELECTION,
          run,
          artifactName: anyRuntime.name,
          artifactCreatedAt: anyRuntime.createdAt,
          errors: ["the runtime performance state failed schema validation"],
        };
      }
      return {
        performance,
        lastRun,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        errors: [],
        lineageMismatch: false,
      };
    } catch (caught) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        errors: [
          caught instanceof ZipError
            ? `the private runtime artifact is unreadable: ${caught.message}`
            : "the private runtime artifact could not be parsed",
        ],
      };
    }
    },
  );

  if (scan.result) return scan.result;
  return {
    ...EMPTY_EXECUTION_SELECTION,
    errors: [
      scan.listFailed
        ? "GitHub Actions artifacts could not be listed"
        : `no successful run with a runtime-state artifact was found within the last ${RUN_SCAN_LOOKBACK_DAYS} days`,
    ],
  };
}

/**
 * The **latest completed** preflight report, whatever its run concluded.
 *
 * Independent of the executor selection: a newer manual preflight run
 * legitimately supersedes only the preflight, and a newer *failed* run's
 * preflight supersedes an older passing one. The first completed run that
 * carries a diagnostics artifact is the answer — if that report is corrupt,
 * schema-invalid or lineage-mismatched, the selection fails closed rather
 * than searching backwards for a greener one.
 *
 * A newer completed run with **no** diagnostics artifact is skipped: it
 * demonstrably ended before a preflight report existed (an infrastructure
 * failure, or a job that never reached the preflight step), so it supersedes
 * nothing.
 */
export async function selectLatestPreflight(
  source: RunPageSource,
  expectedStrategyIdentity: string | null,
  now: Date = new Date(),
): Promise<PreflightSelection> {
  const scan = await scanRuns<PreflightSelection>(
    source,
    now,
    COMPLETED,
    async (run) => {
    const artifacts = await fetchRunArtifacts(run.id);
    if (!artifacts) {
      // Not knowing what this run produced is not evidence that it produced
      // nothing, so the walk stops here rather than reaching past it.
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        errors: [
          "GitHub Actions artifacts could not be listed for the newest completed run",
        ],
      };
    }

    // Expired artifacts are looked at too: an expired newest report is a
    // reason to report UNAVAILABLE, never a reason to show an older one.
    const anyDiagnostics = newestAny(
      artifacts,
      (artifact) => artifact.name === DIAGNOSTICS_ARTIFACT_NAME,
    );

    if (!anyDiagnostics) {
      // The decisive question: did the preflight step run? Only provable
      // non-execution lets an older report stand.
      const evidence = await preflightStepEvidence(run.id);
      if (evidence === "DID_NOT_RUN") return null;
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        errors: [
          evidence === "RAN"
            ? "the newest completed run ran its preflight step but uploaded no diagnostics artifact"
            : "it could not be established whether the newest completed run reached its preflight step",
        ],
      };
    }

    if (anyDiagnostics.expired) {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        artifactCreatedAt: anyDiagnostics.createdAt,
        errors: [
          "the newest completed run's preflight diagnostics artifact has expired",
        ],
      };
    }

    const diagnostics = anyDiagnostics;
    if (!artifactWithinRunWindow(diagnostics, run)) {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        artifactCreatedAt: diagnostics.createdAt,
        lineageMismatch: true,
        errors: [
          "the preflight diagnostics artifact was not created inside the run it is attached to",
        ],
      };
    }
    if (!artifactSizeIsAcceptable(diagnostics)) {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        artifactCreatedAt: diagnostics.createdAt,
        errors: [
          "the preflight diagnostics artifact's advertised size is not acceptable",
        ],
      };
    }

    const zip = await downloadArtifactZip(diagnostics);
    if (!zip) {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        artifactCreatedAt: diagnostics.createdAt,
        errors: ["the preflight diagnostics artifact could not be downloaded"],
      };
    }

    try {
      const entries = readJsonEntries(zip, DIAGNOSTICS_CONTRACT);
      const preflight = parsePreflight(entries[DIAGNOSTICS_ENTRY], run.url);
      if (!preflight) {
        return {
          ...EMPTY_PREFLIGHT_SELECTION,
          run,
          artifactCreatedAt: diagnostics.createdAt,
          errors: ["the preflight report failed schema validation"],
        };
      }
      if (
        expectedStrategyIdentity !== null &&
        preflight.strategyIdentity !== null &&
        preflight.strategyIdentity !== expectedStrategyIdentity
      ) {
        return {
          ...EMPTY_PREFLIGHT_SELECTION,
          run,
          artifactCreatedAt: diagnostics.createdAt,
          lineageMismatch: true,
          errors: [
            "the preflight strategy identity does not match the approved release's validated identity",
          ],
        };
      }
      return {
        preflight,
        run,
        artifactCreatedAt: diagnostics.createdAt,
        errors: [],
        lineageMismatch: false,
      };
    } catch (caught) {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        artifactCreatedAt: diagnostics.createdAt,
        errors: [
          caught instanceof ZipError
            ? `the preflight diagnostics artifact is unreadable: ${caught.message}`
            : "the preflight diagnostics artifact could not be parsed",
        ],
      };
    }
    },
  );

  if (scan.result) return scan.result;
  return {
    ...EMPTY_PREFLIGHT_SELECTION,
    errors: [
      scan.listFailed
        ? "GitHub Actions artifacts could not be listed"
        : `no completed run with a preflight report was found within the last ${RUN_SCAN_LOOKBACK_DAYS} days`,
    ],
  };
}
