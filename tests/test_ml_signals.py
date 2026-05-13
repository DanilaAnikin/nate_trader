"""Tests for ML signal aggregator — pure logic + score mapping."""

from __future__ import annotations

import pytest

from ml_signals import ml_score_from_proba, FEATURE_NAMES


def test_score_strong_buy():
    assert ml_score_from_proba(0.80) == 5
    assert ml_score_from_proba(0.65) == 5  # boundary


def test_score_moderate_buy():
    assert ml_score_from_proba(0.60) == 3
    assert ml_score_from_proba(0.55) == 3


def test_score_neutral_band():
    assert ml_score_from_proba(0.50) == 0
    assert ml_score_from_proba(0.46) == 0
    assert ml_score_from_proba(0.54) == 0


def test_score_moderate_sell():
    assert ml_score_from_proba(0.40) == -3
    assert ml_score_from_proba(0.45) == -3


def test_score_strong_sell():
    assert ml_score_from_proba(0.20) == -5
    assert ml_score_from_proba(0.35) == -5


def test_score_none_returns_zero():
    """No model = zero adjustment, never crash."""
    assert ml_score_from_proba(None) == 0


def test_feature_names_complete():
    """The feature schema is non-empty and matches expected count."""
    assert len(FEATURE_NAMES) >= 15
    assert "rsi_14" in FEATURE_NAMES
    assert "regime_bull" in FEATURE_NAMES
    assert "ret_5d" in FEATURE_NAMES


def test_feature_names_no_duplicates():
    assert len(FEATURE_NAMES) == len(set(FEATURE_NAMES))
