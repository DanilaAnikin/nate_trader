"use client";

interface SpyComparisonProps {
  portfolioReturn: number;
  spyReturn: number;
}

export default function SpyComparison({ portfolioReturn, spyReturn }: SpyComparisonProps) {
  const alpha = portfolioReturn - spyReturn;

  return (
    <div className="glass-card p-6">
      <h3 className="text-sm font-medium text-secondary mb-6">Monthly Return vs SPY</h3>

      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 text-center">
          <p className="text-xs text-muted uppercase tracking-wider mb-1">Portfolio</p>
          <p className={`text-3xl font-semibold ${portfolioReturn >= 0 ? "text-blue" : "text-red"}`}>
            {portfolioReturn >= 0 ? "+" : ""}{portfolioReturn.toFixed(2)}%
          </p>
        </div>

        <div className="flex flex-col items-center">
          <div className={`px-4 py-2.5 rounded-xl ${
            alpha >= 0
              ? "bg-green/8 text-green"
              : "bg-red/8 text-red"
          }`}>
            <p className="text-[10px] uppercase tracking-wider text-center opacity-60 font-medium">Alpha</p>
            <p className="text-lg font-bold text-center">
              {alpha >= 0 ? "+" : ""}{alpha.toFixed(2)}%
            </p>
          </div>
        </div>

        <div className="flex-1 text-center">
          <p className="text-xs text-muted uppercase tracking-wider mb-1">SPY</p>
          <p className={`text-3xl font-semibold ${spyReturn >= 0 ? "text-secondary" : "text-red"}`}>
            {spyReturn >= 0 ? "+" : ""}{spyReturn.toFixed(2)}%
          </p>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-border">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Relative result for available monthly data</span>
          <span className={`font-medium ${alpha >= 0 ? "text-green" : "text-red"}`}>
            {alpha >= 0 ? "Ahead of SPY" : "Behind SPY"}
          </span>
        </div>
      </div>
    </div>
  );
}
