"""Nate Trader — backtest framework.

Production-grade replay of the live strategy on historical data:

  download_history.py   — fetch + cache daily OHLCV for the universe
  data_provider.py      — point-in-time bar access (no look-ahead)
  news_proxy.py         — price-action proxies for news + Perplexity
                          scores (real APIs can't be replayed)
  portfolio_sim.py      — simulated cash, positions, equity tracking
  engine.py             — day-by-day decision loop mirroring
                          execute_trades.run_execution()
  metrics.py            — Sharpe, drawdown, alpha, regime breakdown,
                          per-symbol P&L
  sweep.py              — grid search over key parameters
  monte_carlo.py        — bootstrap of daily returns for CI on alpha
  run.py                — CLI entry point

Results land in state/backtest/*.json so the dashboard /backtest page
can render them with the same fetchStateFile path used elsewhere.
"""
