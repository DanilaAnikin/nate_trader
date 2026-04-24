"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: "~" },
  { href: "/positions", label: "Positions", icon: "$" },
  { href: "/research", label: "Research", icon: "?" },
  { href: "/screener", label: "Screener", icon: "#" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 bg-[var(--bg-secondary)] border-r border-border flex flex-col min-h-screen">
      <div className="p-5 border-b border-border">
        <h1 className="text-lg font-bold tracking-tight">Nate Trader</h1>
        <p className="text-xs text-muted mt-0.5">Autonomous Trading Agent</p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                active
                  ? "bg-blue/10 text-blue font-medium"
                  : "text-secondary hover:text-foreground hover:bg-card-hover"
              }`}
            >
              <span className="font-mono text-xs w-4 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
