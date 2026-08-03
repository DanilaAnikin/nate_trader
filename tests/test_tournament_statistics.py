from __future__ import annotations

import math

import numpy as np
import pytest

from backtest.tournament_statistics import (
    bootstrap_path_max_drawdown,
    deflated_sharpe_ratio,
    fold_stability,
    paired_stationary_bootstrap,
    probabilistic_sharpe_ratio,
    white_reality_check,
)


def test_paired_stationary_bootstrap_is_deterministic_and_preserves_pairing():
    incumbent = np.asarray([0.01, -0.02, 0.005, 0.003, -0.004, 0.002])
    candidate = incumbent + 0.001

    first = paired_stationary_bootstrap(
        candidate,
        incumbent,
        n_bootstrap=200,
        mean_block_length=3,
        seed=17,
    )
    second = paired_stationary_bootstrap(
        candidate,
        incumbent,
        n_bootstrap=200,
        mean_block_length=3,
        seed=17,
    )

    assert first == second
    assert first["point_estimate_annualized_pct"] == pytest.approx(25.2)
    assert first["annualized_mean_active_difference_pct"] == pytest.approx(
        {"q05": 25.2, "q50": 25.2, "q95": 25.2}
    )
    assert first["probability_gt_zero"] == 1.0
    assert first["restart_probability"] == pytest.approx(1 / 3)


def test_paired_stationary_bootstrap_changes_with_seed_on_variable_data():
    incumbent = np.zeros(12)
    candidate = np.asarray(
        [0.03, -0.02, 0.01, -0.01, 0.02, -0.03] * 2,
        dtype=float,
    )

    first = paired_stationary_bootstrap(
        candidate,
        incumbent,
        n_bootstrap=80,
        mean_block_length=2,
        seed=1,
    )
    second = paired_stationary_bootstrap(
        candidate,
        incumbent,
        n_bootstrap=80,
        mean_block_length=2,
        seed=2,
    )

    assert (
        first["annualized_mean_active_difference_pct"]
        != second["annualized_mean_active_difference_pct"]
    )


def test_bootstrap_path_max_drawdown_reports_adverse_q95_as_positive_loss():
    daily_return = -0.01
    n_observations = 8
    result = bootstrap_path_max_drawdown(
        [daily_return] * n_observations,
        n_bootstrap=50,
        mean_block_length=4,
        seed=9,
    )
    expected_loss_pct = (1.0 - (1.0 + daily_return) ** n_observations) * 100.0

    assert result["observed_max_drawdown_loss_pct"] == pytest.approx(
        expected_loss_pct
    )
    assert result["q95_max_drawdown_loss_pct"] == pytest.approx(expected_loss_pct)
    assert result["bootstrap_max_drawdown_loss_pct"] == pytest.approx(
        {
            "q05": expected_loss_pct,
            "q50": expected_loss_pct,
            "q95": expected_loss_pct,
        }
    )
    assert result["output_unit"] == "positive_loss_pct"
    assert result["comparison"] == "standalone_strategy_path_risk"


def test_white_reality_check_centers_active_returns_and_freezes_sorted_names():
    incumbent = np.asarray([0.01, -0.01, 0.003, -0.002, 0.005, -0.004])
    candidates = {
        "z_weaker": incumbent + 0.0002,
        "a_stronger": incumbent + 0.001,
    }
    result = white_reality_check(
        candidates,
        incumbent,
        n_bootstrap=99,
        mean_block_length=2,
        seed=3,
    )

    assert result["frozen_candidate_order"] == ["a_stronger", "z_weaker"]
    assert result["best_candidate"] == "a_stronger"
    assert result["observed_max_statistic_pct"] == pytest.approx(25.2)
    assert result["centered_null_max_statistic_pct"] == pytest.approx(
        {"q05": 0.0, "q50": 0.0, "q95": 0.0},
        abs=1e-12,
    )
    # Plus-one finite-bootstrap correction means the p-value is never zero.
    assert result["p_value"] == pytest.approx(0.01)


def test_white_reality_check_identical_candidate_does_not_reject_null():
    incumbent = np.asarray([0.01, -0.01, 0.003, -0.002])
    result = white_reality_check(
        {"same": incumbent.copy()},
        incumbent,
        n_bootstrap=49,
        mean_block_length=2,
        seed=5,
    )

    assert result["observed_max_statistic_pct"] == 0.0
    assert result["p_value"] == 1.0


def test_probabilistic_sharpe_is_half_at_estimated_sharpe_benchmark():
    returns = [0.01, -0.004, 0.007, -0.002, 0.006, 0.001, -0.003, 0.008]
    baseline = probabilistic_sharpe_ratio(returns)
    estimated = baseline["inputs"]["estimated_sharpe_annualized"]
    at_estimate = probabilistic_sharpe_ratio(
        returns,
        benchmark_sharpe_annualized=estimated,
    )

    assert baseline["probability_sharpe_gt_benchmark"] > 0.5
    assert at_estimate["probability_sharpe_gt_benchmark"] == pytest.approx(0.5)
    assert at_estimate["z_score"] == pytest.approx(0.0)
    assert at_estimate["inputs"]["sample_raw_kurtosis"] > 0.0
    assert at_estimate["input_return_definition"].endswith("portfolio - BIL")
    assert "Phi(" in at_estimate["formula"]


def test_positive_autocorrelation_reduces_effective_sample_and_confidence():
    excess_returns = [0.0025] * 60 + [-0.0015] * 60
    iid_assumption = probabilistic_sharpe_ratio(
        excess_returns,
        autocorrelation_lags=0,
    )
    adjusted = probabilistic_sharpe_ratio(
        excess_returns,
        autocorrelation_lags=21,
    )

    assert adjusted["inputs"]["autocorrelation_variance_inflation_factor"] > 1
    assert adjusted["inputs"]["raw_observation_count"] == len(excess_returns)
    assert adjusted["inputs"]["effective_observation_count"] < len(excess_returns)
    assert adjusted["inputs"]["effective_observation_count"] >= 3
    assert adjusted["probability_sharpe_gt_benchmark"] < iid_assumption[
        "probability_sharpe_gt_benchmark"
    ]
    assert "Bartlett" not in adjusted["formula"]  # Kept in the ESS formula.
    assert "rho_k" in adjusted["inputs"]["effective_sample_size_formula"]


def test_deflated_sharpe_exposes_legacy_trial_floor_and_is_more_conservative():
    returns = [0.01, -0.004, 0.007, -0.002, 0.006, 0.001, -0.003, 0.008]
    plain = probabilistic_sharpe_ratio(returns)
    deflated = deflated_sharpe_ratio(
        returns,
        trial_sharpes_annualized=[-0.5, 0.0, 0.5, 1.0],
        legacy_trial_floor=15,
    )

    inputs = deflated["inputs"]
    assert inputs["observed_trial_count"] == 4
    assert inputs["legacy_trial_floor"] == 15
    assert inputs["effective_trial_count"] == 15
    assert inputs["expected_maximum_sharpe_annualized"] > 0.0
    assert deflated["probability_sharpe_gt_expected_maximum"] < plain[
        "probability_sharpe_gt_benchmark"
    ]
    assert math.isfinite(deflated["z_score"])
    assert "independent" in deflated["assumption"]


def test_deflated_sharpe_zero_dispersion_legacy_trials_require_explicit_floor():
    excess_returns = [0.01, -0.004, 0.007, -0.002, 0.006, 0.001]
    with pytest.raises(ValueError, match="trial_sharpe_std_floor"):
        deflated_sharpe_ratio(
            excess_returns,
            trial_sharpes_annualized=[0.5, 0.5, 0.5],
            legacy_trial_floor=15,
        )

    result = deflated_sharpe_ratio(
        excess_returns,
        trial_sharpes_annualized=[0.5, 0.5, 0.5],
        legacy_trial_floor=15,
        trial_sharpe_std_floor=0.25,
    )

    assert result["inputs"]["trial_sharpe_sample_std_annualized"] == 0.0
    assert result["inputs"]["trial_sharpe_std_floor_annualized"] == 0.25
    assert result["inputs"]["effective_trial_sharpe_std_annualized"] == 0.25
    assert result["inputs"]["expected_maximum_sharpe_annualized"] > 0.0


def test_fold_stability_uses_inclusive_non_overlapping_ranges():
    dates = [
        "2025-01-02",
        "2025-01-03",
        "2025-01-06",
        "2025-01-07",
        "2025-01-08",
        "2025-01-09",
        "2025-01-10",  # deliberately outside all folds
    ]
    incumbent = np.zeros(len(dates))
    candidate = np.asarray([0.001, 0.001, -0.002, -0.002, 0.003, 0.001, 0.5])
    folds = [
        {"name": "late", "start": "2025-01-08", "end": "2025-01-09"},
        {"name": "early", "start": "2025-01-02", "end": "2025-01-03"},
        {"name": "middle", "start": "2025-01-06", "end": "2025-01-07"},
    ]

    result = fold_stability(dates, candidate, incumbent, folds)

    assert [fold["name"] for fold in result["folds"]] == [
        "early",
        "middle",
        "late",
    ]
    assert result["positive_fold_count"] == 2
    assert result["positive_fold_fraction"] == pytest.approx(2 / 3)
    assert result["all_folds_positive"] is False
    assert result["worst_fold"] == "middle"
    assert result["worst_fold_active_mean_annualized_pct"] == pytest.approx(-50.4)
    assert result["best_fold"] == "late"
    assert result["best_fold_active_mean_annualized_pct"] == pytest.approx(50.4)
    assert result["unassigned_observations"] == 1


@pytest.mark.parametrize(
    ("candidate", "incumbent", "kwargs", "message"),
    [
        ([0.01, 0.02, 0.03], [0.01, 0.02, 0.03, 0.04], {}, "identical shapes"),
        ([0.01, float("nan"), 0.03], [0.01, 0.02, 0.03], {}, "finite"),
        (
            [0.01, 0.02, 0.03],
            [0.01, 0.02, 0.03],
            {"n_bootstrap": 0},
            "positive integer",
        ),
        (
            [0.01, 0.02, 0.03],
            [0.01, 0.02, 0.03],
            {"mean_block_length": 0.5},
            "at least 1",
        ),
        ([0.01, 0.02, 0.03], [0.01, 0.02, 0.03], {"seed": 1.5}, "integer"),
        ([-1.0, 0.02, 0.03], [0.01, 0.02, 0.03], {}, "<= -100%"),
    ],
)
def test_paired_bootstrap_fails_closed(candidate, incumbent, kwargs, message):
    options = dict(kwargs)
    with pytest.raises(ValueError, match=message):
        paired_stationary_bootstrap(
            candidate,
            incumbent,
            n_bootstrap=options.pop("n_bootstrap", 10),
            **options,
        )


def test_paired_bootstrap_and_reality_check_require_three_observations():
    with pytest.raises(ValueError, match="at least 3"):
        paired_stationary_bootstrap([0.01, 0.02], [0.0, 0.0], n_bootstrap=10)
    with pytest.raises(ValueError, match="at least 3"):
        white_reality_check(
            {"candidate": [0.01, 0.02]},
            [0.0, 0.0],
            n_bootstrap=10,
        )


def test_white_reality_check_rejects_empty_or_misaligned_candidate_family():
    with pytest.raises(ValueError, match="non-empty mapping"):
        white_reality_check({}, [0.0, 0.0, 0.0], n_bootstrap=10)
    with pytest.raises(ValueError, match="identical shapes"):
        white_reality_check(
            {"short": [0.0, 0.0, 0.0]},
            [0.0, 0.0, 0.0, 0.0],
            n_bootstrap=10,
        )
    with pytest.raises(ValueError, match="non-empty strings"):
        white_reality_check({" ": [0.0, 0.0, 0.0]}, [0.0, 0.0, 0.0], n_bootstrap=10)


def test_bootstrap_arithmetic_and_compounding_overflow_fail_closed():
    huge = [1e308, 1e308, 1e308]
    with pytest.raises(ValueError, match="overflow"):
        paired_stationary_bootstrap(huge, [0.0, 0.0, 0.0], n_bootstrap=1)
    with pytest.raises(ValueError, match="overflow"):
        bootstrap_path_max_drawdown(huge, n_bootstrap=1)
    with pytest.raises(ValueError, match="overflow"):
        white_reality_check({"huge": huge}, [0.0, 0.0, 0.0], n_bootstrap=1)
    with pytest.raises(ValueError, match="overflow"):
        fold_stability(
            ["2025-01-02", "2025-01-03", "2025-01-06"],
            huge,
            [0.0, 0.0, 0.0],
            [{"name": "all", "start": "2025-01-02", "end": "2025-01-06"}],
        )


def test_sharpe_helpers_fail_closed_on_bad_inputs():
    with pytest.raises(ValueError, match="at least 3"):
        probabilistic_sharpe_ratio([0.01, 0.02])
    with pytest.raises(ValueError, match="non-zero sample"):
        probabilistic_sharpe_ratio([0.01, 0.01, 0.01])
    with pytest.raises(ValueError, match="finite"):
        probabilistic_sharpe_ratio(
            [0.01, -0.01, 0.02],
            benchmark_sharpe_annualized=float("inf"),
        )
    with pytest.raises(ValueError, match="at least 2"):
        deflated_sharpe_ratio(
            [0.01, -0.01, 0.02],
            trial_sharpes_annualized=[0.5],
            legacy_trial_floor=15,
        )
    with pytest.raises(ValueError, match="positive integer"):
        deflated_sharpe_ratio(
            [0.01, -0.01, 0.02],
            trial_sharpes_annualized=[0.0, 0.5],
            legacy_trial_floor=0,
        )


@pytest.mark.parametrize(
    ("dates", "candidate", "incumbent", "folds", "message"),
    [
        (
            ["2025-01-03", "2025-01-02"],
            [0.0, 0.0],
            [0.0, 0.0],
            [{"name": "one", "start": "2025-01-02", "end": "2025-01-03"}],
            "strictly increasing",
        ),
        (
            ["2025-01-02", "2025-01-03"],
            [0.0],
            [0.0, 0.0],
            [{"name": "one", "start": "2025-01-02", "end": "2025-01-03"}],
            "identical lengths",
        ),
        (
            ["2025-01-02", "2025-01-03", "2025-01-06"],
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            [
                {"name": "one", "start": "2025-01-02", "end": "2025-01-03"},
                {"name": "two", "start": "2025-01-03", "end": "2025-01-06"},
            ],
            "overlap",
        ),
        (
            ["2025-01-02", "2025-01-03"],
            [0.0, 0.0],
            [0.0, 0.0],
            [{"name": "empty", "start": "2026-01-01", "end": "2026-02-01"}],
            "contains 0 observations",
        ),
    ],
)
def test_fold_stability_fails_closed(dates, candidate, incumbent, folds, message):
    with pytest.raises(ValueError, match=message):
        fold_stability(dates, candidate, incumbent, folds)
