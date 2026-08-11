import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { isCalendarDate } from "@/lib/calendar-date";
import {
  fetchCashActivities,
  type CashFlowWalkResult,
} from "./equity-backfill";

/**
 * One refresh of both broker datasets: fetch everything, validate everything,
 * then publish once.
 *
 * The two mirrors used to be refreshed independently, by whichever route ran
 * first, each writing as it went. Three consequences, all of them ways to
 * publish something untrue:
 *
 *   * a partial or corrupt portfolio-history response could delete real days
 *     before anything noticed it was partial;
 *   * `/equity` and `/performance` could refresh concurrently and publish in
 *     either order, so an older fetch could land on top of a newer one; and
 *   * the equity curve and the ledger could come from different moments even
 *     though every number derived from them treats them as one observation.
 *
 * So: nothing is written until both datasets are fully in hand and fully
 * validated, and then they are published together under a generation taken
 * *before* the fetch. A generation that is no longer the newest is refused by
 * the database, which is what makes two overlapping refreshes safe.
 */

type Service = SupabaseClient<Database>;
type Mode = Database["public"]["Enums"]["account_mode"];

const ALPACA_BASE: Record<Mode, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

export interface EquityDay {
  readonly snapshot_date: string;
  readonly equity: number;
  readonly cash: number;
  readonly profit_loss: number | null;
  readonly profit_loss_pct: number | null;
}

export type RefreshFailure =
  | "NO_CREDENTIALS"
  | "PORTFOLIO_HISTORY_UNREADABLE"
  | "PORTFOLIO_HISTORY_INCOMPLETE"
  | "CASH_FLOW_INCOMPLETE"
  | "NON_CASH_EXTERNAL_TRANSFER"
  | "STALE_GENERATION"
  | "PUBLISH_REFUSED";

export type RefreshResult =
  | {
      readonly ok: true;
      readonly generation: string;
      readonly equityWritten: number;
      readonly equityRemoved: number;
      readonly flowsWritten: number;
      readonly flowsRemoved: number;
      readonly latestActivityAt: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: RefreshFailure;
      readonly detail: string;
      /** Always true: no path below mutates before the single publish call. */
      readonly mutated: false;
    };

type PortfolioHistory = {
  timestamp?: unknown;
  equity?: unknown;
  profit_loss?: unknown;
  profit_loss_pct?: unknown;
};

/**
 * Read and fully validate Alpaca's `period=all` portfolio history.
 *
 * Every rejection here happens **before** any database mutation, and the
 * result is either a complete, authoritative history or nothing at all. The
 * previous version skipped unusable days with `continue`, which turned a
 * corrupt payload into a shorter one — and a shorter payload is exactly what
 * the reconciliation reads as "these days were retracted".
 */
export async function fetchPortfolioHistory(
  apiKey: string,
  apiSecret: string,
  mode: Mode,
): Promise<
  | { readonly ok: true; readonly days: EquityDay[] }
  | { readonly ok: false; readonly detail: string }
> {
  const res = await fetch(
    `${ALPACA_BASE[mode]}/account/portfolio/history?period=all&timeframe=1D`,
    {
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    return { ok: false, detail: `Alpaca portfolio history HTTP ${res.status}` };
  }

  const body = (await res.json().catch(() => null)) as PortfolioHistory | null;
  if (!body || typeof body !== "object") {
    return { ok: false, detail: "Alpaca portfolio history is not an object" };
  }

  const ts = body.timestamp;
  const equity = body.equity;
  const pl = body.profit_loss;
  const plpc = body.profit_loss_pct;

  // Column-oriented and positional: a length disagreement pairs one day's
  // timestamp with another day's equity, which is worse than no data.
  if (!Array.isArray(ts) || !Array.isArray(equity)) {
    return {
      ok: false,
      detail: "Alpaca portfolio history is not column-oriented arrays",
    };
  }
  if (ts.length === 0 || equity.length === 0) {
    return { ok: false, detail: "Alpaca portfolio history returned no observations" };
  }
  if (equity.length !== ts.length) {
    return {
      ok: false,
      detail: `Alpaca portfolio history is inconsistent: ${ts.length} timestamps against ${equity.length} equity values`,
    };
  }
  for (const [name, column] of [
    ["profit_loss", pl],
    ["profit_loss_pct", plpc],
  ] as const) {
    if (column === undefined || column === null) continue;
    if (!Array.isArray(column)) {
      return { ok: false, detail: `Alpaca portfolio history column ${name} is not an array` };
    }
    if (column.length > 0 && column.length !== ts.length) {
      return {
        ok: false,
        detail: `Alpaca portfolio history column ${name} has ${column.length} values against ${ts.length} timestamps`,
      };
    }
  }

  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  });
  const byDate = new Map<string, EquityDay>();

  for (let index = 0; index < ts.length; index++) {
    const stamp = ts[index];
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) {
      return {
        ok: false,
        detail: `Alpaca portfolio history has a non-numeric timestamp at position ${index}`,
      };
    }
    const value = equity[index];
    // A null, non-finite or non-positive equity is not a day to skip — it is a
    // payload this process cannot understand, and understanding it partially
    // is how real days get deleted.
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return {
        ok: false,
        detail: `Alpaca portfolio history has an unusable equity value at position ${index}`,
      };
    }
    const date = etDate.format(new Date(stamp * 1000));
    // `Intl` will happily render a value that is not a real, round-tripping
    // calendar date; a session the mirror cannot key on is a hard rejection.
    if (!isCalendarDate(date)) {
      return {
        ok: false,
        detail: `Alpaca portfolio history timestamp ${stamp} is not a usable calendar date`,
      };
    }

    const optional = (column: unknown, position: number): number | null => {
      if (!Array.isArray(column) || column.length === 0) return null;
      const entry = column[position];
      if (entry === null || entry === undefined) return null;
      return typeof entry === "number" && Number.isFinite(entry) ? entry : null;
    };

    byDate.set(date, {
      snapshot_date: date,
      equity: Math.round(value * 100) / 100,
      // Portfolio history carries no per-day cash; only equity drives the chart.
      cash: 0,
      profit_loss: optional(pl, index),
      profit_loss_pct: optional(plpc, index),
    });
  }

  const days = [...byDate.values()].sort((a, b) =>
    a.snapshot_date.localeCompare(b.snapshot_date),
  );
  return { ok: true, days };
}

/**
 * Refresh both mirrors as one generation.
 *
 * @param flowsFrom Inclusive market-time date the activity walk is
 *                  authoritative for; rows before it are never touched.
 */
export async function refreshBrokerDatasets(
  svc: Service,
  accountId: string,
  ownerId: string,
  mode: Mode,
  options: { flowsFrom?: string } = {},
): Promise<RefreshResult> {
  const { data: cred, error: credErr } = await svc.rpc(
    "get_account_credentials",
    { acct: accountId },
  );
  if (credErr || !cred || cred.length === 0) {
    return {
      ok: false,
      reason: "NO_CREDENTIALS",
      detail: "This account has no stored Alpaca credentials.",
      mutated: false,
    };
  }
  const { api_key: apiKey, api_secret: apiSecret } = cred[0];

  // The generation is taken before the broker is read, so a refresh that
  // started earlier can be recognised as older even if it finishes later.
  const { data: generation, error: genError } = await svc.rpc(
    "begin_broker_refresh",
    { p_account: accountId, p_owner: ownerId },
  );
  if (genError || generation == null) {
    return {
      ok: false,
      reason: "PUBLISH_REFUSED",
      detail: `A refresh generation could not be reserved: ${genError?.message ?? "no value returned"}`,
      mutated: false,
    };
  }

  const history = await fetchPortfolioHistory(apiKey, apiSecret, mode);
  if (!history.ok) {
    return {
      ok: false,
      reason: "PORTFOLIO_HISTORY_UNREADABLE",
      detail: `${history.detail}. Nothing was written.`,
      mutated: false,
    };
  }

  const walk: CashFlowWalkResult = await fetchCashActivities(
    apiKey,
    apiSecret,
    mode,
    options.flowsFrom,
  );
  if (!walk.complete) {
    return {
      ok: false,
      reason:
        walk.incompleteReason === "NON_CASH_EXTERNAL_TRANSFER"
          ? "NON_CASH_EXTERNAL_TRANSFER"
          : "CASH_FLOW_INCOMPLETE",
      detail: `${walk.detail ?? "The Alpaca activity walk could not be completed."} Nothing was written.`,
      mutated: false,
    };
  }

  // One call, one transaction, both datasets, one generation.
  const { data, error } = await svc.rpc("publish_broker_refresh", {
    p_account: accountId,
    p_owner: ownerId,
    p_generation: generation as unknown as number,
    p_equity: history.days as unknown as Database["public"]["Functions"]["publish_broker_refresh"]["Args"]["p_equity"],
    p_equity_complete: true,
    p_flows: walk.rows as unknown as Database["public"]["Functions"]["publish_broker_refresh"]["Args"]["p_flows"],
    p_flows_from: walk.windowFrom,
    p_flows_complete: true,
    p_flows_scanned: walk.scanned,
  });
  if (error) {
    return {
      ok: false,
      reason: /generation .* is not newer/.test(error.message)
        ? "STALE_GENERATION"
        : "PUBLISH_REFUSED",
      detail: `The refresh was refused and rolled back: ${error.message}`,
      mutated: false,
    };
  }

  const outcome = (data ?? {}) as Record<string, unknown>;
  const count = (key: string) =>
    typeof outcome[key] === "number" ? (outcome[key] as number) : 0;
  return {
    ok: true,
    generation: String(generation),
    equityWritten: count("equity_written"),
    equityRemoved: count("equity_removed"),
    flowsWritten: count("flows_written"),
    flowsRemoved: count("flows_removed"),
    latestActivityAt: walk.latestActivityAt,
  };
}
