/**
 * A minimal PostgREST-shaped query builder for tests.
 *
 * It exists for one reason: `.range()` must behave like the real thing. A mock
 * that ignores ranges and returns the whole array on every call makes a paging
 * bug invisible, and paging is exactly what the equity and cash-flow readers
 * must get right — Supabase caps a response at 1000 rows without an error.
 *
 * Filters (`eq`, `gte`, …) are accepted and ignored: a test controls the row
 * set directly. Ordering and slicing are real.
 */

export interface FakeQueryError {
  readonly message: string;
}

export interface FakeTableState<T> {
  rows: readonly T[];
  error?: FakeQueryError | null;
  /** Ranges the builder was actually asked for, in order. */
  ranges?: [number, number][];
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
  let from = 0;
  let to = Number.MAX_SAFE_INTEGER;

  const resolve = () => {
    if (state.error) return { data: null, error: state.error };
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
    rows = rows.slice(from, to + 1);
    return { data: rows, error: null };
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
    range(start: number, end: number) {
      from = start;
      to = end;
      state.ranges?.push([start, end]);
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
      onFulfilled: (value: { data: T[] | null; error: FakeQueryError | null }) => R,
    ): Promise<R> {
      return Promise.resolve(resolve()).then(onFulfilled);
    },
  };
  return builder;
}
