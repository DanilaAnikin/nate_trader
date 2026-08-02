# V11 Development-Only Tactic Selection Contract

Status: frozen before the second-round tactic results are inspected.

## Claim boundary

This protocol searches for a better risk/return implementation without
pretending that repeated backtests create fresh evidence. Candidate selection
uses only 2022-01-04 through 2024-12-31. The already-inspected 2025-01-02
through 2026-07-10 segment is not available to the selector and may be run once
only after the balanced winner and production policy are frozen.

All comparisons use $1,000,000 starting capital, causal D-close/D+1-open
execution, the exact checked-in 540-symbol ranking universe, and 15 bps per
fill. The current V11 is the baseline:

| Metric | Baseline |
|---|---:|
| CAGR | 15.5786% |
| Excess CAGR vs SPY | 6.7588 pp |
| Jensen alpha | 9.2239% |
| Sharpe | 0.8981 |
| Maximum drawdown | -20.2379% |
| Trades | 222 |

Standalone baseline excess CAGR is +6.7616 pp in 2022, -12.1605 pp in 2023,
and +30.5519 pp in 2024. The predeclared worst-year reference is therefore
-12.1605 pp.

## Predeclared tactic families

The second round is deliberately small and economically motivated:

1. current V11 baseline;
2. SPY volatility targeting at 10% and 12%;
3. cross-sectional breadth scaling;
4. 12% SPY volatility targeting combined with breadth scaling;
5. stock-volatility eligibility caps of 50% and 60%;
6. inverse-volatility allocation;
7. coherent 12-name diversification with a 7.5% name cap;
8. incumbent hold bands at ranks 12 and 15;
9. an 18% sector cap;
10. positive 6-1 momentum confirmation;
11. equal-rank 12-1/6-1 composite ranking; and
12. 12-1 momentum required to exceed SPY's own 12-1 return.

No unlisted parameter grid may be introduced after seeing results. A failed
family may be diagnosed, but a newly invented follow-up becomes a future
research round rather than part of this selection.

## Three saved winners

Every tested tactic remains in the development leaderboard. Three different
winners are retained instead of collapsing risk and return into one opaque
score.

### Maximum-return winner

Choose the highest development CAGR among tactics satisfying all of:

- excess CAGR and Jensen alpha are strictly positive;
- maximum drawdown is no worse than -22.2379%;
- no more than 333 trades; and
- worst calendar-year excess CAGR is no worse than 2 pp below the baseline's
  worst year.

### Minimum-risk winner

Choose the smallest absolute maximum drawdown among tactics satisfying all of:

- development excess CAGR is at least +2 pp;
- Jensen alpha is strictly positive;
- CAGR is at least 2 pp above development SPY CAGR; and
- Sharpe is at least 0.75.

### Balanced winner

Eligible tactics must satisfy all of:

- development excess CAGR and Jensen alpha are strictly positive;
- CAGR is at least 15.0786%, no more than 0.50 pp below baseline;
- maximum drawdown is no worse than the baseline -20.2379%;
- worst calendar-year excess CAGR is no more than 1 pp below baseline;
- no more than 277 trades; and
- no metric is materially degraded versus baseline: at most -0.50 pp CAGR,
  -0.50 pp Jensen alpha, -0.03 Sharpe, or -1.00 pp maximum drawdown.

Among eligible tactics, choose the highest Sharpe, breaking ties by higher
CAGR and then lower turnover. Replacing production additionally requires the
candidate to improve at least two of CAGR, Jensen alpha, Sharpe, and maximum
drawdown. Otherwise the current V11 remains the balanced winner.

## Robustness report

The aggregate selector is accompanied by independent 2022, 2023, and 2024
runs. Calendar-year metrics are diagnostics and enforce the worst-year floors
above; the protocol does not demand that a long-only momentum strategy beat SPY
in every market state.

The final artifact must record every candidate, rejection reason, all three
winners, source/universe identities, and the explicit warning that historical
selection does not guarantee future alpha.

## Frozen development result

The completed 15 bps comparison is stored in
`state/backtest/v11_tactics_development.json`. It contains all 15 candidates,
their standalone 2022/2023/2024 restarts, profile eligibility decisions, and
the exact 540-symbol universe identity.

| Candidate | CAGR | Excess CAGR | Jensen alpha | Sharpe | Max DD | Trades |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 15.5786% | 6.7588 pp | 9.2239% | 0.8981 | -20.2379% | 222 |
| 10% market-vol target | 14.2986% | 5.4788 pp | 8.2962% | 0.9466 | -12.1619% | 226 |
| 12% market-vol target | 15.0302% | 6.2104 pp | 8.8696% | 0.9322 | -16.2122% | 221 |
| Breadth scaling | **15.8933%** | **7.0735 pp** | **9.5498%** | **0.9385** | **-19.7053%** | 226 |
| 12% market-vol + breadth | 15.0577% | 6.2379 pp | 8.9352% | 0.9427 | -16.1501% | 221 |
| 50% stock-vol cap | 8.9608% | 0.1410 pp | 3.3207% | 0.4566 | -16.5699% | 224 |
| 60% stock-vol cap | 9.5301% | 0.7103 pp | 3.8990% | 0.5036 | -18.7123% | 229 |
| Inverse-vol allocation | 15.7467% | 6.9269 pp | 9.3796% | 0.9100 | -20.6154% | 222 |
| Top 12 | 13.7553% | 4.9355 pp | 7.6455% | 0.8533 | -15.8174% | 243 |
| Hold through rank 12 | 13.2295% | 4.4097 pp | 7.0970% | 0.7752 | -19.2992% | 213 |
| Hold through rank 15 | 12.7857% | 3.9659 pp | 6.6929% | 0.7432 | -19.2928% | 207 |
| 18% sector cap | 15.5786% | 6.7588 pp | 9.2239% | 0.8981 | -20.2379% | 222 |
| Positive 6-1 confirmation | 13.7252% | 4.9054 pp | 7.5889% | 0.7728 | -18.0938% | 218 |
| 12-1/6-1 composite | 12.0669% | 3.2471 pp | 6.1694% | 0.6445 | -19.7382% | 227 |
| Beat SPY 12-1 | 14.9110% | 6.0912 pp | 8.6495% | 0.8652 | -19.9313% | 215 |

The frozen profile winners are:

- maximum return: `breadth_scaled`;
- minimum risk: `market_vol_10`; and
- balanced production candidate: `breadth_scaled`.

Breadth scaling improved all four balanced decision metrics versus baseline:
CAGR by 0.3147 pp, Jensen alpha by 0.3259 pp, Sharpe by 0.0404, and maximum
drawdown by 0.5326 pp. Its worst standalone-year excess CAGR was -10.8087 pp
in 2023, better than baseline's -12.1605 pp, so it passed every frozen
replacement condition. The production policy therefore enables breadth
scaling; the 10% market-vol profile remains saved research evidence rather
than an automatic live mode.

### Boundary audit

An exploratory SPY-relative run initially appeared much stronger because its
start was accidentally shifted from 2022-01-04 to 2022-01-03. The earlier
start formed its first signal on 2021-12-31, when SPY lacked the 253 completed
observations required for 12-1 momentum. The relative filter correctly failed
closed and left the portfolio in cash until February, creating an artificial
advantage. Repeating the exact frozen boundary produced the table above.
Calendar-year slices were also rejected in favor of independent cash
restarts. This sensitivity is recorded as a warning, not hidden as a winner.

## One frozen canonical validation

After enabling the balanced winner, the fixed validator was run once without
parameter overrides. All eight required positive-alpha checks passed:

| Cost | Segment | CAGR | SPY CAGR | Excess | Jensen | Sharpe | Max DD |
|---:|---|---:|---:|---:|---:|---:|---:|
| 7 bps | Development | 17.1022% | 8.8198% | 8.2824 pp | 10.5896% | 1.0226 | -18.6554% |
| 7 bps | Reused temporal | 19.9535% | 18.7328% | 1.2208 pp | 8.0530% | 0.7789 | -17.2217% |
| 15 bps | Development | 15.8933% | 8.8198% | 7.0735 pp | 9.5498% | 0.9385 | -19.7053% |
| 15 bps | Reused temporal | 19.0004% | 18.7328% | 0.2677 pp | 7.2580% | 0.7403 | -17.3795% |

The temporal raw excess, especially +0.2677 pp at 15 bps, is much thinner
than the development result and weaker than the prior baseline on these reused
dates. The positive Jensen result comes with lower beta; neither metric is a
forward guarantee. The policy was not retuned after this observation. Its
`PASS` status means paper-validation-eligible only, with forward frozen-rule
paper results now required.
