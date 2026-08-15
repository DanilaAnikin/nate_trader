"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { SafeAccount } from "@/lib/accounts/read";
import { selectAccount } from "@/lib/account-actions";
import { ModeBadge } from "./badges";

export default function AccountSwitcher({
  accounts,
  selectedAccountId,
}: {
  accounts: SafeAccount[];
  selectedAccountId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const active = accounts.filter((a) => a.is_active);
  const selected = accounts.find((a) => a.id === selectedAccountId) ?? null;

  async function pick(id: string) {
    if (id === selectedAccountId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await selectAccount(id);
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <Link
        href="/accounts"
        className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-secondary hover:bg-surface"
      >
        <span className="text-blue text-sm leading-none">+</span>
        Add account
      </Link>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 hover:bg-surface transition-colors"
      >
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: selected?.color ?? "#999" }}
        />
        <span className="flex-1 min-w-0 text-left">
          <span className="block text-xs font-medium text-foreground truncate">
            {selected?.nickname ?? "Select account"}
          </span>
        </span>
        {selected && <ModeBadge mode={selected.mode} />}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-muted transition-transform ${open ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div className="absolute left-0 right-0 mt-1 z-20 bg-card border border-border rounded-lg shadow-lg overflow-hidden">
            <div className="max-h-64 overflow-auto py-1">
              {active.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => pick(a.id)}
                  disabled={busy}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-surface disabled:opacity-50 ${
                    a.id === selectedAccountId ? "bg-blue/5" : ""
                  }`}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: a.color }}
                  />
                  <span className="flex-1 min-w-0 text-xs font-medium text-foreground truncate">
                    {a.nickname}
                  </span>
                  <ModeBadge mode={a.mode} />
                </button>
              ))}
              {active.length === 0 && (
                <p className="px-2.5 py-2 text-[11px] text-muted">
                  No active accounts.
                </p>
              )}
            </div>
            <Link
              href="/accounts"
              onClick={() => setOpen(false)}
              className="block border-t border-border px-2.5 py-2 text-xs text-blue hover:bg-surface"
            >
              Manage accounts
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
