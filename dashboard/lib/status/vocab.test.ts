import { describe, expect, it } from "vitest";
import {
  classifyAge,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  DAY,
  formatAge,
  HOUR,
  isFullSha,
  MINUTE,
  normalizeInstant,
  provenance,
  shortSha,
  unavailable,
} from "./vocab";

describe("normalizeInstant", () => {
  it("keeps an explicit UTC offset", () => {
    expect(normalizeInstant("2026-08-07T16:05:05.164354+00:00")).toBe(
      "2026-08-07T16:05:05.164Z",
    );
  });

  // The runner writes `datetime.now(ZoneInfo("America/New_York"))` with no
  // offset. Reading that as UTC was wrong by four or five hours — enough to
  // move a timestamp across a session boundary and change which day it
  // belongs to.
  it("treats the runner's naive stamp as America/New_York, not UTC", () => {
    // 12:05:05 EDT (UTC-4) in August.
    expect(normalizeInstant("2026-08-07 12:05:05")).toBe(
      "2026-08-07T16:05:05.000Z",
    );
    // 12:05:05 EST (UTC-5) in January — the offset is not a constant.
    expect(normalizeInstant("2026-01-07 12:05:05")).toBe(
      "2026-01-07T17:05:05.000Z",
    );
  });

  it("keeps an explicit offset exactly as given", () => {
    expect(normalizeInstant("2026-08-07T16:05:05+00:00")).toBe(
      "2026-08-07T16:05:05.000Z",
    );
    expect(normalizeInstant("2026-08-07T12:05:05-04:00")).toBe(
      "2026-08-07T16:05:05.000Z",
    );
  });

  it("refuses a wall time that denotes no instant or two", () => {
    // Spring forward 2026: 02:00–03:00 EST never happens in New York.
    expect(normalizeInstant("2026-03-08 02:30:00")).toBeNull();
    // Fall back 2026: 01:30 happens twice, and nothing says which one.
    expect(normalizeInstant("2026-11-01 01:30:00")).toBeNull();
    // The hours either side of each transition are unambiguous.
    expect(normalizeInstant("2026-03-08 01:30:00")).toBe(
      "2026-03-08T06:30:00.000Z",
    );
    expect(normalizeInstant("2026-11-01 03:30:00")).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });

  it("rejects junk rather than inventing a time", () => {
    expect(normalizeInstant("not a date")).toBeNull();
    expect(normalizeInstant(null)).toBeNull();
    expect(normalizeInstant(12345)).toBeNull();
    expect(normalizeInstant("")).toBeNull();
  });

  // `Date.parse` used to be the fallback for anything carrying an offset,
  // which made this function exactly as lenient as the engine underneath it.
  // Every case below produced a number there, and therefore an instant here.
  it.each([
    ["2026-02-30T12:00:00Z", "a February day that does not exist"],
    ["2026-02-29T12:00:00Z", "29 February in a non-leap year"],
    ["2026-04-31T12:00:00Z", "a 31st in a 30-day month"],
    ["2026-13-01T12:00:00Z", "a 13th month"],
    ["2026-08-11T25:00:00Z", "hour 25"],
    ["2026-08-11T12:60:00Z", "minute 60"],
    ["2026-08-11T12:00:60Z", "second 60"],
    ["2026-08-11T12:00:00+25:00", "an offset of 25 hours"],
    ["2026-08-11T12:00:00+00:60", "an offset of 60 minutes"],
    ["2026", "a bare year"],
    ["2026-08", "a year and month"],
    ["2026-08-11", "a date with no time"],
    ["Mar 3 2026 12:00:00 GMT", "a locale string"],
    ["2026-08-11T12:00Z", "no seconds"],
  ])("refuses %s (%s)", (value) => {
    expect(normalizeInstant(value)).toBeNull();
  });

  it("does not roll 2026-02-30 forward into 2 March", () => {
    // Documents the platform behaviour being defended against: this is what
    // the old implementation returned.
    expect(new Date(Date.parse("2026-02-30T12:00:00Z")).toISOString()).toBe(
      "2026-03-02T12:00:00.000Z",
    );
    expect(normalizeInstant("2026-02-30T12:00:00Z")).toBeNull();
  });

  it("reads a T-separated naive stamp as the runner's format, not as UTC", () => {
    // Python's `datetime.isoformat()` on a naive datetime emits exactly this,
    // and the runner's naive datetimes are New York wall time.
    expect(normalizeInstant("2026-08-11T12:00:00")).toBe(
      "2026-08-11T16:00:00.000Z",
    );
  });

  it("refuses an impossible calendar day in the runner's naive format too", () => {
    expect(normalizeInstant("2026-02-30 12:00:00")).toBeNull();
    expect(normalizeInstant("2026-08-11 25:00:00")).toBeNull();
  });

  it("still accepts every real shape the runner and GitHub emit", () => {
    // Guards against over-tightening: these are the live formats.
    expect(normalizeInstant("2026-08-10T16:07:45.128936+00:00")).toBe(
      "2026-08-10T16:07:45.128Z",
    );
    expect(normalizeInstant("2026-08-10T16:07:58Z")).toBe(
      "2026-08-10T16:07:58.000Z",
    );
    expect(normalizeInstant("2026-08-10T16:07:56.299351+00:00")).toBe(
      "2026-08-10T16:07:56.299Z",
    );
    expect(normalizeInstant("2024-02-29T12:00:00Z")).toBe(
      "2024-02-29T12:00:00.000Z",
    );
  });
});

describe("classifyAge", () => {
  const contract = { staleAfterSeconds: 36 * HOUR, expiredAfterSeconds: 7 * DAY };

  it("classifies fresh, stale and expired distinctly", () => {
    expect(classifyAge(60, contract)).toBe("CURRENT");
    expect(classifyAge(40 * HOUR, contract)).toBe("STALE");
    expect(classifyAge(8 * DAY, contract)).toBe("EXPIRED");
  });

  it("never treats an unknown age as current", () => {
    expect(classifyAge(null, contract)).toBe("UNAVAILABLE");
  });

  it("omits EXPIRED when the contract has no hard deadline", () => {
    expect(classifyAge(100 * DAY, { staleAfterSeconds: 5 * MINUTE })).toBe(
      "STALE",
    );
  });

  // A negative age is a datum claiming to come from the future. It used to fall
  // straight through to CURRENT, because -3600 is not greater than any stale
  // threshold — so the *most* suspect timestamp got the greenest label.
  it("tolerates only small clock skew, then calls the future a MISMATCH", () => {
    expect(classifyAge(-30, contract)).toBe("CURRENT");
    expect(classifyAge(-CLOCK_SKEW_TOLERANCE_SECONDS, contract)).toBe("CURRENT");
    expect(classifyAge(-CLOCK_SKEW_TOLERANCE_SECONDS - 1, contract)).toBe(
      "MISMATCH",
    );
    expect(classifyAge(-HOUR, contract)).toBe("MISMATCH");
    expect(classifyAge(-23 * HOUR, contract)).toBe("MISMATCH");
    expect(classifyAge(-100 * DAY, contract)).toBe("MISMATCH");
  });

  it("rejects a non-finite age instead of ranking it", () => {
    expect(classifyAge(Number.NaN, contract)).toBe("UNAVAILABLE");
    expect(classifyAge(Number.NEGATIVE_INFINITY, contract)).toBe("UNAVAILABLE");
    expect(classifyAge(Number.POSITIVE_INFINITY, contract)).toBe("UNAVAILABLE");
  });
});

describe("provenance always explains a non-CURRENT state", () => {
  const base = { source: "src", scope: "scope", now: new Date("2026-08-07T12:00:00Z") };

  it.each([
    "STALE",
    "EXPIRED",
    "MISMATCH",
    "UNAVAILABLE",
    "NOT_APPLICABLE",
    "PENDING",
  ] as const)("supplies a detail for %s when the caller gave none", (freshness) => {
    const result = provenance({ ...base, freshness });
    expect(result.detail).toBeTruthy();
    expect(result.detail!.length).toBeGreaterThan(15);
  });

  it("prefers the caller's own explanation", () => {
    const result = provenance({
      ...base,
      freshness: "MISMATCH",
      detail: "the artifact names another release",
    });
    expect(result.detail).toBe("the artifact names another release");
  });

  it("leaves CURRENT without an excuse", () => {
    expect(provenance({ ...base, freshness: "CURRENT" }).detail).toBeNull();
  });

  it("says so plainly when the timestamp is in the future", () => {
    const result = provenance({
      ...base,
      asOf: "2026-08-07T13:00:00Z",
      freshness: "MISMATCH",
    });
    expect(result.ageSeconds).toBe(-HOUR);
    expect(result.detail).toContain("from now");
  });
});

describe("formatAge", () => {
  it("formats each magnitude", () => {
    expect(formatAge(10)).toBe("10s ago");
    expect(formatAge(120)).toBe("2m ago");
    expect(formatAge(2 * HOUR + 10 * MINUTE)).toBe("2h 10m ago");
    expect(formatAge(3 * DAY)).toBe("3d ago");
  });

  it("does not print a fake age for an unknown timestamp", () => {
    expect(formatAge(null)).toBe("unknown age");
  });
});

describe("provenance", () => {
  it("computes age against the supplied clock", () => {
    const now = Date.parse("2026-08-07T16:10:00Z");
    const value = provenance({
      source: "artifact",
      scope: "release",
      asOf: "2026-08-07T16:05:00Z",
      now,
      freshness: "CURRENT",
    });
    expect(value.ageSeconds).toBe(300);
    expect(value.asOf).toBe("2026-08-07T16:05:00.000Z");
  });

  it("reports a null age when there is no timestamp", () => {
    const value = provenance({
      source: "artifact",
      scope: "release",
      freshness: "UNAVAILABLE",
    });
    expect(value.asOf).toBeNull();
    expect(value.ageSeconds).toBeNull();
  });
});

describe("unavailable", () => {
  it("always carries a reason and never any data", () => {
    const value = unavailable("artifact", "scope", "token missing");
    expect(value.data).toBeNull();
    expect(value.provenance.freshness).toBe("UNAVAILABLE");
    expect(value.provenance.detail).toBe("token missing");
  });
});

describe("sha helpers", () => {
  it("shortens only real SHAs", () => {
    expect(shortSha("0cb02c0765ebf91e60e5efd7f51334e9b538fbcb")).toBe(
      "0cb02c0765eb",
    );
    expect(shortSha("unknown")).toBeNull();
    expect(shortSha(null)).toBeNull();
  });

  it("recognises only a full 40-character SHA as approvable", () => {
    expect(isFullSha("0cb02c0765ebf91e60e5efd7f51334e9b538fbcb")).toBe(true);
    expect(isFullSha("0cb02c0")).toBe(false);
    expect(isFullSha("main")).toBe(false);
    expect(isFullSha(undefined)).toBe(false);
  });
});
