"""Execute trades — regime-adaptive momentum swing trading engine.

This module is the orchestration layer. It reads research + screener state,
applies the regime-adaptive 5-question checklist (from strategy_config), and
places limit orders with trailing stops. It also handles:

  • Scale-out profit taking (sell 50% at +N% gain, trail the rest)
  • Tightened stops once a position is in profit
  • Time stops (close positions held too long with no progress)
  • Real entry-date tracking via Alpaca order history
"""

import sys
from datetime import datetime, timedelta, timezone

from utils import (
    RESEARCH_STATE, SCREENER_STATE, PERFORMANCE_STATE,
    setup_logging, get_now_str, load_json, save_json,
    get_risk_tier,
)
from strategy_config import (
    get_strategy_params, get_market_regime, get_effective_threshold,
    get_bear_hedge_target_pct,
)

HEDGE_SYMBOL = "SH"  # ProShares Short S&P500 — 1× inverse, non-leveraged
HEDGE_REBALANCE_THRESHOLD_PCT = 2.0  # only act on hedge drift > 2% of equity

log = setup_logging("execute_trades")


# ─────────────────────────── candidate sourcing ───────────────────────────


def get_buy_candidates() -> list[dict]:
    """Collect symbols with action=BUY from research + screener.

    Threshold is no longer hard-coded — we take everything the scoring engine
    marked as BUY, plus anything within 3 points below threshold (to allow
    regime-adaptive borderlines). Final filter happens in execute_buys.
    """
    candidates = []

    research = load_json(RESEARCH_STATE)
    for symbol, data in research.get("symbols", {}).items():
        if "error" in data:
            continue
        confidence = data.get("confidence", {})
        total = confidence.get("total", 0)
        threshold = confidence.get("threshold_used", 55)
        # Include BUY and near-BUY (within 3 of threshold) for cash-deployment logic
        if confidence.get("action") == "BUY" or total >= threshold - 3:
            candidates.append({
                "symbol": symbol,
                "confidence": confidence,
                "technicals": data.get("technicals", {}),
                "source": "watchlist",
            })

    screener = load_json(SCREENER_STATE)
    for symbol, data in screener.get("scored_candidates", {}).items():
        if "error" in data:
            continue
        confidence = data.get("confidence", {})
        total = confidence.get("total", 0)
        threshold = confidence.get("threshold_used", 55)
        if confidence.get("action") == "BUY" or total >= threshold - 3:
            if not any(c["symbol"] == symbol for c in candidates):
                candidates.append({
                    "symbol": symbol,
                    "confidence": confidence,
                    "technicals": data.get("technicals", {}),
                    "source": "screener",
                })

    candidates.sort(key=lambda c: c["confidence"].get("total", 0), reverse=True)
    return candidates


def get_sell_candidates() -> list[dict]:
    """Positions whose research action is SELL."""
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
        if confidence.get("action") == "SELL":
            candidates.append({
                "symbol": symbol,
                "confidence": confidence,
                "position": pos,
                "reason": f"Score {confidence.get('total', 0)} — action SELL",
            })

    return candidates


# ───────────────────────── weighted gate score ────────────────────────────

# Gate weights — relative importance of each signal for entry filtering
_GATE_WEIGHTS = {
    "trend": 0.30,      # Most important: price above key SMAs
    "catalyst": 0.15,   # Reduced from old: news/perplexity presence
    "volume": 0.15,     # Confirms institutional interest
    "rs": 0.25,         # Most important for alpha: beating SPY
    "confidence": 0.15, # Overall score threshold
}


def compute_gate_score(candidate: dict, regime: str | None = None,
                       risk_tier: str | None = None) -> tuple[float, list[str]]:
    """Weighted gate score replacing the old 5-question AND-gate.

    Returns (score: float 0.0-1.0, details: list[str]).
    Each check passes (1.0) or fails (0.0), weighted by importance.
    Gate score ≥ gate_score_min (regime-dependent) = proceed to buy.

    Earnings veto: if the symbol has a known earnings release within the
    next 5 trading days, applies a hard penalty (−0.20) regardless of
    the weighted score. Binary risk events have no edge for momentum.
    """
    from earnings_calendar import has_earnings_risk, days_until_earnings

    params = get_strategy_params(regime, risk_tier)
    tech = candidate.get("technicals", {})
    confidence = candidate.get("confidence", {})
    symbol = candidate.get("symbol", "")
    details = []
    checks = {}

    # 1) Trend — above 20-SMA AND 50-SMA
    above_20 = tech.get("above_sma20", False)
    above_50 = tech.get("above_sma50", False)
    trend_pass = bool(above_20 and above_50)
    checks["trend"] = 1.0 if trend_pass else (0.5 if above_20 else 0.0)
    details.append(f"{'PASS' if trend_pass else 'FAIL'}: Trend (>20SMA={above_20}, >50SMA={above_50})")

    # 2) Catalyst — news_score > 5 OR perplexity_score > 10
    news_score = confidence.get("news_score", 0)
    perplexity_score = confidence.get("perplexity_score", 0)
    catalyst_pass = news_score > 5 or perplexity_score > 10
    checks["catalyst"] = 1.0 if catalyst_pass else 0.0
    details.append(f"{'PASS' if catalyst_pass else 'FAIL'}: Catalyst (news={news_score}, px={perplexity_score})")

    # 3) Volume — regime-adaptive ratio
    vol_ratio = tech.get("volume_ratio")
    vol_min = params["volume_min_ratio"]
    volume_pass = vol_ratio is not None and vol_ratio >= vol_min
    checks["volume"] = 1.0 if volume_pass else 0.0
    if vol_ratio is not None:
        details.append(f"{'PASS' if volume_pass else 'FAIL'}: Volume (ratio={vol_ratio:.2f}, need ≥{vol_min:.2f})")
    else:
        details.append("FAIL: Volume (no data)")

    # 4) Relative strength — 20-day return vs SPY 20-day return
    research = load_json(RESEARCH_STATE)
    spy = research.get("spy", {})
    spy_20d = spy.get("twenty_day_return", spy.get("monthly_return", 0))
    stock_20d = tech.get("twenty_day_return", tech.get("five_day_return", 0))
    alpha_20d = stock_20d - spy_20d
    rs_pass = alpha_20d >= params["rs_alpha_min"]
    checks["rs"] = 1.0 if rs_pass else 0.0
    details.append(
        f"{'PASS' if rs_pass else 'FAIL'}: 20d alpha "
        f"({stock_20d:+.2f}% − SPY {spy_20d:+.2f}% = {alpha_20d:+.2f}%, need ≥{params['rs_alpha_min']:+.2f}%)"
    )

    # 5) Confidence — regime-adaptive threshold (effective, with cash-starve bonus)
    from portfolio import get_account
    try:
        acct = get_account()
        cash_pct = acct.get("cash_pct", 50.0)
    except Exception:
        cash_pct = 50.0
    threshold = get_effective_threshold(cash_pct, regime, risk_tier)
    total = confidence.get("total", 0)
    conf_pass = total >= threshold
    checks["confidence"] = 1.0 if conf_pass else 0.0
    details.append(f"{'PASS' if conf_pass else 'FAIL'}: Confidence (score={total}, need ≥{threshold})")

    # Weighted sum
    gate_score = sum(_GATE_WEIGHTS[k] * checks[k] for k in _GATE_WEIGHTS)

    # Earnings veto — apply AFTER weighted sum so it can drive a passing
    # score below the gate. Binary earnings risk has no edge for swing
    # momentum trading.
    try:
        if has_earnings_risk(symbol):
            er_days = days_until_earnings(symbol)
            gate_score -= 0.20
            details.append(f"VETO: Earnings in {er_days}d (−0.20 penalty)")
    except Exception as e:
        # Missing earnings calendar should never block trading
        details.append(f"(earnings calendar unavailable: {e})")

    gate_min = params.get("gate_score_min", 0.65)
    details.append(f"Gate score: {gate_score:.2f} (need ≥{gate_min:.2f})")

    return gate_score, details


# ─────────────────────────── entry tracking ───────────────────────────────


def _get_position_entry_date(symbol: str) -> datetime | None:
    """Best-effort entry date for a held position via Alpaca order history.

    Looks for the most recent filled BUY order for `symbol` and returns its
    filled_at timestamp. Returns None on failure (caller falls back to a
    conservative default).
    """
    try:
        from alpaca.trading.requests import GetOrdersRequest
        from alpaca.trading.enums import QueryOrderStatus, OrderSide
        from trade import client as trading_client

        end = datetime.now(timezone.utc)
        start = end - timedelta(days=90)
        req = GetOrdersRequest(
            status=QueryOrderStatus.CLOSED,
            symbols=[symbol],
            after=start,
            until=end,
            limit=50,
        )
        orders = trading_client.get_orders(filter=req)
        buy_fills = [
            o for o in orders
            if o.side == OrderSide.BUY and o.filled_at is not None
        ]
        if not buy_fills:
            return None
        buy_fills.sort(key=lambda o: o.filled_at, reverse=True)
        return buy_fills[0].filled_at
    except Exception as e:
        log.warning(f"  {symbol}: could not fetch entry date — {e}")
        return None


def _trading_days_between(start: datetime, end: datetime) -> int:
    """Approximate trading days between two datetimes (5/7 of calendar days)."""
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    cal_days = (end - start).days
    return max(0, int(cal_days * 5 / 7))


# ─────────────────────────── buy / sell execution ─────────────────────────


def execute_buys(dry_run: bool = False) -> list[dict]:
    """Execute BUY orders for qualifying candidates."""
    from trade import validate_order, place_limit_order, calculate_position_size
    from research import get_latest_quote
    from notify import send_trade_alert
    from portfolio import get_account

    risk_tier = get_risk_tier()
    regime = get_market_regime()
    results = []

    if risk_tier == "HALT":
        log.warning("HALT mode — no new buys allowed")
        return [{"action": "HALT", "reason": "Risk tier is HALT — no new buys"}]

    try:
        acct = get_account()
        cash_pct = acct.get("cash_pct", 50.0)
    except Exception:
        cash_pct = 50.0

    min_score = get_effective_threshold(cash_pct, regime, risk_tier)
    candidates = get_buy_candidates()
    log.info(
        f"BUY candidates: {len(candidates)} | regime={regime} | risk={risk_tier} "
        f"| cash={cash_pct:.1f}% | threshold={min_score}"
    )

    gate_min = get_strategy_params(regime, risk_tier).get("gate_score_min", 0.65)

    for candidate in candidates:
        symbol = candidate["symbol"]
        score = candidate["confidence"].get("total", 0)

        if score < min_score:
            log.info(f"  {symbol}: score {score} < {min_score} threshold — skipping")
            results.append({"symbol": symbol, "action": "SKIP", "reason": f"Score {score} < {min_score}"})
            continue

        gate_score, gate_details = compute_gate_score(candidate, regime=regime, risk_tier=risk_tier)
        log.info(f"  {symbol}: gate score {gate_score:.2f} (need ≥{gate_min:.2f})")
        for detail in gate_details:
            log.info(f"    {detail}")

        if gate_score < gate_min:
            results.append({"symbol": symbol, "action": "SKIP",
                            "reason": f"Gate score {gate_score:.2f} < {gate_min:.2f}",
                            "gate_details": gate_details})
            continue

        try:
            quote = get_latest_quote(symbol)
            price = quote["ask"]
            if price <= 0:
                price = quote["mid"]
        except Exception as e:
            log.error(f"  {symbol}: failed to get quote — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": f"Quote failed: {e}"})
            continue

        atr = candidate.get("technicals", {}).get("atr_14")
        qty = calculate_position_size(symbol, price, atr=atr)
        if qty <= 0:
            log.info(f"  {symbol}: position size is 0 — skipping")
            results.append({"symbol": symbol, "action": "SKIP", "reason": "Position size 0"})
            continue

        validation = validate_order(symbol, qty, "buy", price)
        if not validation["valid"]:
            log.warning(f"  {symbol}: order rejected — {validation['reasons']}")
            results.append({"symbol": symbol, "action": "REJECTED", "reasons": validation["reasons"]})
            continue

        if dry_run:
            log.info(f"  {symbol}: DRY RUN — would BUY {qty} @ ${price:.2f}")
            results.append({"symbol": symbol, "action": "DRY_RUN", "qty": qty, "price": price, "score": score})
            continue

        try:
            order = place_limit_order(symbol, qty, "buy", price)
            log.info(f"  {symbol}: BUY {qty} @ ${price:.2f} — order {order['id']}")
            send_trade_alert(symbol, "buy", qty, price, f"Score {score} | {candidate['source']} | {regime}")
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
    """Close positions with score < 40."""
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
            send_trade_alert(symbol, "sell", int(pos["qty"]), pos["current_price"], reason)
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


# ─────────────────────────── profit management ────────────────────────────


def execute_scale_outs(dry_run: bool = False) -> list[dict]:
    """Sell 50% of position at scale_out_at_gain%, take the rest at final_target_gain%.

    Idempotent: tracks scale-outs in state/performance.json under "scaled_out"
    so we don't double-sell the same position.
    """
    from portfolio import get_positions
    from trade import client as trading_client, place_limit_order
    from alpaca.trading.requests import LimitOrderRequest
    from alpaca.trading.enums import OrderSide, TimeInForce
    from notify import send_trade_alert

    params = get_strategy_params()
    scale_at = params["scale_out_at_gain"]
    final_at = params["final_target_gain"]

    perf = load_json(PERFORMANCE_STATE)
    # Track scale-outs as {symbol: qty_sold} for partial fill handling
    raw_scaled = perf.get("scaled_out", [])
    if isinstance(raw_scaled, list):
        # Migrate from old set format to dict
        scaled = {s: 999999 for s in raw_scaled}
    else:
        scaled = dict(raw_scaled)

    results = []
    positions = get_positions()
    for pos in positions:
        symbol = pos["symbol"]
        qty = int(pos["qty"])
        pnl_pct = pos["unrealized_plpc"]
        current_price = pos["current_price"]

        # Final target: close entire remaining position
        if pnl_pct >= final_at:
            log.info(f"  {symbol}: at +{pnl_pct:.2f}% — closing at final target +{final_at}%")
            if dry_run:
                results.append({"symbol": symbol, "action": "DRY_RUN_FINAL_TARGET", "pnl_pct": pnl_pct})
                continue
            try:
                limit_price = round(current_price * 0.999, 2)
                req = LimitOrderRequest(
                    symbol=symbol, qty=qty, side=OrderSide.SELL,
                    time_in_force=TimeInForce.DAY, limit_price=limit_price,
                )
                order = trading_client.submit_order(req)
                send_trade_alert(symbol, "sell", qty, current_price, f"Final target +{pnl_pct:.1f}%")
                results.append({
                    "symbol": symbol, "action": "FINAL_TARGET",
                    "qty": qty, "price": current_price, "order_id": str(order.id),
                })
                # Clear from scaled dict (position closed)
                scaled.pop(symbol, None)
            except Exception as e:
                log.error(f"  {symbol}: final target sell failed — {e}")
                results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})
            continue

        # Scale-out: half off at scale_at%, tracked by qty sold
        target_scale_qty = max(1, qty // 2)
        already_scaled = scaled.get(symbol, 0)
        if pnl_pct >= scale_at and already_scaled < target_scale_qty:
            sell_qty = target_scale_qty - already_scaled
            if sell_qty <= 0:
                continue
            log.info(f"  {symbol}: at +{pnl_pct:.2f}% — scaling out {sell_qty}/{qty} at +{scale_at}%")
            if dry_run:
                results.append({"symbol": symbol, "action": "DRY_RUN_SCALE_OUT",
                                "qty": sell_qty, "pnl_pct": pnl_pct})
                continue
            try:
                limit_price = round(current_price * 0.999, 2)
                req = LimitOrderRequest(
                    symbol=symbol, qty=sell_qty, side=OrderSide.SELL,
                    time_in_force=TimeInForce.DAY, limit_price=limit_price,
                )
                order = trading_client.submit_order(req)
                send_trade_alert(symbol, "sell", sell_qty, current_price, f"Scale-out 50% at +{pnl_pct:.1f}%")
                scaled[symbol] = already_scaled + sell_qty
                results.append({
                    "symbol": symbol, "action": "SCALE_OUT",
                    "qty": sell_qty, "price": current_price, "order_id": str(order.id),
                })
            except Exception as e:
                log.error(f"  {symbol}: scale-out failed — {e}")
                results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})

    # Persist scaled-out dict (only when not dry-run)
    if not dry_run:
        perf["scaled_out"] = scaled
        save_json(PERFORMANCE_STATE, perf)

    return results


def execute_time_stops(dry_run: bool = False) -> list[dict]:
    """Close positions held > time_stop_days without time_stop_min_gain.

    Uses Alpaca order history to determine real entry date. Falls back to
    skipping if entry date can't be determined.
    """
    from trade import close_position
    from portfolio import get_positions
    from notify import send_trade_alert

    params = get_strategy_params()
    max_days = params["time_stop_days"]
    min_gain = params["time_stop_min_gain"]

    results = []
    positions = get_positions()
    now = datetime.now(timezone.utc)

    for pos in positions:
        symbol = pos["symbol"]
        pnl_pct = pos["unrealized_plpc"]
        if pnl_pct >= min_gain:
            continue  # making enough progress — leave it alone

        entry = _get_position_entry_date(symbol)
        if entry is None:
            continue
        days_held = _trading_days_between(entry, now)
        if days_held < max_days:
            continue

        log.info(f"  {symbol}: time stop — held {days_held}d at {pnl_pct:+.2f}% (max {max_days}d / min +{min_gain}%)")
        if dry_run:
            results.append({"symbol": symbol, "action": "DRY_RUN_TIME_STOP",
                            "days_held": days_held, "pnl_pct": pnl_pct})
            continue
        try:
            result = close_position(symbol)
            send_trade_alert(symbol, "sell", int(pos["qty"]), pos["current_price"],
                             f"Time stop: {days_held}d @ {pnl_pct:+.1f}%")
            results.append({
                "symbol": symbol, "action": "TIME_STOP",
                "days_held": days_held, "pnl_pct": pnl_pct,
                "order_id": result.get("order_id"),
            })
        except Exception as e:
            log.error(f"  {symbol}: time-stop close failed — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})

    return results


def tighten_stops_in_profit(dry_run: bool = False) -> list[dict]:
    """Replace 8% trailing stops with tighter stop once position is meaningfully in profit.

    When pnl >= 5%, swap to tightened_stop_pct trail. Idempotent via tracking
    in performance state.
    """
    from portfolio import get_positions
    from trade import client as trading_client, place_trailing_stop
    from alpaca.trading.requests import GetOrdersRequest
    from alpaca.trading.enums import QueryOrderStatus, OrderType, OrderSide

    params = get_strategy_params()
    tight_pct = params["tightened_stop_pct"]
    trigger_gain = 5.0

    perf = load_json(PERFORMANCE_STATE)
    tightened = set(perf.get("tightened_stops", []))

    results = []
    positions = get_positions()
    if not positions:
        return results

    # Get current open trailing stops
    req = GetOrdersRequest(status=QueryOrderStatus.OPEN)
    open_orders = list(trading_client.get_orders(filter=req))
    stop_by_symbol = {
        o.symbol: o for o in open_orders
        if o.side == OrderSide.SELL and o.type == OrderType.TRAILING_STOP
    }

    for pos in positions:
        symbol = pos["symbol"]
        pnl_pct = pos["unrealized_plpc"]
        qty = int(pos["qty"])

        if pnl_pct < trigger_gain:
            continue
        if symbol in tightened:
            continue

        existing = stop_by_symbol.get(symbol)
        existing_trail = float(existing.trail_percent) if existing and existing.trail_percent else 8.0
        if existing_trail <= tight_pct + 0.1:
            tightened.add(symbol)
            continue

        log.info(f"  {symbol}: at +{pnl_pct:.2f}% — tightening stop from {existing_trail:.1f}% to {tight_pct:.1f}%")
        if dry_run:
            results.append({"symbol": symbol, "action": "DRY_RUN_TIGHTEN",
                            "from": existing_trail, "to": tight_pct})
            continue
        try:
            if existing:
                trading_client.cancel_order_by_id(existing.id)
            new_stop = place_trailing_stop(symbol, qty, trail_percent=tight_pct)
            tightened.add(symbol)
            results.append({"symbol": symbol, "action": "TIGHTEN",
                            "trail_pct": tight_pct, "order_id": new_stop["id"]})
        except Exception as e:
            log.error(f"  {symbol}: tighten stop failed — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})

    if not dry_run:
        # Keep only symbols we still hold
        held = {p["symbol"] for p in positions}
        perf["tightened_stops"] = sorted(s for s in tightened if s in held)
        save_json(PERFORMANCE_STATE, perf)

    return results


# ────────────────────────── bear hedge management ────────────────────────


def manage_bear_hedge(dry_run: bool = False) -> list[dict]:
    """Maintain SH (inverse SPY) position at the regime-driven target %.

    Behavior:
      • Target 0%, have SH       → close entire SH position
      • Target N%, have 0 SH     → buy SH to reach target (if delta > 2% equity)
      • Target N%, have X% SH    → top-up if X << N, trim if X >> N (>2% drift)
      • Target N%, have X ≈ N    → no-op

    Runs BEFORE execute_buys in the routine so cash is reserved for the hedge
    before directional buys consume it.

    The hedge is exempt from the 5-question checklist, sector cap, max-positions
    cap, and the HALT new-buys block (see validate_order).
    """
    from portfolio import get_positions, get_account
    from research import get_latest_quote
    from trade import place_limit_order, close_position, validate_order
    from notify import send_trade_alert

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    target_pct = get_bear_hedge_target_pct(regime, risk_tier)

    try:
        acct = get_account()
    except Exception as e:
        log.error(f"Hedge: failed to get account — {e}")
        return [{"action": "ERROR", "reason": f"account fetch: {e}"}]

    equity = acct.get("equity", 0.0)
    if equity <= 0:
        return []

    positions = get_positions()
    sh_pos = next((p for p in positions if p["symbol"] == HEDGE_SYMBOL), None)
    sh_value = sh_pos["market_value"] if sh_pos else 0.0
    sh_pct = (sh_value / equity * 100.0) if equity > 0 else 0.0

    target_value = equity * (target_pct / 100.0)
    delta_value = target_value - sh_value
    delta_pct = abs(delta_value) / equity * 100.0 if equity > 0 else 0.0

    log.info(
        f"Hedge: regime={regime} tier={risk_tier} target={target_pct:.1f}% "
        f"current={sh_pct:.1f}% delta={delta_value:+,.0f} ({delta_pct:.1f}%)"
    )

    # Case 1: target is 0 — fully exit any existing hedge
    if target_pct == 0.0 and sh_pos:
        log.info(f"  Closing SH ({sh_pos['qty']:.0f} sh @ ${sh_pos['current_price']:.2f}) — regime no longer warrants hedge")
        if dry_run:
            return [{"symbol": HEDGE_SYMBOL, "action": "DRY_RUN_HEDGE_EXIT",
                     "qty": sh_pos["qty"], "value": sh_value}]
        try:
            result = close_position(HEDGE_SYMBOL)
            send_trade_alert(
                HEDGE_SYMBOL, "sell", int(sh_pos["qty"]), sh_pos["current_price"],
                f"Hedge exit ({regime}/{risk_tier})",
            )
            return [{"symbol": HEDGE_SYMBOL, "action": "HEDGE_EXIT",
                     "qty": sh_pos["qty"], **result}]
        except Exception as e:
            log.error(f"  Hedge exit failed — {e}")
            return [{"symbol": HEDGE_SYMBOL, "action": "ERROR", "reason": str(e)}]

    # Case 2: not enough drift to bother (avoid commission churn on real account)
    if delta_pct < HEDGE_REBALANCE_THRESHOLD_PCT:
        return []

    # Case 3: need to ADD hedge (delta positive = buy more SH)
    if delta_value > 0:
        try:
            quote = get_latest_quote(HEDGE_SYMBOL)
            price = quote["ask"] if quote["ask"] > 0 else quote["mid"]
        except Exception as e:
            log.error(f"  Hedge: quote failed — {e}")
            return [{"symbol": HEDGE_SYMBOL, "action": "ERROR", "reason": f"quote: {e}"}]

        qty = int(delta_value / price)
        if qty < 1:
            return []

        validation = validate_order(HEDGE_SYMBOL, qty, "buy", price)
        if not validation["valid"]:
            log.warning(f"  Hedge order rejected: {validation['reasons']}")
            return [{"symbol": HEDGE_SYMBOL, "action": "REJECTED",
                     "reasons": validation["reasons"]}]

        if dry_run:
            log.info(f"  DRY RUN — would BUY {qty} SH @ ${price:.2f} (${qty * price:,.0f})")
            return [{"symbol": HEDGE_SYMBOL, "action": "DRY_RUN_HEDGE_BUY",
                     "qty": qty, "price": price, "target_pct": target_pct}]

        try:
            order = place_limit_order(HEDGE_SYMBOL, qty, "buy", price)
            send_trade_alert(
                HEDGE_SYMBOL, "buy", qty, price,
                f"Bear hedge → {target_pct:.0f}% target ({regime}/{risk_tier})",
            )
            log.info(f"  HEDGE BUY {qty} SH @ ${price:.2f} (order {order['id']})")
            return [{"symbol": HEDGE_SYMBOL, "action": "HEDGE_BUY",
                     "qty": qty, "price": price, "target_pct": target_pct,
                     "order_id": order["id"]}]
        except Exception as e:
            log.error(f"  Hedge BUY failed — {e}")
            return [{"symbol": HEDGE_SYMBOL, "action": "ERROR", "reason": str(e)}]

    # Case 4: need to TRIM hedge (current SH > target by > 2% of equity)
    if delta_value < 0 and sh_pos:
        try:
            quote = get_latest_quote(HEDGE_SYMBOL)
            price = quote["bid"] if quote["bid"] > 0 else quote["mid"]
        except Exception as e:
            log.error(f"  Hedge: quote failed — {e}")
            return [{"symbol": HEDGE_SYMBOL, "action": "ERROR", "reason": f"quote: {e}"}]

        trim_qty = int(abs(delta_value) / price)
        if trim_qty < 1:
            return []
        trim_qty = min(trim_qty, int(sh_pos["qty"]))  # don't oversell

        if dry_run:
            log.info(f"  DRY RUN — would TRIM {trim_qty} SH @ ${price:.2f}")
            return [{"symbol": HEDGE_SYMBOL, "action": "DRY_RUN_HEDGE_TRIM",
                     "qty": trim_qty, "price": price, "target_pct": target_pct}]

        try:
            order = place_limit_order(HEDGE_SYMBOL, trim_qty, "sell", round(price * 0.999, 2))
            send_trade_alert(
                HEDGE_SYMBOL, "sell", trim_qty, price,
                f"Trim hedge → {target_pct:.0f}% target ({regime}/{risk_tier})",
            )
            log.info(f"  HEDGE TRIM {trim_qty} SH @ ${price:.2f}")
            return [{"symbol": HEDGE_SYMBOL, "action": "HEDGE_TRIM",
                     "qty": trim_qty, "price": price, "target_pct": target_pct,
                     "order_id": order["id"]}]
        except Exception as e:
            log.error(f"  Hedge TRIM failed — {e}")
            return [{"symbol": HEDGE_SYMBOL, "action": "ERROR", "reason": str(e)}]

    return []


# ───────────────────────────── orchestration ──────────────────────────────


def run_execution(dry_run: bool = False) -> dict:
    """Main execution routine — full sequence of trade logic."""
    log.info(f"{'='*60}")
    log.info(f"TRADE EXECUTION — {get_now_str()}")
    log.info(f"{'='*60}")

    from trade import execute_stop_losses, sync_trailing_stops

    stops = execute_stop_losses()
    if stops:
        log.info(f"Stop-losses triggered: {len(stops)}")

    synced = sync_trailing_stops()
    if synced:
        log.info(f"Trailing stops synced: {len(synced)}")

    tightened = tighten_stops_in_profit(dry_run=dry_run)
    if tightened:
        log.info(f"Stops tightened: {len([t for t in tightened if t.get('action') == 'TIGHTEN'])}")

    scale_outs = execute_scale_outs(dry_run=dry_run)
    if scale_outs:
        log.info(f"Scale-out / target exits: {len(scale_outs)}")

    sells = execute_sells(dry_run=dry_run)

    # Hedge sizing runs BEFORE directional buys so it can claim cash first
    hedge = manage_bear_hedge(dry_run=dry_run)
    if hedge:
        log.info(f"Bear hedge actions: {len(hedge)}")

    buys = execute_buys(dry_run=dry_run)
    time_stops = execute_time_stops(dry_run=dry_run)

    from portfolio import save_positions_state, update_performance_state
    save_positions_state()
    update_performance_state()

    result = {
        "timestamp": get_now_str(),
        "regime": get_market_regime(),
        "risk_tier": get_risk_tier(),
        "stop_losses": stops,
        "tightened_stops": tightened,
        "scale_outs": scale_outs,
        "sells": sells,
        "hedge": hedge,
        "buys": buys,
        "time_stops": time_stops,
        "dry_run": dry_run,
    }

    log.info(f"\nExecution summary:")
    log.info(f"  Stop-losses: {len(stops)}")
    log.info(f"  Tightened:   {len([t for t in tightened if t.get('action') == 'TIGHTEN'])}")
    log.info(f"  Scale-outs:  {len([s for s in scale_outs if s.get('action') in ('SCALE_OUT', 'FINAL_TARGET')])}")
    log.info(f"  Sells:       {len([s for s in sells if s.get('action') == 'SELL'])}")
    log.info(f"  Buys:        {len([b for b in buys if b.get('action') == 'BUY'])}")
    log.info(f"  Time stops:  {len([t for t in time_stops if t.get('action') == 'TIME_STOP'])}")
    log.info(f"  Skips:       {len([b for b in buys if b.get('action') == 'SKIP'])}")

    return result


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"

    if cmd == "run":
        result = run_execution(dry_run=False)
        print(f"\nExecution complete. Buys: {len(result['buys'])}, Sells: {len(result['sells'])}")

    elif cmd == "dry-run":
        result = run_execution(dry_run=True)
        print(f"\nDry run — regime={result['regime']} | risk={result['risk_tier']}")
        hedge_target = get_bear_hedge_target_pct(result['regime'], result['risk_tier'])
        print(f"Hedge target: {hedge_target:.1f}% of equity in SH")
        print(f"Would buy: {len([b for b in result['buys'] if b.get('action') in ('DRY_RUN',)])} | "
              f"sell: {len([s for s in result['sells'] if s.get('action') == 'DRY_RUN_SELL'])} | "
              f"hedge: {len([h for h in result['hedge'] if 'DRY_RUN' in h.get('action', '')])} | "
              f"scale-out: {len([s for s in result['scale_outs'] if s.get('action') in ('DRY_RUN_SCALE_OUT', 'DRY_RUN_FINAL_TARGET')])} | "
              f"time-stop: {len([t for t in result['time_stops'] if t.get('action') == 'DRY_RUN_TIME_STOP'])}")
        for h in result["hedge"]:
            print(f"  {h['symbol']}: {h['action']} — qty={h.get('qty', '?')} target={h.get('target_pct', '?')}%")
        for b in result["buys"]:
            reason = b.get('reason', f"qty={b.get('qty')} @ ${b.get('price', 0):.2f} score={b.get('score')}")
            print(f"  {b['symbol']}: {b['action']} — {reason}")

    elif cmd == "midday":
        from trade import execute_stop_losses, sync_trailing_stops
        from portfolio import save_positions_state, update_performance_state

        print(f"\nMidday scan — {get_now_str()}")

        synced = sync_trailing_stops()
        if synced:
            print(f"Trailing stops synced: {len(synced)}")
        else:
            print("All positions have trailing stops.")

        tightened = tighten_stops_in_profit()
        if tightened:
            print(f"Stops tightened: {len([t for t in tightened if t.get('action') == 'TIGHTEN'])}")

        scale_outs = execute_scale_outs()
        if scale_outs:
            for r in scale_outs:
                print(f"  {r['symbol']}: {r['action']}")

        hedge = manage_bear_hedge()
        if hedge:
            for r in hedge:
                print(f"  HEDGE {r.get('action')}: {r.get('qty', '?')} {HEDGE_SYMBOL}")

        stops = execute_stop_losses()
        if stops:
            print(f"Stop-losses triggered: {len(stops)}")

        time_stops = execute_time_stops()
        if time_stops:
            print(f"Time stops: {len([t for t in time_stops if t.get('action') == 'TIME_STOP'])}")

        save_positions_state()
        update_performance_state()
        print("State saved.")

    elif cmd == "candidates":
        buys = get_buy_candidates()
        sells = get_sell_candidates()
        regime = get_market_regime()
        from portfolio import get_account
        try:
            cash_pct = get_account()["cash_pct"]
        except Exception:
            cash_pct = 50.0
        threshold = get_effective_threshold(cash_pct, regime)
        print(f"\nRegime: {regime} | Cash: {cash_pct:.1f}% | Effective threshold: {threshold}")
        print(f"\nBUY candidates ({len(buys)}):")
        for c in buys:
            t = c["confidence"].get("total", 0)
            print(f"  {c['symbol']}: score={t} ({c['source']}) {'✓BUY' if t >= threshold else '↘near'}")
        print(f"\nSELL candidates ({len(sells)}):")
        for c in sells:
            print(f"  {c['symbol']}: {c['reason']}")

    else:
        print("Usage: python3 execute_trades.py [run|dry-run|midday|candidates]")
