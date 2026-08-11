import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAlpacaKeys } from "./credentials";

const KEY = "PKTEST1234567890";
const SECRET = "abcdefSECRET0987654321";

function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("validateAlpacaKeys", () => {
  it("accepts valid keys and returns the account number", async () => {
    mockFetch(() => new Response(JSON.stringify({ account_number: "PA123" }), { status: 200 }));
    const res = await validateAlpacaKeys("paper", KEY, SECRET);
    expect(res).toEqual({ ok: true, accountNumber: "PA123" });
  });

  it("rejects bad keys on 401", async () => {
    mockFetch(() => new Response("unauthorized", { status: 401 }));
    const res = await validateAlpacaKeys("paper", KEY, SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_keys");
  });

  it("rejects bad keys on 403", async () => {
    mockFetch(() => new Response("forbidden", { status: 403 }));
    const res = await validateAlpacaKeys("live", KEY, SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_keys");
  });

  it("reports alpaca_error on a 500", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));
    const res = await validateAlpacaKeys("paper", KEY, SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("alpaca_error");
  });

  it("reports a network error when fetch throws", async () => {
    mockFetch(() => {
      throw new Error("ENOTFOUND");
    });
    const res = await validateAlpacaKeys("paper", KEY, SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("network");
  });

  it("uses the paper base URL for paper accounts", async () => {
    const fn = mockFetch(() => new Response(JSON.stringify({ account_number: "X" }), { status: 200 }));
    await validateAlpacaKeys("paper", KEY, SECRET);
    expect(fn.mock.calls[0][0]).toBe("https://paper-api.alpaca.markets/v2/account");
  });

  it("uses the live base URL for live accounts", async () => {
    const fn = mockFetch(() => new Response(JSON.stringify({ account_number: "X" }), { status: 200 }));
    await validateAlpacaKeys("live", KEY, SECRET);
    expect(fn.mock.calls[0][0]).toBe("https://api.alpaca.markets/v2/account");
  });

  it("sends the keys as Alpaca auth headers", async () => {
    const fn = mockFetch(() => new Response(JSON.stringify({ account_number: "X" }), { status: 200 }));
    await validateAlpacaKeys("paper", KEY, SECRET);
    const headers = fn.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["APCA-API-KEY-ID"]).toBe(KEY);
    expect(headers["APCA-API-SECRET-KEY"]).toBe(SECRET);
  });

  it("never echoes key material in its result", async () => {
    mockFetch(() => new Response(JSON.stringify({ account_number: "PA123" }), { status: 200 }));
    const res = await validateAlpacaKeys("paper", KEY, SECRET);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(SECRET);
  });
});
