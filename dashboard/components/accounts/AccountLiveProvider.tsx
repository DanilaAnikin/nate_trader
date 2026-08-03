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
import {
  accountLiveUrl,
  isAccountLivePayload,
  parseAccountLiveError,
  scopeAccountLiveState,
  type AccountIdentity,
  type AccountLiveErrorPayload,
  type AccountLivePayload,
  type AccountLiveStatus,
} from "@/lib/account-live";

interface AccountLiveContextValue {
  enabled: boolean;
  selectedAccount: AccountIdentity | null;
  status: AccountLiveStatus;
  data: AccountLivePayload | null;
  error: AccountLiveErrorPayload | null;
  refresh: () => Promise<boolean>;
}

const AccountLiveContext = createContext<AccountLiveContextValue | null>(null);

export default function AccountLiveProvider({
  enabled,
  selectedAccount,
  children,
}: {
  enabled: boolean;
  selectedAccount: AccountIdentity | null;
  children: ReactNode;
}) {
  const [status, setStatus] = useState<AccountLiveStatus>(
    enabled ? (selectedAccount ? "loading" : "no-account") : "legacy",
  );
  const [data, setData] = useState<AccountLivePayload | null>(null);
  const [error, setError] = useState<AccountLiveErrorPayload | null>(null);
  const [requestAccountId, setRequestAccountId] = useState<string | null>(
    selectedAccount?.id ?? null,
  );
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
      setStatus("legacy");
      return false;
    }
    if (!selectedId || !selectedNickname || !selectedMode) {
      setRequestAccountId(null);
      setStatus("no-account");
      return false;
    }

    const expected: AccountIdentity = {
      id: selectedId,
      nickname: selectedNickname,
      mode: selectedMode,
    };
    setRequestAccountId(expected.id);
    const url = accountLiveUrl(expected);
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
        setError(parseAccountLiveError(response.status, body));
        setStatus("error");
        return false;
      }
      if (!isAccountLivePayload(body, expected)) {
        setError({
          code: "INVALID_RESPONSE",
          error: "Broker returned data for a different account or an invalid schema.",
        });
        setStatus("error");
        return false;
      }
      setData(body);
      setStatus("live");
      window.dispatchEvent(new CustomEvent("dashboard:refreshed"));
      return true;
    } catch (caught) {
      if (controller.signal.aborted || requestRef.current !== requestId) {
        return false;
      }
      setError({
        code: "REQUEST_FAILED",
        error:
          caught instanceof Error
            ? caught.message
            : "Could not load the selected broker account.",
      });
      setStatus("error");
      return false;
    }
  }, [enabled, selectedId, selectedMode, selectedNickname]);

  useEffect(() => {
    // Defer the initial refresh by one microtask so the effect only schedules
    // work; all state transitions then happen in the async request lifecycle.
    void Promise.resolve().then(refresh);
    return () => abortRef.current?.abort();
  }, [refresh]);

  const value = useMemo<AccountLiveContextValue>(() => {
    const scoped = scopeAccountLiveState({
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
    };
  }, [enabled, selectedAccount, requestAccountId, status, data, error, refresh]);

  return (
    <AccountLiveContext.Provider value={value}>
      {children}
    </AccountLiveContext.Provider>
  );
}

export function useAccountLive(): AccountLiveContextValue {
  const value = useContext(AccountLiveContext);
  if (!value) {
    throw new Error("useAccountLive must be used inside AccountLiveProvider");
  }
  return value;
}
