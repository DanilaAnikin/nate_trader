import "server-only";
import {
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
 * Safe reader for the private V11 runtime artifacts.
 *
 * The artifact is selected by the *approved release SHA*, never by the trigger
 * SHA of the run that happened to be scheduled. Name, release lineage, schema,
 * size and the exact expected entry list are all validated before anything is
 * used, and only sanitized DTOs leave this module.
 */

export const RUNTIME_ARTIFACT_PREFIX = "paper-runtime-state-";
export const DIAGNOSTICS_ARTIFACT_NAME = "paper-diagnostics";

const RUNTIME_ENTRIES = [
  "performance.json",
  "positions.json",
  "production/last_run.json",
] as const;

const DIAGNOSTICS_ENTRY = "production-preflight.json";

export interface RuntimeBundle {
  readonly performance: PerformanceRuntimeSnapshot | null;
  readonly lastRun: LastRunSnapshot | null;
  readonly preflight: PreflightInfo | null;
  readonly runtimeArtifactName: string | null;
  readonly runtimeArtifactCreatedAt: string | null;
  readonly diagnosticsCreatedAt: string | null;
  /** Non-secret reasons a part of the bundle is unavailable or mismatched. */
  readonly errors: readonly string[];
  readonly lineageMismatch: boolean;
}

export const EMPTY_RUNTIME_BUNDLE: RuntimeBundle = {
  performance: null,
  lastRun: null,
  preflight: null,
  runtimeArtifactName: null,
  runtimeArtifactCreatedAt: null,
  diagnosticsCreatedAt: null,
  errors: [],
  lineageMismatch: false,
};

function pick(
  artifacts: readonly ArtifactMeta[],
  predicate: (artifact: ArtifactMeta) => boolean,
): ArtifactMeta | null {
  const usable = artifacts.filter(
    (artifact) => !artifact.expired && predicate(artifact),
  );
  if (usable.length === 0) return null;
  usable.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return usable[0];
}

/**
 * Load the runtime state and preflight diagnostics produced by one specific
 * successful paper-production run.
 *
 * Binding the artifact to its own run removes the ambiguity of the shared,
 * non-SHA-scoped `paper-diagnostics` artifact name.
 */
export async function loadRuntimeBundle(
  approvedReleaseSha: string | null,
  run: WorkflowRunSummary | null,
): Promise<RuntimeBundle> {
  if (!run) {
    return {
      ...EMPTY_RUNTIME_BUNDLE,
      errors: ["no successful paper-production run was found"],
    };
  }
  if (!approvedReleaseSha) {
    return {
      ...EMPTY_RUNTIME_BUNDLE,
      errors: [
        "the approved paper release SHA is unknown, so no artifact can be bound to it",
      ],
    };
  }

  const artifacts = await fetchRunArtifacts(run.id);
  if (!artifacts) {
    return {
      ...EMPTY_RUNTIME_BUNDLE,
      errors: ["GitHub Actions artifacts could not be listed"],
    };
  }

  const expectedName = `${RUNTIME_ARTIFACT_PREFIX}${approvedReleaseSha}`;
  const runtimeArtifact = pick(
    artifacts,
    (artifact) => artifact.name === expectedName,
  );
  const diagnosticsArtifact = pick(
    artifacts,
    (artifact) => artifact.name === DIAGNOSTICS_ARTIFACT_NAME,
  );

  const errors: string[] = [];
  let performance: PerformanceRuntimeSnapshot | null = null;
  let lastRun: LastRunSnapshot | null = null;
  let lineageMismatch = false;

  if (!runtimeArtifact) {
    const mismatched = artifacts.find((artifact) =>
      artifact.name.startsWith(RUNTIME_ARTIFACT_PREFIX),
    );
    if (mismatched) {
      lineageMismatch = true;
      errors.push(
        "the run's runtime artifact is not named for the approved paper release",
      );
    } else {
      errors.push("no runtime-state artifact is attached to this run");
    }
  } else {
    const zip = await downloadArtifactZip(runtimeArtifact.id);
    if (!zip) {
      errors.push("the private runtime artifact could not be downloaded");
    } else {
      try {
        const entries = readJsonEntries(zip, RUNTIME_ENTRIES);
        const parsedRun = parseLastRun(entries["production/last_run.json"]);
        if (!parsedRun) {
          errors.push("the runtime artifact's run record failed schema validation");
        } else if (parsedRun.releaseSha !== approvedReleaseSha) {
          lineageMismatch = true;
          errors.push(
            "the runtime artifact's recorded release does not match the approved paper release",
          );
        } else {
          lastRun = parsedRun;
          performance = parsePerformanceRuntime(entries["performance.json"]);
          if (!performance) {
            errors.push("the runtime performance state failed schema validation");
          }
        }
      } catch (caught) {
        errors.push(
          caught instanceof ZipError
            ? `the private runtime artifact is unreadable: ${caught.message}`
            : "the private runtime artifact could not be parsed",
        );
      }
    }
  }

  let preflight: PreflightInfo | null = null;
  if (!diagnosticsArtifact) {
    errors.push("no preflight diagnostics artifact is attached to this run");
  } else {
    const zip = await downloadArtifactZip(diagnosticsArtifact.id);
    if (!zip) {
      errors.push("the preflight diagnostics artifact could not be downloaded");
    } else {
      try {
        const entries = readJsonEntries(zip, [DIAGNOSTICS_ENTRY]);
        preflight = parsePreflight(entries[DIAGNOSTICS_ENTRY], run.url);
        if (!preflight) {
          errors.push("the preflight report failed schema validation");
        } else if (
          lastRun &&
          preflight.strategyIdentity &&
          performance?.plan &&
          preflight.strategyIdentity !== performance.plan.strategyIdentityValue
        ) {
          lineageMismatch = true;
          errors.push(
            "the preflight strategy identity does not match the frozen plan's identity",
          );
        }
      } catch (caught) {
        errors.push(
          caught instanceof ZipError
            ? `the preflight diagnostics artifact is unreadable: ${caught.message}`
            : "the preflight diagnostics artifact could not be parsed",
        );
      }
    }
  }

  return {
    performance,
    lastRun,
    preflight,
    runtimeArtifactName: runtimeArtifact?.name ?? null,
    runtimeArtifactCreatedAt: runtimeArtifact?.createdAt ?? null,
    diagnosticsCreatedAt: diagnosticsArtifact?.createdAt ?? null,
    errors,
    lineageMismatch,
  };
}
