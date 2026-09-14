import type { StrategyStatusPayload } from "./types";

/** An observation about received records, never a trading-calendar verdict. */
export function paperCadenceNotice(payload: StrategyStatusPayload): { pending: boolean; detail: string } | null {
  if (payload.accountMode !== "paper" || !payload.authorization.data?.productionRuntimeAuthorized) return null;
  const now = new Date(payload.collectedAt);
  if (!Number.isFinite(now.getTime()) || now.getUTCDay() === 0 || now.getUTCDay() === 6 ||
    now.getUTCHours() * 60 + now.getUTCMinutes() < 15 * 60 + 35) return null;
  const today = now.toISOString().slice(0, 10);
  const observedToday = (stamp: string | null | undefined) => {
    const date = new Date(stamp ?? "");
    return Number.isFinite(date.getTime()) && date.getTime() <= now.getTime() + 5 * 60 * 1000 && date.toISOString().slice(0, 10) === today;
  };
  if (observedToday(payload.execution.data?.completedAt)) return null;
  const attempt = payload.operations.data?.latestAttempt;
  if (attempt && attempt.status !== "completed" && observedToday(attempt.startedAt)) {
    return { pending: true, detail: "Today's paper workflow is in progress. Its executor record is not available yet." };
  }
  return { pending: false, detail: "No paper executor record is available for today. The weekday workflow is scheduled for 15:05 UTC; it may be delayed, blocked or still awaiting a published runtime. Check the latest workflow attempt below." };
}
