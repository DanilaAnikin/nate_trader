/**
 * One strict definition of "a calendar date" and "an instant", shared by
 * everything that reads a `YYYY-MM-DD` or an RFC 3339 timestamp out of a
 * document, a broker payload, the GitHub API or the database.
 *
 * A shape test is not a validity test, and `Date.parse` is not a validator.
 * `2026-02-30` matches `\d{4}-\d{2}-\d{2}` and `Date.parse("2026-02-30T12:00Z")`
 * silently returns 2 March — so a shape-only check lets an impossible date
 * through *and* changes what it means. `Date.parse` is worse than that: it is
 * specified to fall back to implementation-defined heuristics for anything that
 * is not exactly the ES date-time string format, so `"2026"`, `"Mar 3 2026"`,
 * `"2026-08-11T25:00:00Z"` and a dozen other shapes each produce *some* number
 * on *some* engine. Nothing here trusts it to decide what is valid; it is only
 * used to arithmetically evaluate a string this module has already validated.
 */

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real, unambiguous `YYYY-MM-DD` calendar date. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_SHAPE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * RFC 3339, in full and with no leniency:
 *
 *   date-fullyear "-" date-month "-" date-mday "T" time-hour ":" time-minute
 *   ":" time-second [ "." 1*DIGIT ] ( "Z" / ( ("+"/"-") time-hour ":" time-minute ) )
 *
 * The separator may also be a space, which is what the runner's naive format
 * uses and what `parseRunnerNaiveInstant` normalizes before calling here.
 */
const RFC3339_SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a complete RFC 3339 timestamp and return its UTC epoch
 * milliseconds, or null.
 *
 * Every component is range-checked *before* the string is handed to the
 * platform: a real calendar day (so `2026-02-30T12:00:00Z` is null rather than
 * 2 March), hours 0–23, minutes and seconds 0–59, and an offset whose own hour
 * and minute are in range. Leap seconds (`:60`) are rejected: they are legal
 * RFC 3339 but no source here emits them, and JavaScript would silently roll
 * one into the next minute.
 */
export function parseRfc3339(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_SHAPE.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, , offset] = match;
  if (!isCalendarDate(`${year}-${month}-${day}`)) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;

  if (offset !== "Z" && offset !== "z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }

  // Now — and only now — the string is known to denote exactly one instant, so
  // the platform is doing arithmetic rather than guessing.
  const parsed = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : null;
}

/** True only for a complete, in-range RFC 3339 timestamp. */
export function isRfc3339(value: unknown): value is string {
  return parseRfc3339(value) !== null;
}
