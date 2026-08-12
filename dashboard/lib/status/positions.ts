/**
 * `positions.json` from the private runtime artifact.
 *
 * The runtime contract has always *required* this file — the artifact is
 * refused without it — but nothing ever read it. So "the runtime artifact is
 * complete" was established by the file being present and parseable as JSON,
 * while its contents could say anything at all: a short position, a zero
 * quantity, a count that contradicts `performance.num_positions`, or a
 * timestamp from a different cycle.
 *
 * That matters because a short is the one state the V11 safety rules treat as
 * blocking everything else. A runtime artifact recording one, presented as
 * evidence that the cycle was healthy, is the exact inversion the gate exists
 * to prevent.
 *
 * Atomic, like every other runtime parser here: either the whole document is
 * understood or nothing is returned. A partially readable position list is a
 * shorter position list, and a shorter one reads as a calmer account.
 */

import { isRecord } from "./parse";
import { normalizeInstant } from "./vocab";

/** One open position, as `scripts/portfolio.py::get_positions` writes it. */
export interface PositionSnapshot {
  readonly symbol: string;
  readonly qty: number;
  readonly avgEntryPrice: number;
  readonly currentPrice: number;
  readonly marketValue: number;
  readonly unrealizedPl: number;
  readonly unrealizedPlPct: number;
  /** Normalized from Alpaca's `PositionSide.LONG` / `"long"` spellings. */
  readonly side: "long" | "short";
}

export interface PositionsRuntimeSnapshot {
  readonly updatedAt: string;
  readonly positions: readonly PositionSnapshot[];
  /** True when every position is long. A short blocks everything in V11. */
  readonly allLong: boolean;
}

/**
 * The most positions a V11 runtime state may carry.
 *
 * The policy selects at most ten names. Held exits can briefly add to that,
 * so the bound is generous — but a "position list" of a thousand rows is not
 * a V11 account, and a document this build cannot account for must not be
 * read as one.
 */
export const MAX_POSITIONS = 64;

/** A US equity ticker as the universe admits them, including class suffixes. */
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * Alpaca's side, in both spellings the SDK produces.
 *
 * `str(p.side)` on an enum yields `"PositionSide.LONG"`; a plain string field
 * yields `"long"`. Anything else is a side this build cannot classify, and
 * "cannot classify" must not collapse to "long".
 */
function positionSide(value: unknown): "long" | "short" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/^positionside\./, "");
  if (normalized === "long") return "long";
  if (normalized === "short") return "short";
  return null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parsePositionsRuntime(
  value: unknown,
): PositionsRuntimeSnapshot | null {
  if (!isRecord(value)) return null;

  // The producer writes this from `get_now_str()` in the same cycle as
  // `performance.updated_at`. Without it the file cannot be placed in time at
  // all, which is the only thing that distinguishes it from a restored one.
  const updatedAt = normalizeInstant(value.updated_at);
  if (updatedAt === null) return null;

  const raw = value.positions;
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_POSITIONS) return null;

  const positions: PositionSnapshot[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return null;

    const symbol = typeof entry.symbol === "string" ? entry.symbol.trim().toUpperCase() : "";
    if (!SYMBOL_PATTERN.test(symbol)) return null;
    // Two rows for one symbol is not a position list; it is two of them, and
    // nothing says which is current.
    if (seen.has(symbol)) return null;
    seen.add(symbol);

    const qty = finite(entry.qty);
    const avgEntryPrice = finite(entry.avg_entry_price);
    const currentPrice = finite(entry.current_price);
    const marketValue = finite(entry.market_value);
    const unrealizedPl = finite(entry.unrealized_pl);
    const unrealizedPlPct = finite(entry.unrealized_plpc);
    if (
      qty === null ||
      avgEntryPrice === null ||
      currentPrice === null ||
      marketValue === null ||
      unrealizedPl === null ||
      unrealizedPlPct === null
    ) {
      return null;
    }
    // The producer refuses these upstream (`get_positions` raises), so a
    // document carrying one did not come from the producer this build knows.
    if (qty === 0) return null;
    if (avgEntryPrice <= 0 || currentPrice <= 0) return null;

    const side = positionSide(entry.side);
    if (side === null) return null;
    // The sign of the quantity and the stated side must agree. A negative
    // quantity labelled `long` is a document describing two different
    // positions, and the safe reading of a disagreement about direction is
    // that the direction is unknown.
    if (side === "long" && qty < 0) return null;
    if (side === "short" && qty > 0) return null;

    positions.push({
      symbol,
      qty,
      avgEntryPrice,
      currentPrice,
      marketValue,
      unrealizedPl,
      unrealizedPlPct,
      side,
    });
  }

  positions.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    updatedAt,
    positions,
    allLong: positions.every((position) => position.side === "long"),
  };
}
