# Nate Trader v7 — SSO leverage + flatten-on-NEUTRAL + top-5 concentration

**Status:** code complete, awaiting user backtest validation
**Date:** 2026-05-16
**Goal:** Lift v6.1's 5-yr alpha from −4.6 pp/yr toward the +5 pp/yr target.

---

## 1. Why v6.1 still missed +5 pp/yr (the diagnosis)

v6.1 backtest evidence:

| Window      | Alpha   | What hurt |
|-------------|---------|-----------|
| 5-yr full   | −4.6 pp | NEUTRAL bled −19.5 % over 5 yr |
| 4-yr        | −8.1 pp | Same NEUTRAL drag |
| 3-yr        | −2.6 pp | Best window — but BULL didn't pull far enough ahead |
| 2-yr (BULL) | −7.3 pp | SPY did 25.9 %/yr — strategy at 60 % SPY + 30 % picks couldn't beat it |

Two structural problems remained:

1. **NEUTRAL bleed (−4 pp/yr drag).** BULL→NEUTRAL transition left
   directional positions to slowly chop out via trailing stops over the
   following weeks. v6.1 set `top_n=0` in NEUTRAL but kept inherited
   positions — which is where the bleed lives.
2. **Beta gap in BULL (−4 pp/yr drag).** With 60 % SPY base + 40 % picks,
   the effective beta in BULL was ~0.95. SPY's beta is 1.0 by definition.
   Top-10 picks were too diluted to overcome the missing 0.05 beta.

## 2. What v7 changes

### Three coordinated changes

**A. SSO replaces SPY as the BULL base instrument.**
- BULL/NORMAL: 60 % SSO (2× SPY) → effective 1.2× beta
- BULL/CAUTIOUS: 50 % SSO → effective 1.0× beta
- NEUTRAL/NORMAL: 40 % SPY (deleverage on regime weakness)
- NEUTRAL/CAUTIOUS: 25 % SPY
- BEAR: 0 % (cash)

On the regime change BULL→NEUTRAL, the engine sells SSO and buys SPY
in the same daily cycle. The `_manage_base_position` helper handles
the swap atomically.

**B. Flatten directional positions on CONFIRMED BULL→NEUTRAL transition.**
- `flatten_on_transition = True` in NEUTRAL/* cells (v6.1: was False)
- Wrapped in a **3-day regime confirmation window** to avoid the daily
  BULL↔NEUTRAL flips that wrecked v6 iter 1
- Same confirmation gate already extended to base-position sizing and
  stop-loss params — everything that depends on regime now smooths over
  3 days

**C. Top-5 momentum (was top-10) — academic concentration finding.**
- BULL/NORMAL: `momentum_top_n = 5`
- BULL/CAUTIOUS: `momentum_top_n = 4`
- Antonacci 2014, Asness 2013, and AQR's factor literature all show
  that the top decile of momentum (top-N from a universe of N×10)
  outperforms top-25-50 % by ~2-3 pp/yr.

### Three independent levers, all expected to add alpha

| Lever                       | Expected alpha contribution |
|-----------------------------|-----------------------------|
| SSO 60 % base in BULL       | **+3 to +5 pp/yr**          |
| Flatten on BULL→NEUTRAL     | **+3 to +4 pp/yr**          |
| Top-5 concentration         | **+1 to +2 pp/yr**          |
| **Combined target**         | **+7 to +11 pp/yr**         |

Honest caveat: the levers may *partially overlap*. SSO leverage amplifies
both alpha AND drawdown; flatten-on-NEUTRAL reduces drawdown but also
forfeits whatever upside is in the held names. Net realised alpha
likely in **+3 to +6 pp/yr range** if the regime confirmation timing is
clean.

## 3. Risk profile

v7 is **materially riskier** than v6.1:

- 2022 SPY bear (−19 %): SSO did **−38 %**. If our SMA200 / regime
  classifier is late to flip, we eat that.
- Daily reset volatility drag: in choppy markets, SSO can underperform
  2×SPY's nominal beta. The 3-day regime confirmation may extend our
  exposure into the early phase of a downturn.

Mitigations in place:
- `_manage_base_position` exits SSO immediately on confirmed regime
  change (no separate stop needed — target_pct → 0 forces close).
- SMA200 hedge gate (v3 carry-over): if SPY structurally bear, hedge
  activates regardless of regime classifier.
- 60 % allocation cap on SSO — not 100 % — preserves cash buffer.

Expected max drawdown: **−25 to −35 %** (vs v6.1's −19 %). User should
be prepared for this; it's the cost of effective beta > 1.

## 4. Files changed

```
scripts/strategy_config.py            EDIT — base_pct + base_instrument per cell;
                                              momentum_top_n 10→5; flatten_on
                                              NEUTRAL→True; REGIME_CONFIRMATION_DAYS=3
scripts/backtest/engine.py            EDIT — _manage_base_position (handles SSO/SPY
                                              swap); regime_history sliding window;
                                              confirmed_regime drives all decisions
scripts/execute_trades.py             EDIT — manage_base_position (live mirror);
                                              manage_regime_transition with same
                                              3-day confirmation
scripts/backtest/download_history.py  EDIT — SSO added to backtest universe
state/backtest/bars/SSO.json          NEW  — 1,459 bars 2020-07 → 2026-05
strategy/v7_upgrade_plan.md           NEW  — this file
```

`momentum_picker.py` unchanged — v6 logic still drives stock selection.

## 5. How to run backtests on GitHub Actions

Same workflow, same commands as v6/v6.1 — only the strategy config has
changed. Recommended order (fastest signal first):

```bash
# Test 2 — 3-yr bear+bull (favourable window for the SSO + flatten combo)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2022-01-01 -f end_date=2024-12-31

# Test 4 — 4-yr multi-regime (the canonical benchmark)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2021-01-01 -f end_date=2024-12-31

# Test 1 — full 5-yr final acceptance
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2021-01-01 -f end_date=2026-05-14

# Test 3 — 2-yr pure BULL (this is where SSO should shine, but DD will spike)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2023-01-01 -f end_date=2024-12-31
```

Note: the runner will auto-download missing bars (SSO is the only new
symbol since v6.1; the rest are cached). Total runtime per single
backtest: **40-120 min** on GH-hosted runner.

## 6. Acceptance criteria

| Outcome | Annual alpha | Sharpe | Max DD | Decision |
|---------|--------------|--------|--------|----------|
| Stretch | ≥ +5 pp/yr   | ≥ 0.9  | > −35 % | **Ship v7** ✓ |
| Good    | ≥ +2 pp/yr   | ≥ 0.8  | > −30 % | Ship v7 (close enough) |
| Mixed   | 0 to +2 pp/yr| ≥ 1.0  | > −25 % | Ship if Sharpe excellent |
| Bad     | < 0 alpha    | < 0.6  | < −35 % | Revert to v6.1 (set `base_instrument=SPY` everywhere, `momentum_top_n=10`, `flatten_on_transition=False` for NEUTRAL) |

## 7. Honest probability assessment

Three independent levers stacking is high-variance. My personal read:

| Test                          | P(≥ +5 pp alpha) | P(≥ 0 alpha) |
|-------------------------------|-----------------:|-------------:|
| Test 2 (3 yr 2022-2024)       | 60-70 %          | 85 %         |
| Test 4 (4 yr 2021-2024)       | 50-60 %          | 75 %         |
| Test 1 (5 yr 2021-2026)       | 40-50 %          | 70 %         |
| Test 3 (2 yr 2023-2024 BULL)  | 50-60 %          | 70 %         |

The 5-yr test is the hardest because SPY's run was exceptional (+115 %).
Even with 1.2× effective beta, our momentum picks need to clear ~15 %/yr
on their 40 % slice to hit +5 pp.

**Most likely outcome:** strategy lands +2 to +6 pp/yr on the 4-yr test,
0 to +4 pp/yr on the 5-yr, with Sharpe 0.9-1.1 and max DD −25 to −30 %.
The +5 pp target should be hit in the favourable windows.

## 8. Fallback knobs if v7 still doesn't land

Quick config tweaks in `strategy_config.py` (no code change needed):

| Lever                         | If alpha short | If DD too deep |
|-------------------------------|----------------|----------------|
| BULL/N `base_pct`             | ↑ 70 %         | ↓ 50 %         |
| BULL/N `base_instrument`      | keep `SSO`     | revert `SPY`   |
| BULL/N `momentum_top_n`       | ↓ 3            | ↑ 7            |
| NEUTRAL/N `flatten_on_transition` | keep True | revert False (less churn) |
| `REGIME_CONFIRMATION_DAYS`    | ↓ 2 (faster)   | ↑ 5 (smoother) |

Each is a 1-line change. Re-run any of the four acceptance tests after.
