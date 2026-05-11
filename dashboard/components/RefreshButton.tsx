"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshAll } from "@/app/actions";

/**
 * Refresh button — three concurrent jobs in one click:
 *
 *   1. Hit /api/live  → fetch fresh Alpaca account/positions.
 *      If creds are set on the server, dispatch a "dashboard:live"
 *      CustomEvent that DashboardClient listens for. That makes the
 *      visible metrics jump to live Alpaca values immediately, without
 *      waiting for the next routine to write GitHub state.
 *
 *   2. refreshAll() server action → revalidatePath("/", "layout")
 *      drops Next.js cache so every page re-fetches fresh GitHub state.
 *
 *   3. router.refresh() → re-renders the current page.
 *
 * UI feedback: spinner while pending, 2s green check on success,
 * "LIVE" tag + timestamp visible when live data was applied.
 */
export default function RefreshButton() {
  const [pending, startTransition] = useTransition();
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [liveOk, setLiveOk] = useState(false);
  const [justSucceeded, setJustSucceeded] = useState(false);
  const router = useRouter();

  function handleClick() {
    startTransition(async () => {
      let live = false;

      // 1. Live Alpaca pull — best effort, silent fallback
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data && data.account) {
            // Tell DashboardClient (or any future listener) to swap displayed
            // metrics for the live values.
            window.dispatchEvent(
              new CustomEvent("dashboard:live", { detail: data })
            );
            live = true;
          }
        }
      } catch {
        // network error → fall back to GitHub revalidate path
      }
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
