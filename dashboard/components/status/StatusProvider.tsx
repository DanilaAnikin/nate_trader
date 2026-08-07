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
  scopeStatusState,
  statusUrl,
  type ScopedStatusState,
  type StatusError,
  type StatusFetchStatus,
} from "@/lib/status/scope";
import type { StrategyStatusPayload } from "@/lib/status/types";

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
    return {
      enabled,
      selectedAccount,
      ...scoped,
      refresh,
      lastRefreshedAt,
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
