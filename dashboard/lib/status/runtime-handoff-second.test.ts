import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { secondRuntimeHandoffFixture } from "@/test/runtime-handoff-second-fixture";
import { runtimeHandoffFixture } from "@/test/runtime-handoff-fixture";
import { buildZip } from "@/test/zip-builder";
import { readRuntimeArchive, verifiedCarriedPlanIdentity } from "./runtime-handoff";

const MANIFEST = "production/handoff/manifest.json";
const PREFIX = "production/handoff/source/";
const PRIOR_MANIFEST = PREFIX + MANIFEST;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function read(value: ReturnType<typeof secondRuntimeHandoffFixture>) {
  return readRuntimeArchive(buildZip(Object.entries(value.entries).map(([name, content]) => ({ name, content }))), {
    mode: "paper", approvedReleaseSha: value.targetSha, pin: value.pin,
    validated: { strategyIdentity: value.targetIdentity, universeSha256: value.universeSha256 },
  });
}
function edit(value: ReturnType<typeof secondRuntimeHandoffFixture>, name: string, change: (raw: Record<string, unknown>) => void) {
  const raw = JSON.parse(value.entries[name]); change(raw); value.entries[name] = JSON.stringify(raw);
}
function repin(value: ReturnType<typeof secondRuntimeHandoffFixture>) { value.pin = digest(value.entries[MANIFEST]); }
function authenticateChangedPrior(value: ReturnType<typeof secondRuntimeHandoffFixture>) {
  edit(value, MANIFEST, (manifest) => {
    (manifest.prior_handoff as Record<string, unknown>).manifest_sha256 = digest(value.entries[PRIOR_MANIFEST]);
    const source = manifest.source as { files: Record<string, string> };
    source.files[MANIFEST] = digest(value.entries[PRIOR_MANIFEST]);
  });
  repin(value);
}

describe("exactly two externally authenticated paper handoffs", () => {
  it("reads eleven files while preserving the original plan identity and all prior bytes", () => {
    const value = secondRuntimeHandoffFixture();
    const first = runtimeHandoffFixture();
    expect(Object.keys(value.entries)).toHaveLength(11);
    for (const [name, raw] of Object.entries(first.entries)) expect(value.entries[PREFIX + name]).toBe(raw);
    const result = read(value);
    expect(result.performance?.plan?.strategyIdentityValue).toBe(value.sourceIdentity);
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, result.performance!.plan, value.targetSha)).toBe(value.targetIdentity);
    expect(result.runtimeGeneration).toBe("LEGACY_UNVERIFIED");
    expect(Object.keys(result.entries)).toHaveLength(3);
  });

  it.each([PRIOR_MANIFEST, PREFIX + PREFIX + "performance.json", PREFIX + PREFIX + "positions.json", PREFIX + PREFIX + "production/last_run.json"])("rejects a missing retained %s", (name) => {
    const value = secondRuntimeHandoffFixture(); delete value.entries[name]; expect(() => read(value)).toThrow("archive_entries");
  });

  it.each([PRIOR_MANIFEST, PREFIX + PREFIX + "performance.json", PREFIX + "performance.json"])("rejects altered retained bytes in %s", (name) => {
    const value = secondRuntimeHandoffFixture(); value.entries[name] += "\n"; expect(() => read(value)).toThrow("source_file_integrity");
  });

  it("requires the prior manifest's independent pin even when outer bytes are pinned", () => {
    const value = secondRuntimeHandoffFixture();
    edit(value, MANIFEST, (manifest) => { (manifest.prior_handoff as Record<string, unknown>).manifest_sha256 = "f".repeat(64); });
    repin(value); expect(() => read(value)).toThrow("manifest_pin");
  });

  it.each(["release", "account", "universe", "immutable", "identity"])("refuses an authenticated but disconnected prior %s", (change) => {
    const value = secondRuntimeHandoffFixture();
    edit(value, PRIOR_MANIFEST, (prior) => {
      if (change === "release") (prior.target as Record<string, unknown>).release_sha = "f".repeat(40);
      if (change === "account") prior.paper_account_sha256 = "f".repeat(64);
      if (change === "universe") prior.ranking_universe_sha256 = "f".repeat(64);
      if (change === "immutable") (prior.plan as Record<string, unknown>).immutable_sha256 = "f".repeat(64);
      if (change === "identity") (prior.source as Record<string, unknown>).strategy_identity = "f".repeat(64);
    });
    authenticateChangedPrior(value); expect(() => read(value)).toThrow("prior_handoff_binding");
  });

  it("rejects a third hop instead of treating nested manifests as arbitrary data", () => {
    const value = secondRuntimeHandoffFixture();
    edit(value, PRIOR_MANIFEST, (prior) => { prior.schema_version = 2; });
    authenticateChangedPrior(value); expect(() => read(value)).toThrow("prior_handoff_version");
    value.entries[PREFIX + PREFIX + MANIFEST] = "{}";
    expect(() => read(value)).toThrow("archive_entries");
  });

  it("does not accept v2 evidence as an old v1 seven-file contract", () => {
    const value = secondRuntimeHandoffFixture();
    edit(value, MANIFEST, (manifest) => { manifest.schema_version = 1; delete manifest.prior_handoff; });
    repin(value); expect(() => read(value)).toThrow("archive_entries");
  });

  it("does not allow current target weights or original attempts to disappear in the second transfer", () => {
    for (const change of ["target", "attempt"] as const) {
      const value = secondRuntimeHandoffFixture();
      edit(value, "performance.json", (performance) => {
        const plan = performance.adaptive_rebalance_pending as Record<string, unknown>;
        if (change === "target") (plan.target_weights as Record<string, number>).AAA = 0.08;
        else delete (plan.order_attempts as Record<string, unknown>)[Object.keys(plan.order_attempts as object)[0]];
      });
      expect(() => read(value)).toThrow();
    }
  });

  it("keeps a native target successor on ordinary lineage with no old-identity exception", () => {
    const value = secondRuntimeHandoffFixture();
    edit(value, "performance.json", (performance) => {
      (performance.adaptive_rebalance_pending as Record<string, unknown>).strategy_identity_value = value.targetIdentity;
    });
    const result = read(value);
    expect(verifiedCarriedPlanIdentity(result.runtimeHandoff, result.performance!.plan, value.targetSha)).toBeNull();
  });
});
