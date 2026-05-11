# Risk Management — Regime-Adaptive

All risk knobs are resolved from `scripts/strategy_config.py` based on
(market_regime, risk_tier). This file describes the policies; the numbers
live in code so they stay consistent across every script.

---

## Drawdown Escalation

| Tier | Trigger | Behavior |
|------|---------|----------|
| **NORMAL** | Default | Full strategy per current regime |
| **CAUTIOUS** | Weekly P&L ≤ −2% | Tighter thresholds, halved sizing, tighter stops |
| **HALT** | Monthly P&L ≤ −5% | No new buys — manage existing only |

**De-escalation:** HALT → CAUTIOUS after 3 consecutive green days;
CAUTIOUS → NORMAL after weekly P&L returns to ≥ 0%.

Auto-set in `portfolio.update_performance_state()` after every routine.

---

## Daily Loss Limit

- If realized + unrealized daily P&L hits **−3%**, stop all new buys for the day
- Existing positions managed normally; their stops still trigger
- Logged in `state/performance.json` and journal

---

## Position-Level Stops (regime-adaptive)

| State | Trail % |
|-------|---------|
| Default trailing stop (BULL/NORMAL) | 8% |
| Default (NEUTRAL/NORMAL, BULL/CAUTIOUS) | 6% |
| BEAR or CAUTIOUS | 5–6% |
| Tightened (after +5% gain) | 5% / 4% / 3% by regime |

Stops are placed automatically via `sync_trailing_stops()` after every fill
and re-evaluated by `tighten_stops_in_profit()` once positions are in profit.

---

## Profit-Taking (regime-adaptive)

| Regime | Scale-out 50% | Final target |
|--------|---------------|--------------|
| BULL/NORMAL | +10% | +20% |
| NEUTRAL/NORMAL | +10% | +15% |
| BEAR/NORMAL | +7% | +12% |
| Any CAUTIOUS | −2 pp on both | −5 pp |

Idempotent — once scaled out, the symbol is recorded in
`state/performance.json:scaled_out` and skipped on subsequent runs until the
position is fully closed.

---

## Time Stop

Position closes if held longer than `time_stop_days` without reaching
`time_stop_min_gain`. Real entry date pulled from Alpaca order history (not
a heuristic on history length).

| Regime/Tier | Max days | Min gain |
|-------------|----------|----------|
| BULL/NORMAL | 12 | +4% |
| NEUTRAL/NORMAL | 10 | +5% |
| BEAR/NORMAL | 7 | +3% |
| Any CAUTIOUS | shorter, see config | tighter |

---

## Concentration Limits

| Metric | NORMAL | CAUTIOUS |
|--------|--------|----------|
| Single position | 5–6% of equity (regime-dependent) | 2.5–3% |
| Single sector | 25% | 25% |
| Min cash reserve | 5–40% (regime-dependent) | 25–60% |
| Max open positions | 15 BULL / 12 NEUTRAL / 8 BEAR | halved (5–10) |

In BULL/NORMAL the cash floor drops to 5% (deploy capital). In BEAR/CAUTIOUS
it rises to 60%+ (defend capital).

---

## Cash Deployment Pressure

If `cash_pct > max_cash_pct` for the current regime, the score threshold
drops by `cash_starve_bonus` (5 points in BULL/NORMAL). Prevents the system
from sitting on cash during a strong rally — the original failure mode that
cost ~6% of monthly alpha.

Absolute floor: threshold never goes below 40 (no buying low-conviction).

---

## Pre-Trade Checklist (validate_order)

Order rejected if any of:
- Risk tier is HALT
- Cash after order < `min_cash_pct` of equity
- Single-position exposure > `max_position_pct`
- Total open positions ≥ 10 (for new symbols)
- Sector exposure after order > 25%
- Daily P&L ≤ −3%
- Symbol not tradeable on Alpaca

---

## Recovery Protocol

When in HALT:
1. Review every position — close any with confidence < 40
2. Update `memory/lessons_learned.md` from the drawdown
3. Wait 3 consecutive green days → CAUTIOUS
4. In CAUTIOUS, half size for ≥ 5 trading days
5. Return to NORMAL only when weekly P&L ≥ 0%
