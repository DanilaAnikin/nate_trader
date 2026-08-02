from __future__ import annotations

from types import SimpleNamespace

import pandas as pd
import pytest

import research


def test_batch_history_uses_multi_symbol_request_and_splits_frames(monkeypatch):
    index = pd.MultiIndex.from_product(
        [
            ["AAA", "BBB"],
            pd.to_datetime(["2025-01-02", "2025-01-03", "2025-01-06"], utc=True),
        ],
        names=["symbol", "timestamp"],
    )
    frame = pd.DataFrame(
        {
            "open": range(6),
            "high": range(6),
            "low": range(6),
            "close": range(6),
            "volume": [1_000_000] * 6,
        },
        index=index,
    )

    class Client:
        def __init__(self):
            self.requests = []

        def get_stock_bars(self, request):
            self.requests.append(request)
            return SimpleNamespace(df=frame)

    client = Client()
    monkeypatch.setattr(research, "_get_data_client", lambda: client)

    frames = research.get_bars_batch(["BBB", "AAA"], days=2, chunk_size=200)

    assert set(frames) == {"AAA", "BBB"}
    assert len(frames["AAA"]) == len(frames["BBB"]) == 2
    assert len(client.requests) == 1
    assert client.requests[0].symbol_or_symbols == ["AAA", "BBB"]


def test_batch_history_fails_closed_when_response_omits_requested_symbol(
    monkeypatch,
):
    index = pd.MultiIndex.from_product(
        [
            ["AAA"],
            pd.to_datetime(["2025-01-02", "2025-01-03"], utc=True),
        ],
        names=["symbol", "timestamp"],
    )
    frame = pd.DataFrame(
        {
            "open": [1.0, 1.0],
            "high": [1.0, 1.0],
            "low": [1.0, 1.0],
            "close": [1.0, 1.0],
            "volume": [1_000_000, 1_000_000],
        },
        index=index,
    )
    monkeypatch.setattr(
        research,
        "_get_data_client",
        lambda: SimpleNamespace(
            get_stock_bars=lambda _request: SimpleNamespace(df=frame)
        ),
    )

    with pytest.raises(research.BarCoverageError, match=r"missing.*BBB"):
        research.get_bars_batch(["AAA", "BBB"])


def test_batch_history_fails_closed_on_empty_chunk(monkeypatch):
    monkeypatch.setattr(
        research,
        "_get_data_client",
        lambda: SimpleNamespace(
            get_stock_bars=lambda _request: SimpleNamespace(df=pd.DataFrame())
        ),
    )

    with pytest.raises(research.BarCoverageError, match=r"AAA, BBB"):
        research.get_bars_batch(["BBB", "AAA"])


def test_batch_history_best_effort_requires_explicit_opt_out(monkeypatch):
    monkeypatch.setattr(
        research,
        "_get_data_client",
        lambda: SimpleNamespace(
            get_stock_bars=lambda _request: SimpleNamespace(df=pd.DataFrame())
        ),
    )

    assert research.get_bars_batch(
        ["AAA"], require_complete=False
    ) == {}
