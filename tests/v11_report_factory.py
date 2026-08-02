"""Small canonical validation artifacts for contract and execution tests."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from adaptive_momentum import SECTOR_BENCHMARKS
from backtest.data_provider import BarProvider
from backtest.validate_v11 import (
    CANONICAL_STARTING_CASH,
    DEFAULT_SLIPPAGE_BPS,
    DEVELOPMENT_LABEL,
    REQUIRED_AUXILIARY_SYMBOLS,
    REQUIRED_WARMUP_SESSIONS,
    TEMPORAL_CHECK_LABEL,
    apply_data_integrity_gate,
    apply_experiment_integrity_gate,
    apply_promotion_profile_gate,
    assess_promotion_gate,
    attach_report_contract,
    build_period_payload,
    build_promotion_profile,
    experiment_result_contract_errors,
    resolve_periods,
)
from strategy_identity import build_strategy_identity, hash_symbol_universe
from universe import load_universe_symbols


def canonical_validation_report(
    *,
    metric_value: float = 1.0,
    allowed_mode: str | None = None,
    bar_snapshot_sha256: str = "a" * 64,
) -> dict[str, Any]:
    """Return a sealed report bound to the current local canonical calendar."""

    provider = BarProvider()
    universe = load_universe_symbols(held_symbols=[])
    periods = resolve_periods(provider)
    period_payload = build_period_payload(provider, periods)
    reference_days = provider.all_trading_days("SPY")
    requested_count = len(
        set(universe) | {"BIL", "SPY", *SECTOR_BENCHMARKS.values()}
    )
    coverage = {
        "reference_symbol": "SPY",
        "reference_start": reference_days[0],
        "reference_end": reference_days[-1],
        "reference_sessions": len(reference_days),
        "validation_start": periods.development_start,
        "validation_end": periods.temporal_check_end,
        "required_warmup_sessions": REQUIRED_WARMUP_SESSIONS,
        "required_auxiliary_symbols": list(REQUIRED_AUXILIARY_SYMBOLS),
        "universe_source": "canonical test fixture",
        "requested_symbol_count_including_spy": requested_count,
        "symbols_with_cached_bars": requested_count,
        "symbols_with_full_range_coverage": requested_count,
        "full_range_coverage_pct": 100.0,
        "missing_symbols": [],
        "partial_coverage_symbols": [],
        "symbols_starting_after_validation_start": [],
        "symbols_missing_validation_end": [],
        "missing_required_auxiliary_symbols": [],
        "partial_required_auxiliary_symbols": [],
        "symbols_without_required_warmup": [],
        "invalid_bar_symbols": [],
        "auxiliary_session_gap_symbols": [],
    }
    universe_hash = hash_symbol_universe(universe)
    evidence = {
        "schema_version": 1,
        "ranking_universe_count": len(universe),
        "ranking_universe_sha256": universe_hash,
        "bar_snapshot_sha256": bar_snapshot_sha256,
        "bar_snapshot_through_date": periods.temporal_check_end,
        "bar_symbols_requested": requested_count,
        "bar_symbols_observed": requested_count,
        "bar_rows_hashed": 1,
    }
    results = []
    for cost in DEFAULT_SLIPPAGE_BPS:
        segments = {}
        for name, label in (
            ("development", DEVELOPMENT_LABEL),
            ("temporal_check", TEMPORAL_CHECK_LABEL),
        ):
            period = period_payload[name]
            segments[name] = {
                "label": label,
                "config": {
                    "start_date": period["start_date"],
                    "end_date": period["end_date"],
                    "starting_cash": CANONICAL_STARTING_CASH,
                    "slippage_bps": cost,
                    "universe_size": len(universe),
                    "ranking_universe_sha256": universe_hash,
                    "strategy_version": "v11-adaptive-momentum",
                    "signal_timing": "prior-close-to-next-open",
                    "param_overrides": None,
                },
                "starting_cash": CANONICAL_STARTING_CASH,
                "final_equity": CANONICAL_STARTING_CASH * 1.01,
                "metrics": {
                    "excess_cagr_pct": metric_value,
                    "jensen_alpha_annual_pct": metric_value,
                },
            }
        results.append(
            {
                "scenario": f"slippage_{cost:g}_bps",
                "slippage_bps": cost,
                "segments": segments,
            }
        )

    profile = build_promotion_profile(
        custom_period_requested=False,
        starting_cash=CANONICAL_STARTING_CASH,
        scenarios=DEFAULT_SLIPPAGE_BPS,
    )
    assessment = apply_data_integrity_gate(
        assess_promotion_gate(results), coverage
    )
    assessment = apply_promotion_profile_gate(
        assessment, profile, period_payload, DEFAULT_SLIPPAGE_BPS
    )
    experiment_errors = experiment_result_contract_errors(
        results,
        period_payload,
        DEFAULT_SLIPPAGE_BPS,
        coverage,
        evidence,
        expected_universe=universe,
    )
    assessment = apply_experiment_integrity_gate(
        assessment, experiment_errors
    )
    if allowed_mode is not None:
        assessment["allowed_mode"] = allowed_mode

    report = {
        "schema_version": 1,
        "kind": "v11_fixed_strategy_validation",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "strategy": {
            "version": "v11-adaptive-momentum",
            "parameter_policy": "fixed checked-in parameters; no optimizer or sweep",
            "signal_timing": "prior completed close to next-session open",
            "identity": build_strategy_identity(),
        },
        "labels": {
            "development": DEVELOPMENT_LABEL,
            "temporal_check": TEMPORAL_CHECK_LABEL,
        },
        "periods": period_payload,
        "promotion_profile": profile,
        "slippage_scenarios_bps": list(DEFAULT_SLIPPAGE_BPS),
        "bar_coverage": coverage,
        "evidence": evidence,
        "warnings": [
            {"code": code, "message": code}
            for code in (
                "NOT_FRESH_OOS",
                "CURRENT_UNIVERSE_SURVIVORSHIP_BIAS",
                "NO_GUARANTEE",
            )
        ],
        "assessment": assessment,
        "results": results,
    }
    return attach_report_contract(report)
