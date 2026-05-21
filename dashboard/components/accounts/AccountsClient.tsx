"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SafeAccount } from "@/lib/accounts/service";
import { selectAccount } from "@/lib/account-actions";
import { ModeBadge, StatusBadge } from "./badges";
import AddAccountDialog from "./AddAccountDialog";
import EditAccountDialog from "./EditAccountDialog";

type LiveInfo = {
  loading: boolean;
  equity?: number;
  numPositions?: number;
  error?: boolean;
};

function money(n: number | undefined): string {
  if (n === undefined) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function fetchLive(id: string): Promise<LiveInfo> {
  try {
    const res = await fetch(`/api/accounts/${id}/live`, { cache: "no-store" });
    if (!res.ok) return { loading: false, error: true };
    const body = await res.json();
    return {
      loading: false,
      equity: body.account?.equity,
      numPositions: body.account?.num_positions,
    };
  } catch {
    return { loading: false, error: true };
  }
}

export default function AccountsClient({
  initialAccounts,
  selectedAccountId,
}: {
  initialAccounts: SafeAccount[];
  selectedAccountId: string | null;
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
        initialAccounts.map(
          async (a) => [a.id, await fetchLive(a.id)] as const,
        ),
      );
      if (active) setLive(Object.fromEntries(entries));
    })();
    return () => {
      active = false;
    };
  }, [initialAccounts]);

  async function refresh() {
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
  }

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
      await fetch(`/api/accounts/${id}/verify`, { method: "POST" });
    } finally {
      setTesting(null);
      await refresh();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Accounts</h1>
          <p className="text-sm text-muted">
            Connect and manage your Alpaca trading accounts.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-lg bg-blue text-white px-4 py-2 text-sm font-medium"
        >
          + Add account
        </button>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-white p-10 text-center">
          <p className="text-sm font-medium text-foreground mb-1">
            No accounts yet
          </p>
          <p className="text-xs text-muted mb-4">
            Add your first Alpaca account to start tracking it here.
          </p>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-lg bg-blue text-white px-4 py-2 text-sm font-medium"
          >
            + Add account
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => {
            const info = live[a.id] ?? { loading: true };
            const isSelected = a.id === selectedAccountId;
            return (
              <div
                key={a.id}
                className="bg-white border border-border rounded-2xl p-4 flex items-start gap-4"
                style={{ borderLeft: `3px solid ${a.color}` }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-foreground truncate">
                      {a.nickname}
                    </span>
                    <ModeBadge mode={a.mode} />
                    {isSelected && (
                      <span className="text-[10px] font-medium text-blue bg-blue/10 rounded px-1.5 py-0.5">
                        Active
                      </span>
                    )}
                    {!a.is_active && (
                      <span className="text-[10px] text-muted bg-surface rounded px-1.5 py-0.5">
                        Inactive
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted flex-wrap">
                    <StatusBadge status={a.status} />
                    {a.alpaca_account_number && (
                      <span>· #{a.alpaca_account_number}</span>
                    )}
                    {info.numPositions !== undefined && (
                      <span>· {info.numPositions} positions</span>
                    )}
                    <span>· verified {timeAgo(a.last_verified_at)}</span>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-foreground tabular-nums">
                    {info.loading
                      ? "…"
                      : info.error
                        ? "—"
                        : money(info.equity)}
                  </div>
                  <div className="text-[10px] text-muted">
                    {info.error ? "connection failed" : "equity"}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5 shrink-0">
                  {!isSelected && (
                    <button
                      type="button"
                      onClick={() => makeActive(a.id)}
                      disabled={busyId === a.id}
                      className="rounded-lg border border-border px-2.5 py-1 text-xs text-secondary hover:bg-surface disabled:opacity-50"
                    >
                      Set active
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => testConnection(a.id)}
                    disabled={testing === a.id}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs text-secondary hover:bg-surface disabled:opacity-50"
                  >
                    {testing === a.id ? "Testing…" : "Test"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(a)}
                    className="rounded-lg border border-border px-2.5 py-1 text-xs text-secondary hover:bg-surface"
                  >
                    Edit
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
