"""Offline, NONPROMOTABLE whole-share capital sensitivity of unchanged V11.

Run: PYTHON_DOTENV_DISABLED=1 .venv/bin/python scripts/backtest/small_account_study.py
Only docs/research receives output. No canonical report, strategy parameters,
runtime state, data downloads, or broker clients are involved. The portfolio
observer calls the original engine methods without changing their decisions.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
import os
import statistics
import subprocess
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

os.environ["PYTHON_DOTENV_DISABLED"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from strategy_config import get_strategy_params
from universe import load_universe_symbols
from utils import PROJECT_ROOT

from backtest import engine
from backtest.data_provider import BarProvider
from backtest.metrics import compute_metrics
from backtest.portfolio_sim import SimulatedPortfolio
from backtest.validate_v11 import (
    build_bar_coverage,
    build_evidence_identity,
    resolve_periods,
)

CAPITALS = (100, 250, 500, 1000)
COSTS_BPS = (7, 15, 25)
_WORKER_PROVIDER: BarProvider | None = None
# These are the sources used by this historical experiment, not a production
# strategy identity. Unrelated deployment work must not be silently promoted
# by (or invalidate) a NONPROMOTABLE study of the unchanged historical policy.
SOURCE_PATHS = (
    "requirements.txt",
    "requirements.lock",
    "watchlist.json",
    "scripts/adaptive_momentum.py",
    "scripts/risk_policy.py",
    "scripts/research.py",
    "scripts/strategy_config.py",
    "scripts/universe.py",
    "scripts/momentum_picker.py",
    "scripts/utils.py",
    "scripts/strategy_identity.py",
    "scripts/backtest/engine.py",
    "scripts/backtest/data_provider.py",
    "scripts/backtest/portfolio_sim.py",
    "scripts/backtest/metrics.py",
    "scripts/backtest/news_proxy.py",
    "scripts/backtest/validate_v11.py",
    "scripts/backtest/small_account_study.py",
)
LIMITATIONS = [
    "NONPROMOTABLE: isolated research; does not approve or change any release or policy.",
    "Current local universe membership, not point-in-time constituents; survivorship and missing delistings can bias results.",
    "Both periods have already been inspected during development; the later period is a REUSED TEMPORAL CHECK, not fresh OOS.",
    "Integer units use adjusted historical OHLC prices. Splits/dividend adjustments can make historical nominal share affordability differ; this is the existing engine's policy sensitivity, not an exact historical broker replay.",
    "Signals use completed prior-session data; fills and daily valuation use the next session's open. Intraday drawdowns are not measured.",
    "Costs are adverse 7/15/25 bps on each buy and sell. They are already included in equity; no separate commissions, regulatory fees, taxes, market impact or stochastic/partial fills are simulated.",
    "Cash earns zero. Each period starts independently in cash; there are no deposits, withdrawals, capital transfers or live account records.",
    "SPY percentage benchmark is a frictionless fractional open-to-open reference. The additional integer-SPY example includes entry slippage and idle cash, has no exit liquidation, and may buy zero shares.",
    "Whole-share blocked counts are observations of material target shortfalls on pending-plan sessions, not broker rejections or distinct order attempts; one frozen target can recur on many days.",
    "No optimization, fractionals, alternate ranking, minimum-position relaxation, or changes to the frozen V11 allocation/risk rules. Historical results do not establish future returns.",
]


def source_hashes() -> dict[str, str]:
    return {
        name: hashlib.sha256((PROJECT_ROOT / name).read_bytes()).hexdigest()
        for name in SOURCE_PATHS
    }


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


class FillObserver(SimulatedPortfolio):
    """Observe actual successful fills; superclass owns all cash/position math."""

    def __init__(self, starting_cash: float, *, provider: BarProvider):
        super().__init__(starting_cash)
        self.provider = provider
        self.fills: list[dict] = []

    def _record(
        self, symbol: str, qty: int, price: float, date: str, side: str, reason: str
    ) -> None:
        bar = self.provider.bar_at(symbol, date)
        if bar is None or qty <= 0 or int(qty) != qty:
            raise ValueError("fill_observation_invalid")
        raw = float(bar["open"])
        cost = qty * (price - raw if side == "buy" else raw - price)
        if cost < -1e-8:
            raise ValueError("unexpected_favorable_fill")
        self.fills.append(
            {
                "date": date,
                "symbol": symbol,
                "side": side,
                "quantity": qty,
                "fill_price": price,
                "reference_open": raw,
                "slippage_usd": max(0.0, cost),
                "reason": reason,
            }
        )

    def open(self, symbol, qty, fill_price, date, is_hedge=False, is_base=False):
        filled = super().open(symbol, qty, fill_price, date, is_hedge, is_base)
        if filled:
            self._record(symbol, qty, fill_price, date, "buy", "engine_buy")
        return filled

    def close(self, symbol, fill_price, date, reason):
        trade = super().close(symbol, fill_price, date, reason)
        if trade is not None:
            self._record(symbol, trade.qty, fill_price, date, "sell", reason)
        return trade

    def partial_close(self, symbol, qty, fill_price, date, reason):
        trade = super().partial_close(symbol, qty, fill_price, date, reason)
        if trade is not None:
            self._record(symbol, trade.qty, fill_price, date, "sell", reason)
        return trade


def observe_pending(plan: dict | None, kwargs: dict) -> dict:
    """Read the engine's returned frozen plan; never reconstruct its ranking."""
    if kwargs["signal_date"] >= kwargs["today"]:
        raise ValueError("noncausal_signal_date")
    portfolio = kwargs["portfolio"]
    blocked, unaffordable, missing = [], [], []
    weights = plan.get("weights", {}) if plan else {}
    equity = portfolio.equity()
    for symbol, weight in weights.items():
        position = portfolio.get_position(symbol)
        shortfall = equity * weight - (position.market_value if position else 0.0)
        if shortfall <= equity * 0.005:
            continue
        if symbol not in kwargs["opens"]:
            missing.append(symbol)
            continue
        fill = engine._buy_fill(kwargs["opens"][symbol], kwargs["slippage_bps"])
        if int(shortfall / fill) == 0:
            blocked.append(symbol)
            if position is None:
                unaffordable.append(symbol)
    return {
        "date": kwargs["today"],
        "signal_date": kwargs["signal_date"],
        "pending_plan": plan is not None,
        "pending_target_count": len(weights),
        "whole_share_shortfall_symbols": blocked,
        "entire_target_unaffordable_symbols": unaffordable,
        "missing_price_symbols": missing,
    }


def observed_backtest(
    config: engine.BacktestConfig, provider: BarProvider
) -> tuple[dict, dict]:
    if config.param_overrides is not None:
        raise ValueError("policy_overrides_forbidden")
    portfolio = FillObserver(config.starting_cash, provider=provider)
    sessions = []
    original = engine._execute_adaptive_momentum

    def observe(**kwargs):
        plan = original(**kwargs)
        sessions.append(observe_pending(plan, kwargs))
        return plan

    # Process-local and restored even on exceptions. There is no concurrent
    # engine use within this runner; different CLI processes do not share it.
    with (
        patch.object(engine, "SimulatedPortfolio", return_value=portfolio),
        patch.object(engine, "_execute_adaptive_momentum", side_effect=observe),
    ):
        result = engine.run_backtest(config, provider=provider)
    if result["config"]["strategy_version"] != "v11-adaptive-momentum":
        raise ValueError("unexpected_strategy_version")
    return result, {"filled_transactions": portfolio.fills, "sessions": sessions}


def summarize(result: dict, observations: dict, provider: BarProvider) -> dict:
    metrics = compute_metrics(result, provider)
    history = result["daily_history"]
    if not history or metrics["spy_observed_sessions"] != len(history):
        raise ValueError("missing_reference_sessions")
    fills = observations["filled_transactions"]
    sessions = observations["sessions"]
    exposure = [100.0 - row["cash_pct"] for row in history]
    first_open = float(provider.bar_at("SPY", history[0]["date"])["open"])
    last_open = float(provider.bar_at("SPY", history[-1]["date"])["open"])
    buy_fill = engine._buy_fill(first_open, result["config"]["slippage_bps"])
    spy_qty = int(result["starting_cash"] / buy_fill)
    spy_cash = result["starting_cash"] - spy_qty * buy_fill
    fields = (
        "total_return_pct",
        "annual_return_pct",
        "spy_total_return_pct",
        "spy_annual_return_pct",
        "max_drawdown_pct",
        "max_drawdown_peak_date",
        "max_drawdown_trough_date",
        "n_trading_days",
        "n_return_intervals",
    )
    return {
        **{key: metrics[key] for key in fields},
        "final_equity_usd": result["final_equity"],
        "final_cash_usd": result["final_cash"],
        "average_exposure_pct": statistics.mean(exposure),
        "median_exposure_pct": statistics.median(exposure),
        "maximum_exposure_pct": max(exposure),
        "average_idle_cash_pct": statistics.mean(row["cash_pct"] for row in history),
        "sessions_entirely_cash": sum(row["num_positions"] == 0 for row in history),
        "maximum_positions": max(row["num_positions"] for row in history),
        "average_positions": statistics.mean(row["num_positions"] for row in history),
        "filled_buys": sum(fill["side"] == "buy" for fill in fills),
        "filled_sells": sum(fill["side"] == "sell" for fill in fills),
        "filled_transactions": len(fills),
        "closed_trade_records": len(result["closed_trades"]),
        "modeled_slippage_usd_already_in_equity": sum(
            fill["slippage_usd"] for fill in fills
        ),
        "pending_plan_sessions": sum(row["pending_plan"] for row in sessions),
        "whole_share_blocked_sessions": sum(
            bool(row["whole_share_shortfall_symbols"]) for row in sessions
        ),
        "whole_share_blocked_target_sessions": sum(
            len(row["whole_share_shortfall_symbols"]) for row in sessions
        ),
        "entire_target_unaffordable_target_sessions": sum(
            len(row["entire_target_unaffordable_symbols"]) for row in sessions
        ),
        "unaffordable_symbols": sorted(
            {
                symbol
                for row in sessions
                for symbol in row["entire_target_unaffordable_symbols"]
            }
        ),
        "missing_price_target_sessions": sum(
            len(row["missing_price_symbols"]) for row in sessions
        ),
        "risk_tier_sessions": dict(Counter(row["risk_tier"] for row in history)),
        "integer_spy_buy_hold": {
            "shares": spy_qty,
            "idle_cash_usd": spy_cash,
            "final_equity_usd": spy_cash + spy_qty * last_open,
            "return_pct": (
                (spy_cash + spy_qty * last_open) / result["starting_cash"] - 1
            )
            * 100,
            "entry_slippage_usd": spy_qty * (buy_fill - first_open),
        },
    }


def markdown_report(report: dict) -> str:
    lines = [
        "# V11: malé účty a celé akcie",
        "",
        "**NONPROMOTABLE — oddělená historická studie, bez změny strategie a bez pokynů brokerovi.**",
        "",
        "Každé období začíná znovu s uvedenou hotovostí. Parametry V11 zůstávají beze změny; mění se pouze počáteční kapitál a model nákladů.",
        "",
        "## Výsledky",
        "",
        "Expozice je průměr investované části účtu při denním ocenění na open. Obchody jsou skutečně simulované nákupní/prodejní transakce; ne počet uzavřených pozic. Náklady jsou již zahrnuté v konečné hodnotě.",
        "",
    ]
    for name, period in report["periods"].items():
        lines += [
            f"### {period['label']} ({period['start_date']} až {period['end_date']})",
            "",
            "| Účet USD | Náklad bps / strana | Konec USD | Výnos % | Max. propad % | Prům. expozice % | Dní jen hotovost | Nákupy/prodeje | Náklady USD |",
            "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
        for case in report["cases"]:
            if case["period"] != name:
                continue
            s = case["summary"]
            lines.append(
                f"| {case['starting_cash_usd']} | {case['slippage_bps']} | {s['final_equity_usd']:.2f} | {s['total_return_pct']:.2f} | {s['max_drawdown_pct']:.2f} | {s['average_exposure_pct']:.2f} | {s['sessions_entirely_cash']}/{s['n_trading_days']} | {s['filled_buys']}/{s['filled_sells']} | {s['modeled_slippage_usd_already_in_equity']:.2f} |"
            )
        reference = next(
            case["summary"] for case in report["cases"] if case["period"] == name
        )
        lines += [
            "",
            f"SPY, zlomkový beznákladový index open–open: **{reference['spy_total_return_pct']:.2f} %**. Jde o referenční vývoj trhu; za každý uvedený účet nelze koupit celou akcii SPY. Varianta SPY s celými akciemi, vstupními náklady a hotovostí je v JSON.",
            "",
        ]
    lines += [
        "## Dosažitelnost pozic při 7 bps",
        "",
        "| Období | Účet USD | Max. počet pozic | Dní s omezením celými akciemi | Nedostupný celý cílový titul × den |",
        "|---|---:|---:|---:|---:|",
    ]
    for case in report["cases"]:
        if case["slippage_bps"] == 7:
            s = case["summary"]
            lines.append(
                f"| {case['period']} | {case['starting_cash_usd']} | {s['maximum_positions']} | {s['whole_share_blocked_sessions']} | {s['entire_target_unaffordable_target_sessions']} |"
            )
    lines += [
        "",
        "Opakovaný nedostupný titul se počítá v každém dni čekajícího plánu. Počty zahrnují stav po provedení plánu, včetně čekání po prodeji; nejsou to odmítnuté ani odeslané pokyny.",
        "",
        "## Omezení a reprodukce",
        "",
    ]
    lines += [f"- {item}" for item in report["limitations"]]
    evidence = report["data_identity"]
    lines += [
        "",
        f"Lokální ranking: **{evidence['ranking_universe_count']} symbolů**, {evidence['bar_rows_hashed']} řádků včetně pomocných ETF, poslední datum {evidence['bar_snapshot_through_date']}.",
        f"SHA256 datového prefixu: `{evidence['bar_snapshot_sha256']}`.",
        f"SHA256 ranking univerza: `{evidence['ranking_universe_sha256']}`.",
        f"SHA256 zdrojů studie: `{report['study_source_sha256']}`. Přesné soubory a jejich hashe jsou v JSON; není to schválená produkční identita.",
        "",
        "Spuštění z kořene stejného checkoutu a dat: `PYTHON_DOTENV_DISABLED=1 .venv/bin/python scripts/backtest/small_account_study.py --output-dir docs/research/small-account-repeat`.",
        "",
        "[Úplný JSON: metriky, transakce, denní průběhy, omezení a původ dat](study.json)",
        "",
    ]
    return "\n".join(lines)


def write_json(path: Path, payload: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True, allow_nan=False) + "\n"
    )
    temporary.replace(path)


def _run_case(
    capital: int, cost: int, name: str, period: dict, universe: list[str]
) -> dict:
    """Each process owns its portfolio/monkeypatches; bars were loaded pre-fork."""
    if _WORKER_PROVIDER is None:
        raise ValueError("worker_provider_missing")
    provider = _WORKER_PROVIDER
    start, cpu_start = time.monotonic(), time.process_time()
    config = engine.BacktestConfig(
        start_date=period["start_date"],
        end_date=period["end_date"],
        starting_cash=capital,
        universe=universe,
        slippage_bps=cost,
        param_overrides=None,
    )
    result, observations = observed_backtest(config, provider)
    return {
        "starting_cash_usd": capital,
        "slippage_bps": cost,
        "period": name,
        "engine_config": result["config"],
        "summary": summarize(result, observations, provider),
        "engine_result": result,
        "observations": observations,
        "wall_seconds": time.monotonic() - start,
        "cpu_seconds": time.process_time() - cpu_start,
    }


def run_study(output: Path, *, workers: int = 3) -> dict:
    global _WORKER_PROVIDER
    if type(workers) is not int or not 1 <= workers <= 3:
        raise ValueError("workers_must_be_1_to_3")
    output = output.resolve()
    if not output.is_relative_to((PROJECT_ROOT / "docs" / "research").resolve()):
        raise ValueError("output_must_be_under_docs_research")
    output.mkdir(parents=True, exist_ok=False)
    provider = BarProvider()
    universe = load_universe_symbols(held_symbols=[])
    periods = resolve_periods(provider)
    before = source_hashes()
    coverage = build_bar_coverage(
        provider,
        universe,
        start_date=periods.development_start,
        end_date=periods.temporal_check_end,
    )
    for key in (
        "missing_required_auxiliary_symbols",
        "partial_required_auxiliary_symbols",
        "invalid_bar_symbols",
        "auxiliary_session_gap_symbols",
    ):
        if coverage[key]:
            raise ValueError(f"invalid_input_{key}")
    identity = build_evidence_identity(
        provider, universe, through_date=periods.temporal_check_end
    )
    report = {
        "schema_version": 1,
        "kind": "v11-small-account-shadow-study",
        "status": "INCOMPLETE",
        "promotable": False,
        "verdict": "NONPROMOTABLE",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "git_commit_at_start": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT, text=True
        ).strip(),
        "study_source_hashes": before,
        "study_source_sha256": _digest(before),
        "data_identity": identity,
        "bar_coverage": coverage,
        "ranking_universe": sorted(universe),
        "periods": periods.as_dict(),
        "capital_usd": list(CAPITALS),
        "slippage_bps_per_side": list(COSTS_BPS),
        "effective_policy": {
            f"{regime}/{tier}": get_strategy_params(regime, tier)
            for regime in ("BULL", "NEUTRAL", "BEAR")
            for tier in ("NORMAL", "CAUTIOUS", "HALT")
        },
        "parameter_overrides": None,
        "worker_processes": workers,
        "limitations": LIMITATIONS,
        "cases": [],
    }
    _WORKER_PROVIDER = provider
    try:
        with ProcessPoolExecutor(
            max_workers=workers, mp_context=multiprocessing.get_context("fork")
        ) as executor:
            pending = [
                executor.submit(_run_case, capital, cost, name, period, universe)
                for capital in CAPITALS
                for cost in COSTS_BPS
                for name, period in periods.as_dict().items()
            ]
            for future in as_completed(pending):
                case = future.result()
                report["cases"].append(case)
                report["cases"].sort(
                    key=lambda row: (
                        row["starting_cash_usd"],
                        row["slippage_bps"],
                        row["period"],
                    )
                )
                write_json(output / "INCOMPLETE.json", report)
                print(
                    json.dumps(
                        {
                            "case": len(report["cases"]),
                            "capital": case["starting_cash_usd"],
                            "cost_bps": case["slippage_bps"],
                            "period": case["period"],
                            "seconds": round(case["wall_seconds"], 2),
                            "cpu_seconds": round(case["cpu_seconds"], 2),
                            "fills": case["summary"]["filled_transactions"],
                        }
                    ),
                    flush=True,
                )
    finally:
        _WORKER_PROVIDER = None
    after = build_evidence_identity(
        BarProvider(),
        load_universe_symbols(held_symbols=[]),
        through_date=periods.temporal_check_end,
    )
    if before != source_hashes() or identity != after:
        raise ValueError("study_inputs_changed_during_run")
    report["status"] = "COMPLETE"
    report["source_and_data_rechecked"] = True
    report["completed_at"] = datetime.now(timezone.utc).isoformat()
    write_json(output / "study.json", report)
    (output / "README.md").write_text(markdown_report(report))
    (output / "INCOMPLETE.json").unlink()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, choices=(1, 2, 3), default=3)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT
        / "docs"
        / "research"
        / f"small-account-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
    )
    args = parser.parse_args()
    run_study(args.output_dir, workers=args.workers)


if __name__ == "__main__":
    main()
