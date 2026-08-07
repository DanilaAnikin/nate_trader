"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import type { SafeAccount } from "@/lib/accounts/service";
import AccountSwitcher from "@/components/accounts/AccountSwitcher";
import ThemeToggle from "@/components/ThemeToggle";

const NAV_ITEMS = [
  { href: "/", label: "Overview", hint: "Broker, market state, convergence" },
  { href: "/positions", label: "Portfolio", hint: "Actual vs V11 target" },
  { href: "/screener", label: "Signals & universe", hint: "Ranking diagnostics" },
  { href: "/research", label: "Validation & research", hint: "Promotion evidence" },
  { href: "/operations", label: "Operations", hint: "Release, scheduler, gates" },
  { href: "/accounts", label: "Accounts", hint: "Observer accounts and keys" },
  { href: "/settings", label: "Settings", hint: "Profile and effective policy" },
];

export default function Sidebar({
  accounts,
  selectedAccountId,
}: {
  accounts: SafeAccount[];
  selectedAccountId: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        aria-controls="app-sidebar"
        className="lg:hidden fixed top-3 left-3 z-50 h-9 w-9 flex items-center justify-center rounded-md bg-card border border-border text-secondary"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden="true"
          className="lg:hidden fixed inset-0 z-40 bg-black/40"
        />
      )}

      <aside
        id="app-sidebar"
        aria-label="Sidebar"
        className={`w-60 bg-card border-r border-border flex flex-col min-h-screen fixed inset-y-0 left-0 z-40 transform transition-transform duration-150 lg:static lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-foreground">Nate Trader</p>
              <p className="text-[10px] text-muted leading-tight">
                V11 read-only observability
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
              className="lg:hidden text-muted hover:text-foreground"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <AccountSwitcher
            accounts={accounts}
            selectedAccountId={selectedAccountId}
          />
        </div>

        <nav
          aria-label="Primary"
          className="flex-1 p-2.5 space-y-0.5 overflow-y-auto"
        >
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`block px-3 py-2 rounded-md text-sm ${
                  active
                    ? "bg-surface text-foreground font-medium"
                    : "text-secondary hover:text-foreground hover:bg-card-hover"
                }`}
              >
                {item.label}
                <span className="block text-[10px] text-muted font-normal">
                  {item.hint}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="p-2.5 border-t border-border space-y-1">
          <p className="px-3 py-1 text-[10px] text-muted leading-snug">
            Read-only. This UI cannot place, cancel or approve anything.
          </p>
          <ThemeToggle />
          <form action={signOut}>
            <button
              type="submit"
              className="w-full text-left px-3 py-2 rounded-md text-sm text-secondary hover:text-foreground hover:bg-card-hover"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
