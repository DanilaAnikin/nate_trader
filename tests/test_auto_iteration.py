"""Tests for the auto-iteration tracker."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _clean_state(tmp_path, monkeypatch):
    """Isolated state paths per test."""
    tracker = tmp_path / "alpha_tracker.json"
    latest = tmp_path / "latest_result.json"
    ml_meta = tmp_path / "ml_metadata.json"
    monkeypatch.setattr("auto_iteration.TRACKER_PATH", tracker)
    monkeypatch.setattr("auto_iteration.LATEST_RESULT_PATH", latest)
    monkeypatch.setattr("auto_iteration.ML_META_PATH", ml_meta)
    yield


def _write_latest(path, alpha=2.0, total=14.0, sharpe=0.4, dd=-10.0, trades=850, run_id="single_test"):
    path.write_text(json.dumps({
        "run_id": run_id,
        "metrics": {
            "alpha_annual_pct": alpha,
            "total_return_pct": total,
            "annual_return_pct": alpha + 10,
            "sharpe_ratio": sharpe,
            "max_drawdown_pct": dd,
            "n_trades": trades,
            "win_rate_pct": 50.0,
        },
    }))


def test_track_first_run(tmp_path, monkeypatch):
    import auto_iteration as ai
    _write_latest(ai.LATEST_RESULT_PATH, alpha=3.5)
    row = ai.track_latest()
    assert row["alpha_annual_pct"] == 3.5
    assert row["run_id"] == "single_test"
    tracker = json.loads(ai.TRACKER_PATH.read_text())
    assert tracker["n_iterations"] == 1
    assert tracker["best_run"]["alpha_annual_pct"] == 3.5


def test_track_updates_best_when_improved(tmp_path, monkeypatch):
    import auto_iteration as ai
    _write_latest(ai.LATEST_RESULT_PATH, alpha=2.0, run_id="r1")
    ai.track_latest()
    _write_latest(ai.LATEST_RESULT_PATH, alpha=5.0, run_id="r2")
    ai.track_latest()
    tracker = json.loads(ai.TRACKER_PATH.read_text())
    assert tracker["best_run"]["alpha_annual_pct"] == 5.0
    assert tracker["best_run"]["run_id"] == "r2"
    assert tracker["n_iterations"] == 2


def test_track_keeps_best_when_regressed(tmp_path, monkeypatch):
    import auto_iteration as ai
    _write_latest(ai.LATEST_RESULT_PATH, alpha=5.0, run_id="best")
    ai.track_latest()
    _write_latest(ai.LATEST_RESULT_PATH, alpha=1.0, run_id="bad")
    ai.track_latest()
    tracker = json.loads(ai.TRACKER_PATH.read_text())
    assert tracker["best_run"]["alpha_annual_pct"] == 5.0
    assert tracker["best_run"]["run_id"] == "best"


def test_track_regression_flag_triggers(tmp_path, monkeypatch):
    """7-day moving avg around 5%, today's run at 1% → flagged."""
    import auto_iteration as ai
    # Seed 4 runs at alpha 5%
    for i in range(4):
        _write_latest(ai.LATEST_RESULT_PATH, alpha=5.0, run_id=f"r{i}")
        ai.track_latest()
    # New run at 1% → should be flagged
    _write_latest(ai.LATEST_RESULT_PATH, alpha=1.0, run_id="regression")
    row = ai.track_latest()
    assert row.get("regression_flagged") is True


def test_track_no_regression_when_stable(tmp_path, monkeypatch):
    import auto_iteration as ai
    for i in range(5):
        _write_latest(ai.LATEST_RESULT_PATH, alpha=3.0, run_id=f"r{i}")
        ai.track_latest()
    _write_latest(ai.LATEST_RESULT_PATH, alpha=2.8, run_id="recent")
    row = ai.track_latest()
    assert row.get("regression_flagged") is not True


def test_track_no_latest_result(tmp_path, monkeypatch):
    import auto_iteration as ai
    # No latest_result.json exists
    row = ai.track_latest()
    assert row == {}
