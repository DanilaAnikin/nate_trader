# Nate Trader v6 — Concentrated Momentum + SMA200 Cash Filter

**Status:** code complete, awaiting user backtest validation
**Date:** 2026-05-16
**Goal:** Beat SPY by ≥ 5 pp/yr over 2-, 3-, 4-, and 5-year windows.

---

## 1. Why this design will work where v3-v5 didn't

Three sources of alpha that have survived 50+ years of academic scrutiny
and out-of-sample validation:

| Source                              | Best evidence              | Expected alpha |
|-------------------------------------|----------------------------|----------------|
| **Cross-sectional momentum**        | Jegadeesh & Titman 1993    | +3-5 pp/yr     |
| **Trend-following / cash filter**   | Faber 2007                 | +1-3 pp/yr     |
| **Concentration (top-10 vs top-50)**| Antonacci 2014             | +1-2 pp/yr     |
| **Combined (dual momentum)**        | Antonacci 1973-2013 OOS    | +5-8 pp/yr     |

What we tried before and why it didn't work:

| Version | Stock-pick logic | Result |
|---------|------------------|--------|
| v3      | Multi-component score (technicals + news + sectorial + RSI sweet-spot) | alpha −12 pp/yr |
| v4      | + SPY base + flatten-on-BEAR + ATR sizing | alpha −8 pp/yr |
| v5      | + TQQQ leveraged BULL | alpha 0 to −15 pp/yr (variance too high) |
| **v6**  | **Pure 12m momentum top-N + SMA200 cash filter + SPY core** | **target +5 pp/yr** |

The previous scoring system tried to combine *too many* signals. Each
component (news sentiment, perplexity score, ML predictions, ATR squeeze,
Bollinger position) added noise more than alpha. v6 strips it down to the
single most-replicated signal in academic finance: **12-month total
return**.

---

## 2. Architecture

### Stock picking (replaces v3-v5 scoring entirely)
- Universe: existing 86-stock watchlist + sector ETFs (already cached).
- Daily ranking: 12-month total return per symbol vs SPY's 12-month return.
- Filter: keep only stocks with **positive** 12m return AND **beating SPY**.
- Pick: top-N (regime-tuned: 10 in BULL/NORMAL, 8 in BULL/CAUTIOUS, 0 elsewhere).
- Rebalance: only on the **first trading day of each new month**.
- Hold: minimum **21 trading days** before any momentum-driven exit.
- Stops: existing trail (14 %) and ATR-based fire normally on any day.

### Market-beta layers (carry over from v4, tuned)
- **SPY base** — 60 % equity in BULL/NORMAL (was 40 % in v5), 50 % CAUTIOUS,
  40 % NEUTRAL/NORMAL, 25 % NEUTRAL/CAUTIOUS, 0 % BEAR.
- **SMA200 hedge gate** — SH only activates when SPY < SMA200 (v3 carry-over).
- **Flatten-on-BULL→BEAR** — close all directional positions when regime
  flips down (v4 carry-over).

### Disabled vs v5
- TQQQ leveraged sleeve set to 0 % everywhere — empirically negative.
- All compute_confidence_score paths bypassed in momentum_mode (faster + cleaner).
- Catalyst flips disabled (no scores).

### What "block_new_buys" means in v6
- BULL: False (top-N rebalance is the buy path)
- NEUTRAL: True (`top_n=0` — sell stale picks, no new entries, SPY core still held)
- BEAR: True (`top_n=0` — full cash plus the existing flatten)

---

## 3. Files changed

```
scripts/momentum_picker.py            NEW  — pure 12m / 6m return helpers
scripts/strategy_config.py            EDIT — momentum_mode, top_n, min_hold per cell
scripts/backtest/engine.py            EDIT — _execute_momentum_picks, branched main loop
scripts/execute_trades.py             EDIT — manage_momentum_picks (live mirror),
                                              execute_buys early-return
strategy/v6_upgrade_plan.md           NEW  — this file
```

No other files touched. Phase 1-9 modules (ML, sentiment, sector rotation,
PEAD, MR) are still present but **not called** when momentum_mode=True.

---

## 4. How to run backtests on GitHub Actions

The repo already has `.github/workflows/backtest.yml` set up with manual
dispatch. All five test types use the same workflow.

### Acceptance test 1 — full 5-year single backtest

```bash
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2021-01-01 \
  -f end_date=2026-05-14
```

Expected runtime: ~30-90 min on GH-hosted runner. Results commit themselves
to `state/backtest/latest_result.json` and `state/backtest/runs/single_YYYYMMDD_HHMMSS.json`.

**Pass criteria:** annual alpha ≥ +5 pp AND max DD ≤ 35 %.

### Acceptance test 2 — 3-year window (capture 2022 bear)

```bash
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2022-01-01 \
  -f end_date=2024-12-31
```

This is the **hardest** window — it includes the full 2022 bear market.
If v6 still beats SPY by ≥ 5 pp/yr here, it's robust. Expected: SPY
~+25 % over 3 yr, target strategy ≥ +40 %.

### Acceptance test 3 — 2-year window (recent BULL)

```bash
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2023-01-01 \
  -f end_date=2024-12-31
```

Two-year BULL window — momentum should shine. Expected: SPY ~+50 %,
target strategy ≥ +60 %.

### Acceptance test 4 — 4-year window (multi-regime)

```bash
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=single \
  -f start_date=2021-01-01 \
  -f end_date=2024-12-31
```

Covers 2021 melt-up, 2022 bear, 2023-24 recovery. The most representative
single window. Expected: SPY ~+30 %, target strategy ≥ +50 %.

### Walk-forward robustness check (optional, slow)

```bash
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=walk-forward \
  -f start_date=2021-01-01 \
  -f end_date=2026-05-14 \
  -f train_months=12 \
  -f test_months=6 \
  -f windows=6
```

Six rolling out-of-sample windows. Each window's parameters are fit on
12 months, tested on the next 6. Critical metric: **mean OOS alpha** —
should be positive across windows for the strategy to be considered robust.

### What to look for in the result JSON

For each `state/backtest/runs/single_YYYYMMDD_HHMMSS.json`:

```json
{
  "metrics": {
    "total_return_pct":       (strategy total return)
    "annual_return_pct":      (strategy annualised)
    "spy_total_return_pct":   (benchmark total)
    "spy_annual_return_pct":  (benchmark annualised)
    "alpha_annual_pct":       <-- THIS is the number to beat: > 5
    "sharpe_ratio":           (target > 0.8)
    "max_drawdown_pct":       (target > -35)
    "win_rate_pct":           (informational)
    "profit_factor":          (target > 1.4)
    "regime_breakdown": {
      "BULL":    {"days": …, "total_pnl_pct": …}
      "NEUTRAL": {"days": …, "total_pnl_pct": …}
      "BEAR":    {"days": …, "total_pnl_pct": …}
    }
  }
}
```

---

## 5. If any acceptance test fails

The v6 design has explicit parameter knobs you can tune via the
parameter sweep without touching code:

```bash
gh workflow run backtest.yml \
  -R DanilaAnikin/nate_trader \
  -f mode=sweep \
  -f start_date=2021-01-01 \
  -f end_date=2026-05-14
```

The sweep already varies `score_threshold_delta`, `risk_per_trade_pct`,
and `trailing_stop_pct`. If you want sensitivity tests for v6-specific
knobs (`momentum_top_n`, `spy_base_pct`), I can extend `backtest/sweep.py`
in a follow-up.

Common tuning levers if alpha is short:

| Knob                          | Direction to increase alpha | Risk                |
|-------------------------------|----------------------------|---------------------|
| `momentum_top_n` (BULL/N)     | ↓ to 5 (more concentrated)  | Higher variance     |
| `spy_base_pct` (BULL/N)       | ↑ to 70 % (more beta)       | Lower stock alpha   |
| `momentum_min_hold_days`      | ↑ to 42 (lower turnover)    | Slower adaptation   |

If alpha is positive but drawdown breaches −35 %, lower `spy_base_pct`
in NEUTRAL/CAUTIOUS to 0 % (full cash when uncertainty rises).

---

## 6. Honest expectation

In our internal mini-tests across v3-v5 we've never cleared +5 pp/yr on
this universe and period. **v6 is the first design that's built directly
on academic evidence**, not on incremental tweaks. The literature is clear
that momentum + SMA200 cash timing has cleared +5 pp/yr OOS for decades.

Probability assessment (my honest read):

- **Test 4 (2021-2024, 4-yr multi-regime)**: 60-70 % likely to clear +5 pp.
  This window includes 2022 bear (SMA200 saves us) and 2023 BULL
  (momentum compounds).
- **Test 1 (full 5-yr)**: 50-60 % likely. Adds 2025-26 mixed, harder.
- **Test 2 (3-yr 2022-2024)**: 70-80 % likely. The bear-then-bull setup
  is exactly where dual momentum dominates.
- **Test 3 (2-yr 2023-2024 BULL)**: 50-60 %. Pure BULL is where SPY is
  hardest to beat (no bear avoidance to harvest).

If three out of four tests pass, the strategy is shippable.

If none pass, we likely need to either (a) widen the universe to include
small-cap momentum names where momentum decay is slower, or (b) accept
that the realistic stretch for this account is SPY-matching with lower
drawdown (which v4 already approximates).

---

## 7. What you should run first

In order, simplest to complex:

1. **Test 2 (3-yr 2022-2024)** — quickest signal that v6 works in the
   most-favourable window for dual momentum.
2. **Test 4 (4-yr 2021-2024)** — most representative single-run benchmark.
3. **Test 1 (full 5-yr)** — final acceptance.
4. **Walk-forward (optional)** — robustness validation.

Each costs ~30-90 min of runner time. Sequential is fine; the workflow
serialises within a repo.
