"""Phase 4 live wiring — Alpaca options API client for SPY put hedges.

Pulls the pure HedgeDecision from options_hedge.decide_action() and
turns it into actual Alpaca paper options orders. Alpaca's options
endpoints (`/v2/options/contracts`, `/v2/orders`) are used directly via
the REST client because the Python SDK's option support is uneven
across versions.

Used by execute_trades.run_execution() — called once per cycle after
the SH ETF hedge logic. If the account doesn't have options trading
enabled, we silently no-op (the SH hedge remains the primary defense).
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import (  # noqa: E402
    ALPACA_API_KEY, ALPACA_SECRET_KEY, STATE_DIR,
    setup_logging, get_now_str, load_json, save_json,
)
from options_hedge import decide_action, OptionPosition, HedgeDecision  # noqa: E402

log = setup_logging("options_executor")

OPTIONS_STATE_PATH = STATE_DIR / "options_hedge_state.json"
ALPACA_PAPER_BASE = "https://paper-api.alpaca.markets/v2"
ALPACA_DATA_BASE = "https://data.alpaca.markets/v1beta1"


# ───────────────────────── HTTP helpers ─────────────────────────


def _headers() -> dict:
    return {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_SECRET_KEY,
        "Content-Type": "application/json",
    }


def _find_spy_put_contract(target_dte: int, target_otm_pct: float,
                           current_spy_price: float) -> dict | None:
    """Search Alpaca options chain for nearest matching SPY put.

    Returns the contract dict or None on failure / no match.
    """
    import requests
    target_strike = current_spy_price * (1 - target_otm_pct / 100)
    target_expiry = datetime.now() + timedelta(days=target_dte)
    expiry_min = (target_expiry - timedelta(days=7)).strftime("%Y-%m-%d")
    expiry_max = (target_expiry + timedelta(days=7)).strftime("%Y-%m-%d")

    try:
        resp = requests.get(
            f"{ALPACA_PAPER_BASE}/options/contracts",
            headers=_headers(),
            params={
                "underlying_symbols": "SPY",
                "type": "put",
                "expiration_date_gte": expiry_min,
                "expiration_date_lte": expiry_max,
                "strike_price_gte": str(target_strike - 5),
                "strike_price_lte": str(target_strike + 5),
                "limit": 50,
            },
            timeout=15,
        )
        resp.raise_for_status()
        contracts = resp.json().get("option_contracts", [])
    except Exception as e:
        log.warning(f"Options chain fetch failed: {e}")
        return None

    if not contracts:
        return None

    # Pick the one closest to (target_strike, target_dte)
    def _score(c: dict) -> float:
        strike_diff = abs(float(c["strike_price"]) - target_strike)
        exp = datetime.fromisoformat(c["expiration_date"])
        dte_diff = abs((exp - datetime.now()).days - target_dte)
        return strike_diff + dte_diff * 0.5  # weight strike more
    contracts.sort(key=_score)
    return contracts[0]


def _get_spy_price() -> float | None:
    """Latest SPY price for strike calculation."""
    try:
        from research import get_latest_quote
        q = get_latest_quote("SPY")
        return q.get("mid") or q.get("ask") or q.get("bid")
    except Exception:
        return None


def _existing_put() -> OptionPosition | None:
    """Return current SPY put position (if any) reconstructed from state file."""
    s = load_json(OPTIONS_STATE_PATH) or {}
    rec = s.get("active_put")
    if not rec:
        return None
    try:
        expiry = datetime.fromisoformat(rec["expiry"])
        dte = max(0, (expiry - datetime.now()).days)
        return OptionPosition(
            strike=float(rec["strike"]),
            expiry_dte=dte,
            contracts=int(rec["contracts"]),
            premium_paid_pct_equity=float(rec["premium_pct"]),
        )
    except (KeyError, ValueError):
        return None


def _record_put(symbol: str, contracts: int, expiry: str, strike: float,
                premium_pct: float, order_id: str) -> None:
    save_json(OPTIONS_STATE_PATH, {
        "updated_at": get_now_str(),
        "active_put": {
            "symbol": symbol,
            "contracts": contracts,
            "expiry": expiry,
            "strike": strike,
            "premium_pct": premium_pct,
            "order_id": order_id,
        },
    })


def _clear_put() -> None:
    save_json(OPTIONS_STATE_PATH, {"updated_at": get_now_str(), "active_put": None})


def _place_option_order(contract_symbol: str, qty: int, side: str) -> dict | None:
    """Submit a market option order on Alpaca paper."""
    import requests
    try:
        resp = requests.post(
            f"{ALPACA_PAPER_BASE}/orders",
            headers=_headers(),
            json={
                "symbol": contract_symbol,
                "qty": str(qty),
                "side": side,         # "buy" or "sell"
                "type": "market",
                "time_in_force": "day",
            },
            timeout=15,
        )
        if resp.status_code >= 400:
            log.warning(f"Option order failed ({resp.status_code}): {resp.text[:200]}")
            return None
        return resp.json()
    except Exception as e:
        log.warning(f"Option order exception: {e}")
        return None


# ─────────────────────────── orchestration ─────────────────────────────────


def execute_options_hedge(dry_run: bool = False) -> list[dict]:
    """Read decide_action and translate into actual orders."""
    from strategy_config import get_market_regime
    from utils import get_risk_tier as _grt
    regime = get_market_regime()
    risk_tier = _grt()
    current_put = _existing_put()

    # Compute total options premium already at risk
    s = load_json(OPTIONS_STATE_PATH) or {}
    total_options_pct = (s.get("active_put") or {}).get("premium_pct", 0.0)

    # IV percentile and SPY YTD are best-effort; default to None (=no skip)
    iv_pct = None
    spy_ytd = None
    try:
        # Quick SPY YTD from research state's monthly history
        perf = load_json(STATE_DIR / "performance.json") or {}
        history = perf.get("daily_history", [])
        if history:
            ytd_first = next((h for h in history if h.get("date", "").startswith(str(datetime.now().year))), None)
            if ytd_first:
                start_eq = ytd_first.get("equity")
                cur_eq = history[-1].get("equity")
                # Not quite SPY YTD but a useful proxy; if we want pure SPY
                # we'd compute from spy_history.json — keep simple for now
                if start_eq and cur_eq:
                    spy_ytd = (cur_eq / start_eq - 1) * 100
    except Exception:
        pass

    decision = decide_action(
        regime=regime, risk_tier=risk_tier, current_put=current_put,
        iv_percentile=iv_pct, spy_ytd_return_pct=spy_ytd,
        total_options_premium_pct=total_options_pct,
    )

    log.info(f"Options hedge: {decision.action} — {decision.reason}")

    if decision.action in ("HOLD", "SKIP"):
        return [{"action": decision.action, "reason": decision.reason}]

    if dry_run:
        return [{"action": f"DRY_RUN_{decision.action}",
                 "reason": decision.reason,
                 "target_dte": decision.target_dte,
                 "target_otm_pct": decision.target_otm_pct}]

    if decision.action == "CLOSE_PUT":
        if current_put is None:
            return []
        # We don't have the contract symbol in our state — best-effort lookup
        # In practice we should have saved it; do nothing if not available
        s = load_json(OPTIONS_STATE_PATH) or {}
        sym = (s.get("active_put") or {}).get("symbol")
        if sym:
            result = _place_option_order(sym, current_put.contracts, "sell")
            _clear_put()
            return [{"action": "CLOSE_PUT", "contract": sym,
                     "order": result, "reason": decision.reason}]
        return []

    # BUY_PUT or ROLL_PUT — find a contract and order it
    if decision.action == "ROLL_PUT" and current_put is not None:
        # Close existing first
        s = load_json(OPTIONS_STATE_PATH) or {}
        old_sym = (s.get("active_put") or {}).get("symbol")
        if old_sym:
            _place_option_order(old_sym, current_put.contracts, "sell")
        _clear_put()

    spy_price = _get_spy_price()
    if spy_price is None:
        return [{"action": "SKIP", "reason": "SPY price unavailable"}]

    contract = _find_spy_put_contract(decision.target_dte,
                                      decision.target_otm_pct, spy_price)
    if not contract:
        return [{"action": "SKIP", "reason": "No matching SPY put contract found"}]

    # Size to target_premium_pct_equity. Without options Greeks data we
    # estimate premium ~= strike × 0.02 (rough) and let real fills determine.
    from portfolio import get_account
    try:
        acct = get_account()
        equity = acct["equity"]
    except Exception:
        return [{"action": "SKIP", "reason": "account fetch failed"}]

    target_dollars = equity * (decision.target_premium_pct_equity / 100)
    estimated_premium_per_contract = float(contract["strike_price"]) * 0.02 * 100  # 100 shares
    qty = max(1, int(target_dollars / estimated_premium_per_contract))
    qty = min(qty, 20)  # absolute cap on contracts as safety

    result = _place_option_order(contract["symbol"], qty, "buy")
    if result and "id" in result:
        _record_put(
            symbol=contract["symbol"],
            contracts=qty,
            expiry=contract["expiration_date"],
            strike=float(contract["strike_price"]),
            premium_pct=decision.target_premium_pct_equity,
            order_id=result["id"],
        )
        return [{"action": decision.action, "contract": contract["symbol"],
                 "qty": qty, "expiry": contract["expiration_date"],
                 "strike": contract["strike_price"], "order_id": result["id"]}]

    return [{"action": "ORDER_REJECTED", "contract": contract["symbol"]}]


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        s = load_json(OPTIONS_STATE_PATH) or {}
        print(f"Options hedge state: {s}")
    elif cmd == "execute":
        dry = "--dry-run" in sys.argv
        result = execute_options_hedge(dry_run=dry)
        for r in result:
            print(f"  {r}")
    else:
        print("Usage: python3 scripts/options_executor.py [status|execute [--dry-run]]")
