"""Deterministic identity for the exact v11 strategy implementation."""

from __future__ import annotations

import hashlib
from importlib import metadata
import json
from pathlib import Path
import platform
from typing import Any

from utils import PROJECT_ROOT


STRATEGY_IDENTITY_SCHEMA = 1
STRATEGY_SOURCE_PATHS = (
    "requirements.txt",
    "requirements.lock",
    "watchlist.json",
    ".github/workflows/paper-production.yml",
    "scripts/adaptive_momentum.py",
    "scripts/risk_policy.py",
    "scripts/research.py",
    "scripts/strategy_config.py",
    "scripts/universe.py",
    "scripts/backtest/data_provider.py",
    "scripts/backtest/download_history.py",
    "scripts/backtest/engine.py",
    "scripts/backtest/metrics.py",
    "scripts/backtest/portfolio_sim.py",
    "scripts/backtest/validate_v11.py",
    "scripts/execute_trades.py",
    "scripts/momentum_picker.py",
    "scripts/portfolio.py",
    "scripts/production_preflight.py",
    "scripts/production_run.py",
    "scripts/strategy_identity.py",
    "scripts/trade.py",
    "scripts/utils.py",
)
RUNTIME_DISTRIBUTIONS = ("alpaca-py", "numpy", "pandas")


def _runtime_versions() -> dict[str, str]:
    versions = {"python": platform.python_version()}
    for distribution in RUNTIME_DISTRIBUTIONS:
        try:
            versions[distribution] = metadata.version(distribution)
        except metadata.PackageNotFoundError:
            versions[distribution] = "missing"
    return versions


def build_bar_snapshot_identity(
    provider: Any,
    ranking_universe: Any,
    auxiliary_symbols: Any,
    *,
    through_date: str,
) -> dict[str, Any]:
    """Hash the exact adjusted-bar prefix used to support a validation.

    Appending newer sessions does not invalidate the artifact, while a split,
    dividend adjustment, correction, deletion, or missing file at or before
    ``through_date`` does.  The symbol marker is hashed even for missing data,
    so membership and availability cannot collapse to the same digest.
    """

    normalized_ranking = sorted(
        {
            str(symbol).strip().upper()
            for symbol in ranking_universe
            if str(symbol).strip()
        }
    )
    requested = sorted(
        set(normalized_ranking)
        | {
            str(symbol).strip().upper()
            for symbol in auxiliary_symbols
            if str(symbol).strip()
        }
    )
    digest = hashlib.sha256()
    row_count = 0
    observed_symbols = 0
    columns = ["open", "high", "low", "close", "volume"]
    for symbol in requested:
        digest.update(f"symbol:{symbol}\n".encode("utf-8"))
        frame = provider.load(symbol)
        if frame is None or frame.empty:
            digest.update(b"missing\n")
            continue
        sliced = frame.loc[frame.index <= through_date]
        if sliced.empty:
            digest.update(b"empty\n")
            continue
        available_columns = [column for column in columns if column in sliced.columns]
        canonical = sliced.loc[:, available_columns].to_csv(
            lineterminator="\n",
            float_format="%.10g",
        )
        digest.update(canonical.encode("utf-8"))
        observed_symbols += 1
        row_count += len(sliced)
    return {
        "schema_version": 1,
        "ranking_universe_count": len(normalized_ranking),
        "ranking_universe_sha256": hash_symbol_universe(normalized_ranking),
        "bar_snapshot_sha256": digest.hexdigest(),
        "bar_snapshot_through_date": through_date,
        "bar_symbols_requested": len(requested),
        "bar_symbols_observed": observed_symbols,
        "bar_rows_hashed": row_count,
    }


def _effective_policy() -> dict[str, Any]:
    from strategy_config import get_bear_hedge_target_pct, get_strategy_params

    cells: dict[str, Any] = {}
    for regime in ("BULL", "NEUTRAL", "BEAR"):
        for tier in ("NORMAL", "CAUTIOUS", "HALT"):
            key = f"{regime}/{tier}"
            cells[key] = {
                "params": get_strategy_params(regime, tier),
                "bear_hedge_target_pct": get_bear_hedge_target_pct(regime, tier),
            }
    return cells


def build_strategy_identity(
    *,
    project_root: Path = PROJECT_ROOT,
    source_paths: tuple[str, ...] = STRATEGY_SOURCE_PATHS,
    effective_policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Hash strategy sources and effective regime/risk configuration.

    A validation artifact is reusable only while this identity matches. Any
    change to signal, universe, risk, metrics, backtest, or live execution
    code invalidates the old promotion result and requires revalidation.
    """

    source_hashes: dict[str, str] = {}
    for relative_path in source_paths:
        path = project_root / relative_path
        if not path.is_file():
            raise FileNotFoundError(f"strategy identity source missing: {relative_path}")
        source_hashes[relative_path] = hashlib.sha256(path.read_bytes()).hexdigest()

    payload = {
        "schema_version": STRATEGY_IDENTITY_SCHEMA,
        "strategy_version": "v11-adaptive-momentum",
        "source_hashes": source_hashes,
        "effective_policy": effective_policy or _effective_policy(),
        "runtime_versions": _runtime_versions(),
    }
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return {
        "schema_version": STRATEGY_IDENTITY_SCHEMA,
        "algorithm": "sha256",
        "value": hashlib.sha256(canonical).hexdigest(),
        "sources": list(source_paths),
        "runtime_versions": payload["runtime_versions"],
    }


def hash_symbol_universe(symbols: Any) -> str:
    """Hash the exact normalized ranking universe independently of held exits."""

    normalized = sorted(
        {
            str(symbol).strip().upper()
            for symbol in symbols
            if str(symbol).strip()
        }
    )
    canonical = json.dumps(normalized, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


__all__ = [
    "STRATEGY_IDENTITY_SCHEMA",
    "STRATEGY_SOURCE_PATHS",
    "build_bar_snapshot_identity",
    "build_strategy_identity",
    "hash_symbol_universe",
]
