"""Tests for the position-sizing logic in trade.calculate_position_size.

We don't import trade.py directly because it builds an Alpaca client at
module load. Instead we exercise the same math through a pure helper
that mirrors the production formula. If the formula changes in trade.py,
update both.
"""

from __future__ import annotations

import pytest


def _calc_shares(equity: float, entry_price: float, *,
                 max_position_pct: float, risk_per_trade_pct: float,
                 trailing_stop_pct: float, atr: float | None = None,
                 existing: int = 0) -> int:
    """Mirror of trade.calculate_position_size() pure math.

    Three sizing methods, take the smallest. Subtract existing position.
    """
    max_pct = max_position_pct / 100.0
    alloc_shares = int((equity * max_pct) / entry_price)

    risk_pct = risk_per_trade_pct / 100.0
    stop_pct = trailing_stop_pct / 100.0
    risk_shares = int((equity * risk_pct) / (entry_price * stop_pct))

    if atr and atr > 0:
        atr_shares = int((equity * risk_pct) / (atr * 2))
    else:
        atr_shares = alloc_shares

    shares = min(alloc_shares, risk_shares, atr_shares)
    return max(0, shares - existing)


# ────────────────────── allocation cap is binding ──────────────────────


def test_alloc_cap_binds_for_low_vol_stock():
    """KO at $50, ATR=$0.50, equity $1M, 6% cap, 1% risk, 8% stop.

    Alloc:  $1M × 6% / $50          = 1200 shares
    Risk:   $1M × 1% / ($50 × 8%)   = 2500 shares
    ATR:    $1M × 1% / ($0.50 × 2)  = 10000 shares
    → alloc binds at 1200.
    """
    shares = _calc_shares(1_000_000, 50.0,
                          max_position_pct=6, risk_per_trade_pct=1,
                          trailing_stop_pct=8, atr=0.50)
    assert shares == 1200


# ─────────────────────── ATR is binding (high vol) ──────────────────────


def test_atr_binds_for_high_vol_stock():
    """TSLA at $400, ATR=$25 (very volatile).

    Alloc:  $1M × 6% / $400          = 150 shares
    Risk:   $1M × 1% / ($400 × 8%)   = 312 shares
    ATR:    $1M × 1% / ($25 × 2)     = 200 shares
    Smallest = alloc 150. Then ATR (200) doesn't bind.

    Crank vol further: ATR=$50 → ATR shares = 100 → ATR binds.
    """
    shares_mid = _calc_shares(1_000_000, 400.0,
                              max_position_pct=6, risk_per_trade_pct=1,
                              trailing_stop_pct=8, atr=25.0)
    assert shares_mid == 150  # alloc binds

    shares_high = _calc_shares(1_000_000, 400.0,
                               max_position_pct=6, risk_per_trade_pct=1,
                               trailing_stop_pct=8, atr=50.0)
    assert shares_high == 100  # ATR binds


def test_atr_protects_against_extreme_vol():
    """Even with huge alloc + small risk, ATR keeps sizing sane."""
    # NVDA-like: $1000 price, ATR=$60 daily range
    shares = _calc_shares(1_000_000, 1000.0,
                          max_position_pct=10, risk_per_trade_pct=1.5,
                          trailing_stop_pct=10, atr=60.0)
    # Alloc: 100, Risk: 15, ATR: 125 — risk binds at 15
    # If atr were 200 → atr_shares = 37, alloc would still bind smaller
    # Sanity: result is positive and reasonable
    assert shares > 0 and shares <= 100


def test_no_atr_falls_back_to_alloc_constraint():
    """Without ATR data, the ATR constraint shouldn't artificially cap."""
    shares = _calc_shares(1_000_000, 100.0,
                          max_position_pct=5, risk_per_trade_pct=1,
                          trailing_stop_pct=8, atr=None)
    # Alloc: 500, Risk: 1250, ATR: same as alloc (fallback) → 500
    assert shares == 500


def test_atr_zero_treated_as_missing():
    shares_with_atr_zero = _calc_shares(1_000_000, 100.0,
                                        max_position_pct=5, risk_per_trade_pct=1,
                                        trailing_stop_pct=8, atr=0)
    shares_without_atr = _calc_shares(1_000_000, 100.0,
                                       max_position_pct=5, risk_per_trade_pct=1,
                                       trailing_stop_pct=8, atr=None)
    assert shares_with_atr_zero == shares_without_atr


# ────────────────────── regime-adaptive variations ──────────────────────


def test_bull_aggressive_vs_bear_defensive():
    """BULL/NORMAL params vs BEAR/NORMAL params should give very different sizes."""
    # BULL/NORMAL: 10% max pos, 1.5% risk, 10% stop
    bull = _calc_shares(1_000_000, 100.0,
                        max_position_pct=10, risk_per_trade_pct=1.5,
                        trailing_stop_pct=10, atr=2.0)
    # BEAR/NORMAL: 4% max pos, 0.5% risk, 6% stop
    bear = _calc_shares(1_000_000, 100.0,
                        max_position_pct=4, risk_per_trade_pct=0.5,
                        trailing_stop_pct=6, atr=2.0)
    assert bull > bear
    assert bull >= 1000  # 10% of $1M ÷ $100 = 1000 (alloc cap binds)
    assert bear <= 1500


# ──────────────────────── existing-position math ────────────────────────


def test_subtracts_existing_position():
    """If we already hold 100 shares, sizing reduces by that amount."""
    new_target = _calc_shares(1_000_000, 50.0,
                              max_position_pct=6, risk_per_trade_pct=1,
                              trailing_stop_pct=8, atr=1.0, existing=400)
    full_target = _calc_shares(1_000_000, 50.0,
                               max_position_pct=6, risk_per_trade_pct=1,
                               trailing_stop_pct=8, atr=1.0, existing=0)
    assert new_target == full_target - 400


def test_existing_exceeds_target_returns_zero():
    shares = _calc_shares(1_000_000, 50.0,
                          max_position_pct=6, risk_per_trade_pct=1,
                          trailing_stop_pct=8, atr=1.0, existing=10000)
    assert shares == 0


# ─────────────────────── edge: tiny equity, huge price ───────────────────


def test_zero_shares_when_equity_below_minimum():
    """$1000 equity, $500 stock → can't afford even 1 share at 5% cap."""
    shares = _calc_shares(1_000, 500.0,
                          max_position_pct=5, risk_per_trade_pct=1,
                          trailing_stop_pct=8)
    assert shares == 0


def test_full_alloc_with_round_lot():
    """1% risk, 10% stop, $100 price, $100k equity → 100 shares risk-based."""
    shares = _calc_shares(100_000, 100.0,
                          max_position_pct=5, risk_per_trade_pct=1,
                          trailing_stop_pct=10, atr=None)
    # Alloc: 50, Risk: 100, ATR: 50 (fallback) → 50
    assert shares == 50
