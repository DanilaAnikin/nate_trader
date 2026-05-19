# S&P 500 Benchmark Tracking

## Methodology

Track SPY (SPDR S&P 500 ETF) as the benchmark. Alpha = portfolio return − SPY return over the same period.

**Goal (recalibrated 2026-05-19)**: **+5–10% alpha per year**, measured walk-forward out-of-sample.

The original `+5% / month` (~80%/yr) goal had no supporting backtest evidence and is mathematically near the ceiling of any disciplined retail momentum strategy. The current goal is at the high end of what a sophisticated multi-strategy system can sustain after costs and is consistent with the diagnostic data in `ALPHA_PLAN.md`.

**Source of truth**: `state/backtest/walk_forward_result.json` → `aggregate.mean_oos_alpha_annual_pct`. Single-window backtests are diagnostic only — they overfit by ~5pp on this codebase. A change ships only if WF mean OOS alpha ≥ +5%/yr across ≥3 windows.

**Holdout discipline**: 2025-01-01 → present is a reserved holdout window. The optimizer never sees it. Pass `--holdout-start=2025-01-01` to `scripts/backtest/run.py sweep` to enforce this on any new tuning run.

---

## Data Points Tracked

### Daily
- SPY open, high, low, close, volume
- SPY daily return %
- Portfolio daily return %
- Daily alpha (portfolio return − SPY return)

### Weekly
- SPY weekly return %
- Portfolio weekly return %
- Weekly alpha
- Rolling 5-day correlation with SPY

### Monthly
- SPY month-to-date return %
- Portfolio month-to-date return %
- Monthly alpha
- Sharpe ratio estimate (annualized)

---

## SPY Reference Data

Retrieved via `scripts/research.py spy`:
- Current price and daily change
- 20-SMA and 50-SMA (for market regime detection)
- RSI-14 (market overbought/oversold)
- Monthly return calculation

---

## Market Regime Detection

Based on SPY technicals:

| Regime | Condition | Portfolio Impact |
|--------|-----------|-----------------|
| **Bull** | SPY price > 20-SMA > 50-SMA | Full allocation, normal rules |
| **Neutral** | 20-SMA < SPY < 50-SMA or vice versa | Reduced allocation, tighter criteria |
| **Bear** | SPY price < 20-SMA < 50-SMA | Defensive — manage existing only |

---

## Performance Grading (Weekly)

| Grade | Monthly Alpha | Assessment |
|-------|--------------|------------|
| **A** | ≥ +5% | Exceeding target |
| **B** | +2% to +4.9% | On track |
| **C** | 0% to +1.9% | Below target, review strategy |
| **D** | −1% to −0.1% | Underperforming, consider changes |
| **F** | < −1% | Failing, trigger strategy review |
