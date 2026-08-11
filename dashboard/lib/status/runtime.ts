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
 * Named steps of `.github/workflows/paper-production.yml`.
 *
 * The preflight's diagnostics upload and the runtime-state upload both run
 * `if: always()`, so a step that reached a conclusion produced its output and
 * an artifact should exist.
 */
export const PREFLIGHT_STEP_NAME = "Verify paper broker and deployment health";
export const EXECUTE_STEP_NAME = "Execute one guarded paper cycle";
export const RUNTIME_UPLOAD_STEP_NAME = "Preserve private runtime state";

/**
 * What a run's jobs say about one named step.
 *
 * `DID_NOT_RUN` is the **only** verdict that lets an older artifact stand, and
 * it now requires GitHub to say so explicitly: the step is present, completed,
 * and concluded `skipped`. Everything else is `UNKNOWN`.
 *
 * That is deliberately narrow, and it is narrower than it used to be. The
 * previous version treated a missing step entry as proof the run ended before
 * reaching it. But GitHub omits steps for several different reasons — a job
 * that died mid-way lists only what it started, a cancelled job may list
 * nothing at all, and a renamed step is simply absent from every job — and
 * none of those is distinguishable from the others through this API. Treating
 * all of them as "it never ran" is how a newer failed cycle gets replaced on
 * screen by an older green one.
 *
 * The operational consequence is accepted: a run that fails before the
 * preflight (a release-verification failure, say) now makes the section
 * `UNAVAILABLE` rather than falling back. An operator seeing UNAVAILABLE goes
 * and looks; an operator seeing yesterday's PASS does not.
 */
export type StepOutcome =
  | {
      readonly kind: "RAN";
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    }
  | { readonly kind: "DID_NOT_RUN" }
  | { readonly kind: "UNKNOWN"; readonly detail: string };

/**
 * Resolve one named step within a specific run **attempt**.
 *
 * The attempt matters: a re-run keeps the run id, and its jobs describe
 * different work. Reading the latest attempt's steps to judge an older
 * attempt's artifact is the same substitution in a different disguise.
 */
export async function namedStepOutcome(
  run: WorkflowRunSummary,
  stepName: string,
): Promise<StepOutcome> {
  const jobs = await fetchRunJobs(run.id, run.attempt);
  if (jobs === null) {
    return {
      kind: "UNKNOWN",
      detail: `the jobs of run #${run.runNumber} attempt ${run.attempt} could not be listed`,
    };
  }
  if (jobs.length === 0) {
    return {
      kind: "UNKNOWN",
      detail: `run #${run.runNumber} attempt ${run.attempt} reports no jobs`,
    };
  }
  // A job still in flight can still reach the step. Its silence proves nothing.
  const unfinished = jobs.find((job) => job.status !== "completed");
  if (unfinished) {
    return {
      kind: "UNKNOWN",
      detail: `job "${unfinished.name}" has not completed, so its steps are not final`,
    };
  }

  const matches = jobs.flatMap((job) =>
    job.steps.filter((step) => step.name === stepName),
  );
  if (matches.length === 0) {
    // Never reached, never listed, or renamed — indistinguishable here.
    return {
      kind: "UNKNOWN",
      detail: `no step named "${stepName}" appears in run #${run.runNumber} attempt ${run.attempt}`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "UNKNOWN",
      detail: `more than one step named "${stepName}" appears in run #${run.runNumber}`,
    };
  }

  const step = matches[0];
  if (step.status !== "completed" || step.conclusion === null) {
    return {
      kind: "UNKNOWN",
      detail: `step "${stepName}" is ${step.status}/${step.conclusion ?? "no conclusion"}`,
    };
  }
  if (step.conclusion === "skipped") return { kind: "DID_NOT_RUN" };
  if (step.conclusion === "success" || step.conclusion === "failure") {
    return {
      kind: "RAN",
      startedAt: step.startedAt,
      completedAt: step.completedAt,
    };
  }
  // `cancelled`, and anything GitHub adds later. Neither ran nor provably not.
  return {
    kind: "UNKNOWN",
    detail: `step "${stepName}" concluded ${step.conclusion}`,
  };
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

/**
 * The newest matching artifact, **including expired ones**.
 *
 * There is deliberately no "newest usable" variant any more. Filtering expired
 * artifacts out made an expired artifact indistinguishable from an absent one,
 * so the walk stepped past the newest cycle and presented an older one as
 * current. An expired artifact is a reason to report UNAVAILABLE.
 */
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
 * Slack around a step's own window.
 *
 * A step's output is uploaded by a later step, and GitHub's API, runner and
 * storage do not share a clock to the second. A few minutes either side covers
 * that without covering a different cycle.
 */
const ARTIFACT_WINDOW_SLACK_MS = 15 * 60 * 1000;

/**
 * The window a named step's output must fall inside.
 *
 * `from` is the step's start; `to` is the run's end, because the upload runs
 * after the step. A null bound means the API did not state it, and an unstated
 * bound cannot be satisfied — every caller here treats that as a failure.
 */
interface OutputWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

function stepOutputWindow(
  step: Extract<StepOutcome, { kind: "RAN" }>,
  run: WorkflowRunSummary,
): OutputWindow | null {
  const from = step.startedAt ? Date.parse(step.startedAt) : NaN;
  const runEnd = run.updatedAt ? Date.parse(run.updatedAt) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(runEnd)) return null;
  return {
    fromMs: from - ARTIFACT_WINDOW_SLACK_MS,
    toMs: runEnd + ARTIFACT_WINDOW_SLACK_MS,
  };
}

/** The tighter window a *report timestamp* must fall inside: the step itself. */
function stepRunWindow(
  step: Extract<StepOutcome, { kind: "RAN" }>,
): OutputWindow | null {
  const from = step.startedAt ? Date.parse(step.startedAt) : NaN;
  const to = step.completedAt ? Date.parse(step.completedAt) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    fromMs: from - ARTIFACT_WINDOW_SLACK_MS,
    toMs: to + ARTIFACT_WINDOW_SLACK_MS,
  };
}

function withinWindow(instant: string | null, window: OutputWindow | null): boolean {
  if (window === null) return false;
  const parsed = instant ? Date.parse(instant) : NaN;
  if (!Number.isFinite(parsed)) return false;
  return parsed >= window.fromMs && parsed <= window.toMs;
}

/**
 * Whether this run's artifacts can be attributed to the attempt on screen.
 *
 * They cannot, past the first attempt. GitHub's artifact listing is
 * **run-level**: `/runs/{id}/artifacts` returns everything any attempt of that
 * run uploaded, with no attempt field to filter on. A re-run therefore serves
 * attempt 1's `paper-diagnostics` alongside attempt 2's, and nothing in the
 * response says which is which. The step-window check narrows it, but a re-run
 * started minutes later overlaps the same 15-minute slack, so it is a
 * heuristic and not a proof.
 *
 * The only thing that would settle it is the artifact naming or containing its
 * own `run_id` + `run_attempt` — and that lives in
 * `.github/workflows/paper-production.yml`, a strategy-identity source this
 * change may not touch. So the dashboard fails closed instead: any attempt
 * past the first is UNAVAILABLE, with a reason that says what would fix it.
 *
 * Attempt 1 is the overwhelmingly common case; the paper workflow has never
 * been re-run in the observed history.
 */
function attemptIsAttributable(run: WorkflowRunSummary): boolean {
  return run.attempt === 1;
}

const RERUN_DETAIL =
  "it is a re-run, and GitHub lists artifacts per run rather than per attempt, " +
  "so this build cannot prove which attempt produced them";

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
    if (!attemptIsAttributable(run)) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        errors: [
          `run #${run.runNumber} is attempt ${run.attempt}: ${RERUN_DETAIL}`,
        ],
      };
    }

    const artifacts = await fetchRunArtifacts(run.id);
    if (!artifacts) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        errors: ["GitHub Actions artifacts could not be listed"],
      };
    }

    // Expired artifacts are looked at too. Filtering them out made an expired
    // runtime artifact indistinguishable from a preflight-only run, so the
    // walk stepped past the newest cycle and showed an older one.
    const anyRuntime = newestAny(artifacts, (artifact) =>
      artifact.name.startsWith(RUNTIME_ARTIFACT_PREFIX),
    );

    if (!anyRuntime) {
      // The same tri-state question the preflight asks. A successful run with
      // no runtime state either never executed a cycle (a preflight-only
      // dispatch, where the execute step is explicitly `skipped`) or executed
      // one whose upload failed — and only the first supersedes nothing.
      const executed = await namedStepOutcome(run, EXECUTE_STEP_NAME);
      if (executed.kind === "DID_NOT_RUN") return null;
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        errors: [
          executed.kind === "RAN"
            ? `run #${run.runNumber} executed a guarded paper cycle but produced no runtime-state artifact`
            : `it could not be established whether run #${run.runNumber} executed a paper cycle: ${executed.detail}`,
        ],
      };
    }

    if (anyRuntime.expired) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        errors: [
          `the runtime-state artifact of run #${run.runNumber} has expired`,
        ],
      };
    }

    // The artifact must be datable to the step that wrote it, in this attempt.
    const upload = await namedStepOutcome(run, RUNTIME_UPLOAD_STEP_NAME);
    if (upload.kind !== "RAN") {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        errors: [
          upload.kind === "DID_NOT_RUN"
            ? `run #${run.runNumber} carries a runtime-state artifact although its upload step was skipped`
            : `the runtime-state artifact of run #${run.runNumber} could not be bound to its upload step: ${upload.detail}`,
        ],
      };
    }
    if (!withinWindow(anyRuntime.createdAt, stepOutputWindow(upload, run))) {
      return {
        ...EMPTY_EXECUTION_SELECTION,
        run,
        artifactName: anyRuntime.name,
        artifactCreatedAt: anyRuntime.createdAt,
        lineageMismatch: true,
        errors: [
          "the runtime-state artifact was not created inside the window of the step that uploads it",
        ],
      };
    }

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
      // The record says when the cycle finished; the step says when the cycle
      // could have finished. A `completed_at` outside that window describes a
      // different execution, whatever artifact it travelled in.
      const executeStep = await namedStepOutcome(run, EXECUTE_STEP_NAME);
      if (executeStep.kind !== "RAN") {
        return {
          ...EMPTY_EXECUTION_SELECTION,
          run,
          artifactName: anyRuntime.name,
          artifactCreatedAt: anyRuntime.createdAt,
          errors: [
            `the executor record of run #${run.runNumber} could not be bound to its execute step: ${
              executeStep.kind === "DID_NOT_RUN"
                ? "the step is recorded as skipped"
                : executeStep.detail
            }`,
          ],
        };
      }
      if (!withinWindow(lastRun.completedAt, stepRunWindow(executeStep))) {
        return {
          ...EMPTY_EXECUTION_SELECTION,
          run,
          artifactName: anyRuntime.name,
          artifactCreatedAt: anyRuntime.createdAt,
          lineageMismatch: true,
          errors: [
            "the executor record's completion time lies outside the window of the step that produced it",
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
    if (!attemptIsAttributable(run)) {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        errors: [
          `run #${run.runNumber} is attempt ${run.attempt}: ${RERUN_DETAIL}`,
        ],
      };
    }

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
      // The decisive question: did the preflight step run? Only an explicit
      // `completed + skipped` lets an older report stand.
      const evidence = await namedStepOutcome(run, PREFLIGHT_STEP_NAME);
      if (evidence.kind === "DID_NOT_RUN") return null;
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        errors: [
          evidence.kind === "RAN"
            ? `run #${run.runNumber} ran its preflight step but uploaded no diagnostics artifact`
            : `it could not be established whether run #${run.runNumber} reached its preflight step: ${evidence.detail}`,
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
    // Bound to the step, in this attempt — not merely to the run. A re-run
    // keeps the id, and the run's window spans both attempts' work.
    const preflightStep = await namedStepOutcome(run, PREFLIGHT_STEP_NAME);
    if (preflightStep.kind !== "RAN") {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        artifactCreatedAt: diagnostics.createdAt,
        errors: [
          preflightStep.kind === "DID_NOT_RUN"
            ? `run #${run.runNumber} carries a diagnostics artifact although its preflight step was skipped`
            : `the diagnostics artifact of run #${run.runNumber} could not be bound to its preflight step: ${preflightStep.detail}`,
        ],
      };
    }
    if (!withinWindow(diagnostics.createdAt, stepOutputWindow(preflightStep, run))) {
      return {
        ...EMPTY_PREFLIGHT_SELECTION,
        run,
        artifactCreatedAt: diagnostics.createdAt,
        lineageMismatch: true,
        errors: [
          "the preflight diagnostics artifact was not created inside the window of the step that produces it",
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
      // `checked_at` must fall inside the preflight step itself, not merely
      // inside the run: a report stamped outside it describes a different
      // execution of the runner.
      if (!withinWindow(preflight.checkedAt, stepRunWindow(preflightStep))) {
        return {
          ...EMPTY_PREFLIGHT_SELECTION,
          run,
          artifactCreatedAt: diagnostics.createdAt,
          lineageMismatch: true,
          errors: [
            "the preflight report's checked_at lies outside the window of the step that produced it",
          ],
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
