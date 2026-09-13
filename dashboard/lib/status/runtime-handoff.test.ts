import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runtimeHandoffFixture } from "@/test/runtime-handoff-fixture";
import { buildZip } from "@/test/zip-builder";
import { readRuntimeArchive, verifiedCarriedPlanIdentity, type RuntimeArchiveContext } from "./runtime-handoff";

const MANIFEST = "production/handoff/manifest.json";
const SOURCE_PERFORMANCE = "production/handoff/source/performance.json";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const value = runtimeHandoffFixture();
  return {
    ...value,
    context: {
      approvedReleaseSha: value.targetSha,
      mode: "paper",
      pin: value.pin,
      validated: { strategyIdentity: value.targetIdentity, universeSha256: value.universeSha256 },
    } satisfies RuntimeArchiveContext,
  };
}
function read(value: ReturnType<typeof fixture>, context: RuntimeArchiveContext = value.context) {
  return readRuntimeArchive(buildZip(Object.entries(value.entries).map(([name, content]) => ({ name, content }))), context);
}
function edit(value: ReturnType<typeof fixture>, name: string, change: (raw: Record<string, unknown>) => void) {
  const raw = JSON.parse(value.entries[name]) as Record<string, unknown>;
  change(raw);
  value.entries[name] = JSON.stringify(raw);
}
function editPlan(value: ReturnType<typeof fixture>, change: (raw: Record<string, unknown>) => void) {
  edit(value, "performance.json", (raw) => change(raw.adaptive_rebalance_pending as Record<string, unknown>));
}
function editAttempt(value: ReturnType<typeof fixture>, change: (raw: Record<string, unknown>, key: string, plan: Record<string, unknown>) => void) {
  editPlan(value, (plan) => {
    const records = plan.order_attempts as Record<string, Record<string, unknown>>;
    const key = Object.keys(records)[0];
    change(records[key], key, plan);
  });
}
function repin(value: ReturnType<typeof fixture>) { value.context.pin = digest(value.entries[MANIFEST]); }

describe("externally pinned paper runtime handoff", () => {
  it("reads all seven genuine Python-generated synthetic files without reserializing float/Unicode hashes", () => {
    const value = fixture();
    expect(value.entries[SOURCE_PERFORMANCE]).toContain("23.0");
    expect(value.entries[SOURCE_PERFORMANCE]).toContain("0.0");
    expect(value.entries[SOURCE_PERFORMANCE]).toContain("\\u017e");
    const result = read(value);
    expect(result.performance?.plan?.strategyIdentityValue).toBe(value.sourceIdentity);
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, result.performance!.plan, value.targetSha)).toBe(value.targetIdentity);
    expect(Object.keys(result.entries)).toHaveLength(3);
    expect(result.runtimeHandoff?.manifestSha256).toBe(value.pin);
  });

  it("accepts exact legacy three files only without a required paper handoff pin", () => {
    const value = fixture();
    for (const name of Object.keys(value.entries)) if (name.startsWith("production/handoff/")) delete value.entries[name];
    expect(read(value, { ...value.context, pin: undefined }).runtimeHandoff).toBeNull();
    expect(() => read(value)).toThrow("handoff_evidence_missing");
  });

  it.each([undefined, "", "f".repeat(64), "NOT_A_DIGEST"])("rejects missing or incorrect external pin %s", (pin) => {
    const value = fixture();
    expect(() => read(value, { ...value.context, pin })).toThrow(/manifest_pin/);
  });

  it.each([
    MANIFEST,
    SOURCE_PERFORMANCE,
    "production/handoff/source/positions.json",
    "production/handoff/source/production/last_run.json",
  ])("rejects incomplete seven-file archive missing %s", (name) => {
    const value = fixture();
    delete value.entries[name];
    expect(() => read(value)).toThrow("archive_entries");
  });

  it("rejects a foreign extra archive entry", () => {
    const value = fixture();
    value.entries["other.json"] = "{}";
    expect(() => read(value)).toThrow("archive_entries");
  });

  it("rejects exact manifest-byte tampering even if JSON is unchanged", () => {
    const value = fixture();
    value.entries[MANIFEST] += "\n";
    expect(() => read(value)).toThrow("manifest_pin");
  });

  it.each([SOURCE_PERFORMANCE, "production/handoff/source/positions.json", "production/handoff/source/production/last_run.json"])("rejects changed original file bytes %s", (name) => {
    const value = fixture();
    value.entries[name] += "\n";
    expect(() => read(value)).toThrow("source_file_integrity");
  });

  it.each([
    { approvedReleaseSha: "1".repeat(40) },
    { mode: "live" as const },
    { validated: null },
    { validated: { strategyIdentity: "a".repeat(64), universeSha256: runtimeHandoffFixture().universeSha256 } },
    { validated: { strategyIdentity: runtimeHandoffFixture().targetIdentity, universeSha256: "a".repeat(64) } },
  ])("rejects a context that does not bind this target %j", (change) => {
    const value = fixture();
    expect(() => read(value, { ...value.context, ...change })).toThrow();
  });

  it("validates required manifest shape even under a different externally supplied pin", () => {
    const value = fixture();
    edit(value, MANIFEST, (manifest) => { manifest.schema_version = 2; });
    repin(value);
    expect(() => read(value)).toThrow("manifest_fields");
  });

  it("refuses duplicated JSON keys in a pinned manifest", () => {
    const value = fixture();
    value.entries[MANIFEST] = value.entries[MANIFEST].replace('"schema_version":1', '"schema_version":1,"schema_version":1');
    repin(value);
    expect(() => read(value)).toThrow("duplicate_json_key");
  });

  it("does not mistake the expired bootstrap window for expiry of ongoing adoption evidence", () => {
    const value = fixture();
    edit(value, MANIFEST, (manifest) => {
      manifest.issued_at = "2020-01-01T00:00:00Z";
      manifest.expires_at = "2020-01-02T00:00:00Z";
    });
    repin(value);
    expect(read(value).runtimeHandoff).not.toBeNull();
  });

  it("requires the actual target run record, preserving source last_run as historical", () => {
    const value = fixture();
    value.entries["production/last_run.json"] = value.entries["production/handoff/source/production/last_run.json"];
    expect(() => read(value)).toThrow("target_run_evidence");
  });

  it.each(["plan_id", "strategy_identity_value", "ranking_universe_sha256", "rebalance_month", "extra_field"])("refuses changed immutable field %s", (field) => {
    const value = fixture();
    editPlan(value, (plan) => { plan[field] = field === "rebalance_month" ? "2026-09" : "a".repeat(64); });
    expect(() => read(value)).toThrow();
  });

  it("refuses an altered frozen target", () => {
    const value = fixture();
    editPlan(value, (plan) => { (plan.target_weights as Record<string, number>).AAA *= 0.5; });
    expect(() => read(value)).toThrow("current_plan_binding");
  });

  it("refuses losing an original intent record", () => {
    const value = fixture();
    editPlan(value, (plan) => { delete (plan.order_attempts as Record<string, unknown>)[Object.keys(plan.order_attempts as object)[0]]; });
    expect(() => read(value)).toThrow("original_attempt_missing");
  });

  it.each(["quantity", "client_order_id", "order_id", "attempt", "status"])("refuses original attempt corruption of %s", (field) => {
    const value = fixture();
    editAttempt(value, (record) => { record[field] = field === "quantity" ? 24 : field === "attempt" ? 0 : "changed"; });
    expect(() => read(value)).toThrow();
  });

  it("allows an advanced retry reservation while preserving the exact original bytes", () => {
    const value = fixture();
    const originalBytes = value.entries[SOURCE_PERFORMANCE];
    editAttempt(value, (record, key, plan) => {
      record.attempt = 2;
      record.status = "reserved";
      delete record.order_id;
      const suffix = digest(`adaptive|${record.symbol}|${record.side}|${plan.plan_id}|${key}|attempt=2`).slice(0, 12);
      record.client_order_id = `nt-adaptive-${String(record.symbol).toLowerCase()}-${record.side}-${suffix}`;
    });
    const result = read(value);
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, result.performance!.plan, value.targetSha)).toBe(value.targetIdentity);
    expect(value.entries[SOURCE_PERFORMANCE]).toBe(originalBytes);
  });

  it("does not authorize a forged proof, different plan instance, wrong release or post-mint mutation", () => {
    const value = fixture();
    const result = read(value);
    const plan = result.performance!.plan!;
    expect(verifiedCarriedPlanIdentity({ ...result.runtimeHandoff! }, plan, value.targetSha)).toBeNull();
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, structuredClone(plan), value.targetSha)).toBeNull();
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, plan, value.sourceSha)).toBeNull();
    (plan.targets[0] as { weightPct: number }).weightPct += 1;
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, plan, value.targetSha)).toBeNull();
  });

  it("grants no exception for a native target-identity plan", () => {
    const value = fixture();
    editPlan(value, (plan) => { plan.strategy_identity_value = value.targetIdentity; });
    const result = read(value);
    expect(result.performance!.plan!.strategyIdentityValue).toBe(value.targetIdentity);
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, result.performance!.plan, value.targetSha)).toBeNull();
  });

  it("keeps handoff provenance after completion without inventing a carried plan", () => {
    const value = fixture();
    edit(value, "performance.json", (performance) => { performance.adaptive_rebalance_pending = null; });
    const result = read(value);
    expect(result.performance!.plan).toBeNull();
    expect(result.runtimeHandoff).not.toBeNull();
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, null, value.targetSha)).toBeNull();
  });
});
