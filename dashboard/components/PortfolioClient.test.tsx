/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PortfolioClient from "./PortfolioClient";
import StatusProvider from "./status/StatusProvider";
import { buildConvergence } from "@/lib/status/convergence";
import { parseFrozenPlan } from "@/lib/status/parse";
import { provenance, section, unavailable } from "@/lib/status/vocab";
import type {
  BrokerInfo,
  BrokerPosition,
  FrozenPlanInfo,
  StrategyStatusPayload,
} from "@/lib/status/types";
import { buildPayload } from "@/test/payload-builder";
import { frozenPlanJson, TARGET_SYMBOLS } from "@/test/fixtures";

const ACCOUNT = { id: "acc-1", nickname: "Paper prod", mode: "paper" as const };

function position(symbol: string, marketValue: number): BrokerPosition {
  return {
    symbol,
    qty: 100,
    avgEntryPrice: marketValue / 100,
    currentPrice: marketValue / 100,
    marketValue,
    unrealizedPl: 1234.5,
    unrealizedPlPct: 1.5,
    side: "long",
  };
}

function broker(positions: BrokerPosition[]): BrokerInfo {
  const gross = positions.reduce((sum, p) => sum + p.marketValue, 0);
  return {
    equity: 1_000_000,
    cash: 1_000_000 - gross,
    cashPct: ((1_000_000 - gross) / 1_000_000) * 100,
    dailyPnl: 0,
    dailyPnlPct: 0,
    grossExposure: gross,
    grossExposurePct: gross / 10_000,
    positionCount: positions.length,
    positions,
    shortSymbols: [],
  };
}

function payloadWithBook(
  positions: BrokerPosition[],
  options: { bound?: boolean; planOverrides?: Record<string, unknown> } = {},
): StrategyStatusPayload {
  const { bound = true, planOverrides = { order_attempts: {} } } = options;
  const base = buildPayload();
  const plan = parseFrozenPlan(
    frozenPlanJson(planOverrides),
  ) as FrozenPlanInfo;
  const snapshot = broker(positions);

  return buildPayload({
    accountBinding: section(base.accountBinding.provenance, {
      ...base.accountBinding.data!,
      role: bound ? "PRODUCTION_CONTROLLED_PAPER" : "OBSERVER_ONLY_PAPER",
      productionBound: bound,
      bindingProof: bound
        ? ("server-authorized-production-owner-and-account" as const)
        : null,
      bindingDetail: bound
        ? "Signed-in production owner and configured production account match."
        : "This paper account does not match the server-configured production executor account.",
    }),
    broker: section(base.broker.provenance, snapshot),
    strategy: section(base.strategy.provenance, {
      ...base.strategy.data!,
      plan,
    }),
    convergence: bound
      ? section(
          provenance({
            source: "frozen V11 plan (runtime artifact) + fresh broker snapshot",
            scope: "frozen plan vs Paper prod",
            asOf: "2026-08-07T17:00:00Z",
            freshness: "CURRENT",
          }),
          buildConvergence(plan, snapshot),
        )
      : unavailable(
          "frozen V11 plan + broker snapshot",
          "frozen plan vs Paper prod",
          "this account is not proven to be the production executor account",
          "NOT_APPLICABLE",
        ),
  });
}

function renderPortfolio(payload: StrategyStatusPayload) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
  );
  return render(
    <StatusProvider enabled selectedAccount={ACCOUNT}>
      <PortfolioClient />
    </StatusProvider>,
  );
}

describe("PortfolioClient", () => {
  it("shows actual, target, delta, sector and lifecycle per symbol", async () => {
    renderPortfolio(
      payloadWithBook(TARGET_SYMBOLS.map((symbol) => position(symbol, 45_000))),
    );
    await waitFor(() =>
      expect(screen.getByText("Holdings and V11 targets")).toBeInTheDocument(),
    );

    const table = screen.getByRole("table", {
      name: /Actual holdings against V11 target weights/,
    });
    expect(
      within(table).getByRole("columnheader", { name: "V11 target %" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "Target sector" }),
    ).toBeInTheDocument();

    const asmlRow = within(table).getByRole("row", { name: /ASML/ });
    expect(within(asmlRow).getByText("TARGET")).toBeInTheDocument();
    expect(within(asmlRow).getByText("CONVERGED")).toBeInTheDocument();
    expect(within(asmlRow).getByText("Technology")).toBeInTheDocument();
  });

  it("keeps a real TQQQ/UPRO legacy holding visible with a zero V11 target", async () => {
    renderPortfolio(
      payloadWithBook([
        ...TARGET_SYMBOLS.map((symbol) => position(symbol, 40_000)),
        position("TQQQ", 60_000),
        position("UPRO", 25_000),
      ]),
    );
    await waitFor(() =>
      expect(screen.getByText("Holdings and V11 targets")).toBeInTheDocument(),
    );
    const table = screen.getByRole("table", {
      name: /Actual holdings against V11 target weights/,
    });

    for (const symbol of ["TQQQ", "UPRO"]) {
      const row = within(table).getByRole("row", { name: new RegExp(symbol) });
      expect(within(row).getByText("LEGACY/EXCLUDED")).toBeInTheDocument();
      expect(within(row).getByText("EXIT")).toBeInTheDocument();
      expect(within(row).getByText("0.00%")).toBeInTheDocument();
    }
  });

  it("labels a nine-of-ten book as an outstanding BUY, not a breach", async () => {
    const held = TARGET_SYMBOLS.filter((symbol) => symbol !== "UNH");
    renderPortfolio(
      payloadWithBook(held.map((symbol) => position(symbol, 45_000))),
    );
    await waitFor(() =>
      expect(screen.getByText("Holdings and V11 targets")).toBeInTheDocument(),
    );
    const table = screen.getByRole("table", {
      name: /Actual holdings against V11 target weights/,
    });
    const unh = within(table).getByRole("row", { name: /UNH/ });
    expect(within(unh).getByText("BUY")).toBeInTheDocument();
    expect(within(unh).getByText("TARGET")).toBeInTheDocument();
  });

  it("shows submitted order intents as PENDING without any identifiers", async () => {
    renderPortfolio(
      payloadWithBook(
        TARGET_SYMBOLS.map((symbol) => position(symbol, 45_000)),
        { planOverrides: {} },
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Order intents recorded in the frozen plan"),
      ).toBeInTheDocument(),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Submitted is not filled");
    expect(text).not.toContain("58371aed-250a-40c7-b883-a62c538100b1");
    expect(text).not.toContain("nt-adaptive-asml-sell");
  });

  it("marks target columns NOT APPLICABLE for an unbound observer account", async () => {
    renderPortfolio(
      payloadWithBook(
        TARGET_SYMBOLS.map((symbol) => position(symbol, 45_000)),
        { bound: false },
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("Holdings and V11 targets")).toBeInTheDocument(),
    );
    const table = screen.getByRole("table", {
      name: /Actual holdings against V11 target weights/,
    });
    const asml = within(table).getByRole("row", { name: /ASML/ });
    expect(within(asml).getAllByText("NOT APPLICABLE").length).toBeGreaterThan(0);
    // Actual broker facts remain fully visible.
    expect(within(asml).getByText("$45,000.00")).toBeInTheDocument();
  });

  it("states the construction rules without inventing stops or a 15-name cap", async () => {
    renderPortfolio(
      payloadWithBook(TARGET_SYMBOLS.map((symbol) => position(symbol, 45_000))),
    );
    await waitFor(() =>
      expect(screen.getByText("Frozen V11 plan")).toBeInTheDocument(),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("target-construction");
    expect(text).toContain("no fixed per-position stop-loss");
    expect(text).not.toMatch(/max 15/i);
    expect(text).not.toMatch(/stop 8%/i);
  });

  it("reports a risk-off cash book as a decision, not as missing data", async () => {
    renderPortfolio(
      payloadWithBook([], {
        planOverrides: {
          risk_off: true,
          target_weights: {},
          sector_by_symbol: {},
          order_attempts: {},
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("No positions — SPY risk-off target is zero"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/actual broker snapshot, not missing data/),
    ).toBeInTheDocument();
  });
});
