import type { CycleReason } from "@/lib/status/cycle-outcome";
import type { ExecutionInfo } from "@/lib/status/types";
import type { CheckState } from "@/lib/status/vocab";
import { StatePill } from "./primitives";

const REASONS: Record<CycleReason, string> = {
  rebalance_complete: "The executor recorded completion of the rebalance for this cycle.",
  no_rebalance_due: "No monthly rebalance was due. The executor deliberately left the allocation unchanged.",
  orders_pending: "Orders still need broker reconciliation. Submission does not prove a fill.",
  cancellation_pending: "Order cancellations still need broker confirmation before the cycle can continue.",
  short_reconciliation: "Short-position reconciliation is still pending; ordinary allocation work must wait.",
  infrastructure_reconciliation: "Orders from retired infrastructure still need reconciliation before allocation can continue.",
  convergence_pending: "The portfolio has not yet reached the frozen target; reconciliation will continue in a later cycle.",
  exposure_gate_closed: "An entry or exposure gate prevented the planned work. This is not rebalance completion.",
  execution_incomplete: "The executor did not establish a complete result for this cycle.",
  execution_error: "An execution error blocked the cycle. Review the recorded blockers before continuing.",
  execution_exception: "The executor stopped with an error. Any orders already submitted still require reconciliation.",
  snapshot_unavailable: "A fresh broker snapshot could not be obtained. This cycle cannot establish the current portfolio state.",
  publication_failed: "The cycle's runtime state could not be published reliably. Its completion is not confirmed.",
};

const PRESENTATION = {
  completed: { label: "Completed", state: "PASS" },
  idle: { label: "Intentionally idle", state: "NOT_APPLICABLE" },
  pending: { label: "Pending reconciliation", state: "PENDING" },
  blocked: { label: "Blocked", state: "WARN" },
  failed: { label: "Error", state: "FAIL" },
} satisfies Record<string, { label: string; state: CheckState }>;

export function CycleOutcomeSummary({ execution }: { execution: ExecutionInfo }) {
  const outcome = execution.cycleOutcome;
  if (!outcome) return (
    <div className="space-y-1">
      <StatePill size="xs" state="UNAVAILABLE" label="Outcome not recorded" />
      <p className="text-xs text-secondary">This older record reports executor health and action counts, but no explicit cycle outcome. Completion or fills cannot be inferred from PASS.</p>
    </div>
  );
  const presentation = PRESENTATION[outcome.state];
  return (
    <div className="space-y-1">
      <StatePill size="xs" state={presentation.state} label={presentation.label} />
      <p className="text-xs text-secondary">{REASONS[outcome.reason]}</p>
    </div>
  );
}

export function SnapshotIntegrity({ execution }: { execution: ExecutionInfo }) {
  switch (execution.runtimeGeneration) {
    case "VERIFIED": return <>Verified snapshot generation</>;
    case "RECOVERY": return <>Verified recovery generation; snapshots are retained history, not a fresh broker observation.</>;
    case "LEGACY_UNVERIFIED": return <>Legacy record; snapshot generation was not recorded.</>;
    default: return <>Snapshot generation has not been verified.</>;
  }
}
