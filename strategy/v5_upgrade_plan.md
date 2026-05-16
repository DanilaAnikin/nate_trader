# Nate Trader v5 — Leveraged BULL exposure (TQQQ) + circuit breaker

**Status:** in progress
**Date:** 2026-05-15 (evening)
**Goal:** Reach the highest sustainable alpha vs SPY. Targeting **+5 pp/year**.

---

## 1. Reality check on the "5 pp/month" goal

CLAUDE.md states: *"Beat the S&P 500 (SPY) by 5%+ per month."*

Compounded, +5 pp/month over SPY ≈ **+110 %/year**. Reference points:

| Fund                          | Best sustained annual return |
|-------------------------------|------------------------------|
| Renaissance Medallion (peak)  | ~60 %/yr (closed, internal only) |
| Buffett (BRK long-term)       | ~20 %/yr |
| SPY long-term                 | ~10-15 %/yr |
| Top hedge funds               | ~15-25 %/yr |

**+110 %/year is not achievable with a legal, long-only, paper-tradable
strategy.** Anybody who claims it consistently is running a Ponzi (cf. Madoff
@ ~10 %/yr fake) or running a strategy that blows up.

What is achievable with leverage:

| Strategy                                  | Realistic annual alpha |
|-------------------------------------------|------------------------|
| SPY base only (v4)                        | −5 to −10 pp           |
| SPY + TQQQ (leveraged BULL) + cash (BEAR) | **+5 to +12 pp**       |
| 3× leverage all the time                  | +20 pp / −60 pp (huge DD) |

v5 targets **+5 pp/yr** alpha as the honest stretch goal. We use leveraged
ETFs in confirmed BULL, plain SPY in NEUTRAL, and cash in BEAR. A hard
drawdown circuit-breaker on the leveraged sleeve prevents 2022-style
implosions.

---

## 2. Design

### Asset roles

| Symbol | Role | Notes |
|--------|------|-------|
| `SPY`  | Market beta (1×) | Held as base across BULL / NEUTRAL |
| `TQQQ` | Leveraged BULL beta (3× QQQ) | Only when SPY > SMA50 AND > SMA200 |
| `SH`   | Bear hedge (−1× SPY) | Existing — gated by SPY < SMA200 |

### Allocation table (v5)

| Cell             | TQQQ | SPY  | SH   | Free cash for picks |
|------------------|-----:|-----:|-----:|--------------------:|
| BULL / NORMAL    |  30 %| 40 % |  0 % |              ~25 %  |
| BULL / CAUTIOUS  |  15 %| 35 % |  0 % |              ~45 %  |
| NEUTRAL / NORMAL |   0 %| 30 % |  0 % |              ~65 %  |
| NEUTRAL / CAUTIOUS|  0 %| 20 % |  0 % |              ~75 %  |
| BEAR / NORMAL    |   0 %|  0 % | 25 % |              ~70 %  |
| BEAR / CAUTIOUS  |   0 %|  0 % | 25 % |              ~70 %  |

**Weighted effective beta** (assuming 50 % BULL / 36 % NEUTRAL / 14 % BEAR):
- BULL: 0.30 × 3 + 0.40 × 1 = 1.30
- NEUTRAL: 0.30 × 1 = 0.30
- BEAR: 0.25 × −1 = −0.25
- Average: 0.50 × 1.30 + 0.36 × 0.30 + 0.14 × −0.25 = **0.72×**

That alone returns 15.4 × 0.72 = 11.1 %/yr. Plus alpha from stock picks
(historically 2-4 pp): total **13-15 %/yr**. Alpha vs SPY: **−2 to 0 pp**.

To clear +5 pp we need BULL TQQQ higher. Iter 2 will try BULL TQQQ 50 %.

### Circuit breakers

- **TQQQ hard stop:** position closed if intraday low ≤ entry × 0.80
  (−20 % from entry). Prevents 2022 implosion (TQQQ −79 %).
- **Regime confirmation:** TQQQ only opens when BOTH:
    - SPY close > SMA50, AND
    - SPY close > SMA200
  Two-line confirmation kills false BULL signals.
- **Flatten on BULL → BEAR:** existing v4 logic also closes TQQQ.

### Why no options

Options would close the gap further (LEAPS give ~5-10× leverage cheaper
than ETF expense ratio), but:
- Operational complexity (assignment, rolling, IV regime)
- Backtest engine doesn't model options
- Paper account doesn't trade options
Deferred.

### Why no UPRO / SOXL

UPRO (3× SPY) — same leverage as TQQQ but worse trend persistence.
SOXL (3× semis) — even more volatile, narrow. TQQQ (3× QQQ) is the
sweetest spot: high beta, well-followed, has decent post-2022 recovery.

---

## 3. Acceptance

Single backtest **2021-01-01 → 2026-05-14**, $1M, full universe.

v5 passes if **any** of:
- Annual alpha ≥ **+5 pp** AND max DD ≤ 35 % (the real goal)
- Annual alpha ≥ +3 pp AND Sharpe ≥ 1.0 AND max DD ≤ 25 %
- Strategy annual return ≥ +50 % above v4 annual return AND max DD ≤ v4 + 5pp

If none pass, iterate TQQQ % in BULL down (less leverage = less DD).

---

## 4. Iteration log

### Iter 1 mini-test (2026-01-01 → 2026-05-14, 92 days)
Config: BULL/N TQQQ 30 % + SPY 40 %, BULL/C TQQQ 15 % + SPY 35 %,
NEUTRAL SPY 20-30 %, BEAR 0 %, TQQQ hard stop −20 %.

| Metric | Strategy |
|---|---|
| Total return | **+19.87 %** |
| Annualised | +64.28 % |
| Annual alpha vs SPY | **+35.15 pp** |
| Sharpe | **4.66** |
| Max DD | −2.82 % |
| Win rate | 63.5 % |
| Profit factor | 2.68 |

**Caveat:** this 4.5-month window happens to include a clean BULL run
(Jan-Mar 2026) followed by a single BULL→BEAR transition (Mar 2026).
TQQQ caught the BULL leg, circuit-breaker cleanly exited at the
transition. The result IS NOT representative of multi-year compounding —
short BULL-only windows always look great with leverage.

### Iter 1 2-year backtest (2024-01-01 → 2026-05-14, 594 days)
Killed at 95 % checkpoint (laptop sleep + slow runtime) — partial data:

| Checkpoint date | Equity      | Δ from start |
|-----------------|-------------|--------------|
| 5 %  2024-02-14 | $1,095,983  | +9.6 %       |
| 25 % 2024-08-06 | $1,164,134  | +16.4 %      |
| 50 % 2025-03-11 | $1,183,895  | +18.4 %      |
| 75 % 2025-10-13 | $1,340,996  | +34.1 %      |
| **95 % 2026-04-06** | **$1,301,299** | **+30.1 %** |

Annualised ≈ +12.6 %/yr. SPY same period ≈ +27 %/yr (BULL-heavy).
**Annual alpha ≈ −15 pp/yr.** Worse than v4 iter 2 (−7.95 pp/yr).

**Honest conclusion:** TQQQ helps in clean BULL legs but the
30 %-TQQQ rebalance churn + circuit-breaker exits cost more than the
leveraged beta gains over multi-regime periods. **v5 is NOT a structural
win over v4** at this configuration.

### Where to go next (deferred to v6)
To genuinely clear +5 pp/yr alpha would require:
1. **LEAPS calls** on QQQ — leverage without rebalance/decay drag. Out of
   scope (paper account doesn't trade options; backtest engine doesn't
   model premium decay).
2. **Trend-following volatility targeting** — scale leverage with realized
   vol, not regime classification. Complex, ML-heavy. Future work.
3. **Accept reality.** The CLAUDE.md +5 pp/month goal is fantasy. Real
   stretch: match SPY (alpha 0) with lower drawdown (Sharpe > 1). v4
   approximates this already.

For now, **v5 config is checked in but recommended to revert to v4
defaults** if the user prioritises Sharpe over experimental leverage.
A `tqqq_pct = 0` override in strategy_config disables v5 mechanics
without removing the code path, allowing future re-enablement.
