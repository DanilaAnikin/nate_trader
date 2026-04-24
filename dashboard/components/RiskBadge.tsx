interface RiskBadgeProps {
  tier: "NORMAL" | "CAUTIOUS" | "HALT" | string;
  size?: "sm" | "lg";
}

const config: Record<string, { dot: string; bg: string; text: string; border: string }> = {
  NORMAL: { dot: "bg-green", bg: "bg-green/8", text: "text-green", border: "border-green/20" },
  CAUTIOUS: { dot: "bg-amber", bg: "bg-amber/8", text: "text-amber", border: "border-amber/20" },
  HALT: { dot: "bg-red", bg: "bg-red/8", text: "text-red", border: "border-red/20" },
};

export default function RiskBadge({ tier, size = "sm" }: RiskBadgeProps) {
  const c = config[tier] || config.NORMAL;
  const isLg = size === "lg";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border font-semibold ${c.bg} ${c.text} ${c.border} ${
        isLg ? "px-3 py-1 text-sm" : "px-2.5 py-0.5 text-xs"
      }`}
    >
      <span className={`rounded-full animate-pulse-dot ${c.dot} ${isLg ? "h-2.5 w-2.5" : "h-1.5 w-1.5"}`} />
      {tier}
    </span>
  );
}
