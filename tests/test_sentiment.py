"""Tests for sentiment score → adjustment mapping + text scoring."""

from __future__ import annotations

import pytest

from sentiment import _score_text, sentiment_to_adjustment


# ──────────────────── sentiment_to_adjustment ────────────────────


def test_strong_bullish():
    assert sentiment_to_adjustment(10) == 3
    assert sentiment_to_adjustment(7) == 3


def test_moderate_bullish():
    assert sentiment_to_adjustment(5) == 2
    assert sentiment_to_adjustment(4) == 2


def test_mild_bullish():
    assert sentiment_to_adjustment(2) == 1
    assert sentiment_to_adjustment(3) == 1


def test_neutral_band():
    for v in (-1, 0, 1):
        assert sentiment_to_adjustment(v) == 0


def test_mild_bearish():
    assert sentiment_to_adjustment(-2) == -1
    assert sentiment_to_adjustment(-3) == -1


def test_moderate_bearish():
    assert sentiment_to_adjustment(-4) == -2
    assert sentiment_to_adjustment(-5) == -2


def test_strong_bearish():
    assert sentiment_to_adjustment(-7) == -3
    assert sentiment_to_adjustment(-10) == -3


# ──────────────────────── _score_text ────────────────────────


def test_text_bullish_with_ticker():
    b, s = _score_text("$NVDA to the moon! buy buy buy 🚀", "NVDA")
    assert b > 0
    assert s == 0


def test_text_bearish_with_ticker():
    b, s = _score_text("$NVDA crash incoming, dumping puts", "NVDA")
    assert b == 0  # "buy" not in text
    assert s > 0


def test_text_no_ticker_returns_zero():
    """Text without ticker reference shouldn't contribute."""
    b, s = _score_text("buy buy buy moon rocket", "NVDA")
    assert b == 0
    assert s == 0


def test_text_ticker_alone_no_keywords():
    b, s = _score_text("$NVDA had a quarterly call yesterday", "NVDA")
    assert b == 0
    assert s == 0


def test_text_mixed_signals():
    b, s = _score_text("$NVDA bull market but earnings miss expected", "NVDA")
    assert b > 0
    assert s > 0


def test_text_case_insensitive():
    b1, _ = _score_text("$NVDA BULLISH RALLY", "NVDA")
    b2, _ = _score_text("$nvda bullish rally", "nvda")
    assert b1 == b2 and b1 > 0
