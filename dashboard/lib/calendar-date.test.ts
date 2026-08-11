import { describe, expect, it } from "vitest";
import { isCalendarDate } from "./calendar-date";

/**
 * The regression this file exists for: `new Date("2026-02-30T00:00:00Z")` does
 * not throw. It returns 2 March. A shape-only check therefore accepts an
 * impossible date *and* silently relabels it, which would key a session row,
 * a lineage comparison or a benchmark baseline to the wrong day.
 */
describe("isCalendarDate", () => {
  it.each([
    "2026-01-01",
    "2026-08-11",
    "2024-02-29", // a real leap day
    "2026-12-31",
  ])("accepts the real date %s", (value) => {
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    ["2026-02-30", "a February day that does not exist"],
    ["2026-02-29", "29 February in a non-leap year"],
    ["2026-04-31", "a 31st in a 30-day month"],
    ["2026-13-01", "a 13th month"],
    ["2026-00-10", "a zeroth month"],
    ["2026-01-00", "a zeroth day"],
    ["2026-01-32", "a 32nd day"],
  ])("rejects %s (%s)", (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });

  it("does not roll an invalid date forward instead of rejecting it", () => {
    // Documents the platform behaviour being defended against.
    expect(new Date("2026-02-30T00:00:00Z").toISOString().slice(0, 10)).toBe(
      "2026-03-02",
    );
    expect(isCalendarDate("2026-02-30")).toBe(false);
  });

  it.each([
    ["2026-8-11", "unpadded month"],
    ["26-08-11", "two-digit year"],
    ["2026-08-11T00:00:00Z", "a timestamp"],
    ["2026-08-11 ", "trailing whitespace"],
    [" 2026-08-11", "leading whitespace"],
    ["2026/08/11", "slashes"],
    ["", "empty"],
  ])("rejects %s (%s)", (value) => {
    expect(isCalendarDate(value)).toBe(false);
  });

  it.each([null, undefined, 20260811, {}, [], new Date()])(
    "rejects the non-string %s",
    (value) => {
      expect(isCalendarDate(value)).toBe(false);
    },
  );
});
