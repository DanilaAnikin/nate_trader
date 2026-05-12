"""Tests for scripts/sector_rotation.py.

External Alpaca API fetches are skipped — we test the pure-math
ranking and adjustment logic directly with injected data.
"""

from __future__ import annotations

import pytest

from sector_rotation import (
    compute_sector_alpha, rank_sectors, compute_sector_adjustment,
    BONUS_POINTS, PENALTY_POINTS, SECTOR_ETF,
)


# ─────────────────────── compute_sector_alpha ────────────────────────


def test_alpha_basic():
    returns = {"XLK": 12.0, "XLF": 8.0, "XLV": 4.0, "SPY": 6.0}
    alpha = compute_sector_alpha(returns, spy_return=6.0)
    assert alpha["Technology"] == pytest.approx(6.0)
    assert alpha["Financial"] == pytest.approx(2.0)
    assert alpha["Healthcare"] == pytest.approx(-2.0)


def test_alpha_missing_etf_returns_none():
    returns = {"XLK": 10.0}  # only one ETF has data
    alpha = compute_sector_alpha(returns, spy_return=5.0)
    assert alpha["Technology"] == 5.0
    assert alpha["Financial"] is None
    assert alpha["Energy"] is None


def test_alpha_none_spy_makes_all_none():
    returns = {"XLK": 10.0, "XLF": 5.0}
    alpha = compute_sector_alpha(returns, spy_return=None)
    assert all(v is None for v in alpha.values())


# ─────────────────────────── rank_sectors ────────────────────────────


def test_rank_top_and_bottom():
    alpha = {
        "Technology": 8.0,
        "Healthcare": 5.0,
        "Financial": 3.0,
        "Consumer": 1.0,
        "Industrial": -1.0,
        "Energy": -3.0,
        "Materials": -5.0,
        "Utilities": -7.0,
    }
    top, bottom = rank_sectors(alpha)
    assert top == ["Technology", "Healthcare", "Financial"]
    assert bottom == ["Energy", "Materials", "Utilities"]


def test_rank_drops_nones():
    alpha = {
        "Technology": 8.0,
        "Healthcare": None,  # dropped
        "Financial": 3.0,
        "Energy": -3.0,
        "Utilities": -7.0,
    }
    top, bottom = rank_sectors(alpha)
    # Only 4 valid sectors — top-3 + bottom-3 overlap by design (small universe)
    assert "Technology" in top
    assert "Utilities" in bottom
    assert "Healthcare" not in top
    assert "Healthcare" not in bottom


def test_rank_handles_ties():
    """Sort is stable enough — same alpha → either order is acceptable."""
    alpha = {"Technology": 5.0, "Healthcare": 5.0, "Financial": 5.0,
             "Consumer": -1.0, "Energy": -1.0, "Materials": -1.0}
    top, bottom = rank_sectors(alpha)
    assert len(top) == 3
    assert len(bottom) == 3


# ──────────────────── compute_sector_adjustment ──────────────────────


def test_adjustment_top_sector_bonus():
    state = {"top_sectors": ["Technology", "Healthcare", "Financial"],
             "bottom_sectors": ["Energy", "Materials", "Utilities"]}
    assert compute_sector_adjustment("Technology", state) == BONUS_POINTS


def test_adjustment_bottom_sector_penalty():
    state = {"top_sectors": ["Technology"],
             "bottom_sectors": ["Energy", "Utilities", "Materials"]}
    assert compute_sector_adjustment("Utilities", state) == PENALTY_POINTS


def test_adjustment_middle_sector_zero():
    state = {"top_sectors": ["Technology", "Healthcare", "Financial"],
             "bottom_sectors": ["Energy", "Materials", "Utilities"]}
    assert compute_sector_adjustment("Consumer", state) == 0


def test_adjustment_no_state_is_zero():
    assert compute_sector_adjustment("Technology", {}) == 0


def test_adjustment_excluded_sectors():
    state = {"top_sectors": ["Technology"], "bottom_sectors": ["Energy"]}
    assert compute_sector_adjustment("Benchmark", state) == 0
    assert compute_sector_adjustment("Hedge", state) == 0
    assert compute_sector_adjustment("Unknown", state) == 0
    assert compute_sector_adjustment("", state) == 0
    assert compute_sector_adjustment(None, state) == 0


def test_sector_etf_map_completeness():
    """Ensure every sector listed in the map has a non-empty ETF ticker."""
    assert len(SECTOR_ETF) >= 10
    for sec, etf in SECTOR_ETF.items():
        assert sec and etf
        assert etf.startswith("X")  # SPDR sector ETFs


# ───────────────────── integration: rank + adjust ────────────────────


def test_full_pipeline():
    """Realistic scenario: tech is leading bull rotation."""
    returns = {
        "XLK": 15.0, "XLY": 12.0, "XLC": 10.0,  # leaders
        "XLF": 7.0, "XLV": 6.0, "XLI": 5.0,
        "XLB": 2.0, "XLRE": 1.0,
        "XLE": -3.0, "XLU": -5.0,
        "SPY": 8.0,
    }
    alpha = compute_sector_alpha(returns, spy_return=8.0)
    top, bottom = rank_sectors(alpha)
    state = {"top_sectors": top, "bottom_sectors": bottom,
             "sector_alpha": alpha}

    assert compute_sector_adjustment("Technology", state) == BONUS_POINTS
    assert compute_sector_adjustment("Consumer", state) == BONUS_POINTS
    assert compute_sector_adjustment("Utilities", state) == PENALTY_POINTS
    assert compute_sector_adjustment("Energy", state) == PENALTY_POINTS
    assert compute_sector_adjustment("Industrial", state) == 0
