"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { DailyHistory, PerformanceData, SpyBenchmark } from "@/lib/types";
import { formatLiveTimestamp } from "@/lib/account-live";
import { evaluateV11Portfolio, V11_POLICY } from "@/lib/v11-policy";
import { useAccountLive } from "@/components/accounts/AccountLiveProvider";
import MetricCard from "@/components/MetricCard";
import EquityChart from "@/components/EquityChart";
import SpyComparison from "@/components/SpyComparison";
import RiskBadge from "@/components/RiskBadge";
import HistoricalComparisonChart from "@/components/HistoricalComparisonChart";

interface Props {
  performance: PerformanceData | null;
  spy: SpyBenchmark | null;
}

interface DisplayMetrics {
  equity: number;
  cash: number;
  cashPct: number;
  dailyPnl: number;
  dailyPnlPct: number;
  monthlyPnl: number | null;
  monthlyPnlPct: number | null;
  numPositions: number;
  updatedAt: string;
  source: "repository" | "alpaca";
}

export default function DashboardClient({ performance, spy }: Props) {
  const { enabled, selectedAccount, status, data, error, refresh } =
    useAccountLive();
  const legacy = !enabled;
  const [accountHistoryState, setAccountHistoryState] = useState<{
    accountId: string;
    liveTimestamp: string;
    rows: DailyHistory[];
  } | null>(null);
  const [historyErrorState, setHistoryErrorState] = useState<{
    accountId: string;
    liveTimestamp: string;
    message: string;
  } | null>(null);
  const accountHistory =
    accountHistoryState !== null &&
    accountHistoryState.accountId === selectedAccount?.id &&
    accountHistoryState.liveTimestamp === data?.timestamp
      ? accountHistoryState.rows
      : null;
  const historyError =
    historyErrorState !== null &&
    historyErrorState.accountId === selectedAccount?.id &&
    historyErrorState.liveTimestamp === data?.timestamp
      ? historyErrorState.message
      : null;
  const liveRefreshTimestamp = data?.timestamp;

  useEffect(() => {
    const accountId = selectedAccount?.id;
    if (!enabled || !accountId || !liveRefreshTimestamp) return;
    const liveTimestamp = liveRefreshTimestamp;

    const controller = new AbortController();
    (async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setAccountHistoryState(null);
      setHistoryErrorState(null);
      try {
        const response = await fetch(
          `/api/accounts/${encodeURIComponent(accountId)}/equity`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          if (!controller.signal.aborted) {
            setHistoryErrorState({
              accountId,
              liveTimestamp,
              message:
                typeof body?.error === "string"
                  ? body.error
                  : `Equity history failed (HTTP ${response.status}).`,
            });
          }
          return;
        }
        if (body?.accountId !== accountId || !Array.isArray(body?.snapshots)) {
          setHistoryErrorState({
            accountId,
            liveTimestamp,
            message: "Equity history did not match the selected account.",
          });
          return;
        }
        if (typeof body.warning === "string") {
          setHistoryErrorState({
            accountId,
            liveTimestamp,
            message: body.warning,
          });
        }
        type Snapshot = {
          date: string;
          equity: number;
          cash: number | null;
          pnl: number | null;
          pnl_pct: number | null;
          num_positions: number | null;
        };
        setAccountHistoryState({
          accountId,
          liveTimestamp,
          rows: body.snapshots.map((snapshot: Snapshot) => ({
            date: snapshot.date,
            equity: snapshot.equity,
            cash: snapshot.cash ?? 0,
            pnl: snapshot.pnl ?? 0,
            pnl_pct: snapshot.pnl_pct ?? 0,
            num_positions: snapshot.num_positions ?? 0,
          })),
        });
      } catch (caught) {
        if (!controller.signal.aborted) {
          setHistoryErrorState({
            accountId,
            liveTimestamp,
            message:
              caught instanceof Error
                ? caught.message
                : "Equity history unavailable.",
          });
        }
      }
    })();
    return () => controller.abort();
  }, [enabled, selectedAccount?.id, liveRefreshTimestamp]);

  const dailyHistory = useMemo(
    () => (legacy ? performance?.daily_history ?? [] : accountHistory ?? []),
    [legacy, performance, accountHistory],
  );

  const monthWindow =
    dailyHistory.length >= 22 ? dailyHistory.slice(-22) : dailyHistory;
  const liveEquity = data?.account.equity;
  const monthStartEquity = monthWindow[0]?.equity ?? liveEquity ?? 0;
  const liveMonthlyPnl =
    liveEquity !== undefined && monthWindow.length > 0 && monthStartEquity > 0
      ? liveEquity - monthStartEquity
      : null;
  const liveMonthlyPnlPct =
    liveMonthlyPnl !== null && monthStartEquity > 0
      ? (liveMonthlyPnl / monthStartEquity) * 100
      : null;

  const display: DisplayMetrics | null = data
    ? {
        equity: data.account.equity,
        cash: data.account.cash,
        cashPct: data.account.cash_pct,
        dailyPnl: data.account.daily_pnl,
        dailyPnlPct: data.account.daily_pnl_pct,
        monthlyPnl: liveMonthlyPnl,
        monthlyPnlPct: liveMonthlyPnlPct,
        numPositions: data.account.num_positions,
        updatedAt: formatLiveTimestamp(data.timestamp),
        source: "alpaca",
      }
    : legacy
      ? {
          equity: performance?.equity ?? 0,
          cash: performance?.cash ?? 0,
          cashPct: performance?.cash_pct ?? 0,
          dailyPnl: performance?.daily_pnl ?? 0,
          dailyPnlPct: performance?.daily_pnl_pct ?? 0,
          monthlyPnl: performance?.monthly_pnl ?? 0,
          monthlyPnlPct: performance?.monthly_pnl_pct ?? 0,
          numPositions: performance?.num_positions ?? 0,
          updatedAt: performance?.updated_at
            ? formatLiveTimestamp(performance.updated_at)
            : "Unknown time",
          source: "repository",
        }
      : null;

  const effectiveDailyHistory = useMemo(() => {
    if (!data || dailyHistory.length === 0) return dailyHistory;
    const today = new Date().toISOString().slice(0, 10);
    const liveEntry: DailyHistory = {
      date: today,
      pnl: data.account.daily_pnl,
      pnl_pct: data.account.daily_pnl_pct,
      equity: data.account.equity,
      cash: data.account.cash,
      num_positions: data.account.num_positions,
    };
    const last = dailyHistory[dailyHistory.length - 1];
    return last?.date === today
      ? [...dailyHistory.slice(0, -1), liveEntry]
      : [...dailyHistory, liveEntry];
  }, [dailyHistory, data]);

  const policy = display
    ? evaluateV11Portfolio(
        data?.positions ?? [],
        display.equity,
        display.cash,
      )
    : null;
  const spyMonthly = spy?.monthly_return ?? 0;
  const marketRegime = spy?.market_regime ?? "UNKNOWN";
  const marketUpdatedAt = spy?.updated_at
    ? formatLiveTimestamp(spy.updated_at)
    : "Unknown time";
  const ready = Boolean(display);

  const rules = display && policy
    ? [
        {
          label: `Cash reserve ≥ ${V11_POLICY.minCashPct}%`,
          ok: policy.checks.minCash,
        },
        {
          label: `Max ${V11_POLICY.maxPositions} positions`,
          ok: data
            ? policy.checks.maxPositions
            : display.numPositions <= V11_POLICY.maxPositions,
        },
        {
          label: `Each position ≤ ${V11_POLICY.maxPositionPct}%`,
          ok: data ? policy.checks.maxPositionWeight : null,
        },
        {
          label: "No excluded ETF infrastructure",
          ok: data ? policy.checks.noExcludedSymbols : null,
        },
        {
          label: `Daily breaker above ${V11_POLICY.riskThresholds.dailyHaltPct}%`,
          ok: display.dailyPnlPct > V11_POLICY.riskThresholds.dailyHaltPct,
        },
      ]
    : [];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">Dashboard</h2>
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
                <span>· Updated {display?.updatedAt}</span>
              </>
            ) : legacy ? (
              <>
                <span className="inline-block bg-amber/10 text-amber text-[10px] font-semibold px-1.5 py-0.5 rounded">
                  REPOSITORY SNAPSHOT
                </span>
                <span>Legacy mode · {display?.updatedAt}</span>
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
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Market snapshot:</span>
          <span
            className={`text-xs font-semibold px-2.5 py-1 rounded-lg ${
              marketRegime === "BULL"
                ? "bg-green/8 text-green"
                : marketRegime === "BEAR"
                  ? "bg-red/8 text-red"
                  : "bg-amber/8 text-amber"
            }`}
          >
            {marketRegime}
          </span>
          <span
            className="text-[10px] text-muted"
            title={`Repository market snapshot from ${marketUpdatedAt}`}
          >
            REPO · {marketUpdatedAt}
          </span>
          {legacy && performance?.risk_tier && (
            <RiskBadge tier={performance.risk_tier} />
          )}
        </div>
      </div>

      {selectedAccount?.mode === "live" && (
        <div className="rounded-xl border border-amber/30 bg-amber/8 px-4 py-3 text-sm text-amber">
          This is a read-only LIVE broker view. The V11 production executor is
          intentionally paper-only and will not place live-money orders.
        </div>
      )}

      {!ready && status === "loading" && (
        <div className="glass-card min-h-48 flex items-center justify-center text-sm text-muted">
          Loading the selected Alpaca account…
        </div>
      )}
      {!ready && status === "no-account" && (
        <div className="glass-card p-8 text-center">
          <p className="text-sm font-medium text-foreground">No account selected</p>
          <p className="text-xs text-muted mt-1 mb-4">
            Add or activate an Alpaca account to load account-scoped data.
          </p>
          <Link href="/accounts" className="text-sm font-medium text-blue">
            Manage accounts →
          </Link>
        </div>
      )}
      {!ready && status === "error" && (
        <div className="rounded-xl border border-red/25 bg-red/5 p-5">
          <p className="text-sm font-medium text-red">Live account unavailable</p>
          <p className="text-xs text-muted mt-1">
            {error?.error ?? "The selected account could not be loaded."} No
            repository or global-account data has been substituted.
          </p>
          <div className="flex items-center gap-4 mt-4">
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-xs font-medium text-blue hover:underline"
            >
              Try again
            </button>
            <Link href="/accounts" className="text-xs font-medium text-secondary hover:underline">
              Check credentials
            </Link>
          </div>
        </div>
      )}

      {ready && display && policy && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard
              label="Equity"
              value={`$${display.equity.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
              subValue={`${display.numPositions} positions`}
              accent="blue"
              index={0}
            />
            <MetricCard
              label="Cash Reserve"
              value={`${display.cashPct.toFixed(1)}%`}
              subValue={`$${display.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
              trend={policy.checks.minCash ? "up" : "down"}
              accent="amber"
              index={1}
            />
            <MetricCard
              label="Daily P&L"
              value={`${display.dailyPnl >= 0 ? "+" : ""}$${display.dailyPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
              subValue={`${display.dailyPnlPct >= 0 ? "+" : ""}${display.dailyPnlPct.toFixed(2)}%`}
              trend={display.dailyPnl >= 0 ? "up" : "down"}
              accent={display.dailyPnl >= 0 ? "green" : "red"}
              index={2}
            />
            <MetricCard
              label="Monthly P&L"
              value={
                display.monthlyPnlPct === null
                  ? "—"
                  : `${display.monthlyPnlPct >= 0 ? "+" : ""}${display.monthlyPnlPct.toFixed(2)}%`
              }
              subValue={
                display.monthlyPnlPct === null
                  ? historyError
                    ? "Account history unavailable"
                    : "Loading account history…"
                  : `SPY repo snapshot: ${spyMonthly >= 0 ? "+" : ""}${spyMonthly.toFixed(2)}%`
              }
              trend={
                display.monthlyPnlPct === null
                  ? undefined
                  : display.monthlyPnlPct >= 0
                    ? "up"
                    : "down"
              }
              accent={
                display.monthlyPnlPct === null
                  ? "blue"
                  : display.monthlyPnlPct >= 0
                    ? "green"
                    : "red"
              }
              index={3}
            />
          </div>

          {historyError && (
            <div className="rounded-xl border border-amber/25 bg-amber/5 px-4 py-3 text-xs text-amber">
              Account metrics are live, but the account-scoped equity history is
              unavailable: {historyError}
            </div>
          )}

          {effectiveDailyHistory.length > 0 && display.monthlyPnlPct !== null ? (
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              <div className="lg:col-span-3">
                <EquityChart data={effectiveDailyHistory} />
              </div>
              <div className="lg:col-span-2">
                <SpyComparison portfolioReturn={display.monthlyPnlPct} spyReturn={spyMonthly} />
              </div>
            </div>
          ) : (
            <div className="glass-card p-8 text-center text-xs text-muted">
              Account-scoped equity history is not available yet. Live account
              totals above remain current.
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-secondary mb-1">
                Visible Guardrails
              </h3>
              <p className="text-[10px] text-muted mb-4 uppercase tracking-wider">
                {V11_POLICY.displayName}
              </p>
              <div className="space-y-3">
                {rules.map((rule) => (
                  <div key={rule.label} className="flex items-center gap-2.5 text-sm">
                    {rule.ok === null ? (
                      <span className="h-[18px] w-[18px] rounded-full border border-border text-[10px] text-muted flex items-center justify-center shrink-0">?</span>
                    ) : rule.ok ? (
                      <svg width="18" height="18" viewBox="0 0 18 18" className="text-green shrink-0">
                        <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M5.5 9l2.5 2.5 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 18 18" className="text-red shrink-0">
                        <circle cx="9" cy="9" r="8" fill="currentColor" fillOpacity="0.1" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    )}
                    <span className={`text-xs ${rule.ok === false ? "text-red" : "text-foreground"}`}>
                      {rule.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-secondary mb-4">
                V11 Mandate
              </h3>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div>
                  <p className="text-2xl font-semibold text-blue">{V11_POLICY.topN}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider mt-1">Top names</p>
                </div>
                <div className="border-x border-border">
                  <p className="text-lg font-semibold text-foreground">{V11_POLICY.signal.split(" ")[0]}</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider mt-1">Momentum</p>
                </div>
                <div>
                  <p className="text-lg font-semibold text-purple">Equal</p>
                  <p className="text-[10px] text-muted uppercase tracking-wider mt-1">Weighting</p>
                </div>
              </div>
              <p className="text-xs text-muted mt-5 leading-relaxed">
                {V11_POLICY.signal} selection with breadth scaling, a SPY
                200-day trend gate, and no excluded ETF infrastructure.
              </p>
              <p className="text-[10px] text-muted mt-2 leading-relaxed">
                Dynamic breadth and rolling-risk status remain runner-side; the
                checks shown here use only verified broker data.
              </p>
            </div>

            <div className="glass-card p-5">
              <h3 className="text-sm font-medium text-secondary mb-3">
                Portfolio Allocation
              </h3>
              <div className="space-y-3.5">
                {[
                  { label: "Invested", value: Math.max(0, 100 - display.cashPct), color: "bg-blue" },
                  { label: "Cash", value: display.cashPct, color: "bg-amber" },
                ].map((row) => (
                  <div key={row.label}>
                    <div className="flex justify-between text-xs mb-1.5">
                      <span className="text-muted">{row.label}</span>
                      <span className="text-foreground font-medium">{row.value.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 bg-surface rounded-full overflow-hidden">
                      <div className={`h-full ${row.color} rounded-full transition-all`} style={{ width: `${Math.min(100, Math.max(0, row.value))}%` }} />
                    </div>
                  </div>
                ))}
                <div>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-muted">Positions</span>
                    <span className="text-foreground font-medium">
                      {display.numPositions} / {V11_POLICY.maxPositions}
                    </span>
                  </div>
                  <div className="h-2 bg-surface rounded-full overflow-hidden">
                    <div className="h-full bg-purple rounded-full transition-all" style={{ width: `${Math.min(100, (display.numPositions / V11_POLICY.maxPositions) * 100)}%` }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {effectiveDailyHistory.length > 0 && (
            <HistoricalComparisonChart portfolioHistory={effectiveDailyHistory} />
          )}
        </>
      )}
    </div>
  );
}
