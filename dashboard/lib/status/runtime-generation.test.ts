import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runtimeGenerationFixture } from "@/test/runtime-generation-fixture";
import pythonFixture from "@/test/runtime-generation-python-fixture.json";
import { runtimeHandoffFixture } from "@/test/runtime-handoff-fixture";
import { APPROVED_SHA, lastRunJson } from "@/test/fixtures";
import { buildZip } from "@/test/zip-builder";
import { CYCLE_REASONS, type CycleReason, type CycleState } from "./cycle-outcome";
import { parseLastRun, executionFromLastRun } from "./parse";
import { readRuntimeArchive } from "./runtime-handoff";

function read(raw: Record<string, string>, expectedRun = { id: 900, attempt: 1 }) {
  return readRuntimeArchive(buildZip(Object.entries(raw).map(([name, content]) => ({ name, content }))), {
    mode: "paper", approvedReleaseSha: APPROVED_SHA, expectedRun,
  });
}
function edit(raw: Record<string, string>, name: string, change: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(raw[name]) as Record<string, unknown>;
  change(value);
  raw[name] = JSON.stringify(value);
}

describe("explicit cycle outcomes", () => {
  const cases = Object.entries(CYCLE_REASONS).flatMap(([state, reasons]) => reasons.map((reason) => [state, reason] as const));
  it.each(cases)("preserves %s/%s independently of legacy terminal counts", (state, reason) => {
    const value = runtimeGenerationFixture({ state: state as CycleState, reason: reason as CycleReason });
    const parsed = parseLastRun(value.lastRun)!;
    expect(parsed).not.toBeNull();
    expect(parsed.cycleOutcome).toEqual({ state, reason });
    expect(parsed.passWorthy).toBe(["completed", "idle", "pending"].includes(state));
    expect(read(value.raw).runtimeGeneration).toBe("VERIFIED");
  });

  it("keeps legacy PASS readable without fabricating completion or generation proof", () => {
    const parsed = parseLastRun(lastRunJson())!;
    const execution = executionFromLastRun(parsed, null);
    expect(execution.status).toBe("PASS");
    expect(execution.cycleOutcome).toBeNull();
    expect(execution.runtimeGeneration).toBe("LEGACY_UNVERIFIED");
  });

  it.each([
    { schema_version: 2, state: "pending", reason: "orders_pending" },
    { schema_version: 1, state: "complete", reason: "rebalance_complete" },
    { schema_version: 1, state: "idle", reason: "orders_pending" },
    { schema_version: 1, state: "pending", reason: "PRIVATE_SECRET_SENTINEL" },
    { schema_version: 1, state: "pending", reason: "orders_pending", extra: "private" },
    null,
  ])("refuses a malformed or unsupported outcome", (cycle_outcome) => {
    expect(parseLastRun(runtimeGenerationFixture(undefined, { cycle_outcome }).lastRun)).toBeNull();
  });

  it.each(["FAIL", "DEGRADED"])("refuses pending paired with %s health", (status) => {
    expect(parseLastRun(runtimeGenerationFixture(undefined, { status }).lastRun)).toBeNull();
  });

  it("shows an explicit blocked cycle even when it stopped before measuring risk", () => {
    const value = runtimeGenerationFixture({ state: "blocked", reason: "execution_incomplete" }, { risk_tier: null, action_counts: {} });
    const parsed = parseLastRun(value.lastRun)!;
    expect(parsed).not.toBeNull();
    expect(parsed.passWorthy).toBe(false);
    expect(executionFromLastRun(parsed, null).cycleOutcome?.state).toBe("blocked");
  });

  it("does not accept healthy explicit outcome without a risk observation", () => {
    expect(parseLastRun(runtimeGenerationFixture(undefined, { risk_tier: null }).lastRun)).toBeNull();
  });

  it("accepts the uniform failed summary without inventing diagnostic actions", () => {
    const parsed = parseLastRun(runtimeGenerationFixture({ state: "failed", reason: "execution_exception" }, {
      risk_tier: null, market_entry_allowed: false, action_counts: {}, blocking_actions: [], failure_type: "RuntimeError",
    }).lastRun)!;
    expect(parsed.cycleOutcome?.state).toBe("failed");
    expect(executionFromLastRun(parsed, null).status).toBe("FAIL");
  });

  it.each(["ABORT_SHORT_RECONCILIATION", "ERROR_BROKER", "TQQQ_BUY", "UNKNOWN_ACTION"])("does not let an explicit healthy outcome hide %s", (action) => {
    expect(parseLastRun(runtimeGenerationFixture(undefined, { action_counts: { [action]: 1 } }).lastRun)).toBeNull();
  });
});

describe("one committed runtime generation", () => {
  it("reads exact producer-generated Python float and Unicode bytes", () => {
    expect(pythonFixture.entries["performance.json"]).toContain("23.0");
    expect(pythonFixture.entries["performance.json"]).toContain("\\u017e");
    const result = read(pythonFixture.entries);
    expect(result.runtimeGeneration).toBe("VERIFIED");
    expect(parseLastRun(result.entries["production/last_run.json"])?.cycleOutcome).toEqual({ state: "pending", reason: "orders_pending" });
  });
  it.each(["performance.json", "positions.json"])("detects changed raw %s bytes even when JSON means the same thing", (name) => {
    const value = runtimeGenerationFixture();
    value.raw[name] += "\n";
    expect(() => read(value.raw)).toThrow("snapshot generation could not be verified");
  });

  it.each(["performance.json", "positions.json"])("rejects a partial write that replaced only %s", (name) => {
    const value = runtimeGenerationFixture();
    edit(value.raw, name, (record) => { record.runtime_generation_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; });
    expect(() => read(value.raw)).toThrow();
  });

  it.each(["cycle_outcome", "runtime_generation"])("rejects a deleted %s rather than downgrading to legacy", (field) => {
    const value = runtimeGenerationFixture();
    edit(value.raw, "production/last_run.json", (record) => { delete record[field]; });
    expect(() => read(value.raw)).toThrow();
  });

  it.each(["performance.json", "positions.json"])("rejects a missing %s generation ID", (name) => {
    const value = runtimeGenerationFixture();
    edit(value.raw, name, (record) => { delete record.runtime_generation_id; });
    expect(() => read(value.raw)).toThrow();
  });

  it.each([{ id: 901, attempt: 1 }, { id: 900, attempt: 2 }])("binds the commit to the actual artifact run and attempt %j", (expected) => {
    expect(() => read(runtimeGenerationFixture().raw, expected)).toThrow();
  });

  it("refuses local-only generation metadata in a GitHub artifact", () => {
    const value = runtimeGenerationFixture();
    edit(value.raw, "production/last_run.json", (record) => {
      const marker = record.runtime_generation as Record<string, unknown>;
      marker.github_run_id = null; marker.github_run_attempt = null;
    });
    expect(() => read(value.raw)).toThrow();
  });

  it("refuses a marker for a different release", () => {
    const value = runtimeGenerationFixture();
    edit(value.raw, "production/last_run.json", (record) => { (record.runtime_generation as Record<string, unknown>).release_sha = "f".repeat(40); });
    expect(() => read(value.raw)).toThrow();
  });

  it("cannot present a recovery generation as a healthy pending cycle", () => {
    const value = runtimeGenerationFixture();
    edit(value.raw, "production/last_run.json", (record) => { (record.runtime_generation as Record<string, unknown>).snapshot_status = "recovery"; });
    expect(() => read(value.raw)).toThrow();
  });

  it("labels a valid failed recovery as retained history", () => {
    const value = runtimeGenerationFixture({ state: "failed", reason: "snapshot_unavailable" });
    edit(value.raw, "production/last_run.json", (record) => { (record.runtime_generation as Record<string, unknown>).snapshot_status = "recovery"; });
    expect(read(value.raw).runtimeGeneration).toBe("RECOVERY");
  });

  it("rejects internally inconsistent fresh snapshots even with correct hashes", () => {
    const value = runtimeGenerationFixture();
    edit(value.raw, "positions.json", (record) => { record.updated_at = "2026-08-07 12:00:00"; });
    edit(value.raw, "production/last_run.json", (record) => {
      const marker = record.runtime_generation as { files: Record<string, string> };
      marker.files["positions.json"] = createHash("sha256").update(value.raw["positions.json"]).digest("hex");
    });
    expect(() => read(value.raw)).toThrow();
  });

  it("requires generation proof inside a seven-file handoff without modifying its retained source", () => {
    const handoff = runtimeHandoffFixture();
    const value = runtimeGenerationFixture();
    const raw = { ...handoff.entries };
    const id = value.id;
    for (const name of ["performance.json", "positions.json"]) edit(raw, name, (record) => { record.runtime_generation_id = id; });
    edit(raw, "production/last_run.json", (record) => {
      record.cycle_outcome = value.lastRun.cycle_outcome;
      record.runtime_generation = { ...(value.lastRun.runtime_generation as object), release_sha: handoff.targetSha,
        files: Object.fromEntries(["performance.json", "positions.json"].map((name) => [name, createHash("sha256").update(raw[name]).digest("hex")])) };
    });
    const context = { mode: "paper" as const, approvedReleaseSha: handoff.targetSha, pin: handoff.pin,
      validated: { strategyIdentity: handoff.targetIdentity, universeSha256: handoff.universeSha256 }, expectedRun: { id: 900, attempt: 1 } };
    const load = () => readRuntimeArchive(buildZip(Object.entries(raw).map(([name, content]) => ({ name, content }))), context);
    expect(load().runtimeGeneration).toBe("VERIFIED");
    raw["positions.json"] += "\n";
    expect(() => load()).toThrow("snapshot generation could not be verified");
  });
});
