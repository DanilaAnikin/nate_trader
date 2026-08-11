/**
 * Placing a runtime artifact in time.
 *
 * `parsePerformanceRuntime` establishes that `performance.json` is internally
 * consistent — a non-empty history, a last session matching the ET date of its
 * own timestamp, a last equity matching the scalar equity. That is everything
 * the document can prove about itself.
 *
 * It cannot prove *when* it was written, and that is the question the gate
 * needs answered: an artifact restored from a previous cycle parses exactly as
 * well as the one this cycle produced. So the timestamp is checked against
 * three external references — the run record it travelled with, the workflow
 * step that wrote it, and this server's clock.
 */

import { parseRfc3339 } from "@/lib/calendar-date";
import type { PerformanceRuntimeSnapshot } from "./parse";

export type PerformanceCoherenceProblem =
  /** `performance.updated_at` is unreadable. */
  | "PERFORMANCE_UPDATED_AT_INVALID"
  /** The execute step's own window could not be established. */
  | "EXECUTE_STEP_WINDOW_UNKNOWN"
  /** The stamp lies outside the step that was supposed to produce it. */
  | "PERFORMANCE_OUTSIDE_STEP_WINDOW"
  /** The stamp is later than the run summary written after it. */
  | "PERFORMANCE_AFTER_RUN"
  /** The stamp is ahead of this server's clock beyond any skew allowance. */
  | "PERFORMANCE_IN_FUTURE";

/**
 * How far a producer's clock may sit ahead of this server's.
 *
 * Both are NTP-disciplined; five minutes is far more than the observed skew
 * and far less than the interval that would let yesterday's file pass.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * How far `performance.updated_at` may sit *after* `last_run.completed_at`.
 *
 * `production_run.main` calls `update_performance_state()` and only then
 * builds the summary, so performance is written first and the ordering is
 * strict. A few seconds of tolerance absorbs a coarse clock without admitting
 * a file from a different cycle.
 */
const WRITE_ORDER_TOLERANCE_MS = 5 * 1000;

/**
 * How far outside the step window the stamp may fall.
 *
 * The step timestamps come from the GitHub API at second granularity and are
 * recorded by a different process than the one writing the file.
 */
const STEP_WINDOW_SLACK_MS = 60 * 1000;

export interface CycleContext {
  /** `last_run.completed_at`, already normalized, or null. */
  readonly lastRunCompletedAt: string | null;
  /** The execute step's reported window, or null when it is unknown. */
  readonly executeStep: {
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
  readonly now: Date;
}

/**
 * Everything about `performance.json` that only its surroundings can decide.
 * An empty array means the document belongs to the cycle it was found in.
 */
export function assessPerformanceCoherence(
  performance: PerformanceRuntimeSnapshot,
  context: CycleContext,
): PerformanceCoherenceProblem[] {
  const problems: PerformanceCoherenceProblem[] = [];

  const updatedMs = parseRfc3339(performance.updatedAt);
  if (updatedMs === null) {
    // Nothing else can be decided without it, and the safe reading of "we do
    // not know when this was written" is that it does not authorize anything.
    return ["PERFORMANCE_UPDATED_AT_INVALID"];
  }

  if (updatedMs - context.now.getTime() > CLOCK_SKEW_TOLERANCE_MS) {
    problems.push("PERFORMANCE_IN_FUTURE");
  }

  const completedMs = parseRfc3339(context.lastRunCompletedAt);
  if (completedMs === null) {
    problems.push("PERFORMANCE_AFTER_RUN");
  } else if (updatedMs - completedMs > WRITE_ORDER_TOLERANCE_MS) {
    problems.push("PERFORMANCE_AFTER_RUN");
  }

  const startedMs = parseRfc3339(context.executeStep?.startedAt);
  const stepEndMs = parseRfc3339(context.executeStep?.completedAt);
  if (startedMs === null || stepEndMs === null || stepEndMs < startedMs) {
    problems.push("EXECUTE_STEP_WINDOW_UNKNOWN");
  } else if (
    updatedMs < startedMs - STEP_WINDOW_SLACK_MS ||
    updatedMs > stepEndMs + STEP_WINDOW_SLACK_MS
  ) {
    problems.push("PERFORMANCE_OUTSIDE_STEP_WINDOW");
  }

  return problems;
}
