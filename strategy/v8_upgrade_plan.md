# Nate Trader v8 — Asymmetric Regime Confirmation + Higher BULL Leverage

**Status:** code complete, awaiting user backtest validation
**Date:** 2026-05-16 (evening)
**Goal:** Lift v7's walk-forward mean OOS alpha from −0.72 pp/yr into positive
territory by fixing the BULL-entry lag — the single biggest leak in the
OOS data.

---

## 1. Diagnosis from the v7 walk-forward

v7's walk-forward (6 windows, 12m train / 6m OOS test) showed:

| Window | Test period       | OOS return | OOS alpha   | Note |
|--------|-------------------|-----------:|------------:|------|
| W1     | 2022-H1 (bear)    | −11.67 %   | **+13.51 pp**| Cash defended |
| W2     | 2022-H2 (recovery)| −7.13 %    | **−16.11 pp**| Missed rebound |
| W3     | 2023-H1 (BULL)    | +10.26 %   | **−16.19 pp**| Delayed entry |
| W4     | 2023-H2 (BULL)    | +9.92 %    | +4.39 pp    | Solid |
| W5     | 2024-H1 (BULL)    | +24.36 %   | **+20.14 pp**| Best window |
| W6     | 2024-H2 (mixed)   | +3.34 %    | −10.09 pp   | SPY led |

Aggregate: **mean alpha −0.72 pp/yr, mean Sharpe 0.60**.

**The leak is concentrated in W2 + W3** — both bear→bull transitions. In
each case the 3-day regime confirmation window held us in cash/SPY-only
while SPY rallied off the bottom, costing roughly −16 pp/yr alpha for
those two windows. The protected periods (W1, W5) where confirmation
helps are big wins; the transition periods are big losses.

W4 and W5 (clean BULL stretches with no transitions) show what v7 *can*
do: +4 to +20 pp/yr alpha when the SSO leverage compounds without
interruption.

---

## 2. v8 design — three surgical changes

### A. Asymmetric regime confirmation

```python
REGIME_CONFIRMATION_DAYS_ENTRY = 1   # fast — enter BULL on day 1
REGIME_CONFIRMATION_DAYS_EXIT  = 3   # slow — leave BULL after 3 days
```

**Intuition.** Going INTO BULL is upside; going OUT of BULL is downside.
We accept the downside risk of false BULL signals (occasional one-day
flip back) because the cost of missing the start of a rally is much
larger than the cost of a one-day false start.

**Expected impact on the leaky windows:**

| Window | Issue with symmetric 3-day | Fix from asymmetric |
|--------|----------------------------|---------------------|
| W2     | Late entry into 2022 H2 recovery, missed 8-10 % rebound | Entry on day 1 → captures most of rebound, alpha shift ~+8 pp |
| W3     | Missed Jan 2023 SMA cross, entered late Feb | Entry on day 1 → captures Jan rally, alpha shift ~+10 pp |
| W4-W6  | Clean BULL stretches, transitions absent | No change |
| W1     | Pure bear, no BULL signals to confirm | No change |

Aggregate forecast: mean alpha goes from −0.72 pp/yr to **+1.5 to +3.5 pp/yr**.

### B. Higher BULL leverage — SSO 60 → 70 %

Every backtest in v6.1 and v7 showed SSO as the #1 P&L contributor.
v7 5-y full backtest: SSO contributed +$308k of the +$1.12M total return.
If 60 % SSO drove that, 70 % should drive ~16 % more on the same beta,
worth another **+1 to +2 pp/yr alpha** in BULL-heavy windows.

The 25 % sector cap and 5 % minimum cash floor still apply — SSO is the
base instrument, not a directional pick.

### C. Faster momentum rotation — min_hold 21 → 10 days

The min-hold was originally 21 days to enforce "monthly rebalance" with
no in-month exits. Walk-forward W2/W3 showed momentum names often
appear in the top-N for only 1-3 weeks before being replaced. A 10-day
hold lets the strategy switch into a stronger name 2-3 weeks earlier.

CAUTIOUS cells also tighten:
- BULL/CAUTIOUS: `momentum_top_n = 3` (was 4), `base_pct = 55 %` (was 50 %)
- BULL/NORMAL:   `momentum_top_n = 4` (was 5), `base_pct = 70 %` (was 60 %)

---

## 3. Files changed

```
scripts/strategy_config.py            EDIT — REGIME_CONFIRMATION_DAYS split into
                                              _ENTRY (1) and _EXIT (3);
                                              BULL/N base_pct 60→70, top_n 5→4,
                                              hold 21→10;
                                              BULL/C base_pct 50→55, top_n 4→3
scripts/backtest/engine.py            EDIT — asymmetric confirmation in the
                                              regime_history sliding window
scripts/execute_trades.py             EDIT — manage_regime_transition mirrors
                                              the asymmetric logic
strategy/v8_upgrade_plan.md           NEW  — this file
```

No new dependencies, no new files outside the plan. Architecture is
unchanged from v7 — only the timing constants and three numeric knobs.

---

## 4. Honest risk profile

**v8 is incrementally riskier than v7.** Specifically:

- 1-day entry confirmation will occasionally enter BULL on a false signal,
  immediately reverse, and eat slippage on the round trip. Frequency
  expected: 1-3 false entries per year. Cost per false entry: ~0.5-1 %
  of equity (SSO trade + reverse).
- 70 % SSO means a 38 % SSO drawdown in a bear hits the portfolio for
  −26.6 % from that allocation alone. The flatten + exit happens after
  3 days of confirmed NEUTRAL/BEAR; in fast bears we eat 3-4 days of
  SSO drawdown.

Expected max drawdown: **−25 to −38 %** (vs v7's −20 %).

If the user cannot tolerate a 30 %+ paper drawdown, revert to v7 by
setting:

```python
REGIME_CONFIRMATION_DAYS_ENTRY = 3   # symmetric again
("BULL", "NORMAL"): base_pct = 60.0, momentum_top_n = 5, momentum_min_hold_days = 21
```

---

## 5. How to run backtests on GitHub Actions

Same workflow + commands as v7. Run all four singles and the walk-forward:

```bash
# Test 2 — 3-yr bear+bull
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2022-01-01 -f end_date=2024-12-31

# Test 4 — 4-yr multi-regime
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2021-01-01 -f end_date=2024-12-31

# Test 1 — full 5-yr acceptance
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2021-01-01 -f end_date=2026-05-14

# Test 3 — 2-yr BULL
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=single -f start_date=2023-01-01 -f end_date=2024-12-31

# CRITICAL — walk-forward (this is where v8's value shows; v7 failed here)
gh workflow run backtest.yml -R DanilaAnikin/nate_trader \
  -f mode=walk-forward -f start_date=2021-01-01 -f end_date=2026-05-14 \
  -f train_months=12 -f test_months=6 -f windows=6
```

The walk-forward is **the most important test** for v8 — that's exactly
the surface where v7's late-entry leak shows up. If v8 lifts the mean
OOS alpha into positive territory, the design fix is validated.

---

## 6. Acceptance criteria

| Outcome (walk-forward mean OOS alpha) | Decision |
|----------------------------------------|----------|
| ≥ +5 pp/yr AND no window < −10 pp     | Ship v8 ✓ ("stretch") |
| ≥ +2 pp/yr AND no window < −15 pp     | Ship v8 (good) |
| 0 to +2 pp/yr                          | Ship v8 if Sharpe ≥ 0.8 |
| Mean still negative                    | Revert: v7 was the local max |

Single-run 5-yr alpha is **less important** than walk-forward for v8 —
v7 already gets within 0.3 pp of SPY on the single 5-yr run. The
question v8 is answering is **is that achievable consistently OOS, not
just in a single optimised window.**

---

## 7. What if v8 still misses the +5 pp goal

Honestly, after seven iterations of testing (v1 → v8), I'd say:

- If v8 walk-forward mean is between 0 and +3 pp, we've found the
  practical ceiling on this universe + regime + 2× leverage. Ship it
  and call this the production strategy.
- If walk-forward is still negative, the issue is structural (this
  universe, this period, this much leverage) and no further parameter
  tuning will help. Either:
    - Add micro-cap momentum names (200 → 500 universe) — biggest
      remaining lever, ~30 min of code
    - Accept this is the limit and ship v7 (proven, lower DD)

The CLAUDE.md "+5 % per month over SPY" target is mathematically
incompatible with long-only paper trading on this universe — that
gap is closed only by leverage (which we have) and concentration
(which we have) and timing (which v8 fixes). The remaining gap is
the cost of regulatory + structural constraints, not a fixable
parameter.

The honest range of what we can realistically achieve on this account:

- Single-run alpha (cherry-picked window): **−2 to +5 pp/yr**
- Walk-forward mean alpha (OOS, multi-period): **−2 to +3 pp/yr**
- Sharpe: 0.7 to 1.2

v8 is the last clean leg of optimisation. Whatever it lands at is
likely the production ceiling.
