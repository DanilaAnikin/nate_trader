"use client";

import RefreshButton from "@/components/RefreshButton";
import SyncBrokerButton from "@/components/SyncBrokerButton";
import SystemStatusBar from "@/components/status/SystemStatusBar";
import { StatePill } from "@/components/status/primitives";
import { useStrategyStatus } from "@/components/status/StatusProvider";
import type { AccountRole } from "@/lib/status/types";

const ROLE_LABEL: Record<AccountRole, string> = {
  PRODUCTION_CONTROLLED_PAPER: "PRODUCTION-CONTROLLED PAPER ACCOUNT",
  OBSERVER_ONLY_PAPER: "OBSERVER-ONLY PAPER ACCOUNT",
  READ_ONLY_LIVE: "READ-ONLY LIVE ACCOUNT",
};

/**
 * Persistent application header.
 *
 * The strategy name, the forward-validation status, the selected account, its
 * broker mode and whether it is provably the executor's account are visible on
 * every screen, because every number below them is meaningless without that
 * context.
 */
export default function AppHeader() {
  const { data, selectedAccount, status } = useStrategyStatus();
  const binding = data?.accountBinding.data ?? null;

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pl-11 lg:pl-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
            <h1 className="text-sm font-semibold text-foreground whitespace-nowrap">
              V11 Adaptive Momentum
            </h1>
            <span
              className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded"
              style={{
                color: "var(--accent-blue)",
                background: "var(--tint-blue)",
              }}
              title="The supported executor is hard-wired to Alpaca paper trading. This is forward validation, not a live-money release."
            >
              PAPER FORWARD VALIDATION
            </span>
            {selectedAccount && (
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-secondary truncate max-w-[14rem]">
                  {selectedAccount.nickname}
                </span>
                <span
                  className="text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded"
                  style={
                    selectedAccount.mode === "live"
                      ? { color: "var(--accent-red)", background: "var(--tint-red)" }
                      : { color: "var(--accent-slate)", background: "var(--tint-slate)" }
                  }
                >
                  {selectedAccount.mode.toUpperCase()}
                </span>
                {binding ? (
                  <StatePill
                    size="xs"
                    state={
                      binding.role === "PRODUCTION_CONTROLLED_PAPER"
                        ? "PASS"
                        : binding.role === "READ_ONLY_LIVE"
                          ? "NOT_APPLICABLE"
                          : "UNAVAILABLE"
                    }
                    label={ROLE_LABEL[binding.role]}
                    title={binding.bindingDetail}
                  />
                ) : status === "loading" ? (
                  <span className="skeleton h-4 w-40" />
                ) : null}
              </span>
            )}
          </div>
          <SyncBrokerButton accountId={selectedAccount?.id ?? null} />
          <RefreshButton />
        </div>
        <SystemStatusBar />
      </div>
    </header>
  );
}
