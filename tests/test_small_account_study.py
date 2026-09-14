"""The research observer must not become a second trading engine."""

import json
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from types import SimpleNamespace

import pandas as pd
import pytest
from backtest import engine
from backtest import small_account_study as study
from backtest.data_provider import BarProvider
from backtest.portfolio_sim import SimulatedPortfolio
from backtest.small_account_study import (
    FillObserver,
    observe_pending,
    observed_backtest,
    run_study,
    summarize,
)


@pytest.fixture
def bars(tmp_path):
    dates = pd.bdate_range("2024-01-02", periods=300).strftime("%Y-%m-%d").tolist()
    for symbol, price in (("AAA", 20), ("SPY", 400), ("BIL", 90)):
        (tmp_path / f"{symbol}.json").write_text(
            json.dumps(
                {
                    "bars": [
                        {
                            "date": date,
                            "open": price,
                            "close": price,
                            "high": price + 1,
                            "low": price - 1,
                            "volume": 5_000_000,
                        }
                        for date in dates
                    ]
                }
            )
        )
    return BarProvider(tmp_path)


def test_observer_matches_real_portfolio_and_only_counts_successful_fills(bars):
    base = SimulatedPortfolio(250)
    observer = FillObserver(250, provider=bars)
    for portfolio in (base, observer):
        assert portfolio.open("AAA", 5, 20.02, "2024-01-02")
        assert not portfolio.open("AAA", 1000, 20.02, "2024-01-02")
        assert portfolio.partial_close("AAA", 2, 19.98, "2024-01-03", "trim")
        assert portfolio.close("AAA", 19.98, "2024-01-04", "exit")
        assert portfolio.close("AAA", 19.98, "2024-01-04", "exit") is None
    assert observer.to_dict() == base.to_dict()
    assert [fill["quantity"] for fill in observer.fills] == [5, 2, 3]
    assert sum(fill["slippage_usd"] for fill in observer.fills) == pytest.approx(0.2)
    assert observer.cash == pytest.approx(249.8)


@pytest.mark.parametrize(
    "capital, expected_qty", [(100, 0), (250, 1), (500, 2), (1000, 4)]
)
def test_observer_does_not_change_whole_share_engine_semantics(
    monkeypatch, bars, capital, expected_qty
):
    monkeypatch.setattr(
        engine,
        "compute_market_state",
        lambda *a, **k: SimpleNamespace(above_sma200=True),
    )
    monkeypatch.setattr(
        engine,
        "build_target_portfolio",
        lambda *a, **k: SimpleNamespace(weights={"AAA": 0.09}),
    )
    config = engine.BacktestConfig(
        start_date="2025-01-01",
        end_date="2025-01-07",
        starting_cash=capital,
        universe=["AAA"],
        slippage_bps=7,
    )
    expected = engine.run_backtest(config, provider=bars)
    actual, observations = observed_backtest(config, bars)
    assert actual == expected
    assert engine.SimulatedPortfolio is SimulatedPortfolio
    assert (
        sum(
            fill["quantity"]
            for fill in observations["filled_transactions"]
            if fill["side"] == "buy"
        )
        == expected_qty
    )
    assert all(row["signal_date"] < row["date"] for row in observations["sessions"])
    summary = summarize(actual, observations, bars)
    assert summary["filled_transactions"] == (1 if expected_qty else 0)
    assert summary["whole_share_blocked_sessions"] > 0
    assert summary["final_equity_usd"] == pytest.approx(
        capital - expected_qty * 20 * 7 / 10000
    )
    assert summary["modeled_slippage_usd_already_in_equity"] == pytest.approx(
        expected_qty * 20 * 7 / 10000
    )


def test_pending_observation_distinguishes_missing_price_unaffordable_and_residual():
    portfolio = SimulatedPortfolio(1000)
    portfolio.open("AAA", 4, 20, "2025-01-02")
    kwargs = {
        "portfolio": portfolio,
        "signal_date": "2025-01-02",
        "today": "2025-01-03",
        "opens": {"AAA": 20, "COSTLY": 500},
        "slippage_bps": 7,
    }
    plan = {"weights": {"AAA": 0.09, "COSTLY": 0.09, "MISSING": 0.09}}
    result = observe_pending(plan, kwargs)
    assert result["whole_share_shortfall_symbols"] == ["AAA", "COSTLY"]
    assert result["entire_target_unaffordable_symbols"] == ["COSTLY"]
    assert result["missing_price_symbols"] == ["MISSING"]
    assert portfolio.cash == 920
    assert plan == {"weights": {"AAA": 0.09, "COSTLY": 0.09, "MISSING": 0.09}}


def test_noncausal_or_policy_override_experiment_is_refused(bars):
    with pytest.raises(ValueError, match="noncausal_signal_date"):
        observe_pending(None, {"signal_date": "2025-01-03", "today": "2025-01-03"})
    with pytest.raises(ValueError, match="policy_overrides_forbidden"):
        observed_backtest(engine.BacktestConfig(param_overrides={}), bars)


def test_observer_restores_engine_globals_when_underlying_engine_fails(
    monkeypatch, bars
):
    original = engine._execute_adaptive_momentum

    def fail(*args, **kwargs):
        raise RuntimeError("synthetic failure")

    monkeypatch.setattr(engine, "run_backtest", fail)
    with pytest.raises(RuntimeError, match="synthetic failure"):
        observed_backtest(engine.BacktestConfig(), bars)
    assert engine._execute_adaptive_momentum is original
    assert engine.SimulatedPortfolio is SimulatedPortfolio


def test_output_cannot_overwrite_runtime_or_canonical_report(tmp_path):
    with pytest.raises(ValueError, match="output_must_be_under_docs_research"):
        run_study(tmp_path / "canonical.json")
    assert not (tmp_path / "canonical.json").exists()


def test_process_worker_has_same_results_without_patching_parent(monkeypatch, bars):
    monkeypatch.setattr(study, "_WORKER_PROVIDER", bars)
    monkeypatch.setattr(
        engine,
        "compute_market_state",
        lambda *a, **k: SimpleNamespace(above_sma200=True),
    )
    monkeypatch.setattr(
        engine,
        "build_target_portfolio",
        lambda *a, **k: SimpleNamespace(weights={"AAA": 0.09}),
    )
    period = {"start_date": "2025-01-01", "end_date": "2025-01-07"}
    expected = study._run_case(250, 7, "synthetic", period, ["AAA"])
    with ProcessPoolExecutor(
        max_workers=1, mp_context=multiprocessing.get_context("fork")
    ) as executor:
        actual = executor.submit(
            study._run_case, 250, 7, "synthetic", period, ["AAA"]
        ).result(timeout=30)
    for key in ("engine_result", "engine_config", "observations", "summary"):
        assert actual[key] == expected[key]
    assert engine.SimulatedPortfolio is SimulatedPortfolio


@pytest.mark.parametrize("workers", [0, 4, True])
def test_worker_resource_bound_is_enforced(tmp_path, workers):
    with pytest.raises(ValueError, match="workers_must_be_1_to_3"):
        run_study(tmp_path, workers=workers)
