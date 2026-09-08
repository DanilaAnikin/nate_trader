import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBenchmarkBars } from "./broker";

/**
 * The benchmark series anchors the forward-performance panel against a recorded
 * epoch close, so it has to be read from the consolidated tape.
 *
 * `iex` is one exchange and prints its own daily bar: SPY's 2026-08-11 close was
 * 770.52 on iex against 770.56 on sip. The baseline records the consolidated
 * value, and four cents exceeds the anchor tolerance — an iex read makes the
 * panel refuse with BASELINE_OBSERVATION_MISMATCH. This test exists so that
 * regression cannot come back silently.
 */
describe("fetchBenchmarkBars feed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function capturedQuery(): Promise<URLSearchParams> {
    let seen: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen = url;
        return {
          ok: true,
          json: async () => ({ bars: [], next_page_token: null }),
        } as unknown as Response;
      }),
    );
    await fetchBenchmarkBars(
      { apiKey: "k", apiSecret: "s" },
      "SPY",
      "2026-08-11",
    );
    expect(seen).not.toBeNull();
    return new URL(seen as unknown as string).searchParams;
  }

  it("requests the consolidated tape, never a single venue", async () => {
    const query = await capturedQuery();
    expect(query.get("feed")).toBe("sip");
    expect(query.get("feed")).not.toBe("iex");
  });

  it("requests fully adjusted daily bars", async () => {
    const query = await capturedQuery();
    expect(query.get("timeframe")).toBe("1Day");
    expect(query.get("adjustment")).toBe("all");
  });
});
