import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchStateFile } from "./github";

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchStateFile", () => {
  it("parses the raw JSON body (no base64 envelope)", async () => {
    const fn = mockFetch(
      () => new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );
    const data = await fetchStateFile<{ hello: string }>("performance.json");
    expect(data).toEqual({ hello: "world" });

    // Must request the raw media type so files >1 MB (e.g. research.json) are
    // returned in full rather than truncated to an empty base64 content field.
    const [, init] = fn.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github.raw");
  });

  it("handles a >1 MB payload that the base64 path would have dropped", async () => {
    const big = { symbols: Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [
        `SYM${i}`,
        { score: i, note: "x".repeat(240) },
      ]),
    ) };
    const body = JSON.stringify(big);
    expect(body.length).toBeGreaterThan(1_048_576);
    mockFetch(() => new Response(body, { status: 200 }));
    const data = await fetchStateFile<typeof big>("research.json");
    expect(Object.keys(data?.symbols ?? {})).toHaveLength(5000);
  });

  it("returns null on a non-ok response", async () => {
    mockFetch(() => new Response("not found", { status: 404 }));
    expect(await fetchStateFile("missing.json")).toBeNull();
  });

  it("returns null on invalid JSON instead of throwing", async () => {
    mockFetch(() => new Response("{not json", { status: 200 }));
    expect(await fetchStateFile("broken.json")).toBeNull();
  });
});
