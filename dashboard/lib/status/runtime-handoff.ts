import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  isRecord, parseFrozenPlan, parseLastRun, parsePerformanceRuntime,
  type PerformanceRuntimeSnapshot,
} from "./parse";
import { parsePositionsRuntime } from "./positions";
import type { AccountMode, FrozenPlanInfo } from "./types";
import { listZipEntries, readJsonEntries, readZipEntry } from "./zip";

const SOURCE_FILES = ["performance.json", "positions.json", "production/last_run.json"] as const;
const MANIFEST = "production/handoff/manifest.json";
const SOURCE_PREFIX = "production/handoff/source/";
const HANDOFF_FILES = [...SOURCE_FILES, MANIFEST, ...SOURCE_FILES.map((name) => SOURCE_PREFIX + name)];
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Fixed codes only; rejected private documents never appear in the response. */
export class RuntimeHandoffError extends Error {
  constructor(reason: string) { super(`paper runtime handoff refused: ${reason}`); }
}
function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new RuntimeHandoffError(reason);
}
function sha(value: unknown): value is string { return typeof value === "string" && SHA.test(value); }
function commit(value: unknown): value is string { return typeof value === "string" && COMMIT.test(value); }
function digest(raw: Buffer): string { return createHash("sha256").update(raw).digest("hex"); }
function keys(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
}

/** JSON.parse discards duplicate keys. The executor refuses them, so do we. */
function strictObject(raw: Buffer): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new RuntimeHandoffError("invalid_json"); }
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? "") && index < text.length) index++; };
  const string = (): string => {
    requireThat(text[index] === '"', "invalid_json");
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === "\\") { index++; continue; }
      if (char === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new RuntimeHandoffError("invalid_json");
  };
  const value = (depth: number): unknown => {
    requireThat(depth < 64, "json_depth");
    whitespace();
    if (text[index] === '"') return string();
    if (text[index] === "{" || text[index] === "[") {
      const object = text[index++] === "{";
      const end = object ? "}" : "]";
      const result: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
      const seen = new Set<string>();
      whitespace();
      if (text[index] === end) { index++; return result; }
      for (;;) {
        whitespace();
        if (object) {
          const key = string();
          requireThat(!seen.has(key), "duplicate_json_key");
          seen.add(key);
          whitespace();
          requireThat(text[index++] === ":", "invalid_json");
          (result as Record<string, unknown>)[key] = value(depth + 1);
        } else (result as unknown[]).push(value(depth + 1));
        whitespace();
        if (text[index] === end) { index++; return result; }
        requireThat(text[index++] === ",", "invalid_json");
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
    requireThat(match, "invalid_json");
    index += match[0].length;
    const result = JSON.parse(match[0]) as unknown;
    requireThat(typeof result !== "number" || Number.isFinite(result), "invalid_json");
    return result;
  };
  try {
    value(0);
    whitespace();
    requireThat(index === text.length, "invalid_json");
    // Return ordinary JSON objects after the duplicate/depth/finite checks.
    const parsed: unknown = JSON.parse(text);
    requireThat(isRecord(parsed), "json_object_required");
    return parsed;
  } catch (error) {
    if (error instanceof RuntimeHandoffError) throw error;
    throw new RuntimeHandoffError("invalid_json");
  }
}

function immutable(plan: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "order_attempts"));
}

/** The source bytes are already externally pinned. Check evolving attempt
 * continuity structurally; never reserialize Python floats to invent a hash.
 * This is observability evidence, not broker reconciliation or permission to
 * retry an order. Only the executor performs that fresh broker verification. */
function attempts(plan: Record<string, unknown>, original?: Record<string, unknown>): void {
  requireThat(isRecord(plan.order_attempts) && isRecord(plan.target_weights), "attempt_records");
  const records = plan.order_attempts;
  const clientIds = new Set<string>();
  const brokerIds = new Set<string>();
  for (const [key, raw] of Object.entries(records)) {
    requireThat(/^[0-9a-f]{16}$/.test(key) && isRecord(raw), "attempt_record");
    requireThat(typeof raw.symbol === "string" && /^[A-Z][A-Z0-9.-]{0,14}$/.test(raw.symbol) &&
      (raw.side === "buy" || raw.side === "sell") &&
      typeof raw.quantity === "number" && Number.isFinite(raw.quantity) && raw.quantity > 0 &&
      typeof raw.target_weight === "number" && Number.isFinite(raw.target_weight) && raw.target_weight >= 0 && raw.target_weight <= 1 &&
      typeof raw.attempt === "number" && Number.isSafeInteger(raw.attempt) && raw.attempt >= 1 &&
      typeof raw.client_order_id === "string" && raw.client_order_id.length > 0 && raw.client_order_id.length <= 48,
    "attempt_fields");
    const submitted = raw.status === "submitted" && typeof raw.order_id === "string" && raw.order_id.length > 0;
    const reserved = raw.status === "reserved" && (raw.order_id === undefined || raw.order_id === null || raw.order_id === "");
    requireThat(original ? submitted || reserved : submitted, "attempt_status");
    requireThat(!clientIds.has(raw.client_order_id), "duplicate_attempt");
    clientIds.add(raw.client_order_id);
    if (submitted) {
      requireThat(!brokerIds.has(raw.order_id as string), "duplicate_attempt");
      brokerIds.add(raw.order_id as string);
    }
    if (raw.side === "buy") {
      const weight = plan.target_weights[raw.symbol];
      requireThat(typeof weight === "number" && Math.abs(weight - raw.target_weight) <= 1e-12, "attempt_target");
    }
    // This id hashes strings only; unlike Python's numeric plan/intent hashes
    // it has an exact cross-language representation.
    const canonical = `adaptive|${raw.symbol}|${raw.side}|${plan.plan_id}|${key}|attempt=${raw.attempt}`;
    const prefix = `nt-adaptive-${raw.symbol}-${raw.side}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 35).replace(/-+$/g, "");
    const expectedId = `${prefix}-${digest(Buffer.from(canonical)).slice(0, 12)}`.slice(0, 48);
    requireThat(raw.client_order_id === expectedId, "attempt_client_id");
  }
  if (!original) {
    requireThat(Object.keys(records).length > 0, "source_attempts_empty");
    return;
  }
  requireThat(isRecord(original.order_attempts), "source_attempt_records");
  for (const [key, prior] of Object.entries(original.order_attempts)) {
    const current = records[key];
    requireThat(isRecord(prior) && isRecord(current), "original_attempt_missing");
    requireThat(typeof current.attempt === "number" && typeof prior.attempt === "number" && current.attempt >= prior.attempt, "attempt_counter_regressed");
    for (const field of ["symbol", "side", "quantity", "target_weight"]) {
      requireThat(isDeepStrictEqual(current[field], prior[field]), "original_intent_changed");
    }
    if (current.attempt === prior.attempt) {
      for (const field of ["client_order_id", "order_id", "status"]) {
        requireThat(current[field] === prior[field], "original_attempt_changed");
      }
    } else requireThat(current.client_order_id !== prior.client_order_id &&
      (!current.order_id || current.order_id !== prior.order_id), "retry_identity_reused");
  }
}

export interface VerifiedRuntimeHandoff {
  readonly manifestSha256: string;
  readonly targetReleaseSha: string;
  readonly targetStrategyIdentity: string;
  readonly sourceReleaseSha: string;
  readonly sourceStrategyIdentity: string;
  readonly rankingUniverseSha256: string;
  readonly planId: string;
}
const verified = new WeakMap<VerifiedRuntimeHandoff, {
  plan: FrozenPlanInfo | null;
  snapshot: FrozenPlanInfo | null;
  carried: boolean;
}>();

/** No duck-typed proof, copied plan or later mutation can grant an exception. */
export function verifiedCarriedPlanIdentity(
  proof: VerifiedRuntimeHandoff | null | undefined,
  plan: FrozenPlanInfo | null,
  approvedReleaseSha: string | null,
): string | null {
  const binding = proof && verified.get(proof);
  return proof && binding?.carried && plan !== null && binding.plan === plan &&
    proof.targetReleaseSha === approvedReleaseSha && isDeepStrictEqual(plan, binding.snapshot)
    ? proof.targetStrategyIdentity : null;
}

export interface RuntimeArchiveContext {
  readonly approvedReleaseSha: string;
  readonly mode: AccountMode;
  readonly pin?: string;
  readonly validated?: { readonly strategyIdentity: string | null; readonly universeSha256: string | null } | null;
}

/** Exact legacy three-file archive, or complete externally pinned seven-file
 * archive. The pin is server configuration, never an archive field. */
export function readRuntimeArchive(zip: Buffer, context: RuntimeArchiveContext): {
  entries: Record<string, unknown>;
  performance: PerformanceRuntimeSnapshot | null;
  runtimeHandoff: VerifiedRuntimeHandoff | null;
} {
  const listed = listZipEntries(zip);
  const hasHandoff = listed.some((entry) => entry.name.startsWith("production/handoff/"));
  if (!hasHandoff) {
    requireThat(!(context.mode === "paper" && context.pin), "handoff_evidence_missing");
    const entries = readJsonEntries(zip, SOURCE_FILES);
    return { entries, performance: parsePerformanceRuntime(entries["performance.json"]), runtimeHandoff: null };
  }
  requireThat(context.mode === "paper", "paper_mode_required");
  requireThat(sha(context.pin), "manifest_pin_missing");
  requireThat(isDeepStrictEqual(listed.map((entry) => entry.name).sort(), [...HANDOFF_FILES].sort()), "archive_entries");
  const raw = Object.fromEntries(listed.map((entry) => [entry.name, readZipEntry(zip, entry)]));
  requireThat(digest(raw[MANIFEST]) === context.pin, "manifest_pin");
  const manifest = strictObject(raw[MANIFEST]);
  requireThat(keys(manifest, ["schema_version", "kind", "source", "target", "paper_account_sha256", "ranking_universe_sha256", "plan", "issued_at", "expires_at"]) &&
    manifest.schema_version === 1 && manifest.kind === "v11_paper_runtime_handoff", "manifest_fields");
  const { source, target, plan } = manifest;
  requireThat(keys(source, ["release_sha", "strategy_identity", "run_id", "artifact_id", "artifact_sha256", "files"]) &&
    keys(target, ["release_sha", "strategy_identity"]) &&
    keys(plan, ["plan_id", "immutable_sha256", "initial_attempts_sha256", "rebalance_month"]), "manifest_bindings");
  requireThat(commit(source.release_sha) && commit(target.release_sha) && source.release_sha !== target.release_sha &&
    target.release_sha === context.approvedReleaseSha, "target_release");
  requireThat(sha(source.strategy_identity) && sha(target.strategy_identity) && sha(context.validated?.strategyIdentity) &&
    target.strategy_identity === context.validated.strategyIdentity, "target_identity");
  requireThat(sha(manifest.ranking_universe_sha256) && sha(context.validated?.universeSha256) &&
    manifest.ranking_universe_sha256 === context.validated.universeSha256, "ranking_universe");
  requireThat(sha(source.artifact_sha256) && sha(manifest.paper_account_sha256) && sha(plan.immutable_sha256) && sha(plan.initial_attempts_sha256) &&
    typeof source.run_id === "number" && Number.isSafeInteger(source.run_id) && source.run_id > 0 &&
    typeof source.artifact_id === "number" && Number.isSafeInteger(source.artifact_id) && source.artifact_id > 0 &&
    typeof plan.plan_id === "string" && /^[0-9a-f]{16}$/.test(plan.plan_id) &&
    typeof plan.rebalance_month === "string" && MONTH.test(plan.rebalance_month), "manifest_metadata");
  const issued = typeof manifest.issued_at === "string" && manifest.issued_at.endsWith("Z") ? Date.parse(manifest.issued_at) : NaN;
  const expires = typeof manifest.expires_at === "string" && manifest.expires_at.endsWith("Z") ? Date.parse(manifest.expires_at) : NaN;
  requireThat(Number.isFinite(issued) && Number.isFinite(expires) && expires > issued && expires - issued <= 48 * 60 * 60 * 1000, "bootstrap_window");
  // This is an already produced target artifact. Bootstrap expiry/source age
  // must not invalidate its immutable evidence weeks after a valid adoption.
  requireThat(keys(source.files, SOURCE_FILES), "source_files");
  const originals: Record<string, Record<string, unknown>> = {};
  for (const name of SOURCE_FILES) {
    requireThat(sha(source.files[name]) && digest(raw[SOURCE_PREFIX + name]) === source.files[name], "source_file_integrity");
    originals[name] = strictObject(raw[SOURCE_PREFIX + name]);
  }
  const sourceRun = originals["production/last_run.json"];
  requireThat(sourceRun.schema_version === 1 && sourceRun.kind === "v11_paper_production_run" &&
    sourceRun.paper_only === true && sourceRun.status === "PASS" && sourceRun.release_sha === source.release_sha &&
    parseLastRun(sourceRun) !== null && parsePositionsRuntime(originals["positions.json"]) !== null, "source_runtime");
  const original = originals["performance.json"].adaptive_rebalance_pending;
  requireThat(isRecord(original) && parseFrozenPlan(original) !== null && parsePerformanceRuntime(originals["performance.json"]) !== null &&
    original.risk_off === false && isRecord(original.target_weights) && Object.keys(original.target_weights).length > 0 &&
    original.plan_id === plan.plan_id && original.rebalance_month === plan.rebalance_month &&
    original.strategy_identity_value === source.strategy_identity && original.ranking_universe_sha256 === manifest.ranking_universe_sha256, "source_plan_binding");
  // The manifest's Python canonical plan/attempt digests are authenticated by
  // its external pin; full source bytes are checked above. JS serialization
  // cannot recompute Python's 23.0/0.0/Unicode representation faithfully.
  attempts(original);
  const entries = Object.fromEntries(SOURCE_FILES.map((name) => [name, strictObject(raw[name])]));
  const currentRun = entries["production/last_run.json"];
  requireThat(currentRun.schema_version === 1 && currentRun.kind === "v11_paper_production_run" &&
    currentRun.paper_only === true && currentRun.release_sha === target.release_sha &&
    ["PASS", "FAIL", "DEGRADED"].includes(String(currentRun.status)), "target_run_evidence");
  const performance = parsePerformanceRuntime(entries["performance.json"]);
  requireThat(performance !== null, "current_performance");
  const current = entries["performance.json"].adaptive_rebalance_pending;
  const carried = isRecord(current) && current.strategy_identity_value === source.strategy_identity;
  if (carried) {
    requireThat(isDeepStrictEqual(immutable(current), immutable(original)), "current_plan_binding");
    attempts(current, original);
  } else if (current !== null && current !== undefined) {
    requireThat(isRecord(current) && current.strategy_identity_value === target.strategy_identity, "current_plan_identity");
    // Native plans receive no handoff exception; normal lineage remains the
    // authority. Risk transitions and broker reconciliation stay in Python.
  }
  const proof: VerifiedRuntimeHandoff = Object.freeze({
    manifestSha256: context.pin,
    targetReleaseSha: target.release_sha,
    targetStrategyIdentity: target.strategy_identity,
    sourceReleaseSha: source.release_sha,
    sourceStrategyIdentity: source.strategy_identity,
    rankingUniverseSha256: manifest.ranking_universe_sha256,
    planId: plan.plan_id,
  });
  verified.set(proof, { plan: performance.plan, snapshot: structuredClone(performance.plan), carried });
  return { entries, performance, runtimeHandoff: proof };
}
