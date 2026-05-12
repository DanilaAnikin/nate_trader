"""Tests for scripts/mean_reversion.py."""

from __future__ import annotations

import pytest

from mean_reversion import (
    is_mr_setup, score_mr_setup, should_exit_mr, is_active,
    find_candidates, mr_position_size,
    RSI_OVERSOLD, RSI_EXIT, GAIN_TARGET_PCT, LOSS_STOP_PCT, TIME_STOP_DAYS,
    MR_SLEEVE_PCT, MR_POSITION_PCT, ACTIVE_REGIMES,
)


# ───────────────────────────── is_mr_setup ─────────────────────────────


def _good_setup(**overrides):
    """Helper: build a technicals dict that *just barely* passes all checks.

    Updated post-tightening (Phase 3 v2):
      RSI<25, 10% below SMA20, volume ≥2.5×, RS floor −3% vs SPY.
    """
    base = {
        "rsi_14": 22.0,                # below 25
        "price": 88.0,
        "sma_20": 100.0,               # 12% below
        "volume_ratio": 3.0,            # 3× avg
        "twenty_day_return": -2.0,     # within RS floor
    }
    base.update(overrides)
    return base


def test_setup_passes_all_checks():
    ok, reasons = is_mr_setup(_good_setup(), spy_20d_return=0.0)
    assert ok is True
    assert any("RSI" in r for r in reasons)
    assert any("below SMA20" in r for r in reasons)
    assert any("capitulation" in r for r in reasons)


def test_setup_fails_rsi_not_oversold():
    ok, reasons = is_mr_setup(_good_setup(rsi_14=40.0))
    assert ok is False


def test_setup_fails_price_too_close_to_sma():
    ok, _ = is_mr_setup(_good_setup(price=95.0))  # only 5% below SMA20 = 100
    assert ok is False


def test_setup_fails_low_volume():
    ok, _ = is_mr_setup(_good_setup(volume_ratio=1.0))
    assert ok is False


def test_setup_filters_falling_knife():
    """RS floor is −3%; anything worse should reject."""
    tech = _good_setup(twenty_day_return=-10.0)
    ok, reasons = is_mr_setup(tech, spy_20d_return=0.0)
    assert ok is False
    assert any("falling knife" in r for r in reasons)


def test_setup_accepts_oversold_relative_to_market_decline():
    """SPY down −10% in 20d, stock down −12% → only −2% alpha → not falling knife."""
    tech = _good_setup(twenty_day_return=-12.0)
    ok, _ = is_mr_setup(tech, spy_20d_return=-10.0)
    assert ok is True


def test_setup_missing_data_safe_default():
    ok, _ = is_mr_setup({})
    assert ok is False
    ok, _ = is_mr_setup({"rsi_14": 25.0})  # missing price/sma
    assert ok is False


# ───────────────────────────── score_mr_setup ──────────────────────────


def test_score_higher_when_more_oversold():
    weak = _good_setup(rsi_14=28.0)
    strong = _good_setup(rsi_14=15.0)
    assert score_mr_setup(strong) > score_mr_setup(weak)


def test_score_higher_with_bigger_volume_spike():
    weak = _good_setup(volume_ratio=1.6)
    strong = _good_setup(volume_ratio=4.0)
    assert score_mr_setup(strong) > score_mr_setup(weak)


def test_score_in_unit_interval():
    s = score_mr_setup(_good_setup())
    assert 0.0 <= s <= 1.0


# ────────────────────────── should_exit_mr ─────────────────────────────


def test_exit_on_target():
    ok, reason = should_exit_mr(position_pnl_pct=GAIN_TARGET_PCT + 0.1,
                                current_rsi=40, days_held=2)
    assert ok and "TARGET" in reason


def test_exit_on_stop():
    ok, reason = should_exit_mr(position_pnl_pct=LOSS_STOP_PCT - 0.1,
                                current_rsi=40, days_held=2)
    assert ok and "STOP" in reason


def test_exit_on_rsi_bounce():
    ok, reason = should_exit_mr(position_pnl_pct=2.0,
                                current_rsi=RSI_EXIT + 1, days_held=1)
    assert ok and "RSI" in reason


def test_exit_on_time_stop():
    ok, reason = should_exit_mr(position_pnl_pct=1.0,
                                current_rsi=40, days_held=TIME_STOP_DAYS + 1)
    assert ok and "TIME" in reason


def test_no_exit_during_normal_holding():
    ok, _ = should_exit_mr(position_pnl_pct=2.0,
                           current_rsi=40, days_held=2)
    assert ok is False


def test_exit_no_rsi_data_doesnt_crash():
    ok, _ = should_exit_mr(position_pnl_pct=1.0,
                           current_rsi=None, days_held=2)
    assert ok is False  # no other exit conditions met


# ────────────────────────────── is_active ──────────────────────────────


def test_active_neutral_and_bear():
    assert is_active("NEUTRAL") is True
    assert is_active("BEAR") is True


def test_inactive_in_bull():
    assert is_active("BULL") is False


def test_inactive_when_regime_none():
    assert is_active(None) is False


# ──────────────────────────── find_candidates ──────────────────────────


def test_find_candidates_empty_in_bull():
    tech = {"AAPL": _good_setup()}
    sectors = {"AAPL": "Technology"}
    out = find_candidates(tech, sectors, regime="BULL", spy_20d_return=0.0)
    assert out == []


def test_find_candidates_returns_passing_setups():
    tech = {
        "AAPL": _good_setup(),
        "MSFT": _good_setup(rsi_14=40.0),       # fails RSI check
        "GOOG": _good_setup(volume_ratio=1.2),   # fails volume (need ≥2.5×)
    }
    sectors = {"AAPL": "Technology", "MSFT": "Technology", "GOOG": "Technology"}
    out = find_candidates(tech, sectors, regime="NEUTRAL", spy_20d_return=0.0)
    syms = {c.symbol for c in out}
    assert "AAPL" in syms
    assert "MSFT" not in syms
    assert "GOOG" not in syms


def test_find_candidates_sorted_by_score_desc():
    tech = {
        "A": _good_setup(rsi_14=24.0),   # just barely under sweet spot
        "B": _good_setup(rsi_14=10.0),    # deeply oversold
        "C": _good_setup(rsi_14=18.0),
    }
    sectors = {k: "Technology" for k in tech}
    out = find_candidates(tech, sectors, regime="BEAR", spy_20d_return=0.0)
    syms = [c.symbol for c in out]
    assert syms == ["B", "C", "A"]


def test_find_candidates_skips_error_technicals():
    tech = {"AAPL": _good_setup(), "BROKEN": {"error": "bad data"}}
    sectors = {"AAPL": "Technology", "BROKEN": "Technology"}
    out = find_candidates(tech, sectors, regime="NEUTRAL", spy_20d_return=0.0)
    assert {c.symbol for c in out} == {"AAPL"}


# ─────────────────────────── mr_position_size ──────────────────────────


def test_size_caps_at_per_position_pct():
    """At a fresh sleeve, sizing is capped by MR_POSITION_PCT (2% default)."""
    shares = mr_position_size(equity=1_000_000, entry_price=100.0,
                              mr_sleeve_committed=0)
    # 2% of $1M = $20k → 200 shares at $100
    assert shares == 200


def test_size_zero_when_sleeve_full():
    """If sleeve is already MR_SLEEVE_PCT committed, no new position."""
    full = 1_000_000 * (MR_SLEEVE_PCT / 100.0)
    shares = mr_position_size(equity=1_000_000, entry_price=100.0,
                              mr_sleeve_committed=full)
    assert shares == 0


def test_size_remaining_sleeve_below_per_position_cap():
    """Sleeve almost full → remaining sleeve is binding, not per-pos cap."""
    # Sleeve = 15% = $150k, committed = $145k, remaining = $5k
    shares = mr_position_size(equity=1_000_000, entry_price=50.0,
                              mr_sleeve_committed=145_000)
    # remaining $5k < per-pos $20k → remaining binds: $5k / $50 = 100 shares
    assert shares == 100


def test_size_zero_for_huge_price():
    shares = mr_position_size(equity=1_000_000, entry_price=1_000_000.0,
                              mr_sleeve_committed=0)
    assert shares == 0
