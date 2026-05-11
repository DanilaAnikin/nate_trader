# Trading Rules — Regime-Adaptive Momentum Swing

All entry gates, position sizing, and exit triggers are **regime-aware** and
resolved through `scripts/strategy_config.py`. The same algorithm pivots from
aggressive in BULL to defensive in BEAR without manual tuning.

---

## Entry Criteria — 5-Question Checklist

Every BUY candidate must pass ALL five questions. Volume, RS, and confidence
thresholds adapt to the current SPY market regime.

1. **Trend alignment** — Price > 20-SMA AND Price > 50-SMA
2. **Catalyst present** — news_score > 5 OR perplexity_score > 10
3. **Volume confirmation** — volume_ratio ≥ `volume_min_ratio` (1.0 in BULL, 1.2 NEUTRAL, 1.5 BEAR)
4. **Relative strength** — 20-day return − SPY 20-day return ≥ `rs_alpha_min`
   (−2.0% BULL, 0.0% NEUTRAL, +5.0% BEAR)
5. **Confidence score** — total ≥ `score_threshold` (55 BULL / 65 NEUTRAL / 80 BEAR)

Any FAIL → skip the candidate. The threshold drops by an additional
`cash_starve_bonus` if portfolio cash exceeds `max_cash_pct` (forces capital
deployment in bulls).

---

## Confidence Scoring (0–100)

### Technical (max ~37)
| Signal | Points |
|--------|--------|
| Price > 20-SMA and 50-SMA | 10 |
| RSI in regime sweet spot | up to 10 |
| MACD > signal | 7 |
| Volume confirmation | up to 5 |
| 20-day momentum (≥+10% = 5, ≥+5% = 3, ≥0% = 1) | up to 5 |

**RSI sweet spot** moves with regime (no more penalizing momentum):
- BULL: sweet 55–80, acceptable 45–88
- NEUTRAL: sweet 50–70, acceptable 40–75
- BEAR: sweet 35–60, acceptable 30–65

### News (max 35)
Sentiment-keyword scan of recent headlines; +4 per positive, −4 per negative.

### Perplexity (max 30)
Catalyst depth score from `perplexity_research.py enhance`.

### Action mapping
- `total ≥ score_threshold` → BUY
- `40 ≤ total < threshold` → HOLD
- `total < 40` → SELL

---

## Exit Criteria

| Trigger | Action |
|---------|--------|
| **Trailing stop** | regime-adaptive (8% NORMAL, 6% CAUTIOUS, 5% BEAR) — placed automatically after fill |
| **Tightened stop** | once gain ≥ 5%, swap trail to `tightened_stop_pct` (5% / 4% / 3%) |
| **Scale-out** | sell 50% at `scale_out_at_gain` (10% BULL, 8% CAUTIOUS, 7% BEAR) |
| **Final target** | close remainder at `final_target_gain` (20% / 15% / 12%) |
| **Time stop** | close if held > `time_stop_days` without `time_stop_min_gain` |
| **Catalyst reversal** | research action flips to SELL (score < 40) |

Time-stop uses Alpaca order history to determine real entry date (not a
heuristic).

---

## Position Sizing

`shares = min(allocation_shares, risk_shares)` where both formulas are
regime-adaptive:

1. **Allocation cap**: `equity × max_position_pct / entry_price`
   - 6% BULL/NORMAL, 5% NEUTRAL/NORMAL, 3% CAUTIOUS, 2% BEAR
2. **Risk-based**: `equity × risk_per_trade_pct / (entry_price × trailing_stop_pct)`
   - 1.0% BULL/NORMAL, 0.7% NEUTRAL, 0.5% CAUTIOUS, 0.3% BEAR

CAUTIOUS halves both. HALT disallows new positions entirely.

---

## Market Regime Detection

Determined from SPY in `research.py:get_spy_benchmark`:
- **BULL** — price > 20-SMA > 50-SMA
- **BEAR** — price < 20-SMA AND 20-SMA < 50-SMA
- **NEUTRAL** — anything else

Regime is written into `state/research.json` → `spy.market_regime` and read
by every downstream component.

---

## Order Execution

- **Limit orders only** — never market orders
- Buy at ask, sell at last × 0.999 (limit just under)
- DAY time-in-force; if unfilled in 30 min, cancel and reassess
- Trailing stop placed via `sync_trailing_stops()` after every fill

---

## Sector Concentration

- Max 25% of equity in any single sector
- Tracked sectors: Technology, Consumer, Financial, Healthcare, Industrial, Energy, Benchmark
- Enforced in `validate_order` — order rejected if breach predicted
