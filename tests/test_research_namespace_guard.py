"""Guard the ``research`` import name against package shadowing.

``scripts/research.py`` is imported by ``scripts/backtest/engine.py`` and by
``execute_trades``, ``trade``, ``screener``, ``options_executor`` and
``run_gap_scanner``.  Creating ``scripts/research/__init__.py`` turns
``scripts/research/`` into a regular package, which takes precedence over the
sibling module and breaks every one of those imports with
``ImportError: cannot import name 'compute_confidence_score' from 'research'``.

This happened once already, while research tooling was being added under
``scripts/research/``.  A PEP 420 namespace directory (no ``__init__.py``) does
NOT shadow a sibling module, so research modules may live in that directory as
long as the file below never reappears.  They are loaded by path rather than
imported as ``research.<name>``.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def test_research_package_init_does_not_exist() -> None:
    offender = SCRIPTS_DIR / "research" / "__init__.py"
    assert not offender.exists(), (
        f"{offender} shadows {SCRIPTS_DIR / 'research.py'} and breaks the "
        "backtest engine plus five production scripts. scripts/research/ must "
        "remain a PEP 420 namespace directory; load modules inside it by path."
    )


def test_research_name_resolves_to_the_module_file() -> None:
    sys.modules.pop("research", None)
    module = importlib.import_module("research")
    assert Path(module.__file__).name == "research.py"
    assert hasattr(module, "compute_confidence_score")
    assert hasattr(module, "compute_technicals")


def test_backtest_engine_still_imports() -> None:
    engine = importlib.import_module("backtest.engine")
    assert callable(engine.run_backtest)


@pytest.mark.parametrize(
    "module_name",
    ["execute_trades", "trade", "screener"],
)
def test_production_importers_of_research_still_load(module_name: str) -> None:
    assert importlib.import_module(module_name) is not None
