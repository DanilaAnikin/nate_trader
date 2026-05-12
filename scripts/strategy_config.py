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
        "score_threshold": 45,           # aggressive — let more winners through
        "rsi_sweet_low": 55,
        "rsi_sweet_high": 80,
        "rsi_acceptable_low": 45,
        "rsi_acceptable_high": 88,
        "volume_min_ratio": 1.0,
        "rs_lookback_days": 20,
        "rs_alpha_min": -5.0,            # don't filter out consolidating names
        "min_cash_pct": 3.0,             # deploy nearly all capital
        "max_cash_pct": 15.0,            # lower trigger for cash-starve bonus
        "cash_starve_bonus": 10,         # strong push to deploy
        "risk_per_trade_pct": 1.5,       # bigger position sizing
        "max_position_pct": 10.0,        # concentrated bets
        "trailing_stop_pct": 10.0,       # wider stops = fewer shakeouts
        "tightened_stop_pct": 6.0,
        "scale_out_at_gain": 15.0,       # let winners run longer
        "final_target_gain": 30.0,       # much higher profit target
        "time_stop_days": 15,            # more patience
        "time_stop_min_gain": 4.0,
        "max_positions": 12,             # fewer but bigger bets
        "gate_score_min": 0.55,          # weighted gate threshold
    },
    ("BULL", "CAUTIOUS"): {
        "score_threshold": 55,
        "rsi_sweet_low": 50,
        "rsi_sweet_high": 75,
        "rsi_acceptable_low": 40,
        "rsi_acceptable_high": 85,
        "volume_min_ratio": 1.1,
        "rs_lookback_days": 20,
        "rs_alpha_min": -2.0,
        "min_cash_pct": 15.0,
        "max_cash_pct": 40.0,
        "cash_starve_bonus": 5,
        "risk_per_trade_pct": 0.8,
        "max_position_pct": 5.0,
        "trailing_stop_pct": 8.0,
        "tightened_stop_pct": 5.0,
        "scale_out_at_gain": 10.0,
        "final_target_gain": 20.0,
        "time_stop_days": 12,
        "time_stop_min_gain": 4.0,
        "max_positions": 10,
        "gate_score_min": 0.60,
    },
    # ────────────────────── NEUTRAL regime ─────────────────────
    ("NEUTRAL", "NORMAL"): {
        "score_threshold": 55,           # was 65 — more deployment
        "rsi_sweet_low": 50,
        "rsi_sweet_high": 70,
        "rsi_acceptable_low": 40,
        "rsi_acceptable_high": 75,
        "volume_min_ratio": 1.1,
        "rs_lookback_days": 20,
        "rs_alpha_min": -2.0,
        "min_cash_pct": 10.0,
        "max_cash_pct": 30.0,
        "cash_starve_bonus": 8,
        "risk_per_trade_pct": 1.0,
        "max_position_pct": 8.0,         # was 5%
        "trailing_stop_pct": 8.0,
        "tightened_stop_pct": 5.0,
        "scale_out_at_gain": 12.0,
        "final_target_gain": 20.0,
        "time_stop_days": 12,
        "time_stop_min_gain": 4.0,
        "max_positions": 12,
        "gate_score_min": 0.65,
    },
    ("NEUTRAL", "CAUTIOUS"): {
        "score_threshold": 65,
        "rsi_sweet_low": 45,
        "rsi_sweet_high": 65,
        "rsi_acceptable_low": 35,
        "rsi_acceptable_high": 70,
        "volume_min_ratio": 1.2,
        "rs_lookback_days": 20,
        "rs_alpha_min": 0.0,
        "min_cash_pct": 25.0,
        "max_cash_pct": 60.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.5,
        "max_position_pct": 4.0,
        "trailing_stop_pct": 6.0,
        "tightened_stop_pct": 4.0,
        "scale_out_at_gain": 10.0,
        "final_target_gain": 15.0,
        "time_stop_days": 10,
        "time_stop_min_gain": 4.0,
        "max_positions": 10,
        "gate_score_min": 0.70,
    },
    # ──────────────────────── BEAR regime ──────────────────────
    ("BEAR", "NORMAL"): {
        "score_threshold": 70,           # was 80 — still high but not frozen
        "rsi_sweet_low": 35,
        "rsi_sweet_high": 60,
        "rsi_acceptable_low": 30,
        "rsi_acceptable_high": 65,
        "volume_min_ratio": 1.3,
        "rs_lookback_days": 20,
        "rs_alpha_min": 2.0,             # was 5.0 — less restrictive
        "min_cash_pct": 30.0,
        "max_cash_pct": 80.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.5,
        "max_position_pct": 4.0,         # was 2%
        "trailing_stop_pct": 6.0,
        "tightened_stop_pct": 4.0,
        "scale_out_at_gain": 8.0,
        "final_target_gain": 15.0,
        "time_stop_days": 8,
        "time_stop_min_gain": 3.0,
        "max_positions": 8,
        "gate_score_min": 0.80,
    },
    ("BEAR", "CAUTIOUS"): {
        "score_threshold": 80,           # was 90 — still very selective
        "rsi_sweet_low": 30,
        "rsi_sweet_high": 55,
        "rsi_acceptable_low": 25,
        "rsi_acceptable_high": 60,
        "volume_min_ratio": 1.5,
        "rs_lookback_days": 20,
        "rs_alpha_min": 5.0,
        "min_cash_pct": 50.0,
        "max_cash_pct": 100.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.3,
        "max_position_pct": 2.0,
        "trailing_stop_pct": 5.0,
        "tightened_stop_pct": 3.0,
        "scale_out_at_gain": 7.0,
        "final_target_gain": 12.0,
        "time_stop_days": 6,
        "time_stop_min_gain": 3.0,
        "max_positions": 5,
        "gate_score_min": 0.85,
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


def get_bear_hedge_target_pct(regime: str | None = None,
                              risk_tier: str | None = None) -> float:
    """Target SH (inverse SPY) allocation as % of equity.

    The hedge sizing follows two signals:
      • Market regime — how directional is the downside risk?
      • Risk tier    — are we already in drawdown?

    Designed so transitions are gradual (no whipsaw): NEUTRAL holds a small
    hedge, BEAR scales it up, and a CAUTIOUS/HALT tier adds extra protection
    regardless of regime. Max possible target is 35%.
    """
    if regime is None:
        regime = get_market_regime()
    if risk_tier is None:
        risk_tier = get_risk_tier()

    # NEUTRAL hedge removed — backtest showed always-on 10% SH cost
    # ~$112k in drift bleed during NEUTRAL periods while delivering
    # almost no protection (NEUTRAL = chop, not crash). Reactivate only
    # when conditions actually deteriorate (CAUTIOUS or BEAR).
    base = {
        "BULL": 0.0,
        "NEUTRAL": 0.0,
        "BEAR": 25.0,
    }.get(regime, 0.0)

    # Tier modifiers — drawdown adds protection on top of regime
    if risk_tier == "CAUTIOUS":
        base += 8.0  # mild hedge when we're already bleeding
    elif risk_tier == "HALT":
        # Floor at 20% — drawdown is real, hedge no matter what regime
        base = max(base + 10.0, 20.0)

    return min(base, 35.0)  # absolute cap


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
    return max(30, threshold)  # absolute floor of 30


if __name__ == "__main__":
    import json as _json
    import sys

    regime = sys.argv[1] if len(sys.argv) > 1 else get_market_regime()
    risk_tier = sys.argv[2] if len(sys.argv) > 2 else get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    print(f"Regime: {regime} | Risk tier: {risk_tier}")
    print(_json.dumps(params, indent=2))
