interface MetricCardProps {
  label: string;
  value: string;
  subValue?: string;
  trend?: "up" | "down" | "neutral";
  accent?: "blue" | "amber" | "green" | "red" | "purple";
  index?: number;
}

const accentColors: Record<string, string> = {
  blue: "bg-blue",
  amber: "bg-amber",
  green: "bg-green",
  red: "bg-red",
  purple: "bg-purple",
};

export default function MetricCard({ label, value, subValue, trend, accent = "blue", index = 0 }: MetricCardProps) {
  const trendColor =
    trend === "up" ? "text-green" : trend === "down" ? "text-red" : "text-foreground";

  return (
    <div
      className="glass-card p-5 relative overflow-hidden animate-slide-up"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-r ${accentColors[accent]}`} />
      <p className="text-xs text-muted font-medium uppercase tracking-wider pl-3">{label}</p>
      <div className="flex items-center gap-2 mt-1.5 pl-3">
        <p className={`text-2xl font-semibold ${trendColor}`}>{value}</p>
        {trend && trend !== "neutral" && (
          <svg width="14" height="14" viewBox="0 0 16 16" className={trendColor}>
            {trend === "up" ? (
              <path d="M8 3l5 7H3z" fill="currentColor" />
            ) : (
              <path d="M8 13l5-7H3z" fill="currentColor" />
            )}
          </svg>
        )}
      </div>
      {subValue && <p className="text-xs text-muted mt-1 pl-3">{subValue}</p>}
    </div>
  );
}
