interface RiskBadgeProps {
  tier: "NORMAL" | "CAUTIOUS" | "HALT" | string;
}

export default function RiskBadge({ tier }: RiskBadgeProps) {
  const styles: Record<string, string> = {
    NORMAL: "bg-green/15 text-green border-green/30",
    CAUTIOUS: "bg-amber/15 text-amber border-amber/30",
    HALT: "bg-red/15 text-red border-red/30",
  };

  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded text-xs font-semibold border ${
        styles[tier] || styles.NORMAL
      }`}
    >
      {tier}
    </span>
  );
}
