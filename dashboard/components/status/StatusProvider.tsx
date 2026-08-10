"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { isStrategyStatusPayload, type StatusIdentity } from "@/lib/status/client";
import {
  parseStatusError,
  performanceUrl,
  scopeStatusState,
  statusUrl,
  type ScopedStatusState,
  type StatusError,
  type StatusFetchStatus,
} from "@/lib/status/scope";
import type { StrategyStatusPayload } from "@/lib/status/types";
import type { PerformanceResponse } from "@/app/api/accounts/[id]/performance/route";

export type PerformanceState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; body: PerformanceResponse };

/**
 * Single client-side owner of the account-scoped V11 read model.
 *
 * Pages never fetch strategy data themselves, so no component can join two
 * sources with different accounts, releases or timestamps. In-flight requests
 * are aborted on account switch and every response is identity-checked before
 * it is published.
 */

interface StatusContextValue extends ScopedStatusState {
  readonly enabled: boolean;
  readonly selectedAccount: StatusIdentity | null;
  readonly refresh: () => Promise<boolean>;
  readonly lastRefreshedAt: string | null;
  /**
   * Forward performance shares this refresh cycle but keeps its own
   * provenance: it is a different source with a different freshness contract,
   * and the two are never merged client-side.
   */
  readonly performance: PerformanceState;
}

const StatusContext = createContext<StatusContextValue | null>(null);

export default function StatusProvider({
  enabled,
  selectedAccount,
  children,
}: {
  enabled: boolean;
  selectedAccount: StatusIdentity | null;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<StatusFetchStatus>(
    enabled ? (selectedAccount ? "loading" : "no-account") : "disabled",
  );
  const [data, setData] = useState<StrategyStatusPayload | null>(null);
  const [error, setError] = useState<StatusError | null>(null);
  const [requestAccountId, setRequestAccountId] = useState<string | null>(
    selectedAccount?.id ?? null,
  );
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [performance, setPerformance] = useState<{
    accountId: string;
    value: PerformanceState;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  const selectedId = selectedAccount?.id ?? null;
  const selectedNickname = selectedAccount?.nickname ?? null;
  const selectedMode = selectedAccount?.mode ?? null;

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    setData(null);
    setError(null);

    setPerformance(null);

    if (!enabled) {
      setRequestAccountId(null);
      setStatus("disabled");
      return false;
    }
    if (!selectedId || !selectedNickname || !selectedMode) {
      setRequestAccountId(null);
      setStatus("no-account");
      return false;
    }

    const expected: StatusIdentity = {
      id: selectedId,
      nickname: selectedNickname,
      mode: selectedMode,
    };
    setRequestAccountId(expected.id);
    const url = statusUrl(expected);
    if (!url) {
      setStatus("no-account");
      return false;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");

    // Same cycle, separate source. Started here so one Refresh click renews
    // both without a page reload; the result is tagged with the account it
    // belongs to so a switch cannot leave the previous account's number up.
    const performanceRequest = (async () => {
      const url = performanceUrl(expected);
      if (!url) return;
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => null)) as
          | PerformanceResponse
          | null;
        if (requestRef.current !== requestId) return;
        if (!response.ok || !body || body.accountId !== expected.id) {
          setPerformance({
            accountId: expected.id,
            value: {
              kind: "error",
              message:
                "Forward performance could not be loaded for the selected account.",
            },
          });
          return;
        }
        setPerformance({ accountId: expected.id, value: { kind: "ready", body } });
      } catch (caught) {
        if (controller.signal.aborted || requestRef.current !== requestId) return;
        setPerformance({
          accountId: expected.id,
          value: {
            kind: "error",
            message:
              caught instanceof Error
                ? caught.message
                : "Forward performance request failed.",
          },
        });
      }
    })();
    void performanceRequest;

    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (requestRef.current !== requestId) return false;
      if (!response.ok) {
        setError(parseStatusError(response.status, body));
        setStatus("error");
        return false;
      }
      if (!isStrategyStatusPayload(body, expected)) {
        setError({
          code: "INVALID_RESPONSE",
          message:
            "The server returned status data for a different account or an unrecognised schema.",
        });
        setStatus("error");
        return false;
      }
      setData(body);
      setStatus("ready");
      setLastRefreshedAt(new Date().toISOString());
      return true;
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current !== requestId) {
        return false;
      }
      setError({
        code: "REQUEST_FAILED",
        message:
          caught instanceof Error
            ? caught.message
            : "Could not load the V11 status for the selected account.",
      });
      setStatus("error");
      return false;
    }
  }, [enabled, selectedId, selectedMode, selectedNickname]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    return () => abortRef.current?.abort();
  }, [refresh]);

  const value = useMemo<StatusContextValue>(() => {
    const scoped = scopeStatusState({
      enabled,
      selectedAccount,
      requestAccountId,
      status,
      data,
      error,
    });
    const scopedPerformance: PerformanceState =
      selectedAccount && performance?.accountId === selectedAccount.id
        ? performance.value
        : { kind: "loading" };
    return {
      enabled,
      selectedAccount,
      ...scoped,
      refresh,
      lastRefreshedAt,
      performance: scopedPerformance,
    };
  }, [
    enabled,
    selectedAccount,
    requestAccountId,
    status,
    data,
    error,
    refresh,
    lastRefreshedAt,
    performance,
  ]);

  return (
    <StatusContext.Provider value={value}>{children}</StatusContext.Provider>
  );
}

export function useStrategyStatus(): StatusContextValue {
  const value = useContext(StatusContext);
  if (!value) {
    throw new Error("useStrategyStatus must be used inside StatusProvider");
  }
  return value;
}
