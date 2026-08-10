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

  // Portfolio history is column-oriented: the arrays are positional, so a
  // length disagreement silently pairs one day's timestamp with another day's
  // equity. An empty payload is equally not a curve — writing nothing and
  // returning 0 would look like a successful refresh of an account that simply
  // has no history.
  if (!Array.isArray(ts) || !Array.isArray(equity)) {
    throw new Error("Alpaca portfolio history is not column-oriented arrays");
  }
  if (ts.length === 0 || equity.length === 0) {
    throw new Error("Alpaca portfolio history returned no observations");
  }
  if (equity.length !== ts.length) {
    throw new Error(
      `Alpaca portfolio history is inconsistent: ${ts.length} timestamps against ${equity.length} equity values`,
    );
  }
  for (const [name, column] of [
    ["profit_loss", pl],
    ["profit_loss_pct", plpc],
  ] as const) {
    if (column.length > 0 && column.length !== ts.length) {
      throw new Error(
        `Alpaca portfolio history column ${name} has ${column.length} values against ${ts.length} timestamps`,
      );
    }
  }

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
    if (eq == null || !Number.isFinite(eq) || eq <= 0) continue;
    const stamp = ts[i];
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) {
      throw new Error("Alpaca portfolio history contains a non-numeric timestamp");
    }
    const date = etDate.format(new Date(stamp * 1000));
    // `Intl` yields an empty string for an invalid Date rather than throwing.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(
        `Alpaca portfolio history timestamp ${stamp} is not a usable calendar date`,
      );
    }
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

/**
 * The walk reads the account's **entire** activity history for the requested
 * types, back to the account's own beginning.
 *
 * A bounded window was the previous approach and it could not prove what it
 * claimed. Alpaca's `after` filter is applied server-side to the activity
 * record, not to the settlement date the ledger books against, and a
 * correction can re-date or withdraw a record after the fact. Any finite
 * lookback therefore has an edge that a late or amended activity can cross
 * unseen, and "I looked back ten days" is not evidence that nothing older
 * moved.
 *
 * Reading everything removes the edge. 500 pages of 100 is 50 000 activities;
 * a paper account that exceeds that gets UNAVAILABLE, not a partial ledger.
 */
const MAX_ACTIVITY_PAGES = 500;

/** Same tolerance the read model uses for a timestamp ahead of our clock. */
const ACTIVITY_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Alpaca's own sign convention for the two unambiguous cash types.
 *
 * `CSD` is a deposit and `CSW` is a withdrawal, so their `net_amount` signs are
 * fixed. A `CSD` booked negative (or a `CSW` booked positive) means the feed
 * and the ledger disagree about direction, and booking it anyway would move the
 * return the wrong way by twice the amount. `JNLC` and `ACATC` legitimately go
 * either way and are not constrained.
 */
const REQUIRED_SIGN: Readonly<Record<string, 1 | -1>> = {
  CSD: 1,
  CSW: -1,
};

export type CashFlowIncompleteReason =
  | "MALFORMED_ACTIVITY"
  | "UNEXPECTED_ACTIVITY_TYPE"
  | "NON_CASH_EXTERNAL_TRANSFER"
  | "FUTURE_DATED_ACTIVITY"
  | "NO_PAGINATION_TOKEN"
  | "LEDGER_RECONCILE_FAILED"
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
    // The shape is not enough: `2026-02-30` parses in V8 and silently rolls
    // over to 2 March, which would book a flow on a session that never was.
    // Round-tripping rejects any day the calendar does not contain.
    if (
      Number.isFinite(noon) &&
      new Date(noon).toISOString().slice(0, 10) === activity.date
    ) {
      // Midday UTC is inside the ET day for every US offset, so formatting
      // cannot roll the date backwards.
      return { date: activity.date, instant: new Date(noon).toISOString() };
    }
    return null;
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
  /** Every activity id seen anywhere in the history, for deduplication. */
  const seen = new Set<string>();
  /** Ids that belong to the measured window, for reconciliation below. */
  const inWindow = new Set<string>();

  const baselineDate = options.since ? boundaryDate(options.since, etDate) : null;
  if (options.since && baselineDate === null) {
    // Without a usable boundary the walk cannot say what it covered.
    return incomplete(
      "MALFORMED_ACTIVITY",
      `The epoch baseline timestamp ${options.since} is not a usable date, so the activity window cannot be bounded.`,
      0,
    );
  }

  // No `after` filter: the whole history is read (see MAX_ACTIVITY_PAGES). The
  // baseline is applied afterwards, to each activity's real occurrence date, so
  // a server-side filter on the wrong field cannot hide anything.
  const nowMs = Date.now();
  const latestAllowedDate = etDate.format(
    new Date(nowMs + ACTIVITY_CLOCK_SKEW_TOLERANCE_MS),
  );

  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const query = new URLSearchParams({
      activity_types: REQUESTED_ACTIVITY_TYPES.join(","),
      page_size: String(ACTIVITY_PAGE_SIZE),
      direction: "desc",
    });
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

      // An activity dated after today's market date is broken data, not a
      // future-scheduled transfer: the same five-minute clock-skew tolerance
      // used everywhere else applies.
      if (occurred.date > latestAllowedDate) {
        return incomplete(
          "FUTURE_DATED_ACTIVITY",
          `Alpaca activity ${id} is dated ${occurred.date}, after the current New York session date, so the activity feed cannot be trusted.`,
          pagesRead,
        );
      }

      // Deduplicate by activity id: a correction can surface the same activity
      // twice within one walk.
      if (seen.has(id)) continue;
      seen.add(id);

      // Activities before the baseline are read (they prove nothing was
      // re-dated across the boundary) but belong to the pre-V11 era, so they
      // are neither written nor counted.
      if (baselineDate !== null && occurred.date < baselineDate) continue;
      inWindow.add(id);

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
      const requiredSign = REQUIRED_SIGN[type];
      if (requiredSign !== undefined && amount !== 0 && Math.sign(amount) !== requiredSign) {
        return incomplete(
          "MALFORMED_ACTIVITY",
          `Alpaca activity ${id} is a ${type} with net_amount ${amount}, which contradicts its own direction.`,
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

  // --- reconcile the mirror against the broker's current truth --------------
  //
  // An upsert alone only ever adds and amends. Alpaca can *withdraw* an
  // activity — a reversed transfer, a correction that re-issues under a new id,
  // a duplicate that gets removed — and the row this mirror wrote for it would
  // otherwise stay in the ledger forever, permanently subtracting a deposit
  // that no longer exists from the reported return.
  //
  // The walk above read the account's entire history, so `seen` is the complete
  // set of activity ids that currently exist. Any mirrored row inside the
  // measured window whose id is absent from it has been withdrawn upstream and
  // must go. Rows outside the window are left alone: this walk makes no claim
  // about them.
  const existing = await svc
    .from("cash_flows")
    .select("external_id,flow_date")
    .eq("account_id", accountId)
    .eq("source", "alpaca_activities");
  if (existing.error) {
    return incomplete(
      "LEDGER_RECONCILE_FAILED",
      `The mirrored cash-flow ledger could not be read for reconciliation: ${existing.error.message}`,
      pagesRead,
    );
  }

  const stale = (existing.data ?? [])
    .filter((row) => {
      const externalId = row.external_id;
      if (typeof externalId !== "string" || !externalId) return false;
      // Only rows the walk was authoritative about.
      if (baselineDate !== null && (row.flow_date ?? "") < baselineDate) return false;
      return !seen.has(externalId);
    })
    .map((row) => row.external_id as string);

  if (stale.length > 0) {
    const removal = await svc
      .from("cash_flows")
      .delete()
      .eq("account_id", accountId)
      .eq("source", "alpaca_activities")
      .in("external_id", stale);
    if (removal.error) {
      return incomplete(
        "LEDGER_RECONCILE_FAILED",
        `${stale.length} mirrored cash flow(s) no longer exist at the broker but could not be removed: ${removal.error.message}`,
        pagesRead,
      );
    }
  }

  const list = [...rows.values()];
  if (list.length > 0) {
    // An amended activity keeps its id, so the upsert overwrites the old
    // amount and date rather than leaving both versions in place.
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
