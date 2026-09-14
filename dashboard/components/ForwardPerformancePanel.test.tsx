/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PerformanceResponse, PerformanceUnavailableReason } from "@/app/api/accounts/[id]/performance/route";
import ForwardPerformancePanel from "./ForwardPerformancePanel";

const context = vi.hoisted(() => ({ mode: "live" as "live" | "paper", reason: "NOT_PRODUCTION_VIEWER" as PerformanceUnavailableReason }));
vi.mock("./status/StatusProvider", () => ({
  useStrategyStatus: () => ({
    selectedAccount: { id: "account", mode: context.mode },
    performance: {
      kind: "ready",
      body: {
        accountId: "account", refreshedAt: "2026-09-14T12:00:00Z",
        status: "UNAVAILABLE", reason: context.reason,
        detail: "Verified reason supplied by the account API.",
        baseline: null, performance: null,
        provenance: { source: "Account performance", scope: "selected account", asOf: null, freshness: "UNAVAILABLE" },
      } satisfies PerformanceResponse,
    },
  }),
}));

describe("forward performance unavailable explanations", () => {
  it.each(["live", "paper"] as const)("keeps an observer %s account separate without inventing history", (mode) => {
    context.mode = mode;
    context.reason = "NOT_PRODUCTION_VIEWER";
    const { container } = render(<ForwardPerformancePanel />);
    expect(screen.getByText(/performance is not available for this account/)).toBeInTheDocument();
    expect(screen.getByText("Verified reason supplied by the account API.")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/V10|TQQQ|UPRO|Record an epoch|starting equity|0\.00%/);
    if (mode === "live") expect(screen.getByText(/does not start a strategy performance record or enable trading/)).toBeInTheDocument();
  });

  it("does not ask a new live account to create or reset a baseline", () => {
    context.mode = "live";
    context.reason = "NO_BASELINE";
    const { container } = render(<ForwardPerformancePanel />);
    expect(screen.getByText("No verified live performance window")).toBeInTheDocument();
    expect(screen.getByText(/Connecting or funding an account alone does not establish that window/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/V10|TQQQ|UPRO|Record an epoch|Create|Reset|\$1,000/);
  });

  it.each([
    ["NO_COMMON_SESSIONS", "Not enough shared performance observations"],
    ["BASELINE_RELEASE_MISMATCH", "Performance reference could not be verified"],
    ["APPROVED_RELEASE_UNKNOWN", "Performance release could not be verified"],
    ["NO_CREDENTIALS", "Account connection is unavailable"],
    ["EQUITY_QUERY_FAILED", "Forward performance unavailable"],
  ] as const)("explains %s without prescribing a new baseline", (reason, title) => {
    context.reason = reason;
    context.mode = "paper";
    const { container } = render(<ForwardPerformancePanel />);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Record an epoch|baseline not persisted|V10|TQQQ|UPRO/);
  });
});
