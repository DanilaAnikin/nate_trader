import { describe, expect, it } from "vitest";
import { parseStatusError, scopeStatusState, statusUrl } from "./scope";
import type { StrategyStatusPayload } from "./types";

const ACCOUNT_A = { id: "a", nickname: "Paper A", mode: "paper" as const };
const ACCOUNT_B = { id: "b", nickname: "Paper B", mode: "paper" as const };

function payloadFor(account: typeof ACCOUNT_A): StrategyStatusPayload {
  return {
    accountId: account.id,
    accountNickname: account.nickname,
    accountMode: account.mode,
  } as StrategyStatusPayload;
}

describe("scopeStatusState", () => {
  it("shows nothing when the account backend is off", () => {
    expect(
      scopeStatusState({
        enabled: false,
        selectedAccount: ACCOUNT_A,
        requestAccountId: "a",
        status: "ready",
        data: payloadFor(ACCOUNT_A),
        error: null,
      }),
    ).toEqual({ status: "disabled", data: null, error: null });
  });

  it("shows nothing when no account is selected", () => {
    expect(
      scopeStatusState({
        enabled: true,
        selectedAccount: null,
        requestAccountId: null,
        status: "ready",
        data: payloadFor(ACCOUNT_A),
        error: null,
      }).status,
    ).toBe("no-account");
  });

  it("hides account A's data while a request for B is in flight", () => {
    const scoped = scopeStatusState({
      enabled: true,
      selectedAccount: ACCOUNT_B,
      requestAccountId: "a",
      status: "ready",
      data: payloadFor(ACCOUNT_A),
      error: null,
    });
    expect(scoped.status).toBe("loading");
    expect(scoped.data).toBeNull();
  });

  it("never publishes a payload whose identity does not match the selection", () => {
    const scoped = scopeStatusState({
      enabled: true,
      selectedAccount: ACCOUNT_B,
      requestAccountId: "b",
      status: "ready",
      data: payloadFor(ACCOUNT_A),
      error: null,
    });
    expect(scoped.status).toBe("loading");
    expect(scoped.data).toBeNull();
  });

  it("rejects a payload whose nickname or mode drifted", () => {
    const mismatched = {
      ...payloadFor(ACCOUNT_B),
      accountMode: "live",
    } as StrategyStatusPayload;
    expect(
      scopeStatusState({
        enabled: true,
        selectedAccount: ACCOUNT_B,
        requestAccountId: "b",
        status: "ready",
        data: mismatched,
        error: null,
      }).data,
    ).toBeNull();
  });

  it("publishes a matching payload", () => {
    const data = payloadFor(ACCOUNT_B);
    expect(
      scopeStatusState({
        enabled: true,
        selectedAccount: ACCOUNT_B,
        requestAccountId: "b",
        status: "ready",
        data,
        error: null,
      }),
    ).toEqual({ status: "ready", data, error: null });
  });

  it("keeps an error visible for the account it belongs to", () => {
    const error = { code: "REQUEST_FAILED", message: "boom" };
    expect(
      scopeStatusState({
        enabled: true,
        selectedAccount: ACCOUNT_B,
        requestAccountId: "b",
        status: "error",
        data: null,
        error,
      }),
    ).toEqual({ status: "error", data: null, error });
  });
});

describe("statusUrl", () => {
  it("encodes the account id", () => {
    expect(statusUrl({ id: "a/b", nickname: "n", mode: "paper" })).toBe(
      "/api/accounts/a%2Fb/status",
    );
    expect(statusUrl(null)).toBeNull();
  });
});

describe("parseStatusError", () => {
  it("accepts a known error envelope", () => {
    expect(
      parseStatusError(404, {
        code: "ACCOUNT_NOT_FOUND",
        error: "Account not found.",
      }),
    ).toEqual({ code: "ACCOUNT_NOT_FOUND", message: "Account not found." });
  });

  it("falls back safely for unknown bodies", () => {
    expect(parseStatusError(401, null).code).toBe("UNAUTHENTICATED");
    expect(parseStatusError(500, { code: "WEIRD", error: "x" }).code).toBe(
      "REQUEST_FAILED",
    );
  });
});
