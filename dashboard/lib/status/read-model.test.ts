import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGithubCache } from "./github-api";
import {
  buildStrategyStatus,
  type StatusAccount,
  type StatusViewer,
} from "./read-model";
import { RUN_SCAN_PAGE_SIZE } from "./runtime";
import type { BrokerResult } from "./broker";
import type { BrokerInfo } from "./types";
import {
  APPROVED_SHA,
  DASHBOARD_SHA,
  failedPreflightJson,
  frozenPlanJson,
  lastRunJson,
  OTHER_SHA,
  performanceJson,
  positionsJson,
  preflightJson,
  REPO_SHA,
  TARGET_SYMBOLS,
  tournamentJson,
  UNIVERSE_HASH,
  validationJson,
} from "@/test/fixtures";
import { buildZip } from "@/test/zip-builder";

const NOW = new Date("2026-08-07T17:00:00Z");

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_USER_ID = "22222222-2222-2222-2222-222222222222";
const PROD_ACCOUNT_ID = "acc-prod";

const OWNER: StatusViewer = { userId: OWNER_ID };
const OTHER_VIEWER: StatusViewer = { userId: OTHER_USER_ID };

const PRODUCTION_ACCOUNT: StatusAccount = {
  id: PROD_ACCOUNT_ID,
  nickname: "Paper production",
  mode: "paper",
  ownerId: OWNER_ID,
};

/** A second tenant's own paper account. */
const FOREIGN_ACCOUNT: StatusAccount = {
  id: "acc-foreign",
  nickname: "Somebody else's paper",
  mode: "paper",
  ownerId: OTHER_USER_ID,
};

const LIVE_ACCOUNT: StatusAccount = {
  id: "acc-live",
  nickname: "Real money",
  mode: "live",
  ownerId: OWNER_ID,
};

const SECRET_BROKER_NUMBER = "PA-SECRET-ACCT-7788";

function brokerSnapshot(overrides: Partial<BrokerInfo> = {}): BrokerInfo {
  const positions = TARGET_SYMBOLS.map((symbol) => ({
    symbol,
    qty: 100,
    avgEntryPrice: 400,
    currentPrice: 400,
    marketValue: 40_000,
    unrealizedPl: 0,
    unrealizedPlPct: 0,
    side: "long" as const,
  }));
  return {
    equity: 1_000_000,
    cash: 600_000,
    cashPct: 60,
    dailyPnl: 0,
    dailyPnlPct: 0,
    grossExposure: 400_000,
    grossExposurePct: 40,
    positionCount: positions.length,
    positions,
    shortSymbols: [],
    ...overrides,
  };
}

function okBroker(overrides: Partial<BrokerInfo> = {}): BrokerResult {
  return {
    ok: true,
    snapshot: brokerSnapshot(overrides),
    fetchedAt: NOW.toISOString(),
    accountNumber: SECRET_BROKER_NUMBER,
  };
}

const OK_BROKER = okBroker();

interface RunSpec {
  id: number;
  runNumber: number;
  conclusion: string;
  event: string;
  updatedAt: string;
  /** Artifacts attached to this run. */
  runtimeArtifactName?: string | null;
  runtimeZip?: Buffer | "corrupt" | "gone";
  diagnostics?: Buffer | typeof DEFAULT_DIAGNOSTICS | null;
}

/**
 * A diagnostics artifact stamped for the run it is attached to.
 *
 * A fixed `checked_at` on every run was fiction: a real report is written by
 * the preflight step of *that* run, and the selector now binds it to that
 * step's window. The stub builds it lazily so the fixture cannot claim a
 * report that predates its own run by hours.
 */
const DEFAULT_DIAGNOSTICS = "default-diagnostics" as const;

function runtimeZipBuffer(
  perf: Record<string, unknown> = performanceJson(),
  run: Record<string, unknown> = lastRunJson(),
  positions: Record<string, unknown> = positionsJson(),
): Buffer {
  return buildZip([
    { name: "performance.json", content: JSON.stringify(perf) },
    { name: "positions.json", content: JSON.stringify(positions) },
    { name: "production/last_run.json", content: JSON.stringify(run) },
  ]);
}

function diagnosticsZipBuffer(
  preflight: Record<string, unknown> = preflightJson(),
): Buffer {
  return buildZip([
    { name: "production-preflight.json", content: JSON.stringify(preflight) },
    { name: "production-dry-run.log", content: "dry run output" },
  ]);
}

function defaultRuns(): RunSpec[] {
  return [
    {
      id: 900,
      runNumber: 43,
      conclusion: "success",
      event: "schedule",
      updatedAt: "2026-08-07T16:06:00Z",
      runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
      runtimeZip: runtimeZipBuffer(),
      diagnostics: DEFAULT_DIAGNOSTICS,
    },
    {
      id: 800,
      runNumber: 42,
      conclusion: "success",
      event: "schedule",
      updatedAt: "2026-08-05T16:51:00Z",
      runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
      runtimeZip: runtimeZipBuffer(),
      diagnostics: DEFAULT_DIAGNOSTICS,
    },
  ];
}

/**
 * The jobs GitHub really returns for a paper-production run: one job, with the
 * named steps and their own windows. The selectors bind every artifact and
 * every recorded timestamp to these, so a stub that omitted them was testing
 * a shape production never sees.
 */
function runJob(run: RunSpec): Record<string, unknown> {
  const step = (name: string, conclusion: string) => ({
    name,
    status: "completed",
    conclusion,
    started_at: run.updatedAt,
    completed_at: run.updatedAt,
  });
  const steps: Record<string, unknown>[] = [
    step("Set up job", "success"),
    step("Verify immutable release approval", "success"),
  ];
  steps.push(
    step(
      "Verify paper broker and deployment health",
      run.diagnostics ? "success" : "skipped",
    ),
  );
  steps.push(
    step(
      "Execute one guarded paper cycle",
      run.runtimeArtifactName ? "success" : "skipped",
    ),
  );
  steps.push(
    step(
      "Preserve private runtime state",
      run.runtimeArtifactName ? "success" : "skipped",
    ),
  );
  steps.push(step("Preserve preflight diagnostics", "success"));
  return {
    name: "Guarded paper forward-validation",
    status: "completed",
    conclusion: run.conclusion,
    steps,
  };
}

interface RouteOptions {
  approvedShaVariable?: string | null;
  runs?: RunSpec[];
  validation?: Record<string, unknown> | null;
  /** Overrides the jobs of the *newest* run only. */
  latestRunJobs?: { status?: string; steps: unknown[] }[];
  /** Patch one run's runtime artifact metadata (expiry, creation time). */
  runtimeArtifactPatch?: { runId: number; patch: Record<string, unknown> };
  /** `run_attempt` as GitHub reports it; null omits the field entirely. */
  runAttempt?: number | null;
  releaseGate?: { conclusion: string; event: string } | null;
}

function stubGithub(options: RouteOptions = {}) {
  const {
    approvedShaVariable = APPROVED_SHA,
    runs = defaultRuns(),
    validation = validationJson(),
    latestRunJobs,
    runtimeArtifactPatch,
    runAttempt = 1,
    releaseGate = { conclusion: "success", event: "push" },
  } = options;

  /**
   * GitHub always states `total_count` on a paged listing, and the reader now
   * reconciles the page against it. The stub does the same so it keeps
   * mirroring the real API rather than a laxer version of it.
   */
  const withTotalCount = (body: unknown) => {
    if (typeof body !== "object" || body === null) return body;
    const record = body as Record<string, unknown>;
    for (const field of ["workflow_runs", "artifacts", "jobs"]) {
      if (Array.isArray(record[field]) && record.total_count === undefined) {
        return { ...record, total_count: (record[field] as unknown[]).length };
      }
    }
    return body;
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(withTotalCount(body)), {
      status,
      headers: { "content-type": "application/json" },
    });

  // Artifact ids are derived from the run so each run has its own set.
  const runtimeArtifactId = (run: RunSpec) => run.id * 10 + 1;
  const diagnosticsArtifactId = (run: RunSpec) => run.id * 10 + 2;

  const zipResponse = (body: Buffer) =>
    new Response(new Uint8Array(body), {
      headers: { "content-length": String(body.byteLength) },
    });

  const handler = vi.fn(async (input: string | URL) => {
    const url = String(input);

    if (url.includes("/environments/paper-production/variables/")) {
      return approvedShaVariable
        ? json({ name: "PRODUCTION_RELEASE_SHA", value: approvedShaVariable })
        : json({ message: "Not Found" }, 404);
    }
    if (url.includes("/commits/main")) {
      return json({
        sha: REPO_SHA,
        commit: { committer: { date: "2026-08-03T15:00:00Z" } },
      });
    }
    if (url.includes("/workflows/paper-production.yml/runs")) {
      // Mirror GitHub's paging exactly: `page` is 1-based, `per_page` bounds
      // the slice, and a page beyond the end is empty. A stub that returned
      // every run on every page would make the scan look like it paged when it
      // never left page one.
      const params = new URL(url).searchParams;
      const perPage = Number(params.get("per_page") ?? "30");
      const page = Number(params.get("page") ?? "1");
      const slice = runs.slice((page - 1) * perPage, page * perPage);
      return json({
        workflow_runs: slice.map((run) => ({
          id: run.id,
          run_number: run.runNumber,
          ...(runAttempt === null ? {} : { run_attempt: runAttempt }),
          status: "completed",
          conclusion: run.conclusion,
          event: run.event,
          head_sha: REPO_SHA,
          created_at: run.updatedAt,
          run_started_at: run.updatedAt,
          updated_at: run.updatedAt,
          html_url: `https://github.com/x/y/actions/runs/${run.id}`,
        })),
      });
    }
    if (url.includes("/workflows/v11-release.yml/runs")) {
      const requestedEvent = new URL(url).searchParams.get("event");
      if (!releaseGate) return json({ workflow_runs: [] });
      // Mirror GitHub: the `event` filter actually filters.
      if (requestedEvent && requestedEvent !== releaseGate.event) {
        return json({ workflow_runs: [] });
      }
      return json({
        workflow_runs: [
          {
            id: 700,
            run_number: 12,
            run_attempt: 1,
            status: "completed",
            conclusion: releaseGate.conclusion,
            event: releaseGate.event,
            head_sha: APPROVED_SHA,
            created_at: "2026-08-02T15:50:00Z",
            updated_at: "2026-08-02T15:58:00Z",
            html_url: "https://github.com/x/y/actions/runs/700",
          },
        ],
      });
    }
    // Attempt-scoped, exactly like GitHub: `/runs/{id}/attempts/{n}/jobs`.
    const jobsMatch = url.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/);
    if (jobsMatch) {
      const runId = Number(jobsMatch[1]);
      if (latestRunJobs && runs.length > 0 && runs[0].id === runId) {
        return json({
          jobs: latestRunJobs.map((job) => ({
            name: "Guarded paper forward-validation",
            status: job.status ?? "completed",
            conclusion: "success",
            steps: job.steps,
          })),
        });
      }
      const run = runs.find((entry) => entry.id === runId);
      if (!run) return json({ jobs: [] });
      return json({ jobs: [runJob(run)] });
    }

    const artifactsMatch = url.match(/\/actions\/runs\/(\d+)\/artifacts/);
    if (artifactsMatch) {
      const run = runs.find((entry) => entry.id === Number(artifactsMatch[1]));
      if (!run) return json({ artifacts: [] });
      const artifacts: Record<string, unknown>[] = [];
      if (run.runtimeArtifactName) {
        artifacts.push({
          id: runtimeArtifactId(run),
          name: run.runtimeArtifactName,
          size_in_bytes: 4271,
          expired: false,
          created_at: run.updatedAt,
          ...(runtimeArtifactPatch?.runId === run.id
            ? runtimeArtifactPatch.patch
            : {}),
        });
      }
      if (run.diagnostics) {
        artifacts.push({
          id: diagnosticsArtifactId(run),
          name: "paper-diagnostics",
          size_in_bytes: 1584,
          expired: false,
          created_at: run.updatedAt,
        });
      }
      return json({ artifacts });
    }

    const zipMatch = url.match(/\/actions\/artifacts\/(\d+)\/zip/);
    if (zipMatch) {
      const artifactId = Number(zipMatch[1]);
      const run = runs.find(
        (entry) =>
          runtimeArtifactId(entry) === artifactId ||
          diagnosticsArtifactId(entry) === artifactId,
      );
      if (!run) return json({ message: "gone" }, 404);
      if (runtimeArtifactId(run) === artifactId) {
        if (run.runtimeZip === "corrupt") {
          const bad = Buffer.from("this is not a zip archive at all");
          return zipResponse(bad);
        }
        if (run.runtimeZip === "gone") return json({ message: "gone" }, 410);
        if (!run.runtimeZip) return json({ message: "gone" }, 404);
        return zipResponse(run.runtimeZip);
      }
      if (!run.diagnostics) return json({ message: "gone" }, 404);
      return zipResponse(
        run.diagnostics === DEFAULT_DIAGNOSTICS
          ? diagnosticsZipBuffer(preflightJson({ checked_at: run.updatedAt }))
          : run.diagnostics,
      );
    }

    if (url.includes("/contents/state/backtest/v11_validation.json")) {
      return validation
        ? new Response(JSON.stringify(validation))
        : json({ message: "Not Found" }, 404);
    }
    if (url.includes("/contents/state/backtest/strategy_tournament_epoch_1.json")) {
      return new Response(JSON.stringify(tournamentJson()));
    }
    if (url.includes("/contents/state/v11_epoch_baseline.json")) {
      return json({ message: "Not Found" }, 404);
    }
    return json({ message: `unrouted ${url}` }, 404);
  });

  vi.stubGlobal("fetch", handler);
  return handler;
}

function actionsCalls(handler: ReturnType<typeof stubGithub>): string[] {
  return handler.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes("/actions/") || url.includes("/environments/"));
}

beforeEach(() => {
  clearGithubCache();
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  vi.stubEnv("BUILD_SHA", DASHBOARD_SHA);
  vi.stubEnv("PRODUCTION_OWNER_USER_ID", OWNER_ID);
  vi.stubEnv("PRODUCTION_ACCOUNT_ID", PROD_ACCOUNT_ID);
  // The broker-side identifier is a mandatory AND check, so the default test
  // configuration is a fully bound production account.
  vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", SECRET_BROKER_NUMBER);
  vi.stubEnv("V11_EPOCH_BASELINE", "");
});

describe("cross-tenant isolation", () => {
  it("gives a second tenant no production runtime and makes no Actions call", async () => {
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OTHER_VIEWER,
      account: FOREIGN_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });

    // Nothing central is disclosed.
    expect(payload.authorization.data?.productionRuntimeAuthorized).toBe(false);
    expect(payload.authorization.data?.denialReason).toBe("NOT_PRODUCTION_OWNER");
    expect(payload.strategy.data).toBeNull();
    expect(payload.preflight.data).toBeNull();
    expect(payload.execution.data).toBeNull();
    expect(payload.operations.data).toBeNull();
    expect(payload.convergence.data).toBeNull();
    expect(payload.universe.data).toBeNull();
    for (const key of [
      "strategy",
      "preflight",
      "execution",
      "operations",
      "convergence",
      "universe",
    ] as const) {
      expect(payload[key].provenance.freshness).toBe("NOT_APPLICABLE");
    }

    // The private GitHub Actions API is not touched at all for this viewer.
    expect(actionsCalls(handler)).toEqual([]);

    // No approved release, gate or plan leaks through another route.
    expect(payload.release.data?.approvedPaperReleaseSha).toBeNull();
    expect(payload.release.data?.releaseGate).toBe("NOT_APPLICABLE");
    expect(payload.validationGate.effective).toBe("NOT_APPLICABLE");

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("f8756105eb63dde2"); // plan id
    expect(serialized).not.toContain(APPROVED_SHA);
    expect(serialized).not.toContain("ADAPTIVE_TRIM");
  });

  it("gives the production owner the runtime and does call the Actions API", async () => {
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.authorization.data?.productionRuntimeAuthorized).toBe(true);
    expect(payload.strategy.data?.plan?.planId).toBe("f8756105eb63dde2");
    expect(actionsCalls(handler).length).toBeGreaterThan(0);
  });

  it("withholds the runtime from the owner on their own non-production account", async () => {
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: { ...PRODUCTION_ACCOUNT, id: "acc-second", nickname: "Second" },
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.authorization.data?.denialReason).toBe(
      "NOT_PRODUCTION_ACCOUNT",
    );
    expect(payload.strategy.data).toBeNull();
    expect(actionsCalls(handler)).toEqual([]);
  });

  it("withholds the runtime for a live account", async () => {
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: { ...LIVE_ACCOUNT, id: PROD_ACCOUNT_ID },
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.authorization.data?.denialReason).toBe("NOT_PAPER_MODE");
    expect(payload.accountBinding.data?.role).toBe("READ_ONLY_LIVE");
    expect(actionsCalls(handler)).toEqual([]);
  });

  it("withholds the runtime when no production owner is configured", async () => {
    vi.stubEnv("PRODUCTION_OWNER_USER_ID", "");
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.authorization.data?.denialReason).toBe("NOT_CONFIGURED");
    expect(payload.accountBinding.data?.role).toBe("OBSERVER_ONLY_PAPER");
    expect(actionsCalls(handler)).toEqual([]);
  });

  it("withholds the runtime when no broker binding is configured", async () => {
    vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", "");
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.authorization.data?.denialReason).toBe(
      "BROKER_BINDING_NOT_CONFIGURED",
    );
    expect(payload.strategy.data).toBeNull();
    expect(actionsCalls(handler)).toEqual([]);
  });

  it("requires the configured broker account number as an AND check", async () => {
    vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", "PA-DIFFERENT-0000");
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.authorization.data?.denialReason).toBe(
      "BROKER_ACCOUNT_MISMATCH",
    );
    expect(actionsCalls(handler)).toEqual([]);
  });

  it("authorizes when the freshly read broker number matches", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.authorization.data?.productionRuntimeAuthorized).toBe(true);
    expect(payload.accountBinding.data?.brokerAccountMask).toBe("••••7788");
    expect(JSON.stringify(payload)).not.toContain(SECRET_BROKER_NUMBER);
  });

  it("fails closed when the broker number cannot be verified", async () => {
    const handler = stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: {
        ok: false,
        code: "ALPACA_UNREACHABLE",
        detail: "Could not reach Alpaca for the selected account.",
      },
      now: NOW,
    });
    expect(payload.authorization.data?.denialReason).toBe(
      "BROKER_ACCOUNT_UNVERIFIED",
    );
    expect(actionsCalls(handler)).toEqual([]);
  });
});

describe("healthy production viewer", () => {
  it("separates the dashboard build, repository, approved and trigger SHAs", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.web.data?.dashboardBuildSha).toBe(DASHBOARD_SHA);
    expect(payload.release.data?.repositoryRefSha).toBe(REPO_SHA);
    expect(payload.release.data?.approvedPaperReleaseSha).toBe(APPROVED_SHA);
    expect(payload.operations.data?.latestAttempt?.triggerSha).toBe(REPO_SHA);
    expect(payload.release.data?.dashboardMatchesApprovedRelease).toBe(false);
  });

  it("exposes the plan, universe and a PASS effective gate", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.data?.marketGate).toBe("RISK_ON");
    expect(payload.universe.data?.rankingUniverseSha256).toBe(UNIVERSE_HASH);
    expect(payload.convergence.data?.targetCount).toBe(10);
    expect(payload.validation.data?.identityMatchesRuntime).toBe("PASS");
    expect(payload.validationGate.reasons).toEqual([]);
    expect(payload.validationGate.effective).toBe("PASS");
    expect(payload.validationGate.reportAssessment).toBe("PASS");
  });

  it("never leaks credentials, order identifiers or the broker account number", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain("client_order_id");
    expect(serialized).not.toContain("order_id");
    expect(serialized).not.toContain("58371aed-250a-40c7-b883-a62c538100b1");
    expect(serialized).not.toContain(SECRET_BROKER_NUMBER);
    expect(serialized).not.toContain("test-service-key");
  });
});

describe("release gate", () => {
  it("is PASS only for a completed successful push run on the approved SHA", async () => {
    stubGithub({ releaseGate: { conclusion: "success", event: "push" } });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.release.data?.releaseGate).toBe("PASS");
  });

  it("is not PASS for a pull-request success", async () => {
    stubGithub({
      releaseGate: { conclusion: "success", event: "pull_request" },
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.release.data?.releaseGate).not.toBe("PASS");
    expect(payload.release.data?.releaseGate).toBe("FAIL");
  });

  it("is not PASS for a manual workflow_dispatch success", async () => {
    stubGithub({
      releaseGate: { conclusion: "success", event: "workflow_dispatch" },
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.release.data?.releaseGate).not.toBe("PASS");
  });

  it("is FAIL for a failed push run", async () => {
    stubGithub({ releaseGate: { conclusion: "failure", event: "push" } });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.release.data?.releaseGate).toBe("FAIL");
  });
});

describe("independent runtime source selection", () => {
  it("keeps an older execution when a newer manual preflight-only run exists", async () => {
    const preflightOnly: RunSpec = {
      id: 950,
      runNumber: 44,
      conclusion: "success",
      event: "workflow_dispatch",
      updatedAt: "2026-08-07T18:30:00Z",
      runtimeArtifactName: null,
      diagnostics: diagnosticsZipBuffer(
        preflightJson({ checked_at: "2026-08-07T18:29:00+00:00" }),
      ),
    };
    const execution: RunSpec = {
      id: 900,
      runNumber: 43,
      conclusion: "success",
      event: "schedule",
      updatedAt: "2026-08-07T16:06:00Z",
      runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
      runtimeZip: runtimeZipBuffer(),
      diagnostics: DEFAULT_DIAGNOSTICS,
    };
    stubGithub({ runs: [preflightOnly, execution] });

    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-07T19:00:00Z"),
    });

    // The manual preflight is newer and wins its own section...
    expect(payload.preflight.data).not.toBeNull();
    expect(payload.preflight.data?.checkedAt).toBe("2026-08-07T18:29:00.000Z");
    expect(payload.preflight.provenance.scope).toContain("#44");
    expect(payload.preflight.data?.runUrl).toContain("/runs/950");

    // ...without hiding the older, still-valid executor cycle.
    expect(payload.execution.data).not.toBeNull();
    expect(payload.execution.data?.completedAt).toBe("2026-08-07T16:05:05.164Z");
    expect(payload.execution.provenance.scope).toContain("#43");
    expect(payload.execution.data?.runUrl).toContain("/runs/900");
    expect(payload.strategy.data?.plan?.planId).toBe("f8756105eb63dde2");

    // Each section carries its own source and timestamp.
    expect(payload.preflight.provenance.asOf).not.toBe(
      payload.execution.provenance.asOf,
    );
  });

  it("finds the executor behind 15 newer preflight-only runs", async () => {
    const preflightOnly: RunSpec[] = Array.from({ length: 15 }, (_, index) => ({
      id: 2000 + index,
      runNumber: 100 + index,
      conclusion: "success",
      event: "workflow_dispatch",
      // Newest first, all after the execution below.
      updatedAt: `2026-08-08T${String(9 + index).padStart(2, "0")}:00:00Z`,
      runtimeArtifactName: null,
      diagnostics: DEFAULT_DIAGNOSTICS,
    })).reverse();

    stubGithub({
      runs: [
        ...preflightOnly,
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });

    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-09T12:00:00Z"),
    });

    // The executor cycle is still found despite 15 newer preflight-only runs.
    expect(payload.execution.data).not.toBeNull();
    expect(payload.execution.data?.runUrl).toContain("/runs/900");
    expect(payload.strategy.data?.plan?.planId).toBe("f8756105eb63dde2");
    // The newest preflight still wins its own section.
    expect(payload.preflight.provenance.scope).toContain("#114");
  });

  it("crosses an exactly-full first page to reach the executor on page two", async () => {
    // The boundary case a stub that ignores `page` can never exercise: the
    // first page comes back with exactly RUN_SCAN_PAGE_SIZE runs, which proves
    // nothing about whether more exist, so a second page must be requested.
    const preflightOnly: RunSpec[] = Array.from(
      { length: RUN_SCAN_PAGE_SIZE },
      (_, index) => ({
        id: 3000 + index,
        runNumber: 200 + index,
        conclusion: "success",
        event: "workflow_dispatch",
        // Newest first: index 0 is the most recent.
        updatedAt: new Date(
          Date.parse("2026-08-09T09:00:00Z") - index * 60_000,
        ).toISOString(),
        runtimeArtifactName: null,
        diagnostics: DEFAULT_DIAGNOSTICS,
      }),
    );

    const handler = stubGithub({
      runs: [
        ...preflightOnly,
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });

    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-09T12:00:00Z"),
    });

    // The run list really was requested twice, the second time for page 2.
    const runListCalls = handler.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/workflows/paper-production.yml/runs"));
    const pagesRequested = runListCalls.map((url) =>
      Number(new URL(url).searchParams.get("page") ?? "1"),
    );
    expect(pagesRequested).toContain(2);
    expect(
      runListCalls.every(
        (url) =>
          Number(new URL(url).searchParams.get("per_page")) ===
          RUN_SCAN_PAGE_SIZE,
      ),
    ).toBe(true);

    expect(payload.execution.data).not.toBeNull();
    expect(payload.execution.data?.runUrl).toContain("/runs/900");
    expect(payload.strategy.data?.plan?.planId).toBe("f8756105eb63dde2");
    // The newest preflight is still the one on page one.
    expect(payload.preflight.provenance.scope).toContain("#200");
  });

  it.each([
    [
      "an expired runtime artifact",
      { expired: true },
      "has expired",
    ],
    [
      "a runtime artifact created outside its upload step",
      { created_at: "2026-08-06T09:00:00Z" },
      "not created inside the window",
    ],
  ])(
    "does not fall back to an older cycle when a newer run has %s",
    async (_label, artifactPatch, expected) => {
      // A newer *successful* run that executed a cycle is the authority for
      // what production did. If its runtime state cannot be read, the answer
      // is UNAVAILABLE — showing the previous cycle's equity, positions and
      // risk tier as if they were current is the failure being prevented.
      stubGithub({
        runs: [
          {
            id: 960,
            runNumber: 48,
            conclusion: "success",
            event: "schedule",
            updatedAt: "2026-08-07T18:30:00Z",
            runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
            runtimeZip: runtimeZipBuffer(),
            diagnostics: DEFAULT_DIAGNOSTICS,
          },
          {
            id: 900,
            runNumber: 43,
            conclusion: "success",
            event: "schedule",
            updatedAt: "2026-08-07T16:06:00Z",
            runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
            runtimeZip: runtimeZipBuffer(),
            diagnostics: DEFAULT_DIAGNOSTICS,
          },
        ],
        runtimeArtifactPatch: { runId: 960, patch: artifactPatch },
      });
      const payload = await buildStrategyStatus({
        viewer: OWNER,
        account: PRODUCTION_ACCOUNT,
        broker: OK_BROKER,
        now: new Date("2026-08-07T19:00:00Z"),
      });
      expect(payload.execution.data).toBeNull();
      expect(payload.execution.provenance.scope).not.toContain("#43");
      expect(payload.execution.provenance.detail ?? "").toContain(expected);
    },
  );

  it("does not fall back when a newer successful run uploaded no runtime state", async () => {
    // The execute step ran (it is not `skipped`), so the artifact should
    // exist. Its absence is an upload failure, not a preflight-only dispatch.
    const step = (name: string, conclusion: string) => ({
      name,
      status: "completed",
      conclusion,
      started_at: "2026-08-07T18:29:00Z",
      completed_at: "2026-08-07T18:30:00Z",
    });
    stubGithub({
      runs: [
        {
          id: 961,
          runNumber: 49,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T18:30:00Z",
          runtimeArtifactName: null,
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
      latestRunJobs: [
        {
          steps: [
            step("Verify paper broker and deployment health", "success"),
            step("Execute one guarded paper cycle", "success"),
            step("Preserve private runtime state", "failure"),
          ],
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-07T19:00:00Z"),
    });
    expect(payload.execution.data).toBeNull();
    expect(payload.execution.provenance.detail ?? "").toContain(
      "produced no runtime-state artifact",
    );
  });

  it("refuses a re-run rather than attributing run-level artifacts to it", async () => {
    // `/runs/{id}/artifacts` is run-level: a re-run serves attempt 1's
    // artifacts alongside attempt 2's with no attempt field to tell them
    // apart. Showing either as "this attempt's" would be a guess.
    stubGithub({ runAttempt: 2 });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).toBeNull();
    expect(payload.preflight.data).toBeNull();
    expect(payload.execution.provenance.detail ?? "").toContain("attempt 2");
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("still serves the ordinary first attempt", async () => {
    stubGithub({ runAttempt: 1 });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).not.toBeNull();
    expect(payload.preflight.data).not.toBeNull();
  });

  it("fails closed when the newest run is unreadable, rather than skipping it", async () => {
    // The listing used to filter unparseable runs out, so a malformed newest
    // run vanished and the previous run's PASS became "current".
    stubGithub({ runAttempt: null });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).toBeNull();
    expect(payload.preflight.data).toBeNull();
    expect(payload.execution.provenance.scope).not.toContain("#43");
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("drops a run whose attempt GitHub did not state", async () => {
    // `run_attempt` used to default to 1. Every attempt-scoped lookup and
    // every step window keys on it, so an unstated attempt is not a run this
    // model can reason about.
    stubGithub({ runAttempt: null });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).toBeNull();
    expect(payload.preflight.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("reads the jobs of the attempt on screen, not the latest attempt", async () => {
    const handler = stubGithub({ runAttempt: 3 });
    await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    const jobCalls = handler.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/jobs"));
    expect(jobCalls.length).toBeGreaterThan(0);
    expect(jobCalls.every((url) => url.includes("/attempts/3/jobs"))).toBe(true);
  });

  it("stops at the freshness boundary instead of scanning forever", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-01-02T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).toBeNull();
    expect(payload.execution.provenance.detail).toContain("within the last");
  });

  it("skips a preflight-only run when looking for the executor cycle", async () => {
    stubGithub({
      runs: [
        {
          id: 950,
          runNumber: 44,
          conclusion: "success",
          event: "workflow_dispatch",
          updatedAt: "2026-08-07T18:30:00Z",
          runtimeArtifactName: null,
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: null,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-07T19:00:00Z"),
    });
    expect(payload.execution.data?.status).toBe("PASS");
    expect(payload.operations.data?.lastSuccessfulRun?.runId).toBe(900);
  });
});

describe("lineage mismatch is fail-closed", () => {
  it("withholds plan, execution and convergence when the artifact names another release", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${OTHER_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });

    expect(payload.strategy.provenance.freshness).toBe("MISMATCH");
    expect(payload.strategy.data).toBeNull();
    expect(payload.execution.provenance.freshness).toBe("MISMATCH");
    expect(payload.execution.data).toBeNull();
    expect(payload.convergence.provenance.freshness).toBe("MISMATCH");
    expect(payload.convergence.data).toBeNull();
    expect(payload.universe.provenance.freshness).toBe("MISMATCH");
    expect(payload.universe.data).toBeNull();
    expect(payload.warnings.join(" ")).toContain("lineage");
    // It must not fall back to an older artifact for the approved SHA.
    expect(JSON.stringify(payload)).not.toContain("f8756105eb63dde2");
  });

  it("withholds when the run record's recorded release disagrees", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson(),
            lastRunJson({ release_sha: OTHER_SHA }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.provenance.freshness).toBe("MISMATCH");
    expect(payload.execution.data).toBeNull();
    expect(payload.convergence.data).toBeNull();
  });

  it("withholds every dependent section on a preflight identity mismatch", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: diagnosticsZipBuffer(
            preflightJson({
              details: {
                ...(preflightJson().details as Record<string, unknown>),
                strategy_identity: "a-different-identity",
              },
            }),
          ),
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    // A preflight/plan identity conflict is a lineage conflict, so nothing
    // that depends on it may stay CURRENT or PASS.
    expect(payload.preflight.provenance.freshness).toBe("MISMATCH");
    expect(payload.preflight.data).toBeNull();
    expect(payload.strategy.provenance.freshness).toBe("MISMATCH");
    expect(payload.strategy.data).toBeNull();
    expect(payload.universe.provenance.freshness).toBe("MISMATCH");
    expect(payload.universe.data).toBeNull();
    expect(payload.execution.provenance.freshness).toBe("MISMATCH");
    expect(payload.execution.data).toBeNull();
    expect(payload.convergence.provenance.freshness).toBe("MISMATCH");
    expect(payload.convergence.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
    expect(payload.validationGate.reasons).toContain("LINEAGE_MISMATCH");
  });

  it("withholds every dependent section on a preflight universe mismatch", async () => {
    const base = preflightJson();
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: diagnosticsZipBuffer({
            ...base,
            checks: [
              {
                name: "ranking_universe",
                passed: true,
                detail: `540 symbols; hash=${"f".repeat(64)}`,
              },
            ],
          }),
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.universe.provenance.freshness).toBe("MISMATCH");
    expect(payload.universe.data).toBeNull();
    expect(payload.strategy.data).toBeNull();
    expect(payload.preflight.data).toBeNull();
    expect(payload.execution.data).toBeNull();
    expect(payload.convergence.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("withholds every dependent section on a non-V11 strategy version", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson(),
            lastRunJson({ strategy_version: "v12-experimental" }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.data).toBeNull();
    expect(payload.execution.data).toBeNull();
    expect(payload.convergence.data).toBeNull();
    expect(payload.validationGate.reasons).toContain("LINEAGE_MISMATCH");
  });

  it("withholds everything when the preflight cannot prove its own lineage", async () => {
    // A preflight report that simply omits its strategy identity used to be
    // read as "nothing to disagree with" and left every section CURRENT.
    const base = preflightJson();
    const details = { ...(base.details as Record<string, unknown>) };
    delete details.strategy_identity;
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: diagnosticsZipBuffer({ ...base, details }),
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    // Missing evidence is reported as UNAVAILABLE, not as a disagreement —
    // but it withholds exactly as much.
    for (const key of [
      "strategy",
      "universe",
      "preflight",
      "execution",
      "convergence",
    ] as const) {
      expect(payload[key].data).toBeNull();
      expect(payload[key].provenance.freshness).toBe("UNAVAILABLE");
    }
    expect(payload.validationGate.effective).not.toBe("PASS");
    expect(payload.validationGate.reasons).toContain("LINEAGE_MISMATCH");
  });

  it("withholds everything when the frozen plan has no signal date", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson({
              adaptive_rebalance_pending: frozenPlanJson({ signal_date: null }),
            }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.data).toBeNull();
    expect(payload.execution.data).toBeNull();
    expect(payload.convergence.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
    // The plan must not leak through any section once it is withheld.
    expect(JSON.stringify(payload)).not.toContain("f8756105eb63dde2");
  });

  it("returns UNAVAILABLE, not a fallback, for a corrupt artifact", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: "corrupt",
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.provenance.freshness).toBe("UNAVAILABLE");
    expect(payload.strategy.data).toBeNull();
    // The independent preflight is unaffected by a broken runtime artifact.
    expect(payload.preflight.data).not.toBeNull();
    expect(payload.broker.provenance.freshness).toBe("CURRENT");
  });
});

describe("effective validation gate", () => {
  it("is FAIL for an expired report even though the report says PASS", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-20T17:00:00Z"),
    });
    expect(payload.validation.data?.status).toBe("PASS");
    expect(payload.validationGate.reportAssessment).toBe("PASS");
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.reasons).toContain("EXPIRED");
  });

  it("is FAIL when the canonical report's identity disagrees with production", async () => {
    // The canonical report is now the *authority* the preflight and plan are
    // compared against, so a report describing a different build breaks
    // lineage first and withholds every dependent section — a stronger outcome
    // than the identity mismatch alone, and it must still fail the gate.
    stubGithub({
      validation: validationJson({
        strategy: {
          version: "v11-adaptive-momentum",
          identity: { value: "b".repeat(64) },
        },
      }),
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.reasons).toContain("LINEAGE_MISMATCH");
    expect(
      payload.validationGate.reasons.some((reason) =>
        reason.startsWith("STRATEGY_IDENTITY_"),
      ),
    ).toBe(true);
    expect(payload.strategy.data).toBeNull();
    expect(payload.preflight.data).toBeNull();
  });

  it("is FAIL when the approved SHA is only derived from an artifact name", async () => {
    stubGithub({ approvedShaVariable: null });
    vi.stubEnv("PRODUCTION_RELEASE_SHA", "");
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.release.data?.approvedShaSource).toBe(
      "derived-from-runtime-artifact",
    );
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.reasons).toContain("APPROVED_RELEASE_UNKNOWN");
  });
});

describe("operations and risk states", () => {
  it("distinguishes an infrastructure failure from a post-start failure", async () => {
    const runs = defaultRuns();
    runs.unshift({
      id: 990,
      runNumber: 45,
      conclusion: "failure",
      event: "schedule",
      updatedAt: "2026-08-07T16:40:00Z",
      runtimeArtifactName: null,
      diagnostics: null,
    });
    stubGithub({ runs, latestRunJobs: [{ steps: [] }] });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.operations.data?.latestAttempt?.infrastructureFailure).toBe(
      true,
    );
    // The older successful cycle is still readable.
    expect(payload.execution.data?.status).toBe("PASS");
    expect(payload.operations.data?.lastSuccessfulRun?.runId).toBe(900);
  });

  it("surfaces a risk-tier conflict between the cycle and the saved file", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson({ risk_tier: "CAUTIOUS" }),
            lastRunJson({ risk_tier: "NORMAL" }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.data?.riskTierConflict).toBe(true);
    expect(payload.strategy.data?.executionRiskTier?.tier).toBe("NORMAL");
    expect(payload.strategy.data?.persistedRiskTier?.tier).toBe("CAUTIOUS");
  });

  it("reports HALT, a zero target and the recovery latch honestly", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson({
              risk_tier: "HALT",
              adaptive_risk_off_latched: true,
              adaptive_rebalance_pending: frozenPlanJson({
                risk_off: true,
                target_weights: {},
                sector_by_symbol: {},
                order_attempts: {},
                construction_risk_tier: "HALT",
              }),
            }),
            lastRunJson({ risk_tier: "HALT", market_entry_allowed: false }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: okBroker({
        positions: [],
        positionCount: 0,
        grossExposure: 0,
        grossExposurePct: 0,
        cash: 1_000_000,
        cashPct: 100,
      }),
      now: NOW,
    });
    expect(payload.strategy.data?.marketGate).toBe("RISK_OFF");
    expect(payload.strategy.data?.recoveryLatchArmed).toBe(true);
    expect(payload.execution.data?.marketEntryAllowed).toBe(false);
    expect(payload.convergence.data?.targetCashPct).toBe(100);
  });

  it("keeps a real TQQQ legacy holding visible with a zero target", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: okBroker({
        positions: [
          {
            symbol: "TQQQ",
            qty: 500,
            avgEntryPrice: 100,
            currentPrice: 120,
            marketValue: 60_000,
            unrealizedPl: 10_000,
            unrealizedPlPct: 20,
            side: "long",
          },
        ],
        positionCount: 1,
        grossExposure: 60_000,
        grossExposurePct: 6,
      }),
      now: NOW,
    });
    const tqqq = payload.convergence.data?.rows.find(
      (row) => row.symbol === "TQQQ",
    );
    expect(tqqq?.classification).toBe("LEGACY_EXCLUDED");
    expect(tqqq?.targetWeightPct).toBe(0);
  });

  it("keeps a broker outage separate from strategy availability", async () => {
    // With no broker binding configured, a broker outage cannot also revoke
    // the production authorization, so the two concerns stay independent.
    vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", SECRET_BROKER_NUMBER);
    stubGithub();
    const bound = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(bound.strategy.provenance.freshness).toBe("CURRENT");

    const outage = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: {
        ok: false,
        code: "ALPACA_UNREACHABLE",
        detail: "Could not reach Alpaca for the selected account.",
      },
      now: NOW,
    });
    expect(outage.broker.provenance.freshness).toBe("UNAVAILABLE");
    // The binding itself can no longer be verified, so production data is
    // withheld — fail-closed, and clearly attributed.
    expect(outage.authorization.data?.denialReason).toBe(
      "BROKER_ACCOUNT_UNVERIFIED",
    );
    expect(outage.convergence.data).toBeNull();
  });

  it("warns when the server has no GitHub token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    stubGithub();
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.warnings.join(" ")).toContain("GITHUB_TOKEN");
  });
});

/* ---------------------------------------------------------------------------
 * A future timestamp is broken data, not fresh data. Every independently-aging
 * source is exercised, because each is classified by its own contract.
 * ------------------------------------------------------------------------- */

describe("future-dated sources are never CURRENT", () => {
  function futureRuns(offsetMs: number): RunSpec[] {
    const at = new Date(NOW.getTime() + offsetMs).toISOString();
    return [
      {
        id: 900,
        runNumber: 43,
        conclusion: "success",
        event: "schedule",
        updatedAt: at,
        runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
        runtimeZip: runtimeZipBuffer(
          performanceJson({ updated_at: at }),
          lastRunJson({ completed_at: at }),
        ),
        diagnostics: diagnosticsZipBuffer(preflightJson({ checked_at: at })),
      },
    ];
  }

  it.each([
    ["1 hour", 60 * 60 * 1000],
    ["23 hours", 23 * 60 * 60 * 1000],
  ])(
    "marks runtime, preflight, execution and workflow MISMATCH %s ahead",
    async (_label, offsetMs) => {
      stubGithub({ runs: futureRuns(offsetMs) });
      const payload = await buildStrategyStatus({
        viewer: OWNER,
        account: PRODUCTION_ACCOUNT,
        broker: OK_BROKER,
        now: NOW,
      });

      for (const key of ["strategy", "preflight", "execution", "operations"] as const) {
        expect(
          payload[key].provenance.freshness,
          `${key} must not be CURRENT`,
        ).not.toBe("CURRENT");
      }
      // The run record claiming to finish in the future is itself a lineage
      // conflict, so the dependent sections are withheld outright.
      expect(payload.strategy.data).toBeNull();
      expect(payload.execution.data).toBeNull();
      expect(payload.convergence.data).toBeNull();
      expect(payload.validationGate.effective).not.toBe("PASS");
    },
  );

  it("still accepts a timestamp inside the clock-skew tolerance", async () => {
    stubGithub({ runs: futureRuns(60 * 1000) });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).not.toBeNull();
    expect(payload.execution.provenance.freshness).toBe("CURRENT");
  });

  it("withholds when the run record has no completion timestamp at all", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson(),
            lastRunJson({ completed_at: null }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).toBeNull();
    expect(payload.strategy.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("gives every non-CURRENT section a usable explanation", async () => {
    stubGithub({ runs: futureRuns(23 * 60 * 60 * 1000) });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    for (const [key, value] of Object.entries(payload)) {
      if (
        typeof value !== "object" ||
        value === null ||
        !("provenance" in value)
      ) {
        continue;
      }
      const section = value as { provenance: { freshness: string; detail: string | null } };
      if (section.provenance.freshness === "CURRENT") continue;
      expect(section.provenance.detail, `${key} has no detail`).toBeTruthy();
    }
  });
});

/* ---------------------------------------------------------------------------
 * A failing preflight check must break the gate even when the check's own
 * detail text still parses into a syntactically valid hash.
 * ------------------------------------------------------------------------- */

describe("a failing ranking_universe check is fatal", () => {
  it("breaks lineage even though its detail still contains a valid hash", async () => {
    const base = preflightJson();
    const checks = (base.checks as { name: string; passed: boolean; detail: string }[]).map(
      (check) =>
        check.name === "ranking_universe" ? { ...check, passed: false } : check,
    );
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: diagnosticsZipBuffer({ ...base, checks }),
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    // The hash still matches the plan's, so a hash-only comparison agrees.
    expect(payload.universe.data).toBeNull();
    expect(payload.strategy.data).toBeNull();
    expect(payload.execution.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
    expect(payload.warnings.join(" ")).toContain("ranking universe");
  });

  it("also fails the gate when the executor's own validation check failed", async () => {
    const base = preflightJson();
    const checks = (base.checks as { name: string; passed: boolean; detail: string }[]).map(
      (check) =>
        check.name === "canonical_validation_gate"
          ? { ...check, passed: false }
          : check,
    );
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: diagnosticsZipBuffer({ ...base, checks }),
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.reasons).toContain("PREFLIGHT_GATE_FAILED");
  });
});

/* ---------------------------------------------------------------------------
 * The preflight comes from the latest COMPLETED run, not the latest successful
 * one.
 *
 * The preflight runs before the executor and writes its report whatever
 * happens next — a run usually fails *because* the preflight refused. Skipping
 * failed runs therefore skipped exactly the reports that matter and fell back
 * to an older green one, so the screen showed a passing preflight while
 * production had just refused to trade.
 * ------------------------------------------------------------------------- */

describe("preflight selection follows completion, not conclusion", () => {
  /** Newer failed run with diagnostics; older successful execution+preflight. */
  function newerFailureRuns(diagnostics: Buffer): RunSpec[] {
    return [
      {
        // Modelled on run 30747478499: workflow_dispatch, completed, failure,
        // diagnostics written, no runtime artifact.
        id: 30747478499,
        runNumber: 2,
        conclusion: "failure",
        event: "workflow_dispatch",
        updatedAt: "2026-08-07T16:40:00Z",
        runtimeArtifactName: null,
        diagnostics,
      },
      {
        id: 900,
        runNumber: 43,
        conclusion: "success",
        event: "schedule",
        updatedAt: "2026-08-07T16:06:00Z",
        runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
        runtimeZip: runtimeZipBuffer(),
        diagnostics: DEFAULT_DIAGNOSTICS,
      },
    ];
  }

  it("takes the newer failed run's preflight and refuses to pass the gate", async () => {
    const refused = failedPreflightJson({
      checks: (
        failedPreflightJson().checks as {
          name: string;
          passed: boolean;
          detail: string;
        }[]
      ).map((check) =>
        check.name === "canonical_validation_gate"
          ? { ...check, passed: false, detail: "validation refused" }
          : check,
      ),
    });
    stubGithub({ runs: newerFailureRuns(diagnosticsZipBuffer(refused)) });

    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });

    // The newer failed run supplied the preflight, not the older green one.
    expect(payload.preflight.provenance.scope).toContain("#2");
    expect(payload.preflight.provenance.scope).toContain("failure");
    // And nothing about it authorizes a buy.
    expect(payload.validationGate.effective).not.toBe("PASS");
    expect(payload.validationGate.reasons).toContain("PREFLIGHT_GATE_FAILED");
    expect(payload.validationGate.reasons).toContain("PREFLIGHT_NOT_PASS");
  });

  it("does not fall back to an older green preflight for the gate", async () => {
    stubGithub({ runs: newerFailureRuns(diagnosticsZipBuffer(failedPreflightJson())) });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.preflight.data?.status).toBe("FAIL");
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("still keeps the older execution — only the preflight is superseded", async () => {
    stubGithub({ runs: newerFailureRuns(diagnosticsZipBuffer(failedPreflightJson())) });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    // The failed run produced no runtime state, so the last successful
    // executor cycle is still the one on screen.
    expect(payload.execution.data?.runUrl).toContain("/runs/900");
  });

  it("skips a newer completed run that produced no preflight at all", async () => {
    // An infrastructure failure that ended before the preflight step
    // demonstrably supersedes nothing.
    stubGithub({
      runs: [
        {
          id: 950,
          runNumber: 44,
          conclusion: "failure",
          event: "schedule",
          updatedAt: "2026-08-07T16:50:00Z",
          runtimeArtifactName: null,
          diagnostics: null,
        },
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.preflight.data).not.toBeNull();
    expect(payload.preflight.provenance.scope).toContain("#43");
    expect(payload.validationGate.effective).toBe("PASS");
  });

  it.each([
    ["a job whose step list is empty", [{ steps: [] }]],
    ["a run that reports no jobs at all", []],
  ])(
    "does not reach past a newer run when the evidence is %s",
    async (_label, latestRunJobs) => {
      // Both shapes were observed on a real cancelled paper-production run.
      // Neither proves the preflight was skipped, so neither may license an
      // older green report.
      stubGithub({
        runs: [
          {
            id: 952,
            runNumber: 46,
            conclusion: "failure",
            event: "schedule",
            updatedAt: "2026-08-07T16:50:00Z",
            runtimeArtifactName: null,
            diagnostics: null,
          },
          {
            id: 900,
            runNumber: 43,
            conclusion: "success",
            event: "schedule",
            updatedAt: "2026-08-07T16:06:00Z",
            runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
            runtimeZip: runtimeZipBuffer(),
            diagnostics: DEFAULT_DIAGNOSTICS,
          },
        ],
        latestRunJobs,
      });
      const payload = await buildStrategyStatus({
        viewer: OWNER,
        account: PRODUCTION_ACCOUNT,
        broker: OK_BROKER,
        now: NOW,
      });
      expect(payload.preflight.data).toBeNull();
      expect(payload.preflight.provenance.freshness).toBe("UNAVAILABLE");
      // Crucially, it did not silently show run #43's green report instead.
      expect(payload.preflight.provenance.scope).not.toContain("#43");
      expect(payload.validationGate.effective).not.toBe("PASS");
    },
  );

  it.each([
    ["cancelled", { conclusion: "cancelled" }],
    ["still running", { status: "in_progress", conclusion: null }],
    ["without a conclusion", { conclusion: null }],
    ["renamed", { name: "Verify broker health" }],
  ])(
    "does not reach past a newer run whose preflight step is %s",
    async (_label, patch) => {
      // `DID_NOT_RUN` requires an explicit completed+skipped. None of these
      // shapes proves the step never produced a report, so none may license
      // an older green one.
      const step = (name: string, conclusion: string | null) => ({
        name,
        status: "completed",
        conclusion,
        started_at: "2026-08-07T16:49:00Z",
        completed_at: "2026-08-07T16:50:00Z",
      });
      stubGithub({
        runs: [
          {
            id: 953,
            runNumber: 47,
            conclusion: "failure",
            event: "schedule",
            updatedAt: "2026-08-07T16:50:00Z",
            runtimeArtifactName: null,
            diagnostics: null,
          },
          {
            id: 900,
            runNumber: 43,
            conclusion: "success",
            event: "schedule",
            updatedAt: "2026-08-07T16:06:00Z",
            runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
            runtimeZip: runtimeZipBuffer(),
            diagnostics: DEFAULT_DIAGNOSTICS,
          },
        ],
        latestRunJobs: [
          {
            steps: [
              {
                ...step("Verify paper broker and deployment health", "success"),
                ...patch,
              },
            ],
          },
        ],
      });
      const payload = await buildStrategyStatus({
        viewer: OWNER,
        account: PRODUCTION_ACCOUNT,
        broker: OK_BROKER,
        now: NOW,
      });
      expect(payload.preflight.data).toBeNull();
      expect(payload.preflight.provenance.freshness).toBe("UNAVAILABLE");
      expect(payload.preflight.provenance.scope).not.toContain("#43");
      expect(payload.validationGate.effective).not.toBe("PASS");
    },
  );

  it.each([
    ["a corrupt runtime ZIP", { runtimeZip: "corrupt" as const }, {}],
    ["a missing runtime artifact", { runtimeArtifactName: null }, {}],
    ["a runtime download that fails", { runtimeZip: "gone" as const }, {}],
    [
      "a runtime artifact whose performance.json is schema-invalid",
      { runtimeZip: runtimeZipBuffer({ ...performanceJson(), equity: "no" }) },
      {},
    ],
    [
      "a runtime artifact whose last_run.json is schema-invalid",
      {
        runtimeZip: runtimeZipBuffer(performanceJson(), {
          ...lastRunJson(),
          paper_only: false,
        }),
      },
      {},
    ],
    [
      "a runtime artifact recording a different release",
      {
        runtimeZip: runtimeZipBuffer(performanceJson(), {
          ...lastRunJson(),
          release_sha: "d".repeat(40),
        }),
      },
      {},
    ],
    [
      "an expired runtime artifact",
      {},
      { runtimeArtifactPatch: { runId: 900, patch: { expired: true } } },
    ],
    [
      "an oversized runtime artifact",
      {},
      {
        runtimeArtifactPatch: {
          runId: 900,
          patch: { size_in_bytes: 900_000_000 },
        },
      },
    ],
  ])(
    "REPRO 1: does not report PASS with a valid preflight but %s",
    async (_label, patch, stubExtras) => {
      // The gate takes `executionRunId` from the *selector's run metadata*,
      // which is populated even when the selection failed. So a run whose
      // preflight is a genuine 18/18 PASS and whose runtime artifact cannot be
      // read at all satisfies the cycle check — the preflight and the
      // (nonexistent) execution "agree" because they name the same run — and
      // the gate goes green with no execution evidence whatsoever.
      stubGithub({
        runs: [
          {
            id: 900,
            runNumber: 43,
            conclusion: "success",
            event: "schedule",
            updatedAt: "2026-08-07T16:06:00Z",
            runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
            runtimeZip: runtimeZipBuffer(),
            diagnostics: DEFAULT_DIAGNOSTICS,
            ...patch,
          },
        ],
        ...stubExtras,
      });
      const payload = await buildStrategyStatus({
        viewer: OWNER,
        account: PRODUCTION_ACCOUNT,
        broker: OK_BROKER,
        now: NOW,
      });
      expect(payload.execution.data).toBeNull();
      expect(payload.validationGate.effective).not.toBe("PASS");
      expect(payload.validationGate.reasons).toContain("EXECUTION_UNAVAILABLE");
    },
  );

  it("the same run with a readable runtime artifact does reach PASS", async () => {
    // The control. Without it the cases above could all be passing because
    // something unrelated in the fixture is broken.
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).not.toBeNull();
    expect(payload.validationGate.reasons).not.toContain("EXECUTION_UNAVAILABLE");
    expect(payload.validationGate.effective).toBe("PASS");
  });

  it.each([
    ["recorded FAIL", { status: "FAIL", market_entry_allowed: false }],
    ["recorded DEGRADED", { status: "DEGRADED" }],
    ["market_entry_allowed false", { market_entry_allowed: false }],
    ["market_entry_allowed null", { market_entry_allowed: null }],
    ["market_entry_allowed absent", { market_entry_allowed: undefined }],
    [
      "a blocking action",
      { blocking_actions: [{ action: "SHORT_DETECTED", symbol: "AAPL" }] },
    ],
  ])(
    "REPRO 1: the gate must not report PASS for a cycle that %s",
    async (_label, runPatch) => {
      // The gate proves the evidence documents are *readable*. It never reads
      // what they say. A cycle that ran, wrote a perfectly well-formed runtime
      // artifact, and recorded `status: "FAIL"` with `market_entry_allowed:
      // false` satisfies every existing condition.
      stubGithub({
        runs: [
          {
            id: 900,
            runNumber: 43,
            conclusion: "success",
            event: "schedule",
            updatedAt: "2026-08-07T16:06:00Z",
            runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
            runtimeZip: runtimeZipBuffer(performanceJson(), {
              ...lastRunJson(),
              ...runPatch,
            }),
            diagnostics: DEFAULT_DIAGNOSTICS,
          },
        ],
      });
      const payload = await buildStrategyStatus({
        viewer: OWNER,
        account: PRODUCTION_ACCOUNT,
        broker: OK_BROKER,
        now: NOW,
      });
      expect(payload.validationGate.effective).not.toBe("PASS");
    },
  );

  it("REPRO 1b: a present but unusable frozen plan invalidates the runtime", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson({ adaptive_rebalance_pending: { not: "a plan" } }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.execution.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("REPRO 1c: performance.json from another day is a mixed artifact", async () => {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson({ updated_at: "2026-07-01T16:05:05+00:00" }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.validationGate.effective).not.toBe("PASS");
  });

  it("fails closed on a corrupt newest diagnostics instead of searching back", async () => {
    stubGithub({
      runs: [
        {
          id: 951,
          runNumber: 45,
          conclusion: "failure",
          event: "schedule",
          updatedAt: "2026-08-07T16:50:00Z",
          runtimeArtifactName: null,
          diagnostics: Buffer.from("this is not a zip archive at all"),
        },
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    const payload = await buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.preflight.data).toBeNull();
    expect(payload.validationGate.effective).not.toBe("PASS");
  });
});

/**
 * Fifth audit round: the runtime authorization holes, end to end.
 *
 * Each of these builds a real payload through `buildStrategyStatus` with a
 * mutated runtime artifact, so what is asserted is what the page would show —
 * not what a unit test of the gate says in isolation. Every one of them
 * reaches `PASS` on `b645cf572`.
 */
describe("REPRO 5: positions.json was required but never read", () => {
  function withPositions(positions: Record<string, unknown>) {
    return {
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success" as const,
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(performanceJson(), lastRunJson(), positions),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    };
  }

  async function build() {
    return buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
  }

  it("refuses a runtime state recording a short position", async () => {
    // A short is *the* blocking reconciliation state in V11: every manager
    // stops until the account is flat. An artifact recording one, presented
    // as evidence that the cycle was healthy, is the inversion the gate
    // exists to prevent — and the file was required by the contract and then
    // never opened.
    const shorted = positionsJson();
    const rows = (shorted.positions as Record<string, unknown>[]).map((row, index) =>
      index === 0 ? { ...row, qty: -100, side: "PositionSide.SHORT" } : row,
    );
    stubGithub(withPositions({ ...shorted, positions: rows }));
    const payload = await build();
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.details.join(" ")).toContain("short position");
  });

  it("refuses a position count that contradicts performance.num_positions", async () => {
    // Two documents written from one broker snapshot. The count is the one
    // number both state independently, so a disagreement means the artifact
    // is a mixture of two cycles.
    const short = positionsJson();
    stubGithub(
      withPositions({
        ...short,
        positions: (short.positions as unknown[]).slice(0, 3),
      }),
    );
    const payload = await build();
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.details.join(" ")).toContain("num_positions");
  });

  it.each([
    ["a zero quantity", { qty: 0 }],
    ["a negative price", { current_price: -1 }],
    ["a zero entry price", { avg_entry_price: 0 }],
    ["an unclassifiable side", { side: "PositionSide.SIDEWAYS" }],
    ["a long marked with a negative quantity", { qty: -5, side: "long" }],
    ["a non-finite market value", { market_value: null }],
    ["a malformed symbol", { symbol: "not a ticker" }],
  ])("refuses a position list with %s", async (_label, patch) => {
    const base = positionsJson();
    const rows = (base.positions as Record<string, unknown>[]).map((row, index) =>
      index === 0 ? { ...row, ...patch } : row,
    );
    stubGithub(withPositions({ ...base, positions: rows }));
    const payload = await build();
    expect(payload.validationGate.effective).toBe("FAIL");
  });

  it("refuses a positions file stamped in a different cycle", async () => {
    const base = positionsJson();
    stubGithub(withPositions({ ...base, updated_at: "2026-08-05 12:05:05" }));
    const payload = await build();
    expect(payload.validationGate.effective).toBe("FAIL");
  });

  it("refuses a positions file with no usable timestamp", async () => {
    const base = positionsJson();
    stubGithub(withPositions({ ...base, updated_at: "recently" }));
    const payload = await build();
    expect(payload.validationGate.effective).toBe("FAIL");
  });

  it("accepts the healthy artifact, so the refusals above mean something", async () => {
    stubGithub(withPositions(positionsJson()));
    const payload = await build();
    expect(payload.validationGate.effective).toBe("PASS");
  });
});

describe("REPRO 6: an ended cycle is not an authorizing one", () => {
  function withLastRun(patch: Record<string, unknown>) {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(performanceJson(), {
            ...lastRunJson(),
            ...patch,
          }),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    return buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
  }

  it("refuses a cycle that ended on a deferred infrastructure cancellation", async () => {
    // It *is* a terminal action — the cycle reached its own end — but what it
    // says it reached the end of is a cancellation it could not complete. It
    // ends a cycle; it does not authorize the next one.
    const payload = await withLastRun({
      action_counts: {
        ADAPTIVE_PLAN: 1,
        ADAPTIVE_DEFERRED_INFRASTRUCTURE_CANCELLATION: 1,
      },
    });
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.details.join(" ")).toContain(
      "deferred infrastructure cancellation",
    );
  });

  it.each([
    "REBALANCE_PENDING_CANCELLATIONS",
    "ORDER_BOOK_RECONCILIATION_PENDING_CANCELLATIONS",
    "SHORT_RECONCILIATION_PENDING_CANCELLATIONS",
    "SELL_CAPACITY_RECONCILIATION_PENDING_CANCELLATIONS",
    "POSITION_SNAPSHOT_RECONCILIATION_PENDING_CANCELLATIONS",
    "PENDING_CANCELLATION",
  ])("refuses a cycle that left %s outstanding", async (action) => {
    const payload = await withLastRun({
      action_counts: { ADAPTIVE_PLAN_DEFERRED: 1, [action]: 1 },
    });
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.details.join(" ")).toContain("cancellation");
  });

  it("still accepts an ordinary deferred plan", async () => {
    // The distinction has to bite in one direction only: deferring the
    // replacement buys to a later boundary is the monthly V11 path.
    const payload = await withLastRun({
      action_counts: { ADAPTIVE_PLAN: 1, ADAPTIVE_PLAN_DEFERRED: 1 },
    });
    expect(payload.validationGate.effective).toBe("PASS");
  });
});

describe("REPRO 7: the two documents must agree about the risk tier", () => {
  async function withTiers(runTier: string, perfTier: string) {
    stubGithub({
      runs: [
        {
          id: 900,
          runNumber: 43,
          conclusion: "success",
          event: "schedule",
          updatedAt: "2026-08-07T16:06:00Z",
          runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
          runtimeZip: runtimeZipBuffer(
            performanceJson({ risk_tier: perfTier }),
            lastRunJson({ risk_tier: runTier }),
          ),
          diagnostics: DEFAULT_DIAGNOSTICS,
        },
      ],
    });
    return buildStrategyStatus({
      viewer: OWNER,
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
  }

  it.each([
    ["NORMAL", "HALT"],
    ["HALT", "NORMAL"],
    ["NORMAL", "CAUTIOUS"],
    ["CAUTIOUS", "NORMAL"],
    ["CAUTIOUS", "HALT"],
  ])("refuses last_run=%s beside performance=%s", async (runTier, perfTier) => {
    // Written from one snapshot seconds apart, so a disagreement is not a
    // race — it is two cycles in one artifact. `NORMAL` beside `HALT` is the
    // dangerous direction: it authorizes a buy on an account the risk policy
    // has halted.
    const payload = await withTiers(runTier, perfTier);
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.details.join(" ")).toMatch(
      /riskTierAgrees|HALT/,
    );
  });

  it("refuses a consistent HALT, which is agreement about a stop", async () => {
    const payload = await withTiers("HALT", "HALT");
    expect(payload.validationGate.effective).toBe("FAIL");
    expect(payload.validationGate.details.join(" ")).toContain("HALT");
  });

  it("accepts a consistent CAUTIOUS, which is agreement about trading on", async () => {
    const payload = await withTiers("CAUTIOUS", "CAUTIOUS");
    expect(payload.validationGate.effective).toBe("PASS");
  });
});
