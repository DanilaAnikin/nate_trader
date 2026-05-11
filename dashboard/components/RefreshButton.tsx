"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshAll } from "@/app/actions";

/**
 * Refresh button for the dashboard.
 *
 * Click flow:
 *   1. Optionally hit /api/live to pull fresh Alpaca data (if creds in env)
 *   2. Call refreshAll() server action → revalidates Next.js layout cache
 *   3. Call router.refresh() → re-renders the current page with fresh data
 *
 * Shows three states: idle, loading (spinner), success (checkmark fades).
 * "Live" tag appears next to the timestamp when Alpaca direct fetch succeeded.
 */
export default function RefreshButton() {
  const [pending, startTransition] = useTransition();
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [liveOk, setLiveOk] = useState(false);
  const [justSucceeded, setJustSucceeded] = useState(false);
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      // Try live Alpaca first — succeeds only if Vercel has ALPACA creds.
      // Failure is silent; we still revalidate GitHub state below.
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        setLiveOk(res.ok);
      } catch {
        setLiveOk(false);
      }

      // Invalidate Next.js layout cache so GitHub state is refetched
      await refreshAll();

      // Re-render the current page with fresh data
      router.refresh();

      setLastRefresh(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setJustSucceeded(true);
      setTimeout(() => setJustSucceeded(false), 2000);
    });
  }

  return (
    <div className="flex items-center gap-2.5">
      {lastRefresh && (
        <span className="text-[10px] text-muted">
          {liveOk && <span className="text-green font-medium mr-1">LIVE</span>}
          {lastRefresh}
        </span>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        title={
          liveOk
            ? "Refresh dashboard (live Alpaca data)"
            : "Refresh dashboard (state cache invalidate)"
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
