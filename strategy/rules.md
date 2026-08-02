# Trading Rules — Aggressive Momentum Engine (v2, archived)

> [!WARNING]
> **Archived pre-V11 material.** These rules are retained only as an audit
> reference; they are not the current production policy, and the old behavior
> and data dependencies are not guaranteed to remain reproducible.
> Use [`v11_adaptive_momentum.md`](v11_adaptive_momentum.md) for the active
> signal, allocation, and execution rules.

All entry gates, position sizing, and exit triggers are **regime-aware** and
resolved through `scripts/strategy_config.py`. The same algorithm pivots from
aggressive in BULL to defensive in BEAR without manual tuning.

---

## Entry Criteria — Weighted Gate Score

BUY candidates are filtered through a **weighted gate score** (0.0–1.0) instead
of the old 5-question AND-gate. Each signal contributes proportionally:

| Signal | Weight | Pass condition |
|--------|--------|----------------|
| **Trend** | 30% | Price > 20-SMA AND 50-SMA (partial: 50% if only > 20-SMA) |
| **Relative strength** | 25% | 20d return − SPY 20d return ≥ `rs_alpha_min` |
| **Catalyst** | 15% | news_score > 5 OR perplexity_score > 10 |
| **Volume** | 15% | volume_ratio ≥ `volume_min_ratio` |
| **Confidence** | 15% | total score ≥ `score_threshold` |

**Gate score thresholds by regime:**
| Regime | Min gate score |
|--------|---------------|
| BULL/NORMAL | 0.55 |
| BULL/CAUTIOUS | 0.60 |
| NEUTRAL/NORMAL | 0.65 |
| NEUTRAL/CAUTIOUS | 0.70 |
| BEAR/NORMAL | 0.80 |
| BEAR/CAUTIOUS | 0.85 |

This lets strong-momentum names through even with moderate volume or missing
catalyst. The threshold also drops by `cash_starve_bonus` if portfolio cash
exceeds `max_cash_pct` (forces capital deployment).

---

## Confidence Scoring (0–100) — Rebalanced

### Technical Score (max 50) — v3 momentum-aligned
| Signal | Points |
|--------|--------|
| Price > 20-SMA AND 50-SMA (uptrend) | 12 |
| Price > 20-SMA only (early/recovering) | 6 |
| RSI in regime sweet spot | up to 10 |
| MACD > signal line | 7 |
| MACD > 0 (above zero line bonus) | 3 |
| Volume confirmation (≥ vol_min_ratio) | up to 5 |
| 20-day high breakout (within 2% = 4, within 5% = 2) | up to 4 |
| 50-day high breakout (new high = 6, within 3% = 3) | up to 6 |
| 20-day momentum (≥+10% = 5, ≥+5% = 3, ≥0% = 1) | up to 5 |

*v3 removed mean-reversion bonuses (ATR squeeze, Bollinger lower-band).*

### Catalyst Score (max 25) — combined news + perplexity
- News: rescaled from 0-35 → 0-12
- Perplexity: rescaled from 0-30 → 0-13
- Combined: min(25, rescaled_news + rescaled_perplexity)

### Momentum Alpha Score (max 25) — relative strength vs SPY
| Alpha (stock 20d return − SPY 20d return) | Points |
|---------------------------------------------|--------|
| ≥ +15% | 25 |
| ≥ +10% | 20 |
| ≥ +5% | 15 |
| ≥ +2% | 10 |
| ≥ 0% | 5 |
| < 0% | 0 |

### Action thresholds (regime-adaptive)
| Regime | BUY threshold | SELL threshold |
|--------|---------------|----------------|
| BULL/NORMAL | 45 | < 30 |
| BULL/CAUTIOUS | 55 | < 40 |
| NEUTRAL/NORMAL | 55 | < 40 |
| NEUTRAL/CAUTIOUS | 65 | < 50 |
| BEAR/NORMAL | 70 | < 55 |
| BEAR/CAUTIOUS | 80 | < 65 |

---

## Exit Criteria

| Trigger | Action |
|---------|--------|
| **Trailing stop** | regime-adaptive (10% BULL, 8% NEUTRAL, 6% BEAR) |
| **Tightened stop** | once gain ≥ 5%, swap trail to `tightened_stop_pct` |
| **Scale-out** | sell 50% at `scale_out_at_gain` (15% BULL, 12% NEUTRAL, 8% BEAR) |
| **Final target** | close remainder at `final_target_gain` (30% BULL, 20% NEUTRAL, 15% BEAR) |
| **Time stop** | close if held > `time_stop_days` without `time_stop_min_gain` |
| **Catalyst reversal** | research action flips to SELL |

All sell orders use limit orders (bid × 0.999), never market orders.

---

## Position Sizing

`shares = min(alloc_shares, risk_shares, atr_shares)` — three methods:

1. **Allocation cap**: `equity × max_position_pct / entry_price`
   - 10% BULL/NORMAL, 8% NEUTRAL, 5% CAUTIOUS, 4% BEAR
2. **Risk-based**: `equity × risk_per_trade_pct / (entry_price × trailing_stop_pct)`
   - 1.5% BULL/NORMAL, 1.0% NEUTRAL, 0.8% CAUTIOUS, 0.5% BEAR
3. **ATR-based**: `(equity × risk_pct) / (ATR_14 × 2)` — volatility-aware

ATR sizing naturally takes smaller positions in volatile names and larger in
stable ones. HALT disallows new directional buys (hedges still allowed).

---

## Hard Rules (Regime-Adaptive)

| Rule | BULL/NORMAL | NEUTRAL/NORMAL | BEAR/NORMAL |
|------|-------------|----------------|-------------|
| Max position size | 10% | 8% | 4% |
| Min cash reserve | 3% | 10% | 30% |
| Risk per trade | 1.5% | 1.0% | 0.5% |
| Trailing stop | 10% | 8% | 6% |
| Scale-out gain | +15% | +12% | +8% |
| Final target | +30% | +20% | +15% |
| Time stop | 15d / +4% | 12d / +4% | 8d / +3% |
| Daily loss halt | −3% (universal) | | |
| Max positions | 12 | 12 | 8 |
| Sector cap | 25% | 25% | 25% |
| Order type | Limit only | Limit only | Limit only |

---

## Market Regime Detection

Determined from SPY in `research.py:get_spy_benchmark`:
- **BULL** — price > 20-SMA > 50-SMA
- **BEAR** — price < 20-SMA AND 20-SMA < 50-SMA
- **NEUTRAL** — anything else

---

## Bear Hedge (SH inverse SPY)

Target as % of equity: 0% BULL, 10% NEUTRAL, 25% BEAR (CAUTIOUS +5pp,
HALT +10pp, max 35%). Rebalances when actual drift > 2% of equity.
Exempt from sector cap, position-count cap, and HALT block.

---

## Sector Concentration

- Max 25% of equity in any single sector
- Tracked sectors: Technology, Consumer, Financial, Healthcare, Industrial, Energy, Materials, Utilities, RealEstate, Communication, Hedge
- Enforced in `validate_order` — order rejected if breach predicted
