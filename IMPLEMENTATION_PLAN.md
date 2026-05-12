# Implementation Plan — Path to +5%/month above SPY

**Date**: 2026-05-12
**Goal**: Beat SPY by 5% per month (≈ +60% annual alpha)
**Current OOS alpha** (walk-forward, mean of 3 windows): +1.09%/yr
**Gap to close**: ~58 percentage points of annual alpha

This document is the single source of truth for closing that gap. It
describes (a) the diagnosed weaknesses in the v2 engine, (b) eight
concrete architectural changes that together target the goal, and
(c) the order in which they will be built and validated.

---

## 1. Diagnosis — What's wrong today

The v2 engine (commit `47b44b7`) fixed real bugs and rebalanced scoring
(50/25/25 tech/catalyst/alpha) with a weighted gate. Walk-forward
post-v2 shows the structural problem:

```
Window 1 (train 2021, test H1 2022):   OOS α = +33.77%   ← bull tail
Window 2 (train H2 2021-H1 2022,
          test H2 2022 = bear):         OOS α = −11.10%   ← bear bleed
Window 3 (train 2022, test H1 2023):    OOS α = −19.41%   ← regime change
Mean OOS α:                              +1.09%/yr
```

The 53-percentage-point spread between best and worst window is the
single biggest diagnostic. The current engine is a **bull-only
momentum harvester** — it works in trends, fails everywhere else.

### Root causes

| # | Root cause | Evidence |
|---|-----------|----------|
| **A** | Pure momentum has no edge in NEUTRAL / BEAR | NEUTRAL = −11.97% total P&L, BEAR = +1.33% in 197d |
| **B** | No fundamental risk filtering (earnings binary risk) | 849 trades over 5y, ~3-5% near earnings dates per stock per year |
| **C** | No sector-level signal (picks weak stocks in weak sectors) | Engine scores stocks in isolation, ignores sector rotation |
| **D** | Static position sizing ignores volatility | 1.5% risk × 8% trail = same sizing for low-vol KO and high-vol TSLA |
| **E** | One-shot daily entries (no intraday gap capture) | Engine runs 4×/day but only scans EOD bars; misses overnight catalysts |
| **F** | Linear hedge (SH only) — no asymmetric downside protection | Need ~25-35% SH allocation in BEAR; options give same protection at 1-2% premium |
| **G** | Single-timeframe scoring | All indicators on daily bars; no confirmation across timeframes |
| **H** | Strategy misses Post-Earnings Announcement Drift (PEAD) | Academic anomaly: stocks that beat earnings drift up 5-10 days; we currently SKIP these via earnings gate |

---

## 2. Eight architectural changes — Solution matrix

Each change targets one or more of the root causes above.

| # | Change | Targets | Effort | Expected α uplift |
|---|--------|---------|--------|-----------------:|
| 1 | **Earnings calendar gate** | B | 2-3h | +1-2%/yr |
| 2 | **Sector rotation scoring** | C | 4-6h | +2-3%/yr |
| 3 | **Mean reversion overlay** | A | 8-12h | +3-5%/yr |
| 4 | **Options hedge overlay** | F | 16-20h | +1-2%/yr + DD reduction |
| 5 | **Pre-market gap scanner** | E | 4-6h | +1-2%/yr |
| 6 | **Volatility-aware (ATR) sizing** | D | 3-4h | +0.5-1%/yr |
| 7 | **Multi-timeframe scoring** | G | 8-10h | +1-2%/yr |
| 8 | **Earnings PEAD strategy** | H | 4-6h | +1-2%/yr |
| **Total** | | | **49-67h** | **+10.5-17%/yr nad current** |

That should take the walk-forward OOS α from +1.09%/yr to **+11-18%/yr**.
Still below the +60%/yr goal, but a real, validated step in that
direction. Phases 9+ (alt data, sentiment, options flow, intraday
features) bridge the remaining gap and are planned for after this batch
delivers measured uplift.

---

## 3. Detailed designs

### Phase 1 — Earnings calendar gate

**Module**: `scripts/earnings_calendar.py`
**State**: `state/earnings_calendar.json` (refreshed weekly)
**Integration**: `execute_trades.compute_gate_score()` adds new check

**Logic**:
```
For each watchlist + held symbol:
  next_earnings_date = lookup(symbol)
  if 0 ≤ (next_earnings - today) ≤ 5 days:
    BLOCK new buy / penalty -0.15 on gate score
  if symbol held AND earnings in 2 days:
    LOG warning (don't auto-close; user decides)
```

**Data source**: Perplexity weekly query (`get next earnings dates for
[symbols]`). Cached, refreshed Mondays pre-market. Falls back to
"unknown" if data unavailable (don't block, but don't bonus either).

**Tests**:
- Mock Perplexity → assert correct date parsing
- 5d window — assert block fires
- 6d window — assert no block
- Unknown date — assert no block

**Acceptance**: In dry-run, see "BLOCK: earnings 3d away" for at least 1
watchlist symbol with imminent earnings.

---

### Phase 2 — Sector rotation scoring

**Module**: `scripts/sector_rotation.py`
**State**: `state/sector_strength.json` (refreshed daily)
**Integration**: `research.compute_confidence_score()` adds sector bonus/penalty

**Logic**:
```
SECTOR_ETFS = {Technology: XLK, Financial: XLF, Healthcare: XLV,
               Industrial: XLI, Consumer: XLY, Energy: XLE,
               Materials: XLB, Utilities: XLU, RealEstate: XLRE,
               Communication: XLC}

For each ETF: compute 20d return − SPY 20d return = sector_alpha

Rank sectors by sector_alpha:
  Top 3 sectors → +5 bonus to symbols in those sectors
  Bottom 3 sectors → −5 penalty
  Middle → no adjustment
```

**Integration**: After existing technical/catalyst scoring, before action
mapping.

**Tests**:
- Mock SPY + XLK bars with XLK outperforming → expect +5 bonus
- Mock SPY + XLU bars with XLU underperforming → expect −5 penalty
- Mock unknown sector → expect 0 adjustment

**Acceptance**: Backtest with sector rotation enabled shows different
per-symbol P&L distribution than without (specifically: fewer trades
in worst-3 sectors).

---

### Phase 3 — Mean reversion overlay

**Module**: `scripts/mean_reversion.py`
**Integration**: `execute_trades.run_execution()` calls
`mean_reversion.find_candidates()` in addition to momentum candidates

**Logic**:
```
ONLY active when regime in {NEUTRAL, BEAR}:
  For each symbol:
    if RSI(14) < 30 and
       price < 0.92 × SMA_20 and
       volume_ratio > 1.5 (capitulation):
      candidate.append(symbol, type="MR_BUY")

Sleeve: 25% of equity reserved for MR positions
Position size: 2-3% per MR trade (smaller than momentum)
Holding period: 2-5 days (faster than momentum)
Exit:
  - +5% gain → take profit
  - −3% loss → stop
  - RSI > 55 → exit (no longer oversold)
  - 5 days elapsed → close
```

**Key design decision**: MR positions are tracked separately
(`is_mr=True` flag in Position dataclass). They don't compete with
momentum positions for slots. The sleeve cap is a soft constraint.

**Tests**:
- Mock oversold setup → expect MR candidate
- Mock BULL regime → expect no MR candidates
- Position held 6 days → expect time exit
- RSI bounces above 55 → expect exit

**Acceptance**: NEUTRAL regime P&L improves from −11.97% baseline to
positive or near-zero in backtest replay.

---

### Phase 4 — Options hedge overlay

**Module**: `scripts/options_hedge.py`
**Integration**: Runs alongside `manage_bear_hedge` (SH stays as the
primary hedge; options are tail-risk insurance)

**Logic**:
```
BEAR regime AND not HALT:
  target_put_premium = 1.5% of equity
  if not holding SPY put OR DTE < 14:
    Buy SPY put, 30 DTE, 5% OTM
    Sell when:
      - regime → BULL
      - DTE ≤ 14 (roll)
      - underlying recovers 10% from put-buy date

HALT tier (catastrophic):
  target_put_premium = 3.0% of equity
  Buy SPY put, 45 DTE, ATM
```

**Risk caps**:
- Total premium at risk ≤ 5% of equity at any time
- Skip if IV percentile > 90 (too expensive)
- Skip if SPY ≤ −15% YTD (hedge usefulness diminished)

**Alpaca paper supports options**: `/v2/options/contracts` and
`/v2/orders` with option contract symbol. We use mid-quote for fill
simulation.

**Tests**:
- Mock BEAR regime + no put → expect buy order
- Mock BULL regime + put held → expect sell order
- Mock put with DTE=10 → expect roll
- Mock high IV → expect skip

**Acceptance**: Backtest BEAR period shows reduced max DD with options
hedge enabled vs SH-only hedge.

---

### Phase 5 — Pre-market gap scanner

**Module**: `scripts/gap_scanner.py`
**Schedule**: Runs at 9:30 AM ET (5 min after open) in a new workflow
**Integration**: Feeds candidates into `execute_trades.run_execution()`

**Logic**:
```
At market open + 5 min:
  For each watchlist + screener symbol:
    overnight_gap = (today_open - yesterday_close) / yesterday_close
    if overnight_gap > +3% and news catalyst exists:
      → potential gap-up momentum trade
      Add to candidates with bonus +5 score (capture gap momentum)
    if overnight_gap < -3% and oversold + bounce signs:
      → potential gap-down reversal (mean reversion)
      Add to candidates with bonus +3 score (MR sleeve)
```

**Filters**:
- Volume in first 5 min > 1.5× pre-market average
- Liquidity check: bid-ask spread < 1%
- No earnings today (would already be filtered by earnings gate)

**Tests**:
- Mock gap-up 5% with news → expect +5 bonus candidate
- Mock gap-up 5% without news → expect filtered out (FOMO trap)
- Mock gap-down 4% oversold → expect MR candidate
- Mock spread > 1% → expect filtered out

**Acceptance**: At least 1 gap candidate detected per typical earnings
week in backtest replay.

---

### Phase 6 — Volatility-aware (ATR) sizing

**Module**: Update `scripts/trade.calculate_position_size()`
**Strategy_config**: Add `atr_risk_multiplier` parameter per regime

**Logic** (3-way min):
```
shares = min(
  alloc_shares,      # equity × max_position_pct / price
  risk_shares,       # equity × risk_pct / (price × trail_pct)
  atr_shares,        # equity × atr_risk_pct / ATR_14
)
```

**ATR-based** uses raw 14-day Average True Range:
- High-vol stock (TSLA, ATR=$15): smaller position
- Low-vol stock (KO, ATR=$0.50): larger position
- Result: equal dollar risk per position regardless of stock volatility

**Default `atr_risk_pct`** = 0.8% (slightly below `risk_per_trade_pct`)

**Tests**:
- Mock low-vol stock → ATR allows bigger size than risk method
- Mock high-vol stock → ATR is the binding constraint
- Verify never exceeds alloc cap

**Acceptance**: Position sizes more uniform in dollar P&L variance across
positions in backtest (lower std-dev of per-trade P&L).

---

### Phase 7 — Multi-timeframe scoring

**Module**: Update `scripts/research.compute_technicals()` and
`compute_confidence_score()`
**Data**: Add 4-hour bars to BarProvider (Alpaca free tier provides)

**Logic**:
```
For each symbol:
  technicals_daily = compute_on_bars(daily_bars)
  technicals_4h = compute_on_bars(4h_bars, last 200 bars = ~33d)

  agreement_bonus = 0
  if RSI_daily in sweet_spot AND RSI_4h in sweet_spot: +3
  if MACD_daily bullish AND MACD_4h bullish: +3
  if price > 20-SMA both daily AND 4h: +2

  Total bonus added to technical_score (max +8)

  Disagreement penalty:
  if RSI_daily > 70 AND RSI_4h < 40: −5 (overbought daily, weak intraday)
```

**Caching**: 4h bars stored separately, refreshed each routine.

**Tests**:
- Mock aligned daily + 4h → expect +8 bonus
- Mock divergent signals → expect −5 penalty
- Mock missing 4h data → expect no adjustment (graceful degrade)

**Acceptance**: Backtest with MTF scoring shows lower whipsaw (fewer
trades held < 3 days).

---

### Phase 8 — Earnings PEAD strategy

**Module**: `scripts/pead_strategy.py`
**Integration**: New candidate source alongside momentum + MR

**Logic** (opposite of earnings gate):
```
If symbol had earnings 1-2 days ago AND:
  - reported beat (EPS surprise > +5%)
  - opened next session with gap-up > +3%
  - volume > 2× average
  → BUY (PEAD candidate)

Hold 5-10 trading days
Exit:
  - +8% gain (PEAD target)
  - −3% stop
  - 10 days elapsed
```

**Data source**: Perplexity post-earnings beat detection (already in our
toolchain). Cross-reference with earnings calendar (Phase 1).

**Sleeve**: 10-15% of equity reserved for PEAD trades.

**Tests**:
- Mock beat + gap-up + volume → expect PEAD candidate
- Mock beat without gap → expect no candidate (drift didn't start)
- Mock miss → expect no candidate
- Time stop test: 11 days elapsed → expect close

**Acceptance**: Backtest replay shows positive P&L on PEAD trades
identified separately from main momentum.

---

## 4. Implementation order and dependencies

```
Phase 1 (earnings gate)
   └── Phase 8 (PEAD) — depends on Phase 1 (uses same calendar data)

Phase 2 (sector rotation)
   └── Independent

Phase 3 (mean reversion)
   └── Depends on Phase 2 (avoid weak sectors for MR too)

Phase 4 (options hedge)
   └── Independent of all above
   └── Should run AFTER Phase 1 (don't buy puts ATM through earnings)

Phase 5 (gap scanner)
   └── Depends on Phase 1 (skip earnings days)

Phase 6 (ATR sizing)
   └── Independent

Phase 7 (multi-timeframe)
   └── Independent
```

**Build order** (respects dependencies, optimizes for early validation):

```
Week 1:  Phase 1 (earnings)         + Phase 6 (ATR sizing)
Week 2:  Phase 2 (sector)
Week 3:  Phase 3 (mean reversion)
Week 4:  Phase 8 (PEAD)             + Phase 5 (gap scanner)
Week 5+: Phase 7 (multi-timeframe)  + Phase 4 (options)
```

---

## 5. Testing strategy

### Levels
1. **Unit tests** — pure functions (scoring math, calendar parsing,
   ATR calculation). Run on every commit. `tests/test_*.py`.
2. **Integration tests** — full module-to-module call paths
   (gate_score with all new checks active). Mock external APIs.
3. **End-to-end tests** — full backtest with feature enabled vs
   disabled. Compare metrics. `tests/e2e/`.
4. **Live regression** — first 1-2 weeks of live trading with new
   feature flagged ON, compare with prior period.

### What "passes" means
- All unit + integration tests green
- E2E backtest shows expected directional change in metrics (the
  acceptance criteria in each phase)
- No regression in walk-forward OOS alpha
- Live regression doesn't show unexpected behavior over first 5
  trading days

### Test framework
- `pytest` + `pytest-mock` for unit/integration
- Custom E2E harness that runs `scripts/backtest/run.py single`
  with feature on/off and compares JSON metrics
- All tests deterministic (seeded RNG where applicable)

---

## 6. Risk mitigations

| Risk | Mitigation |
|------|-----------|
| New feature breaks live trading | Feature flag in `strategy_config.py`; can disable instantly |
| Backtest improvement doesn't translate live | Live regression in first 2 weeks before scaling position size |
| API rate limits (Perplexity, Alpaca) | Cache aggressively; weekly refresh for earnings calendar; daily for sector strength |
| Cost overrun (Perplexity per call) | Batch queries (one call per week per symbol group, not per day) |
| Walk-forward says feature hurts | Skip phase, document negative result, move to next |
| Build time blowup | All new code under feature flags; can toggle in workflow_dispatch input |

---

## 7. Validation gates between phases

After each phase, BEFORE moving to next:

1. Run full unit + integration test suite — must be green
2. Run E2E backtest with feature on/off
3. Verify acceptance criteria from phase design
4. Check walk-forward OOS alpha — must not regress > 1pp
5. Commit + push to main
6. Tag commit with phase marker (e.g. `v3.1-earnings-gate`)

If a phase fails (3) or (4), it does NOT get merged. We document the
failure, possibly skip, move on.

---

## 8. Out-of-scope (future)

Things explicitly NOT in this plan, to be considered after Phase 8 ships
and walks forward shows uplift:

- Alternative data (Twitter/Reddit sentiment, dark pool data, options
  flow)
- Sub-daily granularity (1-min bars, intraday momentum)
- Pairs trading / market-neutral strategies
- Statistical arbitrage between similar stocks
- Order book imbalance signals
- ML model for signal aggregation (XGBoost over indicators)
- Multi-account / multi-strategy allocation
- Live paper-to-live capital ramp protocol

---

## 9. Status tracking

| Phase | Status | Notes | Tests |
|-------|--------|-------|------:|
| 1. Earnings gate | **MERGED** | Perplexity batched fetch, weekly cache, gate veto −0.20 | 20 |
| 2. Sector rotation | **MERGED** | XLK/XLF/.../XLC vs SPY 20d, ±5 per regime | 13 |
| 3. Mean reversion | **MERGED** (core) | Pure logic + sizing complete; live execute_trades hook pending | 27 |
| 4. Options hedge | **SCAFFOLDED** | `decide_action()` pure; Alpaca options wiring deferred | 8 |
| 5. Gap scanner | **SCAFFOLDED** | `classify_gap()` pure; 9:35 ET workflow job deferred | 6 |
| 6. ATR sizing | **MERGED** | Already in `trade.calculate_position_size` as 3rd constraint | 9 |
| 7. Multi-timeframe | **SCAFFOLDED** | `compute_mtf_adjustment()` pure; 4h BarProvider deferred | 4 |
| 8. PEAD | **SCAFFOLDED** | `is_pead_setup()` / `should_exit_pead()` pure; post-earnings query deferred | 9 |

Total tests: **98** (all passing). Pure-math cores for all phases done.
Remaining live wiring (Phase 3 execute_trades hook + Phases 4/5/7/8 I/O)
is tracked in follow-up commits to keep each integration validated
independently.

This table is updated after each phase merges to main.
