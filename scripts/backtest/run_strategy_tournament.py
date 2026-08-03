"""Run frozen strategy-tournament epoch 1 without touching production V11.

The pre-registration contract lives in
``strategy/strategy_tournament_epoch_1.md`` and was committed before this
runner was executed.  This command compares every frozen candidate on one
causal clock, produces compact reproducible evidence, and can nominate only a
shadow challenger.  It never edits live configuration or trading state.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform
import sys
from typing import Any

import numpy as np
import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import adaptive_momentum  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.strategy_candidates import (  # noqa: E402
    CANDIDATE_BY_NAME,
    CANDIDATE_SPECS,
    SECTOR_ETFS,
    PointInTimeFactorCache,
    build_target_portfolio,
    candidate_manifest,
)
from backtest.target_strategy_runner import (  # noqa: E402
    StrategyContext,
    TargetBacktestConfig,
    run_target_strategy,
)
from backtest.tournament_statistics import (  # noqa: E402
    bootstrap_path_max_drawdown,
    deflated_sharpe_ratio,
    fold_stability,
    paired_stationary_bootstrap,
    white_reality_check,
)
from momentum_picker import is_month_start  # noqa: E402
from strategy_identity import (  # noqa: E402
    build_bar_snapshot_identity,
    hash_symbol_universe,
)
from universe import load_universe_symbols  # noqa: E402
from utils import (  # noqa: E402
    PROJECT_ROOT,
    WATCHLIST_PATH,
    load_json,
    save_json,
)


PROTOCOL_PATH = PROJECT_ROOT / "strategy" / "strategy_tournament_epoch_1.md"
OUTPUT_PATH = PROJECT_ROOT / "state" / "backtest" / "strategy_tournament_epoch_1.json"
MARKDOWN_OUTPUT_PATH = (
    PROJECT_ROOT / "strategy" / "strategy_tournament_epoch_1_results.md"
)
PREREGISTRATION_COMMIT = "b796593211ff60c13e0e7247d3b46214e2e86fa6"
PREREGISTRATION_SHA256 = (
    "da11234a9dcc4f9848e824ec6201aa2d2ef1151cd2d34533e20445ac9f2cc938"
)
DATA_CUTOFF = "2026-07-10"
FULL_START = "2022-01-04"
DEVELOPMENT_START = "2022-01-04"
DEVELOPMENT_END = "2024-12-31"
REUSED_START = "2025-01-02"
REUSED_END = DATA_CUTOFF
STARTING_CASH = 1_000_000.0
PRIMARY_COST_BPS = 15.0
INFERENCE_COST_BPS = 25.0
STANDARD_COSTS_BPS = (7.0, 15.0, 25.0, 50.0)
REVERSAL_EXTRA_COST_BPS = 30.0
BOOTSTRAP_SEED = 20_260_803
BOOTSTRAP_REPLICATIONS = 10_000
BOOTSTRAP_BLOCK_LENGTH = 21.0
BOOTSTRAP_SENSITIVITY_BLOCKS = (5.0, 21.0, 63.0)
LEGACY_TRIAL_FLOOR = 105
AUTOCORRELATION_LAGS = 21
INCUMBENT_NAME = "v11_incumbent"

EXPECTED_CANDIDATES = (
    "v11_incumbent",
    "risk_adjusted_momentum",
    "market_residual_momentum",
    "fip_momentum",
    "high_52_week",
    "sector_neutral_momentum",
    "low_vol_trend",
    "momentum_low_vol_ensemble",
    "core_satellite",
    "sector_etf_momentum",
    "short_term_reversal_negative_control",
)

RESEARCH_SOURCE_PATHS = (
    "requirements.txt",
    "requirements.lock",
    "watchlist.json",
    "scripts/adaptive_momentum.py",
    "scripts/momentum_picker.py",
    "scripts/risk_policy.py",
    "scripts/strategy_identity.py",
    "scripts/universe.py",
    "scripts/utils.py",
    "scripts/backtest/data_provider.py",
    "scripts/backtest/metrics.py",
    "scripts/backtest/portfolio_sim.py",
    "scripts/backtest/strategy_candidates.py",
    "scripts/backtest/target_strategy_runner.py",
    "scripts/backtest/tournament_statistics.py",
    "scripts/backtest/run_strategy_tournament.py",
)

DEVELOPMENT_FOLDS = (
    {"name": "2022H1", "start": "2022-01-04", "end": "2022-06-30"},
    {"name": "2022H2", "start": "2022-07-01", "end": "2022-12-30"},
    {"name": "2023H1", "start": "2023-01-03", "end": "2023-06-30"},
    {"name": "2023H2", "start": "2023-07-03", "end": "2023-12-29"},
    {"name": "2024H1", "start": "2024-01-02", "end": "2024-06-28"},
    {"name": "2024H2", "start": "2024-07-01", "end": "2024-12-31"},
)
REUSED_FOLDS = (
    {"name": "2025H1", "start": "2025-01-02", "end": "2025-06-30"},
    {"name": "2025H2", "start": "2025-07-01", "end": "2025-12-31"},
    {"name": "2026H1", "start": "2026-01-02", "end": "2026-07-10"},
)

class TournamentBarProvider(BarProvider):
    """Bar provider that physically removes every row after the frozen cutoff."""

    def __init__(self, *, cutoff: str = DATA_CUTOFF) -> None:
        super().__init__()
        self.cutoff = cutoff
        self._truncated: set[str] = set()

    def load(self, symbol: str):
        frame = super().load(symbol)
        if symbol not in self._truncated:
            if frame is not None:
                frame = frame.loc[frame.index <= self.cutoff].copy()
                self._cache[symbol] = frame
                self._day_cache.pop(symbol, None)
            self._truncated.add(symbol)
        return frame


def _sector_map(symbols: Sequence[str]) -> dict[str, str]:
    watchlist = load_json(WATCHLIST_PATH).get("symbols", {})
    if not isinstance(watchlist, Mapping):
        watchlist = {}
    output: dict[str, str] = {}
    for symbol in symbols:
        info = watchlist.get(symbol, {})
        sector = info.get("sector") if isinstance(info, Mapping) else None
        output[symbol] = str(sector or "Unknown")
    return output


@dataclass
class CandidateStrategyAdapter:
    """Stateful cadence/risk adapter around one pure frozen candidate."""

    name: str
    stock_universe: tuple[str, ...]
    sectors: Mapping[str, str]
    factor_cache: PointInTimeFactorCache
    target_cache: dict[tuple[object, ...], dict[str, float]] = field(
        default_factory=dict,
        repr=False,
    )
    _risk_off_latched: bool = False
    _force_reentry: bool = False

    @property
    def spec(self):
        return CANDIDATE_BY_NAME[self.name]

    def _market_risk_off(self, context: StrategyContext) -> bool:
        if context.risk_tier == "HALT":
            return True
        market = adaptive_momentum.compute_market_state(
            context.provider,
            context.as_of,
        )
        return market is None or not market.above_sma200

    def risk_off(self, context: StrategyContext) -> bool:
        risk_off_now = self._market_risk_off(context)
        if risk_off_now:
            self._risk_off_latched = True
            self._force_reentry = False
            return True
        if self._risk_off_latched:
            confirmed = adaptive_momentum.market_reentry_confirmed(
                context.provider,
                context.as_of,
                confirmation_days=1,
            )
            if confirmed:
                self._force_reentry = True
                self._risk_off_latched = False
        return False

    def should_rebalance(self, context: StrategyContext) -> bool:
        if self._force_reentry:
            return True
        # Initialize every cadence on the first evaluated session.  The
        # signal still uses the completed session immediately before
        # FULL_START, so this is a causal D-close -> D+1-open entry.  Without
        # this guard, the externally available prior SPY session prevents
        # ``is_month_start`` from seeing its documented first-iteration case;
        # monthly candidates then wait until February and the quarterly
        # candidate until April, creating a cadence-dependent start bias.
        if context.session_index == 0:
            return True
        cadence = self.spec.rebalance_cadence
        if cadence == "monthly":
            return is_month_start(context.as_of, context.today)
        if cadence == "quarterly":
            return (
                is_month_start(context.as_of, context.today)
                and int(context.today[5:7]) in {1, 4, 7, 10}
            )
        if cadence == "weekly":
            previous = datetime.fromisoformat(context.as_of).isocalendar()[:2]
            current = datetime.fromisoformat(context.today).isocalendar()[:2]
            return previous != current
        raise ValueError(f"Unsupported rebalance cadence: {cadence}")

    def build_target(self, context: StrategyContext) -> Mapping[str, float]:
        cache_key = (
            context.provider.cache_identity,
            self.name,
            context.as_of,
            tuple(sorted(context.incumbent_symbols)),
            context.risk_tier,
        )
        cached = self.target_cache.get(cache_key)
        if cached is not None:
            self._force_reentry = False
            return dict(cached)
        target = build_target_portfolio(
            self.spec,
            context.provider,
            self.stock_universe,
            context.as_of,
            sector_lookup=lambda symbol: self.sectors.get(symbol, "Unknown"),
            incumbent_symbols=context.incumbent_symbols,
            risk_tier=context.risk_tier,
            factor_cache=self.factor_cache,
        )
        self._force_reentry = False
        weights = dict(target.weights)
        self.target_cache[cache_key] = weights
        return dict(weights)


def _research_source_hashes() -> dict[str, str]:
    return {
        relative: hashlib.sha256((PROJECT_ROOT / relative).read_bytes()).hexdigest()
        for relative in RESEARCH_SOURCE_PATHS
    }


def _assert_frozen_contract() -> None:
    names = tuple(spec.name for spec in CANDIDATE_SPECS)
    if names != EXPECTED_CANDIDATES:
        raise RuntimeError(
            "candidate manifest differs from the pre-registered epoch: "
            f"expected {EXPECTED_CANDIDATES}, received {names}"
        )
    if not PROTOCOL_PATH.is_file():
        raise RuntimeError(f"missing pre-registration contract: {PROTOCOL_PATH}")
    protocol_sha256 = hashlib.sha256(PROTOCOL_PATH.read_bytes()).hexdigest()
    if protocol_sha256 != PREREGISTRATION_SHA256:
        raise RuntimeError(
            "pre-registration contract differs from the committed frozen epoch: "
            f"expected {PREREGISTRATION_SHA256}, received {protocol_sha256}"
        )


def _portfolio_returns(result: Mapping[str, Any]) -> tuple[list[str], np.ndarray]:
    history = result.get("daily_history")
    if not isinstance(history, list) or not history:
        raise ValueError("backtest result has no daily history")
    dates: list[str] = []
    returns: list[float] = []
    previous = float(result["starting_cash"])
    for row in history:
        date = str(row["date"])
        equity = float(row["equity"])
        if not math.isfinite(equity) or equity <= 0 or previous <= 0:
            raise ValueError("portfolio history contains invalid equity")
        dates.append(date)
        returns.append(equity / previous - 1.0)
        previous = equity
    return dates, np.asarray(returns, dtype=float)


def _asset_open_returns(
    provider: BarProvider,
    symbol: str,
    dates: Sequence[str],
) -> np.ndarray:
    if not dates:
        raise ValueError("benchmark dates must not be empty")
    if any(current <= previous for previous, current in zip(dates, dates[1:])):
        raise ValueError("benchmark dates must be strictly increasing and unique")
    returns = np.zeros(len(dates), dtype=float)
    previous: float | None = None
    for index, date in enumerate(dates):
        bar = provider.bar_at(symbol, date)
        if bar is None:
            raise ValueError(f"{symbol} has no benchmark bar on {date}")
        try:
            current = float(bar["open"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(
                f"{symbol} has an invalid benchmark open on {date}"
            ) from exc
        if not math.isfinite(current) or current <= 0:
            raise ValueError(f"{symbol} has an invalid benchmark open on {date}")
        if previous is not None:
            returns[index] = current / previous - 1.0
        previous = current
    return returns


def _max_drawdown_pct(returns: np.ndarray) -> float:
    levels = np.concatenate(([1.0], np.cumprod(1.0 + returns)))
    peaks = np.maximum.accumulate(levels)
    return float(np.min(levels / peaks - 1.0) * 100.0)


def _cagr_pct(returns: np.ndarray) -> float:
    if returns.size == 0:
        return 0.0
    total = float(np.prod(1.0 + returns))
    if not math.isfinite(total) or total <= 0:
        raise ValueError("return path cannot be annualized")
    return (total ** (252.0 / returns.size) - 1.0) * 100.0


def _return_metrics(
    portfolio: np.ndarray,
    spy: np.ndarray,
    qqq: np.ndarray,
    bil: np.ndarray,
) -> dict[str, Any]:
    if not (
        portfolio.ndim == spy.ndim == qqq.ndim == bil.ndim == 1
        and portfolio.shape == spy.shape == qqq.shape == bil.shape
        and portfolio.size >= 2
    ):
        raise ValueError("metric return series must be aligned one-dimensional arrays")
    if not all(np.all(np.isfinite(values)) for values in (portfolio, spy, qqq, bil)):
        raise ValueError("metric return series must be finite")
    if any(np.any(values <= -1.0) for values in (portfolio, spy, qqq, bil)):
        raise ValueError("metric return series contain an impossible return <= -100%")

    portfolio_cagr = _cagr_pct(portfolio)
    spy_cagr = _cagr_pct(spy)
    qqq_cagr = _cagr_pct(qqq)
    portfolio_excess = portfolio - bil
    market_excess = spy - bil
    active = portfolio - spy
    beta = 0.0
    market_variance = float(np.var(market_excess, ddof=1))
    if market_variance > 0:
        beta = float(np.cov(portfolio_excess, market_excess, ddof=1)[0, 1]) / market_variance
    jensen = float(np.mean(portfolio_excess - beta * market_excess)) * 252.0 * 100.0
    annual_vol = float(np.std(portfolio, ddof=1)) * math.sqrt(252.0) * 100.0
    excess_std = float(np.std(portfolio_excess, ddof=1))
    active_std = float(np.std(active, ddof=1))
    sharpe = (
        float(np.mean(portfolio_excess)) / excess_std * math.sqrt(252.0)
        if excess_std > 0
        else 0.0
    )
    information = (
        float(np.mean(active)) / active_std * math.sqrt(252.0)
        if active_std > 0
        else 0.0
    )
    total_return = (float(np.prod(1.0 + portfolio)) - 1.0) * 100.0
    return {
        "annual_return_pct": round(portfolio_cagr, 4),
        "spy_annual_return_pct": round(spy_cagr, 4),
        "qqq_annual_return_pct": round(qqq_cagr, 4),
        "excess_cagr_pct": round(portfolio_cagr - spy_cagr, 4),
        "jensen_alpha_annual_pct": round(jensen, 4),
        "sharpe_ratio": round(sharpe, 4),
        "information_ratio": round(information, 4),
        "annual_vol_pct": round(annual_vol, 4),
        "beta_to_spy": round(beta, 4),
        "max_drawdown_pct": round(_max_drawdown_pct(portfolio), 4),
        "total_return_pct": round(total_return, 4),
        "n_observations": int(portfolio.size),
    }


def _mask(dates: Sequence[str], start: str, end: str) -> np.ndarray:
    return np.asarray([start <= date <= end for date in dates], dtype=bool)


def _period_metrics(
    dates: Sequence[str],
    portfolio: np.ndarray,
    spy: np.ndarray,
    qqq: np.ndarray,
    bil: np.ndarray,
    *,
    start: str,
    end: str,
) -> dict[str, Any]:
    period = _mask(dates, start, end)
    if int(np.count_nonzero(period)) < 2:
        raise ValueError(f"period {start}..{end} has insufficient observations")
    return _return_metrics(
        portfolio[period],
        spy[period],
        qqq[period],
        bil[period],
    )


def _fold_metrics(
    dates: Sequence[str],
    portfolio: np.ndarray,
    spy: np.ndarray,
    qqq: np.ndarray,
    bil: np.ndarray,
    folds: Sequence[Mapping[str, str]],
) -> dict[str, dict[str, Any]]:
    return {
        fold["name"]: _period_metrics(
            dates,
            portfolio,
            spy,
            qqq,
            bil,
            start=fold["start"],
            end=fold["end"],
        )
        for fold in folds
    }


def _capacity_summary(
    result: Mapping[str, Any],
    provider: BarProvider,
) -> dict[str, Any]:
    participation: list[float] = []
    missing = 0
    violations: list[dict[str, Any]] = []
    for order in result.get("orders", []):
        symbol = str(order["symbol"])
        signal_date = str(order["signal_date"])
        try:
            quantity = int(order["qty"])
            official_open = float(order["open_price"])
        except (KeyError, TypeError, ValueError):
            missing += 1
            continue
        if quantity <= 0 or not math.isfinite(official_open) or official_open <= 0:
            missing += 1
            continue
        bars = provider.bars_up_to(symbol, signal_date, lookback_days=60)
        if bars is None or len(bars) < 60 or not {
            "close",
            "volume",
        }.issubset(bars.columns):
            missing += 1
            continue
        dollar_volume = (
            np.asarray(bars["close"], dtype=float)
            * np.asarray(bars["volume"], dtype=float)
        )
        median = float(np.median(dollar_volume))
        if not math.isfinite(median) or median <= 0:
            missing += 1
            continue
        value = quantity * official_open / median * 100.0
        participation.append(value)
        if value > 1.0 + 1e-12:
            violations.append(
                {
                    "symbol": symbol,
                    "signal_date": signal_date,
                    "fill_date": str(order["fill_date"]),
                    "participation_pct": value,
                }
            )
    values = np.asarray(participation, dtype=float)
    return {
        "model": (
            "shares * official_fill_session_open / "
            "trailing_60_session_median_dollar_volume"
        ),
        "hard_cap_pct": 1.0,
        "observed_order_count": len(participation),
        "orders_without_capacity_measure": missing,
        "maximum_participation_pct": (
            round(float(np.max(values)), 6) if values.size else None
        ),
        "p99_participation_pct": (
            round(float(np.quantile(values, 0.99)), 6) if values.size else None
        ),
        "violation_count": len(violations),
        "violations": violations[:20],
    }


def _execution_period_summary(
    result: Mapping[str, Any],
    *,
    start: str,
    end: str,
    period_metrics: Mapping[str, Any],
) -> dict[str, Any]:
    orders = [
        order
        for order in result.get("orders", [])
        if start <= str(order["fill_date"]) <= end
    ]
    traded = math.fsum(float(order["notional"]) for order in orders)
    years = max(float(period_metrics["n_observations"]) / 252.0, 1.0 / 252.0)
    return {
        "order_count": len(orders),
        "buy_order_count": sum(order["side"] == "buy" for order in orders),
        "sell_order_count": sum(order["side"] == "sell" for order in orders),
        "gross_traded_notional": round(traded, 2),
        "annualized_turnover_vs_starting_cash": round(
            traded / STARTING_CASH / years,
            6,
        ),
    }


def _run_one(
    *,
    name: str,
    cost_bps: float,
    delay_sessions: int,
    provider: TournamentBarProvider,
    stock_universe: tuple[str, ...],
    execution_universe: tuple[str, ...],
    sectors: Mapping[str, str],
    factor_cache: PointInTimeFactorCache,
    target_cache: dict[tuple[object, ...], dict[str, float]],
) -> dict[str, Any]:
    adapter = CandidateStrategyAdapter(
        name=name,
        stock_universe=stock_universe,
        sectors=sectors,
        factor_cache=factor_cache,
        target_cache=target_cache,
    )
    return run_target_strategy(
        adapter,
        TargetBacktestConfig(
            start_date=FULL_START,
            end_date=DATA_CUTOFF,
            universe=execution_universe,
            starting_cash=STARTING_CASH,
            slippage_bps=cost_bps,
            convergence_tolerance_weight=0.005,
            execution_delay_sessions=delay_sessions,
        ),
        provider=provider,
    )


def _compact_run(
    result: Mapping[str, Any],
    provider: TournamentBarProvider,
    benchmarks: Mapping[str, np.ndarray],
    *,
    expected_dates: Sequence[str],
) -> tuple[dict[str, Any], np.ndarray]:
    dates, portfolio = _portfolio_returns(result)
    if tuple(dates) != tuple(expected_dates):
        raise ValueError("candidate daily-history clock differs from benchmark clock")
    spy = benchmarks["SPY"]
    qqq = benchmarks["QQQ"]
    bil = benchmarks["BIL"]
    if not (len(dates) == len(spy) == len(qqq) == len(bil)):
        raise ValueError("candidate and benchmark clocks are not aligned")
    development = _period_metrics(
        dates,
        portfolio,
        spy,
        qqq,
        bil,
        start=DEVELOPMENT_START,
        end=DEVELOPMENT_END,
    )
    reused = _period_metrics(
        dates,
        portfolio,
        spy,
        qqq,
        bil,
        start=REUSED_START,
        end=REUSED_END,
    )
    output = {
        "full": _return_metrics(portfolio, spy, qqq, bil),
        "development": development,
        "reused_temporal": reused,
        "development_folds": _fold_metrics(
            dates,
            portfolio,
            spy,
            qqq,
            bil,
            DEVELOPMENT_FOLDS,
        ),
        "reused_folds": _fold_metrics(
            dates,
            portfolio,
            spy,
            qqq,
            bil,
            REUSED_FOLDS,
        ),
        "execution": {
            "full": result["execution_summary"],
            "development": _execution_period_summary(
                result,
                start=DEVELOPMENT_START,
                end=DEVELOPMENT_END,
                period_metrics=development,
            ),
            "reused_temporal": _execution_period_summary(
                result,
                start=REUSED_START,
                end=REUSED_END,
                period_metrics=reused,
            ),
            "capacity": _capacity_summary(result, provider),
            "pending_target_at_end": result.get("pending_target"),
        },
    }
    return output, portfolio


def _sharpe(excess: np.ndarray) -> float:
    std = float(np.std(excess, ddof=1))
    return float(np.mean(excess) / std * math.sqrt(252.0)) if std > 0 else 0.0


def _statistical_evidence(
    *,
    dates: Sequence[str],
    returns: Mapping[str, np.ndarray],
    spy: np.ndarray,
    bil: np.ndarray,
    summaries: Mapping[str, Mapping[str, Any]],
    n_bootstrap: int,
) -> dict[str, Any]:
    development = _mask(dates, DEVELOPMENT_START, DEVELOPMENT_END)
    reused = _mask(dates, REUSED_START, REUSED_END)
    incumbent = returns[INCUMBENT_NAME]
    challengers = {
        name: values for name, values in returns.items() if name != INCUMBENT_NAME
    }
    trial_sharpes_by_name = {
        name: _sharpe(values[development] - bil[development])
        for name, values in returns.items()
    }
    trial_sharpes = list(trial_sharpes_by_name.values())

    candidates: dict[str, Any] = {}
    for name, values in returns.items():
        if name == INCUMBENT_NAME:
            vs_incumbent_development = None
            vs_incumbent_reused = None
        else:
            vs_incumbent_development = paired_stationary_bootstrap(
                values[development],
                incumbent[development],
                n_bootstrap=n_bootstrap,
                mean_block_length=BOOTSTRAP_BLOCK_LENGTH,
                seed=BOOTSTRAP_SEED,
            )
            vs_incumbent_reused = paired_stationary_bootstrap(
                values[reused],
                incumbent[reused],
                n_bootstrap=n_bootstrap,
                mean_block_length=BOOTSTRAP_BLOCK_LENGTH,
                seed=BOOTSTRAP_SEED,
            )
        candidates[name] = {
            "vs_spy_development": paired_stationary_bootstrap(
                values[development],
                spy[development],
                n_bootstrap=n_bootstrap,
                mean_block_length=BOOTSTRAP_BLOCK_LENGTH,
                seed=BOOTSTRAP_SEED,
            ),
            "vs_spy_reused_temporal": paired_stationary_bootstrap(
                values[reused],
                spy[reused],
                n_bootstrap=n_bootstrap,
                mean_block_length=BOOTSTRAP_BLOCK_LENGTH,
                seed=BOOTSTRAP_SEED,
            ),
            "vs_incumbent_development": vs_incumbent_development,
            "vs_incumbent_reused_temporal": vs_incumbent_reused,
            "development_drawdown_bootstrap": bootstrap_path_max_drawdown(
                values[development],
                n_bootstrap=n_bootstrap,
                mean_block_length=BOOTSTRAP_BLOCK_LENGTH,
                seed=BOOTSTRAP_SEED,
            ),
            "deflated_sharpe": deflated_sharpe_ratio(
                values[development] - bil[development],
                trial_sharpes_annualized=trial_sharpes,
                legacy_trial_floor=LEGACY_TRIAL_FLOOR,
                autocorrelation_lags=AUTOCORRELATION_LAGS,
            ),
            "fold_stability_vs_spy": {
                "development": fold_stability(
                    dates,
                    values,
                    spy,
                    DEVELOPMENT_FOLDS,
                ),
                "reused_temporal": fold_stability(
                    dates,
                    values,
                    spy,
                    REUSED_FOLDS,
                ),
            },
        }

    reality_checks: dict[str, Any] = {}
    for block in BOOTSTRAP_SENSITIVITY_BLOCKS:
        label = str(int(block))
        reality_checks[label] = {
            "vs_spy": white_reality_check(
                {name: values[development] for name, values in returns.items()},
                spy[development],
                n_bootstrap=n_bootstrap,
                mean_block_length=block,
                seed=BOOTSTRAP_SEED,
            ),
            "vs_incumbent": white_reality_check(
                {name: values[development] for name, values in challengers.items()},
                incumbent[development],
                n_bootstrap=n_bootstrap,
                mean_block_length=block,
                seed=BOOTSTRAP_SEED,
            ),
        }

    return {
        "selection_cost_bps": INFERENCE_COST_BPS,
        "bootstrap_replications": n_bootstrap,
        "bootstrap_seed": BOOTSTRAP_SEED,
        "primary_mean_block_length": BOOTSTRAP_BLOCK_LENGTH,
        "sensitivity_mean_block_lengths": list(BOOTSTRAP_SENSITIVITY_BLOCKS),
        "legacy_trial_floor": LEGACY_TRIAL_FLOOR,
        "observed_trial_sharpes_annualized": trial_sharpes_by_name,
        "candidates": candidates,
        "white_reality_checks": reality_checks,
        "summary_source": "25_bps_selection_cost_d_plus_1",
        "candidate_summary_names": sorted(summaries),
    }


def _gate_decisions(
    *,
    cost_summaries: Mapping[str, Mapping[str, Mapping[str, Any]]],
    delay_summaries_25: Mapping[str, Mapping[str, Any]],
    reversal_summary_30: Mapping[str, Any] | None,
    statistics: Mapping[str, Any],
) -> dict[str, Any]:
    summaries_15 = cost_summaries[f"{PRIMARY_COST_BPS:g}"]
    summaries_25 = cost_summaries[f"{INFERENCE_COST_BPS:g}"]
    summaries_50 = cost_summaries["50"]
    evidence = statistics["candidates"]
    reality = statistics["white_reality_checks"]["21"]
    incumbent_folds = {
        **summaries_25[INCUMBENT_NAME]["development_folds"],
        **summaries_25[INCUMBENT_NAME]["reused_folds"],
    }
    incumbent_q95_dd = evidence[INCUMBENT_NAME][
        "development_drawdown_bootstrap"
    ]["q95_max_drawdown_loss_pct"]
    incumbent_q05 = evidence[INCUMBENT_NAME]["vs_spy_development"][
        "annualized_mean_active_difference_pct"
    ]["q05"]
    incumbent_robust_score = incumbent_q05 / max(incumbent_q95_dd, 1e-12)

    decisions: dict[str, Any] = {}
    eligible: list[str] = []
    for name in EXPECTED_CANDIDATES:
        if name == INCUMBENT_NAME:
            decisions[name] = {
                "eligible_challenger": False,
                "reasons": ["incumbent control is the comparison baseline"],
                "robust_score": incumbent_robust_score,
            }
            continue
        summary = summaries_25[name]
        stats = evidence[name]
        reasons: list[str] = []
        for period in ("development", "reused_temporal"):
            metrics = summary[period]
            if metrics["excess_cagr_pct"] <= 0:
                reasons.append(f"{period}: excess CAGR is not positive at 25 bps")
            if metrics["jensen_alpha_annual_pct"] <= 0:
                reasons.append(f"{period}: Jensen alpha is not positive at 25 bps")

        development_positive = sum(
            fold["excess_cagr_pct"] > 0
            for fold in summary["development_folds"].values()
        )
        reused_positive = sum(
            fold["excess_cagr_pct"] > 0
            for fold in summary["reused_folds"].values()
        )
        if development_positive < 4:
            reasons.append("fewer than 4/6 development folds beat SPY")
        if reused_positive < 2:
            reasons.append("fewer than 2/3 reused folds beat SPY")

        candidate_folds = {
            **summary["development_folds"],
            **summary["reused_folds"],
        }
        for fold_name, metrics in candidate_folds.items():
            if (
                metrics["max_drawdown_pct"]
                < incumbent_folds[fold_name]["max_drawdown_pct"] - 2.0
            ):
                reasons.append(f"{fold_name}: drawdown is >2 pp worse than V11")

        bootstrap_paths = (
            ("development vs SPY", stats["vs_spy_development"]),
            ("reused vs SPY", stats["vs_spy_reused_temporal"]),
            ("development vs V11", stats["vs_incumbent_development"]),
            ("reused vs V11", stats["vs_incumbent_reused_temporal"]),
        )
        for label, bootstrap in bootstrap_paths:
            if bootstrap["annualized_mean_active_difference_pct"]["q05"] <= 0:
                reasons.append(f"{label}: paired bootstrap q05 is not positive")

        if reality["vs_spy"]["p_value"] > 0.05:
            reasons.append("White Reality Check vs SPY does not reject at 5%")
        if reality["vs_incumbent"]["p_value"] > 0.05:
            reasons.append("White Reality Check vs V11 does not reject at 5%")
        if name != reality["vs_spy"]["best_candidate"]:
            reasons.append("candidate is not the family-best result vs SPY")
        if name != reality["vs_incumbent"]["best_candidate"]:
            reasons.append("candidate is not the family-best result vs V11")
        dsr = stats["deflated_sharpe"][
            "probability_sharpe_gt_expected_maximum"
        ]
        if dsr < 0.95:
            reasons.append("autocorrelation-adjusted Deflated Sharpe is below 0.95")

        for period in ("development", "reused_temporal"):
            if summaries_50[name][period]["excess_cagr_pct"] <= 0:
                reasons.append(f"{period}: not positive vs SPY at 50 bps")
            if delay_summaries_25[name][period]["excess_cagr_pct"] <= 0:
                reasons.append(f"{period}: not positive vs SPY under D+2 delay")

        capacity_runs = [
            (f"{cost_label} bps D+1", by_candidate[name])
            for cost_label, by_candidate in cost_summaries.items()
        ]
        capacity_runs.append(("25 bps D+2", delay_summaries_25[name]))
        if name == "short_term_reversal_negative_control":
            if reversal_summary_30 is None:
                reasons.append("30 bps reversal capacity run is missing")
            else:
                capacity_runs.append(("30 bps D+1", reversal_summary_30))
        for run_label, run_summary in capacity_runs:
            capacity = run_summary["execution"]["capacity"]
            if capacity["violation_count"]:
                reasons.append(
                    f"{run_label}: one or more orders exceed the 1% ADV cap"
                )
            if capacity["orders_without_capacity_measure"]:
                reasons.append(
                    f"{run_label}: one or more orders lack a capacity measurement"
                )

        q05 = stats["vs_spy_development"][
            "annualized_mean_active_difference_pct"
        ]["q05"]
        q95_dd = stats["development_drawdown_bootstrap"][
            "q95_max_drawdown_loss_pct"
        ]
        robust_score = q05 / max(q95_dd, 1e-12)
        required_score = incumbent_robust_score + 0.10 * abs(incumbent_robust_score)
        if robust_score < required_score:
            reasons.append("robust score is not at least 10% better than V11")
        if stats["vs_incumbent_development"]["probability_gt_zero"] < 0.95:
            reasons.append("development probability of improvement vs V11 is below 95%")
        if stats["vs_incumbent_reused_temporal"]["probability_gt_zero"] < 0.95:
            reasons.append("reused probability of improvement vs V11 is below 95%")

        decisions[name] = {
            "eligible_challenger": not reasons,
            "reasons": reasons,
            "development_positive_spy_folds": development_positive,
            "reused_positive_spy_folds": reused_positive,
            "robust_score": robust_score,
            "robust_score_improvement_vs_v11_pct": (
                (robust_score - incumbent_robust_score)
                / max(abs(incumbent_robust_score), 1e-12)
                * 100.0
            ),
        }
        if not reasons:
            eligible.append(name)

    maximum_return = max(
        EXPECTED_CANDIDATES,
        key=lambda name: summaries_15[name]["development"]["annual_return_pct"],
    )
    minimum_risk = min(
        EXPECTED_CANDIDATES,
        key=lambda name: evidence[name]["development_drawdown_bootstrap"][
            "q95_max_drawdown_loss_pct"
        ],
    )
    balanced = max(
        EXPECTED_CANDIDATES,
        key=lambda name: decisions[name]["robust_score"],
    )
    selected = (
        max(eligible, key=lambda name: decisions[name]["robust_score"])
        if eligible
        else None
    )
    return {
        "descriptive_leaders": {
            "maximum_return": maximum_return,
            "minimum_bootstrap_drawdown": minimum_risk,
            "balanced_robust_score": balanced,
        },
        "descriptive_leader_basis": {
            "maximum_return": "development CAGR at primary 15 bps/fill",
            "minimum_bootstrap_drawdown": (
                "development q95 bootstrap drawdown at selection 25 bps/fill"
            ),
            "balanced_robust_score": (
                "development robust score at selection 25 bps/fill"
            ),
        },
        "candidate_gate_decisions": decisions,
        "statistically_eligible_challengers": eligible,
        "shadow_challenger": selected,
        "decision": "SHADOW_CHALLENGER" if selected else "RETAIN_V11",
        "production_changed": False,
        "forward_paper_required": True,
    }


def _warnings() -> list[dict[str, str]]:
    return [
        {
            "code": "NO_FRESH_OOS",
            "message": (
                "2025-2026 is reused temporal evidence; only a future frozen "
                "paper interval can be genuinely unseen."
            ),
        },
        {
            "code": "CURRENT_UNIVERSE_SURVIVORSHIP_BIAS",
            "message": (
                "The 540-name 2026 fallback universe is replayed historically "
                "without point-in-time membership or delisting returns."
            ),
        },
        {
            "code": "SHORT_HISTORY",
            "message": (
                "The effective test spans 2022 through mid-2026 and contains "
                "too few independent market regimes for a production claim."
            ),
        },
        {
            "code": "FIXED_SLIPPAGE_MODEL",
            "message": (
                "Costs are deterministic per-fill stress assumptions, not a "
                "symbol/time-specific opening-auction impact model."
            ),
        },
        {
            "code": "SINGLE_FACTOR_ALPHA",
            "message": (
                "Jensen alpha is SPY/BIL CAPM alpha and does not remove size, "
                "sector, or momentum factor exposure."
            ),
        },
        {
            "code": "NO_GUARANTEE",
            "message": "Historical performance cannot guarantee future returns or alpha.",
        },
    ]


def run_tournament(
    *,
    candidate_names: Sequence[str] | None = None,
    costs_bps: Sequence[float] | None = None,
    n_bootstrap: int = BOOTSTRAP_REPLICATIONS,
) -> dict[str, Any]:
    _assert_frozen_contract()
    selected_names = (
        EXPECTED_CANDIDATES if candidate_names is None else tuple(candidate_names)
    )
    if not selected_names:
        raise ValueError("at least one candidate is required")
    if any(not isinstance(name, str) or not name for name in selected_names):
        raise ValueError("candidate names must be non-empty strings")
    unknown = sorted(set(selected_names) - set(EXPECTED_CANDIDATES))
    if unknown:
        raise ValueError(f"unknown candidates: {', '.join(unknown)}")
    if len(selected_names) != len(set(selected_names)):
        raise ValueError("candidate names must be unique")
    selected_costs = tuple(
        float(value)
        for value in (STANDARD_COSTS_BPS if costs_bps is None else costs_bps)
    )
    if not selected_costs:
        raise ValueError("at least one cost assumption is required")
    if len(selected_costs) != len(set(selected_costs)):
        raise ValueError("cost assumptions must be unique")
    if any(not math.isfinite(value) or value < 0 for value in selected_costs):
        raise ValueError("costs must be finite and nonnegative")
    if type(n_bootstrap) is not int or n_bootstrap <= 0:
        raise ValueError("n_bootstrap must be a positive integer")

    provider = TournamentBarProvider()
    available = set(provider.available_symbols())
    stock_universe = tuple(
        symbol
        for symbol in sorted(set(load_universe_symbols(held_symbols=[])))
        if symbol in available
    )
    if len(stock_universe) != 540 or hash_symbol_universe(stock_universe) != (
        "c86dc489c62625cd380dae6c105e28ee3dbe9aa124363b4dcd1a9f932bafa074"
    ):
        raise RuntimeError("local ranking universe differs from the frozen contract")
    auxiliaries = tuple(sorted({"SPY", "QQQ", "BIL", *SECTOR_ETFS}))
    execution_universe = tuple(sorted(set(stock_universe) | set(auxiliaries)))
    sectors = _sector_map(stock_universe)
    factor_cache = PointInTimeFactorCache()
    target_cache: dict[tuple[object, ...], dict[str, float]] = {}

    calendar = provider.all_trading_days("SPY", start=FULL_START, end=DATA_CUTOFF)
    if not calendar:
        raise RuntimeError("frozen SPY calendar is unavailable")
    benchmarks = {
        symbol: _asset_open_returns(provider, symbol, calendar)
        for symbol in ("SPY", "QQQ", "BIL")
    }

    costs_report: dict[str, dict[str, Any]] = {}
    returns_by_cost: dict[float, dict[str, np.ndarray]] = {}
    for cost in selected_costs:
        label = f"{cost:g}"
        costs_report[label] = {}
        returns_by_cost[cost] = {}
        for name in selected_names:
            print(
                f"=== {name} | {cost:g} bps/fill | D+1 ===",
                flush=True,
            )
            result = _run_one(
                name=name,
                cost_bps=cost,
                delay_sessions=1,
                provider=provider,
                stock_universe=stock_universe,
                execution_universe=execution_universe,
                sectors=sectors,
                factor_cache=factor_cache,
                target_cache=target_cache,
            )
            compact, daily_returns = _compact_run(
                result,
                provider,
                benchmarks,
                expected_dates=calendar,
            )
            costs_report[label][name] = compact
            returns_by_cost[cost][name] = daily_returns

    reversal_extra: dict[str, Any] | None = None
    reversal_name = "short_term_reversal_negative_control"
    if reversal_name in selected_names:
        print(
            f"=== {reversal_name} | {REVERSAL_EXTRA_COST_BPS:g} bps/fill | D+1 ===",
            flush=True,
        )
        result = _run_one(
            name=reversal_name,
            cost_bps=REVERSAL_EXTRA_COST_BPS,
            delay_sessions=1,
            provider=provider,
            stock_universe=stock_universe,
            execution_universe=execution_universe,
            sectors=sectors,
            factor_cache=factor_cache,
            target_cache=target_cache,
        )
        reversal_extra, _ = _compact_run(
            result,
            provider,
            benchmarks,
            expected_dates=calendar,
        )

    delay_report: dict[str, Any] = {}
    if INFERENCE_COST_BPS in selected_costs:
        for name in selected_names:
            print(
                f"=== {name} | {INFERENCE_COST_BPS:g} bps/fill | D+2 stress ===",
                flush=True,
            )
            result = _run_one(
                name=name,
                cost_bps=INFERENCE_COST_BPS,
                delay_sessions=2,
                provider=provider,
                stock_universe=stock_universe,
                execution_universe=execution_universe,
                sectors=sectors,
                factor_cache=factor_cache,
                target_cache=target_cache,
            )
            compact, _ = _compact_run(
                result,
                provider,
                benchmarks,
                expected_dates=calendar,
            )
            delay_report[name] = compact

    is_complete = (
        selected_names == EXPECTED_CANDIDATES
        and selected_costs == STANDARD_COSTS_BPS
        and n_bootstrap == BOOTSTRAP_REPLICATIONS
        and set(delay_report) == set(EXPECTED_CANDIDATES)
        and reversal_extra is not None
    )
    statistics: dict[str, Any] | None = None
    selection: dict[str, Any] = {
        "decision": "INCOMPLETE_DIAGNOSTIC",
        "production_changed": False,
    }
    if (
        INFERENCE_COST_BPS in returns_by_cost
        and set(returns_by_cost[INFERENCE_COST_BPS]) == set(EXPECTED_CANDIDATES)
    ):
        statistics = _statistical_evidence(
            dates=calendar,
            returns=returns_by_cost[INFERENCE_COST_BPS],
            spy=benchmarks["SPY"],
            bil=benchmarks["BIL"],
            summaries=costs_report[f"{INFERENCE_COST_BPS:g}"],
            n_bootstrap=n_bootstrap,
        )
        if is_complete:
            selection = _gate_decisions(
                cost_summaries=costs_report,
                delay_summaries_25=delay_report,
                reversal_summary_30=reversal_extra,
                statistics=statistics,
            )

    data_identity = build_bar_snapshot_identity(
        provider,
        stock_universe,
        auxiliaries,
        through_date=DATA_CUTOFF,
    )
    return {
        "schema_version": 1,
        "kind": "strategy_tournament_epoch_1",
        "status": "COMPLETE" if is_complete else "INCOMPLETE_DIAGNOSTIC",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "research_only": True,
        "production_changed": False,
        "protocol": {
            "path": str(PROTOCOL_PATH.relative_to(PROJECT_ROOT)),
            "preregistration_commit": PREREGISTRATION_COMMIT,
            "sha256": hashlib.sha256(PROTOCOL_PATH.read_bytes()).hexdigest(),
        },
        "research_code_sha256": _research_source_hashes(),
        "runtime": {
            "python": platform.python_version(),
            "numpy": np.__version__,
            "pandas": pd.__version__,
        },
        "data": {
            **data_identity,
            "physical_cutoff": DATA_CUTOFF,
            "ranking_universe": list(stock_universe),
            "auxiliary_symbols": list(auxiliaries),
            "available_sector_etfs": [
                symbol for symbol in SECTOR_ETFS if symbol in available
            ],
            "missing_sector_etfs": [
                symbol for symbol in SECTOR_ETFS if symbol not in available
            ],
        },
        "periods": {
            "full": {"start": FULL_START, "end": DATA_CUTOFF},
            "development": {
                "start": DEVELOPMENT_START,
                "end": DEVELOPMENT_END,
                "folds": list(DEVELOPMENT_FOLDS),
            },
            "reused_temporal": {
                "start": REUSED_START,
                "end": REUSED_END,
                "folds": list(REUSED_FOLDS),
            },
        },
        "execution_contract": {
            "starting_cash": STARTING_CASH,
            "primary_cost_bps": PRIMARY_COST_BPS,
            "inference_cost_bps": INFERENCE_COST_BPS,
            "standard_costs_bps": list(STANDARD_COSTS_BPS),
            "reversal_extra_cost_bps": REVERSAL_EXTRA_COST_BPS,
            "primary_signal_to_fill_delay_sessions": 1,
            "stress_signal_to_fill_delay_sessions": 2,
            "sell_before_buy": True,
            "cash_return": 0.0,
            "risk_free_proxy": "BIL",
            "benchmark": "SPY",
            "secondary_benchmark": "QQQ",
        },
        "candidate_manifest": list(candidate_manifest()),
        "evaluated_candidates": list(selected_names),
        "cost_results": costs_report,
        "reversal_30_bps": reversal_extra,
        "delay_stress_25_bps": delay_report,
        "statistics": statistics,
        "selection": selection,
        "factor_cache": {
            "hits": factor_cache.hits,
            "misses": factor_cache.misses,
        },
        "target_weight_cache_entries": len(target_cache),
        "warnings": _warnings(),
    }


def _fmt(value: Any) -> str:
    return "—" if value is None else f"{float(value):.2f}"


def render_markdown(report: Mapping[str, Any]) -> str:
    costs = report["cost_results"]
    primary = costs.get(f"{PRIMARY_COST_BPS:g}", {})
    inference = costs.get(f"{INFERENCE_COST_BPS:g}", {})
    stress = costs.get("50", {})
    decisions = report.get("selection", {}).get("candidate_gate_decisions", {})
    lines = [
        "# Strategy tournament — epoch 1 results",
        "",
        f"Status: **{report['status']}**  ",
        f"Decision: **{report['selection']['decision']}**  ",
        "Production changed: **no**",
        "",
        "The later 2025–2026 interval is reused, not fresh out-of-sample data. "
        "The current-universe stock history has survivorship/hindsight bias; "
        "therefore no row below is a promise of future alpha.",
        "",
        "| Candidate | Dev CAGR @15 | Dev excess @15 | Dev Sharpe @15 | Dev DD @15 | Reused excess @15 | Dev excess @25 | Dev excess @50 | Gate |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for name in report["evaluated_candidates"]:
        p = primary.get(name, {})
        i = inference.get(name, {})
        s = stress.get(name, {})
        p_dev = p.get("development", {})
        p_reused = p.get("reused_temporal", {})
        i_dev = i.get("development", {})
        s_dev = s.get("development", {})
        gate = decisions.get(name, {})
        if not gate:
            gate_label = "NOT EVALUATED"
        elif name == INCUMBENT_NAME:
            gate_label = "BASELINE"
        else:
            gate_label = "PASS" if gate.get("eligible_challenger") else "FAIL"
        lines.append(
            "| "
            + " | ".join(
                (
                    name,
                    _fmt(p_dev.get("annual_return_pct")),
                    _fmt(p_dev.get("excess_cagr_pct")),
                    _fmt(p_dev.get("sharpe_ratio")),
                    _fmt(p_dev.get("max_drawdown_pct")),
                    _fmt(p_reused.get("excess_cagr_pct")),
                    _fmt(i_dev.get("excess_cagr_pct")),
                    _fmt(s_dev.get("excess_cagr_pct")),
                    gate_label,
                )
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "## Fixed selection",
            "",
            "```json",
            json.dumps(report["selection"], indent=2, sort_keys=True),
            "```",
            "",
            "Full metrics, folds, cost/delay stress, capacity checks, paired "
            "bootstrap, White Reality Check, and Deflated Sharpe evidence are "
            "stored in `state/backtest/strategy_tournament_epoch_1.json`.",
            "",
        ]
    )
    return "\n".join(lines)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run pre-registered research-only strategy tournament epoch 1"
    )
    parser.add_argument(
        "--candidates",
        nargs="+",
        choices=list(EXPECTED_CANDIDATES),
        help="subset for diagnostics; a subset can never produce COMPLETE status",
    )
    parser.add_argument(
        "--costs",
        nargs="+",
        type=float,
        help="cost subset for diagnostics; default is frozen 7/15/25/50",
    )
    parser.add_argument(
        "--bootstrap-replications",
        type=int,
        default=BOOTSTRAP_REPLICATIONS,
    )
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--markdown-output", type=Path, default=MARKDOWN_OUTPUT_PATH)
    parser.add_argument("--no-write", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    report = run_tournament(
        candidate_names=args.candidates,
        costs_bps=args.costs,
        n_bootstrap=args.bootstrap_replications,
    )
    if not args.no_write:
        save_json(args.output, report)
        args.markdown_output.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_output.write_text(render_markdown(report), encoding="utf-8")
        print(f"Saved JSON: {args.output}")
        print(f"Saved Markdown: {args.markdown_output}")
    print(json.dumps(report["selection"], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
