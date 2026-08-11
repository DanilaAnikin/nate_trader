/**
 * `last_run.json` is a document written by a producer we have already caught
 * being wrong: `summarize_execution` classified a record as blocking only on
 * an exact `ABORT`/`ERROR`, while the executor emits `ABORT_SHORT_RECONCILIATION`
 * and four other suffixed names. A cycle that aborted therefore reported
 * `status: "PASS"` with the abort visible only in `action_counts`.
 *
 * The dashboard cannot assume a fixed producer. It reads the counts itself and
 * refuses to call such a document a pass, whatever the document claims.
 */

import { describe, expect, it } from "vitest";
import { executionFromLastRun, parseLastRun } from "./parse";
import { lastRunJson } from "@/test/fixtures";

/** Every ABORT_* the executor can emit today. */
const PRODUCER_ABORT_ACTIONS = [
  "ABORT",
  "ABORT_CANCELLATION_CONFIRMATION",
  "ABORT_INVALID_PENDING_PLAN",
  "ABORT_INVALID_RISK_OFF_LATCH",
  "ABORT_OPEN_ORDER_RECONCILIATION",
  "ABORT_SHORT_RECONCILIATION",
] as const;

describe("parseLastRun — blocking actions the producer failed to flag", () => {
  it.each(PRODUCER_ABORT_ACTIONS)(
    "%s in action_counts contradicts a claimed PASS",
    (action) => {
      const run = parseLastRun(
        lastRunJson({
          status: "PASS",
          // Exactly the shape the buggy producer writes: the abort is counted,
          // but `blocking_actions` is empty because the exact-set test missed it.
          action_counts: { ADAPTIVE_PLAN: 1, [action]: 1 },
          blocking_actions: [],
        }),
      );

      expect(run).not.toBeNull();
      expect(run!.blockingActionNames).toContain(action);
      expect(run!.contradictions).toContain("BLOCKING_ACTION_COUNT");
      expect(run!.passWorthy).toBe(false);
      expect(executionFromLastRun(run!, null).status).toBe("FAIL");
    },
  );

  it.each(["ERROR", "ERROR_BROKER_TIMEOUT", "ERROR_UNSEEN_FUTURE_CASE"])(
    "%s is blocking even though no such literal exists in the producer today",
    (action) => {
      const run = parseLastRun(
        lastRunJson({
          status: "PASS",
          action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1, [action]: 2 },
        }),
      );

      expect(run!.blockingActionNames).toContain(action);
      expect(run!.passWorthy).toBe(false);
    },
  );

  it("does not treat a zero count as an occurrence", () => {
    const run = parseLastRun(
      lastRunJson({
        action_counts: {
          ADAPTIVE_REBALANCE_COMPLETE: 1,
          ABORT_SHORT_RECONCILIATION: 0,
        },
      }),
    );

    expect(run!.blockingActionNames).toEqual([]);
    expect(run!.passWorthy).toBe(true);
  });

  it("does not mistake a name that merely starts with the prefix", () => {
    const run = parseLastRun(
      lastRunJson({
        action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1, ABORTED_NOTHING: 1 },
      }),
    );

    // Not blocking — but also not a name we know, which is its own refusal.
    expect(run!.blockingActionNames).toEqual([]);
    expect(run!.unknownActions).toEqual(["ABORTED_NOTHING"]);
    expect(run!.passWorthy).toBe(false);
  });
});

describe("parseLastRun — terminal proof", () => {
  it("requires a positive terminal action, not merely the absence of a blocker", () => {
    const run = parseLastRun(
      lastRunJson({
        status: "PASS",
        action_counts: { ADAPTIVE_PLAN: 1, ADAPTIVE_TRIM: 10 },
      }),
    );

    expect(run!.terminalProofCount).toBe(0);
    expect(run!.contradictions).toContain("NO_TERMINAL_PROOF");
    expect(run!.passWorthy).toBe(false);
  });

  it("accepts exactly one terminal proof", () => {
    const run = parseLastRun(
      lastRunJson({
        action_counts: { ADAPTIVE_PLAN: 1, ADAPTIVE_REBALANCE_COMPLETE: 1 },
      }),
    );

    expect(run!.terminalProofCount).toBe(1);
    expect(run!.passWorthy).toBe(true);
  });

  it("rejects two terminal proofs — one cycle completes once", () => {
    const run = parseLastRun(
      lastRunJson({
        action_counts: {
          ADAPTIVE_REBALANCE_COMPLETE: 1,
          ADAPTIVE_PLAN_DEFERRED: 1,
        },
      }),
    );

    expect(run!.terminalProofCount).toBe(2);
    expect(run!.contradictions).toContain("AMBIGUOUS_TERMINAL_PROOF");
    expect(run!.passWorthy).toBe(false);
  });

  it("rejects a repeated single terminal proof", () => {
    const run = parseLastRun(
      lastRunJson({ action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 2 } }),
    );

    expect(run!.passWorthy).toBe(false);
  });
});

describe("parseLastRun — unknown and out-of-policy action names", () => {
  it("fails closed on a name no classification covers", () => {
    const run = parseLastRun(
      lastRunJson({
        action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1, NEW_THING_V12: 1 },
      }),
    );

    expect(run!.unknownActions).toEqual(["NEW_THING_V12"]);
    expect(run!.contradictions).toContain("UNCLASSIFIED_ACTION");
    expect(run!.passWorthy).toBe(false);
  });

  it.each(["TQQQ_BUY", "UPRO_TRIM", "BASE_SWAP_SUBMITTED", "MR_BUY", "BUY_PUT"])(
    "%s is a disabled sleeve, so a V11 cycle that emitted it is not a pass",
    (action) => {
      const run = parseLastRun(
        lastRunJson({
          action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1, [action]: 1 },
        }),
      );

      expect(run!.contradictions).toContain("NON_V11_ACTION");
      expect(run!.passWorthy).toBe(false);
    },
  );

  it("treats a DRY_RUN action in a production summary as a contradiction", () => {
    const run = parseLastRun(
      lastRunJson({
        action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1, DRY_RUN_SELL: 1 },
      }),
    );

    expect(run!.contradictions).toContain("NON_V11_ACTION");
    expect(run!.passWorthy).toBe(false);
  });
});

describe("parseLastRun — atomic document validation", () => {
  it("rejects the document when action_counts is missing", () => {
    const json = lastRunJson();
    delete json.action_counts;
    expect(parseLastRun(json)).toBeNull();
  });

  it("rejects the document when blocking_actions is missing", () => {
    const json = lastRunJson();
    delete json.blocking_actions;
    expect(parseLastRun(json)).toBeNull();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "ADAPTIVE_PLAN=1"],
  ])("rejects action_counts that is %s", (_label, counts) => {
    expect(parseLastRun(lastRunJson({ action_counts: counts }))).toBeNull();
  });

  it.each([
    ["fractional", 0.5],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["a numeric string", "1"],
    ["null", null],
  ])("rejects the whole document when a count is %s", (_label, count) => {
    expect(
      parseLastRun(
        lastRunJson({
          action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1, ADAPTIVE_BUY: count },
        }),
      ),
    ).toBeNull();
  });

  it("rejects a malformed action key instead of skipping it", () => {
    expect(
      parseLastRun(
        lastRunJson({
          action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1, "adaptive buy": 1 },
        }),
      ),
    ).toBeNull();
  });

  it("rejects an over-long action key", () => {
    expect(
      parseLastRun(
        lastRunJson({ action_counts: { ["A".repeat(65)]: 1 } }),
      ),
    ).toBeNull();
  });

  it("rejects the whole document rather than truncating a 33rd blocker", () => {
    const blockers = Array.from({ length: 33 }, (_, index) => ({
      action: "ABORT_SHORT_RECONCILIATION",
      symbol: `S${index}`,
    }));
    expect(
      parseLastRun(lastRunJson({ status: "DEGRADED", blocking_actions: blockers })),
    ).toBeNull();
  });

  it("accepts exactly 32 blockers", () => {
    const blockers = Array.from({ length: 32 }, (_, index) => ({
      action: "ABORT_SHORT_RECONCILIATION",
      symbol: `S${index}`,
    }));
    const run = parseLastRun(
      lastRunJson({
        status: "DEGRADED",
        action_counts: { ABORT_SHORT_RECONCILIATION: 32 },
        blocking_actions: blockers,
      }),
    );
    expect(run?.blockingActions).toHaveLength(32);
  });

  it.each([
    ["a non-record entry", ["ABORT_SHORT_RECONCILIATION"]],
    ["an entry with no action", [{ symbol: "AAA" }]],
    ["an entry with an empty action", [{ action: "  ", symbol: "AAA" }]],
    ["an entry with a malformed action", [{ action: "abort now", symbol: "AAA" }]],
    ["an entry with a non-string symbol", [{ action: "ABORT", symbol: 7 }]],
    [
      "an entry whose action is not blocking at all",
      [{ action: "ADAPTIVE_BUY", symbol: "AAA" }],
    ],
  ])("rejects the whole document for %s", (_label, blocking) => {
    expect(
      parseLastRun(lastRunJson({ status: "DEGRADED", blocking_actions: blocking })),
    ).toBeNull();
  });

  it("rejects a blocker that is absent from action_counts", () => {
    expect(
      parseLastRun(
        lastRunJson({
          status: "DEGRADED",
          action_counts: { ADAPTIVE_PLAN: 1 },
          blocking_actions: [
            { action: "ABORT_SHORT_RECONCILIATION", symbol: "AAA" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("rejects a successful run with no usable risk tier", () => {
    expect(parseLastRun(lastRunJson({ risk_tier: "SPICY" }))).toBeNull();
    const json = lastRunJson();
    delete json.risk_tier;
    expect(parseLastRun(json)).toBeNull();
  });

  it("allows a crashed run to have no risk tier — it never computed one", () => {
    const json = lastRunJson({ status: "FAIL", failure_type: "RuntimeError" });
    delete json.risk_tier;
    const run = parseLastRun(json);
    expect(run?.status).toBe("FAIL");
    expect(run?.riskTier).toBeNull();
  });

  it("rejects a PASS that also carries a failure type", () => {
    expect(
      parseLastRun(lastRunJson({ status: "PASS", failure_type: "RuntimeError" })),
    ).toBeNull();
  });

  it("rejects a DEGRADED that carries a failure type without failing", () => {
    // FAIL is the only status the crash path writes, and it is the only one
    // that may carry `failure_type`.
    expect(
      parseLastRun(
        lastRunJson({ status: "DEGRADED", failure_type: "RuntimeError" }),
      ),
    ).toBeNull();
  });

  it("rejects a non-string failure type on a FAIL", () => {
    expect(
      parseLastRun(lastRunJson({ status: "FAIL", failure_type: 500 })),
    ).toBeNull();
  });

  it("rejects a DEGRADED whose blocking_actions is empty and whose counts are clean", () => {
    // Nothing in the document explains the degradation. An unexplained
    // downgrade is a document we do not understand.
    expect(
      parseLastRun(
        lastRunJson({
          status: "DEGRADED",
          action_counts: { ADAPTIVE_REBALANCE_COMPLETE: 1 },
          blocking_actions: [],
        }),
      ),
    ).toBeNull();
  });
});
