"""Shared, broker-free portfolio risk-tier policy for live and backtest use."""

from __future__ import annotations

from dataclasses import dataclass
import math
from collections.abc import Iterable


RISK_LOOKBACK_SESSIONS = 22
CAUTIOUS_ROLLING_DRAWDOWN_PCT = -10.0
CAUTIOUS_DAILY_RETURN_PCT = -5.0
HALT_DAILY_RETURN_PCT = -8.0
_THRESHOLD_EPSILON = 1e-9


@dataclass(frozen=True)
class RiskAssessment:
    tier: str
    current_equity: float
    rolling_peak_equity: float
    rolling_drawdown_pct: float
    daily_return_pct: float
    lookback_sessions: int


def _finite_positive(value: object, *, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be numeric") from exc
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{field} must be finite and positive")
    return number


def assess_portfolio_risk(
    current_equity: float,
    *,
    previous_equity: float | None,
    prior_equities: Iterable[float] = (),
    lookback_sessions: int = RISK_LOOKBACK_SESSIONS,
) -> RiskAssessment:
    """Classify risk from a rolling peak plus same-session loss breakers.

    ``prior_equities`` must contain only observations before the current
    snapshot. Invalid historical rows are ignored, while current/previous
    broker values fail closed via ``ValueError``. The rolling window prevents
    a drawdown from an ancient high-water mark from permanently suppressing
    exposure after the original loss episode has passed.
    """

    if type(lookback_sessions) is not int or lookback_sessions < 2:
        raise ValueError("lookback_sessions must be an integer >= 2")
    current = _finite_positive(current_equity, field="current_equity")
    if previous_equity is None:
        previous = current
    else:
        previous = _finite_positive(previous_equity, field="previous_equity")

    valid_prior: list[float] = []
    for raw in prior_equities:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if math.isfinite(value) and value > 0:
            valid_prior.append(value)
    window = [*valid_prior[-(lookback_sessions - 1) :], current]
    rolling_peak = max(window)
    rolling_drawdown = (current / rolling_peak - 1.0) * 100.0
    daily_return = (current / previous - 1.0) * 100.0

    if daily_return <= HALT_DAILY_RETURN_PCT + _THRESHOLD_EPSILON:
        tier = "HALT"
    elif (
        rolling_drawdown
        <= CAUTIOUS_ROLLING_DRAWDOWN_PCT + _THRESHOLD_EPSILON
        or daily_return <= CAUTIOUS_DAILY_RETURN_PCT + _THRESHOLD_EPSILON
    ):
        tier = "CAUTIOUS"
    else:
        tier = "NORMAL"

    return RiskAssessment(
        tier=tier,
        current_equity=current,
        rolling_peak_equity=rolling_peak,
        rolling_drawdown_pct=rolling_drawdown,
        daily_return_pct=daily_return,
        lookback_sessions=lookback_sessions,
    )


__all__ = [
    "CAUTIOUS_DAILY_RETURN_PCT",
    "CAUTIOUS_ROLLING_DRAWDOWN_PCT",
    "HALT_DAILY_RETURN_PCT",
    "RISK_LOOKBACK_SESSIONS",
    "RiskAssessment",
    "assess_portfolio_risk",
]
