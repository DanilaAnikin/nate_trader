# Nate Trader v4 — Hit the +5 pp/yr Alpha Goal

**Status:** in progress
**Date:** 2026-05-15 (afternoon, after v3 wrap)
**Goal:** Annual alpha ≥ +5 pp vs SPY OR total strategy annual return ≥ SPY.

---

## 1. The honest diagnosis after v3

v3 took us from baseline `+1.7 %/yr` to `+3.3 %/yr` (alpha −12.4 %). Real
constraint is structural, not parametric:

| Regime | % time | Annualised P&L | Annualised SPY P&L (≈) |
|--------|--------|----------------|------------------------|
| BULL   | 50 %   | ~ +15 %        | ~ +30 %                |
| NEUTRAL| 36 %   | ~ −15 %        | ~ +5 %                 |
| BEAR   | 15 %   | ~ 0 %          | ~ −5 %                 |

**In BULL we earn ~SPY but it's only 50 % of the time. In NEUTRAL we
*lose* money while SPY rises slowly.** Combined we annualise +3 % vs SPY
+15 %.

There is no parameter combination that fixes this. The fix is structural:

1. **Be invested in the market itself**, not just in stock-picking,
   *during BULL*. A passive SPY core captures market beta we currently miss.
2. **Be flat in NEUTRAL and BEAR** — not in inherited BULL positions
   bleeding through chop. Flatten the directional book on regime
   transition.
3. Trust the trailing stop to ride normal volatility — stop **scaling
   out** of winners and **stop tight trail stops** that get hit by routine
   10 % pullbacks.

---

## 2. v4 Plan — three structural changes

### Step A — SPY base position
- Add `spy_base_pct` per (regime, risk_tier) cell.
  - BULL/NORMAL: **50 %**
  - BULL/CAUTIOUS: **30 %**
  - NEUTRAL/* and BEAR/*: **0 %**
- New `manage_spy_base()` mirrors `manage_bear_hedge()` — rebalance to
  target when drift > 2 % of equity.
- SPY base exempt from sector cap, position-count cap, gate score, HALT
  block (it's structural beta, not a directional bet).
- Mark SPY tradeable in `watchlist.json` so the engine can hold it.
- The mark-to-market path already handles SPY because it's the regime
  symbol — bars are always present.

### Step B — Flatten on regime transition
- Engine tracks **previous-day regime**. When today's regime is
  NEUTRAL/BEAR and yesterday's was BULL, close all non-SPY/non-SH
  positions at today's open.
- SPY base also goes to 0 % (handled by Step A's target table).
- This eliminates the slow bleed of BULL positions held through
  NEUTRAL chop. The trade-off is occasionally selling a future winner
  in a brief regime dip; we accept that, the data says NEUTRAL never
  recovers cleanly.

### Step C — Widen stops, remove scale-out
- BULL/NORMAL `trailing_stop_pct`: **14 %** (was 9). Normal SPY-style
  pullbacks are 10-15 % within a structural uptrend.
- BULL/NORMAL `tightened_stop_pct`: **9 %** (was 6) — same reasoning.
- Disable scale-out entirely: set `scale_out_at_gain` very high (999 %)
  so it never fires. Trailing stop manages all exits. Reasoning: NVDA
  ran 10x; selling half at +12 % left huge gains on the table.

---

## 3. Acceptance

Single backtest over `2021-01-01 → 2026-05-14`, `$1 M` start, full 86-sym
universe (same as v3_merged_final). v4 passes iff **either** of:

- Annual alpha ≥ +5 pp **OR**
- Strategy annual return ≥ SPY annual return (i.e. alpha ≥ 0).

Hard floor: max drawdown not worse than v3_merged_final by more than +5 pp.

If a single run doesn't pass, iterate `spy_base_pct`, `trailing_stop_pct`,
and `flatten_on_transition` toggles up to 5 times. Each iteration is
documented inline in this file with a one-line result summary.

---

## 4. What v4 is NOT doing

- **No leveraged ETFs.** TQQQ / SQQQ work in backtest but the
  acceptance test would be fragile to vol regime changes. Paper trading
  is for testing the *strategy*, not for chasing 3x beta.
- **No options.** Adds operational complexity (assignment, expiry,
  rolling) that the paper account isn't ready for.
- **No new alpha sources** (ML, sentiment, sector rotation). The Phase
  9 layers already exist on remote and v4 builds *on top* of them.

---

## 5. Files touched

```
strategy/v4_upgrade_plan.md          NEW (this file)
strategy/rules.md                    EDIT (note SPY base + flatten rules)
CLAUDE.md                            EDIT (note SPY base + flatten rules)
watchlist.json                       EDIT (SPY tradeable=true)
scripts/strategy_config.py           EDIT (spy_base_pct, trail widths)
scripts/execute_trades.py            EDIT (manage_spy_base, flatten_on_transition)
scripts/backtest/engine.py           EDIT (mirror SPY base + flatten + previous-day regime)
```

---

## 6. Iteration log

### Iter 1 (killed) — "flush everything on regime change"
- Config: `spy_base_pct=0` in NEUTRAL/BEAR, `flatten_on_transition=True` for both.
- Result: regime classifier (SMA 20/50) flipped BULL↔NEUTRAL ~weekly,
  churning the directional book + SPY core. Slippage > 1 % per flush.
  Killed at ~50 % through, equity at $972 K (−2.8 %).
- Lesson: NEUTRAL is not a crash, it's chop. Flushing the core fights us.

### Iter 2 — "keep SPY base across regimes, flatten only on BULL→BEAR"
- Config:
  - `spy_base_pct` = 50 / 30 / 30 / 20 / 0 / 0
    (BULL-N / BULL-C / NEU-N / NEU-C / BEAR-N / BEAR-C)
  - `flatten_on_transition` = True only in BEAR cells (NEUTRAL keeps held positions)
- Sub-test 2024-01-01 → 2026-05-14 (2.4 y, BULL-heavy):
  - Return **+38.91 %**, ann. **+14.96 %**, SPY ann. +22.92 %, alpha −7.95 %/yr
  - **Sharpe 1.25**, **Max DD −10.30 %**, **Profit factor 1.53**
  - SPY base is top contributor: +$80,952 from passive beta hold
  - vs v3 (full period): annual return 4.5×, max DD half, sharpe 4×
- Lesson: SPY base captures most of the beta we used to miss. Stock picks
  layer modest alpha on top.

### Full 5-year run (in progress)
- Acceptance test 2021-01-01 → 2026-05-14
- Result will be appended below when backtest lands.
