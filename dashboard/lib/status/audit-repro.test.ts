import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGithubCache, fetchWorkflowRuns } from "./github-api";
import { parsePerformanceRuntime, parseValidation } from "./parse";
import { computeEffectiveValidationGate } from "./validation-gate";
import { STRATEGY_IDENTITY, UNIVERSE_HASH, APPROVED_SHA } from "@/test/fixtures";

/**
 * Reproductions for the third audit round's GitHub-runtime findings, written
 * to fail on `d439b2e64`.
 */

describe("REPRO 4c — date-only fields are shape-checked, not round-tripped", () => {
  it("rejects an impossible canonical bar boundary rather than rolling it", () => {
    // `2026-02-30` matches `\d{4}-\d{2}-\d{2}` and `Date.parse` turns it into
    // 2 March, so the 35-day expiry is computed from a day that never
    // existed — two days later than the report actually claims.
    const report = parseValidation({
      schema_version: 1,
      kind: "v11_fixed_strategy_validation",
      generated_at: "2026-08-02T15:56:49.809791+00:00",
      strategy: {
        version: "v11-adaptive-momentum",
        identity: { value: STRATEGY_IDENTITY },
      },
      evidence: {
        schema_version: 1,
        ranking_universe_sha256: UNIVERSE_HASH,
        bar_snapshot_sha256: "b".repeat(64),
        bar_snapshot_through_date: "2026-02-30",
      },
      assessment: { status: "PASS", checks_passed: 5, checks_evaluated: 5 },
      contract: { digest: "c".repeat(64) },
      promotion_profile: {},
      warnings: ["limitations"],
    }, "main");
    // Either the report is refused outright, or its boundary is not usable.
    if (report !== null) {
      expect(report.barBoundaryDate).toBeNull();
    }
  });

  it("refuses the whole document for a daily_history entry dated 2026-02-30", () => {
    // Originally this asserted the bad row was *dropped*. Dropping is the
    // wrong answer for this series: the drawdown and the risk tier are
    // computed from it, so a silently shorter history reports a calmer
    // account than the one that exists. The document is refused instead.
    const perf = parsePerformanceRuntime({
      updated_at: "2026-08-10T16:07:56+00:00",
      equity: 1000,
      cash: 100,
      num_positions: 2,
      risk_tier: "NORMAL",
      daily_history: [
        { date: "2026-08-03", equity: 1000 },
        { date: "2026-02-30", equity: 900 },
      ],
    });
    expect(perf).toBeNull();
  });
});

describe("REPRO 4d — a report timestamp is parsed by Date.parse", () => {
  it("refuses a generated_at that is not a real instant", () => {
    const report = parseValidation({
      schema_version: 1,
      kind: "v11_fixed_strategy_validation",
      generated_at: "2026-02-30T15:56:49+00:00",
      strategy: {
        version: "v11-adaptive-momentum",
        identity: { value: STRATEGY_IDENTITY },
      },
      evidence: {
        schema_version: 1,
        ranking_universe_sha256: UNIVERSE_HASH,
        bar_snapshot_sha256: "b".repeat(64),
        bar_snapshot_through_date: "2026-07-10",
      },
      assessment: { status: "PASS", checks_passed: 5, checks_evaluated: 5 },
      contract: { digest: "c".repeat(64) },
      promotion_profile: {},
      warnings: ["limitations"],
    }, "main");
    if (report !== null) {
      expect(report.generatedAt).toBeNull();
    }
  });

  it("does not let an impossible generated_at authorize a buy", () => {
    const result = computeEffectiveValidationGate({
      report: {
        status: "PASS",
        generatedAt: "2026-02-30T15:56:49+00:00",
        strategyIdentityValue: STRATEGY_IDENTITY,
        rankingUniverseSha256: UNIVERSE_HASH,
        barBoundaryDate: "2026-07-10",
        barSnapshotSha256: "b".repeat(64),
        contractDigest: "c".repeat(64),
        allowedMode: "paper-validation-eligible",
        checksPassed: 5,
        checksEvaluated: 5,
        expiresAt: null,
        expiryBasis: null,
        warnings: ["limitations"],
        reportUrl: null,
      } as never,
      approvedReleaseSha: APPROVED_SHA,
      approvedReleaseAuthoritative: true,
      now: new Date("2026-08-11T12:00:00Z"),
    });
    expect(result.effective).not.toBe("PASS");
  });
});


describe("REPRO 4b — a malformed newest run is filtered out of the list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearGithubCache();
  });

  it("does not silently drop a run whose attempt GitHub did not state", async () => {
    // `toRunSummary` returns null for a run it cannot read, and the caller
    // filters nulls out. The newest run therefore *disappears*, and the walk
    // continues to an older one — which is exactly the substitution the
    // selectors exist to prevent, performed one layer below them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            workflow_runs: [
              {
                id: 999,
                run_number: 50,
                // no run_attempt: unreadable
                status: "completed",
                conclusion: "success",
                event: "schedule",
                head_sha: "a".repeat(40),
                created_at: "2026-08-10T16:00:00Z",
                updated_at: "2026-08-10T16:06:00Z",
              },
              {
                id: 900,
                run_number: 43,
                run_attempt: 1,
                status: "completed",
                conclusion: "success",
                event: "schedule",
                head_sha: "b".repeat(40),
                created_at: "2026-08-07T16:00:00Z",
                updated_at: "2026-08-07T16:06:00Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const runs = await fetchWorkflowRuns("paper-production.yml");
    // Either the whole page fails closed (null), or the malformed run is
    // still present so the selector can refuse it. What must not happen is
    // a clean list containing only the older run.
    if (runs !== null) {
      expect(
        runs.map((r) => r.id),
        "the malformed newest run vanished and the older one became newest",
      ).toContain(999);
    }
  });
});
