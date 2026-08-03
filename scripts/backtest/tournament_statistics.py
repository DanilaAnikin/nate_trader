"""Statistical safeguards for a frozen backtest strategy tournament.

The helpers in this module operate on *aligned decimal daily returns* (for
example, ``0.01`` means +1%).  They intentionally do not align, forward-fill,
or discard observations: shape mismatches and non-finite inputs fail closed so
that a candidate cannot accidentally be compared on a more favourable clock.

Only NumPy and the Python standard library are used.  Bootstrap outputs use
percentage points for annualized returns and drawdowns, while Sharpe ratios and
probabilities are dimensionless.  Inputs to the Sharpe helpers are explicitly
*daily excess returns* (the tournament orchestrator subtracts aligned BIL daily
returns before calling them), not raw portfolio returns.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import date
from numbers import Integral, Real
from statistics import NormalDist
from typing import Any

import numpy as np


DEFAULT_BOOTSTRAP_REPLICATIONS = 10_000
DEFAULT_MEAN_BLOCK_LENGTH = 20.0
DEFAULT_TRADING_DAYS_PER_YEAR = 252.0
DEFAULT_AUTOCORRELATION_LAGS = 21
_EULER_MASCHERONI = 0.5772156649015329


def _finite_vector(
    values: Sequence[float] | np.ndarray,
    *,
    name: str,
    minimum_size: int = 1,
    valid_returns: bool = True,
) -> np.ndarray:
    """Return a defensive float copy after strict one-dimensional validation."""

    try:
        array = np.asarray(values, dtype=float)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must contain numeric values") from exc
    if array.ndim != 1:
        raise ValueError(f"{name} must be one-dimensional")
    if array.size < minimum_size:
        raise ValueError(
            f"{name} must contain at least {minimum_size} observations"
        )
    if not np.all(np.isfinite(array)):
        raise ValueError(f"{name} must contain only finite values")
    if valid_returns and np.any(array <= -1.0):
        raise ValueError(f"{name} contains an impossible daily return <= -100%")
    return array.copy()


def _positive_real(value: float, *, name: str, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a finite number greater than {minimum}")
    numeric = float(value)
    if not math.isfinite(numeric) or numeric <= minimum:
        raise ValueError(f"{name} must be a finite number greater than {minimum}")
    return numeric


def _positive_int(value: int, *, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral) or int(value) <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return int(value)


def _nonnegative_int(value: int, *, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, Integral) or int(value) < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return int(value)


def _seed(value: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, Integral)
        or int(value) < 0
    ):
        raise ValueError("seed must be a non-negative integer")
    return int(value)


def _bootstrap_settings(
    *,
    n_bootstrap: int,
    mean_block_length: float,
    seed: int,
    annualization: float,
) -> tuple[int, float, int, float]:
    replications = _positive_int(n_bootstrap, name="n_bootstrap")
    block_length = _positive_real(
        mean_block_length,
        name="mean_block_length",
        minimum=0.0,
    )
    if block_length < 1.0:
        raise ValueError("mean_block_length must be at least 1")
    random_seed = _seed(seed)
    periods = _positive_real(annualization, name="annualization", minimum=0.0)
    return replications, block_length, random_seed, periods


def _stationary_bootstrap_indices(
    n_observations: int,
    *,
    restart_probability: float,
    rng: np.random.Generator,
) -> np.ndarray:
    """Draw one Politis-Romano stationary-bootstrap index path.

    A block restarts at a uniformly sampled observation with probability
    ``restart_probability``; otherwise the previous index advances by one and
    wraps at the end of the original sample.
    """

    indices = np.empty(n_observations, dtype=np.int64)
    indices[0] = rng.integers(0, n_observations)
    if n_observations == 1:
        return indices

    restarts = rng.random(n_observations - 1) < restart_probability
    new_starts = rng.integers(0, n_observations, size=n_observations - 1)
    for position in range(1, n_observations):
        if restarts[position - 1]:
            indices[position] = new_starts[position - 1]
        else:
            indices[position] = (indices[position - 1] + 1) % n_observations
    return indices


def _quantiles(values: np.ndarray) -> dict[str, float]:
    if not np.all(np.isfinite(values)):
        raise ValueError("bootstrap produced non-finite statistics")
    q05, q50, q95 = np.quantile(values, [0.05, 0.50, 0.95])
    return {"q05": float(q05), "q50": float(q50), "q95": float(q95)}


def _finite_mean(values: np.ndarray, *, context: str, axis: int | None = None):
    """Compute a mean while turning numerical overflow into a closed failure."""

    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            result = np.mean(values, axis=axis)
    except FloatingPointError as exc:
        raise ValueError(f"{context} produced arithmetic overflow") from exc
    if not np.all(np.isfinite(result)):
        raise ValueError(f"{context} produced a non-finite statistic")
    return result


def _scaled(values, scale: float, *, context: str):
    try:
        with np.errstate(over="raise", invalid="raise"):
            result = np.asarray(values) * scale
    except FloatingPointError as exc:
        raise ValueError(f"{context} produced arithmetic overflow") from exc
    if not np.all(np.isfinite(result)):
        raise ValueError(f"{context} produced a non-finite statistic")
    return result


def paired_stationary_bootstrap(
    candidate_returns: Sequence[float] | np.ndarray,
    incumbent_returns: Sequence[float] | np.ndarray,
    *,
    n_bootstrap: int = DEFAULT_BOOTSTRAP_REPLICATIONS,
    mean_block_length: float = DEFAULT_MEAN_BLOCK_LENGTH,
    seed: int = 0,
    annualization: float = DEFAULT_TRADING_DAYS_PER_YEAR,
) -> dict[str, Any]:
    """Bootstrap the paired mean daily return difference.

    The same stationary-bootstrap index path is applied to both strategies.
    The reported statistic is the arithmetic daily mean of
    ``candidate - incumbent``, annualized and converted to percentage points.
    This is deliberately an active-return statistic, not a difference between
    independently compounded CAGR estimates.
    """

    candidate = _finite_vector(
        candidate_returns,
        name="candidate_returns",
        minimum_size=3,
    )
    incumbent = _finite_vector(
        incumbent_returns,
        name="incumbent_returns",
        minimum_size=3,
    )
    if candidate.shape != incumbent.shape:
        raise ValueError(
            "candidate_returns and incumbent_returns must have identical shapes"
        )
    replications, block_length, random_seed, periods = _bootstrap_settings(
        n_bootstrap=n_bootstrap,
        mean_block_length=mean_block_length,
        seed=seed,
        annualization=annualization,
    )

    try:
        with np.errstate(over="raise", invalid="raise"):
            active = candidate - incumbent
    except FloatingPointError as exc:
        raise ValueError("paired active-return calculation overflowed") from exc
    rng = np.random.default_rng(random_seed)
    restart_probability = 1.0 / block_length
    samples = np.empty(replications, dtype=float)
    scale = periods * 100.0
    for replication in range(replications):
        indices = _stationary_bootstrap_indices(
            active.size,
            restart_probability=restart_probability,
            rng=rng,
        )
        sample_mean = _finite_mean(
            active[indices],
            context="paired stationary bootstrap",
        )
        samples[replication] = float(
            _scaled(sample_mean, scale, context="paired stationary bootstrap")
        )

    point_mean = _finite_mean(active, context="paired active-return mean")
    point_estimate = float(
        _scaled(point_mean, scale, context="paired active-return mean")
    )

    return {
        "method": "paired_stationary_bootstrap",
        "n_observations": int(active.size),
        "n_bootstrap": replications,
        "seed": random_seed,
        "mean_block_length": block_length,
        "restart_probability": restart_probability,
        "annualization": periods,
        "statistic": "arithmetic_mean(candidate_daily_return - incumbent_daily_return)",
        "output_unit": "annualized_percentage_points",
        "point_estimate_annualized_pct": point_estimate,
        "annualized_mean_active_difference_pct": _quantiles(samples),
        "probability_gt_zero": float(np.mean(samples > 0.0)),
    }


def _maximum_drawdown_loss(returns: np.ndarray) -> float:
    """Maximum peak-to-trough loss as a positive decimal fraction."""

    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            levels = np.empty(returns.size + 1, dtype=float)
            levels[0] = 1.0
            levels[1:] = np.cumprod(1.0 + returns)
            peaks = np.maximum.accumulate(levels)
            losses = 1.0 - levels / peaks
    except FloatingPointError as exc:
        raise ValueError("drawdown compounding produced arithmetic overflow") from exc
    if not np.all(np.isfinite(levels)) or not np.all(np.isfinite(losses)):
        raise ValueError("drawdown compounding produced non-finite path values")
    return float(np.max(losses))


def bootstrap_path_max_drawdown(
    returns: Sequence[float] | np.ndarray,
    *,
    n_bootstrap: int = DEFAULT_BOOTSTRAP_REPLICATIONS,
    mean_block_length: float = DEFAULT_MEAN_BLOCK_LENGTH,
    seed: int = 0,
) -> dict[str, Any]:
    """Estimate path max-drawdown risk with a stationary bootstrap.

    Drawdown is returned as a positive loss percentage, so ``q95`` is the
    adverse 95th-percentile max-drawdown estimate (larger is worse).
    """

    daily_returns = _finite_vector(returns, name="returns")
    replications, block_length, random_seed, _ = _bootstrap_settings(
        n_bootstrap=n_bootstrap,
        mean_block_length=mean_block_length,
        seed=seed,
        annualization=DEFAULT_TRADING_DAYS_PER_YEAR,
    )

    rng = np.random.default_rng(random_seed)
    restart_probability = 1.0 / block_length
    losses_pct = np.empty(replications, dtype=float)
    for replication in range(replications):
        indices = _stationary_bootstrap_indices(
            daily_returns.size,
            restart_probability=restart_probability,
            rng=rng,
        )
        losses_pct[replication] = (
            _maximum_drawdown_loss(daily_returns[indices]) * 100.0
        )

    quantiles = _quantiles(losses_pct)
    return {
        "method": "stationary_bootstrap_path_max_drawdown",
        "comparison": "standalone_strategy_path_risk",
        "n_observations": int(daily_returns.size),
        "n_bootstrap": replications,
        "seed": random_seed,
        "mean_block_length": block_length,
        "restart_probability": restart_probability,
        "output_unit": "positive_loss_pct",
        "observed_max_drawdown_loss_pct": _maximum_drawdown_loss(daily_returns)
        * 100.0,
        "bootstrap_max_drawdown_loss_pct": quantiles,
        "q95_max_drawdown_loss_pct": quantiles["q95"],
    }


def white_reality_check(
    candidate_returns: Mapping[str, Sequence[float] | np.ndarray],
    incumbent_returns: Sequence[float] | np.ndarray,
    *,
    n_bootstrap: int = DEFAULT_BOOTSTRAP_REPLICATIONS,
    mean_block_length: float = DEFAULT_MEAN_BLOCK_LENGTH,
    seed: int = 0,
    annualization: float = DEFAULT_TRADING_DAYS_PER_YEAR,
) -> dict[str, Any]:
    """Run White's Reality Check for a frozen candidate family.

    For each candidate ``k``, the paired active return is ``d[k, t]``.  The
    observed statistic is ``max_k annualization * mean(d[k])``.  Under the null,
    each active-return row is centered by its own full-sample mean, and the
    same stationary-bootstrap indices are applied to every row.  The p-value
    uses the conservative finite-simulation correction ``(hits + 1)/(B + 1)``.
    """

    if not isinstance(candidate_returns, Mapping) or not candidate_returns:
        raise ValueError("candidate_returns must be a non-empty mapping")
    incumbent = _finite_vector(
        incumbent_returns,
        name="incumbent_returns",
        minimum_size=3,
    )
    replications, block_length, random_seed, periods = _bootstrap_settings(
        n_bootstrap=n_bootstrap,
        mean_block_length=mean_block_length,
        seed=seed,
        annualization=annualization,
    )

    raw_names = list(candidate_returns)
    if any(not isinstance(name, str) for name in raw_names):
        raise ValueError("candidate names must be non-empty strings")

    candidate_names: list[str] = []
    rows: list[np.ndarray] = []
    for raw_name in sorted(raw_names):
        if not raw_name.strip():
            raise ValueError("candidate names must be non-empty strings")
        name = raw_name.strip()
        if name in candidate_names:
            raise ValueError("candidate names must be unique after trimming")
        candidate = _finite_vector(
            candidate_returns[raw_name],
            name=f"candidate_returns[{raw_name!r}]",
            minimum_size=3,
        )
        if candidate.shape != incumbent.shape:
            raise ValueError(
                f"candidate {raw_name!r} and incumbent_returns must have "
                "identical shapes"
            )
        candidate_names.append(name)
        try:
            with np.errstate(over="raise", invalid="raise"):
                rows.append(candidate - incumbent)
        except FloatingPointError as exc:
            raise ValueError(
                f"candidate {raw_name!r} active-return calculation overflowed"
            ) from exc

    active = np.vstack(rows)
    scale = periods * 100.0
    observed_means = _finite_mean(
        active,
        axis=1,
        context="White Reality Check observed means",
    )
    observed_by_candidate = _scaled(
        observed_means,
        scale,
        context="White Reality Check observed means",
    )
    observed_statistic = float(np.max(observed_by_candidate))
    best_index = int(np.argmax(observed_by_candidate))
    try:
        with np.errstate(over="raise", invalid="raise"):
            centered = active - np.asarray(observed_means)[:, None]
    except FloatingPointError as exc:
        raise ValueError("White Reality Check centering overflowed") from exc
    if not np.all(np.isfinite(centered)):
        raise ValueError("White Reality Check centering produced non-finite values")

    rng = np.random.default_rng(random_seed)
    restart_probability = 1.0 / block_length
    null_maxima = np.empty(replications, dtype=float)
    for replication in range(replications):
        indices = _stationary_bootstrap_indices(
            incumbent.size,
            restart_probability=restart_probability,
            rng=rng,
        )
        null_means = _finite_mean(
            centered[:, indices],
            axis=1,
            context="White Reality Check bootstrap",
        )
        null_maxima[replication] = float(
            np.max(
                _scaled(
                    null_means,
                    scale,
                    context="White Reality Check bootstrap",
                )
            )
        )

    exceedances = int(np.count_nonzero(null_maxima >= observed_statistic))
    return {
        "method": "white_reality_check_stationary_bootstrap",
        "null": "no frozen candidate has positive expected return vs incumbent",
        "n_observations": int(incumbent.size),
        "n_candidates": len(candidate_names),
        "frozen_candidate_order": candidate_names,
        "n_bootstrap": replications,
        "seed": random_seed,
        "mean_block_length": block_length,
        "restart_probability": restart_probability,
        "annualization": periods,
        "output_unit": "annualized_percentage_points",
        "observed_annualized_mean_active_pct": {
            name: float(value)
            for name, value in zip(candidate_names, observed_by_candidate)
        },
        "best_candidate": candidate_names[best_index],
        "observed_max_statistic_pct": observed_statistic,
        "centered_null_max_statistic_pct": _quantiles(null_maxima),
        "p_value": float((exceedances + 1) / (replications + 1)),
        "finite_simulation_correction": "(exceedances + 1) / (n_bootstrap + 1)",
    }


def _autocorrelation_effective_sample_size(
    centered_returns: np.ndarray,
    *,
    autocorrelation_lags: int,
) -> dict[str, Any]:
    """Conservative Bartlett-weighted effective sample size.

    ``T_eff_raw = T / (1 + 2*sum(w_k*rho_k))`` with Bartlett weights
    ``w_k = 1-k/(L+1)``.  Negative autocorrelation is not allowed to increase
    confidence: the final value is clamped to ``[3, T]``.  A non-positive
    variance-inflation estimate likewise falls back to ``T`` before clamping.
    """

    requested_lags = _nonnegative_int(
        autocorrelation_lags,
        name="autocorrelation_lags",
    )
    raw_size = int(centered_returns.size)
    used_lags = min(requested_lags, raw_size - 1)
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            denominator = float(np.sum(centered_returns**2))
            correlations: list[float] = []
            weighted_sum = 0.0
            for lag in range(1, used_lags + 1):
                rho = float(
                    np.sum(centered_returns[lag:] * centered_returns[:-lag])
                    / denominator
                )
                weight = 1.0 - lag / (used_lags + 1.0)
                correlations.append(rho)
                weighted_sum += weight * rho
            variance_inflation = 1.0 + 2.0 * weighted_sum
    except FloatingPointError as exc:
        raise ValueError(
            "autocorrelation effective-sample calculation overflowed"
        ) from exc
    if not all(math.isfinite(value) for value in correlations):
        raise ValueError("autocorrelation calculation produced non-finite values")
    if not math.isfinite(variance_inflation):
        raise ValueError("autocorrelation variance inflation is non-finite")

    if variance_inflation > 0.0:
        unclamped = raw_size / variance_inflation
    else:
        # Do not turn an unstable negative long-run variance estimate into an
        # artificial confidence gain.
        unclamped = float(raw_size)
    effective_size = max(3.0, min(float(raw_size), float(unclamped)))
    return {
        "raw_observation_count": raw_size,
        "effective_observation_count": effective_size,
        "autocorrelation_lags_requested": requested_lags,
        "autocorrelation_lags_used": used_lags,
        "bartlett_autocorrelations": correlations,
        "bartlett_weighted_autocorrelation_sum": weighted_sum,
        "variance_inflation_factor": variance_inflation,
        "unclamped_effective_observation_count": float(unclamped),
        "effective_sample_size_formula": (
            "clamp(T / (1 + 2*sum_{k=1..L} "
            "(1-k/(L+1))*rho_k), lower=3, upper=T)"
        ),
    }


def _sharpe_inputs(
    excess_returns: Sequence[float] | np.ndarray,
    *,
    annualization: float,
    autocorrelation_lags: int,
) -> dict[str, Any]:
    daily_excess_returns = _finite_vector(
        excess_returns,
        name="excess_returns",
        minimum_size=3,
        valid_returns=False,
    )
    periods = _positive_real(annualization, name="annualization", minimum=0.0)
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            sample_std = float(np.std(daily_excess_returns, ddof=1))
            sample_mean = float(np.mean(daily_excess_returns))
            centered = daily_excess_returns - sample_mean
            second_moment = float(np.mean(centered**2))
    except FloatingPointError as exc:
        raise ValueError("Sharpe moment calculation produced arithmetic overflow") from exc
    if not all(math.isfinite(value) for value in (sample_std, sample_mean, second_moment)):
        raise ValueError("Sharpe moment calculation produced non-finite values")
    if sample_std <= 0.0:
        raise ValueError(
            "excess_returns must have non-zero sample standard deviation"
        )
    if second_moment <= 0.0:
        raise ValueError("excess_returns must have non-zero centered variance")

    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            skewness = float(np.mean(centered**3) / (second_moment**1.5))
            kurtosis = float(np.mean(centered**4) / (second_moment**2))
    except FloatingPointError as exc:
        raise ValueError("Sharpe higher-moment calculation overflowed") from exc
    if not math.isfinite(skewness) or not math.isfinite(kurtosis):
        raise ValueError("Sharpe higher-moment calculation produced non-finite values")

    daily_sharpe = sample_mean / sample_std
    annualized_sharpe = daily_sharpe * math.sqrt(periods)
    if not math.isfinite(daily_sharpe) or not math.isfinite(annualized_sharpe):
        raise ValueError("Sharpe calculation produced a non-finite value")
    sample_size = _autocorrelation_effective_sample_size(
        centered,
        autocorrelation_lags=autocorrelation_lags,
    )
    return {
        "excess_returns": daily_excess_returns,
        "annualization": periods,
        "daily_sharpe": daily_sharpe,
        "annualized_sharpe": annualized_sharpe,
        "skewness": skewness,
        "kurtosis": kurtosis,
        **sample_size,
    }


def probabilistic_sharpe_ratio(
    excess_returns: Sequence[float] | np.ndarray,
    *,
    benchmark_sharpe_annualized: float = 0.0,
    annualization: float = DEFAULT_TRADING_DAYS_PER_YEAR,
    autocorrelation_lags: int = DEFAULT_AUTOCORRELATION_LAGS,
) -> dict[str, Any]:
    """Probability that the population Sharpe exceeds a benchmark.

    Implements the Bailey/Lopez de Prado probabilistic Sharpe ratio using
    sample skewness and raw (not excess) kurtosis::

        PSR = Phi((SR - SR*) * sqrt(T_eff - 1)
                  / sqrt(1 - skew*SR + ((kurtosis - 1)/4)*SR**2))

    ``SR`` and ``SR*`` are converted to daily units inside the formula; the
    public benchmark argument and reported Sharpe ratios are annualized.
    ``excess_returns`` must already be aligned daily portfolio-minus-BIL
    returns.  ``T_eff`` conservatively adjusts the raw count for serial
    correlation with Bartlett weights and is never allowed to exceed ``T``.
    """

    inputs = _sharpe_inputs(
        excess_returns,
        annualization=annualization,
        autocorrelation_lags=autocorrelation_lags,
    )
    benchmark_annual = float(benchmark_sharpe_annualized)
    if not math.isfinite(benchmark_annual):
        raise ValueError("benchmark_sharpe_annualized must be finite")
    periods = float(inputs["annualization"])
    benchmark_daily = benchmark_annual / math.sqrt(periods)
    daily_sharpe = float(inputs["daily_sharpe"])
    skewness = float(inputs["skewness"])
    kurtosis = float(inputs["kurtosis"])
    variance_adjustment = (
        1.0
        - skewness * daily_sharpe
        + ((kurtosis - 1.0) / 4.0) * daily_sharpe**2
    )
    if not math.isfinite(variance_adjustment) or variance_adjustment <= 0.0:
        raise ValueError("probabilistic Sharpe variance adjustment is not positive")

    z_score = (
        (daily_sharpe - benchmark_daily)
        * math.sqrt(float(inputs["effective_observation_count"]) - 1.0)
        / math.sqrt(variance_adjustment)
    )
    probability = NormalDist().cdf(z_score)
    return {
        "method": "probabilistic_sharpe_ratio",
        "probability_sharpe_gt_benchmark": float(probability),
        "z_score": float(z_score),
        "formula": (
            "Phi((SR_daily - SR*_daily) * sqrt(T_eff - 1) / "
            "sqrt(1 - skew*SR_daily + ((kurtosis - 1)/4)*SR_daily^2))"
        ),
        "input_return_definition": "aligned daily excess returns: portfolio - BIL",
        "inputs": {
            "n_observations": int(inputs["raw_observation_count"]),
            "raw_observation_count": int(inputs["raw_observation_count"]),
            "effective_observation_count": float(
                inputs["effective_observation_count"]
            ),
            "autocorrelation_lags_requested": int(
                inputs["autocorrelation_lags_requested"]
            ),
            "autocorrelation_lags_used": int(inputs["autocorrelation_lags_used"]),
            "bartlett_autocorrelations": inputs["bartlett_autocorrelations"],
            "bartlett_weighted_autocorrelation_sum": float(
                inputs["bartlett_weighted_autocorrelation_sum"]
            ),
            "autocorrelation_variance_inflation_factor": float(
                inputs["variance_inflation_factor"]
            ),
            "unclamped_effective_observation_count": float(
                inputs["unclamped_effective_observation_count"]
            ),
            "effective_sample_size_formula": inputs[
                "effective_sample_size_formula"
            ],
            "annualization": periods,
            "estimated_sharpe_daily": daily_sharpe,
            "estimated_sharpe_annualized": float(inputs["annualized_sharpe"]),
            "benchmark_sharpe_daily": benchmark_daily,
            "benchmark_sharpe_annualized": benchmark_annual,
            "sample_skewness": skewness,
            "sample_raw_kurtosis": kurtosis,
            "variance_adjustment": variance_adjustment,
        },
    }


def deflated_sharpe_ratio(
    excess_returns: Sequence[float] | np.ndarray,
    *,
    trial_sharpes_annualized: Sequence[float] | np.ndarray,
    legacy_trial_floor: int,
    trial_sharpe_std_floor: float | None = None,
    annualization: float = DEFAULT_TRADING_DAYS_PER_YEAR,
    autocorrelation_lags: int = DEFAULT_AUTOCORRELATION_LAGS,
) -> dict[str, Any]:
    """Probabilistic Sharpe ratio deflated for multiple strategy trials.

    ``legacy_trial_floor`` is the minimum effective number of trials, allowing
    a new tournament to account explicitly for prior strategy searches.  The
    effective count is ``max(len(trial_sharpes), legacy_trial_floor)``.  The
    expected maximum Sharpe under a zero-mean Gaussian trials null is::

        SR* = effective_std(trial Sharpes) * ((1-gamma) * Phi^-1(1-1/N)
                                             + gamma * Phi^-1(1-1/(N*e)))

    That annualized ``SR*`` is then passed to :func:`probabilistic_sharpe_ratio`.
    The independent/equal-variance Gaussian-trials approximation is exposed in
    the output rather than presented as a guarantee.  ``excess_returns`` must
    be aligned daily portfolio-minus-BIL returns.  When the legacy count is
    larger than the observed trial set, zero observed Sharpe dispersion fails
    closed unless an explicit positive ``trial_sharpe_std_floor`` is supplied.
    """

    trials = _finite_vector(
        trial_sharpes_annualized,
        name="trial_sharpes_annualized",
        minimum_size=2,
        valid_returns=False,
    )
    trial_floor = _positive_int(legacy_trial_floor, name="legacy_trial_floor")
    periods = _positive_real(annualization, name="annualization", minimum=0.0)
    effective_trials = max(int(trials.size), trial_floor)
    if effective_trials < 2:
        raise ValueError("deflated Sharpe ratio requires at least two effective trials")

    try:
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            trial_std = float(np.std(trials, ddof=1))
    except FloatingPointError as exc:
        raise ValueError("trial Sharpe dispersion calculation overflowed") from exc
    if not math.isfinite(trial_std):
        raise ValueError("trial Sharpe dispersion must be finite")
    if trial_sharpe_std_floor is None:
        std_floor = None
    else:
        std_floor = _positive_real(
            trial_sharpe_std_floor,
            name="trial_sharpe_std_floor",
            minimum=0.0,
        )
    if trial_floor > int(trials.size) and trial_std == 0.0 and std_floor is None:
        raise ValueError(
            "legacy_trial_floor exceeds observed trials with zero dispersion; "
            "provide a positive trial_sharpe_std_floor"
        )
    effective_trial_std = max(trial_std, std_floor or 0.0)
    normal = NormalDist()
    first_quantile = normal.inv_cdf(1.0 - 1.0 / effective_trials)
    second_quantile = normal.inv_cdf(
        1.0 - 1.0 / (effective_trials * math.e)
    )
    expected_maximum_sharpe = effective_trial_std * (
        (1.0 - _EULER_MASCHERONI) * first_quantile
        + _EULER_MASCHERONI * second_quantile
    )
    psr = probabilistic_sharpe_ratio(
        excess_returns,
        benchmark_sharpe_annualized=expected_maximum_sharpe,
        annualization=periods,
        autocorrelation_lags=autocorrelation_lags,
    )
    return {
        "method": "deflated_sharpe_ratio",
        "probability_sharpe_gt_expected_maximum": psr[
            "probability_sharpe_gt_benchmark"
        ],
        "z_score": psr["z_score"],
        "formula": (
            "SR* = effective_std(trial Sharpes) * "
            "((1-gamma)*Phi^-1(1-1/N) + "
            "gamma*Phi^-1(1-1/(N*e))); DSR = PSR(SR*)"
        ),
        "input_return_definition": "aligned daily excess returns: portfolio - BIL",
        "assumption": (
            "expected-maximum benchmark uses an independent, equal-variance "
            "Gaussian-trials approximation"
        ),
        "inputs": {
            **psr["inputs"],
            "observed_trial_count": int(trials.size),
            "legacy_trial_floor": trial_floor,
            "effective_trial_count": effective_trials,
            "trial_sharpes_annualized": [float(value) for value in trials],
            "trial_sharpe_sample_std_annualized": trial_std,
            "trial_sharpe_std_floor_annualized": std_floor,
            "effective_trial_sharpe_std_annualized": effective_trial_std,
            "euler_mascheroni_gamma": _EULER_MASCHERONI,
            "expected_maximum_sharpe_annualized": expected_maximum_sharpe,
            "expected_maximum_sharpe_daily": expected_maximum_sharpe
            / math.sqrt(periods),
        },
    }


def fold_stability(
    dates: Sequence[str],
    candidate_returns: Sequence[float] | np.ndarray,
    incumbent_returns: Sequence[float] | np.ndarray,
    folds: Sequence[Mapping[str, str]],
    *,
    annualization: float = DEFAULT_TRADING_DAYS_PER_YEAR,
    minimum_observations_per_fold: int = 2,
) -> dict[str, Any]:
    """Summarize paired active returns over non-overlapping inclusive folds."""

    if isinstance(dates, (str, bytes)):
        raise ValueError("dates must be a sequence of ISO date strings")
    parsed_dates: list[date] = []
    normalized_dates: list[str] = []
    for raw_date in dates:
        if not isinstance(raw_date, str):
            raise ValueError("dates must contain ISO date strings")
        try:
            parsed = date.fromisoformat(raw_date)
        except ValueError as exc:
            raise ValueError(f"invalid ISO date: {raw_date!r}") from exc
        parsed_dates.append(parsed)
        normalized_dates.append(parsed.isoformat())
    if not parsed_dates:
        raise ValueError("dates must not be empty")
    if any(current <= previous for previous, current in zip(parsed_dates, parsed_dates[1:])):
        raise ValueError("dates must be strictly increasing and unique")

    candidate = _finite_vector(candidate_returns, name="candidate_returns")
    incumbent = _finite_vector(incumbent_returns, name="incumbent_returns")
    if len(normalized_dates) != candidate.size or candidate.shape != incumbent.shape:
        raise ValueError("dates and both return series must have identical lengths")
    if isinstance(folds, (str, bytes)) or not isinstance(folds, Sequence) or not folds:
        raise ValueError("folds must be a non-empty sequence of mappings")
    periods = _positive_real(annualization, name="annualization", minimum=0.0)
    minimum_size = _positive_int(
        minimum_observations_per_fold,
        name="minimum_observations_per_fold",
    )

    normalized_folds: list[tuple[str, date, date]] = []
    seen_names: set[str] = set()
    for position, fold in enumerate(folds):
        if not isinstance(fold, Mapping):
            raise ValueError("each fold must be a mapping with name/start/end")
        raw_name = fold.get("name")
        raw_start = fold.get("start")
        raw_end = fold.get("end")
        if not isinstance(raw_name, str) or not raw_name.strip():
            raise ValueError(f"fold {position} has an invalid name")
        name = raw_name.strip()
        if name in seen_names:
            raise ValueError(f"duplicate fold name: {name!r}")
        seen_names.add(name)
        if not isinstance(raw_start, str) or not isinstance(raw_end, str):
            raise ValueError(f"fold {name!r} start/end must be ISO date strings")
        try:
            start = date.fromisoformat(raw_start)
            end = date.fromisoformat(raw_end)
        except ValueError as exc:
            raise ValueError(f"fold {name!r} has an invalid ISO date") from exc
        if start > end:
            raise ValueError(f"fold {name!r} starts after it ends")
        normalized_folds.append((name, start, end))

    normalized_folds.sort(key=lambda item: (item[1], item[2], item[0]))
    for previous, current in zip(normalized_folds, normalized_folds[1:]):
        if current[1] <= previous[2]:
            raise ValueError(
                f"folds {previous[0]!r} and {current[0]!r} overlap"
            )

    try:
        with np.errstate(over="raise", invalid="raise"):
            active = candidate - incumbent
    except FloatingPointError as exc:
        raise ValueError("fold active-return calculation overflowed") from exc
    fold_results: list[dict[str, Any]] = []
    assigned = np.zeros(candidate.size, dtype=bool)
    scale = periods * 100.0
    for name, start, end in normalized_folds:
        mask = np.asarray(
            [start <= observed_date <= end for observed_date in parsed_dates],
            dtype=bool,
        )
        count = int(np.count_nonzero(mask))
        if count < minimum_size:
            raise ValueError(
                f"fold {name!r} contains {count} observations; "
                f"minimum is {minimum_size}"
            )
        assigned |= mask
        active_annualized = float(
            _scaled(
                _finite_mean(active[mask], context=f"fold {name!r} active mean"),
                scale,
                context=f"fold {name!r} active mean",
            )
        )
        candidate_annualized = float(
            _scaled(
                _finite_mean(
                    candidate[mask],
                    context=f"fold {name!r} candidate mean",
                ),
                scale,
                context=f"fold {name!r} candidate mean",
            )
        )
        incumbent_annualized = float(
            _scaled(
                _finite_mean(
                    incumbent[mask],
                    context=f"fold {name!r} incumbent mean",
                ),
                scale,
                context=f"fold {name!r} incumbent mean",
            )
        )
        fold_results.append(
            {
                "name": name,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "first_observation": normalized_dates[int(np.flatnonzero(mask)[0])],
                "last_observation": normalized_dates[int(np.flatnonzero(mask)[-1])],
                "n_observations": count,
                "candidate_arithmetic_mean_annualized_pct": candidate_annualized,
                "incumbent_arithmetic_mean_annualized_pct": incumbent_annualized,
                "active_mean_annualized_pct": active_annualized,
                "positive_active_mean": active_annualized > 0.0,
            }
        )

    fold_active = np.asarray(
        [row["active_mean_annualized_pct"] for row in fold_results],
        dtype=float,
    )
    positive_count = int(np.count_nonzero(fold_active > 0.0))
    worst_index = int(np.argmin(fold_active))
    best_index = int(np.argmax(fold_active))
    return {
        "method": "non_overlapping_fold_stability",
        "annualization": periods,
        "active_statistic": (
            "arithmetic_mean(candidate_daily_return - incumbent_daily_return)"
        ),
        "output_unit": "annualized_percentage_points",
        "n_folds": len(fold_results),
        "minimum_observations_per_fold": minimum_size,
        "positive_fold_count": positive_count,
        "positive_fold_fraction": positive_count / len(fold_results),
        "all_folds_positive": positive_count == len(fold_results),
        "median_active_mean_annualized_pct": float(np.median(fold_active)),
        "worst_fold": fold_results[worst_index]["name"],
        "worst_fold_active_mean_annualized_pct": float(fold_active[worst_index]),
        "best_fold": fold_results[best_index]["name"],
        "best_fold_active_mean_annualized_pct": float(fold_active[best_index]),
        "unassigned_observations": int(np.count_nonzero(~assigned)),
        "folds": fold_results,
    }


__all__ = [
    "DEFAULT_AUTOCORRELATION_LAGS",
    "DEFAULT_BOOTSTRAP_REPLICATIONS",
    "DEFAULT_MEAN_BLOCK_LENGTH",
    "DEFAULT_TRADING_DAYS_PER_YEAR",
    "bootstrap_path_max_drawdown",
    "deflated_sharpe_ratio",
    "fold_stability",
    "paired_stationary_bootstrap",
    "probabilistic_sharpe_ratio",
    "white_reality_check",
]
