// Types shared by /backtest pages and components.

export interface BacktestMetrics {
  total_return_pct: number;
  annual_return_pct: number;
  spy_total_return_pct: number;
  spy_annual_return_pct: number;
  alpha_total_pct: number;
  alpha_annual_pct: number;
  annual_vol_pct: number;
  sharpe_ratio: number;
  max_drawdown_pct: number;
  max_drawdown_peak_date: string | null;
  max_drawdown_trough_date: string | null;
  n_trading_days: number;
  n_trades: number;
  win_rate_pct: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  profit_factor: number | null;
  best_trade: ClosedTrade | null;
  worst_trade: ClosedTrade | null;
  regime_breakdown: Record<
    string,
    { days: number; pct_of_time: number; avg_daily_pnl_pct: number; total_pnl_pct: number }
  >;
  per_symbol: Array<{ symbol: string; trades: number; wins: number; pnl_total: number; avg_pnl_per_trade: number }>;
  hedge_trades: number;
  hedge_total_pnl: number;
  spy_baseline_equity: number[];
}

export interface ClosedTrade {
  symbol: string;
  entry_date: string;
  exit_date: string;
  qty: number;
  entry_price: number;
  exit_price: number;
  pnl: number;
  pnl_pct: number;
  reason: string;
  is_hedge: boolean;
}

export interface BacktestDaily {
  date: string;
  equity: number;
  cash: number;
  cash_pct: number;
  num_positions: number;
  pnl: number;
  pnl_pct: number;
  regime: string;
  risk_tier: string;
}

export interface SingleResult {
  kind: "single";
  generated_at: string;
  config: {
    start_date: string;
    end_date: string;
    starting_cash: number;
    slippage_bps: number;
    universe_size: number;
  };
  metrics: BacktestMetrics;
  daily_history: BacktestDaily[];
  closed_trades: ClosedTrade[];
  open_positions: unknown[];
}

export interface SweepRow {
  params: {
    score_threshold_delta: number;
    risk_per_trade_pct: number;
    trailing_stop_pct: number;
  };
  metrics: Partial<BacktestMetrics>;
}

export interface SweepResult {
  kind: "sweep";
  generated_at: string;
  start_date: string;
  end_date: string;
  results: SweepRow[];
}

export interface WalkForwardSegment {
  window_index: number;
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  best_params: { threshold_delta: number; risk_per_trade_pct: number };
  train_results: Array<{ delta: number; risk: number; alpha_annual_pct?: number; sharpe?: number; total_return_pct?: number; error?: string }>;
  test_metrics: Partial<BacktestMetrics>;
  test_daily_history: Array<{ date: string; equity: number }>;
}

export interface WalkForwardResult {
  kind: "walk_forward";
  generated_at: string;
  config: {
    start: string; end: string; starting_cash: number;
    train_months: number; test_months: number; max_windows: number;
    mini_grid_size: number;
  };
  segments: WalkForwardSegment[];
  aggregate: {
    mean_oos_alpha_annual_pct: number;
    mean_oos_sharpe: number;
    mean_oos_max_drawdown_pct: number;
    n_windows: number;
  };
}

export interface ComparisonResult {
  kind: "compare";
  generated_at: string;
  start_date: string;
  end_date: string;
  starting_cash: number;
  baseline: {
    label: string;
    params: string;
    metrics: BacktestMetrics;
    daily_history: Array<{ date: string; equity: number }>;
  };
  challenger: {
    label: string;
    params: SweepRow["params"] | string;
    metrics: BacktestMetrics;
    daily_history: Array<{ date: string; equity: number }>;
  };
  spy_baseline_equity: number[];
  delta: { alpha_annual_pp: number; sharpe: number; max_dd_pp: number };
}

export interface MonteCarloResult {
  kind: "monte_carlo";
  generated_at: string;
  start_date: string;
  end_date: string;
  n_simulations: number;
  baseline_metrics: BacktestMetrics;
  median_equity: number;
  p5_equity: number;
  p95_equity: number;
  median_spy_equity: number;
  median_alpha_pct: number;
  p5_alpha_pct: number;
  p95_alpha_pct: number;
  prob_beat_spy_pct: number;
  median_max_dd_pct: number;
  p5_max_dd_pct: number;
  p95_max_dd_pct: number;
  n_days_per_sim: number;
}
