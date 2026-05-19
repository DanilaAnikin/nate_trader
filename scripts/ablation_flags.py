"""Ablation flags — runtime toggles to disable individual scoring modules.

Each module that contributes to the confidence score or trade-decision pipeline
checks the corresponding flag. Default OFF (i.e. module runs normally). Set
the env var to "1", "true", or "yes" to disable that module for the run.

Used by:
  • Live engine (execute_trades.py, research.py)
  • Backtest engine (backtest/engine.py, sweep.py)

Goal: enable per-module attribution by running 7 backtests, each with one
module ablated, to see which modules earn alpha vs. add noise.

Usage:
    ABLATE_ML=1 python3 scripts/backtest/run.py ...
    ABLATE_PEAD=1 ABLATE_SENTIMENT=1 python3 scripts/execute_trades.py dry-run
"""

from __future__ import annotations

import os


def _flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in {"1", "true", "yes", "on"}


ABLATE_ML = _flag("ABLATE_ML")
ABLATE_PEAD = _flag("ABLATE_PEAD")
ABLATE_MEAN_REV = _flag("ABLATE_MEAN_REV")
ABLATE_SENTIMENT = _flag("ABLATE_SENTIMENT")
ABLATE_MULTI_TF = _flag("ABLATE_MULTI_TF")
ABLATE_EARNINGS_FILTER = _flag("ABLATE_EARNINGS_FILTER")
ABLATE_SECTOR_ROT = _flag("ABLATE_SECTOR_ROT")


def active_ablations() -> list[str]:
    """Return the list of currently-active ablation names (for logging)."""
    return [
        name
        for name, on in [
            ("ML", ABLATE_ML),
            ("PEAD", ABLATE_PEAD),
            ("MEAN_REV", ABLATE_MEAN_REV),
            ("SENTIMENT", ABLATE_SENTIMENT),
            ("MULTI_TF", ABLATE_MULTI_TF),
            ("EARNINGS_FILTER", ABLATE_EARNINGS_FILTER),
            ("SECTOR_ROT", ABLATE_SECTOR_ROT),
        ]
        if on
    ]
