"""The research knobs must be exactly inert at their defaults.

Two parameters were added to explore whether V11's structure — not its tuning —
is what costs it against SPY: a graduated floor below SPY's SMA200 instead of an
all-or-nothing exit to cash, and parking the un-invested residual in the
benchmark instead of holding it as cash.

Both default to off. That claim is the entire basis for treating the measured
V11 baseline as still describing V11, so it is proved here rather than asserted
in a comment. If either default ever drifts, the baseline every candidate is
compared against silently stops being the baseline.
"""

from __future__ import annotations

import pytest

from adaptive_momentum import (
    AdaptiveMomentumConfig,
    MarketState,
    UniverseScan,
    _target_gross_weight,
    config_from_params,
)
from backtest.engine import _residual_parking_mode
from strategy_config import get_strategy_params


def _scan(ranked_count: int = 10, breadth_pct: float | None = 70.0) -> UniverseScan:
    # `_target_gross_weight` reads only `len(ranked)` and `breadth_pct`; the
    # signals themselves never reach it, so placeholders keep the test about
    # the gross-exposure rule rather than about candidate construction.
    ranked = tuple(range(ranked_count))  # type: ignore[arg-type]
    return UniverseScan(
        signals=ranked,
        ranked=ranked,
        evaluated_count=ranked_count,
        liquid_count=ranked_count,
        breadth_pct=breadth_pct,
    )


def _market(*, above: bool) -> MarketState:
    return MarketState(
        as_of="2026-09-04",
        price=100.0 if above else 80.0,
        sma200=90.0,
        above_sma200=above,
        annual_volatility_pct=15.0,
    )


# ── the defaults themselves ─────────────────────────────────────────────────


def test_the_graduated_floor_defaults_to_off():
    assert AdaptiveMomentumConfig().below_sma200_floor_pct == 0.0


def test_the_live_v11_policy_does_not_set_the_floor():
    """The shipped policy must not carry the research knob at all."""
    params = get_strategy_params("BULL", "NORMAL")
    assert "momentum_below_sma200_floor_pct" not in params
    assert config_from_params(params).below_sma200_floor_pct == 0.0


def test_residual_parking_defaults_to_cash():
    assert _residual_parking_mode({}) == "cash"
    assert _residual_parking_mode(get_strategy_params("BULL", "NORMAL")) == "cash"


@pytest.mark.parametrize(
    "value", ["", "  ", "spy", "spy_alway", "yes", "true", "1", "benchmark"]
)
def test_an_unrecognised_parking_mode_falls_back_to_cash(value):
    """A typo must not silently start buying the benchmark."""
    assert _residual_parking_mode({"momentum_residual_parking": value}) == "cash"


@pytest.mark.parametrize("value", ["spy_always", "SPY_ALWAYS", "  spy_always  "])
def test_a_recognised_parking_mode_survives_case_and_whitespace(value):
    """Only exact-after-normalisation names count; these are exact."""
    assert _residual_parking_mode({"momentum_residual_parking": value}) == "spy_always"


# ── behaviour, not just the stored value ────────────────────────────────────


def test_below_sma200_still_targets_zero_gross_by_default():
    """The V11 rule: below the SMA200, the book goes to cash. Unchanged."""
    cfg = config_from_params(get_strategy_params("BULL", "NORMAL"))
    assert (
        _target_gross_weight(_market(above=False), _scan(), "NORMAL", cfg) == 0.0
    )


def test_above_sma200_is_untouched_by_the_floor_parameter():
    """The floor must not perturb the risk-on path even when it is set."""
    base = config_from_params(get_strategy_params("BULL", "NORMAL"))
    floored = config_from_params(
        {**get_strategy_params("BULL", "NORMAL"), "momentum_below_sma200_floor_pct": 50}
    )
    market, scan = _market(above=True), _scan()
    assert _target_gross_weight(market, scan, "NORMAL", base) == _target_gross_weight(
        market, scan, "NORMAL", floored
    )


def test_a_set_floor_changes_only_the_below_sma200_case():
    """The positive control: the knob does something when it is turned on."""
    floored = config_from_params(
        {**get_strategy_params("BULL", "NORMAL"), "momentum_below_sma200_floor_pct": 50}
    )
    gross = _target_gross_weight(_market(above=False), _scan(), "NORMAL", floored)
    assert 0.0 < gross <= 0.5


def test_halt_still_exits_regardless_of_the_floor():
    """HALT is not a de-risking tier, and no research knob may soften it."""
    floored = config_from_params(
        {**get_strategy_params("BULL", "NORMAL"), "momentum_below_sma200_floor_pct": 90}
    )
    assert _target_gross_weight(_market(above=False), _scan(), "HALT", floored) == 0.0
    assert _target_gross_weight(_market(above=True), _scan(), "HALT", floored) == 0.0


def test_missing_market_state_still_targets_zero():
    """No market data is not a reason to hold a floor of exposure."""
    floored = config_from_params(
        {**get_strategy_params("BULL", "NORMAL"), "momentum_below_sma200_floor_pct": 90}
    )
    assert _target_gross_weight(None, _scan(), "NORMAL", floored) == 0.0
