from __future__ import annotations

import json
import math
import os
from pathlib import Path
import subprocess
import sys

import pytest

from backtest.data_provider import BarProvider
from backtest.target_strategy_runner import (
    TargetBacktestConfig,
    TargetValidationError,
    run_target_strategy,
)


def _write_bars(
    bars_dir: Path,
    symbol: str,
    rows: list[tuple[str, float]],
) -> None:
    bars = [
        {
            "date": date,
            "open": open_price,
            "high": open_price,
            "low": open_price,
            "close": open_price,
            "volume": 1_000_000,
        }
        for date, open_price in rows
    ]
    (bars_dir / f"{symbol}.json").write_text(json.dumps({"bars": bars}))


def _provider(
    tmp_path: Path,
    *,
    dates: list[str],
    symbols: dict[str, list[float | None]],
) -> BarProvider:
    bars_dir = tmp_path / "bars"
    bars_dir.mkdir()
    _write_bars(bars_dir, "SPY", list(zip(dates, [100.0] * len(dates))))
    _write_bars(bars_dir, "BIL", list(zip(dates, [100.0] * len(dates))))
    for symbol, opens in symbols.items():
        _write_bars(
            bars_dir,
            symbol,
            [
                (date, float(open_price))
                for date, open_price in zip(dates, opens)
                if open_price is not None
            ],
        )
    return BarProvider(bars_dir)


def _config(dates: list[str], universe: tuple[str, ...], **kwargs) -> TargetBacktestConfig:
    return TargetBacktestConfig(
        start_date=dates[0],
        end_date=dates[-1],
        universe=universe,
        starting_cash=1_000.0,
        convergence_tolerance_weight=0.001,
        **kwargs,
    )


class _ScheduledStrategy:
    name = "scheduled"

    def __init__(self, targets: dict[str, dict[str, float]]):
        self.targets = targets
        self.build_calls: list[str] = []

    def should_rebalance(self, context) -> bool:
        return context.as_of in self.targets

    def build_target(self, context):
        self.build_calls.append(context.as_of)
        return self.targets[context.as_of]


def test_strategy_context_is_prior_session_and_provider_is_causally_capped(tmp_path):
    dates = ["2025-01-02", "2025-01-03"]
    provider = _provider(tmp_path, dates=dates, symbols={"AAA": [10.0, 999.0]})

    class InspectStrategy:
        name = "inspect"

        def __init__(self):
            self.observed = []

        def should_rebalance(self, context):
            attempted_today = context.provider.bars_up_to("AAA", context.today)
            self.observed.append(
                {
                    "as_of": context.as_of,
                    "signal_date": context.signal_date,
                    "today": context.today,
                    "fill_date": context.fill_date,
                    "last_visible_date": str(attempted_today.index[-1]),
                    "last_visible_open": float(attempted_today.iloc[-1]["open"]),
                    "today_bar": context.provider.bar_at("AAA", context.today),
                }
            )
            return True

        def build_target(self, context):
            return {}

    strategy = InspectStrategy()
    run_target_strategy(
        strategy,
        _config(dates, ("AAA",), slippage_bps=0.0),
        provider=provider,
    )

    assert strategy.observed == [
        {
            "as_of": "2025-01-02",
            "signal_date": "2025-01-02",
            "today": "2025-01-03",
            "fill_date": "2025-01-03",
            "last_visible_date": "2025-01-02",
            "last_visible_open": 10.0,
            "today_bar": None,
        }
    ]


def test_constant_slippage_is_paid_on_buy_and_sell_legs(tmp_path):
    dates = ["2025-01-02", "2025-01-03", "2025-01-06"]
    provider = _provider(tmp_path, dates=dates, symbols={"AAA": [100.0] * 3})
    strategy = _ScheduledStrategy(
        {
            "2025-01-02": {"AAA": 0.5},
            "2025-01-03": {},
        }
    )

    result = run_target_strategy(
        strategy,
        _config(dates, ("AAA",), slippage_bps=100.0),
        provider=provider,
    )

    assert len(result["closed_trades"]) == 1
    trade = result["closed_trades"][0]
    assert trade["entry_date"] == "2025-01-03"
    assert trade["exit_date"] == "2025-01-06"
    assert trade["qty"] == 4
    assert trade["entry_price"] == pytest.approx(101.0)
    assert trade["exit_price"] == pytest.approx(99.0)
    assert trade["pnl"] == pytest.approx(-8.0)
    assert result["final_equity"] == pytest.approx(992.0)
    assert result["metrics"]["total_return_pct"] == pytest.approx(-0.8)
    assert result["orders"] == [
        {
            "symbol": "AAA",
            "side": "buy",
            "qty": 4,
            "signal_date": "2025-01-02",
            "fill_date": "2025-01-03",
            "open_price": 100.0,
            "fill_price": 101.0,
            "notional": 404.0,
            "reason": "target_rebalance_buy",
        },
        {
            "symbol": "AAA",
            "side": "sell",
            "qty": 4,
            "signal_date": "2025-01-03",
            "fill_date": "2025-01-06",
            "open_price": 100.0,
            "fill_price": 99.0,
            "notional": 396.0,
            "reason": "target_rebalance_exit",
        },
    ]
    assert result["execution_summary"] == pytest.approx(
        {
            "order_count": 2,
            "buy_order_count": 1,
            "sell_order_count": 1,
            "gross_traded_notional": 800.0,
            "gross_traded_notional_pct_starting_cash": 80.0,
            "maximum_order_notional": 404.0,
        }
    )


def test_partial_trim_uses_sell_fill_for_integer_qty_and_is_audited(tmp_path):
    dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"]
    provider = _provider(tmp_path, dates=dates, symbols={"AAA": [100.0] * 4})
    # The first target buys nine shares at 101.  The second target creates a
    # $99.50 excess: one share at the 99 sell fill, but less than one share at
    # the unadjusted 100 open.  This guards the integer trim calculation.
    strategy = _ScheduledStrategy(
        {
            "2025-01-02": {"AAA": 0.91},
            "2025-01-03": {"AAA": 800.5 / 991.0},
        }
    )

    result = run_target_strategy(
        strategy,
        _config(dates, ("AAA",), slippage_bps=100.0),
        provider=provider,
    )

    assert result["closed_trades"][0]["reason"] == "target_rebalance_trim"
    assert result["closed_trades"][0]["qty"] == 1
    assert result["open_positions"][0]["qty"] == 8
    assert result["orders"][1] == {
        "symbol": "AAA",
        "side": "sell",
        "qty": 1,
        "signal_date": "2025-01-03",
        "fill_date": "2025-01-06",
        "open_price": 100.0,
        "fill_price": 99.0,
        "notional": 99.0,
        "reason": "target_rebalance_trim",
    }
    assert result["execution_summary"]["gross_traded_notional"] == pytest.approx(
        1_008.0
    )
    assert result["pending_target"] is None


def test_replacement_buy_waits_one_session_after_sell(tmp_path):
    dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"]
    provider = _provider(
        tmp_path,
        dates=dates,
        symbols={"AAA": [10.0] * 4, "BBB": [10.0] * 4},
    )
    strategy = _ScheduledStrategy(
        {
            "2025-01-02": {"AAA": 0.5},
            "2025-01-03": {"BBB": 0.5},
        }
    )

    result = run_target_strategy(
        strategy,
        _config(dates, ("AAA", "BBB"), slippage_bps=0.0),
        provider=provider,
    )

    assert result["closed_trades"][0]["symbol"] == "AAA"
    assert result["closed_trades"][0]["exit_date"] == "2025-01-06"
    assert result["daily_history"][2]["num_positions"] == 0
    assert result["open_positions"] == [
        pytest.approx(
            {
                "symbol": "BBB",
                "entry_date": "2025-01-07",
                "qty": 50,
                "avg_entry_price": 10.0,
                "current_price": 10.0,
                "market_value": 500.0,
                "unrealized_pl": 0.0,
                "unrealized_plpc": 0.0,
                "is_hedge": False,
                "is_base": False,
            }
        )
    ]


def test_execution_delay_can_stress_frozen_signal_at_d_plus_two(tmp_path):
    dates = ["2025-01-02", "2025-01-03", "2025-01-06"]
    provider = _provider(tmp_path, dates=dates, symbols={"AAA": [10.0] * 3})
    strategy = _ScheduledStrategy(
        {
            "2025-01-02": {"AAA": 0.5},
            # A newer signal must not replace the target waiting for D+2.
            "2025-01-03": {},
        }
    )

    result = run_target_strategy(
        strategy,
        _config(
            dates,
            ("AAA",),
            slippage_bps=0.0,
            execution_delay_sessions=2,
        ),
        provider=provider,
    )

    assert strategy.build_calls == ["2025-01-02"]
    assert result["daily_history"][1]["num_positions"] == 0
    assert result["open_positions"][0]["entry_date"] == "2025-01-06"
    assert result["config"]["signal_timing"] == "D-close-to-D+2-open"


@pytest.mark.parametrize(
    "target, message",
    [
        ({"AAA": math.nan}, "finite"),
        ({"AAA": -0.01}, "nonnegative"),
        ({"AAA": 0.6, "BBB": 0.5}, "<= 1.0"),
    ],
)
def test_invalid_targets_are_rejected_before_any_order(tmp_path, target, message):
    dates = ["2025-01-02", "2025-01-03"]
    provider = _provider(
        tmp_path,
        dates=dates,
        symbols={"AAA": [10.0] * 2, "BBB": [10.0] * 2},
    )
    strategy = _ScheduledStrategy({"2025-01-02": target})

    with pytest.raises(TargetValidationError, match=message):
        run_target_strategy(
            strategy,
            _config(dates, ("AAA", "BBB"), slippage_bps=0.0),
            provider=provider,
        )


def test_missing_sell_open_keeps_frozen_target_and_delays_replacement(tmp_path):
    dates = [
        "2025-01-02",
        "2025-01-03",
        "2025-01-06",
        "2025-01-07",
        "2025-01-08",
    ]
    provider = _provider(
        tmp_path,
        dates=dates,
        symbols={
            "AAA": [10.0, 10.0, None, 10.0, 10.0],
            "BBB": [10.0] * 5,
        },
    )
    strategy = _ScheduledStrategy(
        {
            "2025-01-02": {"AAA": 0.5},
            "2025-01-03": {"BBB": 0.5},
            # Must be ignored while the prior target is still pending.
            "2025-01-06": {"AAA": 0.2, "BBB": 0.2},
        }
    )

    result = run_target_strategy(
        strategy,
        _config(dates, ("AAA", "BBB"), slippage_bps=0.0),
        provider=provider,
    )

    assert strategy.build_calls == ["2025-01-02", "2025-01-03"]
    assert result["closed_trades"][0]["exit_date"] == "2025-01-07"
    assert result["daily_history"][2]["num_positions"] == 1
    assert result["daily_history"][3]["num_positions"] == 0
    assert result["open_positions"][0]["symbol"] == "BBB"
    assert result["open_positions"][0]["entry_date"] == "2025-01-08"
    assert result["pending_target"] is None


def test_opening_gap_changes_context_risk_tier_no_earlier_than_next_session(tmp_path):
    dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"]
    provider = _provider(
        tmp_path,
        dates=dates,
        symbols={"AAA": [100.0, 100.0, 80.0, 80.0]},
    )

    class GapObserver(_ScheduledStrategy):
        def __init__(self):
            super().__init__({"2025-01-02": {"AAA": 0.9}})
            self.risk_observations = []

        def risk_off(self, context):
            incumbent_price = (
                context.incumbent_positions["AAA"].current_price
                if "AAA" in context.incumbent_positions
                else None
            )
            self.risk_observations.append(
                (context.today, context.risk_tier, incumbent_price)
            )
            return None

    strategy = GapObserver()
    run_target_strategy(
        strategy,
        _config(dates, ("AAA",), slippage_bps=0.0),
        provider=provider,
    )

    assert strategy.risk_observations == [
        ("2025-01-03", "NORMAL", None),
        ("2025-01-06", "NORMAL", 100.0),
        ("2025-01-07", "HALT", 80.0),
    ]


def test_risk_off_latches_zero_target_until_missing_exit_can_fill(tmp_path):
    dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"]
    provider = _provider(
        tmp_path,
        dates=dates,
        symbols={"AAA": [10.0, 10.0, None, 10.0]},
    )

    class RiskOffStrategy(_ScheduledStrategy):
        def __init__(self):
            super().__init__({"2025-01-02": {"AAA": 0.5}})

        def risk_off(self, context):
            if context.as_of == "2025-01-03":
                return True
            return None

    result = run_target_strategy(
        RiskOffStrategy(),
        _config(dates, ("AAA",), slippage_bps=0.0),
        provider=provider,
    )

    assert result["daily_history"][2]["num_positions"] == 1
    assert result["closed_trades"][0]["exit_date"] == "2025-01-07"
    assert result["open_positions"] == []
    assert result["pending_target"] is None


def test_research_runner_does_not_import_production_engine_or_config():
    repo_root = Path(__file__).resolve().parent.parent
    script = """
import sys
import backtest.target_strategy_runner
forbidden = {
    'adaptive_momentum',
    'backtest.engine',
    'execute_trades',
    'strategy_config',
}
loaded = sorted(forbidden.intersection(sys.modules))
if loaded:
    raise SystemExit('unexpected production imports: ' + ','.join(loaded))
"""
    env = os.environ.copy()
    env["PYTHONPATH"] = str(repo_root / "scripts")
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=repo_root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr or completed.stdout
