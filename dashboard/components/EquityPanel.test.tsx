/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EquityPanel from "./EquityPanel";
import StatusProvider from "./status/StatusProvider";
import { buildPayload } from "@/test/payload-builder";

const ACCOUNT = { id: "acc-1", nickname: "1m paper", mode: "paper" as const };

function stubFetch(equityResponse: { body: unknown; status?: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/equity")) {
        return new Response(JSON.stringify(equityResponse.body), {
          status: equityResponse.status ?? 200,
        });
      }
      if (url.includes("/performance")) {
        return new Response(JSON.stringify({ accountId: "acc-1", status: "UNAVAILABLE" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(buildPayload()), { status: 200 });
    }),
  );
}

function renderPanel() {
  return render(
    <StatusProvider enabled selectedAccount={ACCOUNT}>
      <EquityPanel />
    </StatusProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EquityPanel", () => {
  it("draws the curve and labels it broker accounting, not V11 alpha", async () => {
    stubFetch({
      body: {
        accountId: "acc-1",
        capturedAt: "2026-08-20T20:00:00Z",
        snapshots: [
          { date: "2026-08-01", equity: 800000, cash: 400000, pnl: 0, pnl_pct: 0, num_positions: 10 },
          { date: "2026-08-20", equity: 896108, cash: 482975, pnl: 1200, pnl_pct: 0.13, num_positions: 10 },
        ],
        cashFlows: [],
      },
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("Account equity curve")).toBeInTheDocument(),
    );
    expect(screen.getByText("Latest equity")).toBeInTheDocument();
    // The honesty guard: the curve is never presented as V11 forward alpha.
    // (The phrase appears in both the subtitle and the disclosure — either is fine.)
    expect(
      screen.getAllByText(/not.*V11 forward alpha|broker accounting/i).length,
    ).toBeGreaterThan(0);
  });

  it("shows a graceful unavailable state when the curve cannot be loaded", async () => {
    stubFetch({ body: { error: "boom" }, status: 500 });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText("Equity curve unavailable")).toBeInTheDocument(),
    );
  });

  it("does not draw a curve from a single point", async () => {
    stubFetch({
      body: {
        accountId: "acc-1",
        capturedAt: null,
        snapshots: [
          { date: "2026-08-20", equity: 896108, cash: 482975, pnl: 0, pnl_pct: 0, num_positions: 10 },
        ],
        cashFlows: [],
      },
    });
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText("Not enough history to draw a curve"),
      ).toBeInTheDocument(),
    );
  });
});
