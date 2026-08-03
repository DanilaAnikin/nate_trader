"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { PerformanceData, Position, PositionsData } from "@/lib/types";
import { formatLiveTimestamp } from "@/lib/account-live";
import { evaluateV11Portfolio, V11_POLICY } from "@/lib/v11-policy";
import { useAccountLive } from "@/components/accounts/AccountLiveProvider";
import PositionsTable from "@/components/PositionsTable";
import MetricCard from "@/components/MetricCard";

interface Props {
  initialPositions: PositionsData | null;
  initialPerformance: PerformanceData | null;
}

function AccountState({
  status,
  error,
  retry,
}: {
  status: "no-account" | "loading" | "error";
  error?: string;
  retry: () => Promise<boolean>;
}) {
  if (status === "loading") {
    return (
      <div className="glass-card min-h-48 flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted">
          <svg
            className="animate-spin"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
          Loading the selected Alpaca account…
        </div>
      </div>
    );
  }

  if (status === "no-account") {
    return (
      <div className="glass-card p-8 text-center">
        <p className="text-sm font-medium text-foreground">No account selected</p>
        <p className="text-xs text-muted mt-1 mb-4">
          Add or activate an Alpaca account before viewing broker positions.
        </p>
        <Link href="/accounts" className="text-sm font-medium text-blue">
          Manage accounts →
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-red/25 bg-red/5 p-5">
      <p className="text-sm font-medium text-red">Live account unavailable</p>
      <p className="text-xs text-muted mt-1">
        {error ?? "The selected account could not be loaded."} No repository or
        global-account data has been substituted.
      </p>
      <div className="flex items-center gap-4 mt-4">
        <button
          type="button"
          onClick={() => void retry()}
          className="text-xs font-medium text-blue hover:underline"
        >
          Try again
        </button>
        <Link href="/accounts" className="text-xs font-medium text-secondary hover:underline">
          Check credentials
        </Link>
      </div>
    </div>
  );
}

export default function PositionsClient({
  initialPositions,
  initialPerformance,
}: Props) {
  const { enabled, selectedAccount, status, data, error, refresh } =
    useAccountLive();
  const legacy = !enabled;

  const positions: Position[] = useMemo(
    () => data?.positions ?? (legacy ? initialPositions?.positions ?? [] : []),
    [data, legacy, initialPositions],
  );
  const equity = data?.account.equity ??
    (legacy ? initialPerformance?.equity ?? 0 : 0);
  const cash = data?.account.cash ?? (legacy ? initialPerformance?.cash ?? 0 : 0);
  const cashPct = data?.account.cash_pct ??
    (legacy ? initialPerformance?.cash_pct ?? 0 : 0);

  const totals = useMemo(() => {
    const totalUnrealizedPl = positions.reduce(
      (sum, position) => sum + position.unrealized_pl,
      0,
    );
    const totalMarketValue = positions.reduce(
      (sum, position) => sum + Math.abs(position.market_value),
      0,
    );
    const utilization = equity > 0 ? (totalMarketValue / equity) * 100 : 0;
    return { totalUnrealizedPl, totalMarketValue, utilization };
  }, [positions, equity]);

  const policy = useMemo(
    () => evaluateV11Portfolio(positions, equity, cash),
    [positions, equity, cash],
  );

  const rules = [
    {
      label: `Max ${V11_POLICY.maxPositions} positions`,
      ok: policy.checks.maxPositions,
    },
    {
      label: `Cash reserve ≥ ${V11_POLICY.minCashPct}%`,
      ok: policy.checks.minCash,
    },
    {
      label: `Each position ≤ ${V11_POLICY.maxPositionPct}% equity`,
      ok: policy.checks.maxPositionWeight,
    },
    {
      label: "No legacy leveraged ETFs",
      ok: policy.checks.noExcludedSymbols,
    },
    {
      label: "Long-only portfolio",
      ok: policy.checks.noShortPositions,
    },
  ];

  const ready = legacy || (status === "live" && Boolean(data));
  const updatedAt = data
    ? formatLiveTimestamp(data.timestamp)
    : initialPositions?.updated_at
      ? formatLiveTimestamp(initialPositions.updated_at)
      : "Unknown time";

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Positions</h2>
        <p className="text-xs text-muted mt-1 flex flex-wrap items-center gap-1.5">
          {data ? (
            <>
              <span className="inline-block bg-green/10 text-green text-[10px] font-semibold px-1.5 py-0.5 rounded">
                ALPACA FRESH
              </span>
              <span>{data.nickname}</span>
              <span>·</span>
              <span className={data.mode === "paper" ? "text-blue" : "text-red"}>
                {data.mode.toUpperCase()}
              </span>
              <span>· Updated {updatedAt}</span>
            </>
          ) : legacy ? (
            <>
              <span className="inline-block bg-amber/10 text-amber text-[10px] font-semibold px-1.5 py-0.5 rounded">
                REPOSITORY SNAPSHOT
              </span>
              <span>Legacy mode · {updatedAt}</span>
            </>
          ) : (
            <>
              <span className="inline-block bg-surface text-muted text-[10px] font-semibold px-1.5 py-0.5 rounded">
                {status.toUpperCase()}
              </span>
              <span>{selectedAccount?.nickname ?? "No selected account"}</span>
            </>
          )}
        </p>
      </div>

      {selectedAccount?.mode === "live" && (
        <div className="rounded-xl border border-amber/30 bg-amber/8 px-4 py-3 text-sm text-amber">
          This is a read-only LIVE broker view. The V11 production executor is
          intentionally paper-only and will not place live-money orders.
        </div>
      )}

      {!ready ? (
        <AccountState
          status={status === "no-account" ? "no-account" : status === "loading" ? "loading" : "error"}
          error={error?.error}
          retry={refresh}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              label="Open Positions"
              value={`${positions.length}`}
              subValue={`V11 max: ${V11_POLICY.maxPositions}`}
              accent="blue"
              index={0}
            />
            <MetricCard
              label="Portfolio Utilization"
              value={`${totals.utilization.toFixed(1)}%`}
              subValue={`$${totals.totalMarketValue.toLocaleString(undefined, { minimumFractionDigits: 2 })} invested`}
              accent="purple"
              index={1}
            />
            <MetricCard
              label="Unrealized P&L"
              value={`${totals.totalUnrealizedPl >= 0 ? "+" : ""}$${totals.totalUnrealizedPl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
              trend={totals.totalUnrealizedPl >= 0 ? "up" : "down"}
              accent={totals.totalUnrealizedPl >= 0 ? "green" : "red"}
              index={2}
            />
            <MetricCard
              label="Cash Reserve"
              value={`${cashPct.toFixed(1)}%`}
              subValue={policy.checks.minCash ? "Within V11 floor" : "Below V11 floor"}
              trend={policy.checks.minCash ? "up" : "down"}
              accent="amber"
              index={3}
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            <div className="lg:col-span-3">
              <PositionsTable positions={positions} equity={equity} />
            </div>
            <div className="glass-card p-5 h-fit">
              <h3 className="text-sm font-medium text-secondary mb-2">
                Broker-Visible Guardrails
              </h3>
              <p className="text-[10px] text-muted mb-4 uppercase tracking-wider">
                {V11_POLICY.displayName}
              </p>
              <div className="space-y-3">
                {rules.map((rule) => (
                  <div key={rule.label} className="flex items-center gap-2.5 text-sm">
                    {rule.ok ? (
                      <svg width="16" height="16" viewBox="0 0 18 18" className="text-green shrink-0">
                        <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M5.5 9l2.5 2.5 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 18 18" className="text-red shrink-0">
                        <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    )}
                    <span className={`text-xs ${rule.ok ? "text-foreground" : "text-red"}`}>
                      {rule.label}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted mt-4 leading-relaxed">
                Breadth, sector, SMA200, and rolling-risk gates are enforced by
                the V11 runner and are not inferred from broker positions.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
