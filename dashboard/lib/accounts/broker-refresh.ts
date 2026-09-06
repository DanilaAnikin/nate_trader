import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/database.types";
import { isCalendarDate } from "@/lib/calendar-date";
import {
  describeFetchFailure,
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
  | "BROKER_UNREACHABLE"
  | "STALE_GENERATION"
  | "CREDENTIALS_ROTATED"
  | "RECONCILIATION_CONFLICT"
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
      /**
       * Whether either **mirror** moved. Always false: the only statement that
       * writes `equity_snapshots` or `cash_flows` is the single publish call,
       * and it is one transaction that either commits whole or rolls back.
       *
       * It is named `mirrorMutated`, not `mutated`, because reserving a
       * refresh token *is* a database write — a row in `broker_refresh_token`
       * and a `nextval` on the generation sequence. Neither is user-visible
       * financial state, but calling the whole operation "no mutation" would
       * be false, and a reader deciding whether a retry is safe needs the
       * distinction.
       */
      readonly mirrorMutated: false;
      /** True once a token was reserved, so a sequence value was consumed. */
      readonly reservationTaken: boolean;
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
 * result is either a complete, internally consistent history or nothing at
 * all. Three classes of leniency have been removed, each of which turned a
 * broken payload into a plausible shorter one — and a shorter payload is
 * exactly what a reconciliation reads as "these days were retracted":
 *
 *   * days with an unusable equity were skipped with `continue`;
 *   * an unusable `profit_loss` / `profit_loss_pct` entry silently became
 *     `null`, so a corrupt column read as "this day had no P/L"; and
 *   * rows were collected into a `Map` keyed by date, so two rows for the same
 *     session quietly resolved last-wins. Two rows for one day means the
 *     payload is not what it claims to be — the timestamps disagree with the
 *     sessions, or the response splices two responses — and picking one of
 *     them is a guess about which day's equity is real.
 */
export async function fetchPortfolioHistory(
  apiKey: string,
  apiSecret: string,
  mode: Mode,
): Promise<
  | { readonly ok: true; readonly days: EquityDay[] }
  | { readonly ok: false; readonly detail: string }
> {
  let res: Response;
  try {
    res = await fetch(
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
  } catch (caught) {
    // Timeout, abort, DNS, TLS, dropped connection. This used to propagate out
    // of the route as an unhandled rejection and reach the browser as a raw
    // 500 with no named reason.
    return {
      ok: false,
      detail: `Alpaca portfolio history could not be reached: ${describeFetchFailure(caught)}`,
    };
  }
  if (!res.ok) {
    return { ok: false, detail: `Alpaca portfolio history HTTP ${res.status}` };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, detail: "Alpaca portfolio history is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, detail: "Alpaca portfolio history is not an object" };
  }
  const body = parsed as PortfolioHistory;

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
  // An optional column is either absent, or present and exactly as long as the
  // others. "Present but a different length" is a payload whose columns do not
  // describe the same days.
  for (const [name, column] of [
    ["profit_loss", pl],
    ["profit_loss_pct", plpc],
  ] as const) {
    if (column === undefined || column === null) continue;
    if (!Array.isArray(column)) {
      return { ok: false, detail: `Alpaca portfolio history column ${name} is not an array` };
    }
    if (column.length !== ts.length) {
      return {
        ok: false,
        detail: `Alpaca portfolio history column ${name} has ${column.length} values against ${ts.length} timestamps`,
      };
    }
  }

  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  });
  const days: EquityDay[] = [];
  const seenDates = new Set<string>();
  const seenStamps = new Set<number>();

  /**
   * An optional P/L entry. `null`/absent is a legitimate "not reported"; a
   * string, a boolean, a NaN or an Infinity is a column this process does not
   * understand, and reading it as "not reported" hides that.
   */
  const optional = (
    column: unknown,
    position: number,
  ): { ok: true; value: number | null } | { ok: false } => {
    if (column === undefined || column === null) return { ok: true, value: null };
    if (!Array.isArray(column)) return { ok: false };
    const entry = column[position];
    if (entry === null || entry === undefined) return { ok: true, value: null };
    if (typeof entry !== "number" || !Number.isFinite(entry)) return { ok: false };
    return { ok: true, value: entry };
  };

  for (let index = 0; index < ts.length; index++) {
    const stamp = ts[index];
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) {
      return {
        ok: false,
        detail: `Alpaca portfolio history has a non-numeric timestamp at position ${index}`,
      };
    }
    if (seenStamps.has(stamp)) {
      return {
        ok: false,
        detail: `Alpaca portfolio history repeats the timestamp ${stamp}, so its columns do not describe distinct observations`,
      };
    }
    seenStamps.add(stamp);

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
    if (seenDates.has(date)) {
      return {
        ok: false,
        detail: `Alpaca portfolio history reports the session ${date} more than once, so which equity belongs to it cannot be determined`,
      };
    }
    seenDates.add(date);

    const profitLoss = optional(pl, index);
    if (!profitLoss.ok) {
      return {
        ok: false,
        detail: `Alpaca portfolio history has an unusable profit_loss value at position ${index}`,
      };
    }
    const profitLossPct = optional(plpc, index);
    if (!profitLossPct.ok) {
      return {
        ok: false,
        detail: `Alpaca portfolio history has an unusable profit_loss_pct value at position ${index}`,
      };
    }

    days.push({
      snapshot_date: date,
      equity: Math.round(value * 100) / 100,
      // Portfolio history carries no per-day cash; only equity drives the chart.
      cash: 0,
      profit_loss: profitLoss.value,
      profit_loss_pct: profitLossPct.value,
    });
  }

  days.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
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
  const failed = (
    reason: RefreshFailure,
    detail: string,
    reservationTaken: boolean,
  ): RefreshResult => ({
    ok: false,
    reason,
    detail,
    mirrorMutated: false,
    reservationTaken,
  });

  // Credentials and reservation from **one** transaction.
  //
  // They used to be two calls, credentials first. A rotation landing between
  // them produced a token recording the *new* `credential_version` while the
  // caller held the *old* key — the one combination the version re-check at
  // publish time cannot catch, because the token and the account agree with
  // each other and disagree only with reality. The refresh then published data
  // fetched with a credential that no longer existed, and reported success.
  //
  // `begin_broker_refresh_with_credentials` locks the account row, reads the
  // Vault secrets and writes the token in a single transaction, so what the
  // token records is by construction the key this function holds.
  const { data: reservation, error: genError } = await svc.rpc(
    "begin_broker_refresh_with_credentials",
    { p_account: accountId, p_owner: ownerId },
  );
  const issued =
    reservation && typeof reservation === "object" && !Array.isArray(reservation)
      ? (reservation as Record<string, unknown>)
      : null;
  const token = issued?.token;
  const generation = issued?.generation;
  const apiKey = issued?.api_key;
  const apiSecret = issued?.api_secret;

  if (genError && /no stored credentials|account has no stored/i.test(genError.message ?? "")) {
    return failed(
      "NO_CREDENTIALS",
      "This account has no stored Alpaca credentials.",
      false,
    );
  }
  if (
    genError ||
    typeof token !== "string" ||
    typeof apiKey !== "string" ||
    typeof apiSecret !== "string"
  ) {
    return failed(
      "PUBLISH_REFUSED",
      `A refresh could not be reserved: ${genError?.message ?? "no token and credentials returned"}`,
      false,
    );
  }

  // The mode the reservation was issued against — and *only* that. Falling
  // back to the caller's copy when the reservation's is missing or unreadable
  // is the failure mode this is meant to prevent: the caller's is the older
  // value, and reading the live broker with a stale mode hits the wrong Alpaca
  // host entirely. A reservation that cannot state its mode is not a
  // reservation this refresh can use.
  if (issued?.mode !== "paper" && issued?.mode !== "live") {
    return failed(
      "PUBLISH_REFUSED",
      `The refresh reservation did not state a usable account mode (${String(
        issued?.mode ?? "absent",
      )}), so the broker cannot be read against a known host.`,
      true,
    );
  }
  const authoritativeMode: Mode = issued.mode;

  const history = await fetchPortfolioHistory(apiKey, apiSecret, authoritativeMode);
  if (!history.ok) {
    return failed(
      /could not be reached/.test(history.detail)
        ? "BROKER_UNREACHABLE"
        : "PORTFOLIO_HISTORY_UNREADABLE",
      `${history.detail}. Nothing was written.`,
      true,
    );
  }

  const walk: CashFlowWalkResult = await fetchCashActivities(
    apiKey,
    apiSecret,
    authoritativeMode,
    options.flowsFrom,
  );
  if (!walk.complete) {
    return failed(
      walk.incompleteReason === "NON_CASH_EXTERNAL_TRANSFER"
        ? "NON_CASH_EXTERNAL_TRANSFER"
        : walk.incompleteReason === "BROKER_UNREACHABLE"
          ? "BROKER_UNREACHABLE"
          : "CASH_FLOW_INCOMPLETE",
      `${walk.detail ?? "The Alpaca activity walk could not be completed."} Nothing was written.`,
      true,
    );
  }

  // One call, one transaction, both datasets, one reservation. The database
  // has no code path here that deletes: a stored row the payload omits aborts
  // the whole transaction rather than being reconciled away.
  const { data, error } = await svc.rpc("publish_broker_refresh", {
    p_token: token,
    p_equity: history.days as unknown as Json,
    p_equity_complete: true,
    p_flows: walk.rows as unknown as Json,
    p_flows_from: walk.windowFrom,
    p_flows_complete: true,
    p_flows_scanned: walk.scanned,
    p_flows_saw_empty_page: walk.sawEmptyTerminalPage,
  });
  if (error) {
    const message = error.message ?? "";
    const reason: RefreshFailure = message.includes("RECONCILIATION_CONFLICT")
      ? "RECONCILIATION_CONFLICT"
      : /credentials changed|account mode changed|account number changed/.test(message)
        ? "CREDENTIALS_ROTATED"
        : /generation .* is not newer|already been published|older than the/.test(message)
          ? "STALE_GENERATION"
          : "PUBLISH_REFUSED";
    return failed(
      reason,
      `The refresh was refused and rolled back; the stored mirror is unchanged. ${message}`,
      true,
    );
  }

  const outcome = (data ?? {}) as Record<string, unknown>;
  const count = (key: string) =>
    typeof outcome[key] === "number" ? (outcome[key] as number) : 0;
  return {
    ok: true,
    generation: String(generation ?? ""),
    equityWritten: count("equity_written"),
    equityRemoved: count("equity_removed"),
    flowsWritten: count("flows_written"),
    flowsRemoved: count("flows_removed"),
    latestActivityAt: walk.latestActivityAt,
  };
}
