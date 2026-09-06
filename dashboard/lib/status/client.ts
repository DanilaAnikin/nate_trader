/**
 * Client-side boundary for the strategy status payload.
 *
 * A delayed response for account A must never paint over account B, and a
 * payload whose schema drifted must never be rendered. These checks run in the
 * browser before any number reaches the screen.
 */

import type {
  StrategyStatusPayload,
  SystemIndicator,
} from "./types";
import {
  STRATEGY_STATUS_SCHEMA_VERSION,
  STRATEGY_STATUS_SOURCE,
} from "./types";
import { FRESHNESS_VALUES, type Freshness } from "./vocab";

export interface StatusIdentity {
  readonly id: string;
  readonly nickname: string;
  readonly mode: "paper" | "live";
}

function isSectionLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const prov = candidate.provenance as Record<string, unknown> | undefined;
  return (
    typeof prov === "object" &&
    prov !== null &&
    typeof prov.source === "string" &&
    typeof prov.scope === "string" &&
    FRESHNESS_VALUES.includes(prov.freshness as Freshness) &&
    "data" in candidate
  );
}

const REQUIRED_SECTIONS = [
  "web",
  "release",
  "authorization",
  "accountBinding",
  "broker",
  "strategy",
  "universe",
  "validation",
  "preflight",
  "execution",
  "operations",
  "tournament",
  "convergence",
] as const;

export function isStrategyStatusPayload(
  value: unknown,
  expected: StatusIdentity,
): value is StrategyStatusPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== STRATEGY_STATUS_SCHEMA_VERSION) return false;
  if (payload.source !== STRATEGY_STATUS_SOURCE) return false;
  if (payload.accountId !== expected.id) return false;
  if (payload.accountNickname !== expected.nickname) return false;
  if (payload.accountMode !== expected.mode) return false;
  if (
    typeof payload.collectedAt !== "string" ||
    !Number.isFinite(Date.parse(payload.collectedAt))
  ) {
    return false;
  }
  if (!Array.isArray(payload.warnings)) return false;
  const gate = payload.validationGate as Record<string, unknown> | undefined;
  if (
    typeof gate !== "object" ||
    gate === null ||
    typeof gate.effective !== "string" ||
    typeof gate.reportAssessment !== "string" ||
    !Array.isArray(gate.reasons)
  ) {
    return false;
  }
  return REQUIRED_SECTIONS.every((key) => isSectionLike(payload[key]));
}

/**
 * The five independent shell indicators. There is deliberately no single
 * aggregate "online" dot: web readiness says nothing about the broker, the
 * strategy runtime, the scheduler, or the promotion evidence.
 */
export function systemIndicators(
  payload: StrategyStatusPayload,
): SystemIndicator[] {
  const operations = payload.operations.data;
  const latest = operations?.latestAttempt ?? null;

  // Only derive the scheduler dot from the latest attempt when the operations
  // source is CURRENT. A STALE source must surface as STALE (amber) like every
  // other freshness indicator — grouping STALE with CURRENT let a workflow that
  // last succeeded days ago render a green PASS, which is exactly the
  // "stale data degrading into a green check" the vocabulary forbids.
  const schedulerState: SystemIndicator["state"] =
    payload.operations.provenance.freshness !== "CURRENT"
      ? payload.operations.provenance.freshness
      : !latest
        ? "UNAVAILABLE"
        : latest.status !== "completed"
          ? "PENDING"
          : latest.conclusion === "success"
            ? "PASS"
            : latest.infrastructureFailure
              ? "WARN"
              : "FAIL";

  const schedulerDetail = !latest
    ? "no scheduled attempt was found"
    : latest.conclusion === "success"
      ? `attempt #${latest.runNumber} succeeded`
      : latest.infrastructureFailure
        ? `attempt #${latest.runNumber} failed in GitHub infrastructure before any step ran; no strategy, preflight or broker work happened`
        : `attempt #${latest.runNumber} failed after the job started`;

  // The shell reports the *effective* gate, never the stored report
  // assessment: an expired or mismatched PASS must not look green anywhere.
  const validationState: SystemIndicator["state"] = payload.validationGate
    .effective;

  return [
    {
      key: "web",
      label: "Web",
      state: payload.web.data?.status === "ok" ? "PASS" : "FAIL",
      source: payload.web.provenance.source,
      scope: payload.web.provenance.scope,
      asOf: payload.web.provenance.asOf,
      ageSeconds: payload.web.provenance.ageSeconds,
      detail: payload.web.data
        ? `build ${payload.web.data.dashboardBuildSha?.slice(0, 12) ?? "unknown"} · ${payload.web.data.dataMode}`
        : payload.web.provenance.detail,
    },
    {
      key: "broker",
      label: "Broker",
      state: payload.broker.provenance.freshness,
      source: payload.broker.provenance.source,
      scope: payload.broker.provenance.scope,
      asOf: payload.broker.provenance.asOf,
      ageSeconds: payload.broker.provenance.ageSeconds,
      detail:
        payload.broker.provenance.detail ??
        "a successful broker request; it says nothing about the V11 run",
    },
    {
      key: "runtime",
      label: "V11 runtime",
      state: payload.strategy.provenance.freshness,
      source: payload.strategy.provenance.source,
      scope: payload.strategy.provenance.scope,
      asOf: payload.strategy.provenance.asOf,
      ageSeconds: payload.strategy.provenance.ageSeconds,
      detail: payload.strategy.provenance.detail,
    },
    {
      key: "scheduler",
      label: "Scheduler",
      state: schedulerState,
      source: payload.operations.provenance.source,
      scope: payload.operations.provenance.scope,
      asOf: payload.operations.provenance.asOf,
      ageSeconds: payload.operations.provenance.ageSeconds,
      detail: schedulerDetail,
    },
    {
      key: "validation",
      label: "Validation",
      state: validationState,
      source: payload.validation.provenance.source,
      scope: payload.validation.provenance.scope,
      asOf: payload.validation.provenance.asOf,
      ageSeconds: payload.validation.provenance.ageSeconds,
      detail:
        payload.validationGate.details[0] ??
        payload.validation.provenance.detail,
    },
  ];
}

/* ------------------------------------------------------------ formatting */

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const COMPACT_MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Money, or an explicit dash. A missing value is never rendered as `$0`. */
export function money(value: number | null | undefined, compact = false): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return (compact ? COMPACT_MONEY : MONEY).format(value);
}

export function percent(
  value: number | null | undefined,
  digits = 2,
  signed = false,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function points(
  value: number | null | undefined,
  digits = 2,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)} pp`;
}

export function decimal(
  value: number | null | undefined,
  digits = 2,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

export function integer(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return String(Math.round(value));
}

/** Absolute timestamp in both UTC and America/New_York, for tooltips. */
export function absoluteTimestamps(iso: string | null): string {
  if (!iso) return "No timestamp recorded";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "No timestamp recorded";
  const date = new Date(parsed);
  const utc = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(date);
  const ny = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "America/New_York",
  }).format(date);
  return `${utc} UTC\n${ny} America/New_York`;
}
