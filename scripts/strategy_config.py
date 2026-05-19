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
    # Post-2022-bear lesson: aggressive 10% positions × 1.5% risk got us
    # +45% in BULL but blew up −22% in the 2022 regime transition. We
    # keep BULL aggressive enough to harvest momentum but pull back on
    # individual-position blast radius.
    ("BULL", "NORMAL"): {
        "score_threshold": 48,
        "rsi_sweet_low": 55,
        "rsi_sweet_high": 80,
        "rsi_acceptable_low": 45,
        "rsi_acceptable_high": 88,
        "volume_min_ratio": 1.1,
        "rs_lookback_days": 20,
        "rs_alpha_min": -3.0,
        "min_cash_pct": 5.0,
        "max_cash_pct": 15.0,
        "cash_starve_bonus": 8,
        "risk_per_trade_pct": 1.2,
        # v10c: max_position_pct 7→15 — momentum picks earned ~+1.5pp more
        # alpha when allowed to size up. Still capped well below the
        # leveraged ETF allocation (25%) so it can't crowd out beta.
        "max_position_pct": 15.0,
        # v10 (2026-05-19): widened trail 14→40 lets winners run through
        # normal pullbacks; the monthly momentum rebalance + ATR stop
        # already do the cutting. Backtest 2021-2024 lifted IS alpha
        # from −5.08% to −3.28%/yr.
        "trailing_stop_pct": 40.0,
        "tightened_stop_pct": 35.0,
        "scale_out_at_gain": 999.0,      # v4: disabled — let winners run
        "final_target_gain": 999.0,      # v4: disabled — trailing stop manages exit
        "time_stop_days": 30,
        "time_stop_min_gain": 0.0,
        "max_positions": 14,
        "gate_score_min": 0.55,
        "block_new_buys": False,
        "atr_stop_multiple": 2.5,        # v4: wider — matches widened trail
        # v10 (2026-05-19): TQQQ overlay replaces SSO as primary BULL beta.
        # SMA50+SMA200 gate exits TQQQ on regime weakness (2022 went
        # +4.5% alpha because the gate took us flat). On 2021-2024 IS
        # alpha jumped −5.08% → +7.06%/yr. 2025 holdout: +25.78%/yr.
        # 20% SSO is kept as a less-volatile beta floor.
        "base_pct": 20.0,
        "base_instrument": "SSO",
        "spy_base_pct": 20.0,
        "flatten_on_transition": False,
        "tqqq_pct": 80.0,
        "tqqq_stop_pct": 20.0,
        "momentum_mode": True,
        "momentum_min_hold_days": 21,
        "momentum_top_n": 5,
        # v9 sector rotation DISABLED — overlay competed with momentum picks
        # for capital, dropped BULL P&L from +83% (v7) to +41% (v9).
        "sector_rotation_pct": 0.0,
        "sector_rotation_top_n": 0,
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
        # v10: mirror NORMAL widening — same logic applies in CAUTIOUS
        "trailing_stop_pct": 35.0,
        "tightened_stop_pct": 30.0,
        "scale_out_at_gain": 999.0,      # v4: disabled
        "final_target_gain": 999.0,      # v4: disabled
        "time_stop_days": 30,
        "time_stop_min_gain": 0.0,
        "max_positions": 10,
        "gate_score_min": 0.60,
        "block_new_buys": False,
        "atr_stop_multiple": 2.5,
        # v10 CAUTIOUS BULL — slightly de-risked TQQQ exposure (60% vs 80%)
        "base_pct": 30.0,
        "base_instrument": "SSO",
        "spy_base_pct": 30.0,
        "flatten_on_transition": False,
        "tqqq_pct": 60.0,
        "tqqq_stop_pct": 20.0,
        "momentum_mode": True,
        "momentum_min_hold_days": 21,
        "momentum_top_n": 4,
        "sector_rotation_pct": 0.0,
        "sector_rotation_top_n": 0,
    },
    # ────────────────────── NEUTRAL regime ─────────────────────
    ("NEUTRAL", "NORMAL"): {
        "score_threshold": 55,
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
        "max_position_pct": 8.0,
        "trailing_stop_pct": 8.0,
        "tightened_stop_pct": 5.0,
        "scale_out_at_gain": 12.0,
        "final_target_gain": 20.0,
        "time_stop_days": 30,
        "time_stop_min_gain": 0.0,
        "max_positions": 12,
        "gate_score_min": 0.65,
        "block_new_buys": True,
        "atr_stop_multiple": 2.5,
        # v10 NEUTRAL: TQQQ overlay activates when SPY > SMA50 AND SMA200
        # (typical pullback within an intact uptrend). 60% TQQQ + 20% SPY
        # converts cash-heavy NEUTRAL into a dip-buying regime. The TQQQ
        # SMA gate auto-flattens if the structural trend breaks. IS alpha
        # 2021-2024 jumped +6.07% → +29.14%; 2025 holdout +44%/yr.
        "base_pct": 20.0,
        "base_instrument": "SPY",
        "spy_base_pct": 20.0,
        "flatten_on_transition": True,   # v7: cut stocks on regime weakness
        "tqqq_pct": 60.0,
        "tqqq_stop_pct": 20.0,
        "momentum_mode": True,
        "momentum_min_hold_days": 21,
        "momentum_top_n": 0,
        "sector_rotation_pct": 0.0,
        "sector_rotation_top_n": 0,
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
        "time_stop_days": 30,
        "time_stop_min_gain": 0.0,
        "max_positions": 10,
        "gate_score_min": 0.70,
        "block_new_buys": True,
        "atr_stop_multiple": 2.5,
        # v10 NEUTRAL/CAUTIOUS: same shape as NORMAL but smaller exposure.
        # 15% SPY + 35% TQQQ keeps the dip-buy edge while honouring the
        # drawdown trigger that escalated us to CAUTIOUS.
        "base_pct": 15.0,
        "base_instrument": "SPY",
        "spy_base_pct": 15.0,
        "flatten_on_transition": True,
        "tqqq_pct": 35.0,
        "tqqq_stop_pct": 20.0,
        "momentum_mode": True,
        "momentum_min_hold_days": 21,
        "momentum_top_n": 0,
        "sector_rotation_pct": 0.0,
        "sector_rotation_top_n": 0,
    },
    # ──────────────────────── BEAR regime ──────────────────────
    ("BEAR", "NORMAL"): {
        "score_threshold": 70,
        "rsi_sweet_low": 35,
        "rsi_sweet_high": 60,
        "rsi_acceptable_low": 30,
        "rsi_acceptable_high": 65,
        "volume_min_ratio": 1.3,
        "rs_lookback_days": 20,
        "rs_alpha_min": 2.0,
        "min_cash_pct": 30.0,
        "max_cash_pct": 80.0,
        "cash_starve_bonus": 0,
        "risk_per_trade_pct": 0.5,
        "max_position_pct": 4.0,
        "trailing_stop_pct": 6.0,
        "tightened_stop_pct": 4.0,
        "scale_out_at_gain": 8.0,
        "final_target_gain": 15.0,
        "time_stop_days": 30,
        "time_stop_min_gain": 0.0,
        "max_positions": 8,
        "gate_score_min": 0.80,
        "block_new_buys": True,
        "atr_stop_multiple": 3.0,
        "base_pct": 0.0,
        "base_instrument": "SPY",
        "spy_base_pct": 0.0,
        "flatten_on_transition": True,
        "tqqq_pct": 0.0,
        "tqqq_stop_pct": 20.0,
        "momentum_mode": True,
        "momentum_min_hold_days": 21,
        "momentum_top_n": 0,
        "sector_rotation_pct": 0.0,
        "sector_rotation_top_n": 0,
    },
    ("BEAR", "CAUTIOUS"): {
        "score_threshold": 80,
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
        "time_stop_days": 30,
        "time_stop_min_gain": 0.0,
        "max_positions": 5,
        "gate_score_min": 0.85,
        "block_new_buys": True,
        "atr_stop_multiple": 3.0,
        "base_pct": 0.0,
        "base_instrument": "SPY",
        "spy_base_pct": 0.0,
        "flatten_on_transition": True,
        "tqqq_pct": 0.0,
        "tqqq_stop_pct": 20.0,
        "momentum_mode": True,
        "momentum_min_hold_days": 21,
        "momentum_top_n": 0,
        "sector_rotation_pct": 0.0,
        "sector_rotation_top_n": 0,
    },
}


# v7: regime confirmation — require N consecutive days of the same SPY/SMA
# classifier output before treating a transition as "confirmed". Avoids
# the BULL↔NEUTRAL daily-flip churn that wrecked v6 iter 1.
#
# v8: asymmetric — walk-forward showed −16 pp/yr OOS alpha in W2/W3 came
# from late entry into BULL after the 2022 bear bottom + 2023 rally. The
# 3-day buffer protects against chop but costs ~5-10 pp in recovery legs.
# Fast entry (1-day) + slow exit (3-day) gives back most of that without
# reopening the churn problem.
REGIME_CONFIRMATION_DAYS = 3  # legacy alias — single-value
REGIME_CONFIRMATION_DAYS_ENTRY = 3   # v9: REVERTED to symmetric (v8 1-day caused whipsaw)
REGIME_CONFIRMATION_DAYS_EXIT = 3    # v9: kept symmetric — v8 walk-forward proved
                                      # asymmetric backfires on bear-bounce false signals


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


def _spy_below_sma200() -> bool:
    """Return True iff most recent SPY close is below its 200-day SMA.

    v3 hard gate: SH hedge only activates in a structural downtrend, defined
    as "SPY below 200-SMA" (canonical institutional bull/bear line). Without
    this gate, even BEAR-regime detection sometimes fires in multi-week
    pullbacks within a structural uptrend and bleeds via the hedge.

    Fail-safe: if research state lacks the SMA200 field, default to True so
    we DON'T strip an existing hedge based on missing data.
    """
    research = load_json(RESEARCH_STATE)
    spy = research.get("spy", {})
    price = spy.get("price")
    sma200 = spy.get("sma_200")
    if price is None or sma200 is None:
        return True  # fail-safe
    return float(price) < float(sma200)


def get_bear_hedge_target_pct(regime: str | None = None,
                              risk_tier: str | None = None) -> float:
    """Target SH (inverse SPY) allocation as % of equity.

    The hedge sizing follows three signals:
      • SPY 200-day SMA — structural bull (above) vs bear (below). v3 HARD GATE.
        If SPY ≥ SMA200, target is 0 regardless of regime/tier.
      • Market regime — how directional is the downside risk?
      • Risk tier    — are we already in drawdown?

    NEUTRAL was already de-hedged in v2 (backtest showed ~$112k drift bleed).
    v3 layers the SMA200 gate on top of that so even BEAR-regime fires don't
    activate the hedge during multi-year SPY uptrends.
    """
    if regime is None:
        regime = get_market_regime()
    if risk_tier is None:
        risk_tier = get_risk_tier()

    # v3 hard gate — no hedge in structural uptrend
    if not _spy_below_sma200():
        return 0.0

    base = {
        "BULL": 0.0,
        "NEUTRAL": 0.0,
        "BEAR": 25.0,
    }.get(regime, 0.0)

    # Tier modifiers — drawdown adds protection on top of regime
    if risk_tier == "CAUTIOUS":
        base += 8.0
    elif risk_tier == "HALT":
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


# Phase H of ALPHA_PLAN.md — universe liquidity filter.
# Applied in screener.py BEFORE quick-scoring so penny stocks and thinly-
# traded tail names never enter the scoring pipeline. Tunable here so we
# can sweep them in the future without touching the screener code.
#
# Defaults chosen so 2026 large-cap universe passes through unchanged
# while clearly low-quality names are dropped. Tightening in BEAR regimes
# adds margin against slippage cliffs that hit small caps first.
UNIVERSE_FILTER = {
    "BULL":    {"min_price_usd": 10.0, "min_dollar_volume_usd": 5_000_000},
    "NEUTRAL": {"min_price_usd": 10.0, "min_dollar_volume_usd": 5_000_000},
    "BEAR":    {"min_price_usd": 15.0, "min_dollar_volume_usd": 10_000_000},
}


def get_universe_filter(regime: str | None = None) -> dict:
    """Return liquidity filter thresholds for the current/requested regime."""
    if regime is None:
        regime = get_market_regime()
    if regime not in UNIVERSE_FILTER:
        regime = "NEUTRAL"
    return dict(UNIVERSE_FILTER[regime])


if __name__ == "__main__":
    import json as _json
    import sys

    regime = sys.argv[1] if len(sys.argv) > 1 else get_market_regime()
    risk_tier = sys.argv[2] if len(sys.argv) > 2 else get_risk_tier()
    params = get_strategy_params(regime, risk_tier)
    print(f"Regime: {regime} | Risk tier: {risk_tier}")
    print(_json.dumps(params, indent=2))
