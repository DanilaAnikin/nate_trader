"""Tests for scripts/earnings_calendar.py.

Network calls (Perplexity) are mocked. Pure date math is tested
directly with injected `today` for determinism.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from unittest.mock import patch

import pytest

from earnings_calendar import (
    days_until_earnings, has_earnings_risk, is_stale, refresh_calendar,
    EARNINGS_BLOCK_WINDOW_DAYS,
)


# ─────────────────────── days_until_earnings ────────────────────────


def test_days_until_known_future_date():
    cal = {"dates": {"AAPL": "2026-05-20"}}
    today = date(2026, 5, 12)
    assert days_until_earnings("AAPL", calendar=cal, today=today) == 8


def test_days_until_same_day():
    cal = {"dates": {"AAPL": "2026-05-12"}}
    today = date(2026, 5, 12)
    assert days_until_earnings("AAPL", calendar=cal, today=today) == 0


def test_days_until_past_date_returns_none():
    cal = {"dates": {"AAPL": "2026-05-01"}}
    today = date(2026, 5, 12)
    assert days_until_earnings("AAPL", calendar=cal, today=today) is None


def test_days_until_missing_symbol():
    cal = {"dates": {}}
    today = date(2026, 5, 12)
    assert days_until_earnings("NVDA", calendar=cal, today=today) is None


def test_days_until_explicit_null():
    cal = {"dates": {"AAPL": None}}
    today = date(2026, 5, 12)
    assert days_until_earnings("AAPL", calendar=cal, today=today) is None


def test_days_until_malformed_date_returns_none():
    cal = {"dates": {"AAPL": "not-a-date"}}
    today = date(2026, 5, 12)
    assert days_until_earnings("AAPL", calendar=cal, today=today) is None


# ─────────────────────── has_earnings_risk ────────────────────────


def test_risk_within_window():
    """3 days away → block."""
    cal = {"dates": {"AAPL": "2026-05-15"}}
    today = date(2026, 5, 12)
    assert has_earnings_risk("AAPL", calendar=cal, today=today) is True


def test_risk_exactly_at_window_edge():
    """Exactly EARNINGS_BLOCK_WINDOW_DAYS away → still block."""
    cal = {"dates": {"AAPL": f"2026-05-{12 + EARNINGS_BLOCK_WINDOW_DAYS:02d}"}}
    today = date(2026, 5, 12)
    assert has_earnings_risk("AAPL", calendar=cal, today=today) is True


def test_risk_one_day_past_window():
    """6 days away (window is 5) → no block."""
    cal = {"dates": {"AAPL": "2026-05-18"}}
    today = date(2026, 5, 12)
    assert has_earnings_risk("AAPL", calendar=cal, today=today) is False


def test_risk_today_is_earnings_day():
    cal = {"dates": {"AAPL": "2026-05-12"}}
    today = date(2026, 5, 12)
    assert has_earnings_risk("AAPL", calendar=cal, today=today) is True


def test_risk_unknown_symbol_does_not_block():
    cal = {"dates": {}}
    today = date(2026, 5, 12)
    assert has_earnings_risk("AAPL", calendar=cal, today=today) is False


def test_risk_with_custom_window():
    """Different window_days parameter is respected."""
    cal = {"dates": {"AAPL": "2026-05-22"}}  # 10d away
    today = date(2026, 5, 12)
    assert has_earnings_risk("AAPL", window_days=14, calendar=cal, today=today) is True
    assert has_earnings_risk("AAPL", window_days=5, calendar=cal, today=today) is False


# ──────────────────────────── is_stale ─────────────────────────────


def test_stale_when_no_updated_at():
    assert is_stale({"dates": {}}) is True


def test_stale_when_old():
    old = (datetime.now() - timedelta(days=10)).strftime("%Y-%m-%d %H:%M:%S")
    assert is_stale({"updated_at": old, "dates": {}}) is True


def test_not_stale_when_recent():
    fresh = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    assert is_stale({"updated_at": fresh, "dates": {}}) is False


def test_stale_on_malformed_timestamp():
    assert is_stale({"updated_at": "yesterday-ish", "dates": {}}) is True


# ──────────────────── refresh_calendar (mocked) ─────────────────────


def test_refresh_skips_if_fresh():
    """If cache is fresh, no Perplexity call."""
    fresh = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fake_cache = {"updated_at": fresh, "dates": {"AAPL": "2026-08-01"}}

    with patch("earnings_calendar.load_calendar", return_value=fake_cache), \
         patch("earnings_calendar._ask_perplexity_for_earnings") as mock_perp:
        result = refresh_calendar(symbols=["AAPL"])

    mock_perp.assert_not_called()
    assert result == fake_cache


def test_refresh_force_calls_perplexity():
    fresh = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    fake_cache = {"updated_at": fresh, "dates": {}}

    with patch("earnings_calendar.load_calendar", return_value=fake_cache), \
         patch("earnings_calendar._ask_perplexity_for_earnings",
               return_value={"AAPL": "2026-08-01"}) as mock_perp, \
         patch("earnings_calendar.save_calendar") as mock_save:
        refresh_calendar(symbols=["AAPL"], force=True)

    mock_perp.assert_called_once()
    mock_save.assert_called_once()


def test_refresh_when_stale_calls_perplexity():
    old = (datetime.now() - timedelta(days=10)).strftime("%Y-%m-%d %H:%M:%S")
    fake_cache = {"updated_at": old, "dates": {}}

    with patch("earnings_calendar.load_calendar", return_value=fake_cache), \
         patch("earnings_calendar._ask_perplexity_for_earnings",
               return_value={"AAPL": "2026-08-01", "NVDA": None}) as mock_perp, \
         patch("earnings_calendar.save_calendar"):
        refresh_calendar(symbols=["AAPL", "NVDA"])

    mock_perp.assert_called_once_with(["AAPL", "NVDA"])


def test_refresh_batches_large_symbol_lists():
    """Symbols are batched in groups of 15 to avoid Perplexity context limits."""
    fake_cache = {"updated_at": None, "dates": {}}
    symbols = [f"S{i:02d}" for i in range(32)]  # 32 symbols → 3 batches

    with patch("earnings_calendar.load_calendar", return_value=fake_cache), \
         patch("earnings_calendar._ask_perplexity_for_earnings",
               return_value={s: None for s in symbols}) as mock_perp, \
         patch("earnings_calendar.save_calendar"):
        refresh_calendar(symbols=symbols, force=True)

    assert mock_perp.call_count == 3  # ceil(32 / 15)
