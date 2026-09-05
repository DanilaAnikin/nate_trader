"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The stored daily equity curve for one account, read from
 * `GET /api/accounts/[id]/equity` (side-effect free — it never refreshes the
 * broker mirrors). This is broker accounting for the selected account, not the
 * strategy's forward performance: it may contain pre-V11 history and must never
 * be relabelled as V11 alpha. Presentation layers say so.
 */

export interface EquitySnapshot {
  readonly date: string;
  readonly equity: number;
  readonly cash: number;
  readonly pnl: number | null;
  readonly pnl_pct: number | null;
  readonly num_positions: number | null;
}

export interface EquityCurve {
  readonly accountId: string;
  readonly capturedAt: string | null;
  readonly snapshots: EquitySnapshot[];
  readonly cashFlows: { date: string; amount: number }[];
}

export type EquityState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; curve: EquityCurve }
  | { kind: "error"; message: string };

/**
 * @param refreshKey — bump this (e.g. StatusProvider.lastRefreshedAt) to force a
 * re-fetch after Re-read/Sync. Without it the curve fetched once per account and
 * never updated, so "Sync broker data" wrote new snapshots the chart never showed.
 */
export function useAccountEquity(
  accountId: string | null,
  refreshKey?: string | number | null,
): EquityState {
  const [state, setState] = useState<EquityState>({ kind: "idle" });
  const requestRef = useRef(0);

  // The state transitions live in a callback, not the effect body, so the
  // fetch's loading/ready/error updates are not synchronous setState during the
  // effect (the same shape StatusProvider uses for its own refresh).
  const load = useCallback((id: string | null, signal: AbortSignal) => {
    if (!id) {
      setState({ kind: "idle" });
      return;
    }
    const requestId = ++requestRef.current;
    setState({ kind: "loading" });

    void (async () => {
      try {
        const response = await fetch(`/api/accounts/${id}/equity`, {
          cache: "no-store",
          signal,
        });
        const body = (await response.json().catch(() => null)) as
          | (EquityCurve & { error?: string })
          | null;
        if (requestRef.current !== requestId) return;
        if (!response.ok || !body || body.accountId !== id) {
          setState({
            kind: "error",
            message: body?.error ?? "The equity curve could not be loaded.",
          });
          return;
        }
        setState({
          kind: "ready",
          curve: {
            accountId: body.accountId,
            capturedAt: body.capturedAt ?? null,
            snapshots: Array.isArray(body.snapshots) ? body.snapshots : [],
            cashFlows: Array.isArray(body.cashFlows) ? body.cashFlows : [],
          },
        });
      } catch (caught) {
        if (signal.aborted || requestRef.current !== requestId) return;
        setState({
          kind: "error",
          message: caught instanceof Error ? caught.message : "Equity request failed.",
        });
      }
    })();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred to a microtask so the transition is not a synchronous setState
    // during the effect (mirrors StatusProvider's refresh scheduling).
    void Promise.resolve().then(() => load(accountId, controller.signal));
    return () => controller.abort();
  }, [accountId, refreshKey, load]);

  return state;
}
