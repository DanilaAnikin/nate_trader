/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import StatusProvider from "./StatusProvider";
import SystemStatusBar from "./SystemStatusBar";
import { provenance, section } from "@/lib/status/vocab";
import { buildPayload } from "@/test/payload-builder";
import type { StrategyStatusPayload } from "@/lib/status/types";

const ACCOUNT = { id: "acc-1", nickname: "Paper prod", mode: "paper" as const };

function renderBar(payload: StrategyStatusPayload = buildPayload()) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
  );
  return render(
    <StatusProvider enabled selectedAccount={ACCOUNT}>
      <SystemStatusBar />
    </StatusProvider>,
  );
}

describe("SystemStatusBar", () => {
  it("names five independent subsystems instead of one aggregate dot", async () => {
    renderBar();
    await waitFor(() => expect(screen.getByText("Web")).toBeInTheDocument());
    for (const label of ["Web", "Broker", "V11 runtime", "Scheduler", "Validation"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText(/Dashboard Online/i)).not.toBeInTheDocument();
  });

  it("shows a fresh broker beside a stale runtime rather than one merged state", async () => {
    const base = buildPayload();
    renderBar(
      buildPayload({
        strategy: section(
          provenance({
            source: base.strategy.provenance.source,
            scope: base.strategy.provenance.scope,
            asOf: "2026-08-01T16:05:05Z",
            now: Date.parse("2026-08-07T17:00:00Z"),
            freshness: "STALE",
            detail: "older than its 36-hour contract",
          }),
          base.strategy.data,
        ),
      }),
    );
    await waitFor(() => expect(screen.getByText("Broker")).toBeInTheDocument());
    expect(screen.getByText("CURRENT")).toBeInTheDocument();
    expect(screen.getByText("STALE")).toBeInTheDocument();
  });

  it("never claims ONLINE or LIVE without a source", async () => {
    renderBar();
    await waitFor(() => expect(screen.getByText("Web")).toBeInTheDocument());
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\bONLINE\b/);
    expect(text).not.toMatch(/\bLIVE\b/);
  });

  it("reports an unavailable status region rather than an empty green bar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(
      <StatusProvider enabled selectedAccount={ACCOUNT}>
        <SystemStatusBar />
      </StatusProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("STATUS UNAVAILABLE")).toBeInTheDocument(),
    );
  });

  it("exposes the status region to assistive technology", async () => {
    renderBar();
    const region = await screen.findByRole("status", { name: "System status" });
    expect(region).toHaveAttribute("aria-live", "polite");
  });
});
