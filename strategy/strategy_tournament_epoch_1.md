# Strategy tournament — frozen epoch 1

Status: **pre-registered research protocol; never a production authorization**

This document freezes the first comparison of economically distinct strategies
before any result from the new runner is inspected.  A definition, date,
threshold, candidate, or selection rule changed after the first run starts a
new epoch instead of silently modifying this one.

## Scope and non-claims

- The incumbent V11 paper strategy and its approved identity are not changed.
- Every candidate is long-only and uses adjusted daily OHLCV already cached by
  the project.  Signals use completed close D and orders fill no earlier than
  an open after D.
- Stock strategies use the same frozen 540-name current-universe fallback
  (`c86dc489c62625cd380dae6c105e28ee3dbe9aa124363b4dcd1a9f932bafa074`).
- The universe is not point-in-time and has survivorship/hindsight bias.
  Results can nominate a shadow challenger, but cannot establish investable or
  future alpha.
- Options, crypto, futures, FX, value, and quality are outside this epoch.  The
  repository has neither their causal data nor an appropriate execution,
  carry, borrow, or benchmark model.  Mixing them into the equity league would
  make the comparison less realistic, not broader.
- All data are physically capped at `2026-07-10`.  The period after 2024 has
  already been inspected in earlier work and is labelled `REUSED_TEMPORAL`,
  never fresh out-of-sample evidence.

## Frozen candidates

Common stock eligibility is price at least USD 10, trailing 60-session median
dollar volume at least USD 25 million, a known sector, close above its 200-day
simple moving average, positive 12-1 return, a current bar, and one contiguous
253-session adjusted-price epoch.  Except where stated otherwise, candidates
rebalance monthly, hold at most ten names, keep at most 9% in one stock and 20%
in one sector, reserve at least 10% cash, use the V11 SPY-SMA200/breadth gross
exposure gates, and use deterministic symbol tie-breaking.

1. `v11_incumbent` — canonical 12-1 rank and the promoted V11 breadth scaling.
2. `risk_adjusted_momentum` — equal percentile rank of 12-1/252-session
   volatility and 6-1/252-session volatility.
3. `market_residual_momentum` — 12-1 stock return minus beta times SPY 12-1,
   divided by residual daily volatility; beta is estimated causally from the
   latest 252 aligned completed daily returns.
4. `fip_momentum` — equal percentile rank of 12-1 return and smoothness.  The
   smoothness leg ranks lower information discreteness first, where
   `ID = sign(12-1) * (negative-day share - positive-day share)` over the 12-1
   formation window.
5. `high_52_week` — descending completed close divided by the maximum adjusted
   close in the latest 252 sessions.
6. `sector_neutral_momentum` — descending within-sector percentile of 12-1,
   then absolute 12-1, preserving the common portfolio sector cap.
7. `low_vol_trend` — the twenty lowest 252-session-volatility eligible stocks,
   quarterly rebalanced, inverse-volatility weighted, 4.5% name cap, 20%
   sector cap, and the common maximum 90% gross exposure.
8. `momentum_low_vol_ensemble` — a fixed 50/50 rank ensemble of 12-1 momentum
   and inverse 252-session volatility, followed by the common top-ten and caps.
9. `core_satellite` — when SPY is above SMA200, 50% SPY plus a 40% equal-weight
   sleeve of the canonical top-ten stocks; otherwise cash.  Stock-sector caps
   apply to the satellite.
10. `sector_etf_momentum` — the top three available unlevered sector SPDRs from
    XLK/XLF/XLV/XLI/XLY/XLP/XLE/XLB/XLU/XLRE/XLC, ranked by an equal percentile
    blend of positive 12-1 and 6-1 returns, individually above SMA200, inverse-
    volatility weighted to at most 90% gross.  Missing/stale ETFs are excluded.
11. `short_term_reversal_negative_control` — weekly top ten by the most
    negative completed five-session return, but only inside the common liquid,
    positive-long-trend stock set.  This deliberately turnover-heavy strategy
    is a negative control, not a favoured candidate.

No hyperparameter search is allowed inside this epoch.

## Clock, costs, and capacity

- Primary cost: 15 bps on every buy fill and 15 bps on every sell fill.
- Stress costs: 7, 25, and 50 bps per fill for every candidate.  Reversal must
  additionally remain interpretable at 30 and 50 bps.
- Primary clock: completed close D to the next session open.  A full extra
  session of order delay is a required stress test.
- Rebalances sell first.  Replacement buys wait at least one further session,
  and a missing exit price keeps the frozen liquidation intent pending.
- With USD 1 million starting equity, the stock cap implies an order no larger
  than USD 90,000.  Against the USD 25 million eligibility floor this is below
  0.36% of median daily dollar volume; a run that violates 1% participation is
  ineligible.
- Cash earns zero in the simulator.  BIL is used only as the observed
  risk-free proxy unless a candidate explicitly owns it.

## Frozen evaluation periods

Aggregate development is `2022-01-04..2024-12-31`; its six non-overlapping
stability folds are 2022H1, 2022H2, 2023H1, 2023H2, 2024H1, and 2024H2.
`REUSED_TEMPORAL` is `2025-01-02..2026-07-10`, split into 2025H1, 2025H2, and
2026H1.  Fold statistics are computed by slicing one continuous run, not by
restarting capital and then averaging Sharpe or drawdown values.

The bootstrap is paired on aligned daily returns, stationary with frozen seed
`20260803`, 10,000 resamples, and mean block length 21.  Block lengths 5 and 63
are sensitivity checks.  The multiple-testing trial count has a conservative
floor of 105 to acknowledge earlier repository searches.

## Selection and promotion gates

The report may name descriptive maximum-return, minimum-risk, and balanced
leaders.  A strategy is a statistically eligible challenger only if, at
25 bps/fill:

- development and `REUSED_TEMPORAL` excess CAGR and Jensen alpha are positive;
- at least four of six development folds and two of three reused folds beat
  SPY, with no fold drawdown more than 2 percentage points worse than V11;
- its paired stationary-bootstrap 5th percentile annualized active return is
  positive versus SPY and versus V11;
- the White Reality Check family-wise p-value is at most 0.05 and its Deflated
  Sharpe probability is at least 0.95;
- it remains positive versus SPY at 50 bps and under the extra-session delay;
- its fixed robust score (5th-percentile annualized excess divided by the 95th-
  percentile absolute drawdown) is at least 10% above V11, with at least 95%
  paired-bootstrap probability of improvement.

If no candidate clears every gate, `v11_incumbent` remains the paper strategy.
Even a passing candidate is only a `SHADOW_CHALLENGER`; promotion requires a
new, pre-registered forward-paper interval containing unseen market data and a
separate explicit deployment decision.
