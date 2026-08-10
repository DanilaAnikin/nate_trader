import "server-only";

/**
 * Read every row of a Supabase query, with completeness that is proven rather
 * than assumed.
 *
 * PostgREST silently caps a response (1000 rows by default on Supabase). A
 * single `.select()` therefore returns a *truncated* history without any error,
 * which for an equity curve or a cash-flow ledger is not a smaller answer — it
 * is a wrong one. Two years of daily snapshots already exceed 500 rows and an
 * active account's ledger grows without bound.
 *
 * This reader walks explicit ranges until it sees a short page, and fails
 * closed if it would have to give up early. The caller must apply a **total**
 * ordering (a unique column, or a tie-breaker on one): range pagination over a
 * non-deterministic order can repeat and skip rows between pages.
 */

/** Supabase's own default cap; asking for more per page gains nothing. */
export const SUPABASE_PAGE_SIZE = 1000;

/**
 * 50 pages = 50 000 rows ≈ 190 years of daily equity, or a very busy ledger.
 * Reaching it means something is wrong, so it is an error rather than a
 * silently truncated answer.
 */
export const MAX_SUPABASE_PAGES = 50;

export type PagedFailure = "QUERY_FAILED" | "PAGE_LIMIT_REACHED";

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
}

/**
 * @param label     Human-readable name of the data being read, for messages.
 * @param fetchPage Runs one page. Must apply a total ordering *and*
 *                  `.range(from, to)` with the supplied bounds.
 */
export async function readAllRows<T>(
  label: string,
  fetchPage: (from: number, to: number) => PromiseLike<PageResponse<T>>,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_SUPABASE_PAGES; page++) {
    const from = page * SUPABASE_PAGE_SIZE;
    const { data, error } = await fetchPage(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) {
      return {
        ok: false,
        reason: "QUERY_FAILED",
        detail: `The ${label} query failed: ${error.message}`,
        pages: page + 1,
      };
    }
    const batch = data ?? [];
    rows.push(...batch);
    // A short page is the last page. A page that is exactly full may or may
    // not be, so another range is always requested.
    if (batch.length < SUPABASE_PAGE_SIZE) {
      return { ok: true, rows, pages: page + 1 };
    }
  }
  return {
    ok: false,
    reason: "PAGE_LIMIT_REACHED",
    detail: `More than ${MAX_SUPABASE_PAGES * SUPABASE_PAGE_SIZE} ${label} rows exist; the history could not be read completely.`,
    pages: MAX_SUPABASE_PAGES,
  };
}
