from __future__ import annotations

import json
from pathlib import Path

import pytest

from adaptive_momentum import (
    _risk_tier_scaler,
    config_from_params,
)
from risk_policy import (
    CAUTIOUS_DAILY_RETURN_PCT,
    CAUTIOUS_ROLLING_DRAWDOWN_PCT,
    HALT_DAILY_RETURN_PCT,
)
from strategy_config import get_strategy_params


REPO_ROOT = Path(__file__).resolve().parent.parent
POLICY_PATH = REPO_ROOT / "dashboard" / "lib" / "v11-policy.json"


def _dashboard_policy() -> dict:
    return json.loads(POLICY_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("regime", ["BULL", "NEUTRAL", "BEAR"])
@pytest.mark.parametrize("risk_tier", ["NORMAL", "CAUTIOUS", "HALT"])
def test_dashboard_v11_policy_matches_production_strategy_config(regime, risk_tier):
    policy = _dashboard_policy()
    params = get_strategy_params(regime, risk_tier)
    adaptive = config_from_params(params)

    assert policy["strategyVersion"] == params["strategy_version"]
    assert policy["schemaVersion"] == 1
    assert policy["topN"] == params["momentum_top_n"]
    assert policy["maxPositions"] == params["max_positions"]
    assert policy["minEligiblePositions"] == params["momentum_min_positions"]
    assert policy["maxPositionPct"] == params["max_position_pct"]
    assert policy["minCashPct"] == params["min_cash_pct"]
    assert policy["maxSectorPct"] == params["momentum_max_sector_pct"]
    assert policy["maxGrossExposurePct"] == adaptive.max_gross_exposure_pct
    assert policy["maxGrossExposurePct"] == 100.0 - params["min_cash_pct"]
    assert policy["weighting"] == params["momentum_weighting_scheme"]
    assert policy["breadthScalingEnabled"] is params["momentum_use_breadth_scaling"]
    assert policy["riskOnReentryDays"] == params["momentum_risk_on_reentry_days"]
    assert policy["productionExecutionMode"] == "paper-only"

    assert policy["signal"] == "12-1 momentum"
    assert adaptive.lookback_days == 252
    assert adaptive.skip_recent_days == 21

    assert policy["maxLegacyLeveragedEtfTargetPct"] == 0
    assert params["tqqq_pct"] == 0
    assert params["upro_pct"] == 0
    assert set(policy["disabledLegacyLeveragedEtfs"]) == {
        "TQQQ",
        "UPRO",
        "SSO",
    }
    assert set(policy["excludedSymbols"]) == adaptive.excluded_symbols
    assert policy["legacyOverlaysEnabled"] is False
    assert policy["legacyStopsEnabled"] is False
    assert params["base_pct"] == 0
    assert params["spy_base_pct"] == 0
    assert params["cash_sleeve_pct"] == 0
    assert params["sector_rotation_pct"] == 0
    assert params["pead_sleeve_pct"] == 0
    assert params["enable_mean_reversion"] is False
    assert params["enable_pead"] is False
    assert params["enable_options_hedge"] is False
    assert params["momentum_min_hold_days"] == 0
    assert params["trailing_stop_pct"] == 99
    assert params["tightened_stop_pct"] == 99
    assert params["scale_out_at_gain"] == 999
    assert params["final_target_gain"] == 999
    assert params["time_stop_days"] == 9999


def test_dashboard_v11_policy_matches_shared_risk_policy():
    policy = _dashboard_policy()

    assert policy["cautiousGrossMultiplier"] == pytest.approx(
        _risk_tier_scaler("CAUTIOUS")
    )
    assert policy["riskThresholds"] == {
        "dailyCautiousPct": CAUTIOUS_DAILY_RETURN_PCT,
        "dailyHaltPct": HALT_DAILY_RETURN_PCT,
        "rollingDrawdownCautiousPct": CAUTIOUS_ROLLING_DRAWDOWN_PCT,
    }
