"""Generate daily journal and weekly review from state files."""

import sys
from datetime import datetime, timedelta

from utils import (
    RESEARCH_STATE, POSITIONS_STATE, PERFORMANCE_STATE, SCREENER_STATE,
    JOURNAL_DIR, MEMORY_DIR,
    setup_logging, get_today_str, get_now_str, load_json, save_json,
    get_risk_tier, EDT,
)

log = setup_logging("write_journal")


def write_daily_journal() -> str:
    """Generate and write the daily trading journal from state files."""
    today = get_today_str()
    log.info(f"Writing daily journal for {today}...")

    research = load_json(RESEARCH_STATE)
    perf = load_json(PERFORMANCE_STATE)
    positions_data = load_json(POSITIONS_STATE)
    screener = load_json(SCREENER_STATE)

    # SPY data
    spy = research.get("spy", {})
    spy_price = spy.get("price", "N/A")
    spy_5d = spy.get("five_day_return", "N/A")
    spy_monthly = spy.get("monthly_return", "N/A")
    spy_regime = spy.get("market_regime", "N/A")

    # Format SPY price
    if isinstance(spy_price, (int, float)):
        spy_price_str = f"${spy_price:,.2f}"
        spy_5d_str = f"{spy_5d:+.2f}%" if isinstance(spy_5d, (int, float)) else "N/A"
    else:
        spy_price_str = "N/A"
        spy_5d_str = "N/A"

    # Research summary
    symbols_data = research.get("symbols", {})
    total_scanned = len(symbols_data)
    scored_symbols = {s: d for s, d in symbols_data.items() if "error" not in d}
    screener_scored = screener.get("scored_candidates", {})

    # Top candidates by score
    top_candidates = []
    for sym, data in scored_symbols.items():
        score = data.get("confidence", {}).get("total", 0)
        top_candidates.append((sym, score))
    for sym, data in screener_scored.items():
        score = data.get("confidence", {}).get("total", 0)
        top_candidates.append((sym, score))
    top_candidates.sort(key=lambda x: x[1], reverse=True)

    top_str = ", ".join(f"{s} ({sc})" for s, sc in top_candidates[:5]) if top_candidates else "None"

    # Positions
    positions = positions_data.get("positions", [])
    positions_table = ""
    for p in positions:
        stop_price = float(p["avg_entry_price"]) * 0.92  # 8% stop
        positions_table += (
            f"| {p['symbol']} | {p['qty']:.0f} | ${p['avg_entry_price']:,.2f} "
            f"| ${p['current_price']:,.2f} | {p['unrealized_plpc']:+.2f}% "
            f"| ${stop_price:,.2f} |\n"
        )
    if not positions_table:
        positions_table = "| — | — | — | — | — | — |\n"

    # Performance
    daily_pnl = perf.get("daily_pnl", 0)
    daily_pnl_pct = perf.get("daily_pnl_pct", 0)
    weekly_pnl = perf.get("weekly_pnl", 0)
    weekly_pnl_pct = perf.get("weekly_pnl_pct", 0)
    monthly_pnl = perf.get("monthly_pnl", 0)
    monthly_pnl_pct = perf.get("monthly_pnl_pct", 0)
    equity = perf.get("equity", 0)
    cash = perf.get("cash", 0)
    cash_pct = perf.get("cash_pct", 0)
    risk_tier = perf.get("risk_tier", "NORMAL")

    # Alpha vs SPY
    if isinstance(spy_monthly, (int, float)):
        alpha = monthly_pnl_pct - spy_monthly
        alpha_str = f"{alpha:+.2f}%"
        spy_month_str = f"{spy_monthly:+.2f}%"
    else:
        alpha_str = "N/A"
        spy_month_str = "N/A"

    journal = f"""# Trading Journal — {today}

## Market Conditions
- SPY: {spy_price_str} (5d: {spy_5d_str})
- Market Regime: {spy_regime}
- Risk Tier: {risk_tier}

## Research Summary
- Scanned {total_scanned} watchlist symbols + {len(screener_scored)} screener candidates
- Top candidates: {top_str}

## Trades Executed
| Time | Symbol | Side | Qty | Price | Reason |
|------|--------|------|-----|-------|--------|
| — | — | — | — | — | See execution logs |

## Open Positions
| Symbol | Qty | Avg Cost | Current | P&L % | Stop |
|--------|-----|----------|---------|--------|------|
{positions_table}
## Performance
- Day P&L: ${daily_pnl:,.2f} ({daily_pnl_pct:+.2f}%)
- Week P&L: ${weekly_pnl:,.2f} ({weekly_pnl_pct:+.2f}%)
- Month P&L: ${monthly_pnl:,.2f} ({monthly_pnl_pct:+.2f}%)
- SPY Month: {spy_month_str}
- **Alpha**: {alpha_str}
- Portfolio Equity: ${equity:,.2f}
- Cash: ${cash:,.2f} ({cash_pct:.1f}%)

## Reflection
- Positions: {len(positions)} open
- Risk tier: {risk_tier}
- Generated automatically by GitHub Actions
"""

    # Write journal file
    journal_path = JOURNAL_DIR / f"{today}.md"
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    with open(journal_path, "w") as f:
        f.write(journal)

    log.info(f"Journal written to {journal_path}")
    return str(journal_path)


def write_weekly_review() -> str:
    """Generate weekly review summarizing the trading week."""
    today = get_today_str()
    log.info(f"Writing weekly review for week ending {today}...")

    perf = load_json(PERFORMANCE_STATE)
    positions_data = load_json(POSITIONS_STATE)
    research = load_json(RESEARCH_STATE)

    # Weekly metrics
    weekly_pnl = perf.get("weekly_pnl", 0)
    weekly_pnl_pct = perf.get("weekly_pnl_pct", 0)
    monthly_pnl = perf.get("monthly_pnl", 0)
    monthly_pnl_pct = perf.get("monthly_pnl_pct", 0)
    equity = perf.get("equity", 0)
    risk_tier = perf.get("risk_tier", "NORMAL")

    # SPY comparison
    spy = research.get("spy", {})
    spy_monthly = spy.get("monthly_return", 0)
    spy_5d = spy.get("five_day_return", 0)

    # Grade the week
    if weekly_pnl_pct >= 3:
        grade = "A"
    elif weekly_pnl_pct >= 1:
        grade = "B"
    elif weekly_pnl_pct >= 0:
        grade = "C"
    elif weekly_pnl_pct >= -2:
        grade = "D"
    else:
        grade = "F"

    # Alpha
    alpha_weekly = weekly_pnl_pct - (spy_5d if isinstance(spy_5d, (int, float)) else 0)
    alpha_monthly = monthly_pnl_pct - (spy_monthly if isinstance(spy_monthly, (int, float)) else 0)

    # Daily history for the week
    history = perf.get("daily_history", [])
    week_history = history[-5:] if len(history) >= 5 else history

    daily_breakdown = ""
    for entry in week_history:
        daily_breakdown += f"| {entry.get('date', 'N/A')} | ${entry.get('pnl', 0):,.2f} | {entry.get('pnl_pct', 0):+.2f}% | ${entry.get('equity', 0):,.2f} |\n"

    positions = positions_data.get("positions", [])

    review = f"""# Weekly Review — Week Ending {today}

## Grade: {grade}

## Performance Summary
| Metric | Value |
|--------|-------|
| Weekly P&L | ${weekly_pnl:,.2f} ({weekly_pnl_pct:+.2f}%) |
| Monthly P&L | ${monthly_pnl:,.2f} ({monthly_pnl_pct:+.2f}%) |
| SPY Weekly | {spy_5d:+.2f}% |
| SPY Monthly | {spy_monthly:+.2f}% |
| Weekly Alpha | {alpha_weekly:+.2f}% |
| Monthly Alpha | {alpha_monthly:+.2f}% |
| Equity | ${equity:,.2f} |
| Risk Tier | {risk_tier} |
| Open Positions | {len(positions)} |

## Daily Breakdown
| Date | P&L | P&L % | Equity |
|------|-----|-------|--------|
{daily_breakdown}
## Open Positions
"""
    for p in positions:
        review += f"- **{p['symbol']}**: {p['qty']:.0f} shares @ ${p['avg_entry_price']:,.2f} → ${p['current_price']:,.2f} ({p['unrealized_plpc']:+.2f}%)\n"
    if not positions:
        review += "- No open positions\n"

    review += f"""
## Lessons Learned
- Weekly grade: {grade}
- Risk tier: {risk_tier}
- Generated automatically by GitHub Actions weekly review

## Next Week Plan
- Continue monitoring watchlist for BUY signals (score >= 65)
- Check for earnings catalysts in upcoming week
- Review and adjust watchlist based on this week's performance
"""

    # Write to journal
    journal_path = JOURNAL_DIR / f"{today}-weekly-review.md"
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    with open(journal_path, "w") as f:
        f.write(review)

    # Append lesson to memory
    lessons_path = MEMORY_DIR / "lessons_learned.md"
    lessons_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lessons_path, "a") as f:
        f.write(f"\n## Week Ending {today}\n")
        f.write(f"- Grade: {grade} | Weekly: {weekly_pnl_pct:+.2f}% | Alpha: {alpha_weekly:+.2f}%\n")
        f.write(f"- Positions: {len(positions)} | Risk Tier: {risk_tier}\n")

    log.info(f"Weekly review written to {journal_path}")
    return str(journal_path)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "daily"

    if cmd == "daily":
        path = write_daily_journal()
        print(f"Daily journal written to {path}")

    elif cmd == "weekly":
        path = write_weekly_review()
        print(f"Weekly review written to {path}")

    else:
        print("Usage: python3 write_journal.py [daily|weekly]")
