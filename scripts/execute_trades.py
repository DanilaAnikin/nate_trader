"""Execute trades — reads research data and places BUY/SELL orders."""

import sys

from utils import (
    RESEARCH_STATE, SCREENER_STATE, PERFORMANCE_STATE,
    setup_logging, get_now_str, load_json, save_json,
    get_risk_tier,
)

log = setup_logging("execute_trades")


def get_buy_candidates() -> list[dict]:
    """Collect symbols with action=BUY and score >= 65 from research + screener."""
    candidates = []

    # From research.json (watchlist symbols)
    research = load_json(RESEARCH_STATE)
    for symbol, data in research.get("symbols", {}).items():
        if "error" in data:
            continue
        confidence = data.get("confidence", {})
        if confidence.get("action") == "BUY" and confidence.get("total", 0) >= 65:
            candidates.append({
                "symbol": symbol,
                "confidence": confidence,
                "technicals": data.get("technicals", {}),
                "source": "watchlist",
            })

    # From screener.json (discovered symbols)
    screener = load_json(SCREENER_STATE)
    for symbol, data in screener.get("scored_candidates", {}).items():
        if "error" in data:
            continue
        confidence = data.get("confidence", {})
        if confidence.get("action") == "BUY" and confidence.get("total", 0) >= 65:
            # Don't duplicate watchlist symbols
            if not any(c["symbol"] == symbol for c in candidates):
                candidates.append({
                    "symbol": symbol,
                    "confidence": confidence,
                    "technicals": data.get("technicals", {}),
                    "source": "screener",
                })

    # Sort by score descending
    candidates.sort(key=lambda c: c["confidence"].get("total", 0), reverse=True)
    return candidates


def get_sell_candidates() -> list[dict]:
    """Collect held positions with action=SELL (score < 40)."""
    from portfolio import get_positions

    candidates = []
    positions = get_positions()
    research = load_json(RESEARCH_STATE)

    for pos in positions:
        symbol = pos["symbol"]
        data = research.get("symbols", {}).get(symbol, {})
        if "error" in data or not data:
            continue
        confidence = data.get("confidence", {})
        if confidence.get("action") == "SELL" and confidence.get("total", 0) < 40:
            candidates.append({
                "symbol": symbol,
                "confidence": confidence,
                "position": pos,
                "reason": f"Score {confidence.get('total', 0)} < 40",
            })

    return candidates


def passes_five_question_checklist(candidate: dict) -> tuple[bool, list[str]]:
    """Run the 5-question checklist. Returns (all_pass, list_of_results)."""
    tech = candidate.get("technicals", {})
    confidence = candidate.get("confidence", {})
    results = []

    # 1. Trend — above 20-SMA AND 50-SMA
    above_20 = tech.get("above_sma20", False)
    above_50 = tech.get("above_sma50", False)
    trend_pass = bool(above_20 and above_50)
    results.append(f"{'PASS' if trend_pass else 'FAIL'}: Trend (above 20-SMA and 50-SMA)")

    # 2. Catalyst — news_score > 5 or perplexity_score > 10 indicates a catalyst
    news_score = confidence.get("news_score", 0)
    perplexity_score = confidence.get("perplexity_score", 0)
    catalyst_pass = news_score > 5 or perplexity_score > 10
    results.append(f"{'PASS' if catalyst_pass else 'FAIL'}: Catalyst (news={news_score}, perplexity={perplexity_score})")

    # 3. Volume — volume_ratio >= 1.2
    vol_ratio = tech.get("volume_ratio")
    volume_pass = vol_ratio is not None and vol_ratio >= 1.2
    results.append(f"{'PASS' if volume_pass else 'FAIL'}: Volume (ratio={vol_ratio:.2f})" if vol_ratio else f"FAIL: Volume (no data)")

    # 4. Relative strength — 5-day return > SPY 5-day return
    research = load_json(RESEARCH_STATE)
    spy_5d = research.get("spy", {}).get("five_day_return", 0)
    stock_5d = tech.get("five_day_return", 0)
    rs_pass = stock_5d > spy_5d
    results.append(f"{'PASS' if rs_pass else 'FAIL'}: Relative strength ({stock_5d:+.2f}% vs SPY {spy_5d:+.2f}%)")

    # 5. Confidence — total >= 65
    total = confidence.get("total", 0)
    conf_pass = total >= 65
    results.append(f"{'PASS' if conf_pass else 'FAIL'}: Confidence (score={total})")

    all_pass = trend_pass and catalyst_pass and volume_pass and rs_pass and conf_pass
    return all_pass, results


def execute_buys(dry_run: bool = False) -> list[dict]:
    """Execute BUY orders for qualifying candidates."""
    from trade import validate_order, place_limit_order, calculate_position_size
    from research import get_latest_quote
    from notify import send_trade_alert

    risk_tier = get_risk_tier()
    results = []

    if risk_tier == "HALT":
        log.warning("HALT mode — no new buys allowed")
        return [{"action": "HALT", "reason": "Risk tier is HALT — no new buys"}]

    # In CAUTIOUS mode, raise threshold to 75
    min_score = 75 if risk_tier == "CAUTIOUS" else 65

    candidates = get_buy_candidates()
    log.info(f"BUY candidates: {len(candidates)} (risk_tier={risk_tier}, min_score={min_score})")

    for candidate in candidates:
        symbol = candidate["symbol"]
        score = candidate["confidence"].get("total", 0)

        if score < min_score:
            log.info(f"  {symbol}: score {score} < {min_score} threshold — skipping")
            results.append({"symbol": symbol, "action": "SKIP", "reason": f"Score {score} < {min_score}"})
            continue

        # Run 5-question checklist
        passes, checklist = passes_five_question_checklist(candidate)
        log.info(f"  {symbol}: 5-question checklist {'PASS' if passes else 'FAIL'}")
        for check in checklist:
            log.info(f"    {check}")

        if not passes:
            results.append({"symbol": symbol, "action": "SKIP", "reason": "Failed 5-question checklist", "checklist": checklist})
            continue

        # Get current price for limit order
        try:
            quote = get_latest_quote(symbol)
            price = quote["ask"]  # buy at ask
            if price <= 0:
                price = quote["mid"]
        except Exception as e:
            log.error(f"  {symbol}: failed to get quote — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": f"Quote failed: {e}"})
            continue

        # Calculate position size
        qty = calculate_position_size(symbol, price)
        if qty <= 0:
            log.info(f"  {symbol}: position size is 0 — skipping")
            results.append({"symbol": symbol, "action": "SKIP", "reason": "Position size 0"})
            continue

        # Validate order
        validation = validate_order(symbol, qty, "buy", price)
        if not validation["valid"]:
            log.warning(f"  {symbol}: order rejected — {validation['reasons']}")
            results.append({"symbol": symbol, "action": "REJECTED", "reasons": validation["reasons"]})
            continue

        if dry_run:
            log.info(f"  {symbol}: DRY RUN — would BUY {qty} @ ${price:.2f}")
            results.append({"symbol": symbol, "action": "DRY_RUN", "qty": qty, "price": price, "score": score})
            continue

        # Place limit order (trailing stop placed later via sync_trailing_stops after fill)
        try:
            order = place_limit_order(symbol, qty, "buy", price)
            log.info(f"  {symbol}: BUY {qty} @ ${price:.2f} — order {order['id']}")

            # Notify
            send_trade_alert(symbol, "buy", qty, price, f"Score {score} | {candidate['source']}")

            results.append({
                "symbol": symbol,
                "action": "BUY",
                "qty": qty,
                "price": price,
                "score": score,
                "order_id": order["id"],
            })
        except Exception as e:
            log.error(f"  {symbol}: order failed — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})

    return results


def execute_sells(dry_run: bool = False) -> list[dict]:
    """Execute SELL orders for positions with score < 40."""
    from trade import close_position
    from notify import send_trade_alert

    results = []
    candidates = get_sell_candidates()
    log.info(f"SELL candidates: {len(candidates)}")

    for candidate in candidates:
        symbol = candidate["symbol"]
        pos = candidate["position"]
        reason = candidate["reason"]

        if dry_run:
            log.info(f"  {symbol}: DRY RUN — would SELL (close position)")
            results.append({"symbol": symbol, "action": "DRY_RUN_SELL", "reason": reason})
            continue

        try:
            result = close_position(symbol)
            log.info(f"  {symbol}: position closed — {result}")

            send_trade_alert(
                symbol, "sell", int(pos["qty"]),
                pos["current_price"], reason,
            )

            results.append({
                "symbol": symbol,
                "action": "SELL",
                "qty": pos["qty"],
                "price": pos["current_price"],
                "pnl_pct": pos["unrealized_plpc"],
                "reason": reason,
            })
        except Exception as e:
            log.error(f"  {symbol}: sell failed — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})

    return results


def execute_time_stops(dry_run: bool = False) -> list[dict]:
    """Close positions held > 10 trading days without 5%+ gain."""
    from trade import close_position
    from portfolio import get_positions
    from notify import send_trade_alert

    results = []
    positions = get_positions()
    perf = load_json(PERFORMANCE_STATE)
    history = perf.get("daily_history", [])

    # We track by checking if position P&L < 5% — actual entry date tracking
    # would need Alpaca order history. For now, check positions with low gains.
    # This is a simplified heuristic: if num trading days tracked >= 10 and gain < 5%
    if len(history) < 10:
        return results

    for pos in positions:
        pnl_pct = pos.get("unrealized_plpc", 0)
        if pnl_pct < 5.0:
            # Check if we have 10+ days of history with this position
            # For now log a warning — full implementation needs entry date tracking
            log.info(f"  {pos['symbol']}: held with {pnl_pct:+.2f}% gain — monitor for time stop")

    return results


def run_execution(dry_run: bool = False) -> dict:
    """Main execution routine — run all trade logic."""
    log.info(f"{'='*60}")
    log.info(f"TRADE EXECUTION — {get_now_str()}")
    log.info(f"{'='*60}")

    # 1. Execute stop-losses first
    from trade import execute_stop_losses, sync_trailing_stops
    stops = execute_stop_losses()
    if stops:
        log.info(f"Stop-losses triggered: {len(stops)}")

    # 1b. Sync trailing stops for filled positions missing them
    synced = sync_trailing_stops()
    if synced:
        log.info(f"Trailing stops synced: {len(synced)}")

    # 2. Execute sells (score < 40)
    sells = execute_sells(dry_run=dry_run)

    # 3. Execute buys (score >= 65, passes checklist)
    buys = execute_buys(dry_run=dry_run)

    # 4. Check time stops
    time_stops = execute_time_stops(dry_run=dry_run)

    # 5. Save portfolio state
    from portfolio import save_positions_state, update_performance_state
    save_positions_state()
    update_performance_state()

    result = {
        "timestamp": get_now_str(),
        "risk_tier": get_risk_tier(),
        "stop_losses": stops,
        "sells": sells,
        "buys": buys,
        "time_stops": time_stops,
        "dry_run": dry_run,
    }

    log.info(f"\nExecution summary:")
    log.info(f"  Stop-losses: {len(stops)}")
    log.info(f"  Sells: {len([s for s in sells if s.get('action') == 'SELL'])}")
    log.info(f"  Buys:  {len([b for b in buys if b.get('action') == 'BUY'])}")
    log.info(f"  Skips: {len([b for b in buys if b.get('action') == 'SKIP'])}")

    return result


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"

    if cmd == "run":
        result = run_execution(dry_run=False)
        print(f"\nExecution complete. Buys: {len(result['buys'])}, Sells: {len(result['sells'])}")

    elif cmd == "dry-run":
        result = run_execution(dry_run=True)
        print(f"\nDry run complete. Would buy: {len(result['buys'])}, Would sell: {len(result['sells'])}")
        for b in result["buys"]:
            reason = b.get('reason', f"qty={b.get('qty')} @ ${b.get('price', 0):.2f}")
            print(f"  {b['symbol']}: {b['action']} — {reason}")

    elif cmd == "candidates":
        buys = get_buy_candidates()
        sells = get_sell_candidates()
        print(f"\nBUY candidates ({len(buys)}):")
        for c in buys:
            print(f"  {c['symbol']}: score={c['confidence']['total']} ({c['source']})")
        print(f"\nSELL candidates ({len(sells)}):")
        for c in sells:
            print(f"  {c['symbol']}: {c['reason']}")

    else:
        print("Usage: python3 execute_trades.py [run|dry-run|candidates]")
