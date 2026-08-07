import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGithubCache } from "./github-api";
import { buildStrategyStatus, type StatusAccount } from "./read-model";
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

const PRODUCTION_ACCOUNT: StatusAccount = {
  id: "acc-prod",
  nickname: "Paper production",
  mode: "paper",
  brokerAccountNumber: "PA3ABCDE1234",
};

const OBSERVER_ACCOUNT: StatusAccount = {
  id: "acc-observer",
  nickname: "Second paper",
  mode: "paper",
  brokerAccountNumber: "PA9ZZZZ0000",
};

const LIVE_ACCOUNT: StatusAccount = {
  id: "acc-live",
  nickname: "Real money",
  mode: "live",
  brokerAccountNumber: "PA0LIVE9999",
};

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

const OK_BROKER: BrokerResult = {
  ok: true,
  snapshot: brokerSnapshot(),
  fetchedAt: NOW.toISOString(),
};

interface RouteOptions {
  approvedShaVariable?: string | null;
  runtimeArtifactName?: string;
  runtimeZip?: Buffer | "corrupt" | "missing";
  diagnosticsZip?: Buffer;
  validation?: Record<string, unknown> | null;
  latestRunConclusion?: string;
  latestRunJobs?: { steps: unknown[] }[];
  releaseGateConclusion?: string | null;
  epochBaseline?: Record<string, unknown> | null;
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
  ]);
}

/** Route the GitHub REST calls the read model makes. */
function stubGithub(options: RouteOptions = {}) {
  const {
    approvedShaVariable = APPROVED_SHA,
    runtimeArtifactName = `paper-runtime-state-${APPROVED_SHA}`,
    runtimeZip = runtimeZipBuffer(),
    diagnosticsZip = diagnosticsZipBuffer(),
    validation = validationJson(),
    latestRunConclusion = "success",
    latestRunJobs = [{ steps: [{ name: "checkout" }] }],
    releaseGateConclusion = "success",
    epochBaseline = null,
  } = options;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
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
        workflow_runs: [
          {
            id: 900,
            run_number: 43,
            run_attempt: 1,
            status: "completed",
            conclusion: latestRunConclusion,
            event: "schedule",
            head_sha: REPO_SHA,
            created_at: "2026-08-07T16:00:00Z",
            run_started_at: "2026-08-07T16:00:00Z",
            updated_at: "2026-08-07T16:06:00Z",
            html_url: "https://github.com/x/y/actions/runs/900",
          },
          {
            id: 800,
            run_number: 42,
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
            event: "schedule",
            head_sha: REPO_SHA,
            created_at: "2026-08-05T16:45:00Z",
            run_started_at: "2026-08-05T16:45:00Z",
            updated_at: "2026-08-05T16:51:00Z",
            html_url: "https://github.com/x/y/actions/runs/800",
          },
        ],
      });
    }
    if (url.includes("/workflows/v11-release.yml/runs")) {
      return json({
        workflow_runs: releaseGateConclusion
          ? [
              {
                id: 700,
                run_number: 12,
                run_attempt: 1,
                status: "completed",
                conclusion: releaseGateConclusion,
                event: "push",
                head_sha: APPROVED_SHA,
                created_at: "2026-08-02T15:50:00Z",
                updated_at: "2026-08-02T15:58:00Z",
                html_url: "https://github.com/x/y/actions/runs/700",
              },
            ]
          : [],
      });
    }
    if (url.match(/\/actions\/runs\/\d+\/jobs/)) {
      return json({ jobs: latestRunJobs });
    }
    if (url.match(/\/actions\/runs\/\d+\/artifacts/)) {
      const artifacts: Record<string, unknown>[] = [];
      if (runtimeZip !== "missing") {
        artifacts.push({
          id: 1,
          name: runtimeArtifactName,
          size_in_bytes: 4271,
          expired: false,
          created_at: "2026-08-07T16:05:06Z",
        });
      }
      artifacts.push({
        id: 2,
        name: "paper-diagnostics",
        size_in_bytes: 1584,
        expired: false,
        created_at: "2026-08-07T16:05:07Z",
      });
      return json({ artifacts });
    }
    if (url.includes("/actions/artifacts/1/zip")) {
      if (runtimeZip === "missing") return json({ message: "gone" }, 404);
      const body =
        runtimeZip === "corrupt"
          ? Buffer.from("this is not a zip archive at all")
          : runtimeZip;
      return new Response(new Uint8Array(body));
    }
    if (url.includes("/actions/artifacts/2/zip")) {
      return new Response(new Uint8Array(diagnosticsZip));
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
      return epochBaseline
        ? new Response(JSON.stringify(epochBaseline))
        : json({ message: "Not Found" }, 404);
    }
    return json({ message: `unrouted ${url}` }, 404);
  });

  vi.stubGlobal("fetch", handler);
  return handler;
}

beforeEach(() => {
  clearGithubCache();
  vi.stubEnv("GITHUB_TOKEN", "test-token");
  vi.stubEnv("BUILD_SHA", DASHBOARD_SHA);
  vi.stubEnv("PRODUCTION_ACCOUNT_ID", PRODUCTION_ACCOUNT.id);
  vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", "");
  vi.stubEnv("V11_EPOCH_BASELINE", "");
});

describe("buildStrategyStatus — healthy production account", () => {
  it("separates the dashboard build, repository and approved trading SHAs", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });

    expect(payload.web.data?.dashboardBuildSha).toBe(DASHBOARD_SHA);
    expect(payload.release.data?.repositoryRefSha).toBe(REPO_SHA);
    expect(payload.release.data?.approvedPaperReleaseSha).toBe(APPROVED_SHA);
    expect(payload.operations.data?.latestAttempt?.triggerSha).toBe(REPO_SHA);
    expect(payload.release.data?.dashboardMatchesApprovedRelease).toBe(false);
    expect(payload.release.data?.approvedShaSource).toBe(
      "github-environment-variable",
    );
    expect(payload.release.data?.releaseGate).toBe("PASS");
    // A different dashboard build is expected, never reported as a failure.
    expect(payload.release.provenance.freshness).toBe("CURRENT");
  });

  it("exposes the frozen plan, risk state and convergence", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });

    expect(payload.strategy.provenance.freshness).toBe("CURRENT");
    expect(payload.strategy.data?.plan?.planId).toBe("f8756105eb63dde2");
    expect(payload.strategy.data?.marketGate).toBe("RISK_ON");
    expect(payload.strategy.data?.executionRiskTier?.tier).toBe("CAUTIOUS");
    expect(payload.strategy.data?.recoveryLatchArmed).toBe(false);
    // Not persisted by the runner — must stay explicitly unavailable.
    expect(payload.strategy.data?.spyClose).toBeNull();
    expect(payload.strategy.data?.breadthMultiplierPct).toBeNull();

    expect(payload.convergence.data?.targetCount).toBe(10);
    expect(payload.convergence.data?.actualCount).toBe(10);
    expect(payload.universe.data?.symbolCount).toBe(540);
    expect(payload.universe.data?.rankingUniverseSha256).toBe(UNIVERSE_HASH);
  });

  it("reads validation at the approved release and confirms identity match", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.validation.data?.status).toBe("PASS");
    expect(payload.validation.data?.readAtRef).toBe(APPROVED_SHA);
    expect(payload.validation.data?.identityMatchesRuntime).toBe("PASS");
    expect(payload.validation.data?.universeMatchesRuntime).toBe("PASS");
  });

  it("never leaks credentials, order identifiers or raw artifacts", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("test-token");
    expect(serialized).not.toContain("client_order_id");
    expect(serialized).not.toContain("order_id");
    expect(serialized).not.toContain("58371aed-250a-40c7-b883-a62c538100b1");
    expect(serialized).not.toContain("nt-adaptive-asml-sell");
    expect(serialized).not.toContain("PA3ABCDE1234");
    expect(serialized).not.toContain("test-service-key");
    expect(payload.accountBinding.data?.brokerAccountMask).toBe("••••1234");
  });
});

describe("buildStrategyStatus — degraded sources", () => {
  it("returns UNAVAILABLE, not a fallback, when the runtime artifact is corrupt", async () => {
    stubGithub({ runtimeZip: "corrupt" });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.provenance.freshness).toBe("UNAVAILABLE");
    expect(payload.strategy.data).toBeNull();
    expect(payload.strategy.provenance.detail).toMatch(/unreadable|parsed/);
    // The broker snapshot is independent and stays current.
    expect(payload.broker.provenance.freshness).toBe("CURRENT");
    expect(payload.convergence.data).toBeNull();
  });

  it("returns UNAVAILABLE when no runtime artifact is attached", async () => {
    stubGithub({ runtimeZip: "missing" });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.data).toBeNull();
    expect(payload.strategy.provenance.freshness).toBe("UNAVAILABLE");
  });

  it("flags MISMATCH when the artifact belongs to another release", async () => {
    stubGithub({
      runtimeArtifactName: `paper-runtime-state-${OTHER_SHA}`,
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.provenance.freshness).toBe("MISMATCH");
    expect(payload.strategy.data).toBeNull();
    expect(payload.warnings.join(" ")).toContain("release lineage");
  });

  it("flags MISMATCH when the run record's release differs from the approval", async () => {
    stubGithub({
      runtimeZip: runtimeZipBuffer(
        performanceJson(),
        lastRunJson({ release_sha: OTHER_SHA }),
      ),
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.provenance.freshness).toBe("MISMATCH");
  });

  it("marks stale runtime state STALE while the broker stays CURRENT", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-11T17:00:00Z"),
    });
    expect(payload.broker.provenance.freshness).toBe("CURRENT");
    expect(payload.strategy.provenance.freshness).toBe("STALE");
  });

  it("marks an over-week-old runtime EXPIRED", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-20T17:00:00Z"),
    });
    expect(payload.strategy.provenance.freshness).toBe("EXPIRED");
  });

  it("marks validation EXPIRED past the 35-day bar-boundary deadline", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: new Date("2026-08-20T17:00:00Z"),
    });
    expect(payload.validation.provenance.freshness).toBe("EXPIRED");
    expect(payload.validation.data?.expiresAt).toBe("2026-08-14T00:00:00.000Z");
  });

  it("flags a strategy-identity mismatch between evidence and running code", async () => {
    stubGithub({
      validation: validationJson({
        strategy: {
          version: "v11-adaptive-momentum",
          identity: { value: "a-different-identity" },
        },
      }),
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.validation.data?.identityMatchesRuntime).toBe("FAIL");
    expect(payload.validation.provenance.freshness).toBe("MISMATCH");
  });

  it("flags a ranking-universe mismatch", async () => {
    stubGithub({
      validation: validationJson({
        evidence: {
          ranking_universe_count: 540,
          ranking_universe_sha256: "f".repeat(64),
          bar_snapshot_through_date: "2026-07-10",
        },
      }),
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.validation.data?.universeMatchesRuntime).toBe("FAIL");
    expect(payload.validation.provenance.freshness).toBe("MISMATCH");
  });

  it("keeps an older successful cycle visible when the latest attempt failed", async () => {
    stubGithub({
      latestRunConclusion: "failure",
      latestRunJobs: [{ steps: [] }],
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.operations.data?.latestAttempt?.conclusion).toBe("failure");
    expect(payload.operations.data?.latestAttempt?.infrastructureFailure).toBe(
      true,
    );
    expect(payload.operations.data?.latestAttempt?.failureKind).toBe(
      "infrastructure",
    );
    expect(payload.operations.data?.lastSuccessfulRun?.runId).toBe(800);
    // The last successful execution is still readable.
    expect(payload.execution.data?.status).toBe("PASS");
  });

  it("distinguishes a post-start failure from an infrastructure failure", async () => {
    stubGithub({
      latestRunConclusion: "failure",
      latestRunJobs: [{ steps: [{ name: "checkout" }, { name: "preflight" }] }],
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.operations.data?.latestAttempt?.infrastructureFailure).toBe(
      false,
    );
    expect(payload.operations.data?.latestAttempt?.failureKind).toBe(
      "strategy-or-broker",
    );
  });

  it("reports a failed release gate without inventing a PASS", async () => {
    stubGithub({ releaseGateConclusion: "failure" });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.release.data?.releaseGate).toBe("FAIL");
  });

  it("derives the approved SHA from the artifact name and labels it as derived", async () => {
    stubGithub({ approvedShaVariable: null });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.release.data?.approvedPaperReleaseSha).toBe(APPROVED_SHA);
    expect(payload.release.data?.approvedShaSource).toBe(
      "derived-from-runtime-artifact",
    );
    expect(payload.release.provenance.detail).toContain("Derived");
  });

  it("fails closed to UNAVAILABLE without a server GitHub token", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.warnings.join(" ")).toContain("GITHUB_TOKEN");
  });

  it("keeps a broker failure separate from strategy availability", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: {
        ok: false,
        code: "ALPACA_UNREACHABLE",
        detail: "Could not reach Alpaca for the selected account.",
      },
      now: NOW,
    });
    expect(payload.broker.provenance.freshness).toBe("UNAVAILABLE");
    expect(payload.broker.data).toBeNull();
    expect(payload.strategy.provenance.freshness).toBe("CURRENT");
    expect(payload.convergence.data).toBeNull();
  });
});

describe("buildStrategyStatus — account binding", () => {
  it("marks a different paper account observer-only and convergence NOT_APPLICABLE", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: OBSERVER_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.accountBinding.data?.role).toBe("OBSERVER_ONLY_PAPER");
    expect(payload.accountBinding.data?.productionBound).toBe(false);
    expect(payload.convergence.provenance.freshness).toBe("NOT_APPLICABLE");
    expect(payload.convergence.data).toBeNull();
    // Strategy runtime still describes the executor, scoped to it explicitly.
    expect(payload.strategy.data?.plan?.planId).toBe("f8756105eb63dde2");
    expect(payload.strategy.provenance.scope).toContain("production executor");
  });

  it("marks a live account read-only and never production-bound", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: LIVE_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.accountBinding.data?.role).toBe("READ_ONLY_LIVE");
    expect(payload.accountBinding.data?.productionBound).toBe(false);
    expect(payload.convergence.provenance.freshness).toBe("NOT_APPLICABLE");
    expect(payload.accountMode).toBe("live");
  });

  it("binds by broker account number when no account id is configured", async () => {
    vi.stubEnv("PRODUCTION_ACCOUNT_ID", "");
    vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", "PA9ZZZZ0000");
    stubGithub();
    const payload = await buildStrategyStatus({
      account: OBSERVER_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.accountBinding.data?.productionBound).toBe(true);
    expect(payload.accountBinding.data?.bindingProof).toBe(
      "server-configured-broker-account-number",
    );
  });

  it("does not present any account as production-controlled without configuration", async () => {
    vi.stubEnv("PRODUCTION_ACCOUNT_ID", "");
    vi.stubEnv("PRODUCTION_ALPACA_ACCOUNT_NUMBER", "");
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.accountBinding.data?.role).toBe("OBSERVER_ONLY_PAPER");
    expect(payload.convergence.provenance.freshness).toBe("NOT_APPLICABLE");
  });
});

describe("buildStrategyStatus — risk states", () => {
  it("surfaces a risk-tier conflict between the cycle and the saved file", async () => {
    stubGithub({
      runtimeZip: runtimeZipBuffer(
        performanceJson({ risk_tier: "CAUTIOUS" }),
        lastRunJson({ risk_tier: "NORMAL" }),
      ),
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: OK_BROKER,
      now: NOW,
    });
    expect(payload.strategy.data?.riskTierConflict).toBe(true);
    expect(payload.strategy.data?.executionRiskTier?.tier).toBe("NORMAL");
    expect(payload.strategy.data?.persistedRiskTier?.tier).toBe("CAUTIOUS");
  });

  it("reports HALT and a zero-target risk-off plan without pretending it is missing data", async () => {
    stubGithub({
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
    });
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: {
        ok: true,
        snapshot: brokerSnapshot({
          positions: [],
          positionCount: 0,
          grossExposure: 0,
          grossExposurePct: 0,
          cash: 1_000_000,
          cashPct: 100,
        }),
        fetchedAt: NOW.toISOString(),
      },
      now: NOW,
    });

    expect(payload.strategy.data?.marketGate).toBe("RISK_OFF");
    expect(payload.strategy.data?.executionRiskTier?.tier).toBe("HALT");
    expect(payload.strategy.data?.recoveryLatchArmed).toBe(true);
    expect(payload.execution.data?.marketEntryAllowed).toBe(false);
    expect(payload.convergence.data?.targetCount).toBe(0);
    expect(payload.convergence.data?.targetCashPct).toBe(100);
    expect(payload.convergence.data?.nextSafeAction).toContain("risk-off");
  });

  it("keeps a real TQQQ legacy holding visible with a zero target", async () => {
    stubGithub();
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: {
        ok: true,
        snapshot: brokerSnapshot({
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
        fetchedAt: NOW.toISOString(),
      },
      now: NOW,
    });
    const tqqq = payload.convergence.data?.rows.find(
      (row) => row.symbol === "TQQQ",
    );
    expect(tqqq?.classification).toBe("LEGACY_EXCLUDED");
    expect(tqqq?.targetWeightPct).toBe(0);
    expect(tqqq?.marketValue).toBe(60_000);
    expect(payload.convergence.data?.legacyExcludedSymbols).toEqual(["TQQQ"]);
  });

  it("reports a nine-of-ten book as pending convergence, not as failure", async () => {
    stubGithub();
    const held = TARGET_SYMBOLS.filter((symbol) => symbol !== "UNH");
    const payload = await buildStrategyStatus({
      account: PRODUCTION_ACCOUNT,
      broker: {
        ok: true,
        snapshot: brokerSnapshot({
          positions: held.map((symbol) => ({
            symbol,
            qty: 100,
            avgEntryPrice: 450,
            currentPrice: 450,
            marketValue: 45_000,
            unrealizedPl: 0,
            unrealizedPlPct: 0,
            side: "long" as const,
          })),
          positionCount: held.length,
          grossExposure: held.length * 45_000,
          grossExposurePct: (held.length * 45_000) / 10_000,
        }),
        fetchedAt: NOW.toISOString(),
      },
      now: NOW,
    });
    expect(payload.convergence.data?.targetCount).toBe(10);
    expect(payload.convergence.data?.actualCount).toBe(9);
    // The missing target is an outstanding BUY, not a strategy breach.
    expect(
      payload.convergence.data?.rows.find((row) => row.symbol === "UNH")
        ?.lifecycle,
    ).toBe("BUY");
    // The plan's one submitted sell intent is still PENDING, not filled.
    expect(
      payload.convergence.data?.rows.find((row) => row.symbol === "ASML")
        ?.lifecycle,
    ).toBe("PENDING");
    expect(payload.convergence.data?.pendingCount).toBe(1);
    expect(payload.convergence.data?.nextSafeAction).toContain(
      "not proven filled",
    );
  });
});
