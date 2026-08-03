# Strategy tournament — epoch 1 results

Status: **COMPLETE**
Decision: **RETAIN_V11**
Production changed: **no**

The later 2025–2026 interval is reused, not fresh out-of-sample data. The current-universe stock history has survivorship/hindsight bias; therefore no row below is a promise of future alpha.

| Candidate | Dev CAGR @15 | Dev excess @15 | Dev Sharpe @15 | Dev DD @15 | Reused excess @15 | Dev excess @25 | Dev excess @50 | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| v11_incumbent | 15.87 | 7.06 | 0.94 | -19.71 | -0.10 | 6.21 | 2.98 | BASELINE |
| risk_adjusted_momentum | 12.27 | 3.46 | 0.67 | -15.43 | 8.02 | 2.37 | -0.54 | FAIL |
| market_residual_momentum | 11.80 | 2.99 | 0.64 | -14.50 | 3.52 | 2.03 | -0.25 | FAIL |
| fip_momentum | 6.00 | -2.81 | 0.23 | -16.12 | -6.97 | -3.91 | -6.63 | FAIL |
| high_52_week | 3.36 | -5.45 | 0.00 | -16.67 | -15.22 | -6.42 | -9.52 | FAIL |
| sector_neutral_momentum | 11.39 | 2.58 | 0.59 | -17.26 | 4.93 | 0.27 | -2.56 | FAIL |
| low_vol_trend | 4.21 | -4.60 | 0.08 | -13.85 | -13.36 | -5.34 | -7.12 | FAIL |
| momentum_low_vol_ensemble | 5.87 | -2.94 | 0.25 | -14.88 | -11.45 | -3.97 | -6.54 | FAIL |
| core_satellite | 8.94 | 0.13 | 0.47 | -19.34 | -1.24 | -1.19 | -3.62 | FAIL |
| sector_etf_momentum | 2.22 | -6.59 | -0.10 | -20.16 | -22.05 | -7.71 | -10.51 | FAIL |
| short_term_reversal_negative_control | 0.15 | -8.65 | -0.26 | -20.58 | -26.61 | -12.50 | -21.66 | FAIL |

## Fixed selection

```json
{
  "candidate_gate_decisions": {
    "core_satellite": {
      "development_positive_spy_folds": 3,
      "eligible_challenger": false,
      "reasons": [
        "development: excess CAGR is not positive at 25 bps",
        "reused_temporal: excess CAGR is not positive at 25 bps",
        "fewer than 4/6 development folds beat SPY",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY at 50 bps",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 2,
      "robust_score": -0.42966462645421516,
      "robust_score_improvement_vs_v11_pct": -48.026097124956344
    },
    "fip_momentum": {
      "development_positive_spy_folds": 1,
      "eligible_challenger": false,
      "reasons": [
        "development: excess CAGR is not positive at 25 bps",
        "development: Jensen alpha is not positive at 25 bps",
        "reused_temporal: excess CAGR is not positive at 25 bps",
        "fewer than 4/6 development folds beat SPY",
        "fewer than 2/3 reused folds beat SPY",
        "2023H2: drawdown is >2 pp worse than V11",
        "2024H2: drawdown is >2 pp worse than V11",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY at 50 bps",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 1,
      "robust_score": -0.5293509792943267,
      "robust_score_improvement_vs_v11_pct": -82.36958467085381
    },
    "high_52_week": {
      "development_positive_spy_folds": 2,
      "eligible_challenger": false,
      "reasons": [
        "development: excess CAGR is not positive at 25 bps",
        "development: Jensen alpha is not positive at 25 bps",
        "reused_temporal: excess CAGR is not positive at 25 bps",
        "reused_temporal: Jensen alpha is not positive at 25 bps",
        "fewer than 4/6 development folds beat SPY",
        "fewer than 2/3 reused folds beat SPY",
        "2023H2: drawdown is >2 pp worse than V11",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY at 50 bps",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 0,
      "robust_score": -0.6425176049846268,
      "robust_score_improvement_vs_v11_pct": -121.35723432676745
    },
    "low_vol_trend": {
      "development_positive_spy_folds": 1,
      "eligible_challenger": false,
      "reasons": [
        "development: excess CAGR is not positive at 25 bps",
        "development: Jensen alpha is not positive at 25 bps",
        "reused_temporal: excess CAGR is not positive at 25 bps",
        "reused_temporal: Jensen alpha is not positive at 25 bps",
        "fewer than 4/6 development folds beat SPY",
        "fewer than 2/3 reused folds beat SPY",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY at 50 bps",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 0,
      "robust_score": -0.7720615632503551,
      "robust_score_improvement_vs_v11_pct": -165.98712789385485
    },
    "market_residual_momentum": {
      "development_positive_spy_folds": 2,
      "eligible_challenger": false,
      "reasons": [
        "fewer than 4/6 development folds beat SPY",
        "fewer than 2/3 reused folds beat SPY",
        "2024H2: drawdown is >2 pp worse than V11",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 1,
      "robust_score": -0.41288247103088355,
      "robust_score_improvement_vs_v11_pct": -42.24438549288437
    },
    "momentum_low_vol_ensemble": {
      "development_positive_spy_folds": 1,
      "eligible_challenger": false,
      "reasons": [
        "development: excess CAGR is not positive at 25 bps",
        "development: Jensen alpha is not positive at 25 bps",
        "reused_temporal: excess CAGR is not positive at 25 bps",
        "reused_temporal: Jensen alpha is not positive at 25 bps",
        "fewer than 4/6 development folds beat SPY",
        "fewer than 2/3 reused folds beat SPY",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY at 50 bps",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 0,
      "robust_score": -0.6049736693647144,
      "robust_score_improvement_vs_v11_pct": -108.42276888941204
    },
    "risk_adjusted_momentum": {
      "development_positive_spy_folds": 3,
      "eligible_challenger": false,
      "reasons": [
        "fewer than 4/6 development folds beat SPY",
        "2024H2: drawdown is >2 pp worse than V11",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 3,
      "robust_score": -0.4118323341968842,
      "robust_score_improvement_vs_v11_pct": -41.882597141195035
    },
    "sector_etf_momentum": {
      "development_positive_spy_folds": 1,
      "eligible_challenger": false,
      "reasons": [
        "development: excess CAGR is not positive at 25 bps",
        "development: Jensen alpha is not positive at 25 bps",
        "reused_temporal: excess CAGR is not positive at 25 bps",
        "reused_temporal: Jensen alpha is not positive at 25 bps",
        "fewer than 4/6 development folds beat SPY",
        "fewer than 2/3 reused folds beat SPY",
        "2023H1: drawdown is >2 pp worse than V11",
        "2023H2: drawdown is >2 pp worse than V11",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY at 50 bps",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "7 bps D+1: one or more orders exceed the 1% ADV cap",
        "15 bps D+1: one or more orders exceed the 1% ADV cap",
        "25 bps D+1: one or more orders exceed the 1% ADV cap",
        "50 bps D+1: one or more orders exceed the 1% ADV cap",
        "25 bps D+2: one or more orders exceed the 1% ADV cap",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 0,
      "robust_score": -0.6254507958427657,
      "robust_score_improvement_vs_v11_pct": -115.47745509407925
    },
    "sector_neutral_momentum": {
      "development_positive_spy_folds": 3,
      "eligible_challenger": false,
      "reasons": [
        "fewer than 4/6 development folds beat SPY",
        "2024H1: drawdown is >2 pp worse than V11",
        "2024H2: drawdown is >2 pp worse than V11",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 2,
      "robust_score": -0.38373775269914423,
      "robust_score_improvement_vs_v11_pct": -32.20358008133333
    },
    "short_term_reversal_negative_control": {
      "development_positive_spy_folds": 1,
      "eligible_challenger": false,
      "reasons": [
        "development: excess CAGR is not positive at 25 bps",
        "development: Jensen alpha is not positive at 25 bps",
        "reused_temporal: excess CAGR is not positive at 25 bps",
        "reused_temporal: Jensen alpha is not positive at 25 bps",
        "fewer than 4/6 development folds beat SPY",
        "fewer than 2/3 reused folds beat SPY",
        "2022H1: drawdown is >2 pp worse than V11",
        "2023H2: drawdown is >2 pp worse than V11",
        "2024H2: drawdown is >2 pp worse than V11",
        "2026H1: drawdown is >2 pp worse than V11",
        "development vs SPY: paired bootstrap q05 is not positive",
        "reused vs SPY: paired bootstrap q05 is not positive",
        "development vs V11: paired bootstrap q05 is not positive",
        "reused vs V11: paired bootstrap q05 is not positive",
        "White Reality Check vs SPY does not reject at 5%",
        "White Reality Check vs V11 does not reject at 5%",
        "candidate is not the family-best result vs SPY",
        "candidate is not the family-best result vs V11",
        "autocorrelation-adjusted Deflated Sharpe is below 0.95",
        "development: not positive vs SPY at 50 bps",
        "development: not positive vs SPY under D+2 delay",
        "reused_temporal: not positive vs SPY at 50 bps",
        "reused_temporal: not positive vs SPY under D+2 delay",
        "robust score is not at least 10% better than V11",
        "development probability of improvement vs V11 is below 95%",
        "reused probability of improvement vs V11 is below 95%"
      ],
      "reused_positive_spy_folds": 0,
      "robust_score": -0.5678996179652022,
      "robust_score_improvement_vs_v11_pct": -95.65018582022003
    },
    "v11_incumbent": {
      "eligible_challenger": false,
      "reasons": [
        "incumbent control is the comparison baseline"
      ],
      "robust_score": -0.2902627542030737
    }
  },
  "decision": "RETAIN_V11",
  "descriptive_leader_basis": {
    "balanced_robust_score": "development robust score at selection 25 bps/fill",
    "maximum_return": "development CAGR at primary 15 bps/fill",
    "minimum_bootstrap_drawdown": "development q95 bootstrap drawdown at selection 25 bps/fill"
  },
  "descriptive_leaders": {
    "balanced_robust_score": "v11_incumbent",
    "maximum_return": "v11_incumbent",
    "minimum_bootstrap_drawdown": "low_vol_trend"
  },
  "forward_paper_required": true,
  "production_changed": false,
  "shadow_challenger": null,
  "statistically_eligible_challengers": []
}
```

Full metrics, folds, cost/delay stress, capacity checks, paired bootstrap, White Reality Check, and Deflated Sharpe evidence are stored in `state/backtest/strategy_tournament_epoch_1.json`.
