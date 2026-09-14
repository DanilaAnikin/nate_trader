/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildPayload } from "@/test/payload-builder";
import type { CycleOutcome } from "@/lib/status/cycle-outcome";
import { CycleOutcomeSummary, SnapshotIntegrity } from "./CycleOutcomeSummary";

describe("recorded cycle outcome", () => {
  it.each([
    [{ state: "completed", reason: "rebalance_complete" }, "Completed"],
    [{ state: "idle", reason: "no_rebalance_due" }, "Intentionally idle"],
    [{ state: "pending", reason: "orders_pending" }, "Pending reconciliation"],
    [{ state: "blocked", reason: "execution_error" }, "Blocked"],
    [{ state: "failed", reason: "snapshot_unavailable" }, "Error"],
  ] as const)("renders %s as %s", (cycleOutcome, label) => {
    render(<CycleOutcomeSummary execution={{ ...buildPayload().execution.data!, cycleOutcome: cycleOutcome as CycleOutcome }} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    if (cycleOutcome.state !== "completed") expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    if (cycleOutcome.state === "pending") expect(screen.getByText(/Submission does not prove a fill/)).toBeInTheDocument();
  });

  it("does not translate legacy PASS into completed, idle or a fill", () => {
    render(<CycleOutcomeSummary execution={buildPayload().execution.data!} />);
    expect(screen.getByText("Outcome not recorded")).toBeInTheDocument();
    expect(screen.getByText(/Completion or fills cannot be inferred from PASS/)).toBeInTheDocument();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
  });

  it("distinguishes verified recovery from a fresh observation", () => {
    render(<SnapshotIntegrity execution={{ ...buildPayload().execution.data!, runtimeGeneration: "RECOVERY" }} />);
    expect(screen.getByText(/retained history, not a fresh broker observation/)).toBeInTheDocument();
  });
});
