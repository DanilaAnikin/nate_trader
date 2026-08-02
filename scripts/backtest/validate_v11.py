"""Honest, fixed-parameter validation for the v11 strategy.

This command deliberately does *not* optimize parameters.  It re-runs the
same checked-in strategy over a development period and a later temporal check
under one or more execution-cost assumptions.  The temporal check is labelled
as reused rather than fresh out-of-sample data because the repository's
historical results have already inspected it.

Only local cached bars and the local universe snapshot/fallback are read.  A
report is written atomically to ``state/backtest/v11_validation.json`` only by
the CLI entry point::

    python3 scripts/backtest/validate_v11.py
    python3 scripts/backtest/validate_v11.py --slippage-bps 7 15 25
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import sys
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from backtest.data_provider import BarProvider  # noqa: E402
from universe import (  # noqa: E402
    MIN_UNIVERSE_SYMBOL_COUNT,
    UNIVERSE_STATE,
    load_universe_symbols,
    valid_cached_universe_symbols,
)
from utils import PROJECT_ROOT, load_json, save_json  # noqa: E402
from adaptive_momentum import SECTOR_BENCHMARKS  # noqa: E402
from strategy_identity import (  # noqa: E402
    build_bar_snapshot_identity,
    build_strategy_identity,
    hash_symbol_universe,
)


RESULT_PATH = PROJECT_ROOT / "state" / "backtest" / "v11_validation.json"
DEFAULT_SLIPPAGE_BPS = (7.0, 15.0)
REFERENCE_SYMBOL = "SPY"
PREFERRED_DEVELOPMENT_END = "2024-12-31"
REQUIRED_WARMUP_SESSIONS = 253
REQUIRED_AUXILIARY_SYMBOLS = tuple(
    sorted({"BIL", REFERENCE_SYMBOL, *SECTOR_BENCHMARKS.values()})
)

DEVELOPMENT_LABEL = "DEVELOPMENT / model-building period"
TEMPORAL_CHECK_LABEL = "REUSED TEMPORAL CHECK / not fresh OOS"

REQUIRED_ALPHA_METRICS = (
    "excess_cagr_pct",
    "jensen_alpha_annual_pct",
)
PASS_ALLOWED_MODE = "paper-validation-eligible"
FAIL_ALLOWED_MODE = "dry-run/shadow-research-only"
VALIDATION_MAX_AGE_DAYS = 35
PROMOTION_PROFILE_SCHEMA_VERSION = 1
PROMOTION_PROFILE_NAME = "v11-canonical-local-history-v1"
CANONICAL_STARTING_CASH = 1_000_000.0
MIN_DEVELOPMENT_SESSIONS = 504
MIN_TEMPORAL_CHECK_SESSIONS = 252
# Promotion is intentionally reserved for a genuinely broad cross-sectional
# ranking set.  A syntactically valid but partial discovery/cache must not be
# able to turn a handful of names into the validated production universe.
MIN_RANKING_UNIVERSE_SYMBOLS = MIN_UNIVERSE_SYMBOL_COUNT
RESULT_STRATEGY_VERSION = "v11-adaptive-momentum"
RESULT_SIGNAL_TIMING = "prior-close-to-next-open"
REQUIRED_WARNING_CODES = frozenset(
    {"NOT_FRESH_OOS", "CURRENT_UNIVERSE_SURVIVORSHIP_BIAS", "NO_GUARANTEE"}
)


@dataclass(frozen=True)
class ValidationPeriods:
    """Resolved trading-session boundaries for the two validation segments."""

    development_start: str
    development_end: str
    temporal_check_start: str
    temporal_check_end: str

    def as_dict(self) -> dict[str, dict[str, str]]:
        return {
            "development": {
                "label": DEVELOPMENT_LABEL,
                "start_date": self.development_start,
                "end_date": self.development_end,
            },
            "temporal_check": {
                "label": TEMPORAL_CHECK_LABEL,
                "start_date": self.temporal_check_start,
                "end_date": self.temporal_check_end,
            },
        }


def build_period_payload(
    provider: BarProvider,
    periods: ValidationPeriods,
) -> dict[str, dict[str, str | int]]:
    """Serialize canonical bounds together with observed SPY session counts."""

    payload: dict[str, dict[str, str | int]] = periods.as_dict()
    for key, start_date, end_date in (
        (
            "development",
            periods.development_start,
            periods.development_end,
        ),
        (
            "temporal_check",
            periods.temporal_check_start,
            periods.temporal_check_end,
        ),
    ):
        payload[key]["sessions"] = len(
            provider.all_trading_days(
                REFERENCE_SYMBOL,
                start=start_date,
                end=end_date,
            )
        )
    return payload


def build_promotion_profile(
    *,
    custom_period_requested: bool,
    starting_cash: float,
    scenarios: Sequence[float],
    custom_components_requested: bool = False,
) -> dict[str, Any]:
    """Describe whether this invocation is the one promotable experiment."""

    canonical_capital = math.isclose(
        float(starting_cash),
        CANONICAL_STARTING_CASH,
        rel_tol=0.0,
        abs_tol=1e-9,
    )
    canonical_costs = tuple(float(value) for value in scenarios) == tuple(
        DEFAULT_SLIPPAGE_BPS
    )
    return {
        "schema_version": PROMOTION_PROFILE_SCHEMA_VERSION,
        "name": PROMOTION_PROFILE_NAME,
        "promotable": bool(
            not custom_period_requested
            and not custom_components_requested
            and canonical_capital
            and canonical_costs
        ),
        "custom_period_requested": bool(custom_period_requested),
        "custom_components_requested": bool(custom_components_requested),
        "starting_cash": float(starting_cash),
        "canonical_starting_cash": CANONICAL_STARTING_CASH,
        "required_slippage_bps": list(DEFAULT_SLIPPAGE_BPS),
        "minimum_segment_sessions": {
            "development": MIN_DEVELOPMENT_SESSIONS,
            "temporal_check": MIN_TEMPORAL_CHECK_SESSIONS,
        },
        "parameter_overrides": None,
    }


def _first_on_or_after(days: Sequence[str], date: str) -> str | None:
    return next((day for day in days if day >= date), None)


def _last_on_or_before(days: Sequence[str], date: str) -> str | None:
    return next((day for day in reversed(days) if day <= date), None)


def resolve_periods(
    provider: BarProvider,
    *,
    start: str | None = None,
    development_end: str | None = None,
    temporal_check_start: str | None = None,
    end: str | None = None,
) -> ValidationPeriods:
    """Map requested calendar dates to actual locally available SPY sessions.

    Defaults use 2024-12-31 as the conceptual development boundary when the
    cache spans that date.  For shorter/synthetic caches a deterministic 70/30
    chronological split is used.  At least one trading session is required in
    each segment.
    """

    all_days = provider.all_trading_days(REFERENCE_SYMBOL)
    if len(all_days) < 2:
        raise ValueError("At least two cached SPY trading sessions are required")

    # The 12-1 signal needs 253 completed sessions.  When the local cache is
    # long enough, begin after that warm-up instead of reporting a misleading
    # first year in which the strategy was mechanically unable to trade.
    # Tiny/synthetic caches fall back to their first day and surface the
    # deficiency in ``bar_coverage``.
    default_start = (
        all_days[REQUIRED_WARMUP_SESSIONS]
        if len(all_days) > REQUIRED_WARMUP_SESSIONS + 1
        else all_days[0]
    )
    resolved_start = _first_on_or_after(all_days, start or default_start)
    resolved_end = _last_on_or_before(all_days, end or all_days[-1])
    if resolved_start is None or resolved_end is None or resolved_start >= resolved_end:
        raise ValueError("Requested range does not contain two cached SPY sessions")

    range_days = [day for day in all_days if resolved_start <= day <= resolved_end]
    if len(range_days) < 2:
        raise ValueError("Requested range does not contain two cached SPY sessions")

    if development_end is not None:
        resolved_development_end = _last_on_or_before(range_days, development_end)
        if resolved_development_end is None:
            raise ValueError("Development end precedes the first available session")
    else:
        preferred = _last_on_or_before(range_days, PREFERRED_DEVELOPMENT_END)
        has_later_session = preferred is not None and preferred < range_days[-1]
        if has_later_session:
            resolved_development_end = preferred
        else:
            # The index is the last development observation.  Clamp it so the
            # later check always receives at least one session.
            split_index = min(len(range_days) - 2, max(0, int(len(range_days) * 0.70) - 1))
            resolved_development_end = range_days[split_index]

    if temporal_check_start is not None:
        resolved_temporal_start = _first_on_or_after(range_days, temporal_check_start)
    else:
        resolved_temporal_start = next(
            (day for day in range_days if day > resolved_development_end),
            None,
        )

    if resolved_temporal_start is None:
        raise ValueError("Temporal-check start is after the last available session")
    if resolved_temporal_start <= resolved_development_end:
        raise ValueError("Temporal check must start after the development period")

    return ValidationPeriods(
        development_start=resolved_start,
        development_end=resolved_development_end,
        temporal_check_start=resolved_temporal_start,
        temporal_check_end=resolved_end,
    )


def normalize_slippage_scenarios(values: Iterable[float]) -> tuple[float, ...]:
    """Validate cost scenarios and remove duplicates without reordering."""

    scenarios: list[float] = []
    for raw in values:
        value = float(raw)
        if not math.isfinite(value) or value < 0:
            raise ValueError("Slippage values must be finite and non-negative")
        if value not in scenarios:
            scenarios.append(value)
    if not scenarios:
        raise ValueError("At least one slippage scenario is required")
    return tuple(scenarios)


def _universe_source() -> str:
    payload = load_json(UNIVERSE_STATE)
    if valid_cached_universe_symbols(payload):
        return "state/universe.json current snapshot"
    return "watchlist.json local fallback"


_COVERAGE_LIST_FIELDS = (
    "missing_symbols",
    "partial_coverage_symbols",
    "symbols_starting_after_validation_start",
    "symbols_missing_validation_end",
    "missing_required_auxiliary_symbols",
    "partial_required_auxiliary_symbols",
    "symbols_without_required_warmup",
    "invalid_bar_symbols",
    "auxiliary_session_gap_symbols",
)
_COVERAGE_COUNT_FIELDS = (
    "reference_sessions",
    "required_warmup_sessions",
    "requested_symbol_count_including_spy",
    "symbols_with_cached_bars",
    "symbols_with_full_range_coverage",
)


def bar_coverage_schema_errors(coverage: Any) -> list[str]:
    """Return strict schema failures; absent fields never mean success."""

    if not isinstance(coverage, dict):
        return ["bar coverage must be an object"]
    errors: list[str] = []
    if coverage.get("reference_symbol") != REFERENCE_SYMBOL:
        errors.append("bar coverage reference_symbol must be SPY")
    if coverage.get("required_auxiliary_symbols") != list(
        REQUIRED_AUXILIARY_SYMBOLS
    ):
        errors.append("bar coverage required auxiliary set is inconsistent")
    if coverage.get("required_warmup_sessions") != REQUIRED_WARMUP_SESSIONS:
        errors.append("bar coverage warm-up requirement is inconsistent")
    if not isinstance(coverage.get("universe_source"), str) or not coverage.get(
        "universe_source"
    ):
        errors.append("bar coverage universe_source is missing")
    for field in ("reference_start", "reference_end", "validation_start", "validation_end"):
        value = coverage.get(field)
        if not isinstance(value, str) or not value:
            errors.append(f"bar coverage {field} is missing")
    for field in _COVERAGE_LIST_FIELDS:
        value = coverage.get(field)
        if not isinstance(value, list) or any(
            not isinstance(symbol, str) or not symbol for symbol in value
        ):
            errors.append(f"bar coverage {field} must be a symbol list")
        elif value != sorted(set(value)):
            errors.append(f"bar coverage {field} must be sorted and unique")
    for field in _COVERAGE_COUNT_FIELDS:
        value = coverage.get(field)
        if type(value) is not int or value < 0:
            errors.append(f"bar coverage {field} must be a non-negative integer")
    full_pct = coverage.get("full_range_coverage_pct")
    if (
        not isinstance(full_pct, (int, float))
        or isinstance(full_pct, bool)
        or not math.isfinite(float(full_pct))
        or not 0.0 <= float(full_pct) <= 100.0
    ):
        errors.append("bar coverage full_range_coverage_pct is invalid")
    requested = coverage.get("requested_symbol_count_including_spy")
    cached = coverage.get("symbols_with_cached_bars")
    full = coverage.get("symbols_with_full_range_coverage")
    if all(type(value) is int for value in (requested, cached, full)):
        if not 0 <= full <= cached <= requested:
            errors.append("bar coverage counts are inconsistent")
        expected_pct = round(full / requested * 100.0, 2) if requested else 0.0
        if isinstance(full_pct, (int, float)) and not math.isclose(
            float(full_pct), expected_pct, rel_tol=0.0, abs_tol=0.01
        ):
            errors.append("bar coverage percentage is inconsistent with counts")
    if all(
        isinstance(coverage.get(field), str)
        for field in ("reference_start", "reference_end", "validation_start", "validation_end")
    ):
        if coverage["reference_start"] > coverage["validation_start"]:
            errors.append("bar coverage starts after the validation window")
        if coverage["validation_start"] > coverage["validation_end"]:
            errors.append("bar coverage validation window is reversed")
        if coverage["validation_end"] > coverage["reference_end"]:
            errors.append("bar coverage ends after the reference data")
    return errors


def _bar_frame_quality_errors(frame: pd.DataFrame, *, end_date: str) -> list[str]:
    """Validate the cached adjusted OHLCV prefix used by promotion."""

    errors: list[str] = []
    required_columns = ("open", "high", "low", "close", "volume")
    if frame.index.has_duplicates:
        errors.append("duplicate session dates")
    if not frame.index.is_monotonic_increasing:
        errors.append("unsorted session dates")
    try:
        parsed_dates = pd.to_datetime(frame.index, format="%Y-%m-%d", errors="raise")
        if any(
            str(original) != parsed.strftime("%Y-%m-%d")
            for original, parsed in zip(frame.index, parsed_dates, strict=True)
        ):
            errors.append("non-canonical session date")
    except (TypeError, ValueError):
        errors.append("invalid session date")
    if any(column not in frame.columns for column in required_columns):
        return ["missing OHLCV columns"]
    sliced = frame.loc[frame.index <= end_date, list(required_columns)]
    if sliced.empty:
        return ["no rows through validation end"]
    numeric = sliced.apply(pd.to_numeric, errors="coerce")
    finite = numeric.map(lambda value: math.isfinite(float(value)))
    if not bool(finite.to_numpy().all()):
        errors.append("non-finite OHLCV values")
    prices = numeric[["open", "high", "low", "close"]]
    if not bool((prices > 0).to_numpy().all()):
        errors.append("non-positive price")
    if not bool((numeric["volume"] >= 0).all()):
        errors.append("negative volume")
    if not bool(
        (
            (numeric["high"] >= prices[["open", "low", "close"]].max(axis=1))
            & (numeric["low"] <= prices[["open", "high", "close"]].min(axis=1))
        ).all()
    ):
        errors.append("inconsistent OHLC range")
    return errors


def build_bar_coverage(
    provider: BarProvider,
    universe: Sequence[str],
    *,
    start_date: str,
    end_date: str,
) -> dict[str, Any]:
    """Describe local-data coverage without fetching or mutating anything."""

    reference_days = provider.all_trading_days(REFERENCE_SYMBOL)
    available = set(provider.available_symbols())
    requested = sorted(set(universe) | set(REQUIRED_AUXILIARY_SYMBOLS))
    missing = [symbol for symbol in requested if symbol not in available]
    full_coverage: list[str] = []
    partial_coverage: list[str] = []
    insufficient_warmup: list[str] = []
    missing_validation_end: list[str] = []
    starting_after_validation_start: list[str] = []
    invalid_bar_symbols: list[str] = []
    auxiliary_session_gap_symbols: list[str] = []

    for symbol in requested:
        if symbol not in available:
            continue
        bars = provider.load(symbol)
        if bars is None or bars.empty:
            missing.append(symbol)
            continue
        if _bar_frame_quality_errors(bars, end_date=end_date):
            invalid_bar_symbols.append(symbol)
        symbol_start = str(bars.index[0])
        if symbol_start > start_date:
            starting_after_validation_start.append(symbol)
        if end_date not in bars.index:
            missing_validation_end.append(symbol)
        warmup_sessions = int((bars.index < start_date).sum())
        if warmup_sessions < REQUIRED_WARMUP_SESSIONS:
            insufficient_warmup.append(symbol)
        if symbol_start <= start_date and end_date in bars.index:
            full_coverage.append(symbol)
        else:
            partial_coverage.append(symbol)

    reference_validation_days = {
        day for day in reference_days if start_date <= day <= end_date
    }
    for symbol in REQUIRED_AUXILIARY_SYMBOLS:
        if symbol not in available:
            continue
        bars = provider.load(symbol)
        if bars is None or bars.empty:
            continue
        observed = {
            str(day) for day in bars.index if start_date <= str(day) <= end_date
        }
        if observed != reference_validation_days:
            auxiliary_session_gap_symbols.append(symbol)

    missing = sorted(set(missing))
    missing_auxiliary = sorted(set(missing) & set(REQUIRED_AUXILIARY_SYMBOLS))
    partial_auxiliary = sorted(
        set(partial_coverage) & set(REQUIRED_AUXILIARY_SYMBOLS)
    )
    cached_count = len(requested) - len(missing)
    full_ratio = len(full_coverage) / len(requested) * 100.0 if requested else 0.0
    return {
        "reference_symbol": REFERENCE_SYMBOL,
        "reference_start": reference_days[0] if reference_days else None,
        "reference_end": reference_days[-1] if reference_days else None,
        "reference_sessions": len(reference_days),
        "validation_start": start_date,
        "validation_end": end_date,
        "required_warmup_sessions": REQUIRED_WARMUP_SESSIONS,
        "required_auxiliary_symbols": list(REQUIRED_AUXILIARY_SYMBOLS),
        "universe_source": _universe_source(),
        "requested_symbol_count_including_spy": len(requested),
        "symbols_with_cached_bars": cached_count,
        "symbols_with_full_range_coverage": len(full_coverage),
        "full_range_coverage_pct": round(full_ratio, 2),
        "missing_symbols": missing,
        "partial_coverage_symbols": partial_coverage,
        "symbols_starting_after_validation_start": starting_after_validation_start,
        "symbols_missing_validation_end": missing_validation_end,
        "missing_required_auxiliary_symbols": missing_auxiliary,
        "partial_required_auxiliary_symbols": partial_auxiliary,
        "symbols_without_required_warmup": insufficient_warmup,
        "invalid_bar_symbols": sorted(invalid_bar_symbols),
        "auxiliary_session_gap_symbols": sorted(
            auxiliary_session_gap_symbols
        ),
    }


def build_evidence_identity(
    provider: BarProvider,
    universe: Sequence[str],
    *,
    through_date: str,
) -> dict[str, Any]:
    """Fingerprint the exact universe and adjusted bars used by validation."""

    return build_bar_snapshot_identity(
        provider,
        universe,
        REQUIRED_AUXILIARY_SYMBOLS,
        through_date=through_date,
    )


def _base_warnings(coverage: dict[str, Any]) -> list[dict[str, str]]:
    warnings = [
        {
            "code": "NOT_FRESH_OOS",
            "message": (
                "The later segment is a reused temporal check, not fresh OOS; "
                "its dates have already been inspected during development."
            ),
        },
        {
            "code": "CURRENT_UNIVERSE_SURVIVORSHIP_BIAS",
            "message": (
                "Historical runs use today's locally resolved symbols, creating "
                "current-universe survivorship bias rather than point-in-time membership."
            ),
        },
        {
            "code": "NO_GUARANTEE",
            "message": (
                "Historical returns or positive alpha provide no guarantee of future "
                "performance; paper/shadow validation is required before deployment."
            ),
        },
    ]
    if coverage["missing_symbols"]:
        warnings.append(
            {
                "code": "MISSING_BAR_FILES",
                "message": (
                    f"{len(coverage['missing_symbols'])} resolved symbols have no local "
                    "bar file and cannot participate in the validation."
                ),
            }
        )
    if coverage["partial_coverage_symbols"]:
        warnings.append(
            {
                "code": "PARTIAL_BAR_COVERAGE",
                "message": (
                    f"{len(coverage['partial_coverage_symbols'])} symbols do not cover "
                    "the full requested range; eligibility therefore changes with data availability."
                ),
            }
        )
    if coverage["symbols_without_required_warmup"]:
        warnings.append(
            {
                "code": "INSUFFICIENT_SIGNAL_WARMUP",
                "message": (
                    f"{len(coverage['symbols_without_required_warmup'])} symbols lack "
                    f"the {coverage['required_warmup_sessions']}-session pre-start "
                    "history required by the 12-1 signal and may enter the universe late."
                ),
            }
        )
    return warnings


def _default_config_factory(**kwargs: Any) -> Any:
    # Deferred import keeps report helpers lightweight and makes importing this
    # module incapable of invoking broker/data clients.
    from backtest.engine import BacktestConfig

    return BacktestConfig(**kwargs)


def _default_runner(
    config: Any,
    *,
    provider: BarProvider | None = None,
) -> dict[str, Any]:
    from backtest.engine import run_backtest

    return run_backtest(config, provider=provider)


def _default_metrics(result: dict[str, Any], provider: BarProvider) -> dict[str, Any]:
    from backtest.metrics import compute_metrics

    return compute_metrics(result, provider)


def _segment_summary(
    result: dict[str, Any], metrics: dict[str, Any], *, label: str
) -> dict[str, Any]:
    return {
        "label": label,
        "config": result.get("config", {}),
        "starting_cash": result.get("starting_cash"),
        "final_equity": result.get("final_equity"),
        "metrics": metrics,
    }


def assess_promotion_gate(scenario_results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Apply the fixed alpha promotion rule to completed validation results.

    Every slippage scenario must report *strictly positive* excess CAGR and
    Jensen alpha in both the development and reused temporal-check segments.
    Missing, boolean, non-numeric, zero, and non-finite values all fail closed.
    This is an assessment only; it never changes parameters or chooses a best
    scenario.
    """

    checks: list[dict[str, Any]] = []
    required_segments = ("development", "temporal_check")
    for scenario_index, scenario in enumerate(scenario_results):
        scenario_name = scenario.get("scenario") or f"scenario_{scenario_index + 1}"
        slippage = scenario.get("slippage_bps")
        segments = scenario.get("segments")
        if not isinstance(segments, dict):
            segments = {}
        for segment_name in required_segments:
            segment = segments.get(segment_name)
            metrics = segment.get("metrics") if isinstance(segment, dict) else None
            if not isinstance(metrics, dict):
                metrics = {}
            for metric_name in REQUIRED_ALPHA_METRICS:
                raw_value = metrics.get(metric_name)
                is_number = (
                    isinstance(raw_value, (int, float))
                    and not isinstance(raw_value, bool)
                    and math.isfinite(float(raw_value))
                )
                value = float(raw_value) if is_number else None
                passed = value is not None and value > 0.0
                check = {
                    "scenario": scenario_name,
                    "slippage_bps": slippage,
                    "segment": segment_name,
                    "metric": metric_name,
                    "operator": ">",
                    "threshold": 0.0,
                    "value": value,
                    "passed": passed,
                }
                if not passed:
                    check["reason"] = (
                        "missing_or_non_finite"
                        if value is None
                        else "not_strictly_positive"
                    )
                checks.append(check)

    failed_checks = [check for check in checks if not check["passed"]]
    status = "PASS" if checks and not failed_checks else "FAIL"
    passed_count = len(checks) - len(failed_checks)
    if status == "PASS":
        allowed_mode = PASS_ALLOWED_MODE
        alpha_claim = (
            "All historical alpha checks passed; this permits paper validation only, "
            "not a claim of guaranteed or fresh-OOS alpha."
        )
    else:
        allowed_mode = FAIL_ALLOWED_MODE
        alpha_claim = (
            "Validated-alpha claims are prohibited; continue only in dry-run/shadow research."
        )
    return {
        "status": status,
        "allowed_mode": allowed_mode,
        "rule": (
            "Every slippage scenario and both segments require excess_cagr_pct > 0 "
            "and jensen_alpha_annual_pct > 0."
        ),
        "checks_evaluated": len(checks),
        "checks_passed": passed_count,
        "checks": checks,
        "failed_checks": failed_checks,
        "alpha_claim": alpha_claim,
    }


def apply_data_integrity_gate(
    assessment: dict[str, Any], coverage: dict[str, Any]
) -> dict[str, Any]:
    """Fail promotion when required benchmark/risk/sector bars are incomplete."""

    schema_errors = bar_coverage_schema_errors(coverage)

    def _symbol_list(field: str) -> list[str]:
        value = coverage.get(field)
        return list(value) if isinstance(value, list) else []

    missing = _symbol_list("missing_symbols")
    stale_at_end = _symbol_list("symbols_missing_validation_end")
    missing_auxiliary = _symbol_list("missing_required_auxiliary_symbols")
    partial_auxiliary = _symbol_list("partial_required_auxiliary_symbols")
    invalid_bars = _symbol_list("invalid_bar_symbols")
    auxiliary_gaps = _symbol_list("auxiliary_session_gap_symbols")
    data_check = {
        "category": "ranking_and_auxiliary_bar_coverage",
        "schema_errors": schema_errors,
        "required_symbols": (
            list(coverage.get("required_auxiliary_symbols"))
            if isinstance(coverage.get("required_auxiliary_symbols"), list)
            else []
        ),
        "missing_symbols": missing,
        "symbols_missing_validation_end": stale_at_end,
        "missing_auxiliary_symbols": missing_auxiliary,
        "partial_auxiliary_symbols": partial_auxiliary,
        "invalid_bar_symbols": invalid_bars,
        "auxiliary_session_gap_symbols": auxiliary_gaps,
        "passed": not (
            schema_errors
            or missing
            or stale_at_end
            or missing_auxiliary
            or partial_auxiliary
            or invalid_bars
            or auxiliary_gaps
        ),
    }
    updated = {
        **assessment,
        "data_integrity_check": data_check,
        "failed_data_checks": [] if data_check["passed"] else [data_check],
    }
    if data_check["passed"]:
        return updated
    updated["status"] = "FAIL"
    updated["allowed_mode"] = FAIL_ALLOWED_MODE
    updated["alpha_claim"] = (
        "Validated-alpha claims are prohibited; ranking or required auxiliary "
        "bars are incomplete."
    )
    return updated


def promotion_profile_errors(
    profile: Any,
    periods: Any,
    scenarios: Sequence[float],
) -> list[str]:
    """Reject every report that is not the one canonical promotion run."""

    expected_profile = build_promotion_profile(
        custom_period_requested=False,
        starting_cash=CANONICAL_STARTING_CASH,
        scenarios=DEFAULT_SLIPPAGE_BPS,
    )
    errors: list[str] = []
    if profile != expected_profile:
        errors.append("promotion profile is not the canonical fixed profile")
    try:
        normalized_scenarios = tuple(float(value) for value in scenarios)
    except (TypeError, ValueError):
        normalized_scenarios = ()
    if normalized_scenarios != tuple(DEFAULT_SLIPPAGE_BPS):
        errors.append("promotion scenarios must be exactly 7bps and 15bps")
    if not isinstance(periods, dict):
        return [*errors, "promotion periods are missing"]
    for segment, minimum in (
        ("development", MIN_DEVELOPMENT_SESSIONS),
        ("temporal_check", MIN_TEMPORAL_CHECK_SESSIONS),
    ):
        payload = periods.get(segment)
        sessions = payload.get("sessions") if isinstance(payload, dict) else None
        if type(sessions) is not int or sessions < minimum:
            errors.append(
                f"{segment} requires at least {minimum} reference sessions"
            )
    return errors


def apply_promotion_profile_gate(
    assessment: dict[str, Any],
    profile: Any,
    periods: Any,
    scenarios: Sequence[float],
) -> dict[str, Any]:
    """Add the canonical-profile gate to an alpha/data assessment."""

    errors = promotion_profile_errors(profile, periods, scenarios)
    profile_check = {
        "category": "canonical_promotion_profile",
        "errors": errors,
        "passed": not errors,
    }
    updated = {
        **assessment,
        "promotion_profile_check": profile_check,
        "failed_promotion_profile_checks": [] if not errors else [profile_check],
    }
    if not errors:
        return updated
    updated["status"] = "FAIL"
    updated["allowed_mode"] = FAIL_ALLOWED_MODE
    updated["alpha_claim"] = (
        "Validated-alpha claims are prohibited; this is not the canonical "
        "fixed promotion experiment."
    )
    return updated


def experiment_result_contract_errors(
    results: Any,
    periods: Any,
    scenarios: Sequence[float],
    coverage: Any,
    evidence: Any,
    *,
    expected_universe: Sequence[str],
) -> list[str]:
    """Bind every recorded metric to one period, capital and universe."""

    errors: list[str] = []
    if not isinstance(periods, dict):
        return ["experiment periods are missing"]
    if not isinstance(coverage, dict):
        errors.append("experiment bar coverage is missing")
    if not isinstance(evidence, dict):
        errors.append("experiment evidence is missing")
        evidence = {}

    normalized_universe = sorted(
        {
            str(symbol).strip().upper()
            for symbol in expected_universe
            if str(symbol).strip()
        }
    )
    expected_universe_count = len(normalized_universe)
    expected_universe_hash = hash_symbol_universe(normalized_universe)
    if expected_universe_count < MIN_RANKING_UNIVERSE_SYMBOLS:
        errors.append(
            "ranking universe is too narrow for broad-universe promotion "
            f"({expected_universe_count} < {MIN_RANKING_UNIVERSE_SYMBOLS})"
        )

    required_evidence_ints = (
        "schema_version",
        "ranking_universe_count",
        "bar_symbols_requested",
        "bar_symbols_observed",
        "bar_rows_hashed",
    )
    for field in required_evidence_ints:
        value = evidence.get(field)
        if type(value) is not int or value < 0:
            errors.append(f"evidence {field} is invalid")
    for field in ("ranking_universe_sha256", "bar_snapshot_sha256"):
        value = evidence.get(field)
        if (
            not isinstance(value, str)
            or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)
        ):
            errors.append(f"evidence {field} is invalid")
    if evidence.get("schema_version") != 1:
        errors.append("evidence schema_version must be 1")
    if evidence.get("ranking_universe_count") != expected_universe_count:
        errors.append("evidence ranking universe count is inconsistent")
    if evidence.get("ranking_universe_sha256") != expected_universe_hash:
        errors.append("evidence ranking universe hash is inconsistent")

    temporal = periods.get("temporal_check")
    development = periods.get("development")
    temporal_end = temporal.get("end_date") if isinstance(temporal, dict) else None
    if evidence.get("bar_snapshot_through_date") != temporal_end:
        errors.append("evidence boundary does not match temporal-check end")
    if isinstance(coverage, dict):
        if coverage.get("validation_start") != (
            development.get("start_date")
            if isinstance(development, dict)
            else None
        ):
            errors.append("coverage start does not match development start")
        if coverage.get("validation_end") != temporal_end:
            errors.append("coverage end does not match temporal-check end")
        if evidence.get("bar_symbols_requested") != coverage.get(
            "requested_symbol_count_including_spy"
        ):
            errors.append("evidence requested-symbol count is inconsistent")
        if evidence.get("bar_symbols_observed") != coverage.get(
            "symbols_with_cached_bars"
        ):
            errors.append("evidence observed-symbol count is inconsistent")

    if not isinstance(results, list) or len(results) != len(scenarios):
        return [*errors, "experiment result count does not match scenarios"]

    segment_contract = {
        "development": (DEVELOPMENT_LABEL, development),
        "temporal_check": (TEMPORAL_CHECK_LABEL, temporal),
    }
    for scenario_index, (scenario, expected_cost) in enumerate(
        zip(results, scenarios, strict=True)
    ):
        if not isinstance(scenario, dict):
            errors.append(f"scenario {scenario_index + 1} is not an object")
            continue
        scenario_name = f"slippage_{float(expected_cost):g}_bps"
        if scenario.get("scenario") != scenario_name:
            errors.append(f"scenario {scenario_index + 1} name is inconsistent")
        if scenario.get("slippage_bps") != float(expected_cost):
            errors.append(f"scenario {scenario_index + 1} cost is inconsistent")
        segments = scenario.get("segments")
        if not isinstance(segments, dict) or set(segments) != set(segment_contract):
            errors.append(f"scenario {scenario_name} segment set is inconsistent")
            continue
        for segment_name, (expected_label, expected_period) in segment_contract.items():
            segment = segments.get(segment_name)
            if not isinstance(segment, dict) or not isinstance(expected_period, dict):
                errors.append(f"{scenario_name}/{segment_name} payload is invalid")
                continue
            if segment.get("label") != expected_label:
                errors.append(f"{scenario_name}/{segment_name} label is inconsistent")
            if segment.get("starting_cash") != CANONICAL_STARTING_CASH:
                errors.append(
                    f"{scenario_name}/{segment_name} starting cash is inconsistent"
                )
            config = segment.get("config")
            if not isinstance(config, dict):
                errors.append(f"{scenario_name}/{segment_name} config is missing")
                continue
            expected_config = {
                "start_date": expected_period.get("start_date"),
                "end_date": expected_period.get("end_date"),
                "starting_cash": CANONICAL_STARTING_CASH,
                "slippage_bps": float(expected_cost),
                "universe_size": expected_universe_count,
                "ranking_universe_sha256": expected_universe_hash,
                "strategy_version": RESULT_STRATEGY_VERSION,
                "signal_timing": RESULT_SIGNAL_TIMING,
            }
            for field, expected_value in expected_config.items():
                if config.get(field) != expected_value:
                    errors.append(
                        f"{scenario_name}/{segment_name} config {field} is inconsistent"
                    )
            if "param_overrides" not in config or config.get("param_overrides") is not None:
                errors.append(
                    f"{scenario_name}/{segment_name} config parameter overrides are invalid"
                )
    return errors


def apply_experiment_integrity_gate(
    assessment: dict[str, Any], errors: Sequence[str]
) -> dict[str, Any]:
    """Fail promotion if result metadata is detached from its experiment."""

    experiment_check = {
        "category": "bound_experiment_results",
        "errors": list(errors),
        "passed": not errors,
    }
    updated = {
        **assessment,
        "experiment_contract_check": experiment_check,
        "failed_experiment_contract_checks": (
            [] if not errors else [experiment_check]
        ),
    }
    if not errors:
        return updated
    updated["status"] = "FAIL"
    updated["allowed_mode"] = FAIL_ALLOWED_MODE
    updated["alpha_claim"] = (
        "Validated-alpha claims are prohibited; recorded metrics are not bound "
        "to the canonical experiment."
    )
    return updated


def compute_report_sha256(report: dict[str, Any]) -> str:
    """Return an unkeyed, tamper-evident digest of the full report payload."""

    payload = {key: value for key, value in report.items() if key != "contract"}
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def attach_report_contract(report: dict[str, Any]) -> dict[str, Any]:
    """Attach the deterministic whole-report digest at the write boundary."""

    sealed = dict(report)
    sealed["contract"] = {
        "schema_version": 1,
        "algorithm": "sha256",
        "report_sha256": compute_report_sha256(sealed),
    }
    return sealed


def validation_report_contract_errors(
    report: Any,
    *,
    now: datetime | None = None,
    provider: BarProvider | None = None,
    universe: Sequence[str] | None = None,
) -> list[str]:
    """Recompute the promotion contract and reject stale/tampered reports.

    The digest is tamper-evident, not a cryptographic signature: it prevents
    accidental/manual field flips from silently authorizing orders.  The
    assessment is also recomputed from the recorded scenarios and coverage so
    a bare ``status=PASS`` object can never satisfy the live gate.
    """

    if not isinstance(report, dict):
        return ["top-level validation report must be an object"]
    errors: list[str] = []
    if report.get("schema_version") != 1:
        errors.append("validation report schema_version must be 1")
    if report.get("kind") != "v11_fixed_strategy_validation":
        errors.append("validation report kind is unsupported")

    contract = report.get("contract")
    if not isinstance(contract, dict):
        errors.append("whole-report contract digest missing")
    elif (
        contract.get("schema_version") != 1
        or contract.get("algorithm") != "sha256"
        or contract.get("report_sha256") != compute_report_sha256(report)
    ):
        errors.append("whole-report contract digest mismatch")

    local_provider = provider or BarProvider()
    resolved_universe = sorted(
        set(
            universe
            if universe is not None
            else load_universe_symbols(held_symbols=[])
        )
    )
    canonical_period_payload: dict[str, Any] | None = None
    canonical_periods: ValidationPeriods | None = None
    try:
        canonical_periods = resolve_periods(local_provider)
        canonical_period_payload = build_period_payload(
            local_provider, canonical_periods
        )
    except (OSError, TypeError, ValueError) as exc:
        errors.append(f"canonical local validation periods unavailable: {exc}")

    periods = report.get("periods")
    if not isinstance(periods, dict):
        errors.append("validation periods missing")
    elif (
        canonical_period_payload is not None
        and periods != canonical_period_payload
    ):
        errors.append("validation periods do not match canonical local history")

    labels = report.get("labels")
    if labels != {
        "development": DEVELOPMENT_LABEL,
        "temporal_check": TEMPORAL_CHECK_LABEL,
    }:
        errors.append("validation segment labels are inconsistent")

    strategy = report.get("strategy")
    if not isinstance(strategy, dict):
        errors.append("validation strategy metadata missing")
    else:
        if strategy.get("version") != RESULT_STRATEGY_VERSION:
            errors.append("validation strategy version is inconsistent")
        if strategy.get("signal_timing") != (
            "prior completed close to next-session open"
        ):
            errors.append("validation strategy timing is inconsistent")
        if strategy.get("parameter_policy") != (
            "fixed checked-in parameters; no optimizer or sweep"
        ):
            errors.append("validation parameter policy is inconsistent")
        recorded_identity = strategy.get("identity")
        try:
            current_identity = build_strategy_identity()
        except (OSError, ValueError) as exc:
            errors.append(f"current strategy identity unavailable: {exc}")
        else:
            if not isinstance(recorded_identity, dict) or (
                recorded_identity.get("value") != current_identity.get("value")
            ):
                errors.append("validation strategy identity is stale")

    scenarios = report.get("slippage_scenarios_bps")
    try:
        normalized_scenarios = normalize_slippage_scenarios(scenarios or [])
    except (TypeError, ValueError):
        normalized_scenarios = ()
        errors.append("slippage scenario contract is invalid")
    if normalized_scenarios != DEFAULT_SLIPPAGE_BPS:
        errors.append("promotion scenarios must be exactly 7bps and 15bps")

    results = report.get("results")
    coverage = report.get("bar_coverage")
    evidence = report.get("evidence")
    profile = report.get("promotion_profile")
    recorded_assessment = report.get("assessment")
    if not isinstance(results, list) or not results:
        errors.append("validation scenarios missing")
    coverage_errors = bar_coverage_schema_errors(coverage)
    errors.extend(coverage_errors)
    if not isinstance(recorded_assessment, dict):
        errors.append("promotion assessment missing")

    if isinstance(coverage, dict) and canonical_periods is not None:
        reference_days = local_provider.all_trading_days(REFERENCE_SYMBOL)
        expected_reference = {
            "reference_start": reference_days[0] if reference_days else None,
            "reference_end": reference_days[-1] if reference_days else None,
            "reference_sessions": len(reference_days),
            "validation_start": canonical_periods.development_start,
            "validation_end": canonical_periods.temporal_check_end,
        }
        for field, expected_value in expected_reference.items():
            if coverage.get(field) != expected_value:
                errors.append(f"bar coverage {field} is not canonical")

    profile_errors = promotion_profile_errors(
        profile,
        periods,
        normalized_scenarios,
    )
    errors.extend(profile_errors)
    experiment_errors = experiment_result_contract_errors(
        results,
        periods,
        normalized_scenarios,
        coverage,
        evidence,
        expected_universe=resolved_universe,
    )
    errors.extend(experiment_errors)

    if isinstance(results, list) and isinstance(recorded_assessment, dict):
        recomputed = apply_data_integrity_gate(
            assess_promotion_gate(results),
            coverage if isinstance(coverage, dict) else {},
        )
        recomputed = apply_promotion_profile_gate(
            recomputed,
            profile,
            periods,
            normalized_scenarios,
        )
        recomputed = apply_experiment_integrity_gate(
            recomputed,
            experiment_errors,
        )
        if recorded_assessment != recomputed:
            errors.append("recorded promotion assessment is inconsistent")

    warnings = report.get("warnings")
    warning_codes = (
        {
            warning.get("code")
            for warning in warnings
            if isinstance(warning, dict)
        }
        if isinstance(warnings, list)
        else set()
    )
    if not REQUIRED_WARNING_CODES.issubset(warning_codes):
        errors.append("required bias/OOS/no-guarantee warnings are missing")

    checked_at = now or datetime.now(timezone.utc)
    if checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=timezone.utc)
    checked_at = checked_at.astimezone(timezone.utc)
    generated_at = report.get("generated_at")
    try:
        generated = datetime.fromisoformat(str(generated_at).replace("Z", "+00:00"))
        if generated.tzinfo is None or generated.utcoffset() != timedelta(0):
            raise ValueError("timestamp must be UTC and timezone-aware")
        age = checked_at - generated.astimezone(timezone.utc)
        if age < -timedelta(minutes=5) or age > timedelta(
            days=VALIDATION_MAX_AGE_DAYS
        ):
            errors.append("validation report is expired or future-dated")
    except (TypeError, ValueError):
        errors.append("validation generation timestamp is invalid")

    through_date = (
        evidence.get("bar_snapshot_through_date")
        if isinstance(evidence, dict)
        else None
    )
    try:
        boundary = datetime.strptime(str(through_date), "%Y-%m-%d").date()
        boundary_age = checked_at.date() - boundary
        if boundary_age.days < 0 or boundary_age.days > VALIDATION_MAX_AGE_DAYS:
            errors.append("validation bar boundary is expired or future-dated")
        if canonical_periods is not None and through_date != (
            canonical_periods.temporal_check_end
        ):
            errors.append("validation bar boundary is not the latest local session")
    except (TypeError, ValueError):
        errors.append("validation bar boundary is invalid")
    return list(dict.fromkeys(errors))


def run_validation(
    *,
    provider: BarProvider | None = None,
    universe: Sequence[str] | None = None,
    start: str | None = None,
    development_end: str | None = None,
    temporal_check_start: str | None = None,
    end: str | None = None,
    starting_cash: float = 1_000_000.0,
    slippage_bps: Iterable[float] = DEFAULT_SLIPPAGE_BPS,
    runner: Callable[[Any], dict[str, Any]] | None = None,
    metrics_fn: Callable[[dict[str, Any], BarProvider], dict[str, Any]] | None = None,
    config_factory: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """Run fixed v11 validation and return an in-memory, serializable report.

    This function performs no writes.  Injectable seams keep tests fast and
    make the fixed parameters auditable: each generated backtest config has
    ``param_overrides=None``.
    """

    if not math.isfinite(starting_cash) or starting_cash <= 0:
        raise ValueError("Starting cash must be finite and positive")

    local_provider = provider or BarProvider()
    resolved_universe = (
        list(universe)
        if universe is not None
        else load_universe_symbols(held_symbols=[])
    )
    resolved_universe = sorted(set(resolved_universe))
    periods = resolve_periods(
        local_provider,
        start=start,
        development_end=development_end,
        temporal_check_start=temporal_check_start,
        end=end,
    )
    scenarios = normalize_slippage_scenarios(slippage_bps)
    period_payload = build_period_payload(local_provider, periods)
    custom_period_requested = any(
        value is not None
        for value in (start, development_end, temporal_check_start, end)
    )
    promotion_profile = build_promotion_profile(
        custom_period_requested=custom_period_requested,
        starting_cash=starting_cash,
        scenarios=scenarios,
        custom_components_requested=any(
            component is not None
            for component in (runner, metrics_fn, config_factory)
        ),
    )
    coverage = build_bar_coverage(
        local_provider,
        resolved_universe,
        start_date=periods.development_start,
        end_date=periods.temporal_check_end,
    )

    # Freeze the experiment identities before the first scenario.  The same
    # cached provider is injected into every default backtest so a long run
    # cannot silently combine different on-disk bar snapshots.
    strategy_identity = build_strategy_identity()
    evidence_identity = build_evidence_identity(
        local_provider,
        resolved_universe,
        through_date=periods.temporal_check_end,
    )

    run_one = (
        runner
        if runner is not None
        else lambda config: _default_runner(config, provider=local_provider)
    )
    calculate_metrics = metrics_fn or _default_metrics
    make_config = config_factory or _default_config_factory
    segment_specs = (
        (
            "development",
            DEVELOPMENT_LABEL,
            periods.development_start,
            periods.development_end,
        ),
        (
            "temporal_check",
            TEMPORAL_CHECK_LABEL,
            periods.temporal_check_start,
            periods.temporal_check_end,
        ),
    )

    scenario_results: list[dict[str, Any]] = []
    for cost_bps in scenarios:
        segments: dict[str, Any] = {}
        for key, label, segment_start, segment_end in segment_specs:
            config = make_config(
                start_date=segment_start,
                end_date=segment_end,
                starting_cash=starting_cash,
                universe=resolved_universe,
                slippage_bps=cost_bps,
                param_overrides=None,
            )
            result = run_one(config)
            metrics = calculate_metrics(result, local_provider)
            segments[key] = _segment_summary(result, metrics, label=label)
        scenario_results.append(
            {
                "scenario": f"slippage_{cost_bps:g}_bps",
                "slippage_bps": cost_bps,
                "segments": segments,
            }
        )

    stability_errors: list[str] = []
    try:
        strategy_identity_after = build_strategy_identity()
    except (OSError, ValueError) as exc:
        stability_errors.append(
            f"strategy source identity unavailable after validation: {exc}"
        )
    else:
        if strategy_identity_after.get("value") != strategy_identity.get("value"):
            stability_errors.append(
                "strategy source identity changed during validation"
            )

    # BarProvider caches frames.  Re-open the directory after the scenarios so
    # an on-disk mutation cannot be hidden by that cache.  Injectable custom
    # providers are already non-promotable and are re-read through their seam.
    post_run_provider = (
        BarProvider(local_provider.bars_dir)
        if isinstance(local_provider, BarProvider)
        else local_provider
    )
    try:
        evidence_identity_after = build_evidence_identity(
            post_run_provider,
            resolved_universe,
            through_date=periods.temporal_check_end,
        )
    except (OSError, TypeError, ValueError) as exc:
        stability_errors.append(
            f"bar snapshot identity unavailable after validation: {exc}"
        )
    else:
        if evidence_identity_after != evidence_identity:
            stability_errors.append("bar snapshot identity changed during validation")

    assessment = apply_data_integrity_gate(
        assess_promotion_gate(scenario_results), coverage
    )
    assessment = apply_promotion_profile_gate(
        assessment,
        promotion_profile,
        period_payload,
        scenarios,
    )
    experiment_errors = experiment_result_contract_errors(
        scenario_results,
        period_payload,
        scenarios,
        coverage,
        evidence_identity,
        expected_universe=resolved_universe,
    )
    experiment_errors.extend(stability_errors)
    assessment = apply_experiment_integrity_gate(
        assessment,
        experiment_errors,
    )
    report = {
        "schema_version": 1,
        "kind": "v11_fixed_strategy_validation",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "strategy": {
            "version": "v11-adaptive-momentum",
            "parameter_policy": "fixed checked-in parameters; no optimizer or sweep",
            "signal_timing": "prior completed close to next-session open",
            "identity": strategy_identity,
        },
        "labels": {
            "development": DEVELOPMENT_LABEL,
            "temporal_check": TEMPORAL_CHECK_LABEL,
        },
        "periods": period_payload,
        "promotion_profile": promotion_profile,
        "slippage_scenarios_bps": list(scenarios),
        "bar_coverage": coverage,
        "evidence": evidence_identity,
        "warnings": _base_warnings(coverage),
        "assessment": assessment,
        "results": scenario_results,
    }
    return attach_report_contract(report)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate fixed v11 parameters on local bars; no optimization and no network access"
        )
    )
    parser.add_argument("--start", default=None, help="first date (clipped to a SPY session)")
    parser.add_argument(
        "--development-end",
        default=None,
        help="last development date; default is 2024-12-31 when available",
    )
    parser.add_argument(
        "--temporal-check-start",
        default=None,
        help="first reused temporal-check date; default is the next SPY session",
    )
    parser.add_argument("--end", default=None, help="last date (clipped to a SPY session)")
    parser.add_argument("--starting-cash", type=float, default=1_000_000.0)
    parser.add_argument(
        "--slippage-bps",
        type=float,
        nargs="+",
        default=list(DEFAULT_SLIPPAGE_BPS),
        metavar="BPS",
        help="one or more non-negative per-fill stress assumptions (default: 7 15)",
    )
    return parser


def _print_summary(report: dict[str, Any]) -> None:
    print("\nV11 FIXED-STRATEGY VALIDATION")
    print("No optimizer; local cached data only.")
    for scenario in report["results"]:
        print(f"\n{scenario['scenario']}")
        for segment in scenario["segments"].values():
            metrics = segment["metrics"]
            print(
                f"  {segment['label']}: "
                f"CAGR={metrics.get('annual_return_pct', 0):+.2f}%  "
                f"excess={metrics.get('excess_cagr_pct', 0):+.2f}%  "
                f"Jensen alpha={metrics.get('jensen_alpha_annual_pct', 0):+.2f}%  "
                f"Sharpe={metrics.get('sharpe_ratio', 0):.2f}  "
                f"max DD={metrics.get('max_drawdown_pct', 0):.2f}%"
            )
    assessment = report["assessment"]
    print(f"\nPROMOTION GATE: {assessment['status']}")
    print(f"Allowed mode: {assessment['allowed_mode']}")
    if assessment["failed_checks"]:
        print("Failed alpha checks:")
        for check in assessment["failed_checks"]:
            value = "missing/non-finite" if check["value"] is None else f"{check['value']:+.4f}%"
            print(
                f"  {check['scenario']} / {check['segment']} / "
                f"{check['metric']}: {value} (required > 0)"
            )
        print("No validated-alpha claim is allowed.")
    if assessment.get("failed_data_checks"):
        check = assessment["failed_data_checks"][0]
        print(
            "Ranking/auxiliary bar coverage failed: "
            f"missing={check['missing_symbols']} "
            f"stale_at_end={check['symbols_missing_validation_end']} "
            f"partial_auxiliary={check['partial_auxiliary_symbols']}"
        )
    if assessment.get("failed_promotion_profile_checks"):
        print("Canonical promotion profile failed:")
        for error in assessment["promotion_profile_check"]["errors"]:
            print(f"  {error}")
    if assessment.get("failed_experiment_contract_checks"):
        print("Experiment binding failed:")
        for error in assessment["experiment_contract_check"]["errors"]:
            print(f"  {error}")
    print(f"\nSaved atomically to {RESULT_PATH}")
    print("Warnings: not fresh OOS; current-universe survivorship bias; no guarantee.")


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        report = run_validation(
            start=args.start,
            development_end=args.development_end,
            temporal_check_start=args.temporal_check_start,
            end=args.end,
            starting_cash=args.starting_cash,
            slippage_bps=args.slippage_bps,
        )
    except ValueError as exc:
        _build_parser().error(str(exc))
    contract_errors = validation_report_contract_errors(report)
    save_json(RESULT_PATH, report)
    _print_summary(report)
    if contract_errors:
        print("\nREPORT CONTRACT: FAIL")
        for error in contract_errors:
            print(f"  {error}")
    return (
        0
        if report["assessment"].get("status") == "PASS" and not contract_errors
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
