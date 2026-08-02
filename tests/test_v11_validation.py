from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from types import SimpleNamespace

import pandas as pd
import pytest

from backtest import validate_v11
from tests.v11_report_factory import canonical_validation_report


class FakeProvider:
    def __init__(self):
        self.frames = {
            "SPY": self._frame(
                ["2024-12-30", "2024-12-31", "2025-01-02", "2025-01-03"]
            ),
            "AAA": self._frame(
                ["2024-12-30", "2024-12-31", "2025-01-02", "2025-01-03"]
            ),
            "PART": self._frame(["2024-12-31", "2025-01-02"]),
        }
        for symbol in validate_v11.REQUIRED_AUXILIARY_SYMBOLS:
            self.frames.setdefault(
                symbol,
                self._frame(
                    ["2024-12-30", "2024-12-31", "2025-01-02", "2025-01-03"]
                ),
            )

    @staticmethod
    def _frame(dates: list[str]) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "open": [100.0] * len(dates),
                "high": [101.0] * len(dates),
                "low": [99.0] * len(dates),
                "close": [100.0] * len(dates),
                "volume": [1_000_000] * len(dates),
            },
            index=dates,
        )

    def all_trading_days(self, symbol: str, start=None, end=None):
        days = list(self.frames[symbol].index)
        if start is not None:
            days = [day for day in days if day >= start]
        if end is not None:
            days = [day for day in days if day <= end]
        return days

    def available_symbols(self):
        return sorted(self.frames)

    def load(self, symbol: str):
        return self.frames.get(symbol)


def _canonical_contract_report() -> dict:
    """Return a canonical report with a deterministic, boundary-local clock."""

    report = canonical_validation_report()
    boundary = report["evidence"]["bar_snapshot_through_date"]
    report["generated_at"] = f"{boundary}T12:00:00+00:00"
    return validate_v11.attach_report_contract(report)


def _contract_errors(
    report: dict,
    *,
    now: datetime | None = None,
) -> list[str]:
    if now is None:
        generated = datetime.fromisoformat(
            str(report["generated_at"]).replace("Z", "+00:00")
        )
        now = generated + timedelta(minutes=1)
    return validate_v11.validation_report_contract_errors(report, now=now)


def test_resolve_periods_uses_available_sessions_and_named_boundary():
    periods = validate_v11.resolve_periods(FakeProvider())

    assert periods.development_start == "2024-12-30"
    assert periods.development_end == "2024-12-31"
    assert periods.temporal_check_start == "2025-01-02"
    assert periods.temporal_check_end == "2025-01-03"


def test_default_start_reserves_signal_warmup_when_cache_is_long_enough():
    provider = FakeProvider()
    dates = [day.strftime("%Y-%m-%d") for day in pd.bdate_range("2022-01-03", periods=300)]
    provider.frames["SPY"] = provider._frame(dates)

    periods = validate_v11.resolve_periods(provider)

    assert periods.development_start == dates[validate_v11.REQUIRED_WARMUP_SESSIONS]


def test_fixed_validation_runs_both_segments_for_each_cost_without_writing(tmp_path):
    calls = []

    def config_factory(**kwargs):
        return SimpleNamespace(**kwargs)

    def runner(config):
        calls.append(config)
        return {
            "config": vars(config),
            "starting_cash": config.starting_cash,
            "final_equity": config.starting_cash * 1.01,
            "daily_history": [],
            "closed_trades": [],
        }

    def metrics(result, provider):
        assert isinstance(provider, FakeProvider)
        return {
            "annual_return_pct": 1.0,
            "excess_cagr_pct": 0.5,
            "jensen_alpha_annual_pct": 0.25,
            "sharpe_ratio": 0.2,
            "max_drawdown_pct": -1.0,
        }

    untouched_output = tmp_path / "v11_validation.json"
    report = validate_v11.run_validation(
        provider=FakeProvider(),
        universe=["AAA", "PART", "MISSING"],
        slippage_bps=[7, 15, 7],
        runner=runner,
        metrics_fn=metrics,
        config_factory=config_factory,
    )

    assert len(calls) == 4
    assert [call.slippage_bps for call in calls] == [7.0, 7.0, 15.0, 15.0]
    assert all(call.param_overrides is None for call in calls)
    assert all(call.universe == ["AAA", "MISSING", "PART"] for call in calls)
    assert report["slippage_scenarios_bps"] == [7.0, 15.0]
    assert report["evidence"]["ranking_universe_count"] == 3
    assert len(report["evidence"]["ranking_universe_sha256"]) == 64
    assert len(report["evidence"]["bar_snapshot_sha256"]) == 64
    assessment = report["assessment"]
    assert report["promotion_profile"]["custom_components_requested"] is True
    assert report["promotion_profile"]["promotable"] is False
    assert assessment["promotion_profile_check"]["passed"] is False
    assert assessment["status"] == "FAIL"
    assert assessment["allowed_mode"] == "dry-run/shadow-research-only"
    assert assessment["checks_evaluated"] == 8
    assert assessment["checks_passed"] == 8
    assert assessment["failed_checks"] == []
    assert assessment["data_integrity_check"]["missing_symbols"] == ["MISSING"]
    assert assessment["data_integrity_check"][
        "symbols_missing_validation_end"
    ] == ["PART"]
    assert len(assessment["checks"]) == 8
    assert all(check["passed"] for check in assessment["checks"])
    assert "not fresh OOS" in report["labels"]["temporal_check"]
    assert report["bar_coverage"]["missing_symbols"] == ["MISSING"]
    assert report["bar_coverage"]["partial_coverage_symbols"] == ["PART"]
    assert {warning["code"] for warning in report["warnings"]} >= {
        "NOT_FRESH_OOS",
        "CURRENT_UNIVERSE_SURVIVORSHIP_BIAS",
        "NO_GUARANTEE",
        "MISSING_BAR_FILES",
        "PARTIAL_BAR_COVERAGE",
        "INSUFFICIENT_SIGNAL_WARMUP",
    }
    assert not untouched_output.exists()


def test_validation_fails_if_strategy_sources_change_during_run(monkeypatch):
    identities = iter(
        [
            {"schema_version": 1, "algorithm": "sha256", "value": "a" * 64},
            {"schema_version": 1, "algorithm": "sha256", "value": "b" * 64},
        ]
    )
    monkeypatch.setattr(
        validate_v11,
        "build_strategy_identity",
        lambda: next(identities),
    )

    def config_factory(**kwargs):
        return SimpleNamespace(**kwargs)

    def runner(config):
        return {
            "config": vars(config),
            "starting_cash": config.starting_cash,
            "final_equity": config.starting_cash,
        }

    def metrics(_result, _provider):
        return {
            "annual_return_pct": 1.0,
            "excess_cagr_pct": 1.0,
            "jensen_alpha_annual_pct": 1.0,
        }

    report = validate_v11.run_validation(
        provider=FakeProvider(),
        universe=["AAA"],
        runner=runner,
        metrics_fn=metrics,
        config_factory=config_factory,
    )

    errors = report["assessment"]["experiment_contract_check"]["errors"]
    assert "strategy source identity changed during validation" in errors
    assert report["assessment"]["status"] == "FAIL"


def test_validation_fails_if_bar_snapshot_changes_during_run():
    provider = FakeProvider()
    calls = 0

    def config_factory(**kwargs):
        return SimpleNamespace(**kwargs)

    def runner(config):
        nonlocal calls
        calls += 1
        if calls == 1:
            provider.frames["AAA"].loc["2025-01-03", "close"] = 101.0
        return {
            "config": vars(config),
            "starting_cash": config.starting_cash,
            "final_equity": config.starting_cash,
        }

    def metrics(_result, _provider):
        return {
            "annual_return_pct": 1.0,
            "excess_cagr_pct": 1.0,
            "jensen_alpha_annual_pct": 1.0,
        }

    report = validate_v11.run_validation(
        provider=provider,
        universe=["AAA"],
        runner=runner,
        metrics_fn=metrics,
        config_factory=config_factory,
    )

    errors = report["assessment"]["experiment_contract_check"]["errors"]
    assert "bar snapshot identity changed during validation" in errors
    assert report["assessment"]["status"] == "FAIL"


def test_experiment_contract_rejects_a_narrow_ranking_universe():
    report = canonical_validation_report()

    errors = validate_v11.experiment_result_contract_errors(
        report["results"],
        report["periods"],
        report["slippage_scenarios_bps"],
        report["bar_coverage"],
        report["evidence"],
        expected_universe=["AAA"],
    )

    assert any("too narrow for broad-universe promotion" in error for error in errors)


def test_promotion_gate_fails_closed_for_non_positive_or_missing_alpha():
    scenarios = [
        {
            "scenario": "slippage_15_bps",
            "slippage_bps": 15.0,
            "segments": {
                "development": {
                    "metrics": {
                        "excess_cagr_pct": 0.0,
                        "jensen_alpha_annual_pct": 1.25,
                    }
                },
                "temporal_check": {
                    "metrics": {
                        "excess_cagr_pct": -0.1,
                        # Deliberately absent Jensen alpha must fail closed.
                    }
                },
            },
        }
    ]

    assessment = validate_v11.assess_promotion_gate(scenarios)

    assert assessment["status"] == "FAIL"
    assert assessment["allowed_mode"] == "dry-run/shadow-research-only"
    assert assessment["checks_evaluated"] == 4
    assert assessment["checks_passed"] == 1
    assert [
        (check["segment"], check["metric"], check["value"], check["reason"])
        for check in assessment["failed_checks"]
    ] == [
        ("development", "excess_cagr_pct", 0.0, "not_strictly_positive"),
        ("temporal_check", "excess_cagr_pct", -0.1, "not_strictly_positive"),
        (
            "temporal_check",
            "jensen_alpha_annual_pct",
            None,
            "missing_or_non_finite",
        ),
    ]
    assert "prohibited" in assessment["alpha_claim"]


def test_empty_or_non_finite_assessment_cannot_pass():
    empty = validate_v11.assess_promotion_gate([])
    assert empty["status"] == "FAIL"
    assert empty["allowed_mode"] == "dry-run/shadow-research-only"

    non_finite = validate_v11.assess_promotion_gate(
        [
            {
                "scenario": "bad",
                "segments": {
                    "development": {
                        "metrics": {
                            "excess_cagr_pct": float("nan"),
                            "jensen_alpha_annual_pct": float("inf"),
                        }
                    }
                },
            }
        ]
    )
    assert non_finite["status"] == "FAIL"
    assert all(check["value"] is None for check in non_finite["failed_checks"][:2])


def test_cli_summary_prints_failed_gate_and_restricted_mode(capsys):
    report = {
        "results": [],
        "assessment": {
            "status": "FAIL",
            "allowed_mode": "dry-run/shadow-research-only",
            "failed_checks": [
                {
                    "scenario": "slippage_15_bps",
                    "segment": "temporal_check",
                    "metric": "excess_cagr_pct",
                    "value": -2.5,
                }
            ],
        },
    }

    validate_v11._print_summary(report)

    output = capsys.readouterr().out
    assert "PROMOTION GATE: FAIL" in output
    assert "Allowed mode: dry-run/shadow-research-only" in output
    assert "No validated-alpha claim is allowed." in output


def test_cli_is_the_write_boundary_and_uses_atomic_json_helper(tmp_path, monkeypatch):
    output = tmp_path / "state" / "backtest" / "v11_validation.json"
    report = {
        "results": [],
        "warnings": [],
        "bar_coverage": {},
        "assessment": {
            "status": "FAIL",
            "allowed_mode": "dry-run/shadow-research-only",
            "failed_checks": [],
        },
    }
    monkeypatch.setattr(validate_v11, "RESULT_PATH", output)
    monkeypatch.setattr(validate_v11, "run_validation", lambda **kwargs: report)
    monkeypatch.setattr(validate_v11, "_print_summary", lambda payload: None)

    assert validate_v11.main(["--slippage-bps", "9"]) == 1
    assert json.loads(output.read_text()) == report
    assert list(output.parent.glob("*.tmp")) == []


@pytest.mark.parametrize("values", [[], [-1], [float("nan")], [float("inf")]])
def test_slippage_scenarios_must_be_non_negative_and_finite(values):
    with pytest.raises(ValueError):
        validate_v11.normalize_slippage_scenarios(values)


def test_empty_bar_coverage_fails_closed_even_when_report_is_resealed():
    report = _canonical_contract_report()
    report["bar_coverage"] = {}
    report = validate_v11.attach_report_contract(report)

    errors = _contract_errors(report)

    assert errors
    assert "bar coverage reference_symbol must be SPY" in errors
    assert "bar coverage required auxiliary set is inconsistent" in errors


def test_custom_period_request_is_not_promotable():
    report = _canonical_contract_report()
    profile = validate_v11.build_promotion_profile(
        custom_period_requested=True,
        starting_cash=validate_v11.CANONICAL_STARTING_CASH,
        scenarios=validate_v11.DEFAULT_SLIPPAGE_BPS,
    )

    assessment = validate_v11.apply_promotion_profile_gate(
        report["assessment"],
        profile,
        report["periods"],
        validate_v11.DEFAULT_SLIPPAGE_BPS,
    )

    assert profile["promotable"] is False
    assert assessment["status"] == "FAIL"
    assert assessment["allowed_mode"] == validate_v11.FAIL_ALLOWED_MODE
    assert assessment["promotion_profile_check"]["errors"] == [
        "promotion profile is not the canonical fixed profile"
    ]


def test_noncanonical_starting_cash_is_not_promotable():
    report = _canonical_contract_report()
    profile = validate_v11.build_promotion_profile(
        custom_period_requested=False,
        starting_cash=500_000.0,
        scenarios=validate_v11.DEFAULT_SLIPPAGE_BPS,
    )

    assessment = validate_v11.apply_promotion_profile_gate(
        report["assessment"],
        profile,
        report["periods"],
        validate_v11.DEFAULT_SLIPPAGE_BPS,
    )

    assert profile["promotable"] is False
    assert assessment["status"] == "FAIL"
    assert assessment["allowed_mode"] == validate_v11.FAIL_ALLOWED_MODE
    assert "promotion profile is not the canonical fixed profile" in assessment[
        "promotion_profile_check"
    ]["errors"]


@pytest.mark.parametrize(
    "scenarios",
    [
        pytest.param((9.0, 15.0), id="different"),
        pytest.param((7.0, 15.0, 25.0), id="extra"),
        pytest.param((7.0,), id="missing"),
    ],
)
def test_noncanonical_scenario_sets_fail_contract_even_when_resealed(scenarios):
    report = _canonical_contract_report()
    report["slippage_scenarios_bps"] = list(scenarios)
    report = validate_v11.attach_report_contract(report)

    errors = _contract_errors(report)

    assert "promotion scenarios must be exactly 7bps and 15bps" in errors


@pytest.mark.parametrize(
    "scenarios",
    [
        pytest.param((9.0, 15.0), id="different"),
        pytest.param((7.0, 15.0, 25.0), id="extra"),
        pytest.param((7.0,), id="missing"),
    ],
)
def test_cli_exits_one_for_noncanonical_scenario_sets(
    scenarios,
    tmp_path,
    monkeypatch,
):
    output = tmp_path / "v11_validation.json"
    base_report = _canonical_contract_report()

    def fake_validation(**kwargs):
        resolved_scenarios = validate_v11.normalize_slippage_scenarios(
            kwargs["slippage_bps"]
        )
        profile = validate_v11.build_promotion_profile(
            custom_period_requested=False,
            starting_cash=validate_v11.CANONICAL_STARTING_CASH,
            scenarios=resolved_scenarios,
        )
        report = deepcopy(base_report)
        report["promotion_profile"] = profile
        report["slippage_scenarios_bps"] = list(resolved_scenarios)
        report["assessment"] = validate_v11.apply_promotion_profile_gate(
            report["assessment"],
            profile,
            report["periods"],
            resolved_scenarios,
        )
        return validate_v11.attach_report_contract(report)

    monkeypatch.setattr(validate_v11, "RESULT_PATH", output)
    monkeypatch.setattr(validate_v11, "run_validation", fake_validation)
    monkeypatch.setattr(validate_v11, "_print_summary", lambda report: None)

    argv = ["--slippage-bps", *(str(value) for value in scenarios)]
    assert validate_v11.main(argv) == 1
    assert json.loads(output.read_text())["assessment"]["status"] == "FAIL"


def test_segment_config_mismatch_fails_contract_even_when_resealed():
    report = _canonical_contract_report()
    report["results"][0]["segments"]["development"]["config"][
        "end_date"
    ] = "1999-12-31"
    report = validate_v11.attach_report_contract(report)

    errors = _contract_errors(report)

    assert (
        "slippage_7_bps/development config end_date is inconsistent" in errors
    )


@pytest.mark.parametrize(
    ("field", "expected_error"),
    [
        pytest.param(
            "evidence",
            "evidence boundary does not match temporal-check end",
            id="evidence-through-date",
        ),
        pytest.param(
            "coverage",
            "coverage end does not match temporal-check end",
            id="coverage-boundary",
        ),
    ],
)
def test_evidence_and_coverage_boundaries_must_match_periods(
    field,
    expected_error,
):
    report = _canonical_contract_report()
    mismatched_boundary = report["periods"]["development"]["end_date"]
    if field == "evidence":
        report["evidence"]["bar_snapshot_through_date"] = mismatched_boundary
    else:
        report["bar_coverage"]["validation_end"] = mismatched_boundary
    report = validate_v11.attach_report_contract(report)

    errors = _contract_errors(report)

    assert expected_error in errors


@pytest.mark.parametrize(
    ("segment", "minimum"),
    [
        ("development", validate_v11.MIN_DEVELOPMENT_SESSIONS),
        ("temporal_check", validate_v11.MIN_TEMPORAL_CHECK_SESSIONS),
    ],
)
def test_too_short_segment_fails_promotion_contract(segment, minimum):
    report = _canonical_contract_report()
    report["periods"][segment]["sessions"] = minimum - 1
    report = validate_v11.attach_report_contract(report)

    errors = _contract_errors(report)

    assert f"{segment} requires at least {minimum} reference sessions" in errors


@pytest.mark.parametrize(
    "timestamp_template",
    [
        pytest.param("{boundary}T12:00:00", id="naive"),
        pytest.param("{boundary}T14:00:00+02:00", id="non-utc"),
    ],
)
def test_generation_timestamp_must_be_timezone_aware_utc(timestamp_template):
    report = _canonical_contract_report()
    boundary = report["evidence"]["bar_snapshot_through_date"]
    report["generated_at"] = timestamp_template.format(boundary=boundary)
    report = validate_v11.attach_report_contract(report)
    now = datetime.fromisoformat(f"{boundary}T13:00:00+00:00").astimezone(
        timezone.utc
    )

    errors = _contract_errors(report, now=now)

    assert "validation generation timestamp is invalid" in errors
