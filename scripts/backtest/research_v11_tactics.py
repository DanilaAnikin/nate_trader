"""Development-only, predeclared V11 tactic comparison.

This research command deliberately has no temporal-check option.  It evaluates
the tactic families frozen in ``strategy/v11_tactic_selection.md`` on the
2022-2024 development segment at 15 bps/fill and records three distinct
Pareto-style winners: maximum return, minimum risk, and balanced.

The output is research evidence only.  It never changes production parameters,
the canonical validation artifact, or paper-trading authorization.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
import sys
from typing import Any

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import adaptive_momentum  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.engine import BacktestConfig, run_backtest  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402
from strategy_identity import build_strategy_identity, hash_symbol_universe  # noqa: E402
from universe import load_universe_symbols  # noqa: E402
from utils import PROJECT_ROOT, save_json  # noqa: E402


OUTPUT_PATH = PROJECT_ROOT / "state" / "backtest" / "v11_tactics_development.json"
DEVELOPMENT_START = "2022-01-04"
DEVELOPMENT_END = "2024-12-31"
STARTING_CASH = 1_000_000.0
SLIPPAGE_BPS = 15.0
BASELINE_WORST_YEAR_EXCESS = -12.1605
FROZEN_BASELINE_OVERRIDES = {
    # The research baseline predates promotion of the winning breadth tactic.
    # Keep the comparison reproducible after production defaults move on.
    "momentum_use_breadth_scaling": False,
}

YEAR_SEGMENTS = {
    "2022": ("2022-01-04", "2022-12-30"),
    "2023": ("2023-01-03", "2023-12-29"),
    "2024": ("2024-01-02", "2024-12-31"),
}

SUMMARY_METRICS = (
    "annual_return_pct",
    "spy_annual_return_pct",
    "excess_cagr_pct",
    "jensen_alpha_annual_pct",
    "sharpe_ratio",
    "max_drawdown_pct",
    "annual_vol_pct",
    "beta_to_spy",
    "information_ratio",
    "n_trades",
    "total_return_pct",
)


@dataclass(frozen=True)
class TacticSpec:
    name: str
    description: str
    params: dict[str, Any]
    ranking_mode: str = "canonical"


TACTICS = (
    TacticSpec("baseline", "Frozen pre-promotion V11 policy", {}),
    TacticSpec(
        "market_vol_10",
        "Scale gross exposure toward 10% SPY annual volatility",
        {
            "momentum_use_market_volatility_scaling": True,
            "momentum_target_market_vol_pct": 10.0,
        },
    ),
    TacticSpec(
        "market_vol_12",
        "Scale gross exposure toward 12% SPY annual volatility",
        {
            "momentum_use_market_volatility_scaling": True,
            "momentum_target_market_vol_pct": 12.0,
        },
    ),
    TacticSpec(
        "breadth_scaled",
        "Scale gross exposure by eligible-stock breadth",
        {"momentum_use_breadth_scaling": True},
    ),
    TacticSpec(
        "market_vol_12_breadth",
        "Combine 12% market-volatility and breadth scaling",
        {
            "momentum_use_market_volatility_scaling": True,
            "momentum_target_market_vol_pct": 12.0,
            "momentum_use_breadth_scaling": True,
        },
    ),
    TacticSpec(
        "stock_vol_cap_50",
        "Reject stocks above 50% annualized 63-session volatility",
        {"momentum_max_annual_vol_pct": 50.0},
    ),
    TacticSpec(
        "stock_vol_cap_60",
        "Reject stocks above 60% annualized 63-session volatility",
        {"momentum_max_annual_vol_pct": 60.0},
    ),
    TacticSpec(
        "inverse_volatility",
        "Allocate selected names by constrained inverse volatility",
        {"momentum_weighting_scheme": "inverse_volatility"},
    ),
    TacticSpec(
        "top_12",
        "Hold up to 12 names with a coherent 7.5% name cap",
        {
            "momentum_top_n": 12,
            "max_positions": 12,
            "max_position_pct": 7.5,
        },
    ),
    TacticSpec(
        "hold_rank_12",
        "Retain incumbents while they remain in the top 12",
        {"momentum_hold_rank_n": 12},
    ),
    TacticSpec(
        "hold_rank_15",
        "Retain incumbents while they remain in the top 15",
        {"momentum_hold_rank_n": 15},
    ),
    TacticSpec(
        "sector_cap_18",
        "Reduce the maximum sector allocation to 18%",
        {"momentum_max_sector_pct": 18.0},
    ),
    TacticSpec(
        "positive_6_1",
        "Require positive 6-1 momentum in addition to 12-1",
        {},
        ranking_mode="positive_6_1",
    ),
    TacticSpec(
        "composite_12_1_6_1",
        "Rank by the equal sum of 12-1 and 6-1 cross-sectional ranks",
        {},
        ranking_mode="composite_12_1_6_1",
    ),
    TacticSpec(
        "beat_spy_12_1",
        "Require each stock's 12-1 return to exceed SPY's 12-1 return",
        {},
        ranking_mode="beat_spy_12_1",
    ),
)


class _ResearchBarProvider(BarProvider):
    """Exact BarProvider semantics with an indexed day-bar lookup.

    The engine prices the whole broad universe every session. Pandas row
    selection dominates a many-tactic sweep, so research runs materialize the
    same five scalar fields once per symbol and then perform ordinary mapping
    lookups. Signal slicing continues through the unmodified causal provider
    methods.
    """

    def __init__(self) -> None:
        super().__init__()
        self._development_truncated: set[str] = set()

    def load(self, symbol: str):
        """Physically exclude every row beyond the frozen development end."""

        frame = super().load(symbol)
        if symbol not in self._development_truncated:
            if frame is not None:
                frame = frame.loc[frame.index <= DEVELOPMENT_END].copy()
                self._cache[symbol] = frame
            self._development_truncated.add(symbol)
        return frame
def _summary(metrics: dict[str, Any]) -> dict[str, Any]:
    return {field: metrics.get(field) for field in SUMMARY_METRICS}


def _tactic_overrides(tactic: TacticSpec) -> dict[str, dict[str, Any]]:
    return {"*": {**FROZEN_BASELINE_OVERRIDES, **tactic.params}}


def _with_stock_volatility_cap(
    scan: adaptive_momentum.UniverseScan,
    cap_pct: float,
) -> adaptive_momentum.UniverseScan:
    """Reapply the one threshold that changes signal eligibility in this sweep."""

    canonical_reason_order = (
        "price",
        "liquidity",
        "volatility",
        "sector",
        "trend",
        "absolute_momentum",
    )
    transformed: list[adaptive_momentum.CandidateSignal] = []
    for signal in scan.signals:
        existing = set(signal.rejection_reasons) - {"volatility"}
        if signal.annual_volatility_pct > cap_pct:
            existing.add("volatility")
        reasons = tuple(
            reason for reason in canonical_reason_order if reason in existing
        ) + tuple(
            reason
            for reason in signal.rejection_reasons
            if reason not in canonical_reason_order
        )
        transformed.append(
            replace(
                signal,
                eligible=not reasons,
                rejection_reasons=reasons,
            )
        )
    ranked = tuple(
        sorted(
            (signal for signal in transformed if signal.eligible),
            key=lambda signal: (
                -signal.momentum_12_1_pct,
                -signal.momentum_6_1_pct,
                signal.symbol,
            ),
        )
    )
    return replace(scan, signals=tuple(transformed), ranked=ranked)


def _spy_12_1_return(provider: Any, as_of: str) -> float | None:
    bars = provider.bars_up_to("SPY", as_of, lookback_days=258)
    if bars is None or "close" not in bars.columns:
        return None
    return adaptive_momentum._period_return_pct(  # noqa: SLF001
        bars["close"],
        252,
        21,
    )


def _rerank(
    scan: adaptive_momentum.UniverseScan,
    *,
    mode: str,
    provider: Any,
    as_of: str,
) -> adaptive_momentum.UniverseScan:
    ranked = list(scan.ranked)
    if mode == "canonical":
        return scan
    if mode == "positive_6_1":
        ranked = [signal for signal in ranked if signal.momentum_6_1_pct > 0.0]
    elif mode == "composite_12_1_6_1":
        long_order = sorted(
            ranked,
            key=lambda signal: (-signal.momentum_12_1_pct, signal.symbol),
        )
        medium_order = sorted(
            ranked,
            key=lambda signal: (-signal.momentum_6_1_pct, signal.symbol),
        )
        long_rank = {signal.symbol: rank for rank, signal in enumerate(long_order)}
        medium_rank = {
            signal.symbol: rank for rank, signal in enumerate(medium_order)
        }
        ranked.sort(
            key=lambda signal: (
                long_rank[signal.symbol] + medium_rank[signal.symbol],
                long_rank[signal.symbol],
                signal.symbol,
            )
        )
    elif mode == "beat_spy_12_1":
        spy_return = _spy_12_1_return(provider, as_of)
        ranked = (
            []
            if spy_return is None
            else [
                signal
                for signal in ranked
                if signal.momentum_12_1_pct > spy_return
            ]
        )
    else:
        raise ValueError(f"Unsupported ranking mode: {mode}")
    return replace(scan, ranked=tuple(ranked))


@contextmanager
def _ranking_policy(mode: str) -> Iterator[None]:
    original = adaptive_momentum.scan_universe

    if mode == "canonical":
        yield
        return

    def transformed(provider, candidates, as_of, **kwargs):
        scan = original(provider, candidates, as_of, **kwargs)
        return _rerank(scan, mode=mode, provider=provider, as_of=as_of)

    adaptive_momentum.scan_universe = transformed
    try:
        yield
    finally:
        adaptive_momentum.scan_universe = original


@contextmanager
def _shared_scan_cache() -> Iterator[dict[str, int]]:
    """Reuse identical point-in-time universe scans within one research run.

    Aggregate and standalone-year simulations request the same month-end
    signals repeatedly.  The cached object contains only the causal scan for
    an exact provider, date, candidate set, and immutable signal config;
    portfolio construction, incumbent hold bands, weights, fills, and metrics
    are still recomputed independently for every tactic and segment.
    """

    original = adaptive_momentum.scan_universe
    cache: dict[tuple[Any, ...], adaptive_momentum.UniverseScan] = {}
    stats = {"hits": 0, "misses": 0}

    def cached(provider, candidates, as_of, **kwargs):
        config = kwargs.get("config") or adaptive_momentum.AdaptiveMomentumConfig()
        signal_config = (
            config.lookback_days,
            config.skip_recent_days,
            config.medium_lookback_days,
            config.trend_days,
            config.volatility_days,
            config.liquidity_days,
            config.min_price_usd,
            config.min_median_dollar_volume_usd,
            config.require_sector_classification,
            config.excluded_symbols,
        )
        key = (
            id(provider),
            str(as_of),
            tuple(sorted({str(symbol).upper().strip() for symbol in candidates if symbol})),
            signal_config,
        )
        if key in cache:
            stats["hits"] += 1
            scan = cache[key]
        else:
            stats["misses"] += 1
            scan = original(provider, key[2], as_of, **kwargs)
            cache[key] = scan
        return _with_stock_volatility_cap(
            scan,
            config.max_annual_volatility_pct,
        )

    adaptive_momentum.scan_universe = cached
    try:
        yield stats
    finally:
        adaptive_momentum.scan_universe = original


def _run_segment(
    provider: BarProvider,
    universe: list[str],
    tactic: TacticSpec,
    *,
    start_date: str,
    end_date: str,
) -> dict[str, Any]:
    config = BacktestConfig(
        start_date=start_date,
        end_date=end_date,
        starting_cash=STARTING_CASH,
        universe=universe,
        slippage_bps=SLIPPAGE_BPS,
        param_overrides=_tactic_overrides(tactic),
    )
    with _ranking_policy(tactic.ranking_mode):
        result = run_backtest(config, provider=provider)
    return _summary(compute_metrics(result, provider))


def _worst_year_excess(candidate: dict[str, Any]) -> float | None:
    years = candidate.get("years")
    if not isinstance(years, dict) or set(years) != set(YEAR_SEGMENTS):
        return None
    values = [years[year].get("excess_cagr_pct") for year in YEAR_SEGMENTS]
    if any(not isinstance(value, (int, float)) for value in values):
        return None
    return min(float(value) for value in values)


def _eligibility(candidate: dict[str, Any], profile: str) -> list[str]:
    metrics = candidate["development"]
    cagr = float(metrics["annual_return_pct"])
    excess = float(metrics["excess_cagr_pct"])
    jensen = float(metrics["jensen_alpha_annual_pct"])
    sharpe = float(metrics["sharpe_ratio"])
    drawdown = float(metrics["max_drawdown_pct"])
    trades = int(metrics["n_trades"])
    worst_year = _worst_year_excess(candidate)
    reasons: list[str] = []
    if excess <= 0 or jensen <= 0:
        reasons.append("aggregate alpha is not strictly positive")
    if worst_year is None:
        reasons.append("standalone calendar-year evidence is incomplete")
        return reasons

    if profile == "maximum_return":
        if drawdown < -22.2379:
            reasons.append("maximum drawdown is below -22.2379%")
        if trades > 333:
            reasons.append("trade count exceeds 333")
        if worst_year < BASELINE_WORST_YEAR_EXCESS - 2.0:
            reasons.append("worst-year excess trails baseline by more than 2 pp")
    elif profile == "minimum_risk":
        if excess < 2.0:
            reasons.append("excess CAGR is below +2 pp")
        if cagr < float(metrics["spy_annual_return_pct"]) + 2.0:
            reasons.append("CAGR is less than 2 pp above SPY")
        if sharpe < 0.75:
            reasons.append("Sharpe is below 0.75")
    elif profile == "balanced":
        if cagr < 15.0786:
            reasons.append("CAGR is more than 0.50 pp below baseline")
        if drawdown < -20.2379:
            reasons.append("maximum drawdown is worse than baseline")
        if worst_year < BASELINE_WORST_YEAR_EXCESS - 1.0:
            reasons.append("worst-year excess trails baseline by more than 1 pp")
        if trades > 277:
            reasons.append("trade count exceeds 277")
        baseline = {
            "annual_return_pct": 15.5786,
            "jensen_alpha_annual_pct": 9.2239,
            "sharpe_ratio": 0.8981,
            "max_drawdown_pct": -20.2379,
        }
        tolerances = {
            "annual_return_pct": 0.50,
            "jensen_alpha_annual_pct": 0.50,
            "sharpe_ratio": 0.03,
            "max_drawdown_pct": 1.00,
        }
        for field, baseline_value in baseline.items():
            if float(metrics[field]) < baseline_value - tolerances[field]:
                reasons.append(f"{field} exceeds its degradation tolerance")
        improvements = sum(
            (
                cagr > baseline["annual_return_pct"],
                jensen > baseline["jensen_alpha_annual_pct"],
                sharpe > baseline["sharpe_ratio"],
                drawdown > baseline["max_drawdown_pct"],
            )
        )
        if candidate["name"] != "baseline" and improvements < 2:
            reasons.append("candidate improves fewer than two balanced metrics")
    else:
        raise ValueError(f"Unknown profile: {profile}")
    return reasons


def select_winners(candidates: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Apply the frozen profile rules without inventing a blended score."""

    profiles = {
        "maximum_return": lambda item: (
            float(item["development"]["annual_return_pct"]),
            float(item["development"]["sharpe_ratio"]),
        ),
        "minimum_risk": lambda item: (
            float(item["development"]["max_drawdown_pct"]),
            float(item["development"]["sharpe_ratio"]),
        ),
        "balanced": lambda item: (
            float(item["development"]["sharpe_ratio"]),
            float(item["development"]["annual_return_pct"]),
            -int(item["development"]["n_trades"]),
        ),
    }
    output: dict[str, Any] = {}
    for profile, key in profiles.items():
        decisions = {
            candidate["name"]: _eligibility(candidate, profile)
            for candidate in candidates
        }
        eligible = [
            candidate
            for candidate in candidates
            if not decisions[candidate["name"]]
        ]
        winner = max(eligible, key=key) if eligible else None
        output[profile] = {
            "winner": winner["name"] if winner else None,
            "eligible": [candidate["name"] for candidate in eligible],
            "rejections": {
                name: reasons for name, reasons in decisions.items() if reasons
            },
        }
    return output


def _pareto_front(candidates: Sequence[dict[str, Any]]) -> list[str]:
    fields = (
        "annual_return_pct",
        "jensen_alpha_annual_pct",
        "sharpe_ratio",
        "max_drawdown_pct",
    )
    front: list[str] = []
    for candidate in candidates:
        metrics = candidate["development"]
        dominated = False
        for challenger in candidates:
            if challenger is candidate:
                continue
            other = challenger["development"]
            no_worse = all(float(other[field]) >= float(metrics[field]) for field in fields)
            strictly_better = any(
                float(other[field]) > float(metrics[field]) for field in fields
            )
            if no_worse and strictly_better:
                dominated = True
                break
        if not dominated:
            front.append(candidate["name"])
    return sorted(front)


def run_research(tactic_names: Sequence[str] | None = None) -> dict[str, Any]:
    requested = set(tactic_names or [tactic.name for tactic in TACTICS])
    unknown = sorted(requested - {tactic.name for tactic in TACTICS})
    if unknown:
        raise ValueError(f"Unknown tactic names: {', '.join(unknown)}")

    provider = _ResearchBarProvider()
    universe = sorted(set(load_universe_symbols(held_symbols=[])))
    candidates: list[dict[str, Any]] = []
    with _shared_scan_cache() as scan_cache_stats:
        for tactic in TACTICS:
            if tactic.name not in requested:
                continue
            print(f"\n=== {tactic.name}: development ===", flush=True)
            development = _run_segment(
                provider,
                universe,
                tactic,
                start_date=DEVELOPMENT_START,
                end_date=DEVELOPMENT_END,
            )
            years: dict[str, Any] = {}
            for year, (start_date, end_date) in YEAR_SEGMENTS.items():
                print(f"=== {tactic.name}: {year} ===", flush=True)
                years[year] = _run_segment(
                    provider,
                    universe,
                    tactic,
                    start_date=start_date,
                    end_date=end_date,
                )
            candidates.append(
                {
                    **asdict(tactic),
                    "development": development,
                    "years": years,
                    "worst_year_excess_cagr_pct": min(
                        float(metrics["excess_cagr_pct"])
                        for metrics in years.values()
                    ),
                }
            )

    winners = select_winners(candidates)
    return {
        "schema_version": 1,
        "kind": "v11_development_only_tactic_research",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "selection_contract": "strategy/v11_tactic_selection.md",
        "development_period": {
            "start_date": DEVELOPMENT_START,
            "end_date": DEVELOPMENT_END,
        },
        "calendar_year_segments": {
            year: {"start_date": bounds[0], "end_date": bounds[1]}
            for year, bounds in YEAR_SEGMENTS.items()
        },
        "starting_cash": STARTING_CASH,
        "slippage_bps": SLIPPAGE_BPS,
        "frozen_baseline_overrides": FROZEN_BASELINE_OVERRIDES,
        "strategy_identity": build_strategy_identity(),
        "ranking_universe_count": len(universe),
        "ranking_universe_sha256": hash_symbol_universe(universe),
        "data_boundary": {
            "provider_max_date": DEVELOPMENT_END,
            "post_development_rows_excluded_before_simulation": True,
        },
        "scan_cache": scan_cache_stats,
        "warnings": [
            "DEVELOPMENT_ONLY_SELECTION",
            "NO_FRESH_OOS",
            "CURRENT_UNIVERSE_SURVIVORSHIP_BIAS",
            "START_BOUNDARY_WARMUP_SENSITIVITY",
            "NO_GUARANTEE",
        ],
        "candidates": candidates,
        "pareto_front": _pareto_front(candidates),
        "winners": winners,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the frozen 2022-2024 V11 tactic comparison"
    )
    parser.add_argument(
        "--tactics",
        nargs="+",
        choices=[tactic.name for tactic in TACTICS],
        help="optional subset; omitted means every predeclared tactic",
    )
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH)
    parser.add_argument("--no-write", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    report = run_research(args.tactics)
    if not args.no_write:
        save_json(args.output, report)
        print(f"\nSaved development-only leaderboard to {args.output}")
    for profile, result in report["winners"].items():
        print(f"{profile}: {result['winner']}")
    print(f"pareto_front: {', '.join(report['pareto_front'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
