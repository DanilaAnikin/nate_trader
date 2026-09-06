/**
 * A closed vocabulary for the action names a production summary may contain.
 *
 * `state/production/last_run.json` is written by `scripts/production_run.py`,
 * and that producer has already been wrong once in exactly the way that
 * matters: it flagged a record as blocking only when its action was the exact
 * string `ABORT` or `ERROR`, while the executor emits
 * `ABORT_SHORT_RECONCILIATION` and four other suffixed names. A cycle that
 * aborted on an unreconciled short was recorded as `status: "PASS"` with the
 * abort visible only as a count.
 *
 * So the dashboard re-derives the verdict from the counts instead of trusting
 * the producer's own summary line. Because a future producer may emit names
 * this file has never seen, an unclassified name is a refusal, not a shrug:
 * new names must be classified here before a run carrying one can pass.
 */

/** What an action name means for the health of a completed cycle. */
export type ActionClass =
  /** The cycle stopped. Any non-zero count refuses a pass. */
  | "blocking"
  /** The cycle reached its own end. Exactly one is required for a pass. */
  | "terminal"
  /** Ordinary V11 work: planning, orders, gates, pending reconciliation. */
  | "neutral"
  /**
   * A disabled sleeve or a dry-run marker. Not an error in itself, but a V11
   * paper-production cycle that emitted one did not run the V11 policy.
   */
  | "non-v11"
  /** Not in this file. Fails closed. */
  | "unknown";

/**
 * `ABORT`, `ABORT_*`, `ERROR`, `ERROR_*`. A prefix rule rather than a list, so
 * an abort path added to the executor tomorrow blocks without first having to
 * be enumerated here — the failure mode of the exact-set test.
 */
const BLOCKING_PREFIXES = ["ABORT", "ERROR"] as const;

export function isBlockingAction(action: string): boolean {
  return BLOCKING_PREFIXES.some(
    (prefix) => action === prefix || action.startsWith(`${prefix}_`),
  );
}

/**
 * The three ways a V11 cycle can announce that it finished: it rebalanced, it
 * deliberately deferred the plan to a later boundary, or it deferred an
 * infrastructure cancellation. Anything else means it stopped somewhere.
 */
export const TERMINAL_ACTIONS: readonly string[] = [
  "ADAPTIVE_DEFERRED_INFRASTRUCTURE_CANCELLATION",
  "ADAPTIVE_PLAN_DEFERRED",
  "ADAPTIVE_REBALANCE_COMPLETE",
];

/** Ordinary V11 vocabulary, taken from the executor and the broker layer. */
const NEUTRAL_ACTIONS: readonly string[] = [
  "ADAPTIVE_BUY",
  "ADAPTIVE_EXIT",
  "ADAPTIVE_PLAN",
  "ADAPTIVE_TRIM",
  "BLOCK",
  "CANCEL_ALL_ORDERS_REQUESTED",
  "CANCEL_REQUESTED",
  "ENTRY_GATE_BLOCKED",
  "FINAL_TARGET",
  "FLATTEN",
  "HALT",
  "HOLD",
  "ORDER_BOOK_RECONCILIATION_PENDING_CANCELLATIONS",
  "ORDER_REJECTED",
  "PENDING_BUY",
  "PENDING_BUY_BLOCKS_SELL",
  "PENDING_CANCELLATION",
  "PENDING_SELL",
  "POSITION_SNAPSHOT_RECONCILIATION_PENDING_CANCELLATIONS",
  "REBALANCE_PENDING_BUYS",
  "REBALANCE_PENDING_CANCELLATIONS",
  "REBALANCE_PENDING_SELLS",
  "REJECTED",
  "SELL",
  "SELL_CAPACITY_RECONCILIATION_PENDING_CANCELLATIONS",
  "SHORT_COVER_PENDING",
  "SHORT_RECONCILIATION_PENDING_CANCELLATIONS",
  "SKIP",
  "SKIP_MIN_HOLD",
  "STALE_PLAN_PENDING_ORDERS",
  "VALIDATION_GATE_BLOCKED",
];

/**
 * Sleeves the V11 policy disables (SPY/SSO base, TQQQ, UPRO, hedges, options,
 * mean reversion, PEAD, the legacy score-driven picker) plus the dry-run
 * markers, which `production_run.py` cannot legitimately produce because it
 * calls `run_execution(dry_run=False)`.
 */
const NON_V11_ACTIONS: readonly string[] = [
  "BASE_BUY",
  "BASE_EXIT_PENDING",
  "BASE_EXIT_SUBMITTED",
  "BASE_SWAP_PENDING",
  "BASE_SWAP_SUBMITTED",
  "BASE_TRIM",
  "BUY_PUT",
  "CLOSE_PUT",
  "HEDGE_BUY",
  "HEDGE_EXIT_PENDING",
  "HEDGE_EXIT_SUBMITTED",
  "HEDGE_TRIM",
  "MOMENTUM_BUY",
  "MOMENTUM_EXIT",
  "MR_BUY",
  "MR_EXIT",
  "PEAD_BUY",
  "PEAD_EXIT",
  "ROLL_PUT",
  "SCALE_OUT",
  "TIGHTEN",
  "TIME_STOP",
  "TQQQ_BUY",
  "TQQQ_EXIT_PENDING",
  "TQQQ_EXIT_SUBMITTED",
  "TQQQ_TRIM",
  "UPRO_BUY",
  "UPRO_EXIT_PENDING",
  "UPRO_EXIT_SUBMITTED",
  "UPRO_TRIM",
];

const CLASSIFICATION = new Map<string, ActionClass>([
  ...TERMINAL_ACTIONS.map((name) => [name, "terminal"] as const),
  ...NEUTRAL_ACTIONS.map((name) => [name, "neutral"] as const),
  ...NON_V11_ACTIONS.map((name) => [name, "non-v11"] as const),
]);

/** Uppercase, underscore-separated, at most 64 characters. */
export const ACTION_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export function classifyAction(action: string): ActionClass {
  if (isBlockingAction(action)) return "blocking";
  if (action.startsWith("DRY_RUN")) return "non-v11";
  return CLASSIFICATION.get(action) ?? "unknown";
}
