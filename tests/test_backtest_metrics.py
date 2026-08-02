from __future__ import annotations

import math

import pandas as pd
import pytest

from backtest.metrics import compute_metrics


class OpenPriceProvider:
    def __init__(self, prices: dict[str, float]):
        self.prices = prices

    def bar_at(self, symbol: str, date: str):
        if symbol != "SPY" or date not in self.prices:
            return None
        price = self.prices[date]
        # Deliberately different close catches clock mismatches.
        return {"open": price, "close": price * 10.0}


def test_metrics_use_open_clock_and_report_beta_adjusted_alpha():
    dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"]
    opens = dict(zip(dates, [100.0, 101.0, 99.0, 103.0]))
    history = [
        {
            "date": date,
            "equity": price * 10_000,
            "pnl_pct": 0.0,
            "regime": "BULL",
        }
        for date, price in opens.items()
    ]
    result = {
        "starting_cash": 1_000_000.0,
        "final_equity": 1_030_000.0,
        "daily_history": history,
        "closed_trades": [],
    }

    metrics = compute_metrics(result, OpenPriceProvider(opens))

    assert metrics["spy_baseline_equity"] == [
        1_000_000.0,
        1_010_000.0,
        990_000.0,
        1_030_000.0,
    ]
    assert metrics["beta_to_spy"] == pytest.approx(1.0, abs=1e-4)
    assert metrics["jensen_alpha_annual_pct"] == pytest.approx(0.0, abs=1e-4)
    assert metrics["excess_cagr_pct"] == pytest.approx(0.0, abs=1e-4)

    daily = pd.Series(
        [1_000_000.0, 1_000_000.0, 1_010_000.0, 990_000.0, 1_030_000.0]
    ).pct_change().dropna()
    expected_sharpe = float(daily.mean() / daily.std(ddof=1)) * math.sqrt(252)
    assert metrics["sharpe_ratio"] == pytest.approx(expected_sharpe, abs=1e-4)
    assert metrics["risk_free_proxy"] == "BIL"
    assert metrics["risk_free_fallback_zero"] is True


def test_regime_return_is_compounded_not_summed():
    dates = ["2025-01-02", "2025-01-03", "2025-01-06"]
    result = {
        "starting_cash": 100.0,
        "final_equity": 99.0,
        "daily_history": [
            {"date": dates[0], "equity": 100.0, "pnl_pct": 0.0, "regime": "BULL"},
            {"date": dates[1], "equity": 110.0, "pnl_pct": 10.0, "regime": "BULL"},
            {"date": dates[2], "equity": 99.0, "pnl_pct": -10.0, "regime": "BULL"},
        ],
        "closed_trades": [],
    }
    provider = OpenPriceProvider(dict(zip(dates, [100.0, 100.0, 100.0])))

    metrics = compute_metrics(result, provider)

    assert metrics["regime_breakdown"]["BULL"]["total_pnl_pct"] == pytest.approx(-1.0)


def test_initial_fill_loss_is_included_in_drawdown():
    dates = ["2025-01-02", "2025-01-03"]
    result = {
        "starting_cash": 100.0,
        "final_equity": 90.0,
        "daily_history": [
            {"date": date, "equity": 90.0, "pnl_pct": 0.0, "regime": "BULL"}
            for date in dates
        ],
        "closed_trades": [],
    }
    provider = OpenPriceProvider(dict.fromkeys(dates, 100.0))

    metrics = compute_metrics(result, provider)

    assert metrics["max_drawdown_pct"] == pytest.approx(-10.0)
    assert metrics["max_drawdown_peak_date"] == dates[0]
    assert metrics["max_drawdown_trough_date"] == dates[0]


class MultiAssetOpenProvider:
    def __init__(self, prices: dict[str, dict[str, float]]):
        self.prices = prices

    def bar_at(self, symbol: str, date: str):
        price = self.prices.get(symbol, {}).get(date)
        return None if price is None else {"open": price, "close": price}


def test_sharpe_and_jensen_use_observed_bil_risk_free_proxy():
    dates = ["2025-01-02", "2025-01-03", "2025-01-06", "2025-01-07"]
    bil = dict(zip(dates, [100.0, 101.0, 102.0, 103.0]))
    spy = dict(zip(dates, [100.0, 102.0, 101.0, 104.0]))
    history = [
        {
            "date": date,
            "equity": bil[date],
            "pnl_pct": 0.0,
            "regime": "BULL",
        }
        for date in dates
    ]
    result = {
        "starting_cash": 100.0,
        "final_equity": 103.0,
        "daily_history": history,
        "closed_trades": [],
    }

    metrics = compute_metrics(
        result,
        MultiAssetOpenProvider({"SPY": spy, "BIL": bil}),
    )

    assert metrics["risk_free_fallback_zero"] is False
    assert metrics["risk_free_observed_sessions"] == len(dates)
    assert metrics["risk_free_total_return_pct"] == pytest.approx(3.0)
    assert metrics["sharpe_ratio"] == pytest.approx(0.0, abs=1e-4)
    assert metrics["jensen_alpha_annual_pct"] == pytest.approx(0.0, abs=1e-4)
