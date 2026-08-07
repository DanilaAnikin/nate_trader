/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OperationsClient from "./OperationsClient";
import SignalsClient from "./SignalsClient";
import ValidationResearchClient from "./ValidationResearchClient";
import StatusProvider from "./status/StatusProvider";
import { parseTournament, parseValidation } from "@/lib/status/parse";
import { provenance, section, unavailable } from "@/lib/status/vocab";
import type { StrategyStatusPayload, ValidationInfo } from "@/lib/status/types";
import { buildPayload } from "@/test/payload-builder";
import {
  APPROVED_SHA,
  DASHBOARD_SHA,
  tournamentJson,
  validationJson,
} from "@/test/fixtures";

const ACCOUNT = { id: "acc-1", nickname: "Paper prod", mode: "paper" as const };

function renderWithStatus(
  ui: React.ReactElement,
  payload: StrategyStatusPayload = buildPayload(),
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
  );
  return render(
    <StatusProvider enabled selectedAccount={ACCOUNT}>
      {ui}
    </StatusProvider>,
  );
}

describe("SignalsClient", () => {
  it("shows the universe source, count and hash", async () => {
    renderWithStatus(<SignalsClient />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Ranking universe" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("WATCHLIST FALLBACK")).toBeInTheDocument();
    // Shown both as the universe fact and as the first funnel step.
    expect(screen.getAllByText("540").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "c86dc489c62625cd380dae6c105e28ee3dbe9aa124363b4dcd1a9f932bafa074",
      ),
    ).toBeInTheDocument();
  });

  it("reports every unpersisted filter stage as UNAVAILABLE, never as zero", async () => {
    renderWithStatus(<SignalsClient />);
    const funnel = await screen.findByRole("table", {
      name: /Per-filter eligibility funnel/,
    });
    const rows = within(funnel).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(within(row).getByText("UNAVAILABLE")).toBeInTheDocument();
      expect(within(row).queryByText("0")).not.toBeInTheDocument();
    }
    expect(
      screen.getByText(/Reimplementing the V11 ranking in the browser/),
    ).toBeInTheDocument();
  });

  it("keeps retired V10 signals out of the active trading UI", async () => {
    renderWithStatus(<SignalsClient />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Ranking universe" }),
      ).toBeInTheDocument(),
    );
    const text = document.body.textContent ?? "";
    // Only the explicit "retired" explanation may mention them.
    expect(text).toContain("Retired V10 screener signals");
    expect(text).toContain("not used by V11");
    expect(text).not.toMatch(/most active list\b/i);
    expect(text).not.toMatch(/top gainers|top losers/i);
  });
});

describe("ValidationResearchClient", () => {
  function payloadWithEvidence(): StrategyStatusPayload {
    const base = buildPayload();
    const parsed = parseValidation(validationJson(), APPROVED_SHA)!;
    const validation: ValidationInfo = {
      ...parsed,
      identityMatchesRuntime: "PASS",
      universeMatchesRuntime: "PASS",
    };
    return buildPayload({
      validation: section(base.validation.provenance, validation),
      tournament: section(
        base.tournament.provenance,
        parseTournament(tournamentJson(), "main")!,
      ),
    });
  }

  it("separates development from the reused temporal check", async () => {
    renderWithStatus(<ValidationResearchClient />, payloadWithEvidence());
    await waitFor(() =>
      expect(screen.getByText("Canonical V11 validation")).toBeInTheDocument(),
    );
    expect(
      screen.getAllByText(/DEVELOPMENT \/ model-building period/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/REUSED TEMPORAL CHECK/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText("NOT FRESH OOS")).toBeInTheDocument();
  });

  it("keeps the canonical validator and the tournament visibly separate", async () => {
    renderWithStatus(<ValidationResearchClient />, payloadWithEvidence());
    await waitFor(() =>
      expect(
        screen.getByText("Strategy tournament — epoch 1"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("RETAIN_V11")).toBeInTheDocument();
    expect(
      screen.getByText(/must not be combined/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A separate, pre-registered research experiment/),
    ).toBeInTheDocument();
  });

  it("states the survivorship and reused-period limitations", async () => {
    renderWithStatus(<ValidationResearchClient />, payloadWithEvidence());
    await waitFor(() =>
      expect(
        screen.getByText(/Limitations that must accompany these metrics/),
      ).toBeInTheDocument(),
    );
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/survivorship/i);
    expect(text).toMatch(/not fresh out-of-sample/i);
    expect(text).toMatch(/authorizes forward/i);
  });

  it("shows an expired report as EXPIRED rather than PASS", async () => {
    const base = payloadWithEvidence();
    renderWithStatus(
      <ValidationResearchClient />,
      buildPayload({
        validation: section(
          provenance({
            source: base.validation.provenance.source,
            scope: base.validation.provenance.scope,
            asOf: base.validation.provenance.asOf,
            freshness: "EXPIRED",
            detail: "past its 35-day freshness deadline",
          }),
          base.validation.data,
        ),
        tournament: base.tournament,
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByText("EXPIRED").length).toBeGreaterThan(0),
    );
  });

  it("shows UNAVAILABLE when the tournament evidence cannot be read", async () => {
    renderWithStatus(
      <ValidationResearchClient />,
      buildPayload({
        tournament: unavailable(
          "repository state/backtest/strategy_tournament_epoch_1.json",
          "frozen epoch-1 research evidence",
          "the tournament evidence could not be read",
        ),
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Tournament evidence unavailable"),
      ).toBeInTheDocument(),
    );
  });
});

describe("OperationsClient", () => {
  it("shows the four SHA scopes separately", async () => {
    renderWithStatus(<OperationsClient />);
    await waitFor(() =>
      expect(screen.getByText("Release identity and gates")).toBeInTheDocument(),
    );
    expect(screen.getByText("Dashboard build SHA")).toBeInTheDocument();
    expect(
      screen.getByText(/Repository \/ research SHA/),
    ).toBeInTheDocument();
    expect(screen.getByText("Approved paper release SHA")).toBeInTheDocument();
    expect(screen.getByText("Latest scheduled trigger SHA")).toBeInTheDocument();
    expect(screen.getByText(DASHBOARD_SHA.slice(0, 12))).toBeInTheDocument();
    // The approved SHA appears in the identity panel and on the executed cycle.
    expect(screen.getAllByText(APPROVED_SHA.slice(0, 12)).length).toBeGreaterThan(
      0,
    );
  });

  it("treats a dashboard/executor SHA difference as expected, not as a failure", async () => {
    renderWithStatus(<OperationsClient />);
    await waitFor(() =>
      expect(
        screen.getByText("DIFFERENT COMMIT (EXPECTED)"),
      ).toBeInTheDocument(),
    );
  });

  it("offers no execute, cancel, approve or emergency control", async () => {
    renderWithStatus(<OperationsClient />);
    await waitFor(() =>
      expect(screen.getByText("Release identity and gates")).toBeInTheDocument(),
    );
    for (const button of screen.queryAllByRole("button")) {
      expect(button.textContent ?? "").not.toMatch(
        /execute|cancel|buy|sell|approve|liquidate|emergency|run now/i,
      );
    }
    expect(
      screen.getByText(/Why there are no controls here/),
    ).toBeInTheDocument();
  });

  it("links to the exact Actions run instead of embedding a trigger", async () => {
    renderWithStatus(<OperationsClient />);
    const link = await screen.findByRole("link", { name: "run" });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/x/y/actions/runs/2",
    );
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
