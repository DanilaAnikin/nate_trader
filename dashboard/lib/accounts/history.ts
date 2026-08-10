import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

/**
 * Read an account's equity curve and cash-flow ledger from ONE database
 * snapshot.
 *
 * This replaces a client-side page walk. That walk was careful — keyset
 * cursor, exact count, duplicate detection — and still could not deliver what
 * a return calculation needs, because several HTTP requests are several MVCC
 * snapshots. Between two pages the database may change, and the most damaging
 * change is invisible to every client-side check: an **UPDATE to a row already
 * read** leaves the count unchanged, repeats no key and skips nothing, so the
 * walk returns a value that no longer exists and reports success.
 *
 * `account_history_snapshot` is a `STABLE` function, so every query in its
 * body observes the snapshot of the calling statement. One request, one
 * snapshot, both datasets — and the snapshot token comes back with them so a
 * result can be audited to the state it came from.
 */

type Service = SupabaseClient<Database>;

export interface HistoryEquityPoint {
  readonly date: string;
  readonly equity: number;
  readonly cash: number | null;
  readonly profitLoss: number | null;
  readonly profitLossPct: number | null;
  readonly numPositions: number | null;
}

export interface HistoryCashFlow {
  /** `bigint` as text: a JSON number would lose precision above 2^53. */
  readonly id: string;
  readonly date: string;
  readonly amount: number;
  readonly kind: string | null;
  readonly source: string | null;
}

export interface AccountHistory {
  readonly equity: readonly HistoryEquityPoint[];
  readonly cashFlows: readonly HistoryCashFlow[];
  /** The database snapshot the two datasets were read in. */
  readonly snapshot: string;
  readonly capturedAt: string;
}

export type HistoryFailure =
  | "ACCOUNT_NOT_FOUND"
  | "HISTORY_TOO_LARGE"
  | "QUERY_FAILED"
  | "MALFORMED_SNAPSHOT";

export type HistoryResult =
  | { readonly ok: true; readonly history: AccountHistory }
  | {
      readonly ok: false;
      readonly reason: HistoryFailure;
      readonly detail: string;
    };

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param from Inclusive lower bound on the session/flow date, or null for the
 *             account's whole history.
 */
export async function readAccountHistory(
  svc: Service,
  accountId: string,
  ownerId: string,
  from: string | null,
): Promise<HistoryResult> {
  const { data, error } = await svc.rpc("account_history_snapshot", {
    p_account: accountId,
    p_owner: ownerId,
    p_from: from,
  });

  if (error) {
    if (error.code === "P0002") {
      return {
        ok: false,
        reason: "ACCOUNT_NOT_FOUND",
        detail: "The account could not be read for this owner.",
      };
    }
    // The function raises this rather than materialising an unbounded history.
    if (/snapshot limit/.test(error.message)) {
      return {
        ok: false,
        reason: "HISTORY_TOO_LARGE",
        detail: `The account history is too large to read in one consistent snapshot: ${error.message}`,
      };
    }
    return {
      ok: false,
      reason: "QUERY_FAILED",
      detail: `The account history snapshot failed: ${error.message}`,
    };
  }

  const payload = data as Record<string, unknown> | null;
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      reason: "MALFORMED_SNAPSHOT",
      detail: "The account history snapshot returned no payload.",
    };
  }
  const snapshot = typeof payload.snapshot === "string" ? payload.snapshot : "";
  const capturedAt =
    typeof payload.captured_at === "string" ? payload.captured_at : "";
  if (!snapshot || !capturedAt) {
    return {
      ok: false,
      reason: "MALFORMED_SNAPSHOT",
      detail: "The account history snapshot carries no snapshot identity.",
    };
  }

  const rawEquity = Array.isArray(payload.equity) ? payload.equity : null;
  const rawFlows = Array.isArray(payload.cash_flows) ? payload.cash_flows : null;
  if (!rawEquity || !rawFlows) {
    return {
      ok: false,
      reason: "MALFORMED_SNAPSHOT",
      detail: "The account history snapshot is not shaped as two arrays.",
    };
  }

  // The function reports its own counts; if the payload disagrees, the result
  // is not the consistent snapshot it claims to be.
  const equityCount = num(payload.equity_count);
  const flowCount = num(payload.cash_flow_count);
  if (equityCount !== rawEquity.length || flowCount !== rawFlows.length) {
    return {
      ok: false,
      reason: "MALFORMED_SNAPSHOT",
      detail: `The snapshot reports ${equityCount}/${flowCount} rows but carries ${rawEquity.length}/${rawFlows.length}.`,
    };
  }

  const equity: HistoryEquityPoint[] = [];
  for (const row of rawEquity as Record<string, unknown>[]) {
    const date = typeof row.date === "string" ? row.date : "";
    const value = num(row.equity);
    if (!ISO_DATE.test(date) || value === null) {
      return {
        ok: false,
        reason: "MALFORMED_SNAPSHOT",
        detail: "An equity observation has no usable date or value.",
      };
    }
    equity.push({
      date,
      equity: value,
      cash: num(row.cash),
      profitLoss: num(row.profit_loss),
      profitLossPct: num(row.profit_loss_pct),
      numPositions: num(row.num_positions),
    });
  }

  const cashFlows: HistoryCashFlow[] = [];
  for (const row of rawFlows as Record<string, unknown>[]) {
    const id = typeof row.id === "string" ? row.id : "";
    const date = typeof row.date === "string" ? row.date : "";
    const amount = num(row.amount);
    if (!id || !ISO_DATE.test(date) || amount === null) {
      return {
        ok: false,
        reason: "MALFORMED_SNAPSHOT",
        detail: "A cash-flow row has no usable id, date or amount.",
      };
    }
    cashFlows.push({
      id,
      date,
      amount,
      kind: typeof row.kind === "string" ? row.kind : null,
      source: typeof row.source === "string" ? row.source : null,
    });
  }

  return { ok: true, history: { equity, cashFlows, snapshot, capturedAt } };
}
