# Trading Rules

## Entry Criteria (ALL must be true)

1. **Trend alignment**: Price > 20-SMA AND Price > 50-SMA
2. **Catalyst present**: Concrete news catalyst within last 5 trading days (earnings, product, upgrade, macro tailwind)
3. **Volume confirmation**: Recent volume ≥ 1.2× 20-day average volume
4. **Relative strength**: Stock's 5-day return > SPY's 5-day return
5. **Confidence score ≥ 65**: Composite of technical (0–35) + news (0–35) + Perplexity (0–30)

If any criterion is **NO** → do not open a new position.

---

## Exit Criteria (ANY triggers exit)

| Trigger | Action |
|---------|--------|
| **Stop-loss** | 8% trailing stop from highest close since entry |
| **Profit target 1** | Sell 50% at +10% gain |
| **Profit target 2** | Sell remaining at +15% gain |
| **Time stop** | Close if held > 10 trading days without +5% gain |
| **Catalyst reversal** | Close if original catalyst is invalidated (e.g., earnings miss, downgrade) |
| **Confidence < 40** | Close position on next research update |

---

## Position Sizing

Calculate position size as the **minimum** of:

1. **Allocation limit**: 5% of total portfolio equity
2. **Risk-based**: `(portfolio_equity × 0.004) / (entry_price × 0.08)` shares
   - Risks 0.4% of portfolio per trade assuming 8% stop-loss

### In CAUTIOUS mode
- Halve both calculations (effective max: 2.5% of equity)

### In HALT mode
- No new positions allowed

---

## Market Regime Rules

| Regime | SPY Condition | Behavior |
|--------|--------------|----------|
| **Bull** | SPY > 20-SMA > 50-SMA | Full trading, all criteria apply |
| **Neutral** | SPY between 20-SMA and 50-SMA | Tighten confidence to ≥ 70, reduce position size by 25% |
| **Bear** | SPY < 20-SMA < 50-SMA | No new longs. Only manage existing positions. Consider closing weak holdings. |

---

## Order Execution

- **Limit orders only** — never use market orders
- Set limit price at **last price ± 0.1%** (buy slightly above, sell slightly below)
- If order doesn't fill within 30 minutes, cancel and reassess
- Always attach a trailing stop order immediately after a fill

---

## Sector Concentration

- Max 25% of portfolio in any single sector
- Sectors tracked: Technology, Consumer, Healthcare, Financial, Energy, Industrial
- Before opening a position, verify sector exposure won't breach limit
