"use client";

interface SpyComparisonProps {
  portfolioReturn: number;
  spyReturn: number;
}

export default function SpyComparison({ portfolioReturn, spyReturn }: SpyComparisonProps) {
  const alpha = portfolioReturn - spyReturn;
  const target = 5;
  const onTrack = portfolioReturn >= spyReturn + target;

  return (
    <div className="glass-card rounded-lg p-6">
      <h3 className="text-sm font-medium text-secondary mb-6">Monthly Return vs SPY</h3>

      <div className="flex items-center justify-between gap-4">
        {/* Portfolio */}
        <div className="flex-1 text-center">
          <p className="text-xs text-muted uppercase tracking-wider mb-1">Portfolio</p>
          <p className={`text-3xl font-bold ${portfolioReturn >= 0 ? "text-blue" : "text-red"}`}>
            {portfolioReturn >= 0 ? "+" : ""}{portfolioReturn.toFixed(2)}%
          </p>
        </div>

        {/* Alpha Badge */}
        <div className="flex flex-col items-center">
          <div className={`px-3 py-2 rounded-lg border ${
            alpha >= 0
              ? "bg-green/10 border-green/20 text-green"
              : "bg-red/10 border-red/20 text-red"
          }`}>
            <p className="text-[10px] uppercase tracking-wider text-center opacity-70">Alpha</p>
            <p className="text-lg font-bold text-center">
              {alpha >= 0 ? "+" : ""}{alpha.toFixed(2)}%
            </p>
          </div>
        </div>

        {/* SPY */}
        <div className="flex-1 text-center">
          <p className="text-xs text-muted uppercase tracking-wider mb-1">SPY</p>
          <p className={`text-3xl font-bold ${spyReturn >= 0 ? "text-secondary" : "text-red"}`}>
            {spyReturn >= 0 ? "+" : ""}{spyReturn.toFixed(2)}%
          </p>
        </div>
      </div>

      {/* Target line */}
      <div className="mt-6 pt-4 border-t border-border/50">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="text-muted">Progress to +5% target over SPY</span>
          <span className={onTrack ? "text-green font-medium" : "text-amber font-medium"}>
            {onTrack ? "On Track" : `${(alpha - target).toFixed(1)}% to go`}
          </span>
        </div>
        <div className="h-2 bg-border/50 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              alpha >= target ? "bg-green" : alpha >= 0 ? "bg-blue" : "bg-red"
            }`}
            style={{ width: `${Math.min(Math.max((alpha / target) * 100, 0), 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted mt-1">
          <span>SPY baseline</span>
          <span>+5% target</span>
        </div>
      </div>
    </div>
  );
}
