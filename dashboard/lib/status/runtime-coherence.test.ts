/**
 * The runtime documents must agree with themselves.
 *
 * Structural validity is not coherence. `performance.json` can parse perfectly
 * and still carry an empty history, a session dated tomorrow, or a last row
 * whose equity is nothing like the scalar equity printed beside it — and each
 * of those renders on screen as an ordinary observation. The producer writes
 * both halves in one function from one snapshot, so any disagreement between
 * them means the document is a mixture of two moments.
 */

import { describe, expect, it } from "vitest";
import { parseFrozenPlan, parsePerformanceRuntime, parseValidation } from "./parse";
import { assessPerformanceCoherence } from "./coherence";
import { frozenPlanJson, performanceJson, validationJson } from "@/test/fixtures";

describe("parsePerformanceRuntime — history must describe the same moment", () => {
  it("rejects an empty daily_history", () => {
    // The rolling drawdown and the risk tier are computed from this series.
    // Zero rows is not a quiet account; it is no evidence at all.
    expect(parsePerformanceRuntime(performanceJson({ daily_history: [] }))).toBeNull();
  });

  it("rejects a history whose last session is after the update timestamp", () => {
    const json = performanceJson({
      updated_at: "2026-08-07 12:05:05",
      daily_history: [
        { date: "2026-08-06", equity: 1_000_000 },
        { date: "2026-08-08", equity: 1_010_000 },
      ],
    });
    expect(parsePerformanceRuntime(json)).toBeNull();
  });

  it("rejects a history whose last session is not the ET session of updated_at", () => {
    // `update_performance_state` appends `get_today_str()` — the ET calendar
    // date of the same instant it stamps into `updated_at`. They cannot differ.
    const json = performanceJson({
      updated_at: "2026-08-07 12:05:05",
      daily_history: [{ date: "2026-08-05", equity: 1_000_000 }],
    });
    expect(parsePerformanceRuntime(json)).toBeNull();
  });

  it("accepts the two written by one cycle", () => {
    const json = performanceJson({
      updated_at: "2026-08-07 12:05:05",
      equity: 1_010_000,
      daily_history: [
        { date: "2026-08-06", equity: 1_000_000 },
        { date: "2026-08-07", equity: 1_010_000 },
      ],
    });
    expect(parsePerformanceRuntime(json)).not.toBeNull();
  });

  it("rejects a last-row equity that disagrees with the scalar equity", () => {
    const json = performanceJson({
      updated_at: "2026-08-07 12:05:05",
      equity: 1_010_000,
      daily_history: [{ date: "2026-08-07", equity: 999_999 }],
    });
    expect(parsePerformanceRuntime(json)).toBeNull();
  });

  it("tolerates a sub-cent difference from float round-tripping", () => {
    const json = performanceJson({
      updated_at: "2026-08-07 12:05:05",
      equity: 1_010_000.004,
      daily_history: [{ date: "2026-08-07", equity: 1_010_000 }],
    });
    expect(parsePerformanceRuntime(json)).not.toBeNull();
  });

  it("rejects a difference of a whole cent and more", () => {
    const json = performanceJson({
      updated_at: "2026-08-07 12:05:05",
      equity: 1_010_000.02,
      daily_history: [{ date: "2026-08-07", equity: 1_010_000 }],
    });
    expect(parsePerformanceRuntime(json)).toBeNull();
  });

  it("rejects an updated_at whose wall time does not exist in the runner's zone", () => {
    // 02:30 on the spring-forward date denotes no instant, so it cannot
    // establish which session the history belongs to.
    expect(
      parsePerformanceRuntime(
        performanceJson({
          updated_at: "2026-03-08 02:30:00",
          daily_history: [{ date: "2026-03-08", equity: 1_000_000 }],
        }),
      ),
    ).toBeNull();
  });
});

describe("assessPerformanceCoherence — placing the cycle in time", () => {
  const perf = () =>
    parsePerformanceRuntime(
      performanceJson({
        updated_at: "2026-08-07 12:05:05",
        equity: 1_010_000,
        daily_history: [{ date: "2026-08-07", equity: 1_010_000 }],
      }),
    )!;

  /** 2026-08-07 12:05:05 ET is 16:05:05Z. */
  const UPDATED_UTC = "2026-08-07T16:05:05.000Z";
  const NOW = new Date("2026-08-07T17:00:00Z");

  it("accepts a performance stamp inside the execute-step window", () => {
    expect(
      assessPerformanceCoherence(perf(), {
        lastRunCompletedAt: "2026-08-07T16:05:06.000Z",
        executeStep: {
          startedAt: "2026-08-07T16:04:00.000Z",
          completedAt: "2026-08-07T16:06:00.000Z",
        },
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("rejects a performance stamp before the execute step started", () => {
    expect(
      assessPerformanceCoherence(perf(), {
        lastRunCompletedAt: "2026-08-07T16:05:06.000Z",
        executeStep: {
          startedAt: "2026-08-07T16:30:00.000Z",
          completedAt: "2026-08-07T16:40:00.000Z",
        },
        now: NOW,
      }),
    ).toContain("PERFORMANCE_OUTSIDE_STEP_WINDOW");
  });

  it("rejects a performance stamp after the execute step completed", () => {
    expect(
      assessPerformanceCoherence(perf(), {
        lastRunCompletedAt: "2026-08-07T16:05:06.000Z",
        executeStep: {
          startedAt: "2026-08-07T15:00:00.000Z",
          completedAt: "2026-08-07T15:30:00.000Z",
        },
        now: NOW,
      }),
    ).toContain("PERFORMANCE_OUTSIDE_STEP_WINDOW");
  });

  it("refuses to place the cycle when the step window is unknown", () => {
    expect(
      assessPerformanceCoherence(perf(), {
        lastRunCompletedAt: "2026-08-07T16:05:06.000Z",
        executeStep: null,
        now: NOW,
      }),
    ).toContain("EXECUTE_STEP_WINDOW_UNKNOWN");
  });

  it("rejects a performance stamp after the run completed", () => {
    // `update_performance_state()` runs *before* the summary is written, so a
    // performance file newer than the run record is not this cycle's.
    expect(
      assessPerformanceCoherence(perf(), {
        lastRunCompletedAt: "2026-08-07T16:00:00.000Z",
        executeStep: {
          startedAt: "2026-08-07T15:50:00.000Z",
          completedAt: "2026-08-07T16:10:00.000Z",
        },
        now: NOW,
      }),
    ).toContain("PERFORMANCE_AFTER_RUN");
  });

  it("allows the small clock tolerance between the two writes", () => {
    expect(
      assessPerformanceCoherence(perf(), {
        // Two seconds earlier — the two files are written moments apart and
        // the ordering can invert under a coarse clock.
        lastRunCompletedAt: "2026-08-07T16:05:03.000Z",
        executeStep: {
          startedAt: "2026-08-07T16:04:00.000Z",
          completedAt: "2026-08-07T16:06:00.000Z",
        },
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("rejects a performance stamp in the server's future", () => {
    expect(
      assessPerformanceCoherence(perf(), {
        lastRunCompletedAt: UPDATED_UTC,
        executeStep: {
          startedAt: "2026-08-07T16:04:00.000Z",
          completedAt: "2026-08-07T16:06:00.000Z",
        },
        // The server is an hour behind the stamp — beyond any skew allowance.
        now: new Date("2026-08-07T15:00:00.000Z"),
      }),
    ).toContain("PERFORMANCE_IN_FUTURE");
  });

  it("tolerates skew inside the allowance but still refuses the hour", () => {
    const withinSkew = assessPerformanceCoherence(perf(), {
      lastRunCompletedAt: UPDATED_UTC,
      executeStep: {
        startedAt: "2026-08-07T16:04:00.000Z",
        completedAt: "2026-08-07T16:06:00.000Z",
      },
      now: new Date("2026-08-07T16:03:00.000Z"),
    });
    expect(withinSkew).not.toContain("PERFORMANCE_IN_FUTURE");
  });
});

describe("parseFrozenPlan — one malformed record rejects the plan", () => {
  it("accepts the reference plan", () => {
    expect(parseFrozenPlan(frozenPlanJson())).not.toBeNull();
  });

  it.each([
    ["2026-8", "a month without a zero-padded ordinal"],
    ["2026-13", "an impossible month"],
    ["2026-00", "a zero month"],
    ["August 2026", "a prose month"],
    ["2026-08-01", "a full date where a month belongs"],
  ])("rejects rebalance_month %s (%s)", (rebalance_month) => {
    expect(parseFrozenPlan(frozenPlanJson({ rebalance_month }))).toBeNull();
  });

  it("accepts a well-formed rebalance_month", () => {
    expect(parseFrozenPlan(frozenPlanJson({ rebalance_month: "2026-08" }))).not.toBeNull();
  });

  it.each([
    ["2026-02-30", "a date that does not exist"],
    ["2026-8-7", "an unpadded date"],
    ["", "an empty string"],
  ])("rejects signal_date %s (%s)", (signal_date) => {
    expect(parseFrozenPlan(frozenPlanJson({ signal_date }))).toBeNull();
  });

  it("rejects a missing signal_date — a plan is bound to the close it read", () => {
    const json = frozenPlanJson();
    delete json.signal_date;
    expect(parseFrozenPlan(json)).toBeNull();
  });

  it("rejects a malformed created_at instead of nulling it", () => {
    expect(parseFrozenPlan(frozenPlanJson({ created_at: "yesterday" }))).toBeNull();
    const json = frozenPlanJson();
    delete json.created_at;
    expect(parseFrozenPlan(json)).toBeNull();
  });

  it("rejects a signal_date after the plan was created", () => {
    expect(
      parseFrozenPlan(
        frozenPlanJson({
          signal_date: "2026-09-01",
          created_at: "2026-08-07T16:05:05+00:00",
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["fractional", 4.5],
    ["negative", -1],
    ["a string", "12"],
    ["null", null],
    ["absent", undefined],
  ])("rejects a %s eligible_count rather than defaulting it to zero", (_label, eligible_count) => {
    const json = frozenPlanJson({ eligible_count });
    if (eligible_count === undefined) delete json.eligible_count;
    expect(parseFrozenPlan(json)).toBeNull();
  });

  it("rejects a target symbol with no sector classification", () => {
    // The sector cap is enforced against this map. A target the map does not
    // mention used to become "Unknown", which is a sector that cannot breach
    // a cap — the exact fabrication the strategy rules forbid.
    const json = frozenPlanJson();
    const sectors = { ...(json.sector_by_symbol as Record<string, string>) };
    const [first] = Object.keys(json.target_weights as Record<string, number>);
    delete sectors[first];
    expect(parseFrozenPlan({ ...json, sector_by_symbol: sectors })).toBeNull();
  });

  it("rejects a sector map that names a symbol the plan does not target", () => {
    const json = frozenPlanJson();
    const sectors = {
      ...(json.sector_by_symbol as Record<string, string>),
      GHOST: "Technology",
    };
    expect(parseFrozenPlan({ ...json, sector_by_symbol: sectors })).toBeNull();
  });

  it("rejects a malformed target symbol", () => {
    const json = frozenPlanJson();
    expect(
      parseFrozenPlan({
        ...json,
        target_weights: { ...(json.target_weights as object), "not a symbol": 0.05 },
        sector_by_symbol: {
          ...(json.sector_by_symbol as object),
          "not a symbol": "Technology",
        },
      }),
    ).toBeNull();
  });

  it("rejects an empty target set on a plan that is not risk-off", () => {
    expect(
      parseFrozenPlan(
        frozenPlanJson({ risk_off: false, target_weights: {}, sector_by_symbol: {} }),
      ),
    ).toBeNull();
  });

  it("accepts an empty target set when the plan is risk-off", () => {
    expect(
      parseFrozenPlan(
        frozenPlanJson({ risk_off: true, target_weights: {}, sector_by_symbol: {} }),
      ),
    ).not.toBeNull();
  });

  it.each([
    ["a non-record attempt", { AAA: "buy 10" }],
    ["a missing symbol", { AAA: { side: "buy", quantity: 1, target_weight: 0.05, attempt: 1 } }],
    [
      "an unknown side",
      { AAA: { symbol: "AAA", side: "short", quantity: 1, target_weight: 0.05, attempt: 1 } },
    ],
    [
      "a negative quantity",
      { AAA: { symbol: "AAA", side: "buy", quantity: -1, target_weight: 0.05, attempt: 1 } },
    ],
    [
      "a zero quantity",
      { AAA: { symbol: "AAA", side: "buy", quantity: 0, target_weight: 0.05, attempt: 1 } },
    ],
    [
      "a target weight above one",
      { AAA: { symbol: "AAA", side: "buy", quantity: 1, target_weight: 1.5, attempt: 1 } },
    ],
    [
      "a fractional attempt",
      { AAA: { symbol: "AAA", side: "buy", quantity: 1, target_weight: 0.05, attempt: 1.5 } },
    ],
    [
      "a zero attempt",
      { AAA: { symbol: "AAA", side: "buy", quantity: 1, target_weight: 0.05, attempt: 0 } },
    ],
    [
      "an unreadable submitted_at",
      {
        AAA: {
          symbol: "AAA",
          side: "buy",
          quantity: 1,
          target_weight: 0.05,
          attempt: 1,
          submitted_at: "just now",
        },
      },
    ],
  ])("rejects the whole plan for an order attempt with %s", (_label, order_attempts) => {
    // This used to `continue`, publishing a plan that silently omitted the
    // pending order nobody could read — which reads on screen as "no pending
    // order", the opposite of the truth.
    expect(parseFrozenPlan(frozenPlanJson({ order_attempts }))).toBeNull();
  });

  it("rejects an order_attempts that is not a record", () => {
    expect(parseFrozenPlan(frozenPlanJson({ order_attempts: [] }))).toBeNull();
  });

  it("rejects more order attempts than a plan can have", () => {
    const order_attempts: Record<string, unknown> = {};
    for (let index = 0; index < 65; index += 1) {
      order_attempts[`S${index}`] = {
        symbol: `S${index}`,
        side: "buy",
        quantity: 1,
        target_weight: 0.01,
        attempt: 1,
      };
    }
    expect(parseFrozenPlan(frozenPlanJson({ order_attempts }))).toBeNull();
  });
});

describe("parseValidation — counts are explicit non-negative integers", () => {
  function withAssessment(patch: Record<string, unknown>) {
    const json = validationJson();
    return parseValidation(
      { ...json, assessment: { ...(json.assessment as object), ...patch } },
      "refs/heads/main",
    );
  }

  it.each([
    ["fractional", { checks_evaluated: 0.5, checks_passed: 0.5 }],
    ["a fractional pass count", { checks_evaluated: 8, checks_passed: 7.5 }],
    ["negative", { checks_evaluated: -1, checks_passed: -1 }],
    ["a numeric string", { checks_evaluated: "8", checks_passed: "8" }],
    ["null", { checks_evaluated: null, checks_passed: null }],
  ])("does not report %s check counts as counts", (_label, patch) => {
    // `num()` accepted any finite number, so 0.5 evaluated and 0.5 passed
    // satisfied "> 0 and equal" and the gate read it as fully checked.
    const report = withAssessment(patch);
    expect(report?.checksEvaluated ?? null).toBeNull();
    expect(report?.checksPassed ?? null).toBeNull();
  });

  it("keeps well-formed integer counts", () => {
    const report = withAssessment({ checks_evaluated: 8, checks_passed: 8 });
    expect(report?.checksEvaluated).toBe(8);
    expect(report?.checksPassed).toBe(8);
  });
});
