import { describe, expect, it } from "vitest";
import {
  ACCOUNT_LIVE_SCHEMA_VERSION,
  ACCOUNT_LIVE_SOURCE,
  accountLiveUrl,
  formatLiveTimestamp,
  isAccountLivePayload,
  normalizeAlpacaPosition,
  parseAccountLiveError,
  scopeAccountLiveState,
  type AccountIdentity,
  type AccountLivePayload,
} from "./account-live";

const selected: AccountIdentity = {
  id: "account-a/with space",
  nickname: "Main paper",
  mode: "paper",
};

const validPayload: AccountLivePayload = {
  schemaVersion: ACCOUNT_LIVE_SCHEMA_VERSION,
  source: ACCOUNT_LIVE_SOURCE,
  accountId: selected.id,
  nickname: selected.nickname,
  mode: selected.mode,
  timestamp: "2026-08-03T12:00:00.000Z",
  account: {
    equity: 1_000_000,
    cash: 100_000,
    cash_pct: 10,
    daily_pnl: 123,
    daily_pnl_pct: 0.0123,
    num_positions: 1,
  },
  positions: [
    {
      symbol: "AAPL",
      qty: 10,
      avg_entry_price: 200,
      current_price: 201,
      market_value: 2010,
      unrealized_pl: 10,
      unrealized_plpc: 0.5,
      side: "long",
    },
  ],
};

describe("account-scoped live contract", () => {
  it("never creates a global live endpoint", () => {
    expect(accountLiveUrl(selected)).toBe(
      "/api/accounts/account-a%2Fwith%20space/live",
    );
    expect(accountLiveUrl(null)).toBeNull();
  });

  it("accepts only the selected account, mode, source, and schema", () => {
    expect(isAccountLivePayload(validPayload, selected)).toBe(true);
    expect(
      isAccountLivePayload({ ...validPayload, accountId: "account-b" }, selected),
    ).toBe(false);
    expect(
      isAccountLivePayload({ ...validPayload, mode: "live" }, selected),
    ).toBe(false);
    expect(
      isAccountLivePayload({ ...validPayload, source: "legacy" }, selected),
    ).toBe(false);
    expect(
      isAccountLivePayload({ ...validPayload, schemaVersion: 2 }, selected),
    ).toBe(false);
  });

  it("never exposes delayed account A data after switching to account B", () => {
    const accountB = { ...selected, id: "account-b", nickname: "Second paper" };
    expect(
      scopeAccountLiveState({
        enabled: true,
        selectedAccount: accountB,
        requestAccountId: selected.id,
        status: "live",
        data: validPayload,
        error: null,
      }),
    ).toEqual({ status: "loading", data: null, error: null });
  });

  it("fails closed when no account is selected", () => {
    expect(
      scopeAccountLiveState({
        enabled: true,
        selectedAccount: null,
        requestAccountId: selected.id,
        status: "live",
        data: validPayload,
        error: { code: "REQUEST_FAILED", error: "old error" },
      }),
    ).toEqual({ status: "no-account", data: null, error: null });
  });

  it("rejects malformed numeric and position data", () => {
    expect(
      isAccountLivePayload(
        {
          ...validPayload,
          account: { ...validPayload.account, equity: "1000000" },
        },
        selected,
      ),
    ).toBe(false);
    expect(
      isAccountLivePayload(
        {
          ...validPayload,
          positions: [{ ...validPayload.positions[0], side: "PositionSide.LONG" }],
        },
        selected,
      ),
    ).toBe(false);
    expect(
      isAccountLivePayload(
        {
          ...validPayload,
          timestamp: "not-a-timestamp",
        },
        selected,
      ),
    ).toBe(false);
    expect(
      isAccountLivePayload(
        {
          ...validPayload,
          account: { ...validPayload.account, num_positions: 2 },
        },
        selected,
      ),
    ).toBe(false);
  });

  it("formats ISO timestamps in the requested timezone", () => {
    expect(
      formatLiveTimestamp("2026-08-03T12:00:00.000Z", "en-GB", "UTC"),
    ).toContain("12:00:00");
    expect(formatLiveTimestamp("not-a-date", "en-GB", "UTC")).toBe(
      "Unknown time",
    );
  });

  it("normalizes Alpaca P&L fractions to percentage points exactly once", () => {
    expect(
      normalizeAlpacaPosition({
        symbol: "AAPL",
        qty: "10",
        avg_entry_price: "200",
        current_price: "203.70",
        market_value: "2037",
        unrealized_pl: "37",
        unrealized_plpc: "0.0185",
        side: "long",
      }).unrealized_plpc,
    ).toBeCloseTo(1.85);
  });

  it("preserves typed API errors and safely normalizes unknown ones", () => {
    expect(
      parseAccountLiveError(409, {
        code: "CREDENTIALS_MISSING",
        error: "No stored credentials.",
      }),
    ).toEqual({
      code: "CREDENTIALS_MISSING",
      error: "No stored credentials.",
    });
    expect(parseAccountLiveError(503, null)).toEqual({
      code: "REQUEST_FAILED",
      error: "Live account request failed (HTTP 503).",
    });
    expect(
      parseAccountLiveError(502, { code: "INVENTED", error: "untrusted" }),
    ).toEqual({
      code: "REQUEST_FAILED",
      error: "Live account request failed (HTTP 502).",
    });
  });
});
