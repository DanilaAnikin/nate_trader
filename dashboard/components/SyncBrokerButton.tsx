"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-fetch the broker mirrors: the one control that writes financial data.
 *
 * Separate from `RefreshButton` on purpose. That one re-reads what is already
 * stored; this one calls Alpaca's portfolio-history and activity endpoints,
 * validates both completely, and publishes them in a single transaction. It is
 * the only path in the application that writes `equity_snapshots` or
 * `cash_flows`, and every publish it causes writes an `audit_log` entry naming
 * the account, the generation and the credential version.
 *
 * It used to be a side effect of `GET /equity` and `GET /performance`, so a
 * page left open wrote on every poll and two tabs raced each other, with no
 * actor recorded anywhere. An operator now has to ask for it, and the ledger
 * records that they did.
 */
export default function SyncBrokerButton({
  accountId,
  disabled,
}: {
  accountId: string | null;
  disabled?: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<string | null>(null);
  const router = useRouter();

  function handleClick() {
    if (!accountId) return;
    startTransition(async () => {
      setOutcome(null);
      try {
        const response = await fetch(
          `/api/accounts/${encodeURIComponent(accountId)}/refresh`,
          { method: "POST", cache: "no-store" },
        );
        const body = (await response.json().catch(() => null)) as
          | Record<string, unknown>
          | null;
        if (response.ok) {
          setOutcome(
            `Synced: ${body?.equityWritten ?? 0} session(s), ${body?.flowsWritten ?? 0} cash flow(s).`,
          );
          router.refresh();
          return;
        }
        // A refusal is a named outcome with the mirrors intact, not an error
        // to swallow. Saying which one lets the operator decide what to do.
        setOutcome(
          `Not synced (${String(body?.code ?? response.status)}). ` +
            `The stored mirrors are unchanged.`,
        );
      } catch {
        setOutcome("Not synced: the request did not complete.");
      }
    });
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="sr-only" role="status" aria-live="polite">
        {outcome ?? ""}
      </span>
      {outcome && (
        <span className="text-[11px] text-muted hidden md:inline">{outcome}</span>
      )}
      <button
        type="button"
        onClick={handleClick}
        disabled={pending || disabled || !accountId}
        title="Re-fetch the Alpaca portfolio history and activity feed and republish both mirrors. Writes to the database and is recorded in the audit log."
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-card text-secondary hover:text-foreground hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-60"
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
          className={pending ? "animate-pulse" : ""}
        >
          <path d="M21 12a9 9 0 01-9 9m0 0a9 9 0 01-9-9m9 9V3" />
          <polyline points="8 7 12 3 16 7" />
        </svg>
        {pending ? "Syncing…" : "Sync broker data"}
      </button>
    </div>
  );
}
