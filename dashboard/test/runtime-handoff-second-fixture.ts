import { createHash } from "node:crypto";
import { runtimeHandoffFixture } from "./runtime-handoff-fixture";

/** A bounded second transfer retaining every byte of the original seven files. */
export function secondRuntimeHandoffFixture(options: { targetSha?: string; targetIdentity?: string; sourceSha?: string } = {}) {
  const prior = runtimeHandoffFixture();
  const targetSha = options.targetSha ?? "a".repeat(40);
  const targetIdentity = options.targetIdentity ?? "b".repeat(64);
  const manifestPath = "production/handoff/manifest.json";
  const sourcePrefix = "production/handoff/source/";
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const first = JSON.parse(prior.entries[manifestPath]);
  if (options.sourceSha) {
    prior.targetSha = options.sourceSha;
    first.target.release_sha = options.sourceSha;
    prior.entries["production/last_run.json"] = JSON.stringify({ ...JSON.parse(prior.entries["production/last_run.json"]), release_sha: options.sourceSha });
    prior.entries[manifestPath] = JSON.stringify(first);
    prior.pin = digest(prior.entries[manifestPath]);
  }
  const entries: Record<string, string> = Object.fromEntries(Object.entries(prior.entries).map(([name, raw]) => [sourcePrefix + name, raw]));
  for (const name of ["performance.json", "positions.json", "production/last_run.json"]) entries[name] = prior.entries[name];
  entries["production/last_run.json"] = JSON.stringify({ ...JSON.parse(entries["production/last_run.json"]), release_sha: targetSha });
  const manifest = {
    ...first,
    schema_version: 2,
    prior_handoff: { manifest_sha256: prior.pin },
    source: { ...first.source, release_sha: prior.targetSha, run_id: 900, artifact_id: 901,
      files: Object.fromEntries(Object.entries(prior.entries).map(([name, raw]) => [name, digest(raw)])) },
    target: { release_sha: targetSha, strategy_identity: targetIdentity },
  };
  entries[manifestPath] = JSON.stringify(manifest);
  return { entries, pin: digest(entries[manifestPath]), sourceIdentity: prior.sourceIdentity,
    sourceSha: prior.targetSha, targetSha, targetIdentity, universeSha256: prior.universeSha256, now: prior.now };
}
