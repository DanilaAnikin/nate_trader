/**
 * A minimal PostgREST-shaped query builder for tests.
 *
 * It exists so paging behaves like the real thing. A mock that ignores the
 * cursor and returns the whole array on every call makes a paging bug
 * invisible, and paging is exactly what the equity and cash-flow readers must
 * get right — a server truncates a response silently.
 *
 * What is real: `gt` (the keyset cursor), `limit`, `order`, the server-side row
 * cap, and the exact count. What is ignored: `eq`/`gte`/`is` filters, because a
 * test controls the row set directly.
 */

export interface FakeQueryError {
  readonly message: string;
}

export interface FakeTableState<T> {
  rows: readonly T[];
  error?: FakeQueryError | null;
  /** Cursors the builder was actually asked for, in order. */
  cursors?: (string | number | null)[];
  /** The server's own per-response row cap, like `db-max-rows`. */
  cap?: number;
}

type Order = { column: string; ascending: boolean };

/**
 * Build a chainable query object over `state`. The state is read lazily on
 * await, so a test may mutate `rows` after wiring the mock.
 */
export function fakeTable<T extends Record<string, unknown>>(
  state: FakeTableState<T>,
) {
  const orders: Order[] = [];
  let cursorColumn: string | null = null;
  let cursorValue: string | number | null = null;
  let limit = Number.MAX_SAFE_INTEGER;

  const resolve = () => {
    if (state.error) return { data: null, error: state.error, count: null };
    let rows = [...state.rows];
    for (const order of [...orders].reverse()) {
      rows.sort((a, b) => {
        const left = a[order.column];
        const right = b[order.column];
        if (left === right) return 0;
        const cmp = (left as never) < (right as never) ? -1 : 1;
        return order.ascending ? cmp : -cmp;
      });
    }
    // The exact count ignores the cursor and the limit, exactly like
    // PostgREST's `count=exact`.
    const count = rows.length;
    if (cursorColumn !== null && cursorValue !== null) {
      rows = rows.filter(
        (row) => (row[cursorColumn!] as never) > (cursorValue as never),
      );
    }
    rows = rows.slice(0, Math.min(limit, state.cap ?? Number.MAX_SAFE_INTEGER));
    return { data: rows, error: null, count };
  };

  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    gte: () => builder,
    lte: () => builder,
    order(column: string, options?: { ascending?: boolean }) {
      orders.push({ column, ascending: options?.ascending !== false });
      return builder;
    },
    gt(column: string, value: string | number) {
      cursorColumn = column;
      cursorValue = value;
      state.cursors?.push(value);
      return builder;
    },
    limit(count: number) {
      limit = count;
      return builder;
    },
    maybeSingle: async () => {
      const { data, error } = resolve();
      return { data: data?.[0] ?? null, error };
    },
    single: async () => {
      const { data, error } = resolve();
      return { data: data?.[0] ?? null, error };
    },
    // Awaiting the builder itself runs the query, exactly like PostgREST.
    then<R>(
      onFulfilled: (value: {
        data: T[] | null;
        error: FakeQueryError | null;
        count: number | null;
      }) => R,
    ): Promise<R> {
      return Promise.resolve(resolve()).then(onFulfilled);
    },
  };
  return builder;
}
