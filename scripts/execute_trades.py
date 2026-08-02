"""Execute trades — regime-adaptive momentum swing trading engine.

This module is the orchestration layer. It reads research + screener state,
applies the regime-adaptive 5-question checklist (from strategy_config), and
places limit orders with trailing stops. It also handles:

  • Scale-out profit taking (sell 50% at +N% gain, trail the rest)
  • Tightened stops once a position is in profit
  • Time stops (close positions held too long with no progress)
  • Real entry-date tracking via Alpaca order history
"""

import hashlib
import json
import math
import os
import sys
from contextvars import ContextVar
from datetime import datetime, timedelta, timezone

from utils import (
    RESEARCH_STATE, SCREENER_STATE, PERFORMANCE_STATE, STATE_DIR,
    setup_logging, get_now_str, load_json, load_json_object_status, save_json,
    get_risk_tier as _persisted_get_risk_tier,
)
from strategy_config import (
    get_strategy_params, get_market_regime, get_effective_threshold,
    get_bear_hedge_target_pct,
)

HEDGE_SYMBOL = "SH"  # ProShares Short S&P500 — 1× inverse, non-leveraged
HEDGE_REBALANCE_THRESHOLD_PCT = 2.0  # only act on hedge drift > 2% of equity
SPY_BASE_SYMBOL = "SPY"             # v4: long market beta core position
SSO_BASE_SYMBOL = "SSO"             # v7: 2× SPY leveraged BULL base
TQQQ_BASE_SYMBOL = "TQQQ"           # v10d: 3× QQQ leveraged BULL/NEUTRAL overlay
UPRO_BASE_SYMBOL = "UPRO"           # v10f: 3× SPY parallel sleeve, same SMA gate
BASE_REBALANCE_THRESHOLD_PCT = 2.0
# SPY/SSO are mutually-exclusive bases swapped in manage_base_position;
# TQQQ is a *parallel* overlay managed independently in
# manage_tqqq_position. Keep them apart so the SPY↔SSO swap loop
# doesn't accidentally close TQQQ.
BASE_CANDIDATES = (SPY_BASE_SYMBOL, SSO_BASE_SYMBOL)
V11_INFRASTRUCTURE_SYMBOLS = frozenset(
    {*BASE_CANDIDATES, TQQQ_BASE_SYMBOL, UPRO_BASE_SYMBOL, HEDGE_SYMBOL}
)
V11_VALIDATION_STATE = STATE_DIR / "backtest" / "v11_validation.json"
ADAPTIVE_PENDING_PLAN_KEY = "adaptive_rebalance_pending"
ADAPTIVE_RISK_OFF_LATCH_KEY = "adaptive_risk_off_latched"
_EXECUTION_RISK_TIER: ContextVar[str | None] = ContextVar(
    "execution_risk_tier", default=None
)


def _is_infrastructure(symbol: str) -> bool:
    """True iff `symbol` is a regime-driven infrastructure position (SPY/SSO
    base, TQQQ + UPRO overlays, SH hedge), exempt from trading mechanics
    like trail stops, scale-out, time stops, catalyst flips, and sector
    caps. v7/v10d/v10f."""
    return symbol in V11_INFRASTRUCTURE_SYMBOLS

log = setup_logging("execute_trades")


def get_risk_tier() -> str:
    """Return the immutable risk tier captured for this execution run."""

    snapshot_tier = _EXECUTION_RISK_TIER.get()
    return snapshot_tier or _persisted_get_risk_tier()


def _capture_execution_risk_snapshot() -> dict:
    """Compute today's tier with the shared rolling live/backtest policy."""

    try:
        raw_persisted = load_json(PERFORMANCE_STATE)
    except Exception:
        raw_persisted = {}
    fallback_tier = (
        raw_persisted.get("risk_tier", "NORMAL")
        if isinstance(raw_persisted, dict)
        else "NORMAL"
    )
    if fallback_tier not in {"NORMAL", "CAUTIOUS", "HALT"}:
        fallback_tier = "NORMAL"

    # The local performance file is not authoritative for same-run risk.  It
    # is used only if the broker account itself cannot be read; an absent or
    # malformed file must never prevent a fresh daily-loss HALT assessment.
    try:
        from portfolio import get_account, get_recent_equity_history
        from risk_policy import assess_portfolio_risk

        account = get_account()
        equity = float(account.get("equity", 0.0) or 0.0)
        last_equity = float(account.get("last_equity", 0.0) or 0.0)
        daily_assessment = assess_portfolio_risk(
            equity,
            previous_equity=last_equity,
            prior_equities=(),
        )
    except Exception as exc:
        return {
            "available": False,
            "tier": fallback_tier,
            "reason": f"current account risk snapshot unavailable: {exc}",
        }

    base_snapshot = {
        "tier": daily_assessment.tier,
        "equity": daily_assessment.current_equity,
        "last_equity": last_equity,
        "daily_pnl_pct": daily_assessment.daily_return_pct,
        "lookback_sessions": daily_assessment.lookback_sessions,
    }
    try:
        prior_equities = get_recent_equity_history(max_observations=22)
        assessment = assess_portfolio_risk(
            equity,
            previous_equity=last_equity,
            prior_equities=prior_equities,
        )
    except Exception as exc:
        return {
            **base_snapshot,
            "available": False,
            "rolling_peak_equity": None,
            "rolling_drawdown_pct": None,
            "reason": (
                "rolling broker history unavailable; fresh daily risk tier "
                f"preserved: {exc}"
            ),
        }
    return {
        **base_snapshot,
        "available": True,
        "tier": assessment.tier,
        "rolling_peak_equity": assessment.rolling_peak_equity,
        "rolling_drawdown_pct": assessment.rolling_drawdown_pct,
        "reason": "fresh broker account and rolling-history snapshot",
    }


def paper_trading_mode_enabled() -> bool:
    """True only when the operator explicitly opted into Alpaca paper mode."""
    return os.getenv("TRADING_MODE", "").strip().lower() == "paper"


def require_paper_trading_mode() -> None:
    """Refuse every money-mutating run unless paper mode is explicit.

    There is intentionally no accepted value for live-money trading.  The
    broker client in :mod:`trade` is also permanently constructed with
    ``paper=True`` as a second independent guard.
    """
    if not paper_trading_mode_enabled():
        raise RuntimeError(
            "Trading disabled: set TRADING_MODE=paper to run paper orders. "
            "Live-money mode is not supported."
        )


def _execution_client_order_id(
    purpose: str,
    symbol: str,
    side: str,
    execution_key: str | None = None,
    intent: str | None = None,
) -> str:
    """Deterministic idempotency key for one scheduled order intent."""
    from trade import build_client_order_id

    key = execution_key or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if intent:
        key = f"{key}|{intent}"
    return build_client_order_id(purpose, symbol, side, key)


_RETRYABLE_TERMINAL_ORDER_STATUSES = frozenset(
    {
        "canceled",
        "cancelled",
        "expired",
        "rejected",
        "replaced",
        "done_for_day",
    }
)


def _order_retry_disposition(status: object) -> str:
    """Classify an Alpaca lifecycle status for idempotent retry decisions."""

    normalized = str(status or "").strip().lower()
    if normalized == "filled":
        return "FILLED"
    if normalized in _RETRYABLE_TERMINAL_ORDER_STATUSES:
        return "RETRY"
    # Unknown, calculated, suspended, stopped, pending-cancel/replace, and
    # every active status block a second order. ``calculated`` can represent
    # a filled order awaiting settlement, so retrying from that status alone
    # could reverse a completed cover. Fail closed on every ambiguous state.
    return "ACTIVE_OR_UNKNOWN"


def _entry_gate_blocked() -> list[dict]:
    return [{
        "action": "ENTRY_GATE_BLOCKED",
        "reason": (
            "new exposure blocked by market-clock, risk, or validation gate; "
            "risk-reducing exits remain enabled"
        ),
    }]


def _v11_validation_gate() -> dict:
    """Read the fixed-strategy promotion artifact and fail closed.

    A PASS authorizes paper validation only.  Missing, malformed, or failed
    reports keep the strategy in dry-run/shadow mode; they never prevent
    risk-reducing cancellation, trim, or exit orders.
    """

    try:
        report = load_json(V11_VALIDATION_STATE)
    except Exception as exc:
        return {
            "passed": False,
            "status": "UNAVAILABLE",
            "allowed_mode": "dry-run/shadow-research-only",
            "reason": f"v11 validation artifact unavailable: {exc}",
            "contract_errors": [f"validation artifact read failed: {exc}"],
        }
    if not isinstance(report, dict):
        return {
            "passed": False,
            "status": "INVALID",
            "allowed_mode": "dry-run/shadow-research-only",
            "reason": "v11 validation artifact is not a JSON object",
            "contract_errors": ["top-level artifact must be an object"],
        }
    assessment = report.get("assessment")
    if not isinstance(assessment, dict):
        return {
            "passed": False,
            "status": "MISSING",
            "allowed_mode": "dry-run/shadow-research-only",
            "reason": "v11 validation assessment missing",
        }
    status = str(assessment.get("status", "MISSING")).upper()
    allowed_mode = str(
        assessment.get(
            "allowed_mode",
            "paper-validation-eligible"
            if status == "PASS"
            else "dry-run/shadow-research-only",
        )
    )
    contract_errors = []
    if report.get("schema_version") != 1:
        contract_errors.append("schema_version must be 1")
    if report.get("kind") != "v11_fixed_strategy_validation":
        contract_errors.append("unexpected validation kind")
    strategy = report.get("strategy")
    if not isinstance(strategy, dict) or strategy.get("version") != (
        "v11-adaptive-momentum"
    ):
        contract_errors.append("unexpected strategy version")
    recorded_identity = (
        strategy.get("identity") if isinstance(strategy, dict) else None
    )
    try:
        from adaptive_momentum import SECTOR_BENCHMARKS
        from backtest.data_provider import BarProvider
        from backtest.validate_v11 import validation_report_contract_errors
        from strategy_identity import (
            build_bar_snapshot_identity,
            build_strategy_identity,
            hash_symbol_universe,
        )
        from universe import load_universe_symbols

        contract_errors.extend(validation_report_contract_errors(report))

        current_identity = build_strategy_identity()
        if not isinstance(recorded_identity, dict):
            contract_errors.append("strategy identity missing")
        elif recorded_identity.get("value") != current_identity.get("value"):
            contract_errors.append("strategy identity does not match current code")
        evidence = report.get("evidence")
        recorded_universe_hash = (
            evidence.get("ranking_universe_sha256")
            if isinstance(evidence, dict)
            else None
        )
        current_universe_hash = hash_symbol_universe(
            load_universe_symbols(held_symbols=[])
        )
        if not isinstance(recorded_universe_hash, str):
            contract_errors.append("ranking universe evidence missing")
        elif recorded_universe_hash != current_universe_hash:
            contract_errors.append("ranking universe does not match validation")
        recorded_bar_hash = (
            evidence.get("bar_snapshot_sha256")
            if isinstance(evidence, dict)
            else None
        )
        through_date = (
            evidence.get("bar_snapshot_through_date")
            if isinstance(evidence, dict)
            else None
        )
        if not isinstance(recorded_bar_hash, str) or len(recorded_bar_hash) != 64:
            contract_errors.append("historical bar evidence missing")
        elif not isinstance(through_date, str) or not through_date:
            contract_errors.append("historical bar evidence boundary missing")
        else:
            current_bar_evidence = build_bar_snapshot_identity(
                BarProvider(),
                load_universe_symbols(held_symbols=[]),
                ("BIL", "SPY", *SECTOR_BENCHMARKS.values()),
                through_date=through_date,
            )
            if current_bar_evidence["bar_snapshot_sha256"] != recorded_bar_hash:
                contract_errors.append(
                    "historical bars do not match validation evidence"
                )
    except Exception as exc:
        contract_errors.append(f"current strategy evidence unavailable: {exc}")
    if allowed_mode != "paper-validation-eligible":
        contract_errors.append("allowed_mode is not paper-validation-eligible")
    passed = status == "PASS" and not contract_errors
    return {
        "passed": passed,
        "status": status,
        "allowed_mode": allowed_mode,
        "reason": (
            "v11 fixed-strategy validation passed for paper testing"
            if passed
            else (
                f"v11 validation status={status}; shadow-only"
                + (f" ({'; '.join(contract_errors)})" if contract_errors else "")
            )
        ),
        "contract_errors": contract_errors,
    }


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
        if _is_infrastructure(symbol):
            continue  # v4: SPY base / SH hedge are regime-driven, not score-driven
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
    from ablation_flags import ABLATE_EARNINGS_FILTER
    from earnings_calendar import has_earnings_risk as _has_er_real, days_until_earnings
    has_earnings_risk = (lambda *a, **kw: False) if ABLATE_EARNINGS_FILTER else _has_er_real

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

    # 4) Relative strength — 20-day return vs sector ETF (fallback: SPY).
    # Phase C of ALPHA_PLAN.md: sector-relative RS picks the leader within a
    # leading sector instead of any name that happened to ride the market.
    research = load_json(RESEARCH_STATE)
    spy = research.get("spy", {})
    spy_20d = spy.get("twenty_day_return", spy.get("monthly_return", 0))
    stock_20d = tech.get("twenty_day_return", tech.get("five_day_return", 0))
    sector_name = candidate.get("info", {}).get("sector") or candidate.get("sector")
    sector_state = load_json(STATE_DIR / "sector_strength.json") or {}
    sector_returns = sector_state.get("sector_returns") or {}
    sector_20d = sector_returns.get(sector_name) if sector_name else None
    rs_benchmark = sector_20d if sector_20d is not None else spy_20d
    benchmark_label = (f"{sector_name}({sector_20d:+.2f}%)"
                       if sector_20d is not None
                       else f"SPY {spy_20d:+.2f}%")
    alpha_20d = stock_20d - rs_benchmark
    rs_pass = alpha_20d >= params["rs_alpha_min"]
    checks["rs"] = 1.0 if rs_pass else 0.0
    details.append(
        f"{'PASS' if rs_pass else 'FAIL'}: 20d alpha "
        f"({stock_20d:+.2f}% − {benchmark_label} = {alpha_20d:+.2f}%, "
        f"need ≥{params['rs_alpha_min']:+.2f}%)"
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


def execute_buys(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
    """Execute BUY orders for qualifying candidates.

    In v6 momentum_mode this short-circuits — the monthly momentum
    rebalance handled by `manage_momentum_picks()` is the canonical buy
    path. We keep the legacy score-driven loop in place so an explicit
    override (`momentum_mode: False`) falls back cleanly.
    """
    from trade import validate_order, place_limit_order, calculate_position_size
    from research import get_latest_quote
    from notify import send_trade_alert
    from portfolio import get_account

    risk_tier = get_risk_tier()
    regime = get_market_regime()
    results = []

    if not allow_new_exposure:
        log.warning("Score-driven buys skipped by market entry gate")
        return _entry_gate_blocked()

    if risk_tier == "HALT":
        log.warning("HALT mode — no new buys allowed")
        return [{"action": "HALT", "reason": "Risk tier is HALT — no new buys"}]

    params = get_strategy_params(regime, risk_tier)
    if params.get("momentum_mode", False):
        log.info(f"{regime}/{risk_tier}: execute_buys skipped — momentum_mode "
                 "uses manage_momentum_picks() instead.")
        return [{"action": "SKIP", "reason": "momentum_mode active — see manage_momentum_picks"}]

    if params.get("block_new_buys"):
        log.info(f"{regime}/{risk_tier}: new directional buys blocked by strategy_config "
                 "(v3 — sells, scale-outs and hedge still active).")
        return [{"action": "BLOCK", "reason": f"{regime}/{risk_tier} blocks new buys (v3)"}]

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

    gate_min = params.get("gate_score_min", 0.65)

    for candidate in candidates:
        symbol = candidate["symbol"]
        score = candidate["confidence"].get("total", 0)

        if score < min_score:
            log.info(f"  {symbol}: score {score} < {min_score} threshold — skipping")
            results.append({"symbol": symbol, "action": "SKIP", "reason": f"Score {score} < {min_score}"})
            continue

        gate_score, gate_details = compute_gate_score(candidate, regime=regime, risk_tier=risk_tier)

        # Pre-market gap bonus — small lift if 9:35 ET scanner spotted a gap
        try:
            from run_gap_scanner import get_gap_bonus
            gap_bonus_pts = get_gap_bonus(symbol)
            if gap_bonus_pts > 0:
                # Convert score-points bonus to gate-score increment (~0.02 per pt)
                gap_lift = gap_bonus_pts * 0.02
                gate_score += gap_lift
                gate_details.append(f"BOOST: pre-market gap +{gap_bonus_pts}pts → +{gap_lift:.2f} gate")
        except Exception:
            pass

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
        vol_20d = candidate.get("technicals", {}).get("vol_20d_annualized_pct")
        qty = calculate_position_size(symbol, price, atr=atr, vol_20d_pct=vol_20d)
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
            order = place_limit_order(
                symbol,
                qty,
                "buy",
                price,
                client_order_id=_execution_client_order_id(
                    "score-buy", symbol, "buy"
                ),
            )
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
    """Close positions with score < 40 (legacy scoring path).

    v7 production: skipped when momentum_mode is on. The legacy scoring
    can mark momentum-picked positions as SELL (research.json scores are
    stale for momentum-mode picks), which would prematurely close winners
    that `manage_momentum_picks` would otherwise hold for the full month.
    Momentum-mode exits are managed by:
      • trail stops (ATR-based)
      • time stops (30 days, only if pnl < 0)
      • monthly momentum rebalance (drop-from-top-N)
      • flatten-on-confirmed-transition (BULL→NEUTRAL/BEAR)
    """
    from trade import close_position
    from notify import send_trade_alert

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    if params.get("momentum_mode", False):
        log.info(f"{regime}/{risk_tier}: execute_sells skipped — momentum_mode "
                 "manages exits via trail stops + monthly rebalance + flatten.")
        return [{"action": "SKIP", "reason": "momentum_mode active"}]

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
    from trade import place_limit_order
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
        if _is_infrastructure(symbol):
            continue  # v4: SPY base / SH hedge are regime-driven, not gain-driven
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
                order = place_limit_order(
                    symbol,
                    qty,
                    "sell",
                    limit_price,
                    client_order_id=_execution_client_order_id(
                        "final-target", symbol, "sell"
                    ),
                )
                send_trade_alert(symbol, "sell", qty, current_price, f"Final target +{pnl_pct:.1f}%")
                results.append({
                    "symbol": symbol, "action": "FINAL_TARGET",
                    "qty": qty, "price": current_price, "order_id": order["id"],
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
                order = place_limit_order(
                    symbol,
                    sell_qty,
                    "sell",
                    limit_price,
                    client_order_id=_execution_client_order_id(
                        "scale-out", symbol, "sell"
                    ),
                )
                send_trade_alert(symbol, "sell", sell_qty, current_price, f"Scale-out 50% at +{pnl_pct:.1f}%")
                scaled[symbol] = already_scaled + sell_qty
                results.append({
                    "symbol": symbol, "action": "SCALE_OUT",
                    "qty": sell_qty, "price": current_price, "order_id": order["id"],
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
    """Close positions held > time_stop_days **and** currently in the red.

    v3 rule: a flat/positive position is *not* a failed momentum trade —
    it just hasn't broken out yet. Only force-close losers; the trailing
    stop manages winners.

    Uses Alpaca order history to determine real entry date. Falls back to
    skipping if entry date can't be determined.
    """
    from trade import close_position
    from portfolio import get_positions
    from notify import send_trade_alert

    params = get_strategy_params()
    max_days = params["time_stop_days"]

    results = []
    positions = get_positions()
    now = datetime.now(timezone.utc)

    for pos in positions:
        symbol = pos["symbol"]
        if _is_infrastructure(symbol):
            continue  # v4
        pnl_pct = pos["unrealized_plpc"]
        # v3 rule: only close if held too long AND in the red
        if pnl_pct >= 0:
            continue

        entry = _get_position_entry_date(symbol)
        if entry is None:
            continue
        days_held = _trading_days_between(entry, now)
        if days_held < max_days:
            continue

        log.info(f"  {symbol}: time stop — held {days_held}d at {pnl_pct:+.2f}% (max {max_days}d, gate pnl<0)")
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
        if _is_infrastructure(symbol):
            continue  # v4: never auto-tighten the base / hedge
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


# ──────────── v11: adaptive monthly momentum rebalance ───────────


def _live_sector_lookup(provider, signal_date: str):
    """Return a cached static-or-price-inferred sector classifier."""

    from adaptive_momentum import infer_sector_from_returns
    from utils import get_symbol_info

    cache: dict[str, str] = {}

    def lookup(symbol: str) -> str:
        if symbol not in cache:
            sector = get_symbol_info(symbol).get("sector", "Unknown")
            if sector == "Unknown":
                sector = infer_sector_from_returns(provider, symbol, signal_date)
            cache[symbol] = sector
        return cache[symbol]

    lookup.cache = cache  # type: ignore[attr-defined]
    return lookup


def _adaptive_live_frames(
    symbols: list[str],
    *,
    minimum_auxiliary_bars: int = 253,
    maximum_auxiliary_age_days: int = 7,
    current_date: str | None = None,
):
    """Fetch one complete live snapshot for adaptive portfolio planning.

    Ranking stocks may legitimately be stale (for example, a trading halt),
    in which case ``analyze_symbol`` makes them ineligible.  SPY and every
    requested sector benchmark are signal auxiliaries, however, and must all
    represent the same latest completed session.  Missing response coverage
    or a mixed auxiliary date aborts planning instead of changing the target
    portfolio from a partial cross section.
    """

    from adaptive_momentum import FrameBarProvider, SECTOR_BENCHMARKS
    from research import BarCoverageError, get_bars_batch
    from utils import EDT

    today = current_date or datetime.now(EDT).strftime("%Y-%m-%d")
    requested = sorted({symbol.upper().strip() for symbol in symbols if symbol})
    provider = FrameBarProvider(
        get_bars_batch(requested, days=270, require_complete=True),
        before_date=today,
    )
    missing_completed = [
        symbol for symbol in requested if provider.latest_date(symbol) is None
    ]
    if missing_completed:
        raise BarCoverageError(
            "No completed daily bars for requested symbols: "
            + ", ".join(missing_completed)
        )

    requested_auxiliaries = sorted(
        set(requested) & ({"SPY"} | set(SECTOR_BENCHMARKS.values()))
    )
    if requested_auxiliaries:
        spy_date = provider.latest_date("SPY")
        if spy_date is None:
            raise BarCoverageError(
                "SPY is required to synchronize sector auxiliary bars"
            )
        try:
            auxiliary_age_days = (
                datetime.strptime(today, "%Y-%m-%d")
                - datetime.strptime(spy_date, "%Y-%m-%d")
            ).days
        except (TypeError, ValueError) as exc:
            raise BarCoverageError(
                f"Invalid completed-session date: SPY={spy_date!r}"
            ) from exc
        if auxiliary_age_days < 1 or auxiliary_age_days > maximum_auxiliary_age_days:
            raise BarCoverageError(
                "SPY completed-session bars are stale versus execution date: "
                f"SPY={spy_date}, execution_date={today}, "
                f"age_days={auxiliary_age_days}, "
                f"maximum={maximum_auxiliary_age_days}"
            )
        stale_auxiliaries = {
            symbol: provider.latest_date(symbol)
            for symbol in requested_auxiliaries
            if provider.latest_date(symbol) != spy_date
        }
        if stale_auxiliaries:
            details = ", ".join(
                f"{symbol}={latest or 'missing'}"
                for symbol, latest in stale_auxiliaries.items()
            )
            raise BarCoverageError(
                f"Sector auxiliary bars are stale versus SPY={spy_date}: {details}"
            )
        short_auxiliaries = {
            symbol: len(provider.bars_up_to(symbol, spy_date))
            for symbol in requested_auxiliaries
            if len(provider.bars_up_to(symbol, spy_date))
            < minimum_auxiliary_bars
        }
        if short_auxiliaries:
            details = ", ".join(
                f"{symbol}={count}" for symbol, count in short_auxiliaries.items()
            )
            raise BarCoverageError(
                "Insufficient completed history for signal auxiliaries "
                f"(required {minimum_auxiliary_bars} bars): {details}"
            )
    return provider


def _stale_held_ranking_symbols(
    provider,
    held_symbols: list[str],
    ranking_universe: list[str],
    signal_date: str,
) -> dict[str, str | None]:
    """Identify held ranking names whose last bar is behind the signal date.

    A stale non-held stock can safely become ineligible for a cross-sectional
    ranking.  Treating a held stock the same way would turn a transient
    per-symbol data outage into an unintended liquidation, so risk-on planning
    must pause until every held ranking constituent is current.  Held symbols
    that have left the tradable universe remain exit-only and are deliberately
    not covered by this check.
    """

    held_ranking = set(held_symbols) & set(ranking_universe)
    return {
        symbol: provider.latest_date(symbol)
        for symbol in sorted(held_ranking)
        if provider.latest_date(symbol) != signal_date
    }


def _held_ranking_history_errors(
    provider,
    held_symbols: list[str],
    ranking_universe: list[str],
    signal_date: str,
    *,
    required_bars: int,
) -> dict[str, str]:
    """Return current-date or history-length failures for held rankable names."""

    failures: dict[str, str] = {}
    for symbol in sorted(set(held_symbols) & set(ranking_universe)):
        latest = provider.latest_date(symbol)
        if latest != signal_date:
            failures[symbol] = f"latest={latest or 'missing'}"
            continue
        observed = len(
            provider.bars_up_to(
                symbol,
                signal_date,
                lookback_days=required_bars,
            )
        )
        if observed < required_bars:
            failures[symbol] = f"bars={observed}<{required_bars}"
    return failures


def _cancel_selected_orders_and_wait(
    selected: list[dict],
    *,
    dry_run: bool,
    reason: str,
    final_action: str = "REBALANCE_PENDING_CANCELLATIONS",
) -> list[dict]:
    """Cancel known orders, confirm their lifecycle, then stop this run."""

    from trade import cancel_open_order, list_open_orders

    if not selected:
        return []
    if dry_run:
        return [
            {
                "symbol": order.get("symbol"),
                "action": "DRY_RUN_CANCEL_OPEN_ORDER",
                "order_id": order.get("id"),
                "reason": reason,
            }
            for order in selected
        ]

    results: list[dict] = []
    selected_ids = {str(order.get("id", "")) for order in selected}
    failed = False
    for order in selected:
        order_id = str(order.get("id", ""))
        if not order_id:
            failed = True
            results.append(
                {
                    "symbol": order.get("symbol"),
                    "action": "ERROR",
                    "reason": f"{reason}: open order has no broker order ID",
                }
            )
            continue
        if order.get("status") == "pending_cancel":
            results.append(
                {
                    "symbol": order.get("symbol"),
                    "action": "PENDING_CANCELLATION",
                    "order_id": order_id,
                    "reason": reason,
                }
            )
            continue
        try:
            cancel_open_order(order_id)
            results.append(
                {
                    "symbol": order.get("symbol"),
                    "action": "CANCEL_REQUESTED",
                    "order_id": order_id,
                    "reason": reason,
                }
            )
        except Exception as exc:
            failed = True
            results.append(
                {
                    "symbol": order.get("symbol"),
                    "action": "ERROR",
                    "order_id": order_id,
                    "reason": f"{reason}: cancel failed: {exc}",
                }
            )
    if failed:
        return results
    try:
        confirmed = list_open_orders()
    except Exception as exc:
        results.append(
            {
                "action": "ABORT_CANCELLATION_CONFIRMATION",
                "reason": str(exc),
            }
        )
        return results
    remaining = sorted(
        str(order.get("id"))
        for order in confirmed
        if str(order.get("id")) in selected_ids
    )
    results.append(
        {
            "action": final_action,
            "remaining_order_ids": remaining,
            "reason": (
                "order cancellations still pending broker confirmation"
                if remaining
                else "order cancellations confirmed; refresh state before orders"
            ),
        }
    )
    return results


def _cancel_buy_orders_and_wait(
    open_orders: list[dict],
    *,
    dry_run: bool,
    reason: str,
    symbols: set[str] | frozenset[str] | None = None,
) -> list[dict]:
    """Cancel selected exposure-increasing orders and cross an invocation.

    This helper is intentionally usable before positions or SPY data are
    available.  A closed risk/validation gate must be able to neutralize stale
    BUY intent even when another read dependency has failed.
    """

    selected: list[dict] = []
    for order in open_orders:
        if order.get("side") != "buy":
            continue
        symbol = str(order.get("symbol", ""))
        if symbols is not None and symbol not in symbols:
            continue
        try:
            remaining = float(order.get("remaining_qty", 0.0) or 0.0)
        except (TypeError, ValueError):
            remaining = math.nan
        # An unknown/non-finite BUY quantity is not safe to leave working.
        if not math.isfinite(remaining) or remaining > 0:
            selected.append(order)
    return _cancel_selected_orders_and_wait(
        selected,
        dry_run=dry_run,
        reason=reason,
    )


def _cancel_all_orders_fail_closed(*, dry_run: bool, reason: str) -> list[dict]:
    """Emergency boundary when the broker order book cannot be normalized."""

    if dry_run:
        return [{"action": "DRY_RUN_CANCEL_ALL_ORDERS", "reason": reason}]
    try:
        from trade import cancel_all_orders

        cancel_all_orders()
    except Exception as exc:
        return [
            {
                "action": "ABORT_OPEN_ORDER_RECONCILIATION",
                "reason": f"{reason}; cancel-all failed: {exc}",
            }
        ]
    return [
        {
            "action": "CANCEL_ALL_ORDERS_REQUESTED",
            "reason": (
                f"{reason}; refresh the broker order book on a new invocation"
            ),
        }
    ]


def _cancel_v11_infrastructure_buys(*, dry_run: bool) -> list[dict]:
    """Cancel legacy zero-target BUYs before any migration sell can run."""

    from trade import list_open_orders

    try:
        open_orders = list_open_orders()
    except Exception as exc:
        return [
            {
                "action": "ABORT_OPEN_ORDER_RECONCILIATION",
                "reason": f"infrastructure BUY reconciliation: {exc}",
            }
        ]
    return _cancel_buy_orders_and_wait(
        open_orders,
        dry_run=dry_run,
        reason="V11 zero-target infrastructure migration",
        symbols=V11_INFRASTRUCTURE_SYMBOLS,
    )


def _reconcile_v11_open_buys_preflight(
    *,
    dry_run: bool,
    allow_new_exposure: bool,
) -> list[dict]:
    """Cancel unauthorized BUYs before any fallible legacy migration step.

    A still-working BUY is retained only when it belongs to the exact current
    frozen plan and every already-known exposure gate remains open.  Bound
    orders additionally recheck the daily SPY gate here, before infrastructure
    managers can fail while an obsolete BUY remains executable.
    """

    from adaptive_momentum import compute_market_state, config_from_params
    from trade import list_open_orders

    try:
        open_orders = list_open_orders()
    except Exception as exc:
        return _cancel_all_orders_fail_closed(
            dry_run=dry_run,
            reason=f"early V11 BUY reconciliation unavailable: {exc}",
        )

    active_buys: list[dict] = []
    for order in open_orders:
        if not isinstance(order, dict) or order.get("side") != "buy":
            continue
        try:
            remaining = float(order.get("remaining_qty", 0.0) or 0.0)
        except (TypeError, ValueError):
            remaining = math.nan
        if not math.isfinite(remaining) or remaining > 1e-9:
            active_buys.append(order)
    if not active_buys:
        return []

    try:
        perf, state_error = load_json_object_status(PERFORMANCE_STATE)
    except Exception as exc:
        perf, state_error = {}, f"unexpected state loader failure: {exc}"
    stored_plan = perf.get(ADAPTIVE_PENDING_PLAN_KEY)
    valid_plan = (
        stored_plan
        if _valid_adaptive_pending_plan(stored_plan)
        else None
    )
    risk_tier = get_risk_tier()
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")
    plan_gate_open = bool(
        allow_new_exposure
        and state_error is None
        and isinstance(valid_plan, dict)
        and not valid_plan.get("risk_off", False)
        and valid_plan.get("rebalance_month") == current_month
        and risk_tier != "HALT"
        and not (
            risk_tier == "CAUTIOUS"
            and valid_plan.get("construction_risk_tier") == "NORMAL"
        )
    )

    bound_buys = [
        order
        for order in active_buys
        if plan_gate_open
        and not _is_infrastructure(str(order.get("symbol", "")))
        and _adaptive_open_buy_belongs_to_plan(order, valid_plan)
    ]
    gate_reason = "open BUY is not authorized by the current frozen V11 plan"
    if bound_buys:
        try:
            params = get_strategy_params(get_market_regime(), risk_tier)
            cfg = config_from_params(params)
            provider = _adaptive_live_frames(["SPY"])
            signal_date = provider.latest_date("SPY")
            market = (
                compute_market_state(provider, signal_date, config=cfg)
                if signal_date
                else None
            )
        except Exception as exc:
            market = None
            gate_reason = f"SPY gate unavailable during early BUY audit: {exc}"
        if market is None:
            plan_gate_open = False
            if not gate_reason.startswith("SPY gate unavailable"):
                gate_reason = "SPY gate unavailable during early BUY audit"
        elif not market.above_sma200:
            plan_gate_open = False
            gate_reason = "SPY is below SMA200 during early BUY audit"

    selected = [
        order
        for order in active_buys
        if not plan_gate_open
        or _is_infrastructure(str(order.get("symbol", "")))
        or not _adaptive_open_buy_belongs_to_plan(order, valid_plan)
    ]
    return _cancel_selected_orders_and_wait(
        selected,
        dry_run=dry_run,
        reason=(
            f"early V11 BUY preflight: {state_error}"
            if state_error is not None
            else f"early V11 BUY preflight: {gate_reason}"
        ),
        final_action="V11_BUY_RECONCILIATION_PENDING_CANCELLATIONS",
    )


def _reserve_short_cover_client_order_id(
    symbol: str,
    quantity: float,
    *,
    max_attempts: int = 20,
) -> tuple[str | None, str]:
    """Resolve a retry-safe short-cover ID from broker terminal lifecycle."""

    from trade import get_order_by_client_order_id

    for attempt in range(1, max_attempts + 1):
        client_order_id = _execution_client_order_id(
            "v11-cover",
            symbol,
            "buy",
            intent=f"short-qty={quantity:.9f}|attempt={attempt}",
        )
        prior = get_order_by_client_order_id(client_order_id)
        if prior is None:
            return client_order_id, "READY"
        disposition = _order_retry_disposition(prior.get("status"))
        if disposition == "RETRY":
            continue
        if disposition == "FILLED":
            return None, "FILLED_AWAITING_POSITION_REFRESH"
        return None, "PENDING_ORDER"
    return None, "ATTEMPTS_EXHAUSTED"


def _reconcile_v11_short_positions(
    *,
    dry_run: bool,
    positions_snapshot: list[dict] | None = None,
    open_orders_snapshot: list[dict] | None = None,
) -> list[dict]:
    """Cover every short before any other V11 action can run.

    Safe pending BUY-to-cover orders are allowed to settle.  Every other open
    BUY and every order that could deepen a short is cancelled and confirmed
    across an invocation boundary.  Any unavailable or malformed broker state
    blocks the V11 engine rather than guessing that the account is flat.
    """

    from portfolio import get_positions
    from trade import close_position, list_open_orders

    def abort_untrusted_positions(reason: str) -> list[dict]:
        """Neutralize known BUY intent before returning on bad positions."""

        try:
            candidate_orders = (
                open_orders_snapshot
                if isinstance(open_orders_snapshot, list)
                else list_open_orders()
            )
        except Exception as exc:
            return _cancel_all_orders_fail_closed(
                dry_run=dry_run,
                reason=f"{reason}; open orders unavailable: {exc}",
            )
        valid_order_rows = [
            order for order in candidate_orders if isinstance(order, dict)
        ]
        cancellations = _cancel_selected_orders_and_wait(
            valid_order_rows,
            dry_run=dry_run,
            reason=f"untrusted broker position snapshot: {reason}",
            final_action="POSITION_SNAPSHOT_RECONCILIATION_PENDING_CANCELLATIONS",
        )
        return cancellations or [
            {
                "action": "ABORT_SHORT_RECONCILIATION",
                "reason": reason,
            }
        ]

    if positions_snapshot is None:
        try:
            positions = get_positions()
        except Exception as exc:
            return abort_untrusted_positions(f"positions unavailable: {exc}")
    else:
        positions = positions_snapshot
    if not isinstance(positions, list):
        return abort_untrusted_positions("positions response is not a list")

    shorts: dict[str, float] = {}
    position_quantities: dict[str, float] = {}
    for position in positions:
        if not isinstance(position, dict):
            return abort_untrusted_positions(
                "positions response contains a non-object row"
            )
        symbol = str(position.get("symbol", "")).upper()
        try:
            quantity = float(position.get("qty", 0.0) or 0.0)
        except (TypeError, ValueError):
            quantity = math.nan
        if not symbol or not math.isfinite(quantity):
            return abort_untrusted_positions(
                "position has missing symbol or non-finite quantity"
            )
        position_quantities[symbol] = quantity
        if quantity < -1e-9:
            shorts[symbol] = abs(quantity)

    if open_orders_snapshot is None:
        try:
            open_orders = list_open_orders()
        except Exception as exc:
            return _cancel_all_orders_fail_closed(
                dry_run=dry_run,
                reason=f"V11 order book unavailable: {exc}",
            )
    else:
        open_orders = open_orders_snapshot
    if not isinstance(open_orders, list):
        return [
            {
                "action": "ABORT_SHORT_RECONCILIATION",
                "short_symbols": sorted(shorts),
                "reason": "open-orders response is not a list",
            }
        ]

    # V11 is long-only: working SELL quantity may never exceed the trusted
    # positive position it can close.  Cancel all SELLs for an overcommitted
    # symbol because broker fill ordering is nondeterministic.
    sell_orders_by_symbol: dict[str, list[tuple[dict, float]]] = {}
    buy_orders_by_symbol: dict[str, list[tuple[dict, float]]] = {}
    invalid_order_rows: list[dict] = []
    malformed_order_row = False
    for order in open_orders:
        if not isinstance(order, dict):
            malformed_order_row = True
            continue
        symbol = str(order.get("symbol", "")).upper()
        side = str(order.get("side", "")).lower()
        try:
            remaining = float(order.get("remaining_qty", 0.0) or 0.0)
        except (TypeError, ValueError):
            remaining = math.nan
        if (
            not symbol
            or side not in {"buy", "sell"}
            or not math.isfinite(remaining)
            or remaining < 0
        ):
            invalid_order_rows.append(order)
            continue
        if side == "sell" and remaining > 1e-9:
            sell_orders_by_symbol.setdefault(symbol, []).append(
                (order, remaining)
            )
        elif side == "buy" and remaining > 1e-9:
            buy_orders_by_symbol.setdefault(symbol, []).append(
                (order, remaining)
            )
    if malformed_order_row:
        # Known rows cannot be trusted as a complete book when another row is
        # malformed; cancel everything identifiable and stop at a boundary.
        identifiable = [order for order in open_orders if isinstance(order, dict)]
        cancellations = _cancel_selected_orders_and_wait(
            identifiable,
            dry_run=dry_run,
            reason="open-orders response contains a non-object row",
            final_action="ORDER_BOOK_RECONCILIATION_PENDING_CANCELLATIONS",
        )
        return cancellations or [
            {
                "action": "ABORT_SHORT_RECONCILIATION",
                "reason": "open-orders response contains a non-object row",
            }
        ]

    sell_conflicts = list(invalid_order_rows)
    for symbol, rows in sell_orders_by_symbol.items():
        total_remaining = sum(remaining for _order, remaining in rows)
        long_capacity = max(0.0, position_quantities.get(symbol, 0.0))
        if total_remaining > long_capacity + 1e-9:
            sell_conflicts.extend(order for order, _remaining in rows)
    if sell_conflicts:
        safe_cover_symbols = {
            symbol
            for symbol, rows in buy_orders_by_symbol.items()
            if symbol in shorts
            and sum(remaining for _order, remaining in rows)
            <= shorts[symbol] + 1e-9
        }
        for symbol, rows in buy_orders_by_symbol.items():
            if symbol not in safe_cover_symbols:
                sell_conflicts.extend(order for order, _remaining in rows)
        return _cancel_selected_orders_and_wait(
            list({str(order.get("id")): order for order in sell_conflicts}.values()),
            dry_run=dry_run,
            reason=(
                "V11 long-only preflight: unknown, flat-symbol, or aggregate "
                "oversized SELL could create/increase a short"
            ),
            final_action="SELL_CAPACITY_RECONCILIATION_PENDING_CANCELLATIONS",
        )

    if not shorts:
        return []

    positive_remaining: list[tuple[dict, str, str, float | None]] = []
    buy_totals = {symbol: 0.0 for symbol in shorts}
    for order in open_orders:
        if not isinstance(order, dict):
            continue
        symbol = str(order.get("symbol", "")).upper()
        side = str(order.get("side", "")).lower()
        try:
            remaining = float(order.get("remaining_qty", 0.0) or 0.0)
        except (TypeError, ValueError):
            remaining = None
        if remaining is None or not math.isfinite(remaining) or remaining < 0:
            if side == "buy" or symbol in shorts:
                positive_remaining.append((order, symbol, side, None))
            continue
        if remaining <= 1e-9:
            continue
        positive_remaining.append((order, symbol, side, remaining))
        if side == "buy" and symbol in shorts:
            buy_totals[symbol] += remaining
    safe_cover_symbols = {
        symbol
        for symbol, total in buy_totals.items()
        if total > 1e-9 and total <= shorts[symbol] + 1e-9
    }
    conflicting_orders: list[dict] = []
    for order, symbol, side, remaining in positive_remaining:
        safe_cover = bool(
            remaining is not None
            and side == "buy"
            and symbol in safe_cover_symbols
        )
        if not safe_cover and (side == "buy" or symbol in shorts):
            conflicting_orders.append(order)
    if conflicting_orders:
        return _cancel_selected_orders_and_wait(
            conflicting_orders,
            dry_run=dry_run,
            reason=(
                "V11 short reconciliation: cancel non-cover BUY or "
                "short-increasing order"
            ),
            final_action="SHORT_RECONCILIATION_PENDING_CANCELLATIONS",
        )

    pending_covers = [
        (order, symbol, remaining)
        for order, symbol, side, remaining in positive_remaining
        if remaining is not None
        and side == "buy"
        and symbol in safe_cover_symbols
    ]
    if pending_covers:
        return [
            {
                "symbol": symbol,
                "action": "SHORT_COVER_PENDING",
                "side": "buy",
                "order_id": order.get("id"),
                "remaining_qty": remaining,
                "short_qty": shorts[symbol],
                "reason": "wait for cover fill and refresh positions",
            }
            for order, symbol, remaining in pending_covers
        ]

    if dry_run:
        return [
            {
                "symbol": symbol,
                "action": "DRY_RUN_SHORT_COVER",
                "side": "buy",
                "qty": _clean_order_qty(quantity),
                "reason": "all shorts must be flat before V11 trading",
            }
            for symbol, quantity in sorted(shorts.items())
        ]

    results: list[dict] = []
    for symbol, quantity in sorted(shorts.items()):
        try:
            client_order_id, lifecycle = _reserve_short_cover_client_order_id(
                symbol,
                quantity,
            )
        except Exception as exc:
            results.append(
                {
                    "symbol": symbol,
                    "side": "buy",
                    "action": "ABORT_SHORT_RECONCILIATION",
                    "reason": f"cover lifecycle unavailable: {exc}",
                }
            )
            continue
        if lifecycle != "READY" or client_order_id is None:
            results.append(
                {
                    "symbol": symbol,
                    "side": "buy",
                    "action": (
                        "SHORT_COVER_PENDING"
                        if lifecycle == "PENDING_ORDER"
                        else "ABORT_SHORT_RECONCILIATION"
                    ),
                    "reason": (
                        "prior cover is active; refresh positions before V11 trading"
                        if lifecycle == "PENDING_ORDER"
                        else (
                            "prior cover filled; refresh positions before V11 trading"
                            if lifecycle == "FILLED_AWAITING_POSITION_REFRESH"
                            else "short-cover retry attempts exhausted"
                        )
                    ),
                }
            )
            continue
        result = close_position(symbol, client_order_id=client_order_id)
        status = str(result.get("status", "error"))
        action = {
            "submitted": "SHORT_COVER_SUBMITTED",
            "pending": "SHORT_COVER_PENDING",
        }.get(status, "ABORT_SHORT_RECONCILIATION")
        results.append(
            {
                **result,
                "symbol": symbol,
                "side": "buy",
                "action": action,
                "reason": (
                    "cover order submitted; refresh positions before V11 trading"
                    if status == "submitted"
                    else (
                        "cover order already pending; refresh positions before V11 trading"
                        if status == "pending"
                        else result.get("error", f"unexpected close status={status}")
                    )
                ),
            }
        )
    return results


def _adaptive_plan_id(
    rebalance_month: str,
    signal_date: str | None,
    target_weights: dict[str, float],
    *,
    sector_by_symbol: dict[str, str],
    risk_off: bool,
    construction_risk_tier: str,
    eligible_count: int,
    strategy_identity_value: str,
    ranking_universe_sha256: str,
) -> str:
    """Stable identity for one immutable target portfolio."""

    payload = json.dumps(
        {
            "schema_version": 3,
            "month": rebalance_month,
            "signal_date": signal_date,
            "target_weights": {
                symbol: round(float(weight), 10)
                for symbol, weight in sorted(target_weights.items())
            },
            "sector_by_symbol": {
                str(symbol): str(sector)
                for symbol, sector in sorted(sector_by_symbol.items())
            },
            "risk_off": risk_off,
            "construction_risk_tier": construction_risk_tier,
            "eligible_count": eligible_count,
            "strategy_identity_value": strategy_identity_value,
            "ranking_universe_sha256": ranking_universe_sha256,
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _new_adaptive_pending_plan(
    *,
    rebalance_month: str,
    signal_date: str | None,
    target_weights: dict[str, float],
    sector_by_symbol: dict[str, str],
    risk_off: bool,
    eligible_count: int,
    construction_risk_tier: str,
) -> dict:
    from strategy_identity import build_strategy_identity, hash_symbol_universe
    from universe import load_universe_symbols

    normalized_targets = {
        str(symbol): float(weight)
        for symbol, weight in sorted(target_weights.items())
    }
    normalized_sectors = {
        str(symbol): str(sector)
        for symbol, sector in sorted(sector_by_symbol.items())
    }
    normalized_risk_tier = str(construction_risk_tier)
    normalized_eligible_count = int(eligible_count)
    strategy_identity_value = str(build_strategy_identity()["value"])
    ranking_universe_sha256 = hash_symbol_universe(
        load_universe_symbols(held_symbols=[])
    )
    return {
        "schema_version": 3,
        "plan_id": _adaptive_plan_id(
            rebalance_month,
            signal_date,
            normalized_targets,
            sector_by_symbol=normalized_sectors,
            risk_off=risk_off,
            construction_risk_tier=normalized_risk_tier,
            eligible_count=normalized_eligible_count,
            strategy_identity_value=strategy_identity_value,
            ranking_universe_sha256=ranking_universe_sha256,
        ),
        "rebalance_month": rebalance_month,
        "signal_date": signal_date,
        "target_weights": normalized_targets,
        "sector_by_symbol": normalized_sectors,
        "risk_off": bool(risk_off),
        "strategy_identity_value": strategy_identity_value,
        "ranking_universe_sha256": ranking_universe_sha256,
        "construction_risk_tier": normalized_risk_tier,
        "eligible_count": normalized_eligible_count,
        "created_at": get_now_str(),
        "order_attempts": {},
    }


def _adaptive_pending_plan_structure_valid(value) -> bool:
    """Validate persisted plan integrity without assuming current code identity."""

    if not isinstance(value, dict) or value.get("schema_version") != 3:
        return False
    if not isinstance(value.get("plan_id"), str) or not value["plan_id"]:
        return False
    if not isinstance(value.get("rebalance_month"), str):
        return False
    targets = value.get("target_weights")
    sectors = value.get("sector_by_symbol")
    attempts = value.get("order_attempts")
    risk_off = value.get("risk_off")
    strategy_identity_value = value.get("strategy_identity_value")
    ranking_universe_sha256 = value.get("ranking_universe_sha256")
    construction_risk_tier = value.get("construction_risk_tier")
    eligible_count = value.get("eligible_count")
    if not isinstance(targets, dict) or not isinstance(sectors, dict):
        return False
    if not isinstance(attempts, dict) or not isinstance(risk_off, bool):
        return False
    if not isinstance(strategy_identity_value, str) or not strategy_identity_value:
        return False
    if not isinstance(ranking_universe_sha256, str) or not ranking_universe_sha256:
        return False
    if construction_risk_tier not in {"NORMAL", "CAUTIOUS", "HALT"}:
        return False
    if type(eligible_count) is not int or eligible_count < 0:
        return False
    try:
        normalized_targets = {
            str(symbol): float(weight) for symbol, weight in targets.items()
        }
    except (TypeError, ValueError):
        return False
    if any(
        not math.isfinite(weight) or weight < 0.0 or weight > 1.0
        for weight in normalized_targets.values()
    ):
        return False
    if sum(normalized_targets.values()) > 1.000001:
        return False
    if any(not isinstance(symbol, str) or not symbol for symbol in targets):
        return False
    if any(
        not isinstance(symbol, str)
        or not isinstance(sector, str)
        or not sector
        for symbol, sector in sectors.items()
    ):
        return False
    if set(sectors) != set(normalized_targets):
        return False
    if eligible_count < len(normalized_targets):
        return False
    expected_plan_id = _adaptive_plan_id(
        value["rebalance_month"],
        value.get("signal_date"),
        normalized_targets,
        sector_by_symbol=sectors,
        risk_off=risk_off,
        construction_risk_tier=construction_risk_tier,
        eligible_count=eligible_count,
        strategy_identity_value=strategy_identity_value,
        ranking_universe_sha256=ranking_universe_sha256,
    )
    if value["plan_id"] != expected_plan_id:
        return False
    for intent_key, record in attempts.items():
        if not isinstance(intent_key, str) or not isinstance(record, dict):
            return False
        attempt = record.get("attempt")
        client_order_id = record.get("client_order_id")
        symbol = record.get("symbol")
        side = record.get("side")
        try:
            quantity = float(record.get("quantity"))
            target_weight = float(record.get("target_weight"))
        except (TypeError, ValueError):
            return False
        if type(attempt) is not int or attempt < 1:
            return False
        if not isinstance(client_order_id, str) or not client_order_id:
            return False
        if len(client_order_id) > 48:
            return False
        if (
            not isinstance(symbol, str)
            or not symbol
            or symbol != symbol.upper()
            or side not in {"buy", "sell"}
        ):
            return False
        if not math.isfinite(quantity) or quantity <= 0:
            return False
        if (
            not math.isfinite(target_weight)
            or target_weight < 0
            or target_weight > 1
        ):
            return False
        expected_intent_key = _adaptive_intent_key(
            value,
            symbol,
            side,
            quantity,
            target_weight,
        )
        if intent_key != expected_intent_key:
            return False
        expected_client_order_id = _execution_client_order_id(
            "adaptive",
            symbol,
            side,
            execution_key=str(value["plan_id"]),
            intent=f"{intent_key}|attempt={attempt}",
        )
        if client_order_id != expected_client_order_id:
            return False
        if side == "buy" and (
            symbol not in normalized_targets
            or not math.isclose(
                target_weight,
                normalized_targets[symbol],
                rel_tol=0.0,
                abs_tol=1e-12,
            )
        ):
            return False
    return True


def _adaptive_pending_plan_context_matches(value: dict) -> bool:
    """Bind an in-flight target to its exact code and ranking universe."""

    try:
        from strategy_identity import build_strategy_identity, hash_symbol_universe
        from universe import load_universe_symbols

        return (
            value.get("strategy_identity_value")
            == build_strategy_identity().get("value")
            and value.get("ranking_universe_sha256")
            == hash_symbol_universe(load_universe_symbols(held_symbols=[]))
        )
    except Exception:
        return False


def _valid_adaptive_pending_plan(value) -> bool:
    """Reject corrupt or code-stale plans before they can authorize a buy."""

    return _adaptive_pending_plan_structure_valid(
        value
    ) and _adaptive_pending_plan_context_matches(value)


def _clean_order_qty(quantity: float) -> int | float:
    """Preserve fractional liquidation quantities while keeping whole lots tidy."""

    rounded = round(float(quantity), 9)
    if abs(rounded - round(rounded)) < 1e-9:
        return int(round(rounded))
    return rounded


def _adaptive_portfolio_converged(
    positions: list[dict],
    target_weights: dict[str, float],
    equity: float,
    drift_value: float,
) -> bool:
    """True only when observed filled positions, not submissions, meet targets."""

    held = {
        position["symbol"]: position
        for position in positions
        if not _is_infrastructure(position["symbol"])
    }
    for symbol, position in held.items():
        quantity = float(position.get("qty", 0.0) or 0.0)
        current_value = float(position.get("market_value", 0.0) or 0.0)
        if symbol not in target_weights:
            # Do not strand fractional shares merely because their value is
            # below the general drift threshold.
            if quantity > 1e-9:
                return False
            continue
        target_value = equity * float(target_weights[symbol])
        if abs(current_value - target_value) > drift_value:
            return False
    for symbol, target_weight in target_weights.items():
        if symbol in held:
            continue
        if equity * float(target_weight) > drift_value:
            return False
    return True


def _adaptive_intent_key(
    pending_plan: dict,
    symbol: str,
    side: str,
    quantity: float,
    target_weight: float,
) -> str:
    """Identify one concrete order intent within an immutable plan."""

    canonical = "|".join(
        (
            str(pending_plan["plan_id"]),
            symbol.upper(),
            side.lower(),
            f"qty={float(quantity):.9f}",
            f"target={float(target_weight):.10f}",
        )
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _reserve_adaptive_client_order_id(
    perf: dict,
    pending_plan: dict,
    *,
    symbol: str,
    side: str,
    quantity: float,
    target_weight: float,
) -> tuple[str | None, str]:
    """Reserve/reconcile a retry-safe ID for one concrete order intent.

    Reservation is persisted *before* submission.  If submission fails with
    an ambiguous network error, the next run resolves the same client ID at
    Alpaca.  A terminal cancelled/expired order advances the attempt number;
    a still-active or just-filled order blocks a duplicate submit.
    """

    from trade import get_order_by_client_order_id

    intent_key = _adaptive_intent_key(
        pending_plan,
        symbol,
        side,
        quantity,
        target_weight,
    )
    attempts = pending_plan.setdefault("order_attempts", {})
    record = attempts.get(intent_key)
    attempt_number = 1
    if isinstance(record, dict):
        attempt_number = max(1, int(record.get("attempt", 1)))
        prior_client_id = str(record.get("client_order_id", ""))
        if prior_client_id:
            prior_order = get_order_by_client_order_id(prior_client_id)
            if prior_order is not None:
                disposition = _order_retry_disposition(
                    prior_order.get("status")
                )
                if disposition == "FILLED":
                    return None, "FILLED_AWAITING_POSITION_REFRESH"
                if disposition == "ACTIVE_OR_UNKNOWN":
                    return None, "PENDING_ORDER"
                attempt_number += 1
            # A broker 404 means an earlier reserved/ambiguous request never
            # became an order.  Reusing exactly the same ID is idempotent.

    client_order_id = _execution_client_order_id(
        "adaptive",
        symbol,
        side,
        execution_key=str(pending_plan["plan_id"]),
        intent=f"{intent_key}|attempt={attempt_number}",
    )
    attempts[intent_key] = {
        "attempt": attempt_number,
        "client_order_id": client_order_id,
        "status": "reserved",
        "symbol": symbol.upper(),
        "side": side.lower(),
        "quantity": float(quantity),
        "target_weight": float(target_weight),
        "reserved_at": get_now_str(),
    }
    perf[ADAPTIVE_PENDING_PLAN_KEY] = pending_plan
    save_json(PERFORMANCE_STATE, perf)
    return client_order_id, "READY"


def _mark_adaptive_order_submitted(
    perf: dict,
    pending_plan: dict,
    client_order_id: str,
    order_id: str,
) -> None:
    """Persist the broker order ID after a successful reserved submission."""

    for record in pending_plan.get("order_attempts", {}).values():
        if record.get("client_order_id") == client_order_id:
            record["status"] = "submitted"
            record["order_id"] = str(order_id)
            record["submitted_at"] = get_now_str()
            break
    perf[ADAPTIVE_PENDING_PLAN_KEY] = pending_plan
    save_json(PERFORMANCE_STATE, perf)


def _adaptive_open_buy_belongs_to_plan(order: dict, pending_plan: dict | None) -> bool:
    """Return whether an open BUY is one recorded intent of the frozen plan."""

    if not isinstance(pending_plan, dict):
        return False
    attempts = pending_plan.get("order_attempts")
    targets = pending_plan.get("target_weights")
    if not isinstance(attempts, dict) or not isinstance(targets, dict):
        return False
    order_id = str(order.get("id", ""))
    client_order_id = str(order.get("client_order_id", ""))
    symbol = str(order.get("symbol", "")).upper()
    if order.get("side") != "buy" or symbol not in targets:
        return False
    for record in attempts.values():
        if not isinstance(record, dict):
            continue
        id_matches = bool(
            (order_id and order_id == str(record.get("order_id", "")))
            or (
                client_order_id
                and client_order_id == str(record.get("client_order_id", ""))
            )
        )
        if not id_matches:
            continue
        if record.get("side") != "buy" or record.get("symbol") != symbol:
            return False
        try:
            intended_quantity = float(record.get("quantity"))
            order_quantity = float(order.get("qty", intended_quantity))
            intended_weight = float(record.get("target_weight"))
            target_weight = float(targets[symbol])
        except (TypeError, ValueError):
            return False
        return bool(
            math.isfinite(order_quantity)
            and math.isclose(
                order_quantity,
                intended_quantity,
                rel_tol=0.0,
                abs_tol=1e-9,
            )
            and math.isclose(
                intended_weight,
                target_weight,
                rel_tol=0.0,
                abs_tol=1e-12,
            )
        )
    return False


def _manage_adaptive_momentum_picks(
    *,
    dry_run: bool,
    allow_new_exposure: bool,
) -> list[dict]:
    """Converge the paper account to one frozen, broker-reconciled target."""

    from adaptive_momentum import (
        SECTOR_BENCHMARKS,
        build_target_portfolio,
        compute_market_state,
        config_from_params,
        market_reentry_confirmed,
    )
    from notify import send_trade_alert
    from portfolio import get_account, get_positions
    from research import get_latest_quote
    from trade import (
        cancel_open_order,
        get_market_entry_gate,
        list_open_orders,
        place_limit_order,
        validate_order,
    )
    from universe import load_universe_symbols

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    cfg = config_from_params(params)
    today_ym = datetime.now(timezone.utc).strftime("%Y-%m")

    # Open-order state is the first broker dependency.  It lets a closed
    # validation/risk gate cancel exposure-increasing intent even when a later
    # positions or market-data read is unavailable.
    try:
        open_orders = list_open_orders()
    except Exception as exc:
        log.error(f"Open-order reconciliation unavailable: {exc}")
        return [
            {
                "action": "ABORT_OPEN_ORDER_RECONCILIATION",
                "reason": str(exc),
            }
        ]
    try:
        positions = get_positions()
    except Exception as exc:
        cancellations = _cancel_buy_orders_and_wait(
            open_orders,
            dry_run=dry_run,
            reason="position reconciliation unavailable",
        )
        return cancellations or [
            {"action": "ABORT", "reason": f"positions unavailable: {exc}"}
        ]
    short_reconciliation = _reconcile_v11_short_positions(
        dry_run=dry_run,
        positions_snapshot=positions,
        open_orders_snapshot=open_orders,
    )
    if short_reconciliation:
        return short_reconciliation

    try:
        raw_perf, state_read_error = load_json_object_status(PERFORMANCE_STATE)
    except Exception as exc:
        raw_perf = {}
        state_read_error = f"unexpected state loader failure: {exc}"
    performance_state_error = (
        f"performance state unavailable: {state_read_error}"
        if state_read_error is not None
        else None
    )
    if performance_state_error is not None:
        # Missing local state must never disable a HALT/SMA liquidation, but
        # it cannot authorize a new risk-on target either.
        allow_new_exposure = False
    perf = raw_perf
    risk_off_latch_value = perf.get(ADAPTIVE_RISK_OFF_LATCH_KEY, False)
    invalid_risk_off_latch = type(risk_off_latch_value) is not bool
    if invalid_risk_off_latch:
        # Corrupted local state cannot authorize exposure, but it must not
        # prevent a HALT/SMA zero-target plan from liquidating positions.  Use
        # a conservative local value until the market state is known; a
        # completed risk-off plan repairs the persisted latch to ``True``.
        risk_off_latch_value = False
        allow_new_exposure = False

    held_symbols = [position["symbol"] for position in positions]

    # Every run checks the broad risk gate, even after the monthly rebalance.
    # This is a small request and makes a 200-SMA break an immediate exit.
    if risk_tier == "HALT":
        market = None
        signal_date = None
    else:
        try:
            risk_provider = _adaptive_live_frames(["SPY"])
            signal_date = risk_provider.latest_date("SPY")
            market = (
                compute_market_state(risk_provider, signal_date, config=cfg)
                if signal_date
                else None
            )
        except Exception as exc:
            cancellations = _cancel_buy_orders_and_wait(
                open_orders,
                dry_run=dry_run,
                reason="SPY history unavailable",
            )
            return cancellations or [
                {"action": "ABORT", "reason": f"SPY history unavailable: {exc}"}
            ]
        if market is None:
            cancellations = _cancel_buy_orders_and_wait(
                open_orders,
                dry_run=dry_run,
                reason="SPY history unavailable",
            )
            return cancellations or [
                {"action": "ABORT", "reason": "SPY history unavailable"}
            ]

    risk_off = risk_tier == "HALT" or (market is not None and not market.above_sma200)

    stored_plan = perf.get(ADAPTIVE_PENDING_PLAN_KEY)
    persisted_zero_target_intent = bool(
        isinstance(stored_plan, dict)
        and stored_plan.get("risk_off") is True
        and stored_plan.get("target_weights") == {}
    )
    stored_plan_structure_valid = (
        stored_plan is None or _adaptive_pending_plan_structure_valid(stored_plan)
    )
    invalid_pending_plan = not stored_plan_structure_valid
    if not stored_plan_structure_valid:
        if risk_off or persisted_zero_target_intent:
            # A zero-target emergency does not depend on the corrupted/legacy
            # plan metadata. Convert it to the current schema rather than
            # blocking liquidation if the market recovered during an upgrade.
            stored_plan = None
            stored_plan_structure_valid = True
            invalid_pending_plan = False

    # Persist the emergency intent before crossing the open-order cancellation
    # boundary.  A BUY cancellation deliberately ends this invocation so fills
    # can be reconciled from a fresh broker snapshot; without an already-frozen
    # zero target, a one-session risk-off event could recover before the next
    # invocation and resurrect the old risk-on plan.
    if risk_off or persisted_zero_target_intent:
        perf[ADAPTIVE_RISK_OFF_LATCH_KEY] = True
        if not stored_plan or stored_plan.get("risk_off") is not True:
            stored_plan = _new_adaptive_pending_plan(
                rebalance_month=today_ym,
                signal_date=signal_date,
                target_weights={},
                sector_by_symbol={},
                risk_off=True,
                eligible_count=0,
                construction_risk_tier=risk_tier,
            )
            perf[ADAPTIVE_PENDING_PLAN_KEY] = stored_plan
        if not dry_run and performance_state_error is None:
            save_json(PERFORMANCE_STATE, perf)

    stricter_risk_tier = bool(
        isinstance(stored_plan, dict)
        and stored_plan_structure_valid
        and risk_tier == "CAUTIOUS"
        and stored_plan.get("construction_risk_tier") == "NORMAL"
    )
    stale_plan = bool(
        isinstance(stored_plan, dict)
        and stored_plan_structure_valid
        and stored_plan.get("risk_off") is not True
        and not risk_off
        and (
            stored_plan.get("rebalance_month") != today_ym
            or not _adaptive_pending_plan_context_matches(stored_plan)
        )
    )
    # Every open BUY must belong to the exact current frozen plan. Risk-off,
    # shadow, stale-plan, stricter-tier and retired-infrastructure buys are
    # cancelled even when their IDs happen to be known. Adaptive holdings must
    # also shed legacy GTC trailing stops before a target sell can be submitted;
    # otherwise both sells may fill and create a short.
    cancellations: list[tuple[dict, str]] = []
    seen_cancel_ids: set[str] = set()
    held_adaptive = {
        symbol for symbol in held_symbols if not _is_infrastructure(symbol)
    }
    for order in open_orders:
        order_id = str(order.get("id", ""))
        if not order_id or order_id in seen_cancel_ids:
            continue
        is_directional_buy = order.get("side") == "buy"
        is_infrastructure_buy = bool(
            is_directional_buy
            and _is_infrastructure(str(order.get("symbol", "")))
        )
        is_untrusted_buy = bool(
            is_directional_buy
            and not _adaptive_open_buy_belongs_to_plan(
                order,
                stored_plan if stored_plan_structure_valid else None,
            )
        )
        is_legacy_trailing_sell = (
            order.get("symbol") in held_adaptive
            and order.get("side") == "sell"
            and order.get("type") in {"trailing_stop", "trailing-stop"}
            and order.get("time_in_force") == "gtc"
        )
        if (
            is_directional_buy
            and (
                risk_off
                or stale_plan
                or stricter_risk_tier
                or not allow_new_exposure
                or is_infrastructure_buy
                or is_untrusted_buy
            )
        ) or (
            is_legacy_trailing_sell
        ):
            reason = (
                (
                    "zero-target V11 infrastructure buy"
                    if is_infrastructure_buy
                    else (
                        "open buy is not bound to the current frozen V11 plan"
                        if is_untrusted_buy
                        else "pending directional buy blocked"
                    )
                )
                if is_directional_buy
                else "legacy adaptive trailing stop"
            )
            cancellations.append((order, reason))
            seen_cancel_ids.add(order_id)

    if cancellations:
        results = []
        if dry_run:
            return [
                {
                    "symbol": order.get("symbol"),
                    "action": "DRY_RUN_CANCEL_OPEN_ORDER",
                    "order_id": order.get("id"),
                    "reason": reason,
                }
                for order, reason in cancellations
            ]
        cancellation_error = False
        for order, reason in cancellations:
            if order.get("status") == "pending_cancel":
                results.append(
                    {
                        "symbol": order.get("symbol"),
                        "action": "PENDING_CANCELLATION",
                        "order_id": order.get("id"),
                        "reason": reason,
                    }
                )
                continue
            try:
                cancel_open_order(str(order["id"]))
                results.append(
                    {
                        "symbol": order.get("symbol"),
                        "action": "CANCEL_REQUESTED",
                        "order_id": order.get("id"),
                        "reason": reason,
                    }
                )
            except Exception as exc:
                cancellation_error = True
                results.append(
                    {
                        "symbol": order.get("symbol"),
                        "action": "ERROR",
                        "order_id": order.get("id"),
                        "reason": f"cancel failed: {exc}",
                    }
                )
        if cancellation_error:
            return results
        try:
            confirmed_orders = list_open_orders()
        except Exception as exc:
            results.append(
                {
                    "action": "ABORT_CANCELLATION_CONFIRMATION",
                    "reason": str(exc),
                }
            )
            return results
        still_open = {
            str(order.get("id"))
            for order in confirmed_orders
            if str(order.get("id")) in seen_cancel_ids
        }
        results.append(
            {
                "action": "REBALANCE_PENDING_CANCELLATIONS",
                "remaining_order_ids": sorted(still_open),
                "reason": (
                    "cancellations still pending broker confirmation"
                    if still_open
                    else "cancellations confirmed; refresh positions before target orders"
                ),
            }
        )
        # Always cross an invocation boundary after cancellation so a partial
        # fill racing the cancel is reflected in a fresh position snapshot.
        return results

    if invalid_pending_plan and not risk_off:
        return [
            {
                "action": "ABORT_INVALID_PENDING_PLAN",
                "reason": (
                    "adaptive_rebalance_pending is malformed; "
                    "manual review required"
                ),
            }
        ]

    if stale_plan:
        attempts = stored_plan.get("order_attempts", {})
        plan_order_ids = {
            str(record.get("order_id"))
            for record in attempts.values()
            if isinstance(record, dict) and record.get("order_id")
        }
        plan_client_ids = {
            str(record.get("client_order_id"))
            for record in attempts.values()
            if isinstance(record, dict) and record.get("client_order_id")
        }
        active_plan_orders = [
            order
            for order in open_orders
            if str(order.get("id")) in plan_order_ids
            or str(order.get("client_order_id")) in plan_client_ids
        ]
        if active_plan_orders:
            return [
                {
                    "action": "STALE_PLAN_PENDING_ORDERS",
                    "plan_id": stored_plan["plan_id"],
                    "rebalance_month": stored_plan["rebalance_month"],
                    "order_ids": sorted(
                        str(order.get("id")) for order in active_plan_orders
                    ),
                    "reason": (
                        "stale or risk-incompatible plan cannot submit new orders "
                        "until its "
                        "active orders reach a terminal state"
                    ),
                }
            ]
        perf.pop(ADAPTIVE_PENDING_PLAN_KEY, None)
        stored_plan = None
        if not dry_run:
            save_json(PERFORMANCE_STATE, perf)

    if stricter_risk_tier and isinstance(stored_plan, dict):
        # Preserve the frozen signal and constituents.  CAUTIOUS is a sizing
        # change, not permission to rerank on a newer close while an old plan
        # is in flight.  Equal-weight V11 halves the existing NORMAL targets.
        scaled_weights = {
            symbol: float(weight) * 0.5
            for symbol, weight in stored_plan["target_weights"].items()
        }
        stored_plan = _new_adaptive_pending_plan(
            rebalance_month=stored_plan["rebalance_month"],
            signal_date=stored_plan.get("signal_date"),
            target_weights=scaled_weights,
            sector_by_symbol=dict(stored_plan["sector_by_symbol"]),
            risk_off=False,
            eligible_count=int(stored_plan.get("eligible_count", 0)),
            construction_risk_tier="CAUTIOUS",
        )
        if not dry_run:
            perf[ADAPTIVE_PENDING_PLAN_KEY] = stored_plan
            save_json(PERFORMANCE_STATE, perf)

    if invalid_risk_off_latch and not risk_off and stored_plan is None:
        return [
            {
                "action": "ABORT_INVALID_RISK_OFF_LATCH",
                "reason": "adaptive risk-off latch must be boolean",
            }
        ]

    directional_longs = [
        position
        for position in positions
        if not _is_infrastructure(position["symbol"])
        and float(position.get("qty", 0.0)) > 0
    ]
    risk_off_latched = bool(risk_off_latch_value)
    if risk_off:
        risk_off_latched = True
        perf[ADAPTIVE_RISK_OFF_LATCH_KEY] = True
    elif (
        risk_off_latched
        and not directional_longs
        and stored_plan is None
        and cfg.risk_on_reentry_confirmation_days > 0
    ):
        risk_off_latched = market_reentry_confirmed(
            risk_provider,
            signal_date,
            confirmation_days=cfg.risk_on_reentry_confirmation_days,
            config=cfg,
        )
    elif risk_off_latched and directional_longs and stored_plan is None:
        # A regular month-start already restored exposure. Consume the latch
        # so this episode cannot trigger a second off-cycle portfolio rerank.
        risk_off_latched = False
        perf[ADAPTIVE_RISK_OFF_LATCH_KEY] = False
        if not dry_run and performance_state_error is None:
            save_json(PERFORMANCE_STATE, perf)

    risk_on_reentry_ready = bool(
        not risk_off
        and cfg.risk_on_reentry_confirmation_days > 0
        and risk_off_latched
        and not directional_longs
        and stored_plan is None
    )

    if not risk_off and stored_plan is None and not allow_new_exposure and not dry_run:
        # A closed validation/clock gate must not freeze an unbuyable risk-on
        # signal indefinitely.  Defer the monthly plan until exposure is
        # actually authorized; HALT/SMA risk-off is handled above and remains
        # immediately actionable.
        return [
            {
                "action": "ADAPTIVE_PLAN_DEFERRED",
                "reason": (
                    "new exposure gate closed; no persistent risk-on plan was created"
                ),
            },
            *_entry_gate_blocked(),
        ]

    target_weights: dict[str, float]
    sector_by_symbol: dict[str, str]
    plan = None
    pending_plan: dict
    if risk_off:
        # Emergency risk-off replaces any stale risk-on plan.  It is itself
        # frozen so retries continue toward cash rather than a moving target.
        if not stored_plan or not stored_plan.get("risk_off"):
            pending_plan = _new_adaptive_pending_plan(
                rebalance_month=today_ym,
                signal_date=signal_date,
                target_weights={},
                sector_by_symbol={},
                risk_off=True,
                eligible_count=0,
                construction_risk_tier=risk_tier,
            )
            if not dry_run:
                perf[ADAPTIVE_PENDING_PLAN_KEY] = pending_plan
                save_json(PERFORMANCE_STATE, perf)
        else:
            pending_plan = stored_plan
        target_weights = {}
        sector_by_symbol = {}
    elif stored_plan:
        # Never recompute an in-flight target from a newer signal date.
        pending_plan = stored_plan
        signal_date = pending_plan.get("signal_date")
        target_weights = {
            symbol: float(weight)
            for symbol, weight in pending_plan["target_weights"].items()
        }
        sector_by_symbol = dict(pending_plan["sector_by_symbol"])
    else:
        if (
            perf.get("last_momentum_rebal_ym") == today_ym
            and not risk_on_reentry_ready
        ):
            log.info(f"Adaptive momentum rebalance already completed for {today_ym}")
            return []
        else:
            # Ranking universe is exactly the validated snapshot/fallback.
            # Held-only names remain visible in ``positions`` for exits, but
            # must never leak back into ranking or become re-buy candidates.
            candidates = load_universe_symbols(held_symbols=[])
            requested = sorted(
                set(candidates) | {"SPY"} | set(SECTOR_BENCHMARKS.values())
            )
            try:
                provider = _adaptive_live_frames(requested)
                signal_date = provider.latest_date("SPY")
                if signal_date is None:
                    return [{"action": "ABORT", "reason": "No completed SPY session"}]

                required_history = max(
                    cfg.lookback_days + 1,
                    cfg.trend_days,
                    cfg.volatility_days + 1,
                    cfg.liquidity_days,
                )
                held_history_errors = _held_ranking_history_errors(
                    provider,
                    held_symbols,
                    candidates,
                    signal_date,
                    required_bars=required_history,
                )
                if held_history_errors:
                    details = ", ".join(
                        f"{symbol}={error}"
                        for symbol, error in held_history_errors.items()
                    )
                    return [
                        {
                            "action": "ABORT",
                            "reason": (
                                "held ranking history is incomplete versus "
                                f"SPY={signal_date}: {details}"
                            ),
                        }
                    ]

                sector_lookup = _live_sector_lookup(provider, signal_date)
                plan = build_target_portfolio(
                    provider,
                    candidates,
                    signal_date,
                    sector_lookup=sector_lookup,
                    incumbent_symbols=(
                        position["symbol"]
                        for position in positions
                        if position["symbol"] in candidates
                        and not _is_infrastructure(position["symbol"])
                        and float(position.get("qty", 0.0)) > 0
                    ),
                    risk_tier=risk_tier,
                    config=cfg,
                )
                if plan.market_state is None:
                    return [
                        {
                            "action": "ABORT",
                            "reason": "broad snapshot cannot compute SPY market state",
                        }
                    ]
                if (
                    plan.market_state.as_of != signal_date
                    or not plan.market_state.above_sma200
                ):
                    return [
                        {
                            "action": "ABORT",
                            "reason": (
                                "broad SPY snapshot disagrees with the pre-plan "
                                "risk gate"
                            ),
                        }
                    ]
                evaluated_count = int(
                    plan.diagnostics.get("evaluated_count", 0)
                )
                minimum_evaluated = min(
                    len(candidates),
                    max(cfg.min_positions, math.ceil(len(candidates) * 0.5)),
                )
                if evaluated_count < minimum_evaluated:
                    return [
                        {
                            "action": "ABORT",
                            "reason": (
                                "broad snapshot has insufficient analyzable history: "
                                f"{evaluated_count}<{minimum_evaluated} ranking names"
                            ),
                        }
                    ]
                target_weights = plan.weights
                sector_by_symbol = {
                    symbol: sector_lookup(symbol) for symbol in target_weights
                }
                pending_plan = _new_adaptive_pending_plan(
                    rebalance_month=today_ym,
                    signal_date=signal_date,
                    target_weights=target_weights,
                    sector_by_symbol=sector_by_symbol,
                    risk_off=False,
                    eligible_count=plan.eligible_count,
                    construction_risk_tier=risk_tier,
                )
                if not dry_run:
                    perf[ADAPTIVE_PENDING_PLAN_KEY] = pending_plan
                    save_json(PERFORMANCE_STATE, perf)
            except Exception as exc:
                log.exception("Adaptive portfolio planning failed")
                return [{"action": "ABORT", "reason": f"portfolio planning: {exc}"}]

    try:
        account = get_account()
        equity = float(account.get("equity", 0.0))
        available_cash = float(account.get("cash", 0.0))
    except Exception as exc:
        cancellations = _cancel_buy_orders_and_wait(
            open_orders,
            dry_run=dry_run,
            reason=f"account unavailable: {exc}",
        )
        return cancellations or [
            {"action": "ABORT", "reason": f"account unavailable: {exc}"}
        ]
    if not math.isfinite(equity) or equity <= 0:
        cancellations = _cancel_buy_orders_and_wait(
            open_orders,
            dry_run=dry_run,
            reason="invalid account equity",
        )
        return cancellations or [
            {"action": "ABORT", "reason": "invalid account equity"}
        ]
    if not math.isfinite(available_cash):
        cancellations = _cancel_buy_orders_and_wait(
            open_orders,
            dry_run=dry_run,
            reason="invalid account cash",
        )
        return cancellations or [
            {"action": "ABORT", "reason": "invalid account cash"}
        ]

    results: list[dict] = []
    drift_value = equity * 0.005
    held = {position["symbol"]: position for position in positions}
    pending_sells: dict[str, float] = {}
    pending_buys: dict[str, float] = {}
    for order in open_orders:
        symbol = str(order.get("symbol", ""))
        remaining = max(0.0, float(order.get("remaining_qty", 0.0) or 0.0))
        if order.get("side") == "sell":
            pending_sells[symbol] = pending_sells.get(symbol, 0.0) + remaining
        elif order.get("side") == "buy":
            pending_buys[symbol] = pending_buys.get(symbol, 0.0) + remaining
    submitted_sells = False
    submitted_buys = False
    blocking_failure = False

    # Sell and trim first. These risk-reducing actions remain available even
    # when the market clock blocks new exposure.
    for symbol, position in held.items():
        if _is_infrastructure(symbol):
            continue
        if pending_buys.get(symbol, 0.0) > 0:
            # Never self-cross a partially filled BUY with a new trim/exit.
            # Wait for its terminal state and refresh the filled position first.
            results.append(
                {
                    "symbol": symbol,
                    "action": "PENDING_BUY_BLOCKS_SELL",
                    "remaining_qty": pending_buys[symbol],
                }
            )
            blocking_failure = True
            continue
        current_value = float(position.get("market_value", 0.0))
        target_value = equity * target_weights.get(symbol, 0.0)
        excess = current_value - target_value
        if excess <= drift_value and symbol in target_weights:
            continue
        quantity_held = float(position.get("qty", 0))
        if quantity_held <= 0:
            continue
        if symbol not in target_weights:
            quantity = quantity_held
            action = "ADAPTIVE_EXIT"
        else:
            reference_price = float(position.get("current_price", 0.0))
            if reference_price <= 0:
                continue
            quantity = min(quantity_held, float(int(excess / reference_price)))
            action = "ADAPTIVE_TRIM"
        remaining_pending_sell = pending_sells.get(symbol, 0.0)
        quantity = max(0.0, quantity - remaining_pending_sell)
        if remaining_pending_sell > 0:
            results.append(
                {
                    "symbol": symbol,
                    "action": "PENDING_SELL",
                    "remaining_qty": remaining_pending_sell,
                }
            )
        if quantity <= 1e-9:
            continue
        quantity = _clean_order_qty(quantity)
        reference_price = float(position.get("current_price", 0.0))
        if dry_run:
            results.append(
                {
                    "symbol": symbol,
                    "action": f"DRY_RUN_{action}",
                    "qty": quantity,
                    "target_weight": target_weights.get(symbol, 0.0),
                }
            )
            continue
        try:
            quote = get_latest_quote(symbol)
            bid = quote["bid"] if quote["bid"] > 0 else quote["mid"]
            if not math.isfinite(float(bid)) or float(bid) <= 0:
                raise ValueError("invalid sell quote")
            limit_price = round(bid * 0.999, 2)
            client_order_id, lifecycle = _reserve_adaptive_client_order_id(
                perf,
                pending_plan,
                symbol=symbol,
                side="sell",
                quantity=float(quantity),
                target_weight=target_weights.get(symbol, 0.0),
            )
            if client_order_id is None:
                results.append({"symbol": symbol, "action": lifecycle})
                blocking_failure = True
                continue
            order = place_limit_order(
                symbol,
                quantity,
                "sell",
                limit_price,
                client_order_id=client_order_id,
            )
            _mark_adaptive_order_submitted(
                perf, pending_plan, client_order_id, order["id"]
            )
            send_trade_alert(
                symbol,
                "sell",
                quantity,
                limit_price,
                "Adaptive momentum sell order submitted (not yet filled)",
            )
            results.append(
                {"symbol": symbol, "action": action, "order_id": order["id"]}
            )
            submitted_sells = True
        except Exception as exc:
            results.append({"symbol": symbol, "action": "ERROR", "reason": str(exc)})
            blocking_failure = True

    settlement_pending = bool(pending_sells or submitted_sells)
    if (settlement_pending or blocking_failure) and target_weights and not dry_run:
        results.append(
            {
                "action": "REBALANCE_PENDING_SELLS",
                "reason": (
                    "buy phase waits for successful sell reconciliation and refreshed cash"
                ),
            }
        )
    elif pending_buys and target_weights and not dry_run:
        results.append(
            {
                "action": "REBALANCE_PENDING_BUYS",
                "reason": (
                    "buy phase waits for pending buy fills before recalculating "
                    "cash, positions, and sector exposure"
                ),
            }
        )
    elif target_weights and not allow_new_exposure:
        results.extend(_entry_gate_blocked())
    elif target_weights:
        cash_reserve = equity * (float(params.get("min_cash_pct", 10.0)) / 100.0)
        reserved_buy_cash = sum(
            float(order.get("remaining_qty", 0.0) or 0.0)
            * float(order.get("limit_price", 0.0) or 0.0)
            for order in open_orders
            if order.get("side") == "buy"
        )
        spendable = max(0.0, available_cash - cash_reserve - reserved_buy_cash)
        for symbol, target_weight in sorted(
            target_weights.items(), key=lambda item: (-item[1], item[0])
        ):
            position = held.get(symbol)
            current_value = float(position.get("market_value", 0.0)) if position else 0.0
            try:
                quote = get_latest_quote(symbol)
                price = quote["ask"] if quote["ask"] > 0 else quote["mid"]
                if not math.isfinite(float(price)) or float(price) <= 0:
                    raise ValueError("invalid buy quote")
            except Exception as exc:
                results.append({"symbol": symbol, "action": "ERROR", "reason": str(exc)})
                blocking_failure = True
                continue
            pending_buy_value = pending_buys.get(symbol, 0.0) * price
            shortfall = equity * target_weight - current_value - pending_buy_value
            if pending_buys.get(symbol, 0.0) > 0:
                results.append(
                    {
                        "symbol": symbol,
                        "action": "PENDING_BUY",
                        "remaining_qty": pending_buys[symbol],
                    }
                )
            if shortfall <= drift_value or spendable <= 0:
                continue
            quantity = min(int(shortfall / price), int(spendable / price))
            if quantity <= 0:
                continue
            sector = sector_by_symbol.get(symbol, "Unknown")
            validation = validate_order(
                symbol,
                quantity,
                "buy",
                price,
                sector_override=sector,
            )
            if not validation["valid"]:
                results.append(
                    {
                        "symbol": symbol,
                        "action": "REJECTED",
                        "reasons": validation["reasons"],
                    }
                )
                blocking_failure = True
                continue
            if dry_run:
                results.append(
                    {
                        "symbol": symbol,
                        "action": "DRY_RUN_ADAPTIVE_BUY",
                        "qty": quantity,
                        "price": price,
                        "target_weight": target_weight,
                    }
                )
            else:
                try:
                    # The CLI-level promotion check can become stale during a
                    # broad-universe plan, and this function is also callable
                    # directly.  Revalidate the complete report contract at
                    # the final exposure-increasing order boundary so no caller
                    # can turn ``allow_new_exposure=True`` into an artifact
                    # bypass.
                    fresh_validation_gate = _v11_validation_gate()
                    if not fresh_validation_gate["passed"]:
                        results.append(
                            {
                                "symbol": symbol,
                                "action": "VALIDATION_GATE_BLOCKED",
                                "reason": fresh_validation_gate["reason"],
                            }
                        )
                        blocking_failure = True
                        break
                    # Universe/history planning can exceed the original
                    # 120-second clock lease.  Reauthorize every exposure-
                    # increasing submission immediately before reserving it.
                    fresh_entry_gate = get_market_entry_gate()
                    if not fresh_entry_gate["allowed"]:
                        results.append(
                            {
                                "symbol": symbol,
                                "action": "ENTRY_GATE_BLOCKED",
                                "reason": fresh_entry_gate["reason"],
                            }
                        )
                        blocking_failure = True
                        break
                    client_order_id, lifecycle = _reserve_adaptive_client_order_id(
                        perf,
                        pending_plan,
                        symbol=symbol,
                        side="buy",
                        quantity=float(quantity),
                        target_weight=target_weight,
                    )
                    if client_order_id is None:
                        results.append({"symbol": symbol, "action": lifecycle})
                        blocking_failure = True
                        continue
                    order = place_limit_order(
                        symbol,
                        quantity,
                        "buy",
                        price,
                        client_order_id=client_order_id,
                    )
                    _mark_adaptive_order_submitted(
                        perf, pending_plan, client_order_id, order["id"]
                    )
                    send_trade_alert(
                        symbol,
                        "buy",
                        quantity,
                        price,
                        "Adaptive 12-1 momentum buy order submitted (not yet filled)",
                    )
                    results.append(
                        {
                            "symbol": symbol,
                            "action": "ADAPTIVE_BUY",
                            "order_id": order["id"],
                        }
                    )
                    submitted_buys = True
                except Exception as exc:
                    results.append(
                        {"symbol": symbol, "action": "ERROR", "reason": str(exc)}
                    )
                    blocking_failure = True
            spendable -= quantity * price

    target_gross_weight = sum(target_weights.values())
    results.insert(
        0,
        {
            "action": "ADAPTIVE_PLAN",
            "plan_id": pending_plan["plan_id"],
            "signal_date": pending_plan.get("signal_date"),
            "eligible_count": pending_plan.get("eligible_count", 0),
            "selected_count": len(target_weights),
            "target_gross_weight": target_gross_weight,
            "cash_weight": max(0.0, 1.0 - target_gross_weight),
            "frozen": True,
        },
    )
    orders_pending = bool(open_orders or submitted_sells or submitted_buys)
    converged = _adaptive_portfolio_converged(
        positions,
        target_weights,
        equity,
        drift_value,
    )
    if (
        not dry_run
        and not orders_pending
        and not blocking_failure
        and converged
    ):
        perf["last_momentum_rebal_ym"] = pending_plan["rebalance_month"]
        perf["last_momentum_signal_date"] = pending_plan.get("signal_date")
        perf["last_momentum_targets"] = target_weights
        perf[ADAPTIVE_RISK_OFF_LATCH_KEY] = bool(pending_plan["risk_off"])
        perf.pop(ADAPTIVE_PENDING_PLAN_KEY, None)
        save_json(PERFORMANCE_STATE, perf)
        results.append(
            {
                "action": "ADAPTIVE_REBALANCE_COMPLETE",
                "plan_id": pending_plan["plan_id"],
            }
        )
    return results


def manage_momentum_picks(
    dry_run: bool = False,
    allow_new_exposure: bool = False,
) -> list[dict]:
    """Dispatch to the audited v11 planner, retaining legacy reproducibility."""

    params = get_strategy_params(get_market_regime(), get_risk_tier())
    if params.get("adaptive_momentum", False):
        return _manage_adaptive_momentum_picks(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
    return _manage_legacy_momentum_picks(
        dry_run=dry_run,
        allow_new_exposure=allow_new_exposure,
    )


# ──────────────── legacy v6 implementation ─────────────────


def _manage_legacy_momentum_picks(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
    """v6 — monthly dual-momentum rebalance for live trading.

    Mirror of `backtest.engine._execute_momentum_picks` for the Alpaca path.

    Trigger: first execution of each calendar month. The previous-execution
    month is persisted in performance.json under `last_momentum_rebal_ym`.

    Steps when triggered:
      1. Rank watchlist by 12-month total return (from Alpaca daily bars)
      2. Filter survivors: must beat SPY's 12m return AND > 0
      3. Take top-N (regime-tuned, default 10 in BULL/NORMAL)
      4. Sell currently-held non-infrastructure positions that aren't in
         the new top-N (only if held ≥ `momentum_min_hold_days`)
      5. Buy new top-N members not yet held — equal-weight, capped by
         `max_position_pct` and `min_cash_pct` floor
    """
    from datetime import datetime, timezone
    from research import get_bars, get_latest_quote
    from trade import place_limit_order, close_position, validate_order
    from portfolio import get_positions, get_account
    from notify import send_trade_alert
    from utils import get_tradeable_symbols

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    params = get_strategy_params(regime, risk_tier)

    if not params.get("momentum_mode", False):
        return []

    top_n = int(params.get("momentum_top_n", 10))
    min_hold = int(params.get("momentum_min_hold_days", 21))

    # Once per month — gated by performance.json
    today_ym = datetime.now(timezone.utc).strftime("%Y-%m")
    perf = load_json(PERFORMANCE_STATE) or {}
    last_ym = perf.get("last_momentum_rebal_ym")
    if last_ym == today_ym:
        log.info(f"Momentum rebalance already done for {today_ym} — skipping")
        return []

    if risk_tier == "HALT":
        top_n = 0  # HALT means no entries, but SELL of stale picks still OK

    # ──────────── compute 12m returns ────────────
    log.info(f"Momentum rebalance for {today_ym} — regime={regime}/{risk_tier}, top_n={top_n}")

    def _12m_return(symbol: str) -> float | None:
        try:
            df = get_bars(symbol, days=270)  # enough history for 252-day lookback
            if df is None or len(df) < 252:
                return None
            closes = df["close"].astype(float)
            return (float(closes.iloc[-1]) / float(closes.iloc[-252]) - 1) * 100
        except Exception:
            return None

    spy_12m_raw = _12m_return("SPY")
    if spy_12m_raw is None:
        # v7 hardening: SPY data unavailable (weekend, API outage, holiday).
        # Bailing out is safer than deploying capital with spy_12m=0 — every
        # stock with positive 12m return would appear to "beat SPY".
        log.warning("Momentum rebalance aborted — SPY 12m return unavailable "
                    "(market closed, holiday, or Alpaca data feed glitch). "
                    "Will retry on next routine.")
        return [{"action": "ABORT", "reason": "SPY 12m unavailable"}]
    spy_12m = spy_12m_raw

    ranked: list[tuple[str, float]] = []
    for sym in get_tradeable_symbols():
        r = _12m_return(sym)
        if r is None or r <= 0 or r <= spy_12m:
            continue
        ranked.append((sym, r))
    ranked.sort(key=lambda x: -x[1])

    raw_top = [s for s, _ in ranked[:top_n]] if top_n > 0 else []

    # v7 production hardening: earnings veto. Block any pick within 5 trading
    # days of a known earnings release. Binary-risk events (±10-25 % overnight
    # moves) have no momentum-style edge, and the worst trade in our 5-y
    # backtest was an earnings-day disaster (NVO −24 % in one session).
    # Replacement picks are drawn from the next-best momentum names so the
    # top-N slate is still filled when possible.
    try:
        from ablation_flags import ABLATE_EARNINGS_FILTER
        from earnings_calendar import has_earnings_risk as _has_er_real
        has_earnings_risk = (lambda *a, **kw: False) if ABLATE_EARNINGS_FILTER else _has_er_real
        ranked_syms_iter = iter(s for s, _ in ranked)
        clean_top: list[str] = []
        for sym in raw_top:
            if has_earnings_risk(sym):
                log.info(f"  earnings veto: skipping {sym} (within 5 trading days of report)")
                continue
            clean_top.append(sym)
        # Top up with next-best to refill the slate if any were vetoed
        while len(clean_top) < top_n:
            try:
                next_sym = next(ranked_syms_iter)
            except StopIteration:
                break
            if next_sym in clean_top or next_sym in raw_top:
                continue
            if has_earnings_risk(next_sym):
                continue
            clean_top.append(next_sym)
        filtered_top = clean_top
        top_picks = set(filtered_top)
    except Exception as e:
        # Fail-open: if earnings calendar is unavailable, don't block trading
        log.warning(f"  earnings filter unavailable, no veto applied: {e}")
        filtered_top = raw_top
        top_picks = set(raw_top)

    log.info(f"  SPY 12m={spy_12m:+.1f}%  |  top picks ({len(top_picks)}): "
             f"{', '.join(sorted(top_picks))}")

    results: list[dict] = []
    positions = get_positions()
    now = datetime.now(timezone.utc)

    # ──────────── SELL leg ────────────
    for pos in positions:
        symbol = pos["symbol"]
        if _is_infrastructure(symbol):
            continue
        if symbol in top_picks:
            continue
        entry = _get_position_entry_date(symbol)
        if entry is None:
            continue
        days_held = _trading_days_between(entry, now)
        if days_held < min_hold:
            results.append({"symbol": symbol, "action": "SKIP_MIN_HOLD",
                            "days_held": days_held, "min": min_hold})
            continue
        if dry_run:
            results.append({"symbol": symbol, "action": "DRY_RUN_MOMENTUM_EXIT"})
            continue
        try:
            close_position(symbol)
            send_trade_alert(symbol, "sell", int(pos["qty"]), pos["current_price"],
                             f"Momentum rebalance — dropped from top-{top_n}")
            results.append({"symbol": symbol, "action": "MOMENTUM_EXIT"})
        except Exception as e:
            log.error(f"  {symbol}: momentum exit failed — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})

    # ──────────── BUY leg ────────────
    buy_leg_enabled = top_n > 0 and not params.get("block_new_buys", False)
    if buy_leg_enabled and not allow_new_exposure:
        log.warning("Momentum BUY leg skipped by market entry gate; exits remain active")
        results.extend(_entry_gate_blocked())
    elif buy_leg_enabled:
        try:
            acct = get_account()
            equity = acct.get("equity", 0.0)
        except Exception as e:
            log.error(f"Momentum BUY: account fetch failed — {e}")
            equity = 0.0

        if equity > 0:
            max_pct = params["max_position_pct"] / 100.0
            target_value = min(equity / max(top_n, 1) * 0.95, equity * max_pct)
            held_syms = {p["symbol"] for p in positions}
            # Use the post-earnings-veto slate, including replacement picks.
            # Iterating ranked[:top_n] here used to buy vetoed earnings names.
            for sym in filtered_top:
                if sym in held_syms:
                    continue
                try:
                    quote = get_latest_quote(sym)
                    price = quote["ask"] if quote["ask"] > 0 else quote["mid"]
                except Exception as e:
                    log.warning(f"  {sym}: quote failed — {e}")
                    continue
                qty = int(target_value / price)
                if qty <= 0:
                    continue
                validation = validate_order(sym, qty, "buy", price)
                if not validation["valid"]:
                    results.append({"symbol": sym, "action": "REJECTED",
                                    "reasons": validation["reasons"]})
                    continue
                if dry_run:
                    results.append({"symbol": sym, "action": "DRY_RUN_MOMENTUM_BUY",
                                    "qty": qty, "price": price})
                    continue
                try:
                    order = place_limit_order(
                        sym,
                        qty,
                        "buy",
                        price,
                        client_order_id=_execution_client_order_id(
                            "momentum", sym, "buy", today_ym
                        ),
                    )
                    send_trade_alert(sym, "buy", qty, price,
                                     f"Momentum top-{top_n} pick ({regime})")
                    results.append({"symbol": sym, "action": "MOMENTUM_BUY",
                                    "qty": qty, "price": price,
                                    "order_id": order["id"]})
                except Exception as e:
                    log.error(f"  {sym}: momentum buy failed — {e}")
                    results.append({"symbol": sym, "action": "ERROR", "reason": str(e)})

    # ──────────── persist month marker ────────────
    # If the market/clock gate blocked the BUY leg, do not mark the month done:
    # the next open-market run must retry the filtered slate.  Exit orders are
    # idempotent at the position level and remain intentionally allowed.
    if not dry_run and (allow_new_exposure or not buy_leg_enabled):
        perf["last_momentum_rebal_ym"] = today_ym
        save_json(PERFORMANCE_STATE, perf)

    return results


# ─────────────────── v4: SPY base + regime-transition flatten ───────────


def manage_base_position(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
    """v7 — maintain the structural base position at `base_pct` of equity.

    The base instrument is `params["base_instrument"]` — SPY or SSO.
    Different regimes use different instruments:
      • BULL/NORMAL    → SSO 60 % (≈1.2× effective beta)
      • NEUTRAL/NORMAL → SPY 40 % (deleveraged)
      • BEAR           → 0 %     (full cash)

    On any regime change that swaps the instrument, the stale base is
    liquidated first, then the target instrument is sized to target_pct.

    Base positions are exempt from sector cap, position-count cap, and the
    HALT block (they're structural infrastructure, not directional bets).
    """
    from portfolio import get_positions, get_account
    from research import get_latest_quote
    from trade import place_limit_order, close_position

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    target_pct = params.get("base_pct", params.get("spy_base_pct", 0.0))
    target_sym = params.get("base_instrument", SPY_BASE_SYMBOL)

    try:
        acct = get_account()
    except Exception as e:
        log.error(f"Base position: account fetch failed — {e}")
        return [{"action": "ERROR", "reason": f"account: {e}"}]

    equity = acct.get("equity", 0.0)
    if equity <= 0:
        return []

    positions = get_positions()
    held = {p["symbol"]: p for p in positions}
    results: list[dict] = []

    # Step 1: swap out any base position in a non-target instrument.
    for sym in BASE_CANDIDATES:
        if sym == target_sym:
            continue
        pos = held.get(sym)
        if pos is None:
            continue
        log.info(f"  Closing stale base {sym} ({pos['qty']:.0f} sh) — swap to {target_sym}")
        if dry_run:
            results.append({"symbol": sym, "action": "DRY_RUN_BASE_SWAP",
                            "qty": pos["qty"], "to": target_sym})
            continue
        try:
            close_result = close_position(
                sym,
                client_order_id=_execution_client_order_id(
                    "v11-migration", sym, "sell"
                ),
            )
            if close_result.get("status") == "submitted":
                results.append({"symbol": sym, "action": "BASE_SWAP_SUBMITTED",
                                "qty": pos["qty"], "to": target_sym,
                                "order_id": close_result.get("order_id")})
            elif close_result.get("status") == "pending":
                results.append({"symbol": sym, "action": "BASE_SWAP_PENDING",
                                **close_result})
            else:
                results.append({"symbol": sym, "action": "ERROR",
                                "reason": close_result.get(
                                    "error", "base swap not submitted"
                                )})
        except Exception as e:
            log.error(f"  {sym} swap-out failed — {e}")
            results.append({"symbol": sym, "action": "ERROR", "reason": str(e)})

    # Step 2: size the target instrument
    cur_pos = held.get(target_sym)
    cur_value = cur_pos["market_value"] if cur_pos else 0.0
    cur_pct = (cur_value / equity * 100.0) if equity > 0 else 0.0
    target_value = equity * (target_pct / 100.0)
    delta_value = target_value - cur_value
    delta_pct = abs(delta_value) / equity * 100.0 if equity > 0 else 0.0

    log.info(
        f"Base position: regime={regime} tier={risk_tier} target={target_pct:.1f}% "
        f"{target_sym} current={cur_pct:.1f}% delta=${delta_value:+,.0f} ({delta_pct:.1f}%)"
    )

    if target_pct == 0.0 and cur_pos:
        log.info(f"  Closing {target_sym} base ({cur_pos['qty']:.0f} sh)")
        if dry_run:
            results.append({"symbol": target_sym, "action": "DRY_RUN_BASE_EXIT",
                            "qty": cur_pos["qty"], "value": cur_value})
            return results
        try:
            close_result = close_position(
                target_sym,
                client_order_id=_execution_client_order_id(
                    "v11-migration", target_sym, "sell"
                ),
            )
            if close_result.get("status") == "submitted":
                results.append({"symbol": target_sym,
                                "action": "BASE_EXIT_SUBMITTED",
                                "qty": cur_pos["qty"],
                                "order_id": close_result.get("order_id")})
            elif close_result.get("status") == "pending":
                results.append({"symbol": target_sym,
                                "action": "BASE_EXIT_PENDING",
                                **close_result})
            else:
                results.append({"symbol": target_sym, "action": "ERROR",
                                "reason": close_result.get(
                                    "error", "base exit not submitted"
                                )})
        except Exception as e:
            log.error(f"  {target_sym} base exit failed — {e}")
            results.append({"symbol": target_sym, "action": "ERROR", "reason": str(e)})
        return results

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return results

    try:
        quote = get_latest_quote(target_sym)
        price = quote["ask"] if delta_value > 0 else quote["bid"]
        if price <= 0:
            price = quote["mid"]
    except Exception as e:
        log.error(f"  {target_sym} base: quote failed — {e}")
        results.append({"symbol": target_sym, "action": "ERROR", "reason": f"quote: {e}"})
        return results

    if delta_value > 0:
        if not allow_new_exposure:
            log.warning(f"  {target_sym} base BUY skipped by market entry gate")
            results.extend(_entry_gate_blocked())
            return results
        qty = int(delta_value / price)
        if qty < 1:
            return results
        if dry_run:
            log.info(f"  DRY RUN — would BUY {qty} {target_sym} @ ${price:.2f}")
            results.append({"symbol": target_sym, "action": "DRY_RUN_BASE_BUY",
                            "qty": qty, "price": price, "target_pct": target_pct})
            return results
        try:
            order = place_limit_order(
                target_sym,
                qty,
                "buy",
                price,
                client_order_id=_execution_client_order_id(
                    "base", target_sym, "buy"
                ),
            )
            log.info(f"  {target_sym} BASE BUY {qty} @ ${price:.2f}")
            results.append({"symbol": target_sym, "action": "BASE_BUY",
                            "qty": qty, "price": price, "target_pct": target_pct,
                            "order_id": order["id"]})
        except Exception as e:
            log.error(f"  {target_sym} base BUY failed — {e}")
            results.append({"symbol": target_sym, "action": "ERROR", "reason": str(e)})
        return results

    # Trim
    if cur_pos:
        trim_qty = int(abs(delta_value) / price)
        if trim_qty < 1:
            return results
        trim_qty = min(trim_qty, int(cur_pos["qty"]))
        if dry_run:
            log.info(f"  DRY RUN — would TRIM {trim_qty} {target_sym} @ ${price:.2f}")
            results.append({"symbol": target_sym, "action": "DRY_RUN_BASE_TRIM",
                            "qty": trim_qty, "price": price, "target_pct": target_pct})
            return results
        try:
            order = place_limit_order(target_sym, trim_qty, "sell",
                                      round(price * 0.999, 2),
                                      client_order_id=_execution_client_order_id(
                                          "base-trim", target_sym, "sell"
                                      ))
            log.info(f"  {target_sym} BASE TRIM {trim_qty} @ ${price:.2f}")
            results.append({"symbol": target_sym, "action": "BASE_TRIM",
                            "qty": trim_qty, "price": price, "target_pct": target_pct,
                            "order_id": order["id"]})
        except Exception as e:
            log.error(f"  {target_sym} base TRIM failed — {e}")
            results.append({"symbol": target_sym, "action": "ERROR", "reason": str(e)})

    return results


# v6-compat alias — call sites in run_execution still call manage_spy_base.
manage_spy_base = manage_base_position


# ─────────────────── v10d: TQQQ leveraged BULL overlay ────────────────────

TQQQ_SYMBOL = "TQQQ"


def _spy_above_sma50_and_sma200_live() -> bool:
    """Live mirror of backtest engine's TQQQ confirmation gate.

    Reads SPY benchmark from state/research.json which the pre-market
    routine refreshes daily. Falls back to False (no leverage) when data
    is missing — safer to be in cash than to lever blindly.
    """
    research = load_json(RESEARCH_STATE) or {}
    spy = research.get("spy", {}) or {}
    price = spy.get("price")
    sma50 = spy.get("sma_50")
    sma200 = spy.get("sma_200")
    if price is None or sma50 is None or sma200 is None:
        return False
    try:
        return float(price) > float(sma50) and float(price) > float(sma200)
    except (TypeError, ValueError):
        return False


def manage_tqqq_position(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
    """v10d — TQQQ leveraged overlay (3× QQQ) sized by regime.

    Reads `tqqq_pct` from strategy_config (BULL/NORMAL 80, NEUTRAL/NORMAL
    100, CAUTIOUS tiers smaller, BEAR 0).

    Three safety guards mirror the backtest engine's _manage_tqqq:
      1. Target is 0 unless tqqq_pct > 0 in the active regime cell.
      2. Even with target > 0, only opens when SPY > SMA50 AND SMA200.
      3. Hard circuit-breaker at entry × (1 − tqqq_stop_pct/100). The
         live engine relies on Alpaca trailing-stop orders for daily
         protection; the explicit check fires only on extreme gaps.

    The TQQQ position is marked is_base via strategy_metadata so it's
    exempt from the sector cap, max-positions count, and the HALT
    block — it's structural leverage, not a directional bet.
    """
    from portfolio import get_positions, get_account
    from research import get_latest_quote
    from trade import place_limit_order, close_position

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    target_pct = float(params.get("tqqq_pct", 0.0))

    # Confirmation gate — leverage only when both SMA lines clear
    if target_pct > 0 and not _spy_above_sma50_and_sma200_live():
        log.info(f"TQQQ: regime={regime} target was {target_pct:.1f}% but "
                 f"SMA50/SMA200 gate is off → target=0")
        target_pct = 0.0

    try:
        acct = get_account()
    except Exception as e:
        log.error(f"TQQQ: account fetch failed — {e}")
        return [{"action": "ERROR", "reason": f"account: {e}"}]

    equity = acct.get("equity", 0.0)
    if equity <= 0:
        return []

    positions = get_positions()
    held = {p["symbol"]: p for p in positions}
    results: list[dict] = []

    cur_pos = held.get(TQQQ_SYMBOL)
    cur_value = cur_pos["market_value"] if cur_pos else 0.0
    cur_pct = (cur_value / equity * 100.0) if equity > 0 else 0.0
    target_value = equity * (target_pct / 100.0)
    delta_value = target_value - cur_value
    delta_pct = abs(delta_value) / equity * 100.0 if equity > 0 else 0.0

    log.info(
        f"TQQQ: regime={regime} tier={risk_tier} target={target_pct:.1f}% "
        f"current={cur_pct:.1f}% delta=${delta_value:+,.0f} ({delta_pct:.1f}%)"
    )

    # Exit if target is 0 (gate off, or regime moved to BEAR)
    if target_pct == 0.0 and cur_pos:
        if dry_run:
            results.append({"symbol": TQQQ_SYMBOL, "action": "DRY_RUN_TQQQ_EXIT",
                            "qty": cur_pos["qty"], "value": cur_value})
            return results
        try:
            close_result = close_position(
                TQQQ_SYMBOL,
                client_order_id=_execution_client_order_id(
                    "v11-migration", TQQQ_SYMBOL, "sell"
                ),
            )
            if close_result.get("status") == "submitted":
                results.append(
                    {
                        "symbol": TQQQ_SYMBOL,
                        "action": "TQQQ_EXIT_SUBMITTED",
                        "qty": cur_pos["qty"],
                        "order_id": close_result.get("order_id"),
                    }
                )
            elif close_result.get("status") == "pending":
                results.append(
                    {
                        "symbol": TQQQ_SYMBOL,
                        "action": "TQQQ_EXIT_PENDING",
                        **close_result,
                    }
                )
            else:
                results.append(
                    {
                        "symbol": TQQQ_SYMBOL,
                        "action": "ERROR",
                        "reason": close_result.get("error", "exit not submitted"),
                    }
                )
        except Exception as e:
            log.error(f"  TQQQ exit failed — {e}")
            results.append({"symbol": TQQQ_SYMBOL, "action": "ERROR",
                            "reason": str(e)})
        return results

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return results

    try:
        quote = get_latest_quote(TQQQ_SYMBOL)
        price = quote["ask"] if delta_value > 0 else quote["bid"]
        if price <= 0:
            price = quote["mid"]
    except Exception as e:
        log.error(f"  TQQQ quote failed — {e}")
        results.append({"symbol": TQQQ_SYMBOL, "action": "ERROR",
                        "reason": f"quote: {e}"})
        return results

    if delta_value > 0:
        if not allow_new_exposure:
            log.warning("  TQQQ BUY skipped by market entry gate")
            results.extend(_entry_gate_blocked())
            return results
        qty = int(delta_value / price)
        if qty < 1:
            return results
        if dry_run:
            log.info(f"  DRY RUN — would BUY {qty} TQQQ @ ${price:.2f}")
            results.append({"symbol": TQQQ_SYMBOL, "action": "DRY_RUN_TQQQ_BUY",
                            "qty": qty, "price": price, "target_pct": target_pct})
            return results
        try:
            order = place_limit_order(
                TQQQ_SYMBOL,
                qty,
                "buy",
                price,
                client_order_id=_execution_client_order_id(
                    "tqqq", TQQQ_SYMBOL, "buy"
                ),
            )
            import strategy_metadata as sm
            sm.mark_position(TQQQ_SYMBOL, "base")  # exempts from caps + HALT
            log.info(f"  TQQQ BUY {qty} @ ${price:.2f}")
            results.append({"symbol": TQQQ_SYMBOL, "action": "TQQQ_BUY",
                            "qty": qty, "price": price, "target_pct": target_pct,
                            "order_id": order["id"]})
        except Exception as e:
            log.error(f"  TQQQ BUY failed — {e}")
            results.append({"symbol": TQQQ_SYMBOL, "action": "ERROR",
                            "reason": str(e)})
        return results

    # Trim
    if cur_pos:
        trim_qty = int(abs(delta_value) / price)
        if trim_qty < 1:
            return results
        trim_qty = min(trim_qty, int(cur_pos["qty"]))
        if dry_run:
            results.append({"symbol": TQQQ_SYMBOL, "action": "DRY_RUN_TQQQ_TRIM",
                            "qty": trim_qty, "price": price, "target_pct": target_pct})
            return results
        try:
            order = place_limit_order(TQQQ_SYMBOL, trim_qty, "sell",
                                      round(price * 0.999, 2),
                                      client_order_id=_execution_client_order_id(
                                          "tqqq-trim", TQQQ_SYMBOL, "sell"
                                      ))
            log.info(f"  TQQQ TRIM {trim_qty} @ ${price:.2f}")
            results.append({"symbol": TQQQ_SYMBOL, "action": "TQQQ_TRIM",
                            "qty": trim_qty, "price": price, "target_pct": target_pct,
                            "order_id": order["id"]})
        except Exception as e:
            log.error(f"  TQQQ TRIM failed — {e}")
            results.append({"symbol": TQQQ_SYMBOL, "action": "ERROR",
                            "reason": str(e)})

    return results


def manage_upro_position(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
    """v10f — UPRO (3× SPY) parallel sleeve, mirrors manage_tqqq_position.

    Same SMA50+SMA200 gate as TQQQ. Reads `upro_pct` from strategy_config
    (BULL/NEUTRAL 25, CAUTIOUS slightly lower, BEAR 0).
    """
    from portfolio import get_positions, get_account
    from research import get_latest_quote
    from trade import place_limit_order, close_position

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    target_pct = float(params.get("upro_pct", 0.0))

    if target_pct > 0 and not _spy_above_sma50_and_sma200_live():
        log.info(f"UPRO: regime={regime} target was {target_pct:.1f}% but "
                 f"SMA50/SMA200 gate is off → target=0")
        target_pct = 0.0

    try:
        acct = get_account()
    except Exception as e:
        log.error(f"UPRO: account fetch failed — {e}")
        return [{"action": "ERROR", "reason": f"account: {e}"}]

    equity = acct.get("equity", 0.0)
    if equity <= 0:
        return []

    positions = get_positions()
    held = {p["symbol"]: p for p in positions}
    results: list[dict] = []

    cur_pos = held.get(UPRO_BASE_SYMBOL)
    cur_value = cur_pos["market_value"] if cur_pos else 0.0
    cur_pct = (cur_value / equity * 100.0) if equity > 0 else 0.0
    target_value = equity * (target_pct / 100.0)
    delta_value = target_value - cur_value
    delta_pct = abs(delta_value) / equity * 100.0 if equity > 0 else 0.0

    log.info(
        f"UPRO: regime={regime} tier={risk_tier} target={target_pct:.1f}% "
        f"current={cur_pct:.1f}% delta=${delta_value:+,.0f} ({delta_pct:.1f}%)"
    )

    if target_pct == 0.0 and cur_pos:
        if dry_run:
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "DRY_RUN_UPRO_EXIT",
                            "qty": cur_pos["qty"], "value": cur_value})
            return results
        try:
            close_result = close_position(
                UPRO_BASE_SYMBOL,
                client_order_id=_execution_client_order_id(
                    "v11-migration", UPRO_BASE_SYMBOL, "sell"
                ),
            )
            if close_result.get("status") == "submitted":
                results.append(
                    {
                        "symbol": UPRO_BASE_SYMBOL,
                        "action": "UPRO_EXIT_SUBMITTED",
                        "qty": cur_pos["qty"],
                        "order_id": close_result.get("order_id"),
                    }
                )
            elif close_result.get("status") == "pending":
                results.append(
                    {
                        "symbol": UPRO_BASE_SYMBOL,
                        "action": "UPRO_EXIT_PENDING",
                        **close_result,
                    }
                )
            else:
                results.append(
                    {
                        "symbol": UPRO_BASE_SYMBOL,
                        "action": "ERROR",
                        "reason": close_result.get("error", "exit not submitted"),
                    }
                )
        except Exception as e:
            log.error(f"  UPRO exit failed — {e}")
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "ERROR",
                            "reason": str(e)})
        return results

    if delta_pct < BASE_REBALANCE_THRESHOLD_PCT:
        return results

    try:
        quote = get_latest_quote(UPRO_BASE_SYMBOL)
        price = quote["ask"] if delta_value > 0 else quote["bid"]
        if price <= 0:
            price = quote["mid"]
    except Exception as e:
        log.error(f"  UPRO quote failed — {e}")
        results.append({"symbol": UPRO_BASE_SYMBOL, "action": "ERROR",
                        "reason": f"quote: {e}"})
        return results

    if delta_value > 0:
        if not allow_new_exposure:
            log.warning("  UPRO BUY skipped by market entry gate")
            results.extend(_entry_gate_blocked())
            return results
        qty = int(delta_value / price)
        if qty < 1:
            return results
        if dry_run:
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "DRY_RUN_UPRO_BUY",
                            "qty": qty, "price": price, "target_pct": target_pct})
            return results
        try:
            order = place_limit_order(
                UPRO_BASE_SYMBOL,
                qty,
                "buy",
                price,
                client_order_id=_execution_client_order_id(
                    "upro", UPRO_BASE_SYMBOL, "buy"
                ),
            )
            import strategy_metadata as sm
            sm.mark_position(UPRO_BASE_SYMBOL, "base")
            log.info(f"  UPRO BUY {qty} @ ${price:.2f}")
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "UPRO_BUY",
                            "qty": qty, "price": price, "target_pct": target_pct,
                            "order_id": order["id"]})
        except Exception as e:
            log.error(f"  UPRO BUY failed — {e}")
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "ERROR",
                            "reason": str(e)})
        return results

    if cur_pos:
        trim_qty = int(abs(delta_value) / price)
        if trim_qty < 1:
            return results
        trim_qty = min(trim_qty, int(cur_pos["qty"]))
        if dry_run:
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "DRY_RUN_UPRO_TRIM",
                            "qty": trim_qty, "price": price, "target_pct": target_pct})
            return results
        try:
            order = place_limit_order(UPRO_BASE_SYMBOL, trim_qty, "sell",
                                      round(price * 0.999, 2),
                                      client_order_id=_execution_client_order_id(
                                          "upro-trim", UPRO_BASE_SYMBOL, "sell"
                                      ))
            log.info(f"  UPRO TRIM {trim_qty} @ ${price:.2f}")
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "UPRO_TRIM",
                            "qty": trim_qty, "price": price, "target_pct": target_pct,
                            "order_id": order["id"]})
        except Exception as e:
            log.error(f"  UPRO TRIM failed — {e}")
            results.append({"symbol": UPRO_BASE_SYMBOL, "action": "ERROR",
                            "reason": str(e)})

    return results


def manage_regime_transition(dry_run: bool = False) -> list[dict]:
    """v8 — close all directional positions on CONFIRMED BULL→NEUTRAL/BEAR
    using **asymmetric** confirmation windows:
      • Entering BULL: ENTRY days (default 1)  — fast
      • Exiting  BULL: EXIT  days (default 3)  — slow

    Walk-forward W2/W3 showed −16 pp/yr OOS alpha from 3-day-delayed entry
    into BULL after the 2022 bottom + 2023 H1 rally. Fast entry recovers
    most of that without re-introducing daily-flip churn (slow exit
    keeps the flatten path stable).

    State persisted to `state/performance.json`:
      • regime_history: last max(ENTRY, EXIT) raw-regime strings
      • last_confirmed_regime: the regime once confirmed
    """
    from portfolio import get_positions
    from trade import close_position
    from notify import send_trade_alert
    from strategy_config import (
        REGIME_CONFIRMATION_DAYS_ENTRY,
        REGIME_CONFIRMATION_DAYS_EXIT,
    )

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    params = get_strategy_params(regime, risk_tier)

    perf = load_json(PERFORMANCE_STATE) or {}
    buffer_size = max(REGIME_CONFIRMATION_DAYS_ENTRY, REGIME_CONFIRMATION_DAYS_EXIT)
    history: list[str] = perf.get("regime_history", []) or []
    history.append(regime)
    history = history[-buffer_size:]

    prev_confirmed = perf.get("last_confirmed_regime")
    if prev_confirmed is None:
        confirmed = regime  # bootstrap
    elif regime == prev_confirmed:
        confirmed = prev_confirmed
    else:
        # Transition candidate — apply the right window
        is_entering_bull = (regime == "BULL")
        window = (REGIME_CONFIRMATION_DAYS_ENTRY if is_entering_bull
                  else REGIME_CONFIRMATION_DAYS_EXIT)
        recent = history[-window:]
        if len(recent) >= window and all(r == regime for r in recent):
            confirmed = regime
        else:
            confirmed = prev_confirmed

    # Always persist forward
    if not dry_run:
        perf["regime_history"] = history
        perf["last_confirmed_regime"] = confirmed
        perf["previous_regime"] = regime  # legacy field — kept for back-compat
        save_json(PERFORMANCE_STATE, perf)

    if not params.get("flatten_on_transition", False):
        return []
    if prev_confirmed != "BULL" or confirmed not in ("NEUTRAL", "BEAR"):
        return []

    positions = get_positions()
    to_flatten = [p for p in positions if not _is_infrastructure(p["symbol"])]
    if not to_flatten:
        return []

    log.info(f"Confirmed regime {prev_confirmed} → {confirmed}: flattening "
             f"{len(to_flatten)} directional positions")

    results = []
    for pos in to_flatten:
        symbol = pos["symbol"]
        pnl_pct = pos.get("unrealized_plpc", 0.0)
        if dry_run:
            log.info(f"  DRY RUN — would FLATTEN {symbol} at {pnl_pct:+.1f}%")
            results.append({"symbol": symbol, "action": "DRY_RUN_FLATTEN",
                            "pnl_pct": pnl_pct})
            continue
        try:
            result = close_position(symbol)
            send_trade_alert(symbol, "sell", int(pos["qty"]), pos["current_price"],
                             f"Flatten on {prev_confirmed}→{confirmed} transition "
                             f"(pnl {pnl_pct:+.1f}%)")
            results.append({"symbol": symbol, "action": "FLATTEN",
                            "pnl_pct": pnl_pct, **result})
        except Exception as e:
            log.error(f"  {symbol}: flatten close failed — {e}")
            results.append({"symbol": symbol, "action": "ERROR", "reason": str(e)})

    return results


# ────────────────────────── bear hedge management ────────────────────────


def manage_bear_hedge(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
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
            result = close_position(
                HEDGE_SYMBOL,
                client_order_id=_execution_client_order_id(
                    "v11-migration", HEDGE_SYMBOL, "sell"
                ),
            )
            if result.get("status") == "pending":
                return [{"symbol": HEDGE_SYMBOL,
                         "action": "HEDGE_EXIT_PENDING", **result}]
            if result.get("status") != "submitted":
                return [{"symbol": HEDGE_SYMBOL, "action": "ERROR",
                         "reason": result.get(
                             "error", "hedge exit not submitted"
                         )}]
            send_trade_alert(
                HEDGE_SYMBOL, "sell", int(sh_pos["qty"]), sh_pos["current_price"],
                f"Hedge exit ({regime}/{risk_tier})",
            )
            return [{"symbol": HEDGE_SYMBOL, "action": "HEDGE_EXIT_SUBMITTED",
                     "qty": sh_pos["qty"], **result}]
        except Exception as e:
            log.error(f"  Hedge exit failed — {e}")
            return [{"symbol": HEDGE_SYMBOL, "action": "ERROR", "reason": str(e)}]

    # Case 2: not enough drift to bother (avoid commission churn on real account)
    if delta_pct < HEDGE_REBALANCE_THRESHOLD_PCT:
        return []

    # Case 3: need to ADD hedge (delta positive = buy more SH)
    if delta_value > 0:
        if not allow_new_exposure:
            log.warning("  SH hedge BUY skipped by market entry gate")
            return _entry_gate_blocked()
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
            order = place_limit_order(
                HEDGE_SYMBOL,
                qty,
                "buy",
                price,
                client_order_id=_execution_client_order_id(
                    "bear-hedge", HEDGE_SYMBOL, "buy"
                ),
            )
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
            order = place_limit_order(
                HEDGE_SYMBOL,
                trim_qty,
                "sell",
                round(price * 0.999, 2),
                client_order_id=_execution_client_order_id(
                    "bear-hedge-trim", HEDGE_SYMBOL, "sell"
                ),
            )
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


# ──────────────────────── Mean reversion overlay ───────────────────────────


def execute_mr_buys(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
    """Open MR positions in NEUTRAL/BEAR regimes within sleeve cap."""
    from ablation_flags import ABLATE_MEAN_REV
    if ABLATE_MEAN_REV:
        return []
    from mean_reversion import (
        find_candidates as mr_find_candidates,
        mr_position_size, is_active as mr_is_active,
        MR_SLEEVE_PCT,
    )
    import strategy_metadata as sm
    from portfolio import get_positions, get_account
    from research import get_latest_quote
    from trade import place_limit_order

    if not allow_new_exposure:
        log.warning("Mean-reversion buys skipped by market entry gate")
        return _entry_gate_blocked()

    regime = get_market_regime()
    risk_tier = get_risk_tier()
    if risk_tier == "HALT" or not mr_is_active(regime):
        return []

    research = load_json(RESEARCH_STATE)
    spy_20d = research.get("spy", {}).get("twenty_day_return", 0.0)

    symbol_technicals: dict[str, dict] = {}
    symbol_sectors: dict[str, str | None] = {}
    for sym, data in research.get("symbols", {}).items():
        if "error" in data:
            continue
        symbol_technicals[sym] = data.get("technicals", {})
        symbol_sectors[sym] = data.get("info", {}).get("sector")

    candidates = mr_find_candidates(symbol_technicals, symbol_sectors,
                                    regime, spy_20d_return=spy_20d)
    if not candidates:
        return []

    try:
        acct = get_account()
        equity = acct["equity"]
        cash = acct["cash"]
    except Exception as e:
        log.error(f"MR: failed to get account — {e}")
        return [{"action": "ERROR", "reason": str(e)}]

    positions = get_positions()
    held = {p["symbol"] for p in positions}
    by_strategy = sm.positions_by_strategy()
    mr_symbols = set(by_strategy.get("mr", []))
    sleeve_committed = sum(
        p["market_value"] for p in positions if p["symbol"] in mr_symbols
    )

    log.info(f"MR scan ({regime}): {len(candidates)} candidates, "
             f"sleeve committed ${sleeve_committed:,.0f} / "
             f"${equity * MR_SLEEVE_PCT / 100:,.0f}")

    results = []
    for c in candidates[:5]:  # cap top-5 per cycle
        if c.symbol in held:
            continue  # already a momentum/MR/PEAD position — skip

        try:
            quote = get_latest_quote(c.symbol)
            price = quote["ask"] if quote["ask"] > 0 else quote["mid"]
        except Exception as e:
            log.warning(f"  MR {c.symbol}: quote failed — {e}")
            continue

        qty = mr_position_size(equity, price, sleeve_committed)
        if qty <= 0:
            continue

        cost = qty * price
        if cost > cash:
            continue

        if dry_run:
            results.append({"symbol": c.symbol, "action": "DRY_RUN_MR_BUY",
                            "qty": qty, "price": price, "score": c.score})
            continue

        try:
            order = place_limit_order(
                c.symbol,
                qty,
                "buy",
                price,
                client_order_id=_execution_client_order_id(
                    "mean-reversion", c.symbol, "buy"
                ),
            )
            sm.mark_position(c.symbol, "mr")
            sleeve_committed += cost
            cash -= cost
            log.info(f"  MR BUY {qty} {c.symbol} @ ${price:.2f} (score {c.score:.2f})")
            results.append({"symbol": c.symbol, "action": "MR_BUY",
                            "qty": qty, "price": price, "score": c.score,
                            "order_id": order["id"]})
        except Exception as e:
            log.error(f"  MR {c.symbol}: order failed — {e}")
            results.append({"symbol": c.symbol, "action": "ERROR",
                            "reason": str(e)})

    return results


def execute_mr_exits(dry_run: bool = False) -> list[dict]:
    """Close MR positions on target / stop / RSI bounce / time-stop."""
    from mean_reversion import should_exit_mr
    import strategy_metadata as sm
    from portfolio import get_positions
    from trade import close_position

    research = load_json(RESEARCH_STATE)
    positions = get_positions()
    by_strategy = sm.positions_by_strategy()
    mr_symbols = set(by_strategy.get("mr", []))

    results = []
    for pos in positions:
        symbol = pos["symbol"]
        if symbol not in mr_symbols:
            continue

        rsi = research.get("symbols", {}).get(symbol, {}).get("technicals", {}).get("rsi_14")
        held = sm.days_held(symbol) or 0
        pnl_pct = pos["unrealized_plpc"]

        should_exit, reason = should_exit_mr(pnl_pct, rsi, held)
        if not should_exit:
            continue

        if dry_run:
            results.append({"symbol": symbol, "action": "DRY_RUN_MR_EXIT",
                            "reason": reason, "pnl_pct": pnl_pct})
            continue

        try:
            r = close_position(symbol)
            sm.unmark_position(symbol)
            log.info(f"  MR EXIT {symbol}: {reason}")
            results.append({"symbol": symbol, "action": "MR_EXIT",
                            "reason": reason, "pnl_pct": pnl_pct,
                            "order_id": r.get("order_id")})
        except Exception as e:
            log.error(f"  MR exit {symbol} failed: {e}")
            results.append({"symbol": symbol, "action": "ERROR",
                            "reason": str(e)})

    return results


# ──────────────────────────── PEAD overlay ─────────────────────────────────


def execute_pead_buys(
    dry_run: bool = False,
    allow_new_exposure: bool = True,
) -> list[dict]:
    """PEAD = Post-Earnings Announcement Drift. Buys 1-2 days after a beat.

    Reads `state/earnings_surprises.json` (refreshed by Perplexity in
    pre-market routine). Falls back to price-action proxy if data is
    missing — yesterday's close > 3% above prior close + volume > 2× avg
    + earnings 1-2 days ago counts as a "soft beat".
    """
    from ablation_flags import ABLATE_PEAD
    if ABLATE_PEAD:
        return []
    from pead_strategy import is_pead_setup, score_pead
    from earnings_calendar import load_calendar
    import strategy_metadata as sm
    from portfolio import get_positions, get_account
    from research import get_latest_quote
    from trade import place_limit_order

    if not allow_new_exposure:
        log.warning("PEAD buys skipped by market entry gate")
        return _entry_gate_blocked()

    if get_risk_tier() == "HALT":
        return []

    surprises = load_json(STATE_DIR / "earnings_surprises.json") or {}
    cal = load_calendar()

    research = load_json(RESEARCH_STATE)
    positions = get_positions()
    held = {p["symbol"] for p in positions}

    try:
        acct = get_account()
        equity = acct["equity"]
        cash = acct["cash"]
    except Exception:
        return []

    # PEAD sleeve cap — 15% of equity, 3% per position
    PEAD_SLEEVE_PCT = 15.0
    PEAD_POSITION_PCT = 3.0
    by_strategy = sm.positions_by_strategy()
    pead_symbols = set(by_strategy.get("pead", []))
    sleeve_committed = sum(
        p["market_value"] for p in positions if p["symbol"] in pead_symbols
    )
    sleeve_remaining = equity * PEAD_SLEEVE_PCT / 100 - sleeve_committed

    results = []
    for sym, data in research.get("symbols", {}).items():
        if "error" in data or sym in held:
            continue
        if sleeve_remaining <= 0:
            break

        # Look up earnings recency
        # Try days_until: a recent earnings means it would be in the past
        # (negative) so we estimate days_since via opposite logic
        sym_cal = cal.get("dates", {}).get(sym)
        days_since: int | None = None
        if sym_cal:
            try:
                next_er = datetime.strptime(sym_cal, "%Y-%m-%d").date()
                # next earnings ~90 days out implies last was ~90 days ago
                today_d = datetime.now().date()
                if next_er > today_d:
                    # Look at distance from the typical 90d cycle
                    quarter = 91
                    days_since = quarter - (next_er - today_d).days
                    if days_since < 0 or days_since > 14:
                        days_since = None
            except ValueError:
                pass

        # Surprise data (Perplexity-fetched) takes precedence
        info = surprises.get(sym, {})
        eps_surprise_pct = info.get("eps_surprise_pct")
        gap_up_pct = info.get("gap_up_pct")
        volume_ratio_post = info.get("volume_ratio")
        days_since_earnings = info.get("days_since") if info else days_since

        # Price-action proxy if no explicit data
        tech = data.get("technicals", {})
        if eps_surprise_pct is None:
            # Use 5d return > +5% as proxy for "stock reacted positively"
            five_d = tech.get("five_day_return", 0)
            if five_d > 5:
                eps_surprise_pct = 6.0  # proxy
        if gap_up_pct is None:
            five_d = tech.get("five_day_return", 0)
            if five_d > 3:
                gap_up_pct = 4.0  # proxy
        if volume_ratio_post is None:
            volume_ratio_post = tech.get("volume_ratio")

        if not is_pead_setup(eps_surprise_pct, gap_up_pct,
                             volume_ratio_post, days_since_earnings):
            continue

        score = score_pead(eps_surprise_pct, gap_up_pct, volume_ratio_post)

        try:
            quote = get_latest_quote(sym)
            price = quote["ask"] if quote["ask"] > 0 else quote["mid"]
        except Exception:
            continue

        per_pos_dollars = min(equity * PEAD_POSITION_PCT / 100, sleeve_remaining)
        qty = max(0, int(per_pos_dollars / price))
        if qty <= 0 or qty * price > cash:
            continue

        if dry_run:
            results.append({"symbol": sym, "action": "DRY_RUN_PEAD_BUY",
                            "qty": qty, "score": score})
            continue

        try:
            order = place_limit_order(
                sym,
                qty,
                "buy",
                price,
                client_order_id=_execution_client_order_id(
                    "pead", sym, "buy"
                ),
            )
            sm.mark_position(sym, "pead")
            sleeve_remaining -= qty * price
            cash -= qty * price
            log.info(f"  PEAD BUY {qty} {sym} @ ${price:.2f} (score {score:.2f})")
            results.append({"symbol": sym, "action": "PEAD_BUY",
                            "qty": qty, "score": score, "order_id": order["id"]})
        except Exception as e:
            results.append({"symbol": sym, "action": "ERROR", "reason": str(e)})

    return results


def execute_pead_exits(dry_run: bool = False) -> list[dict]:
    """Close PEAD positions on target / stop / 10d time-stop."""
    from pead_strategy import should_exit_pead
    import strategy_metadata as sm
    from portfolio import get_positions
    from trade import close_position

    positions = get_positions()
    by_strategy = sm.positions_by_strategy()
    pead_symbols = set(by_strategy.get("pead", []))

    results = []
    for pos in positions:
        symbol = pos["symbol"]
        if symbol not in pead_symbols:
            continue
        held = sm.days_held(symbol) or 0
        pnl_pct = pos["unrealized_plpc"]
        should_exit, reason = should_exit_pead(pnl_pct, held)
        if not should_exit:
            continue
        if dry_run:
            results.append({"symbol": symbol, "action": "DRY_RUN_PEAD_EXIT",
                            "reason": reason, "pnl_pct": pnl_pct})
            continue
        try:
            r = close_position(symbol)
            sm.unmark_position(symbol)
            log.info(f"  PEAD EXIT {symbol}: {reason}")
            results.append({"symbol": symbol, "action": "PEAD_EXIT",
                            "reason": reason, "pnl_pct": pnl_pct,
                            "order_id": r.get("order_id")})
        except Exception as e:
            results.append({"symbol": symbol, "action": "ERROR",
                            "reason": str(e)})

    return results


# ───────────────────────────── orchestration ──────────────────────────────


def _infrastructure_migration_status() -> dict:
    """Reconcile v11's zero-target legacy infrastructure migration.

    Adaptive stock buys remain blocked until old leveraged/base/hedge
    positions are absent *and* their broker orders have reached terminal
    states.  A read failure is fail-closed but does not prevent exit routines
    from running.
    """

    from portfolio import get_positions
    from trade import list_open_orders

    migration_symbols = {
        SPY_BASE_SYMBOL,
        SSO_BASE_SYMBOL,
        TQQQ_BASE_SYMBOL,
        UPRO_BASE_SYMBOL,
        HEDGE_SYMBOL,
    }
    try:
        held_symbols = []
        for position in get_positions():
            symbol = str(position.get("symbol", ""))
            quantity = float(position.get("qty", 0.0) or 0.0)
            if not math.isfinite(quantity):
                raise ValueError(f"non-finite position quantity for {symbol}")
            if symbol in migration_symbols and abs(quantity) > 1e-9:
                held_symbols.append(symbol)
        held_symbols.sort()
        open_orders = []
        for order in list_open_orders():
            symbol = str(order.get("symbol", ""))
            remaining = float(order.get("remaining_qty", 0.0) or 0.0)
            if not math.isfinite(remaining) or remaining < 0:
                raise ValueError(f"invalid remaining order quantity for {symbol}")
            if symbol in migration_symbols and remaining > 1e-9:
                open_orders.append(order)
    except Exception as exc:
        return {
            "pending": True,
            "held_symbols": [],
            "open_order_ids": [],
            "reason": f"infrastructure reconciliation unavailable: {exc}",
        }
    pending = bool(held_symbols or open_orders)
    return {
        "pending": pending,
        "held_symbols": held_symbols,
        "open_order_ids": sorted(str(order.get("id")) for order in open_orders),
        "reason": (
            "legacy infrastructure positions/orders must settle before adaptive buys"
            if pending
            else "legacy infrastructure migration converged"
        ),
    }


def run_execution(dry_run: bool = False) -> dict:
    """Capture one fresh risk tier, then use it consistently for this run."""

    if not dry_run:
        require_paper_trading_mode()
    risk_snapshot = _capture_execution_risk_snapshot()
    token = _EXECUTION_RISK_TIER.set(str(risk_snapshot["tier"]))
    try:
        return _run_execution_with_risk_snapshot(
            dry_run=dry_run,
            risk_snapshot=risk_snapshot,
        )
    finally:
        _EXECUTION_RISK_TIER.reset(token)


def _run_execution_with_risk_snapshot(
    *,
    dry_run: bool,
    risk_snapshot: dict,
) -> dict:
    """Main execution routine — full sequence of trade logic.

    A non-dry run is paper-only and checks a fresh, open Alpaca clock before
    any path may add exposure.  A failed entry gate does *not* abort the
    routine: stop-losses, trims, strategy exits, and flattening continue.
    """
    log.info(f"{'='*60}")
    log.info(f"TRADE EXECUTION — {get_now_str()}")
    log.info(f"{'='*60}")

    active_regime = get_market_regime()
    active_params = get_strategy_params(active_regime, get_risk_tier())
    adaptive_mode = bool(active_params.get("adaptive_momentum", False))
    short_preflight = (
        _reconcile_v11_short_positions(dry_run=dry_run)
        if adaptive_mode
        else []
    )
    if short_preflight:
        reason = (
            "V11 short-position reconciliation blocks every other strategy "
            "action until a fresh broker snapshot is flat"
        )
        log.warning(reason)
        return {
            "timestamp": get_now_str(),
            "regime": active_regime,
            "risk_tier": get_risk_tier(),
            "entry_gate": {
                "allowed": False,
                "reason": reason,
                "risk_snapshot": risk_snapshot,
            },
            "safety_preflight": short_preflight,
            "stop_losses": [],
            "tightened_stops": [],
            "scale_outs": [],
            "sells": [],
            "hedge": [],
            "options_hedge": [],
            "momentum_picks": [],
            "infrastructure_migration": {
                "pending": True,
                "held_symbols": [],
                "open_order_ids": [],
                "reason": reason,
            },
            "buys": [],
            "mr_buys": [],
            "mr_exits": [],
            "pead_buys": [],
            "pead_exits": [],
            "time_stops": [],
            "dry_run": dry_run,
        }
    validation_gate = _v11_validation_gate() if adaptive_mode else None

    from trade import (
        execute_stop_losses,
        get_market_entry_gate,
        sync_trailing_stops,
    )

    if dry_run:
        entry_gate = {
            "allowed": True,
            "reason": (
                "dry-run/shadow-only preview; no orders may be submitted"
                if adaptive_mode and not validation_gate["passed"]
                else "dry-run preview; no orders may be submitted"
            ),
        }
        if validation_gate is not None:
            entry_gate["validation"] = validation_gate
            entry_gate["shadow_only"] = not validation_gate["passed"]
        entry_gate["risk_snapshot"] = risk_snapshot
    else:
        broker_entry_gate = get_market_entry_gate()
        entry_gate = dict(broker_entry_gate)
        entry_gate["risk_snapshot"] = risk_snapshot
        if not risk_snapshot.get("available", False):
            entry_gate["broker_allowed"] = bool(broker_entry_gate["allowed"])
            entry_gate["allowed"] = False
            entry_gate["reason"] = (
                f"{risk_snapshot['reason']}; new exposure blocked; "
                "risk-reducing exits remain enabled"
            )
        elif risk_snapshot.get("tier") == "HALT":
            entry_gate["broker_allowed"] = bool(broker_entry_gate["allowed"])
            entry_gate["allowed"] = False
            entry_gate["reason"] = (
                "fresh account snapshot triggered HALT; new exposure blocked; "
                "zero-target exits remain enabled"
            )
        if validation_gate is not None:
            entry_gate.setdefault(
                "broker_allowed", bool(broker_entry_gate["allowed"])
            )
            entry_gate["validation"] = validation_gate
            entry_gate["shadow_only"] = not validation_gate["passed"]
            entry_gate["allowed"] = bool(
                broker_entry_gate["allowed"]
                and validation_gate["passed"]
                and risk_snapshot.get("available", False)
                and risk_snapshot.get("tier") != "HALT"
            )
            if not validation_gate["passed"]:
                entry_gate["reason"] = (
                    f"{validation_gate['reason']}; new adaptive exposure blocked; "
                    "risk-reducing exits and pending-buy cancellation remain enabled"
                )
        if entry_gate["allowed"]:
            log.info(f"New-exposure gate OPEN: {entry_gate['reason']}")
        else:
            log.warning(
                f"New-exposure gate CLOSED: {entry_gate['reason']}. "
                "Risk-reducing exits remain enabled."
            )
    allow_new_exposure = bool(entry_gate["allowed"])
    buy_preflight = (
        _reconcile_v11_open_buys_preflight(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
        if adaptive_mode
        else []
    )
    if buy_preflight:
        reason = (
            "V11 open-BUY reconciliation blocks every other strategy action "
            "until a fresh broker snapshot confirms the boundary"
        )
        log.warning(reason)
        return {
            "timestamp": get_now_str(),
            "regime": active_regime,
            "risk_tier": get_risk_tier(),
            "entry_gate": {**entry_gate, "allowed": False, "reason": reason},
            "safety_preflight": buy_preflight,
            "stop_losses": [],
            "tightened_stops": [],
            "scale_outs": [],
            "sells": [],
            "hedge": [],
            "options_hedge": [],
            "momentum_picks": [],
            "infrastructure_migration": {
                "pending": True,
                "held_symbols": [],
                "open_order_ids": [],
                "reason": reason,
            },
            "buys": [],
            "mr_buys": [],
            "mr_exits": [],
            "pead_buys": [],
            "pead_exits": [],
            "time_stops": [],
            "dry_run": dry_run,
        }
    infrastructure_preflight = (
        _cancel_v11_infrastructure_buys(dry_run=dry_run)
        if adaptive_mode
        else []
    )
    if infrastructure_preflight:
        allow_new_exposure = False
        log.warning(
            "Legacy infrastructure BUY cancellation requires an invocation boundary"
        )

    stops = [] if adaptive_mode else execute_stop_losses(dry_run=dry_run)
    if stops:
        log.info(f"Stop-losses triggered: {len(stops)}")

    synced = [] if adaptive_mode else sync_trailing_stops(dry_run=dry_run)
    if synced:
        log.info(f"Trailing stops synced: {len(synced)}")

    tightened = [] if adaptive_mode else tighten_stops_in_profit(dry_run=dry_run)
    if tightened:
        log.info(f"Stops tightened: {len([t for t in tightened if t.get('action') == 'TIGHTEN'])}")

    scale_outs = [] if adaptive_mode else execute_scale_outs(dry_run=dry_run)
    if scale_outs:
        log.info(f"Scale-out / target exits: {len(scale_outs)}")

    sells = [] if adaptive_mode else execute_sells(dry_run=dry_run)

    # V11 has one target engine.  Legacy sleeve exits must not independently
    # reshape its holdings or race the frozen target-order lifecycle.
    mr_exits = [] if adaptive_mode else execute_mr_exits(dry_run=dry_run)
    if mr_exits:
        log.info(f"MR exits: {len([e for e in mr_exits if e.get('action') == 'MR_EXIT'])}")

    pead_exits = [] if adaptive_mode else execute_pead_exits(dry_run=dry_run)
    if pead_exits:
        log.info(f"PEAD exits: {len([e for e in pead_exits if e.get('action') == 'PEAD_EXIT'])}")

    # Legacy regime flattening is also superseded by V11's SPY-SMA target.
    flatten = (
        [] if adaptive_mode else manage_regime_transition(dry_run=dry_run)
    )
    if flatten:
        log.info(f"Flatten-on-transition actions: {len(flatten)}")

    # Hedge sizing runs BEFORE directional buys so it can claim cash first
    hedge = (
        []
        if infrastructure_preflight
        else manage_bear_hedge(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
    )
    if hedge:
        log.info(f"Bear hedge actions: {len(hedge)}")

    # v4: SPY base position (market beta) — sized by regime
    spy_base = (
        []
        if infrastructure_preflight
        else manage_spy_base(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
    )
    if spy_base:
        log.info(f"SPY base actions: {len(spy_base)}")

    # v10d: TQQQ leveraged BULL/NEUTRAL overlay (3× QQQ).
    # SMA50+SMA200 gate inside the function auto-flattens on breakdown.
    tqqq_actions = (
        []
        if infrastructure_preflight
        else manage_tqqq_position(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
    )
    if tqqq_actions:
        log.info(f"TQQQ overlay actions: {len(tqqq_actions)}")

    # v10f: UPRO (3× SPY) parallel sleeve — same SMA gate as TQQQ.
    upro_actions = (
        []
        if infrastructure_preflight
        else manage_upro_position(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
    )
    if upro_actions:
        log.info(f"UPRO overlay actions: {len(upro_actions)}")

    infrastructure_migration = _infrastructure_migration_status()
    if infrastructure_preflight:
        infrastructure_migration = {
            **infrastructure_migration,
            "pending": True,
            "preflight_actions": infrastructure_preflight,
            "reason": (
                "legacy infrastructure BUY cancellation must settle before "
                "migration sells or adaptive buys"
            ),
        }
    if infrastructure_migration["pending"]:
        log.warning(infrastructure_migration["reason"])

    # v6: monthly dual-momentum rebalance — runs BEFORE execute_buys.
    # When momentum_mode is True (default), execute_buys is a no-op.
    momentum_picks = (
        [
            {
                "action": "ADAPTIVE_DEFERRED_INFRASTRUCTURE_CANCELLATION",
                "reason": infrastructure_migration["reason"],
            }
        ]
        if infrastructure_preflight
        else manage_momentum_picks(
            dry_run=dry_run,
            allow_new_exposure=bool(
                allow_new_exposure and not infrastructure_migration["pending"]
            ),
        )
    )
    if momentum_picks:
        log.info(f"Momentum rebalance actions: {len(momentum_picks)}")

    # Options hedge (puts) — supplemental tail-risk layer on top of SH ETF.
    # Silently no-ops if account lacks options trading or no actionable decision.
    options_hedge_result = []
    if active_params.get("enable_options_hedge", False):
        try:
            from options_executor import execute_options_hedge
            if allow_new_exposure:
                options_hedge_result = execute_options_hedge(dry_run=dry_run)
            else:
                options_hedge_result = _entry_gate_blocked()
            if options_hedge_result:
                log.info(f"Options hedge: {len(options_hedge_result)} action(s)")
        except Exception as e:
            log.warning(f"Options hedge skipped: {e}")

    buys = (
        []
        if adaptive_mode
        else execute_buys(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
    )

    # MR + PEAD buys run AFTER momentum buys so momentum claims slots first.
    # Sleeve caps prevent them from over-allocating.
    mr_buys = (
        execute_mr_buys(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
        if active_params.get("enable_mean_reversion", False)
        else []
    )
    if mr_buys:
        log.info(f"MR buys: {len([m for m in mr_buys if m.get('action') == 'MR_BUY'])}")

    pead_buys = (
        execute_pead_buys(
            dry_run=dry_run,
            allow_new_exposure=allow_new_exposure,
        )
        if active_params.get("enable_pead", False)
        else []
    )
    if pead_buys:
        log.info(f"PEAD buys: {len([p for p in pead_buys if p.get('action') == 'PEAD_BUY'])}")

    time_stops = [] if adaptive_mode else execute_time_stops(dry_run=dry_run)

    if not dry_run:
        from portfolio import save_positions_state, update_performance_state
        save_positions_state()
        update_performance_state()

        # Sync metadata with reality (in case Alpaca closed positions externally)
        try:
            from portfolio import get_positions
            import strategy_metadata as sm
            current = {p["symbol"] for p in get_positions()}
            sm.sync_with_positions(current)
        except Exception as e:
            log.warning(f"strategy_metadata sync skipped: {e}")

    result = {
        "timestamp": get_now_str(),
        "regime": get_market_regime(),
        "risk_tier": get_risk_tier(),
        "entry_gate": entry_gate,
        "stop_losses": stops,
        "tightened_stops": tightened,
        "scale_outs": scale_outs,
        "sells": sells,
        "hedge": hedge,
        "options_hedge": options_hedge_result,
        "momentum_picks": momentum_picks,
        "infrastructure_migration": infrastructure_migration,
        "buys": buys,
        "mr_buys": mr_buys,
        "mr_exits": mr_exits,
        "pead_buys": pead_buys,
        "pead_exits": pead_exits,
        "time_stops": time_stops,
        "dry_run": dry_run,
    }

    log.info("\nExecution summary:")
    log.info(f"  Stop-losses: {len(stops)}")
    log.info(f"  Tightened:   {len([t for t in tightened if t.get('action') == 'TIGHTEN'])}")
    log.info(f"  Scale-outs:  {len([s for s in scale_outs if s.get('action') in ('SCALE_OUT', 'FINAL_TARGET')])}")
    log.info(f"  Sells:       {len([s for s in sells if s.get('action') == 'SELL'])}")
    log.info(f"  Buys:        {len([b for b in buys if b.get('action') == 'BUY'])}")
    log.info(f"  Time stops:  {len([t for t in time_stops if t.get('action') == 'TIME_STOP'])}")
    log.info(f"  Skips:       {len([b for b in buys if b.get('action') == 'SKIP'])}")

    return result


def resolve_cli_command(argv: list[str] | None = None) -> str:
    """Resolve the CLI command; no argument is deliberately a dry run."""
    args = list(sys.argv[1:] if argv is None else argv)
    return args[0] if args else "dry-run"


def _run_midday_command(risk_snapshot: dict) -> int:
    """Run the paper midday lifecycle under one captured risk snapshot."""

    from portfolio import save_positions_state, update_performance_state
    from trade import (
        execute_stop_losses,
        get_market_entry_gate,
        sync_trailing_stops,
    )

    print(f"\nMidday scan — {get_now_str()}")
    active_params = get_strategy_params(get_market_regime(), get_risk_tier())
    adaptive_mode = bool(active_params.get("adaptive_momentum", False))
    if adaptive_mode:
        short_preflight = _reconcile_v11_short_positions(dry_run=False)
        if short_preflight:
            for result in short_preflight:
                print(
                    f"  {result.get('symbol', 'V11')}: "
                    f"{result.get('action', '?')}"
                )
            print("Short reconciliation pending; all other V11 actions blocked.")
            return 0
        # v11 is a target-portfolio strategy.  Legacy stop synchronization,
        # tightening, gain scaling, and time stops would fight that target and
        # can recreate the GTC sell-order deadlock.
        print("Adaptive v11: legacy stop/scale/time-stop mechanics disabled.")
    else:
        synced = sync_trailing_stops()
        if synced:
            print(f"Trailing stops synced: {len(synced)}")
        else:
            print("All positions have trailing stops.")

        tightened = tighten_stops_in_profit()
        if tightened:
            print(
                "Stops tightened: "
                f"{len([t for t in tightened if t.get('action') == 'TIGHTEN'])}"
            )

        scale_outs = execute_scale_outs()
        if scale_outs:
            for result in scale_outs:
                print(f"  {result['symbol']}: {result['action']}")

    entry_gate = get_market_entry_gate()
    risk_allows_entries = bool(
        risk_snapshot.get("available", False)
        and risk_snapshot.get("tier") != "HALT"
    )
    validation_gate = _v11_validation_gate() if adaptive_mode else None
    buy_preflight = (
        _reconcile_v11_open_buys_preflight(
            dry_run=False,
            allow_new_exposure=bool(
                entry_gate["allowed"]
                and risk_allows_entries
                and validation_gate is not None
                and validation_gate["passed"]
            ),
        )
        if adaptive_mode
        else []
    )
    if buy_preflight:
        for result in buy_preflight:
            print(
                f"  {result.get('symbol', 'V11')}: "
                f"{result.get('action', '?')}"
            )
        print("Open-BUY reconciliation pending; all other V11 actions blocked.")
        return 0
    infrastructure_preflight = (
        _cancel_v11_infrastructure_buys(dry_run=False)
        if adaptive_mode
        else []
    )
    if infrastructure_preflight:
        for result in infrastructure_preflight:
            print(
                f"  {result.get('symbol', 'V11')}: "
                f"{result.get('action', '?')}"
            )
        save_positions_state()
        update_performance_state()
        print("Infrastructure BUY cancellation pending; state refreshed.")
        return 0

    hedge = manage_bear_hedge(
        allow_new_exposure=bool(entry_gate["allowed"] and risk_allows_entries),
    )
    if hedge:
        for result in hedge:
            print(
                f"  HEDGE {result.get('action')}: "
                f"{result.get('qty', '?')} {HEDGE_SYMBOL}"
            )

    if adaptive_mode:
        infrastructure_migration = _infrastructure_migration_status()
        adaptive_actions = manage_momentum_picks(
            allow_new_exposure=bool(
                entry_gate["allowed"]
                and risk_allows_entries
                and validation_gate["passed"]
                and not infrastructure_migration["pending"]
            )
        )
        for result in adaptive_actions:
            print(
                f"  {result.get('symbol', 'V11')}: "
                f"{result.get('action', '?')}"
            )
    else:
        stops = execute_stop_losses()
        if stops:
            print(f"Stop-losses triggered: {len(stops)}")

        time_stops = execute_time_stops()
        if time_stops:
            print(
                "Time stops: "
                f"{len([t for t in time_stops if t.get('action') == 'TIME_STOP'])}"
            )

    save_positions_state()
    update_performance_state()
    print("State saved.")
    return 0


def main(argv: list[str] | None = None) -> int:
    """CLI entry point with paper-only opt-in for every mutating routine."""
    cmd = resolve_cli_command(argv)

    if cmd == "run":
        try:
            require_paper_trading_mode()
            result = run_execution(dry_run=False)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        print(f"\nExecution complete. Buys: {len(result['buys'])}, Sells: {len(result['sells'])}")
        return 0

    if cmd == "dry-run":
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
            sym = h.get("symbol", "SH")
            print(f"  {sym}: {h.get('action', '?')} — qty={h.get('qty', '?')} target={h.get('target_pct', '?')}%")
        for buy in result["buys"]:
            sym = buy.get("symbol", "?")
            action = buy.get("action", "?")
            reason = buy.get(
                "reason",
                f"qty={buy.get('qty')} @ ${buy.get('price', 0):.2f} score={buy.get('score')}",
            )
            print(f"  {sym}: {action} — {reason}")
        return 0

    if cmd == "midday":
        try:
            require_paper_trading_mode()
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 2

        risk_snapshot = _capture_execution_risk_snapshot()
        token = _EXECUTION_RISK_TIER.set(str(risk_snapshot["tier"]))
        try:
            return _run_midday_command(risk_snapshot)
        finally:
            _EXECUTION_RISK_TIER.reset(token)

    if cmd == "candidates":
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
        for candidate in buys:
            total = candidate["confidence"].get("total", 0)
            marker = "✓BUY" if total >= threshold else "↘near"
            print(f"  {candidate['symbol']}: score={total} ({candidate['source']}) {marker}")
        print(f"\nSELL candidates ({len(sells)}):")
        for candidate in sells:
            print(f"  {candidate['symbol']}: {candidate['reason']}")
        return 0

    print(
        "Usage: python3 execute_trades.py [run|dry-run|midday|candidates]",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
