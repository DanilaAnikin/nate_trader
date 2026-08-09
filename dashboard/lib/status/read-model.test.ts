import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGithubCache } from "./github-api";
import {
  buildStrategyStatus,
  type StatusAccount,
  type StatusViewer,
} from "./read-model";
import type { BrokerResult } from "./broker";
import type { BrokerInfo } from "./types";
import {
  APPROVED_SHA,
  DASHBOARD_SHA,
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
  runtimeZip?: Buffer | "corrupt";
  diagnostics?: Buffer | null;
}

function runtimeZipBuffer(
  perf: Record<string, unknown> = performanceJson(),
  run: Record<string, unknown> = lastRunJson(),
): Buffer {
  return buildZip([
    { name: "performance.json", content: JSON.stringify(perf) },
    { name: "positions.json", content: JSON.stringify(positionsJson()) },
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
      diagnostics: diagnosticsZipBuffer(),
    },
    {
      id: 800,
      runNumber: 42,
      conclusion: "success",
      event: "schedule",
      updatedAt: "2026-08-05T16:51:00Z",
      runtimeArtifactName: `paper-runtime-state-${APPROVED_SHA}`,
      runtimeZip: runtimeZipBuffer(),
      diagnostics: diagnosticsZipBuffer(),
    },
  ];
}

interface RouteOptions {
  approvedShaVariable?: string | null;
  runs?: RunSpec[];
  validation?: Record<string, unknown> | null;
  latestRunJobs?: { steps: unknown[] }[];
  releaseGate?: { conclusion: string; event: string } | null;
}

function stubGithub(options: RouteOptions = {}) {
  const {
    approvedShaVariable = APPROVED_SHA,
    runs = defaultRuns(),
    validation = validationJson(),
    latestRunJobs = [{ steps: [{ name: "checkout" }] }],
    releaseGate = { conclusion: "success", event: "push" },
  } = options;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
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
      return json({
        workflow_runs: runs.map((run) => ({
          id: run.id,
          run_number: run.runNumber,
          run_attempt: 1,
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
    const jobsMatch = url.match(/\/actions\/runs\/(\d+)\/jobs/);
    if (jobsMatch) return json({ jobs: latestRunJobs });

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
        if (!run.runtimeZip) return json({ message: "gone" }, 404);
        return zipResponse(run.runtimeZip);
      }
      if (!run.diagnostics) return json({ message: "gone" }, 404);
      return zipResponse(run.diagnostics);
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
  vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", "");
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
    vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", SECRET_BROKER_NUMBER);
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
    vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", SECRET_BROKER_NUMBER);
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
      diagnostics: diagnosticsZipBuffer(),
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
          diagnostics: diagnosticsZipBuffer(),
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
          diagnostics: diagnosticsZipBuffer(),
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
          diagnostics: diagnosticsZipBuffer(),
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

  it("withholds the preflight when its strategy identity disagrees", async () => {
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
    expect(payload.preflight.provenance.freshness).toBe("MISMATCH");
    expect(payload.preflight.data).toBeNull();
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
          diagnostics: diagnosticsZipBuffer(),
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

  it("is FAIL on a strategy-identity mismatch", async () => {
    stubGithub({
      validation: validationJson({
        strategy: {
          version: "v11-adaptive-momentum",
          identity: { value: "a-different-identity" },
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
    expect(payload.validationGate.reasons).toContain(
      "STRATEGY_IDENTITY_MISMATCH",
    );
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
          diagnostics: diagnosticsZipBuffer(),
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
          diagnostics: diagnosticsZipBuffer(),
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
    stubGithub();
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
    expect(payload.broker.provenance.freshness).toBe("UNAVAILABLE");
    expect(payload.strategy.provenance.freshness).toBe("CURRENT");
    expect(payload.convergence.data).toBeNull();
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
