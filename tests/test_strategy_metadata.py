"""Tests for scripts/strategy_metadata.py — local position tagging."""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import patch

import pytest


@pytest.fixture(autouse=True)
def _clean_metadata(tmp_path, monkeypatch):
    """Each test gets its own metadata file."""
    fake_path = tmp_path / "strategy_metadata.json"
    monkeypatch.setattr("strategy_metadata.METADATA_PATH", fake_path)
    yield


def test_mark_and_get():
    import strategy_metadata as sm
    sm.mark_position("AAPL", "momentum", "2026-05-12")
    assert sm.get_strategy("AAPL") == "momentum"
    assert sm.get_entry_date("AAPL") == "2026-05-12"


def test_default_strategy_is_momentum():
    import strategy_metadata as sm
    assert sm.get_strategy("UNKNOWN") == "momentum"


def test_unmark():
    import strategy_metadata as sm
    sm.mark_position("AAPL", "mr")
    assert sm.get_strategy("AAPL") == "mr"
    sm.unmark_position("AAPL")
    assert sm.get_strategy("AAPL") == "momentum"


def test_positions_by_strategy():
    import strategy_metadata as sm
    sm.mark_position("AAPL", "momentum")
    sm.mark_position("NVDA", "momentum")
    sm.mark_position("KO", "mr")
    sm.mark_position("META", "pead")
    sm.mark_position("SH", "hedge")
    grouped = sm.positions_by_strategy()
    assert set(grouped["momentum"]) == {"AAPL", "NVDA"}
    assert grouped["mr"] == ["KO"]
    assert grouped["pead"] == ["META"]
    assert grouped["hedge"] == ["SH"]


def test_days_held():
    import strategy_metadata as sm
    five_days_ago = (datetime.now() - timedelta(days=5)).strftime("%Y-%m-%d")
    sm.mark_position("AAPL", "momentum", five_days_ago)
    assert sm.days_held("AAPL") == 5


def test_days_held_unknown_symbol():
    import strategy_metadata as sm
    assert sm.days_held("XYZ") is None


def test_sync_drops_stale():
    import strategy_metadata as sm
    sm.mark_position("AAPL", "momentum")
    sm.mark_position("NVDA", "mr")
    sm.mark_position("META", "pead")
    sm.sync_with_positions({"AAPL"})  # only AAPL still held
    assert sm.get_strategy("AAPL") == "momentum"
    assert sm.get_strategy("NVDA") == "momentum"  # back to default
    assert sm.get_strategy("META") == "momentum"


def test_sync_keeps_held():
    import strategy_metadata as sm
    sm.mark_position("AAPL", "mr")
    sm.mark_position("NVDA", "pead")
    sm.sync_with_positions({"AAPL", "NVDA"})
    assert sm.get_strategy("AAPL") == "mr"
    assert sm.get_strategy("NVDA") == "pead"


def test_mark_unknown_strategy_logs_warning_still_stores():
    """Unknown strategy names should be stored anyway (forward compat)."""
    import strategy_metadata as sm
    sm.mark_position("AAPL", "experimental")
    assert sm.get_strategy("AAPL") == "experimental"
