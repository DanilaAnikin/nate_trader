import type { Database } from "@/lib/database.types";

type Mode = Database["public"]["Enums"]["account_mode"];
type Status = Database["public"]["Enums"]["account_status"];

/** PAPER vs LIVE — live is deliberately loud (real money). */
export function ModeBadge({ mode }: { mode: Mode }) {
  if (mode === "live") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red/10 text-red text-[10px] font-bold tracking-wide px-1.5 py-0.5">
        <span className="h-1.5 w-1.5 rounded-full bg-red" />
        LIVE
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-md bg-blue/10 text-blue text-[10px] font-semibold tracking-wide px-1.5 py-0.5">
      PAPER
    </span>
  );
}

const STATUS_META: Record<Status, { label: string; dot: string; text: string }> = {
  connected: { label: "Connected", dot: "bg-green", text: "text-green" },
  unverified: { label: "Unverified", dot: "bg-muted", text: "text-muted" },
  auth_failed: { label: "Auth failed", dot: "bg-red", text: "text-red" },
  paused: { label: "Paused", dot: "bg-amber", text: "text-amber" },
};

export function StatusBadge({ status }: { status: Status }) {
  const meta = STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${meta.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}
