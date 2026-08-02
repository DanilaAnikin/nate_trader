from __future__ import annotations

import json

import pytest

from backtest import download_history


def _bar(date: str, close: float = 100.0) -> dict:
    return {
        "date": date,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "volume": 1_000_000,
    }


def test_existing_cache_is_extended_backward_and_forward(tmp_path, monkeypatch):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    (tmp_path / "SPY.json").write_text(
        json.dumps({"bars": [_bar("2021-01-04"), _bar("2021-01-05")]})
    )
    calls: list[tuple[str, str, str]] = []

    def fake_fetch(symbol: str, start: str, end: str) -> list[dict]:
        calls.append((symbol, start, end))
        if end == "2021-01-03":
            return [_bar("2020-12-31", 90.0)]
        return [_bar("2021-01-06", 110.0)]

    monkeypatch.setattr(download_history, "fetch_bars", fake_fetch)

    count = download_history.download_symbol("SPY", "2020-01-01", "2021-01-06")

    assert calls == [
        ("SPY", "2020-01-01", "2021-01-03"),
        ("SPY", "2021-01-06", "2021-01-06"),
    ]
    payload = json.loads((tmp_path / "SPY.json").read_text())
    assert count == 4
    assert [bar["date"] for bar in payload["bars"]] == [
        "2020-12-31",
        "2021-01-04",
        "2021-01-05",
        "2021-01-06",
    ]
    assert payload["from"] == "2020-12-31"
    assert payload["to"] == "2021-01-06"


def test_fully_cached_requested_range_does_not_fetch(tmp_path, monkeypatch):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    (tmp_path / "AAPL.json").write_text(
        json.dumps({"bars": [_bar("2021-01-04"), _bar("2021-01-05")]})
    )

    def unexpected_fetch(*_args):
        raise AssertionError("fetch_bars must not be called")

    monkeypatch.setattr(download_history, "fetch_bars", unexpected_fetch)

    assert download_history.download_symbol(
        "AAPL", "2021-01-04", "2021-01-05"
    ) == 2


def test_invalid_requested_range_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)

    with pytest.raises(ValueError, match="is after"):
        download_history.download_symbol("SPY", "2021-01-06", "2021-01-05")


def test_rebuild_fetches_full_range_and_replaces_overlapping_dates(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    (tmp_path / "BIL.json").write_text(
        json.dumps({"bars": [_bar("2021-01-04", 99.0)]})
    )
    monkeypatch.setattr(
        download_history,
        "fetch_bars",
        lambda symbol, start, end: [
            _bar("2021-01-04", 100.0),
            _bar("2021-01-05", 101.0),
        ],
    )

    count = download_history.download_symbol(
        "BIL",
        "2021-01-04",
        "2021-01-05",
        rebuild=True,
    )

    payload = json.loads((tmp_path / "BIL.json").read_text())
    assert count == 2
    assert [bar["close"] for bar in payload["bars"]] == [100.0, 101.0]


def test_rebuild_removes_old_interior_row_missing_from_fresh_response(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    path = tmp_path / "SPY.json"
    path.write_text(
        json.dumps(
            {
                "bars": [
                    _bar("2021-01-04", 90.0),
                    _bar("2021-01-05", 9_999.0),
                    _bar("2021-01-06", 92.0),
                ]
            }
        )
    )
    monkeypatch.setattr(
        download_history,
        "fetch_bars",
        lambda *args: [
            _bar("2021-01-04", 100.0),
            _bar("2021-01-06", 102.0),
        ],
    )

    download_history.download_symbol(
        "SPY", "2021-01-04", "2021-01-06", rebuild=True
    )

    payload = json.loads(path.read_text())
    assert [bar["date"] for bar in payload["bars"]] == [
        "2021-01-04",
        "2021-01-06",
    ]
    assert [bar["close"] for bar in payload["bars"]] == [100.0, 102.0]


def test_rebuild_retains_cache_only_outside_requested_interval(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    path = tmp_path / "SPY.json"
    path.write_text(
        json.dumps(
            {
                "bars": [
                    _bar("2020-12-31", 80.0),
                    _bar("2021-01-04", 90.0),
                    _bar("2021-01-05", 91.0),
                    _bar("2021-01-06", 120.0),
                ]
            }
        )
    )
    monkeypatch.setattr(
        download_history,
        "fetch_bars",
        lambda *args: [
            _bar("2021-01-04", 100.0),
            _bar("2021-01-05", 101.0),
        ],
    )

    download_history.download_symbol(
        "SPY", "2021-01-04", "2021-01-05", rebuild=True
    )

    payload = json.loads(path.read_text())
    assert [(bar["date"], bar["close"]) for bar in payload["bars"]] == [
        ("2020-12-31", 80.0),
        ("2021-01-04", 100.0),
        ("2021-01-05", 101.0),
        ("2021-01-06", 120.0),
    ]


def test_truncated_rebuild_preserves_existing_cache_and_raises(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    path = tmp_path / "SPY.json"
    original = {
        "bars": [
            _bar("2021-01-04", 100.0),
            _bar("2021-01-05", 101.0),
            _bar("2021-01-06", 102.0),
        ]
    }
    path.write_text(json.dumps(original))
    monkeypatch.setattr(
        download_history,
        "fetch_bars",
        lambda *args: [_bar("2021-01-05", 201.0)],
    )

    with pytest.raises(RuntimeError, match="incomplete rebuild coverage"):
        download_history.download_symbol(
            "SPY", "2021-01-04", "2021-01-06", rebuild=True
        )

    assert json.loads(path.read_text()) == original


def test_stale_rebuild_endpoint_is_rejected_without_cache_write(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    monkeypatch.setattr(
        download_history,
        "fetch_bars",
        lambda *args: [_bar("2021-01-04", 100.0)],
    )

    with pytest.raises(RuntimeError, match="incomplete rebuild endpoint"):
        download_history.download_symbol(
            "SPY", "2021-01-01", "2021-01-31", rebuild=True
        )

    assert not (tmp_path / "SPY.json").exists()


def test_fetch_failure_preserves_existing_cache_and_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(download_history, "BARS_DIR", tmp_path)
    path = tmp_path / "SPY.json"
    original = {"bars": [_bar("2021-01-04", 100.0)]}
    path.write_text(json.dumps(original))

    def failed_fetch(*_args):
        raise RuntimeError("network unavailable")

    monkeypatch.setattr(download_history, "fetch_bars", failed_fetch)

    with pytest.raises(RuntimeError, match="incomplete refresh"):
        download_history.download_symbol(
            "SPY",
            "2020-01-01",
            "2021-01-05",
            rebuild=True,
        )

    assert json.loads(path.read_text()) == original
