import { describe, expect, it } from "vitest";
import {
  absoluteTimestamps,
  decimal,
  integer,
  isStrategyStatusPayload,
  money,
  percent,
  points,
  systemIndicators,
} from "./client";
import { provenance, section, unavailable } from "./vocab";
import { buildPayload } from "@/test/payload-builder";

const IDENTITY = { id: "acc-1", nickname: "Paper prod", mode: "paper" as const };

describe("isStrategyStatusPayload", () => {
  it("accepts a complete payload for the expected account", () => {
    expect(isStrategyStatusPayload(buildPayload(), IDENTITY)).toBe(true);
  });

  it("rejects a payload for a different account, nickname or mode", () => {
    const payload = buildPayload();
    expect(isStrategyStatusPayload(payload, { ...IDENTITY, id: "acc-2" })).toBe(
      false,
    );
    expect(
      isStrategyStatusPayload(payload, { ...IDENTITY, nickname: "Other" }),
    ).toBe(false);
    expect(isStrategyStatusPayload(payload, { ...IDENTITY, mode: "live" })).toBe(
      false,
    );
  });

  it("rejects a drifted schema or a missing section", () => {
    expect(
      isStrategyStatusPayload({ ...buildPayload(), schemaVersion: 99 }, IDENTITY),
    ).toBe(false);
    const missing = { ...buildPayload() } as Record<string, unknown>;
    delete missing.convergence;
    expect(isStrategyStatusPayload(missing, IDENTITY)).toBe(false);
    expect(isStrategyStatusPayload(null, IDENTITY)).toBe(false);
    expect(isStrategyStatusPayload("nope", IDENTITY)).toBe(false);
  });
});

describe("systemIndicators", () => {
  it("reports five independently-sourced subsystem states", () => {
    const indicators = systemIndicators(buildPayload());
    expect(indicators.map((indicator) => indicator.key)).toEqual([
      "web",
      "broker",
      "runtime",
      "scheduler",
      "validation",
    ]);
    expect(indicators.every((indicator) => indicator.source.length > 0)).toBe(
      true,
    );
  });

  it("keeps a fresh broker separate from a stale V11 runtime", () => {
    const base = buildPayload();
    const payload = buildPayload({
      strategy: section(
        provenance({
          source: base.strategy.provenance.source,
          scope: base.strategy.provenance.scope,
          asOf: "2026-08-01T16:05:05Z",
          now: Date.parse("2026-08-07T17:00:00Z"),
          freshness: "STALE",
          detail: "older than its 36-hour contract",
        }),
        base.strategy.data,
      ),
    });
    const indicators = systemIndicators(payload);
    expect(indicators.find((i) => i.key === "broker")?.state).toBe("CURRENT");
    expect(indicators.find((i) => i.key === "runtime")?.state).toBe("STALE");
  });

  it("marks an infrastructure workflow failure WARN, not FAIL", () => {
    const base = buildPayload();
    const payload = buildPayload({
      operations: section(base.operations.provenance, {
        ...base.operations.data!,
        latestAttempt: {
          ...base.operations.data!.latestAttempt!,
          conclusion: "failure",
          infrastructureFailure: true,
          failureKind: "infrastructure",
        },
      }),
    });
    const scheduler = systemIndicators(payload).find(
      (indicator) => indicator.key === "scheduler",
    );
    expect(scheduler?.state).toBe("WARN");
    expect(scheduler?.detail).toContain("before any step ran");
  });

  it("marks a post-start workflow failure FAIL", () => {
    const base = buildPayload();
    const payload = buildPayload({
      operations: section(base.operations.provenance, {
        ...base.operations.data!,
        latestAttempt: {
          ...base.operations.data!.latestAttempt!,
          conclusion: "failure",
          infrastructureFailure: false,
          failureKind: "strategy-or-broker",
        },
      }),
    });
    expect(
      systemIndicators(payload).find((i) => i.key === "scheduler")?.state,
    ).toBe("FAIL");
  });

  it("reports the effective gate, never the stored report assessment", () => {
    const base = buildPayload();
    const payload = buildPayload({
      validation: section(
        provenance({
          source: base.validation.provenance.source,
          scope: base.validation.provenance.scope,
          asOf: base.validation.provenance.asOf,
          freshness: "EXPIRED",
          detail: "past the 35-day deadline",
        }),
        base.validation.data,
      ),
      validationGate: {
        effective: "FAIL",
        // The historical report still says PASS; the shell must not.
        reportAssessment: "PASS",
        reasons: ["EXPIRED"],
        details: [
          "The evidence is past its 35-day freshness deadline and can no longer authorize a paper buy.",
        ],
        expiresAt: "2026-08-14T00:00:00Z",
      },
    });
    const indicator = systemIndicators(payload).find(
      (i) => i.key === "validation",
    );
    expect(indicator?.state).toBe("FAIL");
    expect(indicator?.detail).toContain("35-day");
  });

  it("shows NOT_APPLICABLE for a viewer who may not see production evidence", () => {
    const payload = buildPayload({
      validationGate: {
        effective: "NOT_APPLICABLE",
        reportAssessment: "UNAVAILABLE",
        reasons: [],
        details: ["Not evaluated for a non-production viewer."],
        expiresAt: null,
      },
    });
    expect(
      systemIndicators(payload).find((i) => i.key === "validation")?.state,
    ).toBe("NOT_APPLICABLE");
  });

  it("reports an unavailable runtime rather than a green default", () => {
    const payload = buildPayload({
      strategy: unavailable(
        "github-actions artifact paper-runtime-state (server-only)",
        "production executor account",
        "GITHUB_TOKEN is not configured",
      ),
    });
    expect(
      systemIndicators(payload).find((i) => i.key === "runtime")?.state,
    ).toBe("UNAVAILABLE");
  });
});

describe("formatters", () => {
  it("never renders a missing value as zero", () => {
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(Number.NaN)).toBe("—");
    expect(percent(null)).toBe("—");
    expect(points(null)).toBe("—");
    expect(decimal(null)).toBe("—");
    expect(integer(null)).toBe("—");
  });

  it("formats real values with explicit signs where they matter", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(percent(4.5)).toBe("4.50%");
    expect(percent(4.5, 2, true)).toBe("+4.50%");
    expect(points(-0.1)).toBe("-0.10 pp");
    expect(points(7.06)).toBe("+7.06 pp");
    expect(integer(10)).toBe("10");
  });

  it("renders zero as zero when zero is the real value", () => {
    expect(money(0)).toBe("$0.00");
    expect(percent(0)).toBe("0.00%");
  });

  it("exposes both UTC and New York in the timestamp tooltip", () => {
    const text = absoluteTimestamps("2026-08-07T16:05:05Z");
    expect(text).toContain("UTC");
    expect(text).toContain("America/New_York");
    expect(absoluteTimestamps(null)).toBe("No timestamp recorded");
    expect(absoluteTimestamps("junk")).toBe("No timestamp recorded");
  });
});
