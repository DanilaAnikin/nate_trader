"""Pre-deployment sanity checks for v10d.

Run before any live trading session to catch config or environment
breakage early. Returns nonzero on any failure.

Checks:
  1. strategy_config loads without error and returns expected v10d shape.
  2. TQQQ overlay logic imports cleanly (no syntax / wiring errors).
  3. All scoring modules import (PEAD, MR, sentiment, ML, MTF, sector-rot).
  4. The TQQQ symbol is in the infrastructure skip-list across the four
     places that need it.
  5. The latest backtest result file exists and is parseable.

Usage:
    python3 scripts/sanity_check.py

Designed to run as part of the pre-market routine.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))


def _fail(msg: str) -> None:
    print(f"  FAIL: {msg}")


def _ok(msg: str) -> None:
    print(f"  ok:   {msg}")


def check_strategy_config() -> list[str]:
    failures = []
    try:
        from strategy_config import get_strategy_params, get_bear_hedge_target_pct
    except Exception as e:
        failures.append(f"strategy_config import: {e}")
        return failures

    for regime in ["BULL", "NEUTRAL", "BEAR"]:
        for tier in ["NORMAL", "CAUTIOUS"]:
            try:
                p = get_strategy_params(regime, tier)
            except Exception as e:
                failures.append(f"get_strategy_params({regime}, {tier}): {e}")
                continue
            # Required v10d fields
            for k in ["tqqq_pct", "tqqq_stop_pct", "base_pct",
                      "base_instrument", "trailing_stop_pct"]:
                if k not in p:
                    failures.append(f"{regime}/{tier} missing key '{k}'")

    # Specific v10f expectations
    bull_n = get_strategy_params("BULL", "NORMAL")
    if bull_n["tqqq_pct"] != 75.0:
        failures.append(f"BULL/NORMAL tqqq_pct expected 75, got {bull_n['tqqq_pct']}")
    if bull_n.get("upro_pct", 0) != 25.0:
        failures.append(f"BULL/NORMAL upro_pct expected 25, got {bull_n.get('upro_pct')}")
    if bull_n["trailing_stop_pct"] != 40.0:
        failures.append(f"BULL/NORMAL trailing_stop_pct expected 40, "
                        f"got {bull_n['trailing_stop_pct']}")
    neut_n = get_strategy_params("NEUTRAL", "NORMAL")
    if neut_n["tqqq_pct"] != 75.0:
        failures.append(f"NEUTRAL/NORMAL tqqq_pct expected 75, "
                        f"got {neut_n['tqqq_pct']}")
    if neut_n.get("upro_pct", 0) != 25.0:
        failures.append(f"NEUTRAL/NORMAL upro_pct expected 25, "
                        f"got {neut_n.get('upro_pct')}")
    if not failures:
        _ok(f"strategy_config: BULL {bull_n['tqqq_pct']}TQQQ+{bull_n['upro_pct']}UPRO, "
            f"NEUTRAL {neut_n['tqqq_pct']}TQQQ+{neut_n['upro_pct']}UPRO, "
            f"trail={bull_n['trailing_stop_pct']}%")
    return failures


def check_live_wiring() -> list[str]:
    failures = []
    os.environ.setdefault("ALPACA_API_KEY", "sanity_check_no_network")
    os.environ.setdefault("ALPACA_SECRET_KEY", "sanity_check_no_network")
    try:
        from execute_trades import (
            manage_tqqq_position, manage_base_position, manage_bear_hedge,
            _is_infrastructure, BASE_CANDIDATES, TQQQ_BASE_SYMBOL,
        )
    except Exception as e:
        failures.append(f"execute_trades import: {e}")
        return failures

    if not _is_infrastructure("TQQQ"):
        failures.append("_is_infrastructure('TQQQ') returned False")
    if not _is_infrastructure("SSO"):
        failures.append("_is_infrastructure('SSO') returned False (regression)")
    if not _is_infrastructure("SH"):
        failures.append("_is_infrastructure('SH') returned False (regression)")
    if _is_infrastructure("AAPL"):
        failures.append("_is_infrastructure('AAPL') returned True (bug)")
    if TQQQ_BASE_SYMBOL != "TQQQ":
        failures.append(f"TQQQ_BASE_SYMBOL='{TQQQ_BASE_SYMBOL}' not 'TQQQ'")
    if TQQQ_BASE_SYMBOL in BASE_CANDIDATES:
        failures.append("TQQQ is in BASE_CANDIDATES — it should be parallel "
                        "to the SPY↔SSO swap loop, not part of it")
    if not failures:
        _ok("execute_trades: manage_tqqq_position wired, infra skip-list "
            "includes TQQQ, BASE_CANDIDATES correct")
    return failures


def check_modules() -> list[str]:
    failures = []
    modules = [
        "utils", "strategy_config", "trade", "execute_trades", "portfolio",
        "research", "screener", "monitor_drift", "ablation_flags",
        "gap_scanner", "mean_reversion", "pead_strategy", "momentum_picker",
        "sector_rotation", "multi_timeframe", "ml_signals", "sentiment",
        "earnings_calendar", "strategy_metadata",
    ]
    for m in modules:
        try:
            __import__(m)
        except Exception as e:
            failures.append(f"{m} import: {e}")
    if not failures:
        _ok(f"all {len(modules)} production modules import cleanly")
    return failures


def check_backtest_result() -> list[str]:
    failures = []
    p = Path(__file__).resolve().parent.parent / "state" / "backtest"
    latest = p / "latest_result.json"
    wf = p / "walk_forward_result.json"
    if not latest.exists():
        failures.append(f"latest_result.json missing at {latest}")
    else:
        try:
            d = json.loads(latest.read_text())
            metrics = d.get("metrics", {})
            alpha = metrics.get("alpha_annual_pct")
            if alpha is None:
                failures.append("latest_result.json has no alpha_annual_pct")
            else:
                _ok(f"latest_result: α={alpha:+.2f}%/yr")
        except Exception as e:
            failures.append(f"latest_result.json parse: {e}")
    if not wf.exists():
        failures.append(f"walk_forward_result.json missing at {wf}")
    else:
        try:
            d = json.loads(wf.read_text())
            agg = d.get("aggregate", {})
            wf_alpha = agg.get("mean_oos_alpha_annual_pct")
            if wf_alpha is None:
                failures.append("walk_forward_result.json has no aggregate alpha")
            else:
                _ok(f"walk_forward: mean OOS α={wf_alpha:+.2f}%/yr "
                    f"across {agg.get('n_windows')} windows")
        except Exception as e:
            failures.append(f"walk_forward_result.json parse: {e}")
    return failures


def main() -> int:
    print("Running v10d sanity check...\n")
    all_failures: list[str] = []
    for name, fn in [
        ("strategy_config", check_strategy_config),
        ("live_wiring", check_live_wiring),
        ("modules", check_modules),
        ("backtest_result", check_backtest_result),
    ]:
        print(f"[{name}]")
        all_failures.extend(fn())

    print()
    if all_failures:
        print(f"FAILED — {len(all_failures)} issue(s):")
        for f in all_failures:
            print(f"  • {f}")
        return 1
    print("PASSED — system is ready for live trading.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
