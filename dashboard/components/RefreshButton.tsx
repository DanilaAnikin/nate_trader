"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshAll } from "@/app/actions";
import { useAccountLive } from "@/components/accounts/AccountLiveProvider";

/**
 * Refresh button — three coordinated jobs in one click:
 *
 *   1. Ask the shared account provider to fetch the selected account through
 *      its authenticated account-scoped endpoint and validate its identity.
 *
 *   2. refreshAll() server action → revalidatePath("/", "layout")
 *      drops Next.js cache so every page re-fetches fresh GitHub state.
 *
 *   3. router.refresh() → re-renders the current page.
 *
 * UI feedback: spinner while pending, 2s green check on success,
 * "FRESH" tag + timestamp visible when account data was applied.
 */
export default function RefreshButton() {
  const [pending, startTransition] = useTransition();
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [liveOk, setLiveOk] = useState(false);
  const [justSucceeded, setJustSucceeded] = useState(false);
  const router = useRouter();
  const { enabled, selectedAccount, refresh } = useAccountLive();

  function handleClick() {
    startTransition(async () => {
      let live = false;

      // 1. Pull only the selected, ownership-checked account. The shared
      // provider validates account id + mode before publishing the response.
      if (enabled && selectedAccount) live = await refresh();
      setLiveOk(live);

      // 2. Invalidate Next.js cache (so GitHub-state-backed pages re-fetch)
      await refreshAll();

      // 3. Re-render the current page server-side
      router.refresh();

      setLastRefresh(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      );
      setJustSucceeded(true);
      setTimeout(() => setJustSucceeded(false), 2000);
    });
  }

  return (
    <div className="flex items-center gap-2.5">
      {lastRefresh && (
        <span className="text-[10px] text-muted">
          {liveOk && <span className="text-green font-medium mr-1">FRESH</span>}
          {lastRefresh}
        </span>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        title={
          selectedAccount
            ? `Refresh ${selectedAccount.nickname} (${selectedAccount.mode.toUpperCase()})`
            : "Refresh dashboard snapshots"
        }
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-200 ${
          justSucceeded
            ? "bg-green/10 text-green"
            : pending
            ? "bg-blue/5 text-muted cursor-wait"
            : "bg-blue/8 text-blue hover:bg-blue/12 active:scale-95"
        }`}
      >
        {justSucceeded ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={pending ? "animate-spin" : ""}
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        )}
        {pending ? "Refreshing…" : justSucceeded ? "Refreshed" : "Refresh"}
      </button>
    </div>
  );
}
