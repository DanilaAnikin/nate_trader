import { NextResponse } from "next/server";
import { fetchStateFile } from "@/lib/github";

/**
 * Returns the full payload for a specific archived backtest run.
 *
 * GET /api/backtest/runs/{id}
 *
 * `id` is validated against a strict pattern (kind + timestamp) before
 * we hit GitHub, both to short-circuit obvious junk and to avoid any
 * path-traversal weirdness in the filename we construct.
 */

export const revalidate = 600; // archived runs are immutable, cache freely

const ID_REGEX = /^[a-z_]+_\d{8}_\d{6}$/;

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!id || !ID_REGEX.test(id)) {
    return NextResponse.json(
      { error: `Invalid run id: ${id}` },
      { status: 400 }
    );
  }
  const data = await fetchStateFile<unknown>(`backtest/runs/${id}.json`);
  if (!data) {
    return NextResponse.json(
      { error: `Run ${id} not found in archive` },
      { status: 404 }
    );
  }
  return NextResponse.json(data);
}
