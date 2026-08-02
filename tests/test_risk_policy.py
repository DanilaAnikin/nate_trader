from __future__ import annotations

import pytest

from risk_policy import RISK_LOOKBACK_SESSIONS, assess_portfolio_risk


def test_ancient_high_water_rolls_out_of_monthly_window():
    assessment = assess_portfolio_risk(
        100.0,
        previous_equity=100.0,
        prior_equities=[200.0, *([100.0] * (RISK_LOOKBACK_SESSIONS - 1))],
    )

    assert assessment.tier == "NORMAL"
    assert assessment.rolling_peak_equity == 100.0
    assert assessment.rolling_drawdown_pct == 0.0


def test_recent_ten_percent_drawdown_is_cautious():
    assessment = assess_portfolio_risk(
        90.0,
        previous_equity=91.0,
        prior_equities=[100.0, *([91.0] * 10)],
    )

    assert assessment.tier == "CAUTIOUS"
    assert assessment.rolling_drawdown_pct == pytest.approx(-10.0)


def test_daily_breakers_override_rolling_drawdown():
    cautious = assess_portfolio_risk(
        94.0,
        previous_equity=100.0,
        prior_equities=[100.0],
    )
    halt = assess_portfolio_risk(
        91.0,
        previous_equity=100.0,
        prior_equities=[100.0],
    )

    assert cautious.tier == "CAUTIOUS"
    assert halt.tier == "HALT"


@pytest.mark.parametrize("value", [0.0, -1.0, float("nan"), float("inf")])
def test_current_equity_fails_closed_when_invalid(value):
    with pytest.raises(ValueError, match="finite and positive"):
        assess_portfolio_risk(value, previous_equity=100.0)
