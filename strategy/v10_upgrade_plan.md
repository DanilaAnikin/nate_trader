# v10 — TQQQ overlay (BULL + NEUTRAL) — 2026-05-19

Builds on v7 production. Replaces SSO as primary BULL beta with a TQQQ
overlay that is gated by SPY > SMA50 AND SMA200, and extends the same
overlay into NEUTRAL regimes (mild pullbacks within an intact uptrend).

## Why this works

v7 was at a documented ceiling: 9 iterations had failed to lift IS alpha
above −2.4%/yr (full 2021-2026) or OOS WF alpha above −7.4%/yr. The
ablation experiment on 2026-05-19 confirmed that none of the gate-path
modules (ML, PEAD, mean-reversion, sentiment, multi-timeframe,
sector-rot) actually fire in BULL momentum_mode — they live in code
paths the backtest doesn't exercise.

That diagnosis re-framed the search: the only knobs that matter for
BULL alpha in this engine are the **base allocation, the leveraged ETF
overlays, and the trailing-stop width**. The momentum stock-picker
contributes a marginal ~+1.5pp on top of these.

## What changed (vs v7)

### BULL/NORMAL
| Field | v7 | v10 |
|---|---|---|
| base_pct | 60 | 20 |
| base_instrument | SSO | SSO (kept as floor) |
| tqqq_pct | 0 | 80 |
| trailing_stop_pct | 14 | 40 |
| tightened_stop_pct | 9 | 35 |
| max_position_pct | 7 | 15 |

### BULL/CAUTIOUS — symmetric, slightly de-risked
| Field | v7 | v10 |
|---|---|---|
| base_pct | 50 | 30 |
| tqqq_pct | 0 | 60 |
| trailing_stop_pct | 12 | 35 |

### NEUTRAL/NORMAL — the big alpha lift
| Field | v7 | v10d |
|---|---|---|
| base_pct | 40 | 0 |
| base_instrument | SPY | SPY |
| tqqq_pct | 0 | 100 |
| flatten_on_transition | True | True (kept) |

In NEUTRAL the TQQQ gate (SPY > SMA50 AND SMA200) keeps leverage on
during mild pullbacks within an intact bull market. Deep pullbacks that
break SMA50 zero out the position automatically. So in practice TQQQ
runs in NEUTRAL only during the dip-buy window — exactly when it should.

### NEUTRAL/CAUTIOUS
| Field | v7 | v10d |
|---|---|---|
| tqqq_pct | 0 | 50 |
| base_pct (SPY) | 25 | 0 |

### BEAR hedge
| Field | v7 | v10d |
|---|---|---|
| `_BEAR_HEDGE_PCT` (target SH%) | 25 | 10 |

The SH (inverse SPY) hedge had been a consistent net drag of ~−$10k/5y.
Sweep: hedge=10% gave the best alpha at +25.5%, vs +24.7% (hedge=0) and
+23.8% (hedge=25, was). Kept at 10% — real protection without daily bleed.

## Backtest evidence

```
                 v7        v10d
              ───────────  ───────────
2021-24 IS α    −5.08%      +25.46%
2021-24 Sharpe    0.71        1.53
2021-24 DD      −22.7%      −20.1%

2025 holdout α              +46.02%   (never seen during tuning)
Full 5y α       −2.4%       +29.80%
Full 5y Sharpe    1.00        1.73

WF 8 windows
mean OOS α      −7.4%       +54.93%
mean OOS Sharpe              1.98
mean OOS DD                  −14.50%
```

Per-window OOS alphas (8 walk-forward windows, 2022 H1 → 2025 H2):
+29.6, −8.1, +196.6, +50.5, +72.1, +18.2, +48.2, +32.3.

Worst single window: 2022 H2 (the SPY breakdown), −8.1%/yr. The
SMA50+SMA200 gate flattened TQQQ during that period, so the strategy
lost less than SPY did — that's how it still beat SPY in 2022 H1
(+29.6%) and barely lost in H2.

## What was tested and rejected

1. **QQQ-vs-SPY relative-strength gate** (v10d, v10e). Tried blocking
   TQQQ when QQQ trailed SPY on 60-day return (to fix the 2021 weakness
   where SPY ran broadly without tech). At threshold 0pp the gate
   regressed alpha by 12pp; at threshold −3pp it regressed by 6pp. The
   issue: even normal BULL legs have multi-week stretches where QQQ
   trails SPY by 2-4pp, and blocking TQQQ during those crushes returns.
   Reverted — keeping SMA-only gate.

2. **Quality filter on momentum picks** (`apply_quality_filter=True`).
   SMA200 + 6m/12m consistency + 80% vol cap. Regressed by ~1pp.
   Plumbing kept (`momentum_quality_filter` param) for future sweeps.

3. **TQQQ ≥ 90% in BULL**. Alpha kept rising but drawdown hit −27%
   and Sharpe slid. Cap at 80% in BULL/NORMAL.

4. **flatten_on_transition = False**. Regressed −0.1pp. The forced exit
   on confirmed regime change protects more than it costs.

## Live wiring (2026-05-19)

`scripts/execute_trades.manage_tqqq_position()` — mirrors backtest's
`_manage_tqqq` with the same SMA gate, target_pct from
strategy_config, and rebalance threshold. Marked `strategy=base`
in `strategy_metadata` so the position is exempt from sector cap,
position-count cap, and HALT block.

`scripts/trade.sync_trailing_stops()` — adds explicit skip-list
{SPY, SSO, TQQQ, SH} so the daily stop-sync doesn't attach a trailing
stop to the TQQQ overlay (its exit is the SMA gate, not a price trail).

`_is_infrastructure()` in execute_trades.py — extended to include
TQQQ so all existing infrastructure-aware code paths (catalyst-flip
exits, time stops, scale-outs, etc.) skip the overlay correctly.

## What v10d is NOT

- A "set and forget" magic strategy. It's a levered trend-follower on
  QQQ with circuit breakers. Years like 2021 (broad-market rally, tech
  rotation) will show low or slightly negative alpha. The strategy
  delivers when there are clear tech-led BULL legs, which has been most
  years 2022-2026.

- Diversified. The strategy is heavily QQQ-biased by design. A regime
  where QQQ structurally lags SPY for years would be a tail risk.

- Free of drawdown. Max DD in the 5-year backtest is −20%. Live
  trading in CAUTIOUS tier (post a −1.5% week) will reduce TQQQ
  exposure to ~half, but a −20% paper-account swing is realistic.

## Pending / future work

1. **Wire PEAD + mean-reversion into the backtest engine.** Both are
   fully implemented in live but never measured in backtest. Adding them
   may lift OOS alpha further or expose them as dead code worth
   removing.

2. **UPRO / SOXL parallel overlays.** Currently the strategy is
   single-overlay (TQQQ). A small UPRO sleeve would diversify the
   leveraged exposure away from QQQ. Needs cached bars (`UPRO.json`
   download).

3. **WF-objective sweep.** Lock the final 3-knob subset (threshold_delta,
   risk_per_trade_pct, trailing_stop_pct) via
   `--metric=wf_alpha --holdout-start=2025-01-01`. Started 2026-05-19
   at 17:36 — log will indicate optimal cell.

4. **Live monitoring.** `monitor_drift.py` baseline is now the new WF
   distribution (mean +55%, σ ~50pp across 8 windows). Drift detector
   should re-baseline after the first 30 trading days of live v10d.
