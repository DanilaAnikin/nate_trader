/**
 * Shared state vocabulary for the V11 observability read model.
 *
 * Every fact the dashboard shows must carry an explicit state. Missing, stale,
 * expired or mismatched data is never allowed to degrade into `0`, a green
 * check, `LIVE`, `FRESH` or `ONLINE`.
 */

/** Freshness/identity classification for one section of the read model. */
export type Freshness =
  | "CURRENT"
  | "STALE"
  | "EXPIRED"
  | "MISMATCH"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE"
  | "PENDING";

/** Outcome of a check that actually ran. */
export type CheckState =
  | "PASS"
  | "WARN"
  | "FAIL"
  | "PENDING"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";

export const FRESHNESS_VALUES: readonly Freshness[] = [
  "CURRENT",
  "STALE",
  "EXPIRED",
  "MISMATCH",
  "UNAVAILABLE",
  "NOT_APPLICABLE",
  "PENDING",
] as const;

export const CHECK_STATE_VALUES: readonly CheckState[] = [
  "PASS",
  "WARN",
  "FAIL",
  "PENDING",
  "UNAVAILABLE",
  "NOT_APPLICABLE",
] as const;

/**
 * Where one datum came from, when it was true, and how much to trust it now.
 * A single root timestamp is deliberately insufficient: broker state, strategy
 * intent, scheduler health and validation evidence age independently.
 */
export interface Provenance {
  /** Concrete, named producer — never a vague "system". */
  readonly source: string;
  /** What the value describes (account, release, repository ref, ...). */
  readonly scope: string;
  /** Absolute ISO-8601 instant the datum was true, or null when unknown. */
  readonly asOf: string | null;
  /** Age in seconds at collection time, or null when `asOf` is unknown. */
  readonly ageSeconds: number | null;
  readonly freshness: Freshness;
  /** Human-readable reason, required for anything other than CURRENT. */
  readonly detail: string | null;
}

/** One section of the payload: provenance plus its (possibly absent) data. */
export interface Section<T> {
  readonly provenance: Provenance;
  readonly data: T | null;
}

export function provenance(input: {
  source: string;
  scope: string;
  asOf?: string | null;
  now?: Date | number;
  freshness: Freshness;
  detail?: string | null;
}): Provenance {
  const asOf = normalizeInstant(input.asOf ?? null);
  const nowMs =
    input.now === undefined
      ? Date.now()
      : input.now instanceof Date
        ? input.now.getTime()
        : input.now;
  const ageSeconds =
    asOf === null ? null : Math.round((nowMs - Date.parse(asOf)) / 1000);
  return {
    source: input.source,
    scope: input.scope,
    asOf,
    ageSeconds,
    freshness: input.freshness,
    detail: input.detail ?? null,
  };
}

/** Build a section whose data could not be obtained safely. */
export function unavailable<T>(
  source: string,
  scope: string,
  detail: string,
  freshness: Extract<
    Freshness,
    "UNAVAILABLE" | "NOT_APPLICABLE" | "MISMATCH" | "PENDING"
  > = "UNAVAILABLE",
): Section<T> {
  return {
    provenance: provenance({ source, scope, asOf: null, freshness, detail }),
    data: null,
  };
}

export function section<T>(prov: Provenance, data: T | null): Section<T> {
  return { provenance: prov, data };
}

/**
 * Normalize an instant to ISO-8601 UTC. Python's `datetime.isoformat()` and
 * the runner's `"YYYY-MM-DD HH:MM:SS"` local-naive stamps both appear in the
 * runtime artifact; a naive stamp is interpreted as UTC because the production
 * runner executes on a UTC GitHub runner.
 */
export function normalizeInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(trimmed)
    ? /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
      ? trimmed.replace(" ", "T")
      : `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Classify an age against a contract. `staleAfterSeconds` marks "valid but
 * older than its contract"; `expiredAfterSeconds` marks a hard authorization
 * or freshness deadline.
 */
export function classifyAge(
  ageSeconds: number | null,
  contract: { staleAfterSeconds: number; expiredAfterSeconds?: number },
): Freshness {
  if (ageSeconds === null) return "UNAVAILABLE";
  if (
    contract.expiredAfterSeconds !== undefined &&
    ageSeconds > contract.expiredAfterSeconds
  ) {
    return "EXPIRED";
  }
  if (ageSeconds > contract.staleAfterSeconds) return "STALE";
  return "CURRENT";
}

export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Compact relative age such as `4m ago`, `2h 10m ago`, `3d ago`. */
export function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return "unknown age";
  const rounded = Math.round(ageSeconds);
  // The subscribed clock (use-now) is floored to 30-second buckets, so a
  // timestamp set at the true "now" — a just-finished read, say — can read as
  // up to ~30s in the FUTURE against that coarse clock. A read/collection age
  // is never genuinely in the future, so a small negative is a clock artifact,
  // not "12s from now". Show "just now" for anything within a minute either way.
  if (rounded > -MINUTE && rounded < 5) return "just now";
  const abs = Math.abs(rounded);
  const suffix = rounded < 0 ? "from now" : "ago";
  if (abs < 45) return `${abs}s ${suffix}`;
  if (abs < HOUR) return `${Math.round(abs / MINUTE)}m ${suffix}`;
  if (abs < DAY) {
    const hours = Math.floor(abs / HOUR);
    const minutes = Math.round((abs % HOUR) / MINUTE);
    return minutes > 0
      ? `${hours}h ${minutes}m ${suffix}`
      : `${hours}h ${suffix}`;
  }
  const days = Math.floor(abs / DAY);
  const hours = Math.round((abs % DAY) / HOUR);
  return hours > 0 ? `${days}d ${hours}h ${suffix}` : `${days}d ${suffix}`;
}

/** Short display for a commit SHA without pretending an unknown value exists. */
export function shortSha(sha: string | null | undefined): string | null {
  if (typeof sha !== "string") return null;
  const trimmed = sha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) return null;
  return trimmed.slice(0, 12);
}

export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value.trim());
}
