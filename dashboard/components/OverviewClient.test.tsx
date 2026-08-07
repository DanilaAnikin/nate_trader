/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OverviewClient from "./OverviewClient";
import StatusProvider from "./status/StatusProvider";
import { buildPayload } from "@/test/payload-builder";
import { section, unavailable } from "@/lib/status/vocab";
import type { StrategyStatusPayload } from "@/lib/status/types";

const ACCOUNT = { id: "acc-1", nickname: "Paper prod", mode: "paper" as const };

function renderOverview(
  payload: StrategyStatusPayload = buildPayload(),
  performanceBody: unknown = {
    accountId: "acc-1",
    refreshedAt: "2026-08-07T17:00:00Z",
    status: "UNAVAILABLE",
    reason: "NO_BASELINE",
    detail:
      "No auditable V11 forward-validation epoch baseline is persisted.",
    baseline: null,
    performance: null,
    warning: null,
  },
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/performance")) {
        return new Response(JSON.stringify(performanceBody), { status: 200 });
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    }),
  );
  return render(
    <StatusProvider enabled selectedAccount={ACCOUNT}>
      <OverviewClient />
    </StatusProvider>,
  );
}

describe("OverviewClient", () => {
  it("separates broker, market/risk, convergence, operations and evidence", async () => {
    renderOverview();
    await waitFor(() =>
      expect(screen.getByText(/A · Broker account/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/B · V11 market and risk state/)).toBeInTheDocument();
    expect(screen.getByText(/C · Target convergence/)).toBeInTheDocument();
    expect(screen.getByText(/D · Operations/)).toBeInTheDocument();
    expect(
      screen.getByText(/E · Forward paper-validation performance/),
    ).toBeInTheDocument();
    expect(screen.getByText(/F · Promotion evidence/)).toBeInTheDocument();
  });

  it("shows SPY close, breadth and the breadth multiplier as UNAVAILABLE, not zero", async () => {
    renderOverview();
    const spyLabel = await screen.findByText("SPY close vs SMA200");
    const spyRow = spyLabel.closest("div") as HTMLElement;
    expect(within(spyRow).getByText("UNAVAILABLE")).toBeInTheDocument();
    expect(within(spyRow).queryByText("0.00%")).not.toBeInTheDocument();
    expect(within(spyRow).queryByText("$0.00")).not.toBeInTheDocument();

    const breadthRow = screen
      .getByText("Breadth multiplier")
      .closest("div") as HTMLElement;
    expect(within(breadthRow).getByText("UNAVAILABLE")).toBeInTheDocument();
  });

  it("never renders forward performance without a persisted epoch baseline", async () => {
    renderOverview();
    await waitFor(() =>
      expect(
        screen.getByText(
          /V11 forward performance unavailable — baseline not persisted/,
        ),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/must not be relabelled as V11 performance/),
    ).toBeInTheDocument();
  });

  it("shows a broker outage without substituting repository data", async () => {
    renderOverview(
      buildPayload({
        broker: unavailable(
          "Alpaca paper REST snapshot",
          "selected account Paper prod",
          "Could not reach Alpaca for the selected account.",
        ),
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("Broker snapshot unavailable")).toBeInTheDocument(),
    );
    // The reason appears both in the empty state and in the provenance line.
    expect(
      screen.getAllByText(/Could not reach Alpaca for the selected account/)
        .length,
    ).toBeGreaterThan(0);
  });

  it("reports an infrastructure workflow failure distinctly from a strategy failure", async () => {
    const base = buildPayload();
    renderOverview(
      buildPayload({
        operations: section(base.operations.provenance, {
          ...base.operations.data!,
          latestAttempt: {
            ...base.operations.data!.latestAttempt!,
            conclusion: "failure",
            infrastructureFailure: true,
            failureKind: "infrastructure",
          },
        }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByText("INFRASTRUCTURE FAILURE")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/No strategy, preflight or broker execution happened/i),
    ).toBeInTheDocument();
    // The older successful execution is still reported.
    expect(screen.getByText("Last successful execution")).toBeInTheDocument();
  });

  it("shows the risk-tier source conflict rather than silently picking one", async () => {
    const base = buildPayload();
    renderOverview(
      buildPayload({
        strategy: section(base.strategy.provenance, {
          ...base.strategy.data!,
          riskTierConflict: true,
          executionRiskTier: {
            tier: "NORMAL",
            reason: "fresh broker snapshot",
            source: "production run record",
            asOf: "2026-08-07T16:05:05Z",
          },
          persistedRiskTier: {
            tier: "CAUTIOUS",
            reason: "mixed local daily history",
            source: "saved runtime performance.json",
            asOf: "2026-08-07T12:05:05Z",
          },
        }),
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Risk-tier source conflict/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/neither is silently preferred/)).toBeInTheDocument();
  });

  it("marks convergence NOT APPLICABLE for an unbound observer account", async () => {
    const base = buildPayload();
    renderOverview(
      buildPayload({
        accountBinding: section(base.accountBinding.provenance, {
          ...base.accountBinding.data!,
          role: "OBSERVER_ONLY_PAPER",
          productionBound: false,
          bindingProof: null,
          bindingDetail:
            "This paper account does not match the server-configured production executor account.",
        }),
        convergence: unavailable(
          "frozen V11 plan + broker snapshot",
          "frozen plan vs Paper prod",
          "this account is not proven to be the production executor account",
          "NOT_APPLICABLE",
        ),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Target compliance does not apply to this account/),
      ).toBeInTheDocument(),
    );
  });

  it("shows the promotion evidence as paper-only and not a guarantee", async () => {
    renderOverview();
    await waitFor(() =>
      expect(
        screen.getByText(/eligible for forward/, { exact: false }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/never authorizes live money/),
    ).toBeInTheDocument();
  });

  it("contains no retired V10 trading concepts", async () => {
    renderOverview();
    await waitFor(() =>
      expect(screen.getByText(/A · Broker account/)).toBeInTheDocument(),
    );
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/max 15/i);
    expect(text).not.toMatch(/stop 8/i);
    expect(text).not.toMatch(/score 65|score-65/i);
    expect(text).not.toMatch(/AI confidence/i);
    expect(text).not.toMatch(/Dashboard Online/i);
  });
});
