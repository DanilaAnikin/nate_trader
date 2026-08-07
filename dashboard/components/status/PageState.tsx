"use client";

import type { ReactNode } from "react";
import { useStrategyStatus } from "./StatusProvider";
import { UnavailableBlock } from "./primitives";
import type { StrategyStatusPayload } from "@/lib/status/types";

/**
 * Shared loading/empty/error handling for every account-scoped screen.
 *
 * A page body only ever runs with a validated payload for the currently
 * selected account, so no screen can render a stale account's numbers while a
 * switch is in flight.
 */
export default function PageState({
  children,
}: {
  children: (payload: StrategyStatusPayload) => ReactNode;
}) {
  const { status, data, error } = useStrategyStatus();

  if (status === "disabled") {
    return (
      <UnavailableBlock
        state="NOT_APPLICABLE"
        title="Account backend is not configured"
        detail="This deployment has no Supabase account backend, so no account-scoped broker or strategy data can be shown."
      />
    );
  }
  if (status === "no-account") {
    return (
      <UnavailableBlock
        state="UNAVAILABLE"
        title="No observer account selected"
        detail="Add or select an Alpaca account on the Accounts screen. The dashboard never substitutes repository snapshots for account data."
      />
    );
  }
  if (status === "loading") {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading account status…</span>
        {[0, 1, 2].map((index) => (
          <div key={index} className="panel p-4 space-y-3">
            <span className="skeleton block h-4 w-48" />
            <span className="skeleton block h-20 w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (status === "error" || !data) {
    return (
      <UnavailableBlock
        state="UNAVAILABLE"
        title="Status could not be loaded"
        detail={
          error?.message ??
          "The account-scoped status read model failed. No cached or repository fallback is substituted."
        }
      />
    );
  }

  return <>{children(data)}</>;
}
