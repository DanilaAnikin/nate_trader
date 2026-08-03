from __future__ import annotations

import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from backtest.strategy_candidates import PointInTimeFactorCache
from backtest.run_strategy_tournament import (
    DEVELOPMENT_FOLDS,
    EXPECTED_CANDIDATES,
    INCUMBENT_NAME,
    REUSED_FOLDS,
    CandidateStrategyAdapter,
    BOOTSTRAP_SEED,
    TournamentBarProvider,
    _assert_frozen_contract,
    _asset_open_returns,
    _capacity_summary,
    _gate_decisions,
    _return_metrics,
    _statistical_evidence,
    render_markdown,
)


class _OpenProvider:
    def __init__(self, bars):
        self.bars = bars

    def bar_at(self, symbol, date):
        return self.bars.get((symbol, date))


def test_current_protocol_and_candidate_manifest_match_frozen_contract():
    _assert_frozen_contract()


def test_benchmark_returns_fail_closed_on_missing_or_invalid_open():
    dates = ["2024-01-02", "2024-01-03"]
    missing = _OpenProvider({("SPY", dates[0]): {"open": 100.0}})
    with pytest.raises(ValueError, match="no benchmark bar"):
        _asset_open_returns(missing, "SPY", dates)

    invalid = _OpenProvider(
        {
            ("SPY", dates[0]): {"open": 100.0},
            ("SPY", dates[1]): {"open": 0.0},
        }
    )
    with pytest.raises(ValueError, match="invalid benchmark open"):
        _asset_open_returns(invalid, "SPY", dates)


def test_benchmark_returns_are_aligned_open_to_open():
    dates = ["2024-01-02", "2024-01-03", "2024-01-04"]
    provider = _OpenProvider(
        {
            ("SPY", dates[0]): {"open": 100.0},
            ("SPY", dates[1]): {"open": 110.0},
            ("SPY", dates[2]): {"open": 99.0},
        }
    )
    assert _asset_open_returns(provider, "SPY", dates) == pytest.approx(
        [0.0, 0.10, -0.10]
    )


def test_metric_inputs_reject_impossible_daily_returns():
    valid = np.asarray([0.0, 0.01, -0.01])
    impossible = np.asarray([0.0, -1.0, 0.01])
    with pytest.raises(ValueError, match="impossible return"):
        _return_metrics(impossible, valid, valid, valid)


def test_tournament_provider_physically_caps_cached_frame(tmp_path):
    bars = {
        "bars": [
            {
                "date": "2026-07-09",
                "open": 100,
                "high": 101,
                "low": 99,
                "close": 100,
                "volume": 1_000,
            },
            {
                "date": "2026-07-13",
                "open": 200,
                "high": 201,
                "low": 199,
                "close": 200,
                "volume": 2_000,
            },
        ]
    }
    (tmp_path / "SPY.json").write_text(json.dumps(bars), encoding="utf-8")
    provider = TournamentBarProvider(cutoff="2026-07-10")
    provider.bars_dir = tmp_path

    frame = provider.load("SPY")
    assert frame is not None
    assert list(frame.index) == ["2026-07-09"]
    assert provider.bar_at("SPY", "2026-07-13") is None


class _CapacityProvider:
    def __init__(self, count: int):
        self.count = count

    def bars_up_to(self, symbol, date, lookback_days=None):
        return pd.DataFrame(
            {
                "close": np.full(self.count, 100.0),
                "volume": np.full(self.count, 1_000_000.0),
            }
        )


def test_capacity_requires_the_frozen_full_60_session_window():
    result = {
        "orders": [
            {
                "symbol": "AAA",
                "signal_date": "2024-01-31",
                "fill_date": "2024-02-01",
                "qty": 900,
                "open_price": 100.0,
                "notional": 89_550.0,
            }
        ]
    }
    incomplete = _capacity_summary(result, _CapacityProvider(59))
    complete = _capacity_summary(result, _CapacityProvider(60))

    assert incomplete["orders_without_capacity_measure"] == 1
    assert incomplete["observed_order_count"] == 0
    assert complete["orders_without_capacity_measure"] == 0
    assert complete["maximum_participation_pct"] == pytest.approx(0.09)


def _adapter(name: str) -> CandidateStrategyAdapter:
    return CandidateStrategyAdapter(
        name=name,
        stock_universe=("AAA",),
        sectors={"AAA": "Technology"},
        factor_cache=PointInTimeFactorCache(),
    )


def _context(as_of: str, today: str, *, session_index: int = 1):
    return SimpleNamespace(
        as_of=as_of,
        today=today,
        session_index=session_index,
    )


def test_candidate_adapter_uses_frozen_monthly_quarterly_and_weekly_clocks():
    assert _adapter("risk_adjusted_momentum").should_rebalance(
        _context("2024-01-31", "2024-02-01")
    )
    assert not _adapter("risk_adjusted_momentum").should_rebalance(
        _context("2024-02-01", "2024-02-02")
    )
    assert _adapter("low_vol_trend").should_rebalance(
        _context("2024-03-28", "2024-04-01")
    )
    assert not _adapter("low_vol_trend").should_rebalance(
        _context("2024-04-30", "2024-05-01")
    )
    assert _adapter("short_term_reversal_negative_control").should_rebalance(
        _context("2024-01-05", "2024-01-08")
    )


def test_sector_etf_adapter_does_not_bypass_common_spy_gate(monkeypatch):
    monkeypatch.setattr(
        "backtest.run_strategy_tournament.adaptive_momentum.compute_market_state",
        lambda *args, **kwargs: None,
    )
    context = SimpleNamespace(
        risk_tier="NORMAL",
        provider=object(),
        as_of="2024-01-31",
    )

    assert _adapter("sector_etf_momentum")._market_risk_off(context)


def test_adapter_reuses_only_an_identical_pure_target_request(monkeypatch):
    calls = []

    def fake_build(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(weights={"AAA": 0.5})

    monkeypatch.setattr(
        "backtest.run_strategy_tournament.build_target_portfolio",
        fake_build,
    )
    adapter = _adapter("risk_adjusted_momentum")
    context = SimpleNamespace(
        provider=SimpleNamespace(cache_identity=123),
        as_of="2024-01-31",
        incumbent_symbols=frozenset({"AAA"}),
        risk_tier="NORMAL",
    )

    first = adapter.build_target(context)
    second = adapter.build_target(context)

    assert first == second == {"AAA": 0.5}
    assert first is not second
    assert len(calls) == 1


@pytest.mark.parametrize(
    "name",
    (
        "risk_adjusted_momentum",
        "low_vol_trend",
        "short_term_reversal_negative_control",
    ),
)
def test_every_cadence_initializes_on_first_evaluated_session(name):
    assert _adapter(name).should_rebalance(
        _context("2022-01-03", "2022-01-04", session_index=0)
    )


def test_reality_check_vs_spy_contains_the_incumbent_family(monkeypatch):
    dates = [
        "2022-01-04",
        "2022-01-05",
        "2022-01-06",
        "2022-01-07",
        "2025-01-02",
        "2025-01-03",
        "2025-01-06",
    ]
    paths = {
        name: np.asarray([0.001, -0.001, 0.002, 0.0, 0.001, 0.0, -0.001])
        + index * 1e-6
        for index, name in enumerate(EXPECTED_CANDIDATES)
    }
    spy = np.zeros(len(dates))
    bil = np.zeros(len(dates))
    reality_families: list[tuple[str, ...]] = []
    observed_bootstrap_seeds: list[int] = []

    def fake_paired(*args, **kwargs):
        observed_bootstrap_seeds.append(kwargs["seed"])
        return {"paired": True}

    def fake_drawdown(*args, **kwargs):
        observed_bootstrap_seeds.append(kwargs["seed"])
        return {"drawdown": True}

    monkeypatch.setattr(
        "backtest.run_strategy_tournament.paired_stationary_bootstrap",
        fake_paired,
    )
    monkeypatch.setattr(
        "backtest.run_strategy_tournament.bootstrap_path_max_drawdown",
        fake_drawdown,
    )
    monkeypatch.setattr(
        "backtest.run_strategy_tournament.deflated_sharpe_ratio",
        lambda *args, **kwargs: {"dsr": True},
    )
    monkeypatch.setattr(
        "backtest.run_strategy_tournament.fold_stability",
        lambda *args, **kwargs: {"folds": True},
    )

    def fake_reality(candidate_returns, incumbent_returns, **kwargs):
        reality_families.append(tuple(candidate_returns))
        observed_bootstrap_seeds.append(kwargs["seed"])
        return {"best_candidate": next(iter(candidate_returns)), "p_value": 1.0}

    monkeypatch.setattr(
        "backtest.run_strategy_tournament.white_reality_check",
        fake_reality,
    )

    _statistical_evidence(
        dates=dates,
        returns=paths,
        spy=spy,
        bil=bil,
        summaries={name: {} for name in EXPECTED_CANDIDATES},
        n_bootstrap=10,
    )

    assert len(reality_families) == 6
    for vs_spy, vs_incumbent in zip(
        reality_families[::2], reality_families[1::2]
    ):
        assert set(vs_spy) == set(EXPECTED_CANDIDATES)
        assert INCUMBENT_NAME in vs_spy
        assert set(vs_incumbent) == set(EXPECTED_CANDIDATES) - {INCUMBENT_NAME}
    assert set(observed_bootstrap_seeds) == {BOOTSTRAP_SEED}


def _capacity(*, violations: int = 0, missing: int = 0):
    return {
        "violation_count": violations,
        "orders_without_capacity_measure": missing,
    }


def _candidate_summary(*, annual_return: float = 10.0):
    period = {
        "annual_return_pct": annual_return,
        "excess_cagr_pct": 2.0,
        "jensen_alpha_annual_pct": 2.0,
        "max_drawdown_pct": -5.0,
    }
    folds = {
        fold["name"]: {"excess_cagr_pct": 1.0, "max_drawdown_pct": -5.0}
        for fold in (*DEVELOPMENT_FOLDS, *REUSED_FOLDS)
    }
    return {
        "development": dict(period),
        "reused_temporal": dict(period),
        "development_folds": {
            fold["name"]: dict(folds[fold["name"]]) for fold in DEVELOPMENT_FOLDS
        },
        "reused_folds": {
            fold["name"]: dict(folds[fold["name"]]) for fold in REUSED_FOLDS
        },
        "execution": {"capacity": _capacity()},
    }


def _gate_fixture(*, best_spy: str, best_incumbent: str):
    cost_summaries = {
        label: {name: _candidate_summary() for name in EXPECTED_CANDIDATES}
        for label in ("7", "15", "25", "50")
    }
    target = "risk_adjusted_momentum"
    cost_summaries["15"][target]["development"]["annual_return_pct"] = 99.0
    delay = {name: _candidate_summary() for name in EXPECTED_CANDIDATES}
    paired = {
        "annualized_mean_active_difference_pct": {"q05": 3.0},
        "probability_gt_zero": 0.99,
    }
    evidence = {}
    for name in EXPECTED_CANDIDATES:
        evidence[name] = {
            "vs_spy_development": dict(paired),
            "vs_spy_reused_temporal": dict(paired),
            "vs_incumbent_development": None if name == INCUMBENT_NAME else dict(paired),
            "vs_incumbent_reused_temporal": None if name == INCUMBENT_NAME else dict(paired),
            "development_drawdown_bootstrap": {
                "q95_max_drawdown_loss_pct": 10.0
            },
            "deflated_sharpe": {
                "probability_sharpe_gt_expected_maximum": 0.99
            },
        }
    evidence[INCUMBENT_NAME]["vs_spy_development"] = {
        "annualized_mean_active_difference_pct": {"q05": 1.0},
        "probability_gt_zero": 0.99,
    }
    statistics = {
        "candidates": evidence,
        "white_reality_checks": {
            "21": {
                "vs_spy": {"p_value": 0.01, "best_candidate": best_spy},
                "vs_incumbent": {
                    "p_value": 0.01,
                    "best_candidate": best_incumbent,
                },
            }
        },
    }
    return target, cost_summaries, delay, statistics


def test_gate_cannot_assign_family_p_value_to_non_best_candidate():
    target, costs, delay, statistics = _gate_fixture(
        best_spy=INCUMBENT_NAME,
        best_incumbent="risk_adjusted_momentum",
    )
    result = _gate_decisions(
        cost_summaries=costs,
        delay_summaries_25=delay,
        reversal_summary_30=_candidate_summary(),
        statistics=statistics,
    )

    decision = result["candidate_gate_decisions"][target]
    assert not decision["eligible_challenger"]
    assert "candidate is not the family-best result vs SPY" in decision["reasons"]
    assert result["descriptive_leaders"]["maximum_return"] == target


def test_gate_checks_capacity_across_every_required_cost_run():
    target, costs, delay, statistics = _gate_fixture(
        best_spy="risk_adjusted_momentum",
        best_incumbent="risk_adjusted_momentum",
    )
    costs["7"][target]["execution"]["capacity"] = _capacity(violations=1)
    result = _gate_decisions(
        cost_summaries=costs,
        delay_summaries_25=delay,
        reversal_summary_30=_candidate_summary(),
        statistics=statistics,
    )

    reasons = result["candidate_gate_decisions"][target]["reasons"]
    assert "7 bps D+1: one or more orders exceed the 1% ADV cap" in reasons


def test_diagnostic_markdown_does_not_mislabel_unrun_gate_as_failure():
    report = {
        "status": "INCOMPLETE_DIAGNOSTIC",
        "selection": {"decision": "INCOMPLETE_DIAGNOSTIC"},
        "cost_results": {},
        "evaluated_candidates": ["risk_adjusted_momentum"],
    }
    rendered = render_markdown(report)
    assert "NOT EVALUATED" in rendered
    assert "| FAIL |" not in rendered
