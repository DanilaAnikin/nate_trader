import "server-only";
import {
  artifactSizeIsAcceptable,
  downloadArtifactZip,
  fetchRunArtifacts,
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

/** How many recent successful runs to scan before giving up. */
const MAX_RUNS_SCANNED = 12;

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

function successfulRuns(
  runs: readonly WorkflowRunSummary[],
): WorkflowRunSummary[] {
  return runs
    .filter((run) => run.status === "completed" && run.conclusion === "success")
    .slice(0, MAX_RUNS_SCANNED);
}

/**
 * Latest successful executor cycle whose private runtime artifact is bound to
 * the approved release.
 */
export async function selectLatestExecution(
  approvedReleaseSha: string | null,
  runs: readonly WorkflowRunSummary[],
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
  const errors: string[] = [];

  for (const run of successfulRuns(runs)) {
    const artifacts = await fetchRunArtifacts(run.id);
    if (!artifacts) {
      errors.push("GitHub Actions artifacts could not be listed");
      break;
    }

    const anyRuntime = newestUsable(artifacts, (artifact) =>
      artifact.name.startsWith(RUNTIME_ARTIFACT_PREFIX),
    );
    // A preflight-only run carries no runtime state at all; keep looking.
    if (!anyRuntime) continue;

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
  }

  return {
    ...EMPTY_EXECUTION_SELECTION,
    errors:
      errors.length > 0
        ? errors
        : ["no successful run with a runtime-state artifact was found"],
  };
}

/**
 * Latest successful preflight report. Independent of the executor selection —
 * a newer manual preflight run legitimately supersedes only the preflight.
 */
export async function selectLatestPreflight(
  runs: readonly WorkflowRunSummary[],
  expectedStrategyIdentity: string | null,
): Promise<PreflightSelection> {
  const errors: string[] = [];

  for (const run of successfulRuns(runs)) {
    const artifacts = await fetchRunArtifacts(run.id);
    if (!artifacts) {
      errors.push("GitHub Actions artifacts could not be listed");
      break;
    }
    const diagnostics = newestUsable(
      artifacts,
      (artifact) => artifact.name === DIAGNOSTICS_ARTIFACT_NAME,
    );
    if (!diagnostics) continue;
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
            "the preflight strategy identity does not match the frozen plan's identity",
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
  }

  return {
    ...EMPTY_PREFLIGHT_SELECTION,
    errors:
      errors.length > 0
        ? errors
        : ["no successful run with a preflight report was found"],
  };
}
