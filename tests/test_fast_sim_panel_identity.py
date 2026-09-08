"""A panel's symbol->column map must never outlive the panel.

`scanner_index` memoized on `id(panel)` in a module-level dict. CPython reissues
a freed object's address, so building a panel, dropping it, and building a
different one could hand the second panel the first one's column map — marking
every position to a different symbol's price and reporting the result as a
measured variant rather than an error.

Universe sweeps are precisely that access pattern: leave-one-out tests and
random-subset robustness checks build many panels with different symbol lists,
one after another. Those are also the measurements whose whole purpose is to be
trusted, so the failure is worst exactly where it is most likely.
"""

from __future__ import annotations

import gc

import numpy as np
import pytest

from research_tools import fast_sim


# The memo fields carry defaults and must NOT be filled by the helper: passing
# an array for `_sym_index` is what a naive "fill every field" loop does, and it
# would hand the test a pre-populated cache and hide the very bug under test.
_MEMO_FIELDS = {"windows", "_index", "_sym_index"}


def _panel(symbols: list[str]) -> fast_sim.Panel:
    """A skeleton panel; only `symbols` is read by the lookup under test."""
    n = len(symbols)
    empty = np.zeros((1, n))
    return fast_sim.Panel(
        dates=np.array(["2026-01-02"], dtype=object),
        symbols=np.array(symbols, dtype=object),
        **{
            name: empty
            for name in fast_sim.Panel.__dataclass_fields__
            if name not in {"dates", "symbols"} | _MEMO_FIELDS
        },
    )


def test_two_panels_do_not_share_a_column_map():
    a = _panel(["AAA", "BBB", "CCC"])
    b = _panel(["BBB", "CCC"])
    assert fast_sim.scanner_index(a, "CCC") == 2
    assert fast_sim.scanner_index(b, "CCC") == 1


def test_a_recycled_address_cannot_resurrect_a_stale_map():
    """The exact shape of the bug: build, drop, rebuild smaller."""
    first = _panel(["AAA", "BBB", "CCC", "DDD"])
    assert fast_sim.scanner_index(first, "DDD") == 3
    del first
    gc.collect()

    second = _panel(["AAA", "BBB"])
    # Under the old cache this could return 2 or 3 from the freed panel's map.
    assert fast_sim.scanner_index(second, "BBB") == 1
    with pytest.raises(KeyError):
        fast_sim.scanner_index(second, "DDD")


def test_the_cache_lives_on_the_panel_not_in_a_module_global():
    p = _panel(["AAA", "BBB"])
    assert getattr(p, "_sym_index", None) is None
    fast_sim.scanner_index(p, "AAA")
    assert getattr(p, "_sym_index", None) == {"AAA": 0, "BBB": 1}
