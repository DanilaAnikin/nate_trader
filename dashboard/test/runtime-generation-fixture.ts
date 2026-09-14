import { createHash } from "node:crypto";
import { APPROVED_SHA, lastRunJson, performanceJson, positionsJson } from "./fixtures";
import type { CycleOutcome } from "@/lib/status/cycle-outcome";

/** Synthetic producer-shaped bytes, never production account state. */
export function runtimeGenerationFixture(
  outcome: CycleOutcome = { state: "pending", reason: "orders_pending" },
  overrides: Record<string, unknown> = {},
) {
  const id = "11111111-2222-4333-8444-555555555555";
  const snapshots = {
    "performance.json": performanceJson({ runtime_generation_id: id }),
    "positions.json": positionsJson({ runtime_generation_id: id }),
  };
  const raw: Record<string, string> = Object.fromEntries(Object.entries(snapshots).map(([name, value]) => [name, JSON.stringify(value)]));
  const lastRun = lastRunJson({
    status: outcome.state === "failed" ? "FAIL" : outcome.state === "blocked" ? "DEGRADED" : "PASS",
    action_counts: outcome.state === "idle" ? { HOLD: 1 } : outcome.state === "completed" ? { ADAPTIVE_REBALANCE_COMPLETE: 1 } : { REBALANCE_PENDING_BUYS: 1 },
    cycle_outcome: { schema_version: 1, ...outcome },
    runtime_generation: {
      schema_version: 1, id, release_sha: APPROVED_SHA, github_run_id: 900, github_run_attempt: 1, snapshot_status: "fresh",
      files: Object.fromEntries(Object.entries(raw).map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")])),
    },
    ...overrides,
  });
  raw["production/last_run.json"] = JSON.stringify(lastRun);
  return { raw, lastRun, snapshots, id };
}
