/** Versioned executor evidence. Legacy action counts never invent an outcome. */
export const CYCLE_REASONS = {
  completed: ["rebalance_complete"],
  idle: ["no_rebalance_due"],
  pending: ["orders_pending", "cancellation_pending", "short_reconciliation", "infrastructure_reconciliation", "convergence_pending"],
  blocked: ["exposure_gate_closed", "execution_incomplete", "execution_error"],
  failed: ["execution_exception", "snapshot_unavailable", "publication_failed"],
} as const;

export type CycleState = keyof typeof CYCLE_REASONS;
export type CycleReason = (typeof CYCLE_REASONS)[CycleState][number];
export interface CycleOutcome {
  readonly state: CycleState;
  readonly reason: CycleReason;
}

export function parseCycleOutcome(value: unknown): CycleOutcome | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "reason,schema_version,state" || raw.schema_version !== 1) return null;
  if (typeof raw.state !== "string" || !Object.hasOwn(CYCLE_REASONS, raw.state)) return null;
  const reasons: readonly string[] = CYCLE_REASONS[raw.state as CycleState];
  if (typeof raw.reason !== "string" || !reasons.includes(raw.reason)) return null;
  return { state: raw.state as CycleState, reason: raw.reason as CycleReason };
}

export function outcomeMatchesHealth(outcome: CycleOutcome, health: unknown): boolean {
  return health === (outcome.state === "failed" ? "FAIL" : outcome.state === "blocked" ? "DEGRADED" : "PASS");
}

export type RuntimeGenerationStatus = "VERIFIED" | "RECOVERY" | "LEGACY_UNVERIFIED" | "UNVERIFIED";

export interface RuntimeGeneration {
  readonly id: string;
  readonly releaseSha: string;
  readonly githubRunId: number | null;
  readonly githubRunAttempt: number | null;
  readonly snapshotStatus: "fresh" | "recovery";
  readonly files: Readonly<Record<"performance.json" | "positions.json", string>>;
}

export function parseRuntimeGeneration(value: unknown): RuntimeGeneration | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).sort().join(",") !== "files,github_run_attempt,github_run_id,id,release_sha,schema_version,snapshot_status" || raw.schema_version !== 1 ||
    typeof raw.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw.id) ||
    (raw.snapshot_status !== "fresh" && raw.snapshot_status !== "recovery") ||
    typeof raw.files !== "object" || raw.files === null || Array.isArray(raw.files)) return null;
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (typeof raw.release_sha !== "string" || !/^[0-9a-f]{40}$/.test(raw.release_sha) ||
    !((raw.github_run_id === null && raw.github_run_attempt === null) ||
      (positive(raw.github_run_id) && positive(raw.github_run_attempt)))) return null;
  const files = raw.files as Record<string, unknown>;
  if (Object.keys(files).length !== 2 || !Object.hasOwn(files, "performance.json") || !Object.hasOwn(files, "positions.json") ||
    Object.values(files).some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))) return null;
  return { id: raw.id, releaseSha: raw.release_sha, githubRunId: raw.github_run_id as number | null,
    githubRunAttempt: raw.github_run_attempt as number | null,
    snapshotStatus: raw.snapshot_status, files: files as RuntimeGeneration["files"] };
}
