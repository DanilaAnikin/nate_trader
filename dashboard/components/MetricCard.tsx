interface MetricCardProps {
  label: string;
  value: string;
  subValue?: string;
  trend?: "up" | "down" | "neutral";
}

export default function MetricCard({ label, value, subValue, trend }: MetricCardProps) {
  const trendColor =
    trend === "up" ? "text-green" : trend === "down" ? "text-red" : "text-secondary";

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <p className="text-xs text-muted uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${trendColor}`}>{value}</p>
      {subValue && <p className="text-xs text-muted mt-1">{subValue}</p>}
    </div>
  );
}
