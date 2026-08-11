/**
 * One strict definition of "a calendar date", shared by everything that reads
 * a `YYYY-MM-DD` out of a document, a broker payload or the database.
 *
 * A shape test is not a validity test. `2026-02-30` matches `\d{4}-\d{2}-\d{2}`
 * and `new Date("2026-02-30T00:00:00Z")` silently rolls it forward to 2 March,
 * so a shape-only check lets an impossible date through *and* changes what it
 * means. Every accepted value here is round-tripped: it is a real day, and it
 * is the same day it claims to be.
 */

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real, unambiguous `YYYY-MM-DD` calendar date. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_SHAPE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}
