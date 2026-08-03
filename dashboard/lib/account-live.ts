import type { Position } from "@/lib/types";

export const ACCOUNT_LIVE_SCHEMA_VERSION = 1 as const;
export const ACCOUNT_LIVE_SOURCE = "alpaca-account-live" as const;

export type AccountMode = "paper" | "live";

export interface AccountIdentity {
  id: string;
  nickname: string;
  mode: AccountMode;
}

export interface LiveAccountMetrics {
  equity: number;
  cash: number;
  cash_pct: number;
  daily_pnl: number;
  daily_pnl_pct: number;
  num_positions: number;
}

export interface AccountLivePayload {
  schemaVersion: typeof ACCOUNT_LIVE_SCHEMA_VERSION;
  source: typeof ACCOUNT_LIVE_SOURCE;
  accountId: string;
  nickname: string;
  mode: AccountMode;
  timestamp: string;
  account: LiveAccountMetrics;
  positions: Position[];
}

export type AccountLiveErrorCode =
  | "UNAUTHENTICATED"
  | "ACCOUNT_NOT_FOUND"
  | "CREDENTIALS_MISSING"
  | "ALPACA_UNREACHABLE"
  | "ALPACA_AUTH_FAILED"
  | "ALPACA_API_ERROR"
  | "INVALID_RESPONSE"
  | "REQUEST_FAILED"
  | "LEGACY_ENDPOINT_RETIRED";

const ACCOUNT_LIVE_ERROR_CODES = new Set<AccountLiveErrorCode>([
  "UNAUTHENTICATED",
  "ACCOUNT_NOT_FOUND",
  "CREDENTIALS_MISSING",
  "ALPACA_UNREACHABLE",
  "ALPACA_AUTH_FAILED",
  "ALPACA_API_ERROR",
  "INVALID_RESPONSE",
  "REQUEST_FAILED",
  "LEGACY_ENDPOINT_RETIRED",
]);

export interface AccountLiveErrorPayload {
  error: string;
  code: AccountLiveErrorCode;
}

export type AccountLiveStatus =
  | "legacy"
  | "no-account"
  | "loading"
  | "live"
  | "error";

export interface ScopedAccountLiveState {
  status: AccountLiveStatus;
  data: AccountLivePayload | null;
  error: AccountLiveErrorPayload | null;
}

/** Scope provider state synchronously while a server refresh switches A → B. */
export function scopeAccountLiveState({
  enabled,
  selectedAccount,
  requestAccountId,
  status,
  data,
  error,
}: {
  enabled: boolean;
  selectedAccount: AccountIdentity | null;
  requestAccountId: string | null;
  status: AccountLiveStatus;
  data: AccountLivePayload | null;
  error: AccountLiveErrorPayload | null;
}): ScopedAccountLiveState {
  if (!enabled) return { status: "legacy", data: null, error: null };
  if (!selectedAccount) {
    return { status: "no-account", data: null, error: null };
  }
  if (requestAccountId !== selectedAccount.id) {
    return { status: "loading", data: null, error: null };
  }
  const matches = Boolean(
    data &&
      data.accountId === selectedAccount.id &&
      data.nickname === selectedAccount.nickname &&
      data.mode === selectedAccount.mode,
  );
  if (matches) return { status, data, error: null };
  return {
    status: status === "live" ? "loading" : status,
    data: null,
    error,
  };
}

export function normalizeAlpacaPosition(
  position: Record<string, string>,
): Position {
  return {
    symbol: position.symbol,
    qty: Number.parseFloat(position.qty),
    avg_entry_price: Number.parseFloat(position.avg_entry_price),
    current_price: Number.parseFloat(position.current_price),
    market_value: Number.parseFloat(position.market_value),
    unrealized_pl: Number.parseFloat(position.unrealized_pl),
    // Alpaca sends a fraction; the dashboard contract stores percentage points.
    unrealized_plpc: Number.parseFloat(position.unrealized_plpc) * 100,
    side: position.side,
  };
}

export function accountLiveUrl(account: AccountIdentity | null): string | null {
  return account ? `/api/accounts/${encodeURIComponent(account.id)}/live` : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return (
    typeof position.symbol === "string" &&
    isFiniteNumber(position.qty) &&
    isFiniteNumber(position.avg_entry_price) &&
    isFiniteNumber(position.current_price) &&
    isFiniteNumber(position.market_value) &&
    isFiniteNumber(position.unrealized_pl) &&
    isFiniteNumber(position.unrealized_plpc) &&
    (position.side === "long" || position.side === "short")
  );
}

/**
 * Runtime boundary for broker data. A response is usable only when it is the
 * current schema and belongs to the exact account and broker mode selected in
 * the shell. This prevents a delayed request for account A from painting over
 * account B after a switch.
 */
export function isAccountLivePayload(
  value: unknown,
  expected: AccountIdentity,
): value is AccountLivePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  const account = payload.account as Record<string, unknown> | undefined;
  const positions = payload.positions;
  const timestampIsValid =
    typeof payload.timestamp === "string" &&
    Number.isFinite(Date.parse(payload.timestamp));
  const positionCountIsValid =
    Boolean(account) &&
    Number.isInteger(account?.num_positions) &&
    (account?.num_positions as number) >= 0 &&
    Array.isArray(positions) &&
    account?.num_positions === positions.length;
  return (
    payload.schemaVersion === ACCOUNT_LIVE_SCHEMA_VERSION &&
    payload.source === ACCOUNT_LIVE_SOURCE &&
    payload.accountId === expected.id &&
    payload.nickname === expected.nickname &&
    payload.mode === expected.mode &&
    timestampIsValid &&
    Boolean(account) &&
    isFiniteNumber(account?.equity) &&
    isFiniteNumber(account?.cash) &&
    isFiniteNumber(account?.cash_pct) &&
    isFiniteNumber(account?.daily_pnl) &&
    isFiniteNumber(account?.daily_pnl_pct) &&
    positionCountIsValid &&
    Array.isArray(positions) &&
    positions.every(isPosition)
  );
}

export function parseAccountLiveError(
  status: number,
  value: unknown,
): AccountLiveErrorPayload {
  if (value && typeof value === "object") {
    const body = value as Record<string, unknown>;
    if (
      typeof body.error === "string" &&
      typeof body.code === "string" &&
      ACCOUNT_LIVE_ERROR_CODES.has(body.code as AccountLiveErrorCode)
    ) {
      return {
        error: body.error,
        code: body.code as AccountLiveErrorCode,
      };
    }
  }
  return {
    code: status === 401 ? "UNAUTHENTICATED" : "REQUEST_FAILED",
    error: `Live account request failed (HTTP ${status}).`,
  };
}

export function formatLiveTimestamp(
  value: string,
  locale?: string,
  timeZone?: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}
