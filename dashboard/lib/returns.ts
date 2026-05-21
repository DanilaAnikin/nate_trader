/**
 * Return math shared by the dashboard. The equity curve and period returns
 * must be cash-flow-adjusted: a $10k deposit is not $10k of profit.
 */

export type EquityPoint = { date: string; equity: number };

/**
 * Time-weighted return over an ordered equity series, excluding external cash
 * flows. `flows` maps a date to the net flow on that date (+ deposit /
 * − withdrawal). Returns a fraction (0.1 = +10%).
 */
export function twr(points: EquityPoint[], flows?: Map<string, number>): number {
  if (points.length < 2) return 0;
  let acc = 1;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].equity;
    if (prev <= 0) continue;
    const flow = flows?.get(points[i].date) ?? 0;
    const r = (points[i].equity - flow - prev) / prev;
    acc *= 1 + r;
  }
  return acc - 1;
}

/**
 * Plain end-vs-start return. Correct only when there are no cash flows in the
 * window; use `twr` when flows may be present.
 */
export function simpleReturn(points: EquityPoint[]): number {
  if (points.length < 2) return 0;
  const start = points[0].equity;
  const end = points[points.length - 1].equity;
  if (start <= 0) return 0;
  return end / start - 1;
}
