// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAccountEquity } from "./use-equity";

function equityBody(id: string) {
  return { accountId: id, capturedAt: null, snapshots: [], cashFlows: [] };
}

function stubFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    const id = String(url).split("/accounts/")[1]?.split("/")[0] ?? "";
    return { ok: true, json: async () => equityBody(id) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useAccountEquity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("re-fetches when refreshKey changes, so Re-read/Sync update the curve", async () => {
    const fetchMock = stubFetch();
    const { result, rerender } = renderHook(
      ({ key }) => useAccountEquity("acc-1", key),
      { initialProps: { key: "t0" } },
    );
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    const before = fetchMock.mock.calls.length;

    // A bumped key (StatusProvider.lastRefreshedAt after Re-read/Sync) must
    // trigger a fresh fetch — the whole point of the fix.
    rerender({ key: "t1" });
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("does not re-fetch when neither accountId nor refreshKey changes", async () => {
    const fetchMock = stubFetch();
    const { result, rerender } = renderHook(
      ({ key }) => useAccountEquity("acc-1", key),
      { initialProps: { key: "t0" } },
    );
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    const settled = fetchMock.mock.calls.length;

    rerender({ key: "t0" }); // identical key → stable deps → no new fetch
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock.mock.calls.length).toBe(settled);
  });
});
