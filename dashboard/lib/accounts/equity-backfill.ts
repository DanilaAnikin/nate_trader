import "server-only";
import type { Database } from "@/lib/database.types";

type Mode = Database["public"]["Enums"]["account_mode"];

const ALPACA_BASE: Record<Mode, string> = {
  paper: "https://paper-api.alpaca.markets/v2",
  live: "https://api.alpaca.markets/v2",
};

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

/**
 * The window the walk is authoritative for when no baseline bounds it.
 *
 * Alpaca accounts cannot predate the broker, so this is "everything".
 */
const EPOCH_START = "1970-01-01";

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

/**
 * The activity walk's result, with **no database access of its own**.
 *
 * Publishing moved to `refreshBrokerDatasets`, which holds both datasets and
 * writes them in one transaction. A walk that writes as it goes cannot be
 * combined with anything else atomically, and its partial output is exactly
 * what a reconciliation misreads as a retraction.
 */
export interface CashFlowWalkResult {
  readonly complete: boolean;
  readonly incompleteReason: CashFlowIncompleteReason | null;
  readonly detail: string | null;
  readonly pagesRead: number;
  /** Activities examined, including ones outside the window. */
  readonly scanned: number;
  /** Rows to publish, in the shape `publish_broker_refresh` expects. */
  readonly rows: readonly {
    external_id: string;
    flow_date: string;
    amount: number;
    kind: string;
  }[];
  /** Inclusive market-time date the walk is authoritative for. */
  readonly windowFrom: string;
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
): {
  readonly date: string;
  readonly instant: string;
  /**
   * True only when `instant` came from a real `transaction_time`.
   *
   * A date-only activity has no time of day, so its instant below is a
   * *fabricated* midday UTC. Treating that as an observed timestamp would make
   * every same-day activity look hours into the future when read early in the
   * morning — so freshness rules must apply the calendar-date test to these
   * and the clock test only to real ones.
   */
  readonly instantIsReal: boolean;
} | null {
  // A real instant, when the record carries one.
  const transactionTime =
    typeof activity.transaction_time === "string" ? activity.transaction_time : "";
  const parsedTime = transactionTime.trim() ? Date.parse(transactionTime) : NaN;
  const hasRealInstant = Number.isFinite(parsedTime);

  // The occurrence date. `date` wins when present and a real calendar day: it
  // is the settlement day the ledger books against, and it can differ from the
  // record's creation time across a boundary.
  let date: string | null = null;
  if (typeof activity.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(activity.date)) {
    const noon = Date.parse(`${activity.date}T12:00:00Z`);
    // The shape is not enough: `2026-02-30` parses in V8 and silently rolls
    // over to 2 March, which would book a flow on a session that never was.
    if (
      Number.isFinite(noon) &&
      new Date(noon).toISOString().slice(0, 10) === activity.date
    ) {
      date = activity.date;
    } else {
      return null;
    }
  } else if (hasRealInstant) {
    date = etDate.format(new Date(parsedTime));
  }
  if (!date) return null;

  if (hasRealInstant) {
    return {
      date,
      instant: new Date(parsedTime).toISOString(),
      instantIsReal: true,
    };
  }
  // No time of day exists. Midday UTC is inside the ET day for every US
  // offset, so formatting it cannot roll the date backwards — but it is a
  // stand-in, never an observation.
  return {
    date,
    instant: new Date(Date.parse(`${date}T12:00:00Z`)).toISOString(),
    instantIsReal: false,
  };
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
): CashFlowWalkResult {
  // An incomplete walk carries no rows at all. Returning what it managed to
  // read would invite a caller to publish a partial ledger.
  return {
    complete: false,
    incompleteReason: reason,
    detail,
    pagesRead,
    scanned: 0,
    rows: [],
    windowFrom: EPOCH_START,
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
export async function fetchCashActivities(
  apiKey: string,
  apiSecret: string,
  mode: Mode,
  since?: string,
): Promise<CashFlowWalkResult> {
  const options = { since };
  const etDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  });
  const rows = new Map<
    string,
    { external_id: string; flow_date: string; amount: number; kind: string }
  >();
  /** Every activity the walk looked at, window or not. */
  let scanned = 0;

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
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
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
      scanned++;
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

      // A real timestamp is held to the clock: five minutes of skew, no more.
      // Seven hours ahead is not a scheduled transfer, it is a broken feed.
      if (
        occurred.instantIsReal &&
        Date.parse(occurred.instant) - nowMs > ACTIVITY_CLOCK_SKEW_TOLERANCE_MS
      ) {
        return incomplete(
          "FUTURE_DATED_ACTIVITY",
          `Alpaca activity ${id} is timestamped ${occurred.instant}, more than five minutes ahead of this server, so the activity feed cannot be trusted.`,
          pagesRead,
        );
      }
      // A date-only activity has no time of day to compare, so it is held to
      // the calendar instead: it may not be dated after today's ET session.
      if (!occurred.instantIsReal && occurred.date > latestAllowedDate) {
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

      // Only a genuine timestamp is reported as one; a fabricated midday
      // instant must never be handed to a caller that will clock-check it.
      if (
        occurred.instantIsReal &&
        (latestActivityAt === null || occurred.instant > latestActivityAt)
      ) {
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
        external_id: id,
        flow_date: occurred.date,
        amount: Math.round(amount * 100) / 100,
        kind: amount > 0 ? "deposit" : "withdrawal",
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

  // The walk writes nothing. Its rows go to `publish_broker_refresh` together
  // with the portfolio history, so both mirrors move in one transaction under
  // one generation — a walk that wrote as it went could not be combined with
  // anything else atomically, and its partial output is exactly what a
  // reconciliation misreads as a retraction.
  return {
    complete: true,
    incompleteReason: null,
    detail: null,
    pagesRead,
    scanned,
    rows: [...rows.values()],
    windowFrom: baselineDate ?? EPOCH_START,
    latestActivityAt,
  };
}
