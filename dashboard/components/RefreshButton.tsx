"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { refreshAll } from "@/app/actions";
import { useStrategyStatus } from "@/components/status/StatusProvider";
import { Timestamp } from "@/components/status/primitives";

/**
 * Re-read every observability source.
 *
 * **This is a read, and its label says so.** It re-requests the account-scoped
 * status model and re-renders the page: it never triggers a workflow, an
 * execution, a broker order, or a broker-mirror refresh. It used to be called
 * "Refresh", which is what the broker-mirror command is also called, and an
 * operator clicking it could reasonably believe the equity curve had just been
 * re-fetched from Alpaca. It had not; nothing here touches Alpaca's portfolio
 * history or activity feed.
 *
 * Re-fetching from the broker is a command this artifact does not have: the
 * refresh route is an unconditional refusal and the publisher is not in the
 * image. What the equity and performance panels show is the mirror as last
 * published, and their freshness says how old that is.
 */
export default function RefreshButton() {
  const [pending, startTransition] = useTransition();
  const [announcement, setAnnouncement] = useState("");
  const router = useRouter();
  const { enabled, selectedAccount, refresh, lastRefreshedAt } =
    useStrategyStatus();

  function handleClick() {
    startTransition(async () => {
      const ok = enabled && selectedAccount ? await refresh() : false;
      await refreshAll();
      router.refresh();
      setAnnouncement(
        ok
          ? "Status re-read. The broker mirrors were not re-fetched."
          : "Status re-read finished; some sources are unavailable.",
      );
    });
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {lastRefreshedAt && (
        <span className="text-[11px] text-muted hidden sm:inline">
          read <Timestamp iso={lastRefreshedAt} />
        </span>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        title="Re-read the stored status, runtime artifacts and validation evidence. Read-only: it does not re-fetch the broker mirrors."
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-card text-secondary hover:text-foreground hover:bg-card-hover disabled:cursor-wait disabled:opacity-60"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={pending ? "animate-spin" : ""}
        >
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
        </svg>
        {pending ? "Reading…" : "Re-read"}
      </button>
    </div>
  );
}
