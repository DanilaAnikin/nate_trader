"""Offline pre-deployment checks for the v11 paper-trading strategy."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

VALIDATION_RESULT_PATH = (
    _SCRIPTS_DIR.parent / "state" / "backtest" / "v11_validation.json"
)


def _ok(message: str) -> None:
    print(f"  ok:   {message}")


def check_strategy_config() -> list[str]:
    from strategy_config import get_bear_hedge_target_pct, get_strategy_params

    failures: list[str] = []
    for regime in ("BULL", "NEUTRAL", "BEAR"):
        for tier in ("NORMAL", "CAUTIOUS", "HALT"):
            params = get_strategy_params(regime, tier)
            expected = {
                "strategy_version": "v11-adaptive-momentum",
                "adaptive_momentum": True,
                "momentum_top_n": 10,
                "max_position_pct": 9.0,
                "momentum_max_sector_pct": 20.0,
                "momentum_risk_on_reentry_days": 1,
                "min_cash_pct": 10.0,
                "tqqq_pct": 0.0,
                "upro_pct": 0.0,
                "base_pct": 0.0,
                "enable_options_hedge": False,
                "enable_mean_reversion": False,
                "enable_pead": False,
            }
            for key, value in expected.items():
                if params.get(key) != value:
                    failures.append(
                        f"{regime}/{tier} {key}: expected {value!r}, "
                        f"got {params.get(key)!r}"
                    )
            if get_bear_hedge_target_pct(regime, tier) != 0.0:
                failures.append(f"{regime}/{tier}: SH hedge target is not disabled")
    if not failures:
        _ok(
            "v11 targets: 10 names, 9% max, 20% sector, 10% cash, "
            "one-shot recovery reentry, no leverage"
        )
    return failures


def check_live_wiring() -> list[str]:
    failures: list[str] = []
    try:
        from execute_trades import (
            _is_infrastructure,
            manage_momentum_picks,
            paper_trading_mode_enabled,
        )
        from trade import MAX_ENTRY_CLOCK_AGE_SECONDS
    except Exception as exc:
        return [f"paper execution imports: {exc}"]

    for symbol in ("SPY", "SSO", "TQQQ", "UPRO", "SH"):
        if not _is_infrastructure(symbol):
            failures.append(f"{symbol} missing from infrastructure exit set")
    if _is_infrastructure("AAPL"):
        failures.append("AAPL incorrectly classified as infrastructure")
    if not callable(manage_momentum_picks):
        failures.append("adaptive momentum execution is not callable")
    if paper_trading_mode_enabled():
        _ok("TRADING_MODE=paper is explicitly enabled")
    else:
        _ok("orders locked; set TRADING_MODE=paper only for an intentional paper run")
    if MAX_ENTRY_CLOCK_AGE_SECONDS != 120:
        failures.append("broker clock freshness gate is not 120 seconds")
    if not failures:
        _ok("adaptive planner, infrastructure exits, and clock gate are wired")
    return failures


def check_modules() -> list[str]:
    modules = [
        "adaptive_momentum",
        "universe",
        "strategy_config",
        "trade",
        "execute_trades",
        "portfolio",
        "research",
        "backtest.engine",
        "backtest.metrics",
    ]
    failures: list[str] = []
    for module in modules:
        try:
            __import__(module)
        except Exception as exc:
            failures.append(f"{module} import: {exc}")
    if not failures:
        _ok(f"all {len(modules)} v11 modules import without credentials/network")
    return failures


def check_validation_artifact(path: Path = VALIDATION_RESULT_PATH) -> list[str]:
    """Require a schema-valid report whose fixed alpha gate actually passed."""

    if not path.exists():
        return ["validation artifact missing: run scripts/backtest/validate_v11.py"]
    try:
        payload = json.loads(path.read_text())
    except Exception as exc:
        return [f"validation artifact parse: {exc}"]
    if not isinstance(payload, dict):
        return ["validation artifact must be a JSON object"]
    if payload.get("schema_version") != 1 or payload.get("kind") != "v11_fixed_strategy_validation":
        return ["validation artifact has an unsupported schema or kind"]
    from backtest.validate_v11 import validation_report_contract_errors

    report_contract_errors = validation_report_contract_errors(payload)
    if report_contract_errors:
        return [
            "validation artifact contract: " + "; ".join(report_contract_errors)
        ]
    strategy = payload.get("strategy")
    if not isinstance(strategy, dict) or strategy.get("version") != "v11-adaptive-momentum":
        return ["validation artifact does not describe v11-adaptive-momentum"]
    from strategy_identity import build_strategy_identity

    recorded_identity = strategy.get("identity")
    current_identity = build_strategy_identity()
    if (
        not isinstance(recorded_identity, dict)
        or recorded_identity.get("value") != current_identity["value"]
    ):
        return ["validation artifact is stale for the current strategy fingerprint"]
    evidence = payload.get("evidence")
    if not isinstance(evidence, dict):
        return ["validation artifact omits its evidence fingerprint"]
    recorded_bar_hash = evidence.get("bar_snapshot_sha256")
    through_date = evidence.get("bar_snapshot_through_date")
    if not isinstance(recorded_bar_hash, str) or len(recorded_bar_hash) != 64:
        return ["validation artifact omits its historical bar fingerprint"]
    if not isinstance(through_date, str) or not through_date:
        return ["validation artifact omits its historical bar boundary"]
    from strategy_identity import hash_symbol_universe
    from universe import load_universe_symbols

    current_universe_hash = hash_symbol_universe(
        load_universe_symbols(held_symbols=[])
    )
    if evidence.get("ranking_universe_sha256") != current_universe_hash:
        return ["validation artifact is stale for the current ranking universe"]
    from adaptive_momentum import SECTOR_BENCHMARKS
    from backtest.data_provider import BarProvider
    from strategy_identity import build_bar_snapshot_identity

    current_bar_evidence = build_bar_snapshot_identity(
        BarProvider(),
        load_universe_symbols(held_symbols=[]),
        ("BIL", "SPY", *SECTOR_BENCHMARKS.values()),
        through_date=through_date,
    )
    if current_bar_evidence["bar_snapshot_sha256"] != recorded_bar_hash:
        return ["validation artifact is stale for the current historical bars"]
    warnings = payload.get("warnings")
    if not warnings:
        return ["validation artifact omits bias/holdout limitations"]
    assessment = payload.get("assessment")
    if not isinstance(assessment, dict):
        return ["validation artifact omits the fail-closed promotion assessment"]
    status = assessment.get("status")
    if status != "PASS":
        allowed_mode = assessment.get("allowed_mode", "dry-run/shadow-research-only")
        return [
            f"v11 alpha promotion gate is {status or 'missing'}; "
            f"allowed mode: {allowed_mode}"
        ]
    if assessment.get("allowed_mode") != "paper-validation-eligible":
        return ["validation PASS has an inconsistent allowed_mode"]
    _ok("fixed v11 alpha gate passed with explicit bias/holdout limitations")
    return []


def main() -> int:
    print("Running v11 paper-deployment sanity check...\n")
    failures: list[str] = []
    for label, check in (
        ("strategy_config", check_strategy_config),
        ("live_wiring", check_live_wiring),
        ("modules", check_modules),
        ("validation", check_validation_artifact),
    ):
        print(f"[{label}]")
        failures.extend(check())

    print()
    if failures:
        print(f"FAILED — {len(failures)} issue(s):")
        for failure in failures:
            print(f"  • {failure}")
        return 1
    print("PASSED — eligible for intentional paper validation; alpha is not guaranteed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
