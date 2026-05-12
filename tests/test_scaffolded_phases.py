"""Tests for the pure decision logic in scaffold modules.

Phases 4 (options), 5 (gap), 7 (multi-timeframe), 8 (PEAD) ship with
pure-function cores even though their live wiring (Alpaca options API,
new workflow jobs, 4h bar provider) is deferred. We test the cores
here so the production hooks land on validated logic.
"""

from __future__ import annotations

import pytest


# ────────────────────────── Phase 4 options ────────────────────────────


def test_options_bull_closes_existing_put():
    from options_hedge import decide_action, OptionPosition
    put = OptionPosition(strike=400.0, expiry_dte=20, contracts=1, premium_paid_pct_equity=1.5)
    d = decide_action(regime="BULL", risk_tier="NORMAL", current_put=put,
                      iv_percentile=50, spy_ytd_return_pct=10)
    assert d.action == "CLOSE_PUT"


def test_options_bull_no_put_holds():
    from options_hedge import decide_action
    d = decide_action(regime="BULL", risk_tier="NORMAL", current_put=None,
                      iv_percentile=50, spy_ytd_return_pct=10)
    assert d.action == "HOLD"


def test_options_bear_no_put_buys():
    from options_hedge import decide_action
    d = decide_action(regime="BEAR", risk_tier="NORMAL", current_put=None,
                      iv_percentile=50, spy_ytd_return_pct=-5)
    assert d.action == "BUY_PUT"
    assert d.target_premium_pct_equity == 1.5
    assert d.target_dte == 30


def test_options_halt_forces_max_protection():
    from options_hedge import decide_action
    d = decide_action(regime="BULL", risk_tier="HALT", current_put=None,
                      iv_percentile=50, spy_ytd_return_pct=-3)
    assert d.action == "BUY_PUT"
    assert d.target_premium_pct_equity == 3.0


def test_options_rolls_near_expiry():
    from options_hedge import decide_action, OptionPosition
    put = OptionPosition(strike=400.0, expiry_dte=10, contracts=1, premium_paid_pct_equity=1.5)
    d = decide_action(regime="BEAR", risk_tier="NORMAL", current_put=put,
                      iv_percentile=50, spy_ytd_return_pct=-5)
    assert d.action == "ROLL_PUT"


def test_options_skip_when_iv_too_high():
    from options_hedge import decide_action
    d = decide_action(regime="BEAR", risk_tier="NORMAL", current_put=None,
                      iv_percentile=95, spy_ytd_return_pct=-5)
    assert d.action == "SKIP"


def test_options_skip_when_disaster_priced_in():
    from options_hedge import decide_action
    d = decide_action(regime="BEAR", risk_tier="NORMAL", current_put=None,
                      iv_percentile=50, spy_ytd_return_pct=-20)
    assert d.action == "SKIP"


def test_options_skip_when_total_premium_at_cap():
    from options_hedge import decide_action
    d = decide_action(regime="BEAR", risk_tier="NORMAL", current_put=None,
                      iv_percentile=50, spy_ytd_return_pct=-5,
                      total_options_premium_pct=5.0)
    assert d.action == "SKIP"


# ─────────────────────────── Phase 5 gap scanner ────────────────────────


def test_gap_up_with_news_detected():
    from gap_scanner import classify_gap, GAP_UP_BONUS
    s = classify_gap(prior_close=100, today_open=105,
                     first_5min_volume=200_000, avg_premarket_volume=100_000,
                     has_news_catalyst=True)
    assert s is not None
    assert s.kind == "GAP_UP"
    assert s.bonus_points == GAP_UP_BONUS


def test_gap_up_no_news_filtered_out():
    from gap_scanner import classify_gap
    s = classify_gap(prior_close=100, today_open=105,
                     first_5min_volume=200_000, avg_premarket_volume=100_000,
                     has_news_catalyst=False)
    assert s is None


def test_gap_down_oversold_creates_mr_candidate():
    from gap_scanner import classify_gap, GAP_DOWN_BONUS
    s = classify_gap(prior_close=100, today_open=95,
                     first_5min_volume=200_000, avg_premarket_volume=100_000,
                     oversold_signal=True)
    assert s is not None
    assert s.kind == "GAP_DOWN"
    assert s.bonus_points == GAP_DOWN_BONUS


def test_gap_below_threshold_filtered_out():
    from gap_scanner import classify_gap
    s = classify_gap(prior_close=100, today_open=102,
                     first_5min_volume=200_000, avg_premarket_volume=100_000,
                     has_news_catalyst=True)
    assert s is None


def test_gap_low_volume_filtered_out():
    from gap_scanner import classify_gap
    s = classify_gap(prior_close=100, today_open=105,
                     first_5min_volume=100_000, avg_premarket_volume=100_000,  # ratio = 1.0
                     has_news_catalyst=True)
    assert s is None


def test_gap_wide_spread_filtered_out():
    from gap_scanner import classify_gap
    s = classify_gap(prior_close=100, today_open=105,
                     first_5min_volume=200_000, avg_premarket_volume=100_000,
                     bid=104, ask=106.5,  # 2.4% spread
                     has_news_catalyst=True)
    assert s is None


# ─────────────────────── Phase 7 multi-timeframe ────────────────────────


def test_mtf_all_aligned_bullish():
    from multi_timeframe import compute_mtf_adjustment, TimeframeTechnicals
    daily = TimeframeTechnicals(rsi_14=65, macd_above_signal=True, price_above_sma20=True)
    h4 = TimeframeTechnicals(rsi_14=60, macd_above_signal=True, price_above_sma20=True)
    assert compute_mtf_adjustment(daily, h4, regime="BULL") == 8


def test_mtf_two_aligned():
    from multi_timeframe import compute_mtf_adjustment, TimeframeTechnicals
    daily = TimeframeTechnicals(rsi_14=65, macd_above_signal=True, price_above_sma20=True)
    h4 = TimeframeTechnicals(rsi_14=45, macd_above_signal=True, price_above_sma20=True)  # 4h RSI below sweet
    assert compute_mtf_adjustment(daily, h4, regime="BULL") == 5


def test_mtf_bearish_divergence_penalty():
    from multi_timeframe import compute_mtf_adjustment, TimeframeTechnicals
    daily = TimeframeTechnicals(rsi_14=85, macd_above_signal=False, price_above_sma20=True)
    h4 = TimeframeTechnicals(rsi_14=30, macd_above_signal=False, price_above_sma20=False)
    assert compute_mtf_adjustment(daily, h4, regime="BULL") == -5


def test_mtf_no_4h_data_returns_zero():
    from multi_timeframe import compute_mtf_adjustment, TimeframeTechnicals
    daily = TimeframeTechnicals(rsi_14=60)
    assert compute_mtf_adjustment(daily, None, regime="BULL") == 0


# ────────────────────────── Phase 8 PEAD ────────────────────────────────


def test_pead_qualifying_setup():
    from pead_strategy import is_pead_setup
    assert is_pead_setup(eps_surprise_pct=8.0, gap_up_pct=4.0,
                         volume_ratio=2.5, days_since_earnings=1) is True


def test_pead_fails_weak_beat():
    from pead_strategy import is_pead_setup
    assert is_pead_setup(eps_surprise_pct=2.0, gap_up_pct=4.0,
                         volume_ratio=2.5, days_since_earnings=1) is False


def test_pead_fails_small_gap():
    from pead_strategy import is_pead_setup
    assert is_pead_setup(eps_surprise_pct=8.0, gap_up_pct=1.5,
                         volume_ratio=2.5, days_since_earnings=1) is False


def test_pead_fails_low_volume():
    from pead_strategy import is_pead_setup
    assert is_pead_setup(eps_surprise_pct=8.0, gap_up_pct=4.0,
                         volume_ratio=1.5, days_since_earnings=1) is False


def test_pead_fails_outside_window():
    from pead_strategy import is_pead_setup
    # 5 days post-earnings = past the 1-2d entry window
    assert is_pead_setup(eps_surprise_pct=8.0, gap_up_pct=4.0,
                         volume_ratio=2.5, days_since_earnings=5) is False


def test_pead_score_ranks_correctly():
    from pead_strategy import score_pead
    weak = score_pead(eps_surprise_pct=5, gap_up_pct=3, volume_ratio=2)
    strong = score_pead(eps_surprise_pct=20, gap_up_pct=10, volume_ratio=5)
    assert strong > weak
    assert 0.0 <= weak <= 1.0
    assert 0.0 <= strong <= 1.0


def test_pead_exit_target_hit():
    from pead_strategy import should_exit_pead
    ok, reason = should_exit_pead(position_pnl_pct=8.5, days_held=3)
    assert ok and "TARGET" in reason


def test_pead_exit_stop_hit():
    from pead_strategy import should_exit_pead
    ok, reason = should_exit_pead(position_pnl_pct=-3.5, days_held=2)
    assert ok and "STOP" in reason


def test_pead_exit_time_stop():
    from pead_strategy import should_exit_pead
    ok, reason = should_exit_pead(position_pnl_pct=2.0, days_held=11)
    assert ok and "TIME_STOP" in reason


def test_pead_no_exit_in_normal_holding():
    from pead_strategy import should_exit_pead
    ok, _ = should_exit_pead(position_pnl_pct=2.0, days_held=3)
    assert ok is False
