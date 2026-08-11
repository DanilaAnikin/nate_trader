import "server-only";
import { MAX_ARCHIVE_BYTES } from "./zip";

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
  if (typeof run.id !== "number" || typeof run.head_sha !== "string") return null;
  // `run_attempt` used to default to 1 when absent. That is an invention, and
  // it is the one field that distinguishes an original run from a re-run of
  // the same id — the cycle binding, the attempt-scoped jobs and the step
  // windows all key on it. A run whose attempt cannot be read is a run this
  // model cannot reason about, so it is dropped rather than assumed.
  if (
    typeof run.run_attempt !== "number" ||
    !Number.isInteger(run.run_attempt) ||
    run.run_attempt < 1
  ) {
    return null;
  }
  return {
    id: run.id,
    runNumber: typeof run.run_number === "number" ? run.run_number : 0,
    attempt: run.run_attempt,
    status: typeof run.status === "string" ? run.status : "unknown",
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    event: typeof run.event === "string" ? run.event : "unknown",
    headSha: run.head_sha,
    createdAt: run.created_at ?? null,
    runStartedAt: run.run_started_at ?? run.created_at ?? null,
    updatedAt: run.updated_at ?? null,
    url:
      run.html_url ??
      `https://github.com/${GITHUB_REPO}/actions/runs/${run.id}`,
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
    workflow_runs?: RawWorkflowRun[];
  } | null;
  const runs = Array.isArray(body?.workflow_runs)
    ? body.workflow_runs
        .map(toRunSummary)
        .filter((run): run is WorkflowRunSummary => run !== null)
    : null;
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
    jobs?: {
      name?: string;
      status?: string;
      conclusion?: string | null;
      steps?: {
        name?: string;
        status?: string;
        conclusion?: string | null;
        started_at?: string | null;
        completed_at?: string | null;
      }[];
    }[];
  } | null;
  const jobs = Array.isArray(body?.jobs)
    ? body.jobs.map((job) => {
        const steps = Array.isArray(job.steps)
          ? job.steps.map((step) => ({
              name: typeof step?.name === "string" ? step.name : "",
              status: typeof step?.status === "string" ? step.status : "unknown",
              conclusion:
                typeof step?.conclusion === "string" ? step.conclusion : null,
              startedAt:
                typeof step?.started_at === "string" ? step.started_at : null,
              completedAt:
                typeof step?.completed_at === "string" ? step.completed_at : null,
            }))
          : [];
        return {
          name: typeof job.name === "string" ? job.name : "job",
          status: typeof job.status === "string" ? job.status : "unknown",
          conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
          stepCount: steps.length,
          steps,
        };
      })
    : null;
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
  if (typeof raw.id !== "number" || typeof raw.name !== "string") return null;
  return {
    id: raw.id,
    name: raw.name,
    sizeInBytes:
      typeof raw.size_in_bytes === "number" ? raw.size_in_bytes : Number.NaN,
    expired: raw.expired === true,
    createdAt: raw.created_at ?? null,
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
    artifacts?: RawArtifact[];
  } | null;
  const artifacts = Array.isArray(body?.artifacts)
    ? body.artifacts
        .map(toArtifact)
        .filter((artifact): artifact is ArtifactMeta => artifact !== null)
    : null;
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
