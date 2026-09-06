import "server-only";
import { MAX_ARCHIVE_BYTES } from "./zip";
import { isRfc3339 } from "@/lib/calendar-date";

/**
 * Server-only GitHub reader for the observability read model.
 *
 * The token never leaves the server: every consumer is a Route Handler or a
 * Server Component, and only sanitized DTOs are serialized to the browser.
 * Every call is read-only — this module has no code path that can dispatch a
 * workflow, change a variable, or otherwise mutate the trading release.
 */

const API_ROOT = "https://api.github.com";

export const GITHUB_REPO =
  process.env.GITHUB_REPO || "DanilaAnikin/nate_trader";
export const GITHUB_STATE_REF = process.env.GITHUB_STATE_REF || "main";

function token(): string | null {
  const value = process.env.GITHUB_TOKEN?.trim();
  return value ? value : null;
}

export function githubReadConfigured(): boolean {
  return token() !== null;
}

/** Small in-process TTL cache: artifacts change at most once per weekday. */
const cache = new Map<string, { expiresAt: number; value: unknown }>();
const MAX_CACHE_ENTRIES = 64;

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { expiresAt: Date.now() + ttlSeconds * 1000, value });
}

/** Drop every cached GitHub response (used by the explicit refresh action). */
export function clearGithubCache(): void {
  cache.clear();
}

/* ------------------------------------------------------- strict readers */

/**
 * Why these are strict rather than tolerant.
 *
 * Every listing below feeds a *newest wins* selector. Dropping an entry that
 * cannot be read does not shorten a list; it promotes the next entry into the
 * position the selector reads, so a malformed newest artifact silently becomes
 * yesterday's artifact and yesterday's PASS is presented as today's. That
 * substitution happens one layer beneath the selectors, where they cannot see
 * it. A page that cannot be read whole is therefore UNAVAILABLE.
 */

/** A GitHub numeric identifier: a positive, exactly representable integer. */
function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** RFC 3339, strictly — never `Date.parse`, which accepts "2026" and worse. */
function instant(value: unknown): string | null {
  return isRfc3339(value) ? (value as string) : null;
}

/** A full 40-character hexadecimal commit SHA. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/** The lifecycle states the Actions API documents for runs, jobs and steps. */
const RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "in_progress",
  "completed",
  "waiting",
  "requested",
  "pending",
]);

/** The conclusions the Actions API documents. `null` means "not concluded". */
const CONCLUSIONS: ReadonlySet<string> = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);

/**
 * Events that may trigger the workflows this dashboard reads.
 *
 * Deliberately narrow: `paper-production.yml` is `schedule` plus a manual
 * `workflow_dispatch`, and the release gate adds `push` and `pull_request`. An
 * event outside this set means the run came from a trigger this build was not
 * written against.
 */
const EVENTS: ReadonlySet<string> = new Set([
  "schedule",
  "workflow_dispatch",
  "push",
  "pull_request",
  "workflow_run",
  "repository_dispatch",
  "dynamic",
]);

function enumValue(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

/**
 * Whether the page GitHub returned is the whole answer.
 *
 * A page shorter than `total_count` with no `rel="next"` lost entries in
 * transit, and the newest may be among them. `total_count` itself must be
 * present: without it there is nothing to reconcile against.
 */
function pageIsComplete(
  response: Response,
  totalCount: unknown,
  returned: number,
): boolean {
  const total = nonNegativeInt(totalCount);
  if (total === null) return false;
  if (returned === total) return true;
  if (returned > total) return false;
  return /\brel="next"/.test(response.headers.get("link") ?? "");
}

function headers(accept: string): Record<string, string> {
  const value: Record<string, string> = {
    Accept: accept,
    "User-Agent": "nate-trader-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const bearer = token();
  if (bearer) value.Authorization = `Bearer ${bearer}`;
  return value;
}

async function request(
  url: string,
  accept: string,
  timeoutMs = 12_000,
): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers: headers(accept),
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Network/timeout failures must fail closed to UNAVAILABLE, never to a
    // stale committed snapshot.
    return null;
  }
}

/**
 * Read a JSON file from the repository at an explicit git ref.
 *
 * Uses the raw media type: the default base64 envelope silently truncates
 * files above 1 MB, which previously broke large state artifacts.
 */
export async function fetchRepoJson<T>(
  path: string,
  ref: string,
  ttlSeconds = 300,
): Promise<T | null> {
  const key = `contents:${ref}:${path}`;
  const cached = cacheGet<T | null>(key);
  if (cached !== undefined) return cached;

  const url = `${API_ROOT}/repos/${GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const response = await request(url, "application/vnd.github.raw");
  if (!response || !response.ok) {
    cacheSet(key, null, 60);
    return null;
  }
  let parsed: T | null = null;
  try {
    parsed = JSON.parse(await response.text()) as T;
  } catch {
    parsed = null;
  }
  cacheSet(key, parsed, parsed === null ? 60 : ttlSeconds);
  return parsed;
}

export interface CommitRef {
  readonly sha: string;
  readonly committedAt: string | null;
}

/** Head commit of a branch or tag — the repository/research reference. */
export async function fetchRefCommit(
  ref: string = GITHUB_STATE_REF,
  ttlSeconds = 120,
): Promise<CommitRef | null> {
  const key = `commit:${ref}`;
  const cached = cacheGet<CommitRef | null>(key);
  if (cached !== undefined) return cached;

  const url = `${API_ROOT}/repos/${GITHUB_REPO}/commits/${encodeURIComponent(ref)}`;
  const response = await request(url, "application/vnd.github+json");
  if (!response || !response.ok) {
    cacheSet(key, null, 60);
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    sha?: string;
    commit?: { committer?: { date?: string }; author?: { date?: string } };
  } | null;
  const sha = typeof body?.sha === "string" ? body.sha : null;
  const value: CommitRef | null = sha
    ? {
        sha,
        committedAt:
          body?.commit?.committer?.date ?? body?.commit?.author?.date ?? null,
      }
    : null;
  cacheSet(key, value, value ? ttlSeconds : 60);
  return value;
}

export interface WorkflowRunSummary {
  readonly id: number;
  readonly runNumber: number;
  readonly attempt: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly event: string;
  readonly headSha: string;
  readonly createdAt: string | null;
  readonly runStartedAt: string | null;
  readonly updatedAt: string | null;
  readonly url: string;
}

interface RawWorkflowRun {
  id?: number;
  run_number?: number;
  run_attempt?: number;
  status?: string;
  conclusion?: string | null;
  event?: string;
  head_sha?: string;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
  html_url?: string;
}

function toRunSummary(run: RawWorkflowRun): WorkflowRunSummary | null {
  const id = positiveId(run.id);
  const runNumber = positiveId(run.run_number);
  // `run_attempt` used to default to 1 when absent. That is an invention, and
  // it is the one field that distinguishes an original run from a re-run of
  // the same id — the cycle binding, the attempt-scoped jobs and the step
  // windows all key on it.
  const attempt = positiveId(run.run_attempt);
  const status = enumValue(run.status, RUN_STATUSES);
  const event = enumValue(run.event, EVENTS);
  const createdAt = instant(run.created_at);
  const updatedAt = instant(run.updated_at);
  // `run_started_at` is absent on a queued run; when present it must parse.
  const runStartedAt =
    run.run_started_at === undefined || run.run_started_at === null
      ? createdAt
      : instant(run.run_started_at);
  // A conclusion is genuinely absent until the run concludes, but a string
  // outside the documented set is a value this build cannot interpret.
  const conclusion =
    run.conclusion === undefined || run.conclusion === null
      ? null
      : enumValue(run.conclusion, CONCLUSIONS);
  if (
    id === null ||
    runNumber === null ||
    attempt === null ||
    status === null ||
    event === null ||
    createdAt === null ||
    updatedAt === null ||
    runStartedAt === null ||
    (run.conclusion !== undefined && run.conclusion !== null && conclusion === null) ||
    typeof run.head_sha !== "string" ||
    !FULL_SHA.test(run.head_sha)
  ) {
    return null;
  }
  if (run.html_url !== undefined && typeof run.html_url !== "string") return null;
  return {
    id,
    runNumber,
    attempt,
    status,
    conclusion,
    event,
    headSha: run.head_sha,
    createdAt,
    runStartedAt,
    updatedAt,
    url: run.html_url ?? `https://github.com/${GITHUB_REPO}/actions/runs/${id}`,
  };
}

/** Recent runs of one workflow file, newest first. */
export async function fetchWorkflowRuns(
  workflowFile: string,
  options: {
    perPage?: number;
    page?: number;
    headSha?: string;
    event?: string;
    ttlSeconds?: number;
  } = {},
): Promise<WorkflowRunSummary[] | null> {
  const perPage = Math.min(options.perPage ?? 20, 100);
  const query = new URLSearchParams({ per_page: String(perPage) });
  if (options.page && options.page > 1) query.set("page", String(options.page));
  if (options.headSha) query.set("head_sha", options.headSha);
  if (options.event) query.set("event", options.event);
  const key = `runs:${workflowFile}:${query.toString()}`;
  const cached = cacheGet<WorkflowRunSummary[] | null>(key);
  if (cached !== undefined) return cached;

  const url = `${API_ROOT}/repos/${GITHUB_REPO}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${query}`;
  const response = await request(url, "application/vnd.github+json");
  if (!response || !response.ok) {
    cacheSet(key, null, 60);
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    total_count?: unknown;
    workflow_runs?: RawWorkflowRun[];
  } | null;
  // Fail the whole page rather than filtering. Dropping a run this reader
  // cannot understand makes it *disappear*: the next-oldest run becomes the
  // newest, and the selectors happily report its PASS as current. That is the
  // substitution the selectors exist to prevent, performed one layer beneath
  // them where they cannot see it. An unreadable listing is UNAVAILABLE.
  let runs: WorkflowRunSummary[] | null = null;
  if (Array.isArray(body?.workflow_runs)) {
    const parsed = body.workflow_runs.map(toRunSummary);
    runs =
      parsed.some((run) => run === null) ||
      !pageIsComplete(response, body.total_count, parsed.length)
        ? null
        : (parsed as WorkflowRunSummary[]);
  }
  cacheSet(key, runs, runs ? (options.ttlSeconds ?? 60) : 30);
  return runs;
}

export interface WorkflowStepSummary {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  /**
   * The step's own window.
   *
   * A report or artifact produced by a step must be datable to that step. The
   * run's window is too wide: on a re-run it spans work from a different
   * attempt entirely, and within one run it cannot distinguish a preflight
   * report from anything else the job wrote.
   */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface WorkflowJobSummary {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly stepCount: number;
  /**
   * The job's steps, with their own conclusions.
   *
   * A run's conclusion says nothing about *which* steps ran. Deciding whether
   * a report should exist — and therefore whether its absence is "it never
   * ran" or "the upload failed" — requires the step, not the run.
   */
  readonly steps: readonly WorkflowStepSummary[];
}

interface RawStep {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
}

interface RawJob {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  steps?: unknown;
}

function toStepSummary(step: unknown): WorkflowStepSummary | null {
  if (typeof step !== "object" || step === null) return null;
  const raw = step as RawStep;
  const status = enumValue(raw.status, RUN_STATUSES);
  const conclusion =
    raw.conclusion === undefined || raw.conclusion === null
      ? null
      : enumValue(raw.conclusion, CONCLUSIONS);
  if (
    typeof raw.name !== "string" ||
    raw.name.trim() === "" ||
    status === null ||
    (raw.conclusion !== undefined && raw.conclusion !== null && conclusion === null)
  ) {
    return null;
  }
  // A queued step has neither timestamp and an in-progress one has no
  // completion; both are states. A *present* timestamp that cannot be read is
  // not.
  const startedAt =
    raw.started_at === undefined || raw.started_at === null
      ? null
      : instant(raw.started_at);
  const completedAt =
    raw.completed_at === undefined || raw.completed_at === null
      ? null
      : instant(raw.completed_at);
  if (raw.started_at !== undefined && raw.started_at !== null && startedAt === null) {
    return null;
  }
  if (
    raw.completed_at !== undefined &&
    raw.completed_at !== null &&
    completedAt === null
  ) {
    return null;
  }
  // A window that ends before it begins is not a window.
  if (startedAt !== null && completedAt !== null) {
    if (Date.parse(completedAt) < Date.parse(startedAt)) return null;
  }
  return { name: raw.name, status, conclusion, startedAt, completedAt };
}

function toJobSummary(job: unknown): WorkflowJobSummary | null {
  if (typeof job !== "object" || job === null) return null;
  const raw = job as RawJob;
  const status = enumValue(raw.status, RUN_STATUSES);
  const conclusion =
    raw.conclusion === undefined || raw.conclusion === null
      ? null
      : enumValue(raw.conclusion, CONCLUSIONS);
  if (
    typeof raw.name !== "string" ||
    raw.name.trim() === "" ||
    status === null ||
    (raw.conclusion !== undefined && raw.conclusion !== null && conclusion === null) ||
    !Array.isArray(raw.steps)
  ) {
    return null;
  }
  const steps = raw.steps.map(toStepSummary);
  if (steps.some((step) => step === null)) return null;
  return {
    name: raw.name,
    status,
    conclusion,
    stepCount: steps.length,
    steps: steps as WorkflowStepSummary[],
  };
}

/**
 * Jobs of **one attempt** of one run.
 *
 * `/runs/{id}/jobs` returns the latest attempt's jobs, which is the wrong
 * answer whenever a run has been re-run: the artifacts, the report and the
 * step conclusions on screen belong to a specific attempt, and reading another
 * attempt's steps to decide whether that one's preflight ran is exactly the
 * substitution the selector exists to prevent. The attempt is therefore
 * required, and the attempt-scoped endpoint is used.
 *
 * A completed run whose job never executed a single step failed in GitHub's
 * infrastructure (for example no hosted runner could be acquired).
 */
export async function fetchRunJobs(
  runId: number,
  attempt: number,
  ttlSeconds = 120,
): Promise<WorkflowJobSummary[] | null> {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  const key = `run-jobs:${runId}:${attempt}`;
  const cached = cacheGet<WorkflowJobSummary[] | null>(key);
  if (cached !== undefined) return cached;

  const url = `${API_ROOT}/repos/${GITHUB_REPO}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=50`;
  const response = await request(url, "application/vnd.github+json");
  if (!response || !response.ok) {
    cacheSet(key, null, 60);
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    total_count?: unknown;
    jobs?: RawJob[];
  } | null;
  // Whole page or nothing. A step whose window could not be read used to
  // become `{startedAt: null, completedAt: null}`, and every window check
  // treats a null window as "no constraint" — so an unreadable step silently
  // stopped constraining the artifact it was supposed to date.
  let jobs: WorkflowJobSummary[] | null = null;
  if (Array.isArray(body?.jobs)) {
    const parsed = body.jobs.map(toJobSummary);
    jobs =
      parsed.some((entry) => entry === null) ||
      !pageIsComplete(response, body.total_count, parsed.length)
        ? null
        : (parsed as WorkflowJobSummary[]);
  }
  cacheSet(key, jobs, jobs ? ttlSeconds : 30);
  return jobs;
}

/**
 * The approved paper release SHA from the `paper-production` environment.
 * Never written by this application.
 */
export async function fetchEnvironmentVariable(
  environment: string,
  name: string,
  ttlSeconds = 300,
): Promise<string | null> {
  const key = `envvar:${environment}:${name}`;
  const cached = cacheGet<string | null>(key);
  if (cached !== undefined) return cached;

  const url = `${API_ROOT}/repos/${GITHUB_REPO}/environments/${encodeURIComponent(environment)}/variables/${encodeURIComponent(name)}`;
  const response = await request(url, "application/vnd.github+json");
  if (!response || !response.ok) {
    cacheSet(key, null, 60);
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    value?: string;
  } | null;
  const value = typeof body?.value === "string" ? body.value.trim() : null;
  cacheSet(key, value, value ? ttlSeconds : 60);
  return value;
}

export interface ArtifactMeta {
  readonly id: number;
  readonly name: string;
  readonly sizeInBytes: number;
  readonly expired: boolean;
  readonly createdAt: string | null;
}

interface RawArtifact {
  id?: number;
  name?: string;
  size_in_bytes?: number;
  expired?: boolean;
  created_at?: string;
}

function toArtifact(raw: RawArtifact): ArtifactMeta | null {
  const id = positiveId(raw.id);
  const size = nonNegativeInt(raw.size_in_bytes);
  const createdAt = instant(raw.created_at);
  // `expired` decides whether the artifact is worth downloading at all, and
  // `created_at` is what dates it to a step window. A missing one used to
  // become `false` and `null` respectively — the permissive reading of both.
  if (
    id === null ||
    size === null ||
    createdAt === null ||
    typeof raw.name !== "string" ||
    raw.name.trim() === "" ||
    typeof raw.expired !== "boolean"
  ) {
    return null;
  }
  return {
    id,
    name: raw.name,
    sizeInBytes: size,
    expired: raw.expired,
    createdAt,
  };
}

/** Artifacts produced by one specific workflow run. */
export async function fetchRunArtifacts(
  runId: number,
  ttlSeconds = 300,
): Promise<ArtifactMeta[] | null> {
  const key = `run-artifacts:${runId}`;
  const cached = cacheGet<ArtifactMeta[] | null>(key);
  if (cached !== undefined) return cached;

  const url = `${API_ROOT}/repos/${GITHUB_REPO}/actions/runs/${runId}/artifacts?per_page=100`;
  const response = await request(url, "application/vnd.github+json");
  if (!response || !response.ok) {
    cacheSet(key, null, 60);
    return null;
  }
  const body = (await response.json().catch(() => null)) as {
    total_count?: unknown;
    artifacts?: RawArtifact[];
  } | null;
  // Whole page or nothing, for the same reason as the run listing: the
  // runtime selector takes the newest matching artifact, so filtering the
  // newest hands it an older cycle's state presented as this run's.
  let artifacts: ArtifactMeta[] | null = null;
  if (Array.isArray(body?.artifacts)) {
    const parsed = body.artifacts.map(toArtifact);
    artifacts =
      parsed.some((entry) => entry === null) ||
      !pageIsComplete(response, body.total_count, parsed.length)
        ? null
        : (parsed as ArtifactMeta[]);
  }
  cacheSet(key, artifacts, artifacts ? ttlSeconds : 30);
  return artifacts;
}

/**
 * True when the artifact's advertised size is a sane, in-budget number.
 *
 * Checked *before* any download so an artifact whose metadata is missing,
 * NaN, negative or oversized never becomes a request at all.
 */
export function artifactSizeIsAcceptable(artifact: ArtifactMeta): boolean {
  const size = artifact.sizeInBytes;
  return Number.isFinite(size) && size > 0 && size <= MAX_ARCHIVE_BYTES;
}

/**
 * Download an artifact zip.
 *
 * The body is read as a stream and abandoned the moment it exceeds the cap, so
 * a chunked response with no `Content-Length` — or one that lies about it —
 * cannot be buffered to exhaustion first. Returns null on any failure.
 */
export async function downloadArtifactZip(
  artifact: ArtifactMeta,
): Promise<Buffer | null> {
  if (artifact.expired || !artifactSizeIsAcceptable(artifact)) return null;

  const url = `${API_ROOT}/repos/${GITHUB_REPO}/actions/artifacts/${artifact.id}/zip`;
  const response = await request(url, "application/vnd.github+json", 20_000);
  if (!response || !response.ok) return null;

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }

  // A body that undershoots its own advertised length is truncated, not valid.
  if (Number.isFinite(declared) && declared > 0 && total !== declared) {
    return null;
  }
  return Buffer.concat(chunks, total);
}

export function actionsRunUrl(runId: number): string {
  return `https://github.com/${GITHUB_REPO}/actions/runs/${runId}`;
}

export function workflowUrl(workflowFile: string): string {
  return `https://github.com/${GITHUB_REPO}/actions/workflows/${workflowFile}`;
}
