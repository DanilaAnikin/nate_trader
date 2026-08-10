import { describe, expect, it } from "vitest";
import { readAllRows, REQUEST_PAGE_SIZE } from "./paged";

/**
 * Completeness has to be proven, not inferred from page sizes. The original
 * reader assumed the server cap was 1000 and treated a shorter page as the end;
 * both halves of that are wrong, and the consequence is a silently truncated
 * equity curve or cash-flow ledger that still looks healthy.
 */

interface Row {
  id: number;
}

/** The unique ordering key, zero-padded so string order matches numeric order. */
const key = (row: Row) => String(row.id).padStart(9, "0");

function rows(count: number, from = 0): Row[] {
  return Array.from({ length: count }, (_, index) => ({ id: from + index }));
}

/**
 * A PostgREST-shaped server with its own row cap, exactly like `db-max-rows`.
 * It answers a keyset page — rows strictly after `after`, ascending — and
 * reports the exact count of everything matching the filter regardless of
 * paging, which is what makes completeness decidable.
 */
function server(options: {
  data: Row[];
  cap?: number;
  /** Called before each page, so a test can mutate the table mid-walk. */
  beforePage?: (page: number, table: Row[]) => void;
}) {
  const table = [...options.data];
  const cap = options.cap ?? REQUEST_PAGE_SIZE;
  const cursors: (string | null)[] = [];
  let page = 0;
  const fetchPage = async (after: string | null, limit: number) => {
    options.beforePage?.(page++, table);
    cursors.push(after);
    const ordered = [...table].sort((a, b) => key(a).localeCompare(key(b)));
    const remaining =
      after === null ? ordered : ordered.filter((row) => key(row) > after);
    return {
      data: remaining.slice(0, Math.min(limit, cap)),
      error: null,
      count: table.length,
    };
  };
  return { fetchPage, cursors, table };
}

describe("readAllRows", () => {
  it("reads a single short page", async () => {
    const { fetchPage, cursors } = server({ data: rows(3) });
    const result = await readAllRows("test", fetchPage, (row) => String(row.id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(3);
    expect(cursors).toEqual([null]);
  });

  it("returns an empty result for an empty table without a second page", async () => {
    const { fetchPage, cursors } = server({ data: [] });
    const result = await readAllRows("test", fetchPage, (row) => String(row.id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([]);
    expect(cursors).toHaveLength(1);
  });

  // The important one: a server that caps far below what we ask for.
  it("keeps reading when the server caps a page at 100", async () => {
    const table = Array.from({ length: 250 }, (_, index) => ({ id: index }));
    const { fetchPage, cursors } = server({ data: table, cap: 100 });
    const result = await readAllRows("test", fetchPage, key,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(250);
    // Each page resumes from the last key actually received, not from a guess.
    expect(cursors).toHaveLength(3);
    expect(cursors[0]).toBeNull();
  });

  it("keeps reading when the cap is exactly the table size", async () => {
    // The old "a page shorter than the page size means the end" rule reported
    // 100 of 100 as complete only by luck; here a full page is the whole table
    // and the count is what confirms it.
    const { fetchPage } = server({ data: rows(100), cap: 100 });
    const result = await readAllRows("test", fetchPage, (row) => String(row.id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(100);
  });

  it("fails closed when the server reports no exact count", async () => {
    const result = await readAllRows(
      "test",
      async () => ({ data: rows(10), error: null, count: null }),
      key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NO_EXACT_COUNT");
  });

  it("propagates a query error", async () => {
    const result = await readAllRows(
      "test",
      async () => ({
        data: null,
        error: { message: "connection reset" },
        count: null,
      }),
      key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("QUERY_FAILED");
    expect(result.detail).toContain("connection reset");
  });

  it("refuses a torn snapshot when a row is inserted between pages", async () => {
    // A concurrent writer is exactly the case a "read until short page" walk
    // cannot detect: it would return a mixture of two states and call it whole.
    const table = Array.from({ length: 150 }, (_, index) => ({ id: index }));
    const { fetchPage } = server({
      data: table,
      cap: 100,
      beforePage: (page, live) => {
        if (page === 1) live.push({ id: 9_999 });
      },
    });
    const result = await readAllRows("test", fetchPage, key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("CONCURRENT_MODIFICATION");
    expect(result.detail).toContain("150 rows, then 151");
  });

  it("refuses a torn snapshot when a row is deleted between pages", async () => {
    const table = Array.from({ length: 150 }, (_, index) => ({ id: index }));
    const { fetchPage } = server({
      data: table,
      cap: 100,
      beforePage: (page, live) => {
        if (page === 1) live.shift();
      },
    });
    const result = await readAllRows("test", fetchPage, key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("CONCURRENT_MODIFICATION");
  });

  it("catches a same-size reshuffle the count alone would miss", async () => {
    // An insert plus a delete keeps the count identical. Under offset paging
    // this silently *skips* a row; under keyset paging the already-read row
    // stays read and the new one is extra, so the totals no longer agree.
    const table = Array.from({ length: 150 }, (_, index) => ({ id: index }));
    const { fetchPage } = server({
      data: table,
      cap: 100,
      beforePage: (page, live) => {
        if (page === 1) {
          live.shift();
          live.push({ id: 9_999 });
        }
      },
    });
    const result = await readAllRows("test", fetchPage, key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("CONCURRENT_MODIFICATION");
  });

  it("cannot skip a row when an earlier one is deleted mid-walk", async () => {
    // The failure offset paging cannot see at all: deleting a row that was
    // already read shifts every later row down one position, so the first row
    // of the next page is never returned. Keyset paging is immune.
    const table = Array.from({ length: 150 }, (_, index) => ({ id: index }));
    const { fetchPage } = server({
      data: table,
      cap: 100,
      beforePage: (page, live) => {
        if (page === 1) live.shift();
      },
    });
    const result = await readAllRows("test", fetchPage, key,
    );
    // The count moved, so this is refused — but note what did *not* happen:
    // no row between the pages was silently dropped.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("CONCURRENT_MODIFICATION");
  });

  it("fails closed when the count promises rows the server stops returning", async () => {
    let call = 0;
    const result = await readAllRows<Row>(
      "test",
      async () => {
        call++;
        return { data: call === 1 ? rows(100) : [], error: null, count: 250 };
      },
      key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("SHORT_READ");
  });

  it("fails closed rather than looping forever", async () => {
    // One row per page against a very large count exhausts the page budget.
    let next = 0;
    const result = await readAllRows<Row>(
      "test",
      async () => ({ data: [{ id: next++ }], error: null, count: 1_000_000 }),
      key,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("PAGE_LIMIT_REACHED");
  });
});
