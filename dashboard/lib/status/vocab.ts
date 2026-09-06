/**
 * Shared state vocabulary for the V11 observability read model.
 *
 * Every fact the dashboard shows must carry an explicit state. Missing, stale,
 * expired or mismatched data is never allowed to degrade into `0`, a green
 * check, `LIVE`, `FRESH` or `ONLINE`.
 */

import { parseRfc3339 } from "@/lib/calendar-date";

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
  const detail = input.detail ?? null;
  return {
    source: input.source,
    scope: input.scope,
    asOf,
    ageSeconds,
    freshness: input.freshness,
    // Anything other than CURRENT is a claim the reader must be able to act on,
    // so it never ships without a reason. A caller-supplied detail is always
    // preferred; this is the floor, not a substitute for one.
    detail:
      input.freshness === "CURRENT"
        ? detail
        : (detail ?? defaultDetail(input.freshness, ageSeconds)),
  };
}

/** Last-resort explanation, so no non-CURRENT state is ever silent. */
function defaultDetail(freshness: Freshness, ageSeconds: number | null): string {
  switch (freshness) {
    case "STALE":
      return `This value is ${formatAge(ageSeconds)} and is older than its freshness contract.`;
    case "EXPIRED":
      return `This value is ${formatAge(ageSeconds)} and is past its expiry, so it must not inform a decision.`;
    case "MISMATCH":
      return ageSeconds !== null && ageSeconds < 0
        ? `This value is timestamped ${formatAge(ageSeconds)}, which cannot describe a completed observation.`
        : "Two sources that must agree do not, so the value is withheld.";
    case "PENDING":
      return "The producing step has not finished yet.";
    case "NOT_APPLICABLE":
      return "This value does not apply to the selected account or viewer.";
    case "UNAVAILABLE":
    default:
      return "The value could not be read from its source.";
  }
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

/** The zone the runner's naive timestamps are written in. */
const RUNNER_ZONE = "America/New_York";

const RUNNER_ZONE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: RUNNER_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/**
 * The ET calendar date an instant falls on.
 *
 * The runner dates a history row with `get_today_str()` — `datetime.now(EDT)`
 * — while stamping `updated_at` from the same moment, so this is the function
 * that decides whether the two agree.
 */
export function runnerZoneDate(isoInstant: string | null): string | null {
  const parsed = parseRfc3339(isoInstant);
  return parsed === null ? null : inRunnerZone(parsed).slice(0, 10);
}

/** Render an instant as `YYYY-MM-DD HH:MM:SS` in the runner's zone. */
function inRunnerZone(instantMs: number): string {
  const parts = RUNNER_ZONE_FORMAT.formatToParts(new Date(instantMs));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  // `en-CA` renders midnight as 24 in some ICU versions.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

/**
 * Interpret a naive `YYYY-MM-DD HH:MM:SS` as a wall-clock time in the runner's
 * zone, returning the UTC instant it denotes — or null when it denotes none.
 *
 * The runner writes these with `datetime.now(ZoneInfo("America/New_York"))`
 * and no offset, so reading them as UTC was wrong by four or five hours
 * depending on the season. That is not a rounding error: it moves a timestamp
 * across a session boundary and silently changes which day a value belongs to.
 *
 * Two wall times have no single instant, and both return null rather than a
 * guess:
 *
 *   * the hour skipped at the spring-forward transition denotes nothing; and
 *   * the hour repeated at the autumn transition denotes two instants an hour
 *     apart, and nothing in the stamp says which.
 *
 * Both are found by round-tripping: a candidate instant is accepted only if
 * rendering it back in the runner's zone reproduces the original text, and
 * exactly one candidate may do so.
 */
export function parseRunnerNaiveInstant(text: string): string | null {
  const normalized = text.replace("T", " ");
  // Validated as a complete timestamp *before* it is evaluated: reading it as
  // UTC is arithmetic on a known-good string, not a guess at what it might be.
  const asUtc = parseRfc3339(`${normalized.replace(" ", "T")}Z`);
  if (asUtc === null) return null;

  // North American offsets are whole hours; -4 (EDT) and -5 (EST) are the only
  // two this zone uses. Both are tried and the round trip decides.
  const matches: number[] = [];
  for (const offsetHours of [4, 5]) {
    const candidate = asUtc + offsetHours * 60 * 60 * 1000;
    if (inRunnerZone(candidate) === normalized) matches.push(candidate);
  }
  if (matches.length !== 1) return null;
  return new Date(matches[0]).toISOString();
}

/** The runner's naive wall-clock format, exactly: no offset, no sub-second. */
const RUNNER_NAIVE_SHAPE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

/**
 * Normalize an instant to ISO-8601 UTC, or null.
 *
 * Two shapes appear in the runtime artifact and the diagnostics: Python's
 * `datetime.isoformat()`, which carries an explicit offset, and the runner's
 * naive `"YYYY-MM-DD HH:MM:SS"`, which does not. The naive form is written in
 * America/New_York (see `parseRunnerNaiveInstant`), and an ambiguous or
 * nonexistent wall time returns null so the caller reports it as unavailable
 * rather than displaying an instant that may be an hour wrong.
 *
 * **Nothing here is decided by `Date.parse`.** It used to be the fallback for
 * anything with an offset, which made the function as lenient as the engine:
 * `"2026-02-30T12:00:00Z"` became 2 March, `"2026-08-11T25:00:00Z"` became the
 * next day, and bare `"2026"` became a January midnight. All three now return
 * null, because a timestamp this module cannot fully account for is not a
 * timestamp — and every caller here treats one as evidence of *when* something
 * happened.
 */
export function normalizeInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (RUNNER_NAIVE_SHAPE.test(trimmed)) {
    return parseRunnerNaiveInstant(trimmed);
  }
  const parsed = parseRfc3339(trimmed);
  return parsed === null ? null : new Date(parsed).toISOString();
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
  if (ageSeconds === null || !Number.isFinite(ageSeconds)) return "UNAVAILABLE";
  // A negative age means the datum claims to be from the future. Only genuine
  // clock skew between this server and the producer is tolerated; beyond that
  // it is broken data, and a negative age must never fall through to CURRENT
  // simply because it is not greater than the stale threshold.
  if (ageSeconds < -CLOCK_SKEW_TOLERANCE_SECONDS) return "MISMATCH";
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

/**
 * The only allowance for a timestamp ahead of this server's clock.
 *
 * Producers (the GitHub runner, Alpaca, Supabase) run on synchronised clocks,
 * so a few minutes covers ordinary drift. Anything further ahead is a
 * disagreement about reality, not freshness.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 5 * MINUTE;

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
