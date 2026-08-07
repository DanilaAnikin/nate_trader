import { describe, expect, it } from "vitest";
import {
  classifyAge,
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

  it("treats the runner's naive stamp as UTC (the runner executes on a UTC runner)", () => {
    expect(normalizeInstant("2026-08-07 12:05:05")).toBe(
      "2026-08-07T12:05:05.000Z",
    );
  });

  it("rejects junk rather than inventing a time", () => {
    expect(normalizeInstant("not a date")).toBeNull();
    expect(normalizeInstant(null)).toBeNull();
    expect(normalizeInstant(12345)).toBeNull();
    expect(normalizeInstant("")).toBeNull();
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
