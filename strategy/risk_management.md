# Risk Management

## Drawdown Escalation

| Level | Trigger | Actions |
|-------|---------|---------|
| **NORMAL** | Default state | Full trading per `rules.md` |
| **CAUTIOUS** | Weekly P&L ≤ −2% | Halve position sizes, raise confidence threshold to 75, no new sectors, tighten stops to 6% |
| **HALT** | Monthly P&L ≤ −5% | No new trades. Only close/manage existing. Review strategy before resuming. |

### Tier Transitions
- Check at every routine execution
- Escalation is immediate upon breach
- De-escalation: HALT → CAUTIOUS after 3 consecutive green days; CAUTIOUS → NORMAL after weekly P&L returns to ≥ 0%

---

## Daily Loss Limit

- If unrealized + realized daily P&L hits **−3%**, stop all trading for the rest of the day
- Cancel all open buy orders
- Do NOT close existing positions unless stop-losses trigger
- Log the halt in the daily journal with reasoning

---

## Position-Level Stops

| Type | Rule |
|------|------|
| **Initial stop** | 8% below entry price, set as trailing stop order |
| **Trailing stop** | 8% from highest closing price since entry |
| **Profit protection** | After +5% gain, tighten stop to 5% trailing |
| **Time stop** | Close after 10 days if gain < 5% |

---

## Concentration Limits

| Metric | Limit |
|--------|-------|
| Single position | 5% of equity |
| Single sector | 25% of equity |
| Total invested | 80% of equity (20% cash reserve) |
| Max positions | 10 |

---

## Pre-Trade Checklist

Before placing any order, verify:

- [ ] Risk tier allows new trades (not HALT)
- [ ] Cash after trade ≥ 20% of equity
- [ ] Position size ≤ 5% of equity (2.5% if CAUTIOUS)
- [ ] Sector exposure after trade ≤ 25%
- [ ] Total open positions < 10
- [ ] Daily P&L > −3%
- [ ] Confidence score ≥ 65 (75 if CAUTIOUS)
- [ ] All 5 entry criteria met

---

## Recovery Protocol

When in HALT mode:
1. Review all open positions — close any with confidence < 40
2. Analyze losing trades from the month — update `memory/lessons_learned.md`
3. Wait for 3 consecutive green days before moving to CAUTIOUS
4. In CAUTIOUS, trade at half size for at least 5 trading days
5. Only return to NORMAL when weekly P&L ≥ 0%
