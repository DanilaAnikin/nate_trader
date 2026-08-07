"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SafeAccount } from "@/lib/accounts/service";
import { selectAccount } from "@/lib/account-actions";
import { money } from "@/lib/status/client";
import type { AccountBindingInfo, AccountRole } from "@/lib/status/types";
import { StatePill, Timestamp } from "@/components/status/primitives";
import { ModeBadge, StatusBadge } from "./badges";
import AddAccountDialog from "./AddAccountDialog";
import EditAccountDialog from "./EditAccountDialog";

type LiveInfo = {
  loading: boolean;
  equity?: number;
  numPositions?: number;
  error?: boolean;
};

const ROLE_LABEL: Record<AccountRole, string> = {
  PRODUCTION_CONTROLLED_PAPER: "PRODUCTION-CONTROLLED PAPER ACCOUNT",
  OBSERVER_ONLY_PAPER: "OBSERVER-ONLY PAPER ACCOUNT",
  READ_ONLY_LIVE: "READ-ONLY LIVE ACCOUNT",
};

async function fetchLive(id: string): Promise<LiveInfo> {
  try {
    const res = await fetch(`/api/accounts/${encodeURIComponent(id)}/live`, {
      cache: "no-store",
    });
    if (!res.ok) return { loading: false, error: true };
    const body = await res.json();
    if (body?.accountId !== id || typeof body?.broker !== "object") {
      return { loading: false, error: true };
    }
    return {
      loading: false,
      equity: body.broker.equity,
      numPositions: body.broker.positionCount,
    };
  } catch {
    return { loading: false, error: true };
  }
}

export default function AccountsClient({
  initialAccounts,
  selectedAccountId,
  bindings,
}: {
  initialAccounts: SafeAccount[];
  selectedAccountId: string | null;
  bindings: Record<string, AccountBindingInfo>;
}) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<SafeAccount[]>(initialAccounts);
  const [live, setLive] = useState<Record<string, LiveInfo>>(() =>
    Object.fromEntries(initialAccounts.map((a) => [a.id, { loading: true }])),
  );
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<SafeAccount | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const entries = await Promise.all(
        initialAccounts.map(async (a) => [a.id, await fetchLive(a.id)] as const),
      );
      if (active) setLive(Object.fromEntries(entries));
    })();
    return () => {
      active = false;
    };
  }, [initialAccounts]);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/accounts", { cache: "no-store" });
    const body = await res.json().catch(() => ({ accounts: [] }));
    const next: SafeAccount[] = body.accounts ?? [];
    setAccounts(next);
    setLive(Object.fromEntries(next.map((a) => [a.id, { loading: true }])));
    const entries = await Promise.all(
      next.map(async (a) => [a.id, await fetchLive(a.id)] as const),
    );
    setLive(Object.fromEntries(entries));
    router.refresh();
  }, [router]);

  async function makeActive(id: string) {
    setBusyId(id);
    try {
      await selectAccount(id);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function testConnection(id: string) {
    setTesting(id);
    try {
      await fetch(`/api/accounts/${encodeURIComponent(id)}/verify`, {
        method: "POST",
      });
    } finally {
      setTesting(null);
      await refresh();
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Accounts</h1>
          <p className="text-sm text-muted max-w-prose">
            Observer accounts the dashboard can read. Switching the selected
            account changes only what this UI displays — it never changes which
            account the guarded GitHub Actions executor trades.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-md bg-blue text-white px-4 py-2 text-sm font-medium"
        >
          + Add account
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="panel p-10 text-center">
          <p className="text-sm font-medium text-foreground mb-1">
            No accounts yet
          </p>
          <p className="text-xs text-muted mb-4">
            Add an Alpaca account to observe it here.
          </p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-md bg-blue text-white px-4 py-2 text-sm font-medium"
          >
            + Add account
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {accounts.map((a) => {
            const info = live[a.id] ?? { loading: true };
            const binding = bindings[a.id];
            const isSelected = a.id === selectedAccountId;
            return (
              <li
                key={a.id}
                className="panel p-4 flex flex-col sm:flex-row sm:items-start gap-4"
                style={{ borderLeft: `3px solid ${a.color}` }}
              >
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground truncate">
                      {a.nickname}
                    </span>
                    <ModeBadge mode={a.mode} />
                    {isSelected && (
                      <span className="text-[10px] font-medium text-blue bg-blue/10 rounded px-1.5 py-0.5">
                        Selected
                      </span>
                    )}
                    {!a.is_active && (
                      <span className="text-[10px] text-muted bg-surface rounded px-1.5 py-0.5">
                        Inactive
                      </span>
                    )}
                  </div>

                  {binding && (
                    <div className="flex items-center gap-2 flex-wrap">
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
                      />
                    </div>
                  )}
                  {binding && (
                    <p className="text-[11px] text-muted max-w-prose">
                      {binding.bindingDetail}
                    </p>
                  )}

                  <div className="flex items-center gap-2 text-[11px] text-muted flex-wrap">
                    <StatusBadge status={a.status} />
                    {binding?.brokerAccountMask && (
                      <span>· {binding.brokerAccountMask}</span>
                    )}
                    {info.numPositions !== undefined && (
                      <span>· {info.numPositions} positions</span>
                    )}
                    <span>
                      · verified{" "}
                      {a.last_verified_at ? (
                        <Timestamp iso={a.last_verified_at} />
                      ) : (
                        "never"
                      )}
                    </span>
                  </div>
                </div>

                <div className="text-left sm:text-right shrink-0">
                  <div className="text-sm font-semibold text-foreground numeric">
                    {info.loading ? "…" : info.error ? "—" : money(info.equity)}
                  </div>
                  <div className="text-[10px] text-muted">
                    {info.error ? "connection failed" : "broker equity"}
                  </div>
                </div>

                <div className="flex flex-row sm:flex-col gap-1.5 shrink-0">
                  {!isSelected && (
                    <button
                      type="button"
                      onClick={() => makeActive(a.id)}
                      disabled={busyId === a.id}
                      className="rounded-md border border-border px-2.5 py-1 text-xs text-secondary hover:bg-surface disabled:opacity-50"
                    >
                      Select
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => testConnection(a.id)}
                    disabled={testing === a.id}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-secondary hover:bg-surface disabled:opacity-50"
                  >
                    {testing === a.id ? "Testing…" : "Test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(a)}
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-secondary hover:bg-surface"
                  >
                    Edit
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[11px] text-muted max-w-prose">
        Alpaca keys are stored in Supabase Vault and are only ever decrypted
        server-side. A live account is read-only monitoring: the V11 executor is
        hard-wired to the Alpaca paper endpoint and never trades live money.
      </p>

      <AddAccountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={refresh}
      />
      {editing && (
        <EditAccountDialog
          key={editing.id}
          open={true}
          account={editing}
          onClose={() => setEditing(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
