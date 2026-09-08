"""The confirmed market gate must default to V11 and never fail open.

V11's gate fires on a single completed close below SPY's SMA200. That reacts to
every brush against the line — SPY crossed its SMA200 sixteen times in 2022, and
each crossing is a full liquidation and re-entry of the book. A confirmation
window suppresses that, but a gate is a safety device: the only acceptable way
to get it wrong is to be too defensive, never too slow to protect.

These tests pin three properties:
  1. at the default it is bit-for-bit V11;
  2. it never resolves an ambiguous or unreadable market to risk-ON;
  3. the delay is symmetric, so it cannot become slow-to-protect while staying
     quick-to-buy.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from adaptive_momentum import (
    AdaptiveMomentumConfig,
    compute_market_state,
    market_gate_state,
)

TREND = AdaptiveMomentumConfig().trend_days  # 200


class FakeProvider:
    """A SPY series with a controllable tail, on contiguous business days."""

    def __init__(self, closes: list[float]) -> None:
        idx = pd.bdate_range("2020-01-01", periods=len(closes))
        self.frame = pd.DataFrame(
            {"close": closes}, index=[str(d)[:10] for d in idx]
        )

    @property
    def last_date(self) -> str:
        return str(self.frame.index[-1])

    def bars_up_to(self, symbol, as_of, lookback_days=None):
        sub = self.frame.loc[:as_of]
        if lookback_days:
            sub = sub.tail(lookback_days)
        return sub


def _flat_then(tail: list[float], level: float = 100.0, n: int = TREND + 40):
    """A flat history at `level`, then an explicit tail of closes."""
    return FakeProvider([level] * (n - len(tail)) + tail)


def test_default_matches_v11_exactly_when_above():
    p = _flat_then([101.0] * 10)
    assert market_gate_state(p, p.last_date, confirmation_days=0) is False
    assert compute_market_state(p, p.last_date).above_sma200 is True


def test_default_matches_v11_exactly_when_below():
    p = _flat_then([99.0] * 10)
    assert market_gate_state(p, p.last_date, confirmation_days=0) is True
    assert compute_market_state(p, p.last_date).above_sma200 is False


def test_one_day_below_does_not_engage_a_five_day_gate():
    """The whole point: a single brush against the line must not trade."""
    p = _flat_then([101.0] * 9 + [99.0])
    assert market_gate_state(p, p.last_date, confirmation_days=5) is False
    # V11 as shipped would have gone fully to cash on exactly this tape.
    assert market_gate_state(p, p.last_date, confirmation_days=0) is True


def test_five_consecutive_days_below_do_engage():
    p = _flat_then([101.0] * 5 + [99.0] * 5)
    assert market_gate_state(p, p.last_date, confirmation_days=5) is True


def test_one_day_above_does_not_release_a_five_day_gate():
    """Symmetry: a single close back above must not buy the book back."""
    p = _flat_then([99.0] * 9 + [101.0])
    assert market_gate_state(p, p.last_date, confirmation_days=5) is True


def test_five_consecutive_days_above_do_release():
    p = _flat_then([99.0] * 5 + [101.0] * 5)
    assert market_gate_state(p, p.last_date, confirmation_days=5) is False


@pytest.mark.parametrize("days", [2, 3, 5, 10])
def test_an_alternating_tape_never_resolves_to_risk_on(days):
    """Straddling the line is ambiguous, and ambiguity must not buy.

    This is the 2022 tape in miniature. Whatever the confirmation window, a
    market flipping either side of its own average is not a confirmed uptrend.
    """
    tail = [101.0 if i % 2 else 99.0 for i in range(days * 2)]
    p = _flat_then(tail)
    state = market_gate_state(p, p.last_date, confirmation_days=days)
    if tail[-1] < 100.0:
        assert state is True
    else:
        # The last close is above, but the window is not unanimous: the safer
        # state is held rather than the newest observation being trusted.
        assert state is True


def test_insufficient_history_returns_none_not_false():
    """None means "unknown", and the caller must read it as risk-off.

    Returning False here would make a data outage look like a confirmed
    uptrend, which is the one failure mode a gate may never have.
    """
    p = FakeProvider([100.0] * 50)
    assert market_gate_state(p, p.last_date, confirmation_days=5) is None


def test_a_gap_in_the_signal_epoch_returns_none():
    closes = [100.0] * (TREND + 20)
    p = FakeProvider(closes)
    # Punch a two-week hole just before the end.
    idx = list(p.frame.index)
    keep = idx[: -12] + idx[-2:]
    p.frame = p.frame.loc[keep]
    assert market_gate_state(p, str(p.frame.index[-1]), confirmation_days=5) is None


def test_a_non_finite_close_returns_none():
    p = _flat_then([101.0] * 5 + [float("nan")] + [101.0] * 4)
    assert market_gate_state(p, p.last_date, confirmation_days=5) is None


def test_confirmation_days_below_one_is_treated_as_one():
    """Negative or zero must degrade to V11, never to "no gate"."""
    p = _flat_then([99.0] * 10)
    for days in (-5, 0, 1):
        assert market_gate_state(p, p.last_date, confirmation_days=days) is True


def test_the_gate_is_a_pure_function_of_history():
    """Two calls on the same tape agree, and order of evaluation is irrelevant.

    A latch carried between sessions would make the answer depend on when the
    simulation started and would not survive the live executor restarting
    mid-episode.
    """
    p = _flat_then([99.0] * 3 + [101.0] * 4)
    first = market_gate_state(p, p.last_date, confirmation_days=3)
    _ = market_gate_state(p, str(p.frame.index[-5]), confirmation_days=3)
    assert market_gate_state(p, p.last_date, confirmation_days=3) is first


def test_a_rising_market_stays_risk_on_through_the_window():
    closes = list(np.linspace(80.0, 130.0, TREND + 40))
    p = FakeProvider(closes)
    assert market_gate_state(p, p.last_date, confirmation_days=5) is False


def test_a_sustained_decline_engages_and_stays_engaged():
    """The 2008 shape: once it is a real decline, the gate holds."""
    closes = list(np.linspace(130.0, 70.0, TREND + 40))
    p = FakeProvider(closes)
    assert market_gate_state(p, p.last_date, confirmation_days=5) is True
    assert market_gate_state(p, p.last_date, confirmation_days=0) is True
