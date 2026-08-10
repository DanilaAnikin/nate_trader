import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type Service = SupabaseClient<Database>;
type Mode = Database["public"]["Enums"]["account_mode"];

const ALPACA_BASE: Record<Mode, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

type PortfolioHistory = {
  timestamp?: number[];
  equity?: (number | null)[];
  profit_loss?: (number | null)[];
  profit_loss_pct?: (number | null)[];
};

/**
 * Backfill an account's equity curve from Alpaca's Portfolio History — the
 * real, retroactive daily equity. Idempotent: upserts on
 * (account_id, snapshot_date). Returns the number of days written.
 *
 * This is what makes the dashboard equity chart correct (DEF-01) without
 * waiting for the scheduled agent — the equity API route calls it lazily the
 * first time an account is charted.
 */
export async function backfillEquity(
  svc: Service,
  accountId: string,
  mode: Mode,
): Promise<number> {
  const { data: cred, error: credErr } = await svc.rpc(
    "get_account_credentials",
    { acct: accountId },
  );
  if (credErr || !cred || cred.length === 0) {
    throw new Error("account has no stored credentials");
  }

  const res = await fetch(
    `${ALPACA_BASE[mode]}/account/portfolio/history?period=all&timeframe=1D`,
    {
      headers: {
        "APCA-API-KEY-ID": cred[0].api_key,
        "APCA-API-SECRET-KEY": cred[0].api_secret,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`Alpaca portfolio history HTTP ${res.status}`);
  }

  const hist = (await res.json()) as PortfolioHistory;
  const ts = hist.timestamp ?? [];
  const equity = hist.equity ?? [];
  const pl = hist.profit_loss ?? [];
  const plpc = hist.profit_loss_pct ?? [];

  // Keyed by date so a duplicated day collapses to its last value.
  const byDate = new Map<string, Database["public"]["Tables"]["equity_snapshots"]["Insert"]>();
  // Alpaca's daily timestamps fall in the trading day's evening, which is the
  // next calendar day in UTC — so a UTC slice mislabels Friday as Saturday and
  // drops Mondays. Format in market time (ET) so dates match the chart's
  // ET-dated SPY history. en-CA yields YYYY-MM-DD.
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  });
  for (let i = 0; i < ts.length; i++) {
    const eq = equity[i];
    if (eq == null || eq <= 0) continue;
    const date = etDate.format(new Date(ts[i] * 1000));
    byDate.set(date, {
      account_id: accountId,
      snapshot_date: date,
      equity: Math.round(eq * 100) / 100,
      // Portfolio history carries no per-day cash; only equity drives the chart.
      cash: 0,
      profit_loss: pl[i] ?? null,
      profit_loss_pct: plpc[i] ?? null,
      source: "alpaca_portfolio_history",
    });
  }

  const rows = [...byDate.values()];
  if (rows.length > 0) {
    const { error } = await svc
      .from("equity_snapshots")
      .upsert(rows, { onConflict: "account_id,snapshot_date" });
    if (error) throw new Error(`equity_snapshots upsert failed: ${error.message}`);
  }
  return rows.length;
}

type Activity = {
  id?: unknown;
  activity_type?: unknown;
  date?: unknown;
  transaction_time?: unknown;
  net_amount?: unknown;
};

/**
 * External cash movements. `ACATC` is an ACAT cash transfer — a real deposit
 * or withdrawal that would otherwise be read as investment return.
 */
const CASH_ACTIVITY_TYPES = ["CSD", "CSW", "JNLC", "ACATC"] as const;
const CASH_ACTIVITY_TYPE_SET: ReadonlySet<string> = new Set(CASH_ACTIVITY_TYPES);

/**
 * External movements of *securities*, not cash.
 *
 * `ACATS` transfers positions in or out of the account, `JNLS` journals shares
 * between accounts, and `FOPT` is an option-related position adjustment. None
 * of them has a cash `net_amount` that could be booked as a flow, yet every one
 * changes equity without the strategy having traded. Time-weighted return has
 * no way to neutralise them from the activity record alone, so their presence
 * since the baseline makes the number unreportable rather than approximate.
 *
 * They are requested alongside the cash types precisely so they are *detected*.
 */
const NON_CASH_TRANSFER_TYPES = ["ACATS", "JNLS", "FOPT"] as const;
const NON_CASH_TRANSFER_TYPE_SET: ReadonlySet<string> = new Set(
  NON_CASH_TRANSFER_TYPES,
);

const REQUESTED_ACTIVITY_TYPES = [
  ...CASH_ACTIVITY_TYPES,
  ...NON_CASH_TRANSFER_TYPES,
] as const;

const ACTIVITY_PAGE_SIZE = 100;
const MAX_ACTIVITY_PAGES = 50;

/**
 * Alpaca's `after` filter is applied to the activity's own date, but the record
 * a transfer agent posts can settle on a different day than the one the event
 * is finally dated to, and corrections re-date existing rows. Asking for a
 * window that starts this many days *before* the baseline makes such a shift
 * visible; rows are then deduplicated by activity id and filtered on the real
 * occurrence date, so the overlap can only add evidence, never double-count.
 */
export const ACTIVITY_OVERLAP_DAYS = 10;

export type CashFlowIncompleteReason =
  | "MALFORMED_ACTIVITY"
  | "UNEXPECTED_ACTIVITY_TYPE"
  | "NON_CASH_EXTERNAL_TRANSFER"
  | "NO_PAGINATION_TOKEN"
  | "PAGE_LIMIT_REACHED";

export interface CashFlowBackfillResult {
  readonly written: number;
  /** True only when every page back to the baseline boundary was read. */
  readonly complete: boolean;
  readonly incompleteReason: CashFlowIncompleteReason | null;
  readonly detail: string | null;
  readonly pagesRead: number;
  readonly refreshedAt: string;
  /** Newest activity timestamp seen, for freshness reporting. */
  readonly latestActivityAt: string | null;
}

/**
 * Alpaca sends `net_amount` as a decimal *string* ("-2500.00"), and sometimes
 * as a JSON number. Nothing else is acceptable.
 *
 * `Number()` is the trap this replaces: `Number(null)`, `Number("")` and
 * `Number("   ")` are all `0`, and `Number(true)` is `1` — so a broken or
 * absent amount silently became "a cash activity that moved no money" and the
 * walk was still declared complete. Every one of those must fail closed.
 */
export function parseNetAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  // A strict decimal: optional sign, digits, optional fraction. No hex, no
  // exponent, no "Infinity", no "NaN", no empty string, no thousands commas.
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The day the activity actually happened, in market time.
 *
 * Alpaca's non-trade activities carry `date` (the occurrence/settlement day)
 * and may also carry `transaction_time` (when the record was created). They can
 * disagree across a day boundary, so `date` wins when it is present and valid.
 */
export function resolveActivityDate(
  activity: Activity,
  etDate: Intl.DateTimeFormat,
): { readonly date: string; readonly instant: string } | null {
  if (typeof activity.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(activity.date)) {
    const noon = Date.parse(`${activity.date}T12:00:00Z`);
    if (Number.isFinite(noon)) {
      // Midday UTC is inside the ET day for every US offset, so formatting
      // cannot roll the date backwards.
      return { date: activity.date, instant: new Date(noon).toISOString() };
    }
  }
  const raw =
    typeof activity.date === "string" && activity.date.trim()
      ? activity.date
      : typeof activity.transaction_time === "string"
        ? activity.transaction_time
        : "";
  if (!raw.trim()) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  const at = new Date(parsed);
  return { date: etDate.format(at), instant: at.toISOString() };
}

/** The market-time calendar day an ISO instant (or plain date) falls on. */
function boundaryDate(iso: string, etDate: Intl.DateTimeFormat): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return etDate.format(new Date(parsed));
}

/** Shift an ISO instant (or plain date) by whole days, as an ISO instant. */
function shiftIsoDays(iso: string, days: number): string | null {
  const parsed = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso,
  );
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + days * 24 * 60 * 60 * 1000).toISOString();
}

function incomplete(
  reason: CashFlowIncompleteReason,
  detail: string,
  pagesRead: number,
): CashFlowBackfillResult {
  return {
    written: 0,
    complete: false,
    incompleteReason: reason,
    detail,
    pagesRead,
    refreshedAt: new Date().toISOString(),
    latestActivityAt: null,
  };
}

/**
 * Mirror external cash movements (deposits, withdrawals, cash journals, ACAT
 * cash transfers) into `cash_flows`.
 *
 * Without these rows a $10k deposit looks like $10k of profit, so time-weighted
 * return depends on them being *complete*. Every activity must be fully usable:
 * a missing id, timestamp or type, an unparseable amount, or a type outside the
 * requested set makes the whole walk incomplete rather than being skipped —
 * a silently dropped deposit is exactly the failure this guards.
 *
 * Alpaca caps a page at 100 items and paginates by passing the last id as
 * `page_token`; a full page without a usable token is also incomplete. Rows are
 * idempotent on the Alpaca activity id. Read-only against the broker.
 */
export async function backfillCashFlows(
  svc: Service,
  accountId: string,
  mode: Mode,
  options: { since?: string } = {},
): Promise<CashFlowBackfillResult> {
  const { data: cred, error: credErr } = await svc.rpc(
    "get_account_credentials",
    { acct: accountId },
  );
  if (credErr || !cred || cred.length === 0) {
    throw new Error("account has no stored credentials");
  }

  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  });
  const rows = new Map<
    string,
    Database["public"]["Tables"]["cash_flows"]["Insert"]
  >();

  let pageToken: string | null = null;
  let pagesRead = 0;
  let complete = false;
  let latestActivityAt: string | null = null;
  /** Every activity id already accounted for, across pages and the overlap. */
  const seen = new Set<string>();

  // The requested window starts before the baseline (see ACTIVITY_OVERLAP_DAYS)
  // so a re-dated or late-settling transfer cannot fall through the boundary.
  const baselineDate = options.since ? boundaryDate(options.since, etDate) : null;
  const queryAfter = options.since
    ? shiftIsoDays(options.since, -ACTIVITY_OVERLAP_DAYS)
    : null;
  if (options.since && (baselineDate === null || queryAfter === null)) {
    // Without a usable boundary the walk cannot say what it covered.
    return incomplete(
      "MALFORMED_ACTIVITY",
      `The epoch baseline timestamp ${options.since} is not a usable date, so the activity window cannot be bounded.`,
      0,
    );
  }

  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const query = new URLSearchParams({
      activity_types: REQUESTED_ACTIVITY_TYPES.join(","),
      page_size: String(ACTIVITY_PAGE_SIZE),
      direction: "desc",
    });
    if (queryAfter) query.set("after", queryAfter);
    if (pageToken) query.set("page_token", pageToken);

    const res = await fetch(`${ALPACA_BASE[mode]}/account/activities?${query}`, {
      headers: {
        "APCA-API-KEY-ID": cred[0].api_key,
        "APCA-API-SECRET-KEY": cred[0].api_secret,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Alpaca activities HTTP ${res.status}`);

    const activities = (await res.json()) as Activity[];
    if (!Array.isArray(activities)) {
      throw new Error("Alpaca activities returned an unreadable payload");
    }
    pagesRead++;

    let lastId: string | null = null;
    for (const activity of activities) {
      const id = typeof activity.id === "string" ? activity.id.trim() : "";
      const type =
        typeof activity.activity_type === "string"
          ? activity.activity_type.trim()
          : "";

      if (!id) {
        return incomplete(
          "MALFORMED_ACTIVITY",
          "An Alpaca activity has no id, so cash-flow completeness cannot be proven.",
          pagesRead,
        );
      }
      // Pagination is by id, so it must advance even for a row that is skipped
      // as pre-baseline or already seen.
      lastId = id;
      if (!type) {
        return incomplete(
          "MALFORMED_ACTIVITY",
          `Alpaca activity ${id} has no activity_type.`,
          pagesRead,
        );
      }
      if (
        !CASH_ACTIVITY_TYPE_SET.has(type) &&
        !NON_CASH_TRANSFER_TYPE_SET.has(type)
      ) {
        return incomplete(
          "UNEXPECTED_ACTIVITY_TYPE",
          `Alpaca returned activity type ${type}, which was not requested.`,
          pagesRead,
        );
      }

      const occurred = resolveActivityDate(activity, etDate);
      if (!occurred) {
        return incomplete(
          "MALFORMED_ACTIVITY",
          `Alpaca activity ${id} has no usable occurrence date.`,
          pagesRead,
        );
      }

      // The overlap window deliberately reaches behind the baseline. Those rows
      // prove nothing was re-dated across the boundary, but they belong to the
      // pre-V11 era and are neither written nor counted.
      if (baselineDate !== null && occurred.date < baselineDate) continue;
      // Deduplicate by activity id: the overlap and a re-dated correction can
      // both surface the same activity twice.
      if (seen.has(id)) continue;
      seen.add(id);

      if (latestActivityAt === null || occurred.instant > latestActivityAt) {
        latestActivityAt = occurred.instant;
      }

      // A securities transfer changes equity with no cash leg to book. Return
      // is not merely imprecise here — it is unattributable.
      if (NON_CASH_TRANSFER_TYPE_SET.has(type)) {
        return incomplete(
          "NON_CASH_EXTERNAL_TRANSFER",
          `An external securities transfer (${type}, ${occurred.date}) settled in this account after the V11 epoch baseline. It moves positions without a cash flow, so no return or alpha can be attributed to the strategy.`,
          pagesRead,
        );
      }

      const amount = parseNetAmount(activity.net_amount);
      if (amount === null) {
        return incomplete(
          "MALFORMED_ACTIVITY",
          `Alpaca activity ${id} has an invalid or missing net_amount.`,
          pagesRead,
        );
      }

      // A zero-amount cash activity moves no money and is not a flow, but it
      // was still fully understood, so it does not break completeness.
      if (amount === 0) continue;

      rows.set(id, {
        account_id: accountId,
        flow_date: occurred.date,
        amount: Math.round(amount * 100) / 100,
        kind: amount > 0 ? "deposit" : "withdrawal",
        source: "alpaca_activities",
        external_id: id,
      });
    }

    // A short page is the last page; a full page means there may be more.
    if (activities.length < ACTIVITY_PAGE_SIZE) {
      complete = true;
      break;
    }
    if (!lastId) {
      return incomplete(
        "NO_PAGINATION_TOKEN",
        "A full page of activities produced no usable pagination id, so older activities cannot be reached.",
        pagesRead,
      );
    }
    pageToken = lastId;
  }

  if (!complete) {
    return incomplete(
      "PAGE_LIMIT_REACHED",
      `More than ${MAX_ACTIVITY_PAGES} pages of activities exist; the walk back to the epoch baseline did not finish.`,
      pagesRead,
    );
  }

  const list = [...rows.values()];
  if (list.length > 0) {
    const { error } = await svc
      .from("cash_flows")
      .upsert(list, { onConflict: "account_id,external_id" });
    if (error) throw new Error(`cash_flows upsert failed: ${error.message}`);
  }
  return {
    written: list.length,
    complete: true,
    incompleteReason: null,
    detail: null,
    pagesRead,
    refreshedAt: new Date().toISOString(),
    latestActivityAt,
  };
}
