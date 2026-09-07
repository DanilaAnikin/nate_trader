import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBenchmarkBars } from "./broker";

/**
 * The benchmark series must come from the consolidated tape.
 *
 * This read `feed=iex` — a single exchange with a small share of volume, whose
 * daily bar is built from its own prints. Measured on the production account
 * for 2026-08-11: iex 770.52, sip 770.56. Four cents is larger than the epoch
 * baseline's anchor tolerance, so the forward-performance panel refused with
 * BASELINE_OBSERVATION_MISMATCH and stayed dead, and every benchmark return it
 * would have computed came from one venue's prints rather than the published
 * series.
 */
describe("benchmark bars come from the consolidated tape", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureQuery() {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ bars: [], next_page_token: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return seen;
  }

  it("requests feed=sip, never a single venue", async () => {
    const seen = captureQuery();
    await fetchBenchmarkBars({ apiKey: "k", apiSecret: "s" }, "SPY", "2026-08-11");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain("feed=sip");
    expect(seen[0]).not.toContain("feed=iex");
  });

  it("still asks for split and dividend adjusted daily bars", async () => {
    const seen = captureQuery();
    await fetchBenchmarkBars({ apiKey: "k", apiSecret: "s" }, "SPY", "2026-08-11");
    expect(seen[0]).toContain("timeframe=1Day");
    expect(seen[0]).toContain("adjustment=all");
  });
});
