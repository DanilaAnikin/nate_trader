"""Strategy configuration — regime-adaptive parameters for Nate Trader.

Centralizes every tunable knob (thresholds, RSI zones, volume gates, sizing,
cash policy) and resolves them based on the current market regime (from SPY
benchmark) and risk tier (from performance state).

Philosophy: the same algorithm should be aggressive in a bull market and
defensive in a bear market. Rather than a single static config, parameters
flow from `get_strategy_params()` which knows the regime and risk tier.
"""

from __future__ import annotations

from utils import load_json, RESEARCH_STATE, get_risk_tier


def get_market_regime() -> str:
    """Read current SPY market regime from research state. Defaults to NEUTRAL."""
    research = load_json(RESEARCH_STATE)
    return research.get("spy", {}).get("market_regime", "NEUTRAL")


# Base parameter table keyed by (regime, risk_tier).
# These are the knobs that move the system from "defensive filter" to
# "aggressive momentum harvester" depending on market backdrop.
_PARAMS = {
    # ─────────────────────── BULL regime ───────────────────────
    ("BULL", "NORMAL"): {
        "score_threshold": 55,           # was 65 — opens the gate in bulls
        "rsi_sweet_low": 55,             # momentum-friendly: reward strong RSI
        "rsi_sweet_high": 80,
        "rsi_acceptable_low": 45,        # secondary band
        "rsi_acceptable_high": 88,
        "volume_min_ratio": 1.0,         # was 1.2 — relaxed for bull
        "rs_lookback_days": 20,          # 20d alpha vs SPY (not 5d noise)
        "rs_alpha_min": -2.0,            # allow small underperformance (consolidation)
        "min_cash_pct": 5.0,             # only 5% cash min — deploy capital
        "max_cash_pct": 25.0,            # if cash > 25%, drop threshold further
        "cash_starve_bonus": 5,          # if over-cashed, subtract from threshold
        "risk_per_trade_pct": 1.0,       # 1% portfolio risk per trade (was 0.4)
        "max_position_pct": 6.0,         # 6% allocation cap (was 5)
        "trailing_stop_pct": 8.0,
        "tightened_stop_pct": 5.0,       # after +5% gain
        "scale_out_at_gain": 10.0,       # sell 50% at +10%
        "final_target_gain": 20.0,       # sell remainder at +20%
        "time_stop_days": 12,
        "time_stop_min_gain": 4.0,
    },
    ("BULL", "CAUTIOUS"): {
        "score_threshold": 68,
        "rsi_sweet_low": 50,
        "rsi_sweet_high": 75,
        "rsi_acceptable_low": 40,
        "rsi_acceptable_high": 85,
        "volume_min_ratio": 1.1,
        "rs_lookback_days": 20,
        "rs_alpha_min": 0.0,
        "min_cash_pct": 25.0,
        "max_cash_pct": 60.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.5,
        "max_position_pct": 3.0,
        "trailing_stop_pct": 6.0,
        "tightened_stop_pct": 4.0,
        "scale_out_at_gain": 8.0,
        "final_target_gain": 15.0,
        "time_stop_days": 10,
        "time_stop_min_gain": 4.0,
    },
    # ────────────────────── NEUTRAL regime ─────────────────────
    ("NEUTRAL", "NORMAL"): {
        "score_threshold": 65,
        "rsi_sweet_low": 50,
        "rsi_sweet_high": 70,
        "rsi_acceptable_low": 40,
        "rsi_acceptable_high": 75,
        "volume_min_ratio": 1.2,
        "rs_lookback_days": 20,
        "rs_alpha_min": 0.0,
        "min_cash_pct": 20.0,
        "max_cash_pct": 60.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.7,
        "max_position_pct": 5.0,
        "trailing_stop_pct": 8.0,
        "tightened_stop_pct": 5.0,
        "scale_out_at_gain": 10.0,
        "final_target_gain": 15.0,
        "time_stop_days": 10,
        "time_stop_min_gain": 5.0,
    },
    ("NEUTRAL", "CAUTIOUS"): {
        "score_threshold": 75,
        "rsi_sweet_low": 45,
        "rsi_sweet_high": 65,
        "rsi_acceptable_low": 35,
        "rsi_acceptable_high": 70,
        "volume_min_ratio": 1.3,
        "rs_lookback_days": 20,
        "rs_alpha_min": 2.0,
        "min_cash_pct": 30.0,
        "max_cash_pct": 70.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.4,
        "max_position_pct": 2.5,
        "trailing_stop_pct": 6.0,
        "tightened_stop_pct": 4.0,
        "scale_out_at_gain": 8.0,
        "final_target_gain": 12.0,
        "time_stop_days": 8,
        "time_stop_min_gain": 4.0,
    },
    # ──────────────────────── BEAR regime ──────────────────────
    ("BEAR", "NORMAL"): {
        "score_threshold": 80,           # only the strongest survive
        "rsi_sweet_low": 35,
        "rsi_sweet_high": 60,
        "rsi_acceptable_low": 30,
        "rsi_acceptable_high": 65,
        "volume_min_ratio": 1.5,
        "rs_lookback_days": 20,
        "rs_alpha_min": 5.0,             # stock must clearly outperform SPY
        "min_cash_pct": 40.0,
        "max_cash_pct": 100.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.3,
        "max_position_pct": 2.0,
        "trailing_stop_pct": 6.0,
        "tightened_stop_pct": 4.0,
        "scale_out_at_gain": 7.0,
        "final_target_gain": 12.0,
        "time_stop_days": 7,
        "time_stop_min_gain": 3.0,
    },
    ("BEAR", "CAUTIOUS"): {
        "score_threshold": 90,           # effectively no new longs
        "rsi_sweet_low": 30,
        "rsi_sweet_high": 55,
        "rsi_acceptable_low": 25,
        "rsi_acceptable_high": 60,
        "volume_min_ratio": 2.0,
        "rs_lookback_days": 20,
        "rs_alpha_min": 8.0,
        "min_cash_pct": 60.0,
        "max_cash_pct": 100.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.2,
        "max_position_pct": 1.5,
        "trailing_stop_pct": 5.0,
        "tightened_stop_pct": 3.0,
        "scale_out_at_gain": 6.0,
        "final_target_gain": 10.0,
        "time_stop_days": 5,
        "time_stop_min_gain": 3.0,
    },
}


def get_strategy_params(regime: str | None = None, risk_tier: str | None = None) -> dict:
    """Resolve the active parameter set.

    Falls back to (NEUTRAL, NORMAL) if the exact key isn't found.
    HALT risk tier always means "no new buys" — caller checks separately.
    """
    if regime is None:
        regime = get_market_regime()
    if risk_tier is None:
        risk_tier = get_risk_tier()

    if risk_tier == "HALT":
        # HALT is enforced by caller — return CAUTIOUS knobs for any defensive logic
        risk_tier = "CAUTIOUS"

    if regime not in {"BULL", "NEUTRAL", "BEAR"}:
        regime = "NEUTRAL"
    if risk_tier not in {"NORMAL", "CAUTIOUS"}:
        risk_tier = "NORMAL"

    return dict(_PARAMS[(regime, risk_tier)])  # copy so callers can mutate safely


def get_effective_threshold(cash_pct: float, regime: str | None = None,
                            risk_tier: str | None = None) -> int:
    """Score threshold adjusted by cash deployment pressure.

    If we're sitting on more cash than the regime allows (max_cash_pct),
    subtract `cash_starve_bonus` from the threshold to encourage deployment.
    Only kicks in for NORMAL risk tier — CAUTIOUS/HALT stay strict.
    """
    params = get_strategy_params(regime, risk_tier)
    threshold = params["score_threshold"]
    if (risk_tier or get_risk_tier()) == "NORMAL":
        if cash_pct > params["max_cash_pct"]:
            threshold -= params["cash_starve_bonus"]
    return max(40, threshold)  # absolute floor of 40 — never buy garbage


if __name__ == "__main__":
    import json as _json
    import sys

    regime = sys.argv[1] if len(sys.argv) > 1 else get_market_regime()
    risk_tier = sys.argv[2] if len(sys.argv) > 2 else get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    print(f"Regime: {regime} | Risk tier: {risk_tier}")
    print(_json.dumps(params, indent=2))
