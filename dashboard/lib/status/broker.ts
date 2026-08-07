import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { AccountMode, BrokerInfo, BrokerPosition } from "./types";

/**
 * Server-side broker snapshot for one explicitly identified account.
 *
 * Credentials are decrypted in the Route Handler process and never appear in a
 * response. This reader is strictly read-only: it calls `GET /account` and
 * `GET /positions` and has no code path that can submit, replace or cancel an
 * order.
 */

type Service = SupabaseClient<Database>;

export const ALPACA_BASE: Record<AccountMode, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

export const ALPACA_DATA_BASE = "https://data.alpaca.markets/v2";

export type BrokerFailure =
  | "CREDENTIALS_MISSING"
  | "ALPACA_UNREACHABLE"
  | "ALPACA_AUTH_FAILED"
  | "ALPACA_API_ERROR"
  | "INVALID_RESPONSE";

export type BrokerResult =
  | { ok: true; snapshot: BrokerInfo; fetchedAt: string }
  | { ok: false; code: BrokerFailure; detail: string };

export interface AlpacaCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
}

export async function loadCredentials(
  svc: Service,
  accountId: string,
): Promise<AlpacaCredentials | null> {
  const { data, error } = await svc.rpc("get_account_credentials", {
    acct: accountId,
  });
  if (error || !data || data.length === 0) return null;
  return { apiKey: data[0].api_key, apiSecret: data[0].api_secret };
}

function credentialHeaders(cred: AlpacaCredentials): Record<string, string> {
  return {
    "APCA-API-KEY-ID": cred.apiKey,
    "APCA-API-SECRET-KEY": cred.apiSecret,
  };
}

function toPosition(raw: Record<string, string>): BrokerPosition | null {
  const symbol = typeof raw.symbol === "string" ? raw.symbol.toUpperCase() : "";
  const qty = Number.parseFloat(raw.qty);
  const marketValue = Number.parseFloat(raw.market_value);
  if (!symbol || !Number.isFinite(qty) || !Number.isFinite(marketValue)) {
    return null;
  }
  const side = String(raw.side ?? "").toLowerCase();
  return {
    symbol,
    qty,
    avgEntryPrice: Number.parseFloat(raw.avg_entry_price),
    currentPrice: Number.parseFloat(raw.current_price),
    marketValue,
    unrealizedPl: Number.parseFloat(raw.unrealized_pl),
    // Alpaca reports a fraction; the dashboard contract stores percentage points.
    unrealizedPlPct: Number.parseFloat(raw.unrealized_plpc) * 100,
    side: side === "short" || qty < 0 ? "short" : "long",
  };
}

/** Build the derived broker aggregates from a raw Alpaca account + positions. */
export function buildBrokerInfo(
  account: Record<string, unknown>,
  rawPositions: readonly Record<string, string>[],
): BrokerInfo | null {
  const equity = Number.parseFloat(String(account.equity ?? ""));
  const cash = Number.parseFloat(String(account.cash ?? ""));
  if (!Number.isFinite(equity) || !Number.isFinite(cash)) return null;
  const lastEquity = Number.parseFloat(
    String(account.last_equity ?? String(equity)),
  );

  const positions: BrokerPosition[] = [];
  for (const raw of rawPositions) {
    const position = toPosition(raw);
    if (!position) return null;
    positions.push(position);
  }
  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const grossExposure = positions.reduce(
    (total, position) => total + Math.abs(position.marketValue),
    0,
  );
  const previous = Number.isFinite(lastEquity) ? lastEquity : equity;

  return {
    equity,
    cash,
    cashPct: equity > 0 ? (cash / equity) * 100 : 0,
    dailyPnl: equity - previous,
    dailyPnlPct: previous > 0 ? ((equity - previous) / previous) * 100 : 0,
    grossExposure,
    grossExposurePct: equity > 0 ? (grossExposure / equity) * 100 : 0,
    positionCount: positions.length,
    positions,
    shortSymbols: positions
      .filter((position) => position.side === "short")
      .map((position) => position.symbol),
  };
}

/** Fetch a fresh, read-only broker snapshot for one account. */
export async function fetchBrokerSnapshot(
  cred: AlpacaCredentials,
  mode: AccountMode,
): Promise<BrokerResult> {
  const base = ALPACA_BASE[mode];
  let accountRes: Response;
  let positionsRes: Response;
  try {
    const signal = AbortSignal.timeout(10_000);
    const headers = credentialHeaders(cred);
    [accountRes, positionsRes] = await Promise.all([
      fetch(`${base}/account`, { headers, cache: "no-store", signal }),
      fetch(`${base}/positions`, { headers, cache: "no-store", signal }),
    ]);
  } catch {
    return {
      ok: false,
      code: "ALPACA_UNREACHABLE",
      detail: "Could not reach Alpaca for the selected account.",
    };
  }

  if (accountRes.status === 401 || accountRes.status === 403) {
    return {
      ok: false,
      code: "ALPACA_AUTH_FAILED",
      detail: "Alpaca rejected this account's credentials.",
    };
  }
  if (!accountRes.ok || !positionsRes.ok) {
    return {
      ok: false,
      code: "ALPACA_API_ERROR",
      detail: `Alpaca API error: account=${accountRes.status}, positions=${positionsRes.status}.`,
    };
  }

  const account = (await accountRes.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const rawPositions = (await positionsRes.json().catch(() => null)) as
    | Record<string, string>[]
    | null;
  if (!account || !Array.isArray(rawPositions)) {
    return {
      ok: false,
      code: "INVALID_RESPONSE",
      detail: "Alpaca returned an unreadable account or positions payload.",
    };
  }

  const snapshot = buildBrokerInfo(account, rawPositions);
  if (!snapshot) {
    return {
      ok: false,
      code: "INVALID_RESPONSE",
      detail: "Alpaca returned account fields the dashboard cannot validate.",
    };
  }
  return { ok: true, snapshot, fetchedAt: new Date().toISOString() };
}

export interface BenchmarkBarRow {
  readonly date: string;
  readonly close: number;
}

/**
 * Daily benchmark closes from Alpaca market data, dated by America/New_York
 * session so they line up with the equity mirror. Read-only market data.
 */
export async function fetchBenchmarkBars(
  cred: AlpacaCredentials,
  symbol: string,
  startDate: string,
): Promise<BenchmarkBarRow[] | null> {
  const bars: BenchmarkBarRow[] = [];
  let pageToken: string | null = null;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  });

  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      timeframe: "1Day",
      start: startDate,
      adjustment: "all",
      limit: "10000",
      feed: "iex",
      sort: "asc",
    });
    if (pageToken) query.set("page_token", pageToken);
    let response: Response;
    try {
      response = await fetch(
        `${ALPACA_DATA_BASE}/stocks/${encodeURIComponent(symbol)}/bars?${query}`,
        {
          headers: credentialHeaders(cred),
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      bars?: { t?: string; c?: number }[];
      next_page_token?: string | null;
    } | null;
    if (!body || !Array.isArray(body.bars)) return null;
    for (const bar of body.bars) {
      if (typeof bar.t !== "string" || typeof bar.c !== "number") continue;
      const parsed = Date.parse(bar.t);
      if (!Number.isFinite(parsed) || !(bar.c > 0)) continue;
      bars.push({ date: formatter.format(new Date(parsed)), close: bar.c });
    }
    pageToken = body.next_page_token ?? null;
    if (!pageToken) break;
  }
  return bars;
}
