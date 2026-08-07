import type { StrategyStatusPayload } from "./types";
import type { StatusIdentity } from "./client";

/**
 * Account scoping for the status provider.
 *
 * Switching from account A to account B must never leave A's numbers on
 * screen. The provider therefore tracks which account a request was issued
 * for, and this pure reducer decides what may be rendered right now.
 */

export type StatusFetchStatus =
  | "disabled"
  | "no-account"
  | "loading"
  | "ready"
  | "error";

export interface StatusError {
  readonly code: string;
  readonly message: string;
}

export interface ScopedStatusState {
  readonly status: StatusFetchStatus;
  readonly data: StrategyStatusPayload | null;
  readonly error: StatusError | null;
}

export function scopeStatusState(input: {
  enabled: boolean;
  selectedAccount: StatusIdentity | null;
  requestAccountId: string | null;
  status: StatusFetchStatus;
  data: StrategyStatusPayload | null;
  error: StatusError | null;
}): ScopedStatusState {
  if (!input.enabled) return { status: "disabled", data: null, error: null };
  if (!input.selectedAccount) {
    return { status: "no-account", data: null, error: null };
  }
  if (input.requestAccountId !== input.selectedAccount.id) {
    // A request for the previous account is still in flight; show nothing.
    return { status: "loading", data: null, error: null };
  }
  const matches = Boolean(
    input.data &&
      input.data.accountId === input.selectedAccount.id &&
      input.data.accountNickname === input.selectedAccount.nickname &&
      input.data.accountMode === input.selectedAccount.mode,
  );
  if (matches) return { status: input.status, data: input.data, error: null };
  return {
    status: input.status === "ready" ? "loading" : input.status,
    data: null,
    error: input.error,
  };
}

export function statusUrl(account: StatusIdentity | null): string | null {
  return account
    ? `/api/accounts/${encodeURIComponent(account.id)}/status`
    : null;
}

const KNOWN_CODES = new Set([
  "UNAUTHENTICATED",
  "ACCOUNT_NOT_FOUND",
  "INVALID_RESPONSE",
  "REQUEST_FAILED",
]);

export function parseStatusError(status: number, body: unknown): StatusError {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    if (
      typeof record.code === "string" &&
      typeof record.error === "string" &&
      KNOWN_CODES.has(record.code)
    ) {
      return { code: record.code, message: record.error };
    }
  }
  return {
    code: status === 401 ? "UNAUTHENTICATED" : "REQUEST_FAILED",
    message: `The strategy status request failed (HTTP ${status}).`,
  };
}
