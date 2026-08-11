import "server-only";
import type { Database } from "@/lib/database.types";
import { isCalendarDate, parseRfc3339 } from "@/lib/calendar-date";

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
 * Every non-trade activity type Alpaca documents, classified explicitly.
 *
 * An allowlist of four cash types was the previous approach, and it was wrong
 * in the one direction that loses money silently. The walk requested only the
 * types it knew, so an activity type it had never heard of — a new transfer
 * mechanism, a corporate action that moves cash, anything Alpaca adds later —
 * was simply not returned, and the walk declared itself complete without it.
 * A closed allowlist cannot see what it does not ask for.
 *
 * So the walk now requests **no** `activity_types` filter at all: it reads the
 * whole non-trade feed and classifies every row. Three outcomes:
 *
 *   * `cash` — an external cash movement, mirrored into `cash_flows`;
 *   * `non-cash-transfer` — moves securities with no cash leg, which makes
 *     return unattributable rather than approximate, so it is fatal;
 *   * `internal` — a strategy-caused P/L event (a fill, a dividend, interest).
 *     These belong to the return and are deliberately *not* cash flows.
 *
 * Anything not in this table is `UNKNOWN_ACTIVITY_TYPE`: unrecognised is not
 * the same as irrelevant, and the only safe reading of a type this build has
 * never seen is that it might move money.
 */
type ActivityClass = "cash" | "non-cash-transfer" | "internal";

const ACTIVITY_CLASSIFICATION: Readonly<Record<string, ActivityClass>> = {
  // --- external cash ------------------------------------------------------
  CSD: "cash", // cash deposit
  CSW: "cash", // cash withdrawal
  JNLC: "cash", // journal of cash between accounts
  ACATC: "cash", // ACAT cash transfer
  CFEE: "cash", // credit/administrative fee charged to the account
  FEE: "cash", // generic fee
  WIRE: "cash", // wire transfer in or out

  // --- external movement of securities, no cash leg -----------------------
  ACATS: "non-cash-transfer", // ACAT securities transfer
  JNLS: "non-cash-transfer", // journal of shares between accounts
  FOPT: "non-cash-transfer", // option position adjustment
  CSR: "non-cash-transfer", // cash receipt from a spin-off/share issue
  MA: "non-cash-transfer", // merger or acquisition
  NC: "non-cash-transfer", // name change
  REORG: "non-cash-transfer", // reorganisation
  SSO: "non-cash-transfer", // stock spin-off
  SSP: "non-cash-transfer", // stock split
  SPIN: "non-cash-transfer", // spin-off
  SPLIT: "non-cash-transfer", // split

  // --- internal: the strategy's own P/L, already inside the equity curve ---
  FILL: "internal",
  DIV: "internal",
  DIVCGL: "internal",
  DIVCGS: "internal",
  DIVFEE: "internal",
  DIVFT: "internal",
  DIVNRA: "internal",
  DIVROC: "internal",
  DIVTW: "internal",
  DIVTXEX: "internal",
  INT: "internal",
  INTNRA: "internal",
  INTTW: "internal",
  PTC: "internal", // pass-through charge
  PTR: "internal", // pass-through rebate
  SC: "internal", // symbol change
  SWP: "internal", // sweep
  OPASN: "internal",
  OPEXP: "internal",
  OPXRC: "internal",
};

function classifyActivity(type: string): ActivityClass | null {
  return ACTIVITY_CLASSIFICATION[type] ?? null;
}

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
  | "UNKNOWN_ACTIVITY_TYPE"
  | "NON_CASH_EXTERNAL_TRANSFER"
  | "FUTURE_DATED_ACTIVITY"
  | "NO_PAGINATION_TOKEN"
  | "PAGINATION_STALLED"
  | "BROKER_UNREACHABLE"
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
  /**
   * Activities examined, including ones outside the window.
   *
   * This is *evidence*, not a statistic: it is how the database distinguishes
   * "this account genuinely has no cash activities" from "the broker returned
   * an empty page". It is only ever non-zero on a walk that finished.
   */
  readonly scanned: number;
  /** True only when the walk ended on an explicit empty page. */
  readonly sawEmptyTerminalPage: boolean;
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
  if (isCalendarDate(iso)) return iso;
  const parsed = parseRfc3339(iso);
  if (parsed === null) return null;
  return etDate.format(new Date(parsed));
}

/**
 * A rejected `fetch` says why in several different shapes.
 *
 * `AbortSignal.timeout` throws a `TimeoutError` DOMException; an explicit
 * abort throws `AbortError`; DNS, TLS and connection failures throw a
 * `TypeError` whose real reason is on `cause`. All of them must produce a
 * named, human-readable outcome rather than an unhandled rejection.
 */
export function describeFetchFailure(caught: unknown): string {
  if (caught instanceof DOMException) {
    if (caught.name === "TimeoutError") return "the request timed out";
    if (caught.name === "AbortError") return "the request was aborted";
    return caught.name;
  }
  if (caught instanceof Error) {
    const cause = (caught as { cause?: unknown }).cause;
    const causeMessage =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : null;
    return causeMessage ? `${caught.message} (${causeMessage})` : caught.message;
  }
  return "an unknown network failure";
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
    sawEmptyTerminalPage: false,
    rows: [],
    windowFrom: EPOCH_START,
    latestActivityAt: null,
  };
}

/**
 * Read the account's entire non-trade activity feed and classify every row.
 *
 * Without these rows a $10k deposit looks like $10k of profit, so time-weighted
 * return depends on them being *complete*. Every activity must be fully usable:
 * a missing id, timestamp or type, an unparseable amount, or a type this build
 * does not recognise makes the whole walk incomplete rather than being skipped
 * — a silently dropped deposit is exactly the failure this guards.
 *
 * **Termination is by an explicit empty page, never by a short one.**
 * `page_size` is a maximum, not a contract: a broker under load, a filtered
 * page, or a page boundary that happens to fall short all produce fewer rows
 * than requested while more data remains. Treating that as EOF ends the walk
 * early, and an early end is indistinguishable downstream from "the account
 * has no older activities" — which is how a truncated ledger gets published as
 * a complete one. The walk therefore continues until Alpaca returns `[]`, and
 * separately proves it is making progress: the page token must advance, and a
 * page whose ids were all seen before is a loop, not a page.
 *
 * Read-only against the broker; no database access at all.
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

  /** Page tokens already requested, so a repeated one is recognised as a loop. */
  const tokensUsed = new Set<string>();
  let sawEmptyTerminalPage = false;

  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    // No `activity_types` filter: a closed allowlist cannot return a type it
    // was never told to ask for, and an unrequested cash movement is exactly
    // what must not be missed. Everything is read and classified below.
    const query = new URLSearchParams({
      page_size: String(ACTIVITY_PAGE_SIZE),
      direction: "desc",
    });
    if (pageToken) query.set("page_token", pageToken);

    let res: Response;
    try {
      res = await fetch(`${ALPACA_BASE[mode]}/account/activities?${query}`, {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": apiSecret,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch (caught) {
      // A rejected fetch is a timeout, an abort, a DNS or TLS failure, or a
      // dropped connection. It used to propagate as an unhandled rejection and
      // surface as a raw 500; it is an ordinary incomplete walk.
      return incomplete(
        "BROKER_UNREACHABLE",
        `The Alpaca activity feed could not be reached: ${describeFetchFailure(caught)}.`,
        pagesRead,
      );
    }
    if (!res.ok) {
      return incomplete(
        "BROKER_UNREACHABLE",
        `Alpaca activities returned HTTP ${res.status}.`,
        pagesRead,
      );
    }

    let activities: unknown;
    try {
      activities = await res.json();
    } catch {
      return incomplete(
        "MALFORMED_ACTIVITY",
        "An Alpaca activities page was not valid JSON.",
        pagesRead,
      );
    }
    if (!Array.isArray(activities)) {
      return incomplete(
        "MALFORMED_ACTIVITY",
        "Alpaca activities returned a payload that is not an array.",
        pagesRead,
      );
    }
    pagesRead++;

    // The only EOF this walk accepts.
    if (activities.length === 0) {
      complete = true;
      sawEmptyTerminalPage = true;
      break;
    }

    let lastId: string | null = null;
    let freshOnThisPage = 0;
    for (const raw of activities as Activity[]) {
      const activity = raw;
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

      const activityClass = classifyActivity(type);
      if (activityClass === null) {
        return incomplete(
          "UNKNOWN_ACTIVITY_TYPE",
          `Alpaca returned activity type ${type}, which this build does not classify. An unrecognised type may move cash or securities, so the ledger cannot be proven complete without it.`,
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
      freshOnThisPage++;

      // An internal P/L event — a fill, a dividend, interest — is already
      // inside the equity curve. It is understood, and deliberately not a flow.
      if (activityClass === "internal") continue;

      // Activities before the baseline are read (they prove nothing was
      // re-dated across the boundary) but belong to the pre-V11 era, so they
      // are neither written nor counted.
      if (baselineDate !== null && occurred.date < baselineDate) continue;

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
      if (activityClass === "non-cash-transfer") {
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

    // A non-empty page must produce a usable cursor, or there is no way to
    // reach what is behind it.
    if (!lastId) {
      return incomplete(
        "NO_PAGINATION_TOKEN",
        "A page of activities produced no usable pagination id, so older activities cannot be reached.",
        pagesRead,
      );
    }
    // Progress, proved two ways: the cursor must move, and the page must have
    // shown something new. A repeated token or an all-duplicate page means the
    // feed is looping, and looping until MAX_ACTIVITY_PAGES would report
    // PAGE_LIMIT_REACHED for what is really a broken cursor.
    if (tokensUsed.has(lastId)) {
      return incomplete(
        "PAGINATION_STALLED",
        `The Alpaca activity cursor returned to ${lastId} instead of advancing, so the walk cannot reach older activities.`,
        pagesRead,
      );
    }
    if (freshOnThisPage === 0) {
      return incomplete(
        "PAGINATION_STALLED",
        "An entire page of activities repeated ids already seen, so the cursor is not advancing.",
        pagesRead,
      );
    }
    tokensUsed.add(lastId);
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
    sawEmptyTerminalPage,
    rows: [...rows.values()],
    windowFrom: baselineDate ?? EPOCH_START,
    latestActivityAt,
  };
}
