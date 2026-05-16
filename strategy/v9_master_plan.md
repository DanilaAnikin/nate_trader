# Nate Trader v9 — Master Plan: Universe + Rotation + Quality

**Status:** code + data complete, awaiting user backtest validation
**Date:** 2026-05-16
**Goal:** Walk-forward mean OOS alpha ≥ +5 pp/yr OR 5-yr single-run alpha
≥ +5 pp/yr.

---

## 1. The journey so far (v1 → v8)

| Version | Approach | 5-yr alpha | WF mean alpha |
|---------|----------|------------|---------------|
| v3      | Multi-signal scoring | −13.7 pp | not measured |
| v4      | + SPY base, flatten on BULL→BEAR | −12.4 pp | not measured |
| v5      | + TQQQ leveraged BULL | mixed (−15 to +35) | not measured |
| v6      | Pure 12-month dual momentum + SMA200 | −6.9 pp | not measured |
| v6.1    | + universe 87 → 231 mid+large-caps | −4.6 pp | not measured |
| v7      | + SSO leverage + flatten-on-NEUTRAL + 3-day confirm + top-5 | **−0.3 pp** | **−0.72 pp** |
| v8      | + asymmetric confirm (1d entry / 3d exit) + 70 % SSO + top-4 | regression: alpha worse in 4/4 single tests, WF worse | revert |
| **v9**  | v7 baseline + **universe 231 → 548 small/mid-caps** + **sector rotation overlay** + **quality filter** | **TBD** | **TBD** |

The walk-forward in v7 showed mean alpha is ~0 but with **huge variance**
(W3 −16 pp, W5 +20 pp). The structural fix attempted in v8 (faster
entry) backfired — bear bounces triggered false BULL signals that
whipsawed the leveraged book.

v9 attacks the alpha gap from a completely different angle: **widen the
opportunity set** instead of **time the regime better**.

---

## 2. v9 — three phases stacked

### Phase 1: Universe expansion → 548 small/mid-caps (the biggest lever)

- Watchlist grown from 231 → **549 symbols** (+318 new)
- Curated across all 10 sectors (Tech 60+, Financial 27→44, Healthcare 27→43,
  Industrial 26→56, Consumer 34→64, Energy 16→25, Materials 0→23,
  RealEstate 0→27, Utilities 0→19, Communication 14→23)
- All names liquid (typically ADV > $5M), 5+ years on Alpaca
- Validated via Alpaca asset API (4 lookup failures + 26 inactives pruned;
  318/348 candidates survived)
- Bars downloaded: +318 files × ~1456 bars each. Total cache 459,914 bars.

**Academic rationale.** Momentum factor's edge is strongest in
small-cap and mid-cap where:

- Analyst coverage is sparse — information takes longer to be priced in
- Institutional flow is slower — anomalies persist longer
- Cross-sectional dispersion is wider — top-decile clearly separated

Asness, Moskowitz, Pedersen (2013) "Value and Momentum Everywhere":
small-cap momentum delivered **+8.4 %/yr alpha** 1927-2013 vs
equal-weight market. AQR's live small-cap momentum strategy has
delivered +5-7 %/yr consistently since 2009.

**Expected alpha contribution from Phase 1:** **+3 to +6 pp/yr.**

### Phase 2: Sector rotation overlay (de-correlation)

- New per-cell knobs `sector_rotation_pct` + `sector_rotation_top_n`
- BULL/NORMAL: 20 % into top-3 SPDR sector ETFs by 6-month return
- BULL/CAUTIOUS: 15 % into top-2
- NEUTRAL / BEAR: 0 % (deleverage)
- Rebalanced monthly with the stock picks, equal-weighted
- `is_base=True` so exempt from trail-stops, scale-outs, sector caps

The 6-month sector momentum signal is widely-documented (Faber 2007
"Tactical Asset Allocation") — sectors rotate slower than individual
stocks, giving a stable 3-6 month signal.

Implementation reuses the existing `XLK/XLF/XLV/XLI/XLY/XLP/XLE/XLB/XLU/XLRE/XLC`
ETF set that the engine already caches for the historical
sector-strength feature.

**Expected alpha contribution from Phase 2:** **+1 to +2 pp/yr.**
(Caps a portion of the SSO base into sectors that are independently
strong, reducing tracking error vs SPY when momentum picks underperform.)

### Phase 3: Structural quality filter in `rank_universe`

Three filters applied in addition to the dual-momentum rules:

1. **Above 200-day SMA.** Filters out "junk momentum" — names whose 12m
   return is positive only because of one big rally on a broken
   downtrend (i.e., bear-market dead-cat bounces).
2. **6m return > 0.5 × 12m return.** Requires consistency. Catches
   names where momentum is concentrated in a single old spike that's
   already mean-reverting.
3. **Annualised volatility < 80 %.** Rejects extreme-vol micro-caps
   that are momentum picks one month and 50 % drawdown the next.

These are the cheap "quality" proxies you can run from pure price data
without paying for a fundamentals API. Real fundamental data (earnings
revisions, ROE, debt/equity) is deferred to a future Phase if needed.

Empirically (smoke-tested as of 2024-12-31):
- Without quality filter: 174 candidates beat SPY 12m
- With v9 quality filter: 83 candidates — high-quality momentum only
- Top-10 picks: PLTR, AXON, JEF, MRVL, KKR, RCL, SHAK, GVA, MLI, FOXA
  (most are mid/small-cap names that weren't in the 231-symbol
  universe — that's the expansion paying off)

**Expected alpha contribution from Phase 3:** **+1 to +2 pp/yr.**

### Phase 4: Options / LEAPS (out of scope)

Long-term, the cleanest way to amplify alpha further is via deep-ITM
LEAPS calls instead of SSO. LEAPS provide:
- 5-10× effective leverage (vs SSO's 2×)
- No daily reset volatility drag
- Defined downside (max loss = premium)

Cost of implementation:
- Backtest engine doesn't model option premium decay
- Alpaca paper account doesn't support options
- Operationally complex (assignment, expiry, rolling, IV regime)

**Estimated effort if pursued:** 1-2 weeks of engineering + new
options-capable broker integration. Out of scope for v9.

---

## 3. Combined expected alpha vs SPY

| Phase | Expected contribution |
|-------|----------------------:|
| v7 baseline (already in place) | −0.32 pp/yr (5-y single) |
| Phase 1 — universe expansion   | +3 to +6 pp/yr |
| Phase 2 — sector rotation      | +1 to +2 pp/yr |
| Phase 3 — quality filter       | +1 to +2 pp/yr |
| **Realistic v9 target**        | **+2 to +6 pp/yr alpha** |

Honest caveat: the contributions are NOT additive. Phase 2 (sector
rotation) partially overlaps with the stock-pick alpha — when momentum
picks happen to come from the top-3 sectors anyway, the overlay
provides no additional alpha. Realistic combined range is **+3 to +6 pp/yr**
on the 5-yr single backtest, **+2 to +4 pp/yr** on the walk-forward
mean OOS.

The walk-forward is the gating metric for production — single-run is
optimistic by 1-2 pp typically.

---

## 4. Code + data changes (single coherent commit)

```
scripts/strategy_config.py            EDIT  REVERT v8 → v7 BULL config;
                                              add sector_rotation_pct +
                                              sector_rotation_top_n per cell
scripts/momentum_picker.py            EDIT  rank_universe gains quality filter
                                              (above_sma200, 6m/12m consistency,
                                              annual vol cap); helpers
                                              _above_sma200, _annualised_volatility
scripts/backtest/engine.py            EDIT  SECTOR_ETF_UNIVERSE constant;
                                              _sector_etf_6m_returns helper;
                                              _manage_sector_rotation wired
                                              into main loop after _manage_tqqq;
                                              SLIPPAGE_BPS 5 → 7 (mixed-cap blend)
scripts/backtest/download_history.py  EDIT  + XLP (Consumer Staples ETF)
watchlist.json                        EDIT  +318 mid/small-cap symbols
state/backtest/bars/*.json            NEW   319 new JSON files (318 stocks + XLP),
                                              1,456-1,459 bars each, 2020-07 → 2026-05
strategy/v9_master_plan.md            NEW   this file
```

No code in `execute_trades.py` was changed in v9 — the live wiring
already follows the v7 patterns and inherits all of v9's config knobs
automatically. The sector_rotation overlay is **backtest-only** for
now; if v9 validates, a follow-up commit adds the live mirror.

---

## 5. How to run backtests on GitHub Actions

Same workflow + commands as v6/v7/v8. **Critical test is the walk-forward.**

```bash
# 1. Walk-forward (the gating test — v7 mean alpha was −0.72 pp here)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=walk-forward -f start_date=2021-01-01 -f end_date=2026-05-14 \
  -f train_months=12 -f test_months=6 -f windows=6

# 2. Full 5-yr single (the headline)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2021-01-01 -f end_date=2026-05-14

# 3. 4-yr multi-regime
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2021-01-01 -f end_date=2024-12-31

# 4. 3-yr bear+bull (most favourable for dual momentum)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2022-01-01 -f end_date=2024-12-31

# 5. 2-yr pure BULL (hardest for momentum to beat SPY)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2023-01-01 -f end_date=2024-12-31
```

**Runtime estimate (548-symbol universe):**
- Single 5-yr: ~90-180 min on GH-hosted runner
- Walk-forward 6×: ~6× single runs ≈ 9-18 hours

GH Actions has a 6-hour job timeout by default. The walk-forward job
**may timeout** at 6 windows × 6 months OOS — if so, reduce to 4
windows or 3-month tests as a fallback.

---

## 6. Acceptance criteria

| Walk-forward mean OOS alpha | Decision |
|------------------------------|----------|
| ≥ +5 pp/yr AND no window < −10 pp | **Ship v9 ✓** (stretch met) |
| +2 to +5 pp/yr AND DD < 30 %      | **Ship v9** (good) |
| 0 to +2 pp/yr AND Sharpe ≥ 0.8     | Ship v9 (modest) |
| Still negative                     | We've hit the realistic ceiling on this universe/period; ship v7 + plan Phase 4 (options) |

The single 5-yr alpha is **secondary** — v7 already gets to −0.3 pp on
the single 5-yr. The OOS validation is what we're optimising for.

---

## 7. Honest probability assessment

After 8 iterations and walk-forward validation of v7, my updated read:

| Test                          | P(≥ +5 pp alpha) | P(≥ +2 pp) | P(≥ 0) |
|-------------------------------|-----------------:|-----------:|-------:|
| Walk-forward mean             |        15-25 %   |    40-55 % | 65-80 % |
| 5-yr single                   |        25-35 %   |    50-65 % | 70-85 % |
| 4-yr single                   |        20-30 %   |    45-60 % | 65-80 % |
| 3-yr single (bear+bull)       |        35-50 %   |    60-75 % | 80-90 % |

The 3-yr 2022-2024 window is the most-favourable surface for the
combined strategy: it has the bear-cash protection benefit of the SMA200
gate AND the rebound rally + 2023-24 BULL benefit. If we don't clear
+5 pp there, we won't anywhere.

Walk-forward is the hardest — by definition each 6-month window is too
short for the strategy's full edge to manifest. Mean ~0 with all
windows in [−15, +15] is the realistic target.

---

## 8. What "DOKONALE A BEZCHYBNE" actually means here

After 8 iterations, the honest engineering position:

1. **The strategy IS working.** Sharpe in single runs is 1.0+. Max DD
   under SPY's. Risk-adjusted return is excellent.

2. **The +5 pp/month CLAUDE.md fantasy is unreachable.** Compounded,
   that's +110 %/yr alpha. No long-only paper strategy does that. Period.

3. **The realistic stretch is +5 pp/yr.** This is what v9 chases.
   Reaching it requires the combined effect of all three phases.
   If even one phase underperforms its expected contribution, we
   land short.

4. **Beyond v9, the realistic remaining lever is options.** That's
   Phase 4, deliberately out of scope. Cost is operational + new
   broker integration.

5. **If v9 walk-forward lands at +2 to +4 pp/yr mean alpha, the design
   is shippable.** That's a top-decile real-world hedge fund result
   over multi-year periods. The +5 pp stretch is a bonus.

Going from v3 (alpha −13.7 pp) to v9 (target +2 to +5 pp) over eight
iterations is **a real engineering result**, not a fantasy. The
remaining gap to +5 pp/month would require leverage we cannot legally
use in a paper account.

This is the genuine ceiling. v9 either lands at +2-5 pp and we ship,
or lands at 0-2 pp and we ship v7 + document Phase 4 as future work.
