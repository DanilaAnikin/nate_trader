import "server-only";
import { createHash } from "node:crypto";
import { outcomeMatchesHealth, parseCycleOutcome, parseRuntimeGeneration, type RuntimeGenerationStatus } from "./cycle-outcome";

/** A fixed error never embeds rejected runtime documents or broker metadata. */
export class RuntimeGenerationError extends Error {
  constructor() { super("the runtime snapshot generation could not be verified"); }
}

export function verifyRuntimeGeneration(
  entries: Readonly<Record<string, unknown>>,
  raw: Readonly<Record<string, Buffer>>,
  expectedRun?: { readonly id: number; readonly attempt: number },
): RuntimeGenerationStatus {
  const performance = entries["performance.json"];
  const positions = entries["positions.json"];
  const lastRun = entries["production/last_run.json"];
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!record(performance) || !record(positions) || !record(lastRun)) throw new RuntimeGenerationError();
  const marked = Object.hasOwn(performance, "runtime_generation_id") || Object.hasOwn(positions, "runtime_generation_id") ||
    Object.hasOwn(lastRun, "runtime_generation") || Object.hasOwn(lastRun, "cycle_outcome");
  if (!marked) return "LEGACY_UNVERIFIED";
  const generation = parseRuntimeGeneration(lastRun.runtime_generation);
  const outcome = parseCycleOutcome(lastRun.cycle_outcome);
  if (!generation || !outcome || !outcomeMatchesHealth(outcome, lastRun.status) ||
    generation.releaseSha !== lastRun.release_sha ||
    (expectedRun && (generation.githubRunId !== expectedRun.id || generation.githubRunAttempt !== expectedRun.attempt)) ||
    performance.runtime_generation_id !== generation.id || positions.runtime_generation_id !== generation.id ||
    (generation.snapshotStatus === "recovery" && outcome.state !== "failed")) throw new RuntimeGenerationError();
  for (const name of ["performance.json", "positions.json"] as const) {
    if (!Buffer.isBuffer(raw[name]) || createHash("sha256").update(raw[name]).digest("hex") !== generation.files[name]) throw new RuntimeGenerationError();
  }
  if (!Array.isArray(positions.positions) || (generation.snapshotStatus === "fresh" &&
    (typeof performance.updated_at !== "string" || performance.updated_at !== positions.updated_at ||
      !Number.isSafeInteger(performance.num_positions) || performance.num_positions !== positions.positions.length))) throw new RuntimeGenerationError();
  return generation.snapshotStatus === "recovery" ? "RECOVERY" : "VERIFIED";
}
