import "server-only";

/**
 * Read every row of a Supabase query, with completeness that is *proven*.
 *
 * PostgREST truncates a response silently. For an equity curve or a cash-flow
 * ledger that is not a smaller answer, it is a wrong one — a clipped ledger
 * turns a deposit into profit.
 *
 * Two things the first implementation got wrong:
 *
 *   * **It assumed the cap was 1000** and treated a shorter page as the end.
 *     The cap is server configuration (`db-max-rows`) and is commonly lower; a
 *     server capping at 100 would end the walk after one page while looking
 *     perfectly healthy. Completeness is now decided by the server's own
 *     `count: "exact"`, which ignores the range entirely.
 *
 *   * **It paged by offset.** Offsets are positions, not identities, so a row
 *     inserted or deleted *before* the cursor shifts everything after it and a
 *     row can be read twice or skipped entirely — and a skip is invisible when
 *     an insert and a delete cancel out in the count. This reader pages by
 *     **key** instead: each page asks for rows strictly after the last key it
 *     received, in a total order. Nothing before the cursor can move a row that
 *     has not been read yet, so a skip is impossible by construction.
 *
 * What remains is a genuine mid-walk change, and that is failed closed rather
 * than returned as a torn snapshot: the exact count must not move between
 * pages, no key may repeat, and the rows read must equal the count.
 */

/** What each page asks for. The server may return fewer; that is expected. */
export const REQUEST_PAGE_SIZE = 1000;

/**
 * Enough pages for 50 000 rows at the smallest plausible server cap (100),
 * which is ~190 years of daily equity. Reaching it is an error, never a
 * silently truncated answer.
 */
export const MAX_PAGES = 500;

/**
 * A `bigint` primary key as a sortable string.
 *
 * The cursor is compared with `>` as text, so `"9"` would otherwise sort after
 * `"10"` and the walk would stop one row in. Zero-padding to 19 digits keeps
 * string order and numeric order identical for every value a PostgreSQL
 * `bigint` can hold.
 */
export function cashFlowKey(id: number | string): string {
  return String(id).padStart(19, "0");
}

export type PagedFailure =
  | "QUERY_FAILED"
  | "NO_EXACT_COUNT"
  | "CONCURRENT_MODIFICATION"
  | "PAGE_LIMIT_REACHED"
  | "SHORT_READ";

export type PagedResult<T> =
  | { readonly ok: true; readonly rows: T[]; readonly pages: number }
  | {
      readonly ok: false;
      readonly reason: PagedFailure;
      readonly detail: string;
      readonly pages: number;
    };

interface PageResponse<T> {
  data: T[] | null;
  error: { message: string } | null;
  /** `count: "exact"` result — the total matching the filter, ignoring paging. */
  count?: number | null;
}

/**
 * @param label     Human-readable name of the data, for messages.
 * @param fetchPage Runs one page. Must request `{ count: "exact" }`, order
 *                  ascending by a **unique** column, apply
 *                  `.gt(column, after)` when `after` is non-null, and limit the
 *                  result. `after` is the key of the last row already read.
 * @param keyOf     That same unique column's value for a row. It is both the
 *                  cursor and the duplicate check, so it must be a total order.
 */
export async function readAllRows<T>(
  label: string,
  fetchPage: (after: string | null, limit: number) => PromiseLike<PageResponse<T>>,
  keyOf: (row: T) => string,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let expected: number | null = null;
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error, count } = await fetchPage(cursor, REQUEST_PAGE_SIZE);
    if (error) {
      return {
        ok: false,
        reason: "QUERY_FAILED",
        detail: `The ${label} query failed: ${error.message}`,
        pages: page + 1,
      };
    }
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      // Without the server's own total there is no way to say the read is
      // complete, and guessing from page sizes is exactly what this replaces.
      return {
        ok: false,
        reason: "NO_EXACT_COUNT",
        detail: `The ${label} query returned no exact row count, so completeness cannot be proven.`,
        pages: page + 1,
      };
    }
    if (expected === null) {
      expected = count;
    } else if (count !== expected) {
      return {
        ok: false,
        reason: "CONCURRENT_MODIFICATION",
        detail: `The ${label} table changed while it was being read (${expected} rows, then ${count}); the result would be a torn snapshot.`,
        pages: page + 1,
      };
    }

    if (expected === 0) return { ok: true, rows, pages: page + 1 };

    const batch = data ?? [];
    if (batch.length === 0) {
      // The count says rows remain, but nothing came back after the cursor.
      return {
        ok: false,
        reason: "SHORT_READ",
        detail: `The ${label} query reported ${expected} rows but stopped returning them after ${rows.length}.`,
        pages: page + 1,
      };
    }

    for (const row of batch) {
      const key = keyOf(row);
      if (seen.has(key)) {
        return {
          ok: false,
          reason: "CONCURRENT_MODIFICATION",
          detail: `The ${label} query returned row ${key} twice, so the pages do not describe one consistent snapshot.`,
          pages: page + 1,
        };
      }
      seen.add(key);
      cursor = key;
    }
    rows.push(...batch);

    if (rows.length > expected) {
      // More rows exist than the count promised: something was inserted after
      // the cursor mid-walk, so the pages span two different states.
      return {
        ok: false,
        reason: "CONCURRENT_MODIFICATION",
        detail: `The ${label} query returned ${rows.length} rows for an exact count of ${expected}.`,
        pages: page + 1,
      };
    }
    if (rows.length === expected) return { ok: true, rows, pages: page + 1 };
  }

  return {
    ok: false,
    reason: "PAGE_LIMIT_REACHED",
    detail: `The ${label} history needed more than ${MAX_PAGES} pages; it could not be read completely.`,
    pages: MAX_PAGES,
  };
}
