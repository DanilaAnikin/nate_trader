"use client";

import type { ReactNode } from "react";
import { useStrategyStatus } from "./StatusProvider";
import { StatePill, UnavailableBlock } from "./primitives";
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
  if (status === "backend-unreachable") {
    return (
      <UnavailableBlock
        state="UNAVAILABLE"
        title="Account backend could not be reached"
        detail="Supabase is configured but the server could not read your accounts, so no account-scoped data can be shown. This is an infrastructure fault, not a missing account — nothing has been added, removed or changed. Check that the Supabase project is running and that SUPABASE_SERVICE_ROLE_KEY is set on the dashboard server."
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

  return (
    <>
      <ReadModelWarnings warnings={data.warnings} />
      {children(data)}
    </>
  );
}

/**
 * The read model already diagnoses why whole groups of panels are withheld —
 * an unset GITHUB_TOKEN, a broken production lineage, a dashboard build that is
 * not the approved release. Until now nothing rendered those strings, so a
 * reader saw eight panels each saying "could not be read" and never the one
 * sentence naming the cause. They belong above the page, once.
 */
function ReadModelWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div
      className="panel border-l-4 border-l-amber-500 p-4 space-y-2"
      role="status"
    >
      <div className="flex items-center gap-2">
        <StatePill size="xs" state="STALE" label="NEEDS ATTENTION" />
        <span className="text-xs uppercase tracking-wide text-muted">
          {warnings.length === 1
            ? "1 configuration note"
            : `${warnings.length} configuration notes`}
        </span>
      </div>
      <ul className="space-y-1 text-sm">
        {warnings.map((warning) => (
          <li key={warning} className="leading-snug">
            {warning}
          </li>
        ))}
      </ul>
    </div>
  );
}
