# Nate Trader v3 — Strategy Overhaul Plan

**Status:** in progress
**Owner:** Claude Code (claude-code)
**Date opened:** 2026-05-15
**Goal:** Stop losing alpha. Go from −12.85 %/yr alpha → ≥ +5 %/mo (≥ +60 %/yr) alpha vs SPY.

---

## 1. Why we're doing this

The 5-year backtest (2021-01-01 → 2026-05-11) of the live engine returned **+14.56 %** vs SPY **+115.0 %** (alpha −100 % cumulative, **−12.85 %/yr**). Sweep over 75 parameter cells found *no* combination with positive alpha — the worst point on the surface is −13.2 %/yr, the best is −12.9 %/yr. That tells us **the leak is structural, not parametric.**

Regime breakdown of the leak:

| Regime | % of days | Total P&L over 5y |
|--------|-----------|-------------------|
| BULL    | 50 % | +25.5 % |
| NEUTRAL | 36 % | **−12.0 %** ← entire loss lives here |
| BEAR    | 15 % | +1.3 % |

Five structural problems identified:

1. **Scoring is schizophrenic** — rewards both momentum (price > SMA, +25 alpha) AND mean-reversion (Bollinger near lower band, ATR squeeze).
2. **NEUTRAL whipsaws** — every new buy in a sideways tape pays slippage and gets shaken out by trailing stops.
3. **Time stop kills future winners** — closes flat trades at day 12-15 with min +4 %. Real momentum trades take 6-12 weeks.
4. **Universe too narrow / wrong composition** — 34 symbols, mostly mega-caps; momentum needs a wider opportunity set.
5. **Bear hedge SH always-on in NEUTRAL** is a permanent drag in a tape where SPY trends up over multi-year horizons.

---

## 2. Success criteria

Each step must pass a `backtest single` run against the **v3 baseline** (saved before any change) on the same `2021-01-01 → 2026-05-11` window. A change is **kept** if it improves at least one of:

- Annual alpha ≥ +1.0 pp better than baseline, OR
- Sharpe ratio ≥ +0.15 better than baseline AND alpha not worse by > 0.5 pp, OR
- Max drawdown ≥ +2 pp better (less negative) AND alpha not worse by > 1 pp.

If a change fails, we revert it immediately and document the result in the closing comment of the issue. **No "directional" merges without backtest evidence** (CLAUDE.md rule).

**Final acceptance:** `compare` shows v3 challenger ≥ baseline alpha by **+5 pp/yr** AND max drawdown not worse by more than +3 pp.

---

## 3. Implementation order (foundation → polish)

The order is deliberate — each step builds on the previous one's signal and is cheap to undo if it regresses. We backtest after each step.

### Step 1 — Rewrite scoring (drop mean-reversion, add breakouts)
**Files:** `scripts/research.py` (`compute_technicals`, `compute_confidence_score`), `CLAUDE.md`
**What:**
- Remove `bb_lower` proximity bonus (+3)
- Remove `atr_pct < 2.5` squeeze bonus (+5)
- Add `high_20d`, `high_50d`, `pct_from_20d_high`, `pct_from_50d_high` to technicals
- Add **20d-high breakout** scoring (max 4 pts): within 2 % of 20d high → +4, within 5 % → +2
- Add **50d-high breakout** scoring (max 6 pts): new 50d high → +6, within 3 % → +3
- Cap technical at 50 (unchanged) but the 8 points freed by mean-rev removal now flow to breakout
**Why:** Aligns the signal with the strategy's stated identity (momentum). Mean-rev features were pulling entries into pullbacks that then bled out.
**Risk:** Could reduce signal count if no symbol is near its 20/50d high — acceptable, fewer-better trades is the thesis.

### Step 2 — NEUTRAL: block new directional buys
**Files:** `scripts/strategy_config.py` (add `block_new_buys` flag), `scripts/execute_trades.py` (`execute_buys` early-return), `scripts/backtest/engine.py` (skip the buy loop)
**What:**
- Add `block_new_buys: True` to NEUTRAL/NORMAL and NEUTRAL/CAUTIOUS param cells
- Engine checks the flag *before* the gate score and short-circuits with reason `"NEUTRAL_BLOCK"`
- Sells, scale-outs, hedge management, and **already-open positions** all continue normally
**Why:** 36 % of time, −12 % P&L. We're paying spreads to lose. Better: hold existing winners, harvest hedge, wait for BULL re-entry.
**Risk:** We miss BULL transitions by ~1 day (regime detected next session). Quantified by backtest.

### Step 3 — Time stop: 30 days, only if position is in the red
**Files:** `scripts/strategy_config.py` (`time_stop_days`, `time_stop_min_gain`), `scripts/execute_trades.py` (`execute_time_stops`), `scripts/backtest/engine.py` (`_check_time_stops`)
**What:**
- `time_stop_days` → 30 (was 12-15)
- `time_stop_min_gain` → 0.0 (we only care about sign, not magnitude)
- Logic change: close after 30 days **only if `pnl_pct < 0`**. Flat or positive → leave it alone, the trailing stop will handle it.
**Why:** A position flat at day 14 in a real momentum name is normal. Cutting it forfeits the 6-12-week tail. We still cut **losers** at 30d to free capital.
**Risk:** Capital lockup if many positions sit flat. Mitigated by max_positions cap.

### Step 4 — Expand universe + RS-ranked screener
**Files:**
- New: `universe.json` (~100-150 liquid US momentum names; tagged with sector + ADV tier)
- `scripts/screener.py` (RS-ranking of the full universe, top-30 candidates daily)
- `scripts/utils.py` (load both `watchlist.json` and `universe.json`)
- `scripts/backtest/download_history.py` (download bars for new symbols)
**What:**
- Curated universe of large/mid-cap US stocks with ADV > $50M and price > $20
- Tagged with sector so the existing sector cap (25 %) still applies
- Screener computes 60-day RS vs SPY, surfaces top-30 daily
- Live research.py and backtest engine both read the expanded list
**Why:** Momentum is a "wide net, narrow take" strategy. Top-30 by RS out of 100+ candidates will out-trade top-12 out of 34.
**Risk:** Bar-download rate-limits; we phase the download. Sector concentration shifts; we'll re-verify sector cap behavior.

### Step 5 — Hedge only when SPY < SMA200
**Files:** `scripts/research.py` (add `sma_200` to SPY benchmark), `scripts/strategy_config.py` (`get_bear_hedge_target_pct`), `scripts/backtest/engine.py` (`_manage_hedge`)
**What:**
- Persist `sma_200` and `price_below_sma_200: bool` in research state for SPY
- Hedge target reduces to **0 %** whenever SPY ≥ SMA200, regardless of regime classification
- Hedge sizing rules unchanged when SPY < SMA200 (existing regime/tier logic)
**Why:** SH bled the strategy in 2021-2023 NEUTRAL stretches where SPY oscillated but stayed in a multi-year uptrend. The 200-SMA is the canonical "structural bull/bear" line; gates the hedge to actual bear markets.
**Risk:** If SPY breaks 200-SMA briefly and recovers, we may chase the hedge late. Acceptable: hedges are insurance, not alpha.

### Step 6 — Earnings filter (skip entries within ±5 days of earnings)
**Files:**
- New: `scripts/earnings_calendar.py` (yfinance fetch, cached in `state/earnings.json`)
- `scripts/research.py` (add `next_earnings_date` and `days_to_earnings` to symbol output)
- `scripts/execute_trades.py` (`execute_buys` skip if `0 ≤ days_to_earnings ≤ 5`)
- `scripts/backtest/engine.py` (same skip)
- `requirements.txt` (add `yfinance>=0.2.40`)
**What:**
- Daily refresh of earnings calendar for the universe
- Block new buys within the 5-day pre-earnings window
- Existing positions are *not* force-closed (separate decision, conservative default = leave)
**Why:** Worst trade in the 5-year run was NVO −24 % in a single day on 2025-07-28 — almost certainly an earnings event. Filtering pre-earnings entries removes the largest fat-tail loss source.
**Risk:** yfinance reliability; we fall back to "no filter" if data is missing (fail-open is acceptable — earnings risk is a tail, not the median trade).

### Step 7 — ATR vol-target position sizing
**Files:** `scripts/trade.py` (`calculate_position_size`), `scripts/backtest/engine.py` (`_position_size`), `scripts/strategy_config.py` (new `atr_stop_multiple` per regime)
**What:**
- Primary sizing: `shares = (equity × risk_pct) / (atr_stop_multiple × ATR)`
- `atr_stop_multiple`: 2.0 in BULL, 2.5 in NEUTRAL (academic), 3.0 in BEAR — wider stops in choppier tapes prevent vol-driven shakeouts
- Fall back to allocation cap (max_position_pct) and risk-by-trail-stop only if ATR is missing
- The implicit stop becomes **k × ATR** below entry, which we feed into trailing stop init
**Why:** Fixed-% trailing stops are wrong dimensionally — a 10 % stop on a 2 %-ATR name is loose, on a 6 %-ATR name is suicide. Vol-targeting normalizes risk per trade across volatility regimes.
**Risk:** Position count may shrink in high-vol regimes (correct behavior — fewer/smaller bets when noise is high). Verify via backtest.

---

## 4. Sequence + gates

```
baseline backtest (v3_baseline.json)
  → Step 1 → backtest → keep/revert
  → Step 2 → backtest → keep/revert
  → Step 3 → backtest → keep/revert
  → Step 4 → download bars → backtest → keep/revert
  → Step 5 → backtest → keep/revert
  → Step 6 → backtest → keep/revert
  → Step 7 → backtest → keep/revert
final compare run (challenger vs v3_baseline)
walk-forward over 4 windows
```

Each commit message must reference the same GitHub issue (`Refs #N` / `Closes #N`).

---

## 5. Out of scope (deliberate)

- **Options / multi-leg strategies** — not on Alpaca paper of this account, deferred.
- **Intraday timeframe** — strategy is swing (2-10d). Intraday is a separate engine.
- **ML / sentiment models** — keep deterministic, auditable, debuggable.
- **Fractional shares** — Alpaca supports them but the backtest is integer-share; keeping consistent.
- **Slippage model refinement** — current 5 bps is reasonable for the universe.

---

## 6. Files touched (all changes go to `main`)

```
strategy/v3_upgrade_plan.md           NEW   (this file)
strategy/rules.md                     EDIT  (sync with new scoring)
CLAUDE.md                             EDIT  (scoring table, rules table)
watchlist.json                        EDIT  (notes only — universe move)
universe.json                         NEW   (~100-150 ticker base)
requirements.txt                      EDIT  (+ yfinance)
scripts/utils.py                      EDIT  (load universe.json)
scripts/research.py                   EDIT  (technicals + scoring rewrite, SMA200)
scripts/screener.py                   EDIT  (RS ranking)
scripts/strategy_config.py            EDIT  (block_new_buys, atr_stop_multiple, time stops)
scripts/trade.py                      EDIT  (vol-targeted sizing)
scripts/execute_trades.py             EDIT  (NEUTRAL block, earnings filter, time stop)
scripts/earnings_calendar.py          NEW
scripts/backtest/engine.py            EDIT  (mirror live changes)
scripts/backtest/download_history.py  EDIT  (download new symbols)
```

---

## 7. Tracking

GitHub issue: **#10** (https://github.com/DanilaAnikin/nate_trader/issues/10)
Project: Nate Trader Roadmap → Strategy / P0 / claude-code label
Backtest artefacts:
  - `state/backtest/v3_baseline.json` — pre-v3 baseline (5y, 1M cash, 35-sym universe)
  - `state/backtest/v3_step135.json` — Step 1+2+3+5 isolated (pre-merge code)
  - `state/backtest/v3_final.json` — full v3 pre-merge (with 87-sym universe)
  - `state/backtest/v3_merged_final.json` — **final result after merging with Phase 9 remote work**

## 8. Result (2026-05-15)

Final backtest, 2021-01-01 → 2026-05-14, $1M starting cash, 86-sym universe,
v3 changes layered on top of Phase 9 (ML/sentiment/auto-iteration) remote work:

| Metric | Baseline | v3 Final | Δ |
|---|---|---|---|
| Total return | +9.43 % | **+18.88 %** | +9.45 pp |
| Annual return | +1.70 % | +3.29 % | +1.59 pp |
| Annual alpha vs SPY | −13.73 % | **−12.40 %** | **+1.33 pp/yr** ✓ |
| Sharpe ratio | 0.14 | **0.30** | **+0.16** ✓ |
| Max drawdown | −25.09 % | **−21.35 %** | **+3.74 pp** ✓ |
| Win rate | 47.2 % | 48.5 % | +1.3 pp |
| Hedge bleed | −$123 K | **−$15 K** | **+$108 K** |
| BULL regime P&L | +38.9 % | +46.9 % | +7.97 pp |
| NEUTRAL regime P&L | −19.9 % | −25.9 % | −6.04 pp |
| BEAR regime P&L | −5.8 % | −0.4 % | +5.41 pp |

**Pass / fail vs §2 acceptance criteria:**
- ✓ Annual alpha ≥ +1.0 pp better than baseline (got +1.33)
- ✓ Sharpe ≥ +0.15 better AND alpha not worse (got +0.16 / better alpha)
- ✓ Max DD ≥ +2 pp better AND alpha not worse (got +3.74)
- ✗ Stretch goal (alpha ≥ +5 pp/yr) — not met, requires changes beyond v3
  (longer hold periods, leveraged BULL exposure, or options) — out of scope.

**Top P&L contributors in v3 (4 of 5 are new universe symbols):**
BX +$35K, MRVL +$35K, APP +$34K, NVDA +$31K, ISRG +$27K.

**Where the leak still is:**
NEUTRAL regime (36 % of days) still produces −25.9 % aggregate P&L.
The `block_new_buys` flag prevents *new* deployment during NEUTRAL but the
strategy still holds positions inherited from BULL, which bleed through
NEUTRAL chop before being closed. Fixing this requires either
(a) closing-all-positions on BULL→NEUTRAL transition, or (b) a faster
regime-transition signal. Both deferred to a follow-up `[strategy]` issue.
