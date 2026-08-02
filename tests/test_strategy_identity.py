from __future__ import annotations

from pathlib import Path

import pandas as pd

from strategy_identity import (
    build_bar_snapshot_identity,
    build_strategy_identity,
    hash_symbol_universe,
)


def test_strategy_identity_is_stable_and_source_sensitive(tmp_path: Path):
    source = tmp_path / "strategy.py"
    source.write_text("VERSION = 1\n")
    policy = {"BULL/NORMAL": {"top_n": 10}}

    first = build_strategy_identity(
        project_root=tmp_path,
        source_paths=("strategy.py",),
        effective_policy=policy,
    )
    second = build_strategy_identity(
        project_root=tmp_path,
        source_paths=("strategy.py",),
        effective_policy=policy,
    )
    source.write_text("VERSION = 2\n")
    changed = build_strategy_identity(
        project_root=tmp_path,
        source_paths=("strategy.py",),
        effective_policy=policy,
    )

    assert first == second
    assert len(first["value"]) == 64
    assert changed["value"] != first["value"]


def test_strategy_identity_is_policy_sensitive(tmp_path: Path):
    (tmp_path / "strategy.py").write_text("VERSION = 1\n")

    first = build_strategy_identity(
        project_root=tmp_path,
        source_paths=("strategy.py",),
        effective_policy={"top_n": 10},
    )
    changed = build_strategy_identity(
        project_root=tmp_path,
        source_paths=("strategy.py",),
        effective_policy={"top_n": 12},
    )

    assert changed["value"] != first["value"]


def test_universe_hash_is_order_independent_but_membership_sensitive():
    assert hash_symbol_universe(["msft", "AAPL", "AAPL"]) == hash_symbol_universe(
        ["AAPL", "MSFT"]
    )
    assert hash_symbol_universe(["AAPL"]) != hash_symbol_universe(
        ["AAPL", "MSFT"]
    )


def test_bar_snapshot_hash_is_prefix_sensitive_but_allows_future_appends():
    class Provider:
        def __init__(self):
            self.frame = pd.DataFrame(
                {
                    "open": [100.0, 101.0],
                    "high": [101.0, 102.0],
                    "low": [99.0, 100.0],
                    "close": [100.5, 101.5],
                    "volume": [1_000, 1_100],
                },
                index=["2025-01-02", "2025-01-03"],
            )

        def load(self, symbol):
            return self.frame if symbol == "AAA" else None

    provider = Provider()
    first = build_bar_snapshot_identity(
        provider, ["AAA"], [], through_date="2025-01-03"
    )
    provider.frame.loc["2025-01-06"] = [102.0, 103.0, 101.0, 102.5, 1_200]
    appended = build_bar_snapshot_identity(
        provider, ["AAA"], [], through_date="2025-01-03"
    )
    provider.frame.loc["2025-01-02", "close"] = 99.5
    revised = build_bar_snapshot_identity(
        provider, ["AAA"], [], through_date="2025-01-03"
    )

    assert appended["bar_snapshot_sha256"] == first["bar_snapshot_sha256"]
    assert revised["bar_snapshot_sha256"] != first["bar_snapshot_sha256"]
