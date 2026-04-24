export interface DailyHistory {
  date: string;
  pnl: number;
  pnl_pct: number;
  equity: number;
}

export interface PerformanceData {
  risk_tier: "NORMAL" | "CAUTIOUS" | "HALT";
  risk_tier_updated: string | null;
  equity: number;
  cash: number;
  cash_pct: number;
  daily_pnl: number;
  daily_pnl_pct: number;
  weekly_pnl: number;
  weekly_pnl_pct: number;
  monthly_pnl: number;
  monthly_pnl_pct: number;
  num_positions: number;
  updated_at: string;
  daily_history: DailyHistory[];
}

export interface Position {
  symbol: string;
  qty: number;
  avg_entry_price: number;
  current_price: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_plpc: number;
  side: string;
}

export interface PositionsData {
  updated_at: string;
  positions: Position[];
}

export interface Technicals {
  price: number;
  sma_20: number | null;
  sma_50: number | null;
  rsi_14: number | null;
  macd: number | null;
  macd_signal: number | null;
  bb_upper: number | null;
  bb_lower: number | null;
  bb_mid: number | null;
  volume: number;
  vol_avg_20: number | null;
  volume_ratio: number | null;
  five_day_return: number;
  above_sma20: boolean | null;
  above_sma50: boolean | null;
}

export interface Confidence {
  technical_score: number;
  news_score: number;
  perplexity_score: number;
  total: number;
  action: "BUY" | "HOLD" | "SELL";
}

export interface PerplexityResult {
  symbol: string;
  sentiment: string;
  perplexity_score: number;
  key_catalyst: string;
  risk: string;
  timeframe: string;
}

export interface SymbolResearch {
  technicals: Technicals;
  news_score: number;
  news_headlines: string[];
  confidence: Confidence;
  info: { sector?: string; notes?: string };
  perplexity?: PerplexityResult;
  error?: string;
}

export interface SpyBenchmark {
  symbol: string;
  price: number;
  sma_20: number | null;
  sma_50: number | null;
  rsi_14: number | null;
  five_day_return: number;
  monthly_return: number;
  market_regime: "BULL" | "BEAR" | "NEUTRAL" | "UNKNOWN";
  updated_at: string;
}

export interface ResearchData {
  updated_at: string;
  spy: SpyBenchmark;
  symbols: Record<string, SymbolResearch>;
  perplexity_enhanced_at?: string;
}

export interface MostActive {
  symbol: string;
  volume: number;
  trade_count: number;
}

export interface TopMover {
  symbol: string;
  change_pct: number;
  price: number;
  change: number;
}

export interface ScreenerData {
  updated_at: string;
  most_active: MostActive[];
  top_movers: TopMover[];
  trending: string[];
  scored_candidates: Record<string, SymbolResearch>;
}

export interface ComputedMetrics {
  cashReserveOk: boolean;
  maxPositionsOk: boolean;
  positionCount: number;
  maxPositionSize: number;
  portfolioUtilization: number;
  totalUnrealizedPl: number;
}
