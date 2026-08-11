/**
 * The GitHub listings are the newest-evidence selectors' only input.
 *
 * Every one of them is a *newest wins* walk: the newest run, the newest
 * artifact, the newest attempt-scoped job. Dropping an entry the reader cannot
 * understand does not remove one item from a list — it promotes the next one
 * into the position the selector reads. A malformed newest artifact silently
 * becomes yesterday's artifact, and yesterday's PASS is shown as today's.
 *
 * So a page is parsed whole or not at all, and "not at all" is UNAVAILABLE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGithubCache,
  fetchRunArtifacts,
  fetchRunJobs,
  fetchWorkflowRuns,
} from "./github-api";

function respondWith(body: unknown, headers: Record<string, string> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json", ...headers },
        }),
    ),
  );
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 900,
    run_number: 43,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "schedule",
    head_sha: "b".repeat(40),
    created_at: "2026-08-07T16:00:00Z",
    run_started_at: "2026-08-07T16:00:10Z",
    updated_at: "2026-08-07T16:06:00Z",
    html_url: "https://github.com/x/y/actions/runs/900",
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: 55,
    name: "paper-runtime-state-" + "a".repeat(40),
    size_in_bytes: 4096,
    expired: false,
    created_at: "2026-08-07T16:06:00Z",
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    name: "paper",
    status: "completed",
    conclusion: "success",
    steps: [
      {
        name: "Execute one guarded paper cycle",
        status: "completed",
        conclusion: "success",
        number: 1,
        started_at: "2026-08-07T16:04:00Z",
        completed_at: "2026-08-07T16:06:00Z",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  clearGithubCache();
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  vi.stubEnv("GITHUB_REPO", "owner/repo");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearGithubCache();
});

describe("fetchWorkflowRuns", () => {
  it("reads a well-formed page", async () => {
    respondWith({ total_count: 1, workflow_runs: [run()] });
    const runs = await fetchWorkflowRuns("paper-production.yml");
    expect(runs?.map((entry) => entry.id)).toEqual([900]);
  });

  it.each([
    ["a missing attempt", { run_attempt: undefined }],
    ["a zero attempt", { run_attempt: 0 }],
    ["a fractional attempt", { run_attempt: 1.5 }],
    ["a missing id", { id: undefined }],
    ["a negative id", { id: -1 }],
    ["a fractional id", { id: 1.5 }],
    ["a missing run number", { run_number: undefined }],
    ["a short head sha", { head_sha: "abc" }],
    ["a non-hex head sha", { head_sha: "z".repeat(40) }],
    ["an unrecognised status", { status: "quantum" }],
    ["an unrecognised conclusion", { conclusion: "mostly" }],
    ["an unrecognised event", { event: "telepathy" }],
    ["a missing created_at", { created_at: undefined }],
    ["a non-RFC3339 created_at", { created_at: "2026-08-07" }],
    ["an impossible created_at", { created_at: "2026-02-30T00:00:00Z" }],
    ["a lenient updated_at", { updated_at: "Aug 7 2026" }],
    ["a non-string html_url", { html_url: 7 }],
  ])("fails the whole page for a run with %s", async (_label, patch) => {
    const malformed = run({ id: 999, run_number: 50, ...patch });
    if ("run_attempt" in patch && patch.run_attempt === undefined) {
      delete (malformed as Record<string, unknown>).run_attempt;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (malformed as Record<string, unknown>)[key];
    }
    respondWith({ total_count: 2, workflow_runs: [malformed, run()] });
    // Not "the good run": the malformed one is the *newest*, and returning
    // only the older one hands the selector a substitution it cannot detect.
    expect(await fetchWorkflowRuns("paper-production.yml")).toBeNull();
  });

  it("fails the page when the listing is not an array", async () => {
    respondWith({ total_count: 0, workflow_runs: "none" });
    expect(await fetchWorkflowRuns("paper-production.yml")).toBeNull();
  });

  it("fails the page when fewer runs are returned than total_count and no more pages follow", async () => {
    // A truncated page with no `Link: rel="next"` is a page that lost entries
    // in transit. The newest may be among them.
    respondWith({ total_count: 5, workflow_runs: [run()] });
    expect(await fetchWorkflowRuns("paper-production.yml")).toBeNull();
  });

  it("accepts a first page shorter than total_count when more pages follow", async () => {
    respondWith(
      { total_count: 5, workflow_runs: [run()] },
      { link: '<https://api.github.com/x?page=2>; rel="next"' },
    );
    expect(await fetchWorkflowRuns("paper-production.yml", { perPage: 1 })).not.toBeNull();
  });

  it("fails the page when total_count is absent", async () => {
    respondWith({ workflow_runs: [run()] });
    expect(await fetchWorkflowRuns("paper-production.yml")).toBeNull();
  });

  it("fails the page when total_count is not a non-negative integer", async () => {
    respondWith({ total_count: -1, workflow_runs: [run()] });
    expect(await fetchWorkflowRuns("paper-production.yml")).toBeNull();
  });
});

describe("fetchRunArtifacts", () => {
  it("reads a well-formed page", async () => {
    respondWith({ total_count: 1, artifacts: [artifact()] });
    const artifacts = await fetchRunArtifacts(900);
    expect(artifacts?.map((entry) => entry.id)).toEqual([55]);
  });

  it.each([
    ["a missing id", { id: undefined }],
    ["a fractional id", { id: 1.5 }],
    ["a missing name", { name: undefined }],
    ["an empty name", { name: "" }],
    ["a missing size", { size_in_bytes: undefined }],
    ["a fractional size", { size_in_bytes: 1.5 }],
    ["a negative size", { size_in_bytes: -1 }],
    ["a non-boolean expired", { expired: "no" }],
    ["a missing expired flag", { expired: undefined }],
    ["a missing created_at", { created_at: undefined }],
    ["a lenient created_at", { created_at: "2026" }],
    ["an impossible created_at", { created_at: "2026-13-01T00:00:00Z" }],
  ])("fails the whole page for an artifact with %s", async (_label, patch) => {
    const malformed = artifact({ id: 99, ...patch });
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (malformed as Record<string, unknown>)[key];
    }
    // The malformed one is the newest. Filtering it used to hand the runtime
    // selector the *previous* artifact — an older cycle's state, presented as
    // this run's.
    respondWith({ total_count: 2, artifacts: [malformed, artifact()] });
    expect(await fetchRunArtifacts(900)).toBeNull();
  });

  it("fails the page when the count does not match", async () => {
    respondWith({ total_count: 3, artifacts: [artifact()] });
    expect(await fetchRunArtifacts(900)).toBeNull();
  });
});

describe("fetchRunJobs", () => {
  it("reads a well-formed attempt page", async () => {
    respondWith({ total_count: 1, jobs: [job()] });
    const jobs = await fetchRunJobs(900, 1);
    expect(jobs?.[0].steps[0].name).toBe("Execute one guarded paper cycle");
  });

  it.each([
    ["a missing name", { name: undefined }],
    ["an unrecognised status", { status: "thinking" }],
    ["an unrecognised conclusion", { conclusion: "ok-ish" }],
    ["a non-array steps field", { steps: "none" }],
    ["a missing steps field", { steps: undefined }],
  ])("fails the whole page for a job with %s", async (_label, patch) => {
    const malformed = job(patch);
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (malformed as Record<string, unknown>)[key];
    }
    respondWith({ total_count: 1, jobs: [malformed] });
    expect(await fetchRunJobs(900, 1)).toBeNull();
  });

  it.each([
    ["a missing name", { name: undefined }],
    ["an empty name", { name: "" }],
    ["an unrecognised status", { status: "warming up" }],
    ["an unrecognised conclusion", { conclusion: "fine" }],
    ["a lenient started_at", { started_at: "2026-08-07" }],
    ["an impossible completed_at", { completed_at: "2026-02-30T00:00:00Z" }],
    [
      "a completion before its start",
      { started_at: "2026-08-07T16:06:00Z", completed_at: "2026-08-07T16:04:00Z" },
    ],
  ])("fails the whole page for a step with %s", async (_label, patch) => {
    // The step window is what dates a report or artifact to a cycle. A step
    // whose window cannot be read used to become `{null, null}`, which every
    // window check treats as "no constraint".
    const step = { ...job().steps[0], ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (step as Record<string, unknown>)[key];
    }
    respondWith({ total_count: 1, jobs: [job({ steps: [step] })] });
    expect(await fetchRunJobs(900, 1)).toBeNull();
  });

  it("accepts a step that has not finished yet", async () => {
    // An in-progress step legitimately has no completion. That is a state, not
    // a malformed record.
    const step = {
      ...job().steps[0],
      status: "in_progress",
      conclusion: null,
      completed_at: null,
    };
    respondWith({ total_count: 1, jobs: [job({ steps: [step] })] });
    const jobs = await fetchRunJobs(900, 1);
    expect(jobs?.[0].steps[0].completedAt).toBeNull();
  });

  it("refuses an attempt that is not a positive integer", async () => {
    respondWith({ total_count: 1, jobs: [job()] });
    expect(await fetchRunJobs(900, 0)).toBeNull();
    expect(await fetchRunJobs(900, 1.5)).toBeNull();
  });
});
