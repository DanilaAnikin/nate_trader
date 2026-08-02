from __future__ import annotations

from dataclasses import replace

import pandas as pd

import adaptive_momentum
from adaptive_momentum import AdaptiveMomentumConfig, CandidateSignal, UniverseScan
from backtest.research_v11_tactics import (
    FROZEN_BASELINE_OVERRIDES,
    TACTICS,
    _rerank,
    _shared_scan_cache,
    _tactic_overrides,
    select_winners,
)


def _candidate(
    name: str,
    *,
    cagr: float,
    excess: float,
    jensen: float,
    sharpe: float,
    drawdown: float,
    trades: int,
    worst_year: float = -12.0,
) -> dict:
    metrics = {
        "annual_return_pct": cagr,
        "spy_annual_return_pct": 8.82,
        "excess_cagr_pct": excess,
        "jensen_alpha_annual_pct": jensen,
        "sharpe_ratio": sharpe,
        "max_drawdown_pct": drawdown,
        "n_trades": trades,
    }
    return {
        "name": name,
        "development": metrics,
        "years": {
            "2022": {"excess_cagr_pct": 6.0},
            "2023": {"excess_cagr_pct": worst_year},
            "2024": {"excess_cagr_pct": 25.0},
        },
    }


def test_frozen_selector_keeps_distinct_return_risk_and_balanced_winners():
    baseline = _candidate(
        "baseline",
        cagr=15.5786,
        excess=6.7588,
        jensen=9.2239,
        sharpe=0.8981,
        drawdown=-20.2379,
        trades=222,
        worst_year=-12.1605,
    )
    maximum_return = _candidate(
        "maximum_return_tactic",
        cagr=17.0,
        excess=8.2,
        jensen=10.0,
        sharpe=0.90,
        drawdown=-21.0,
        trades=230,
    )
    minimum_risk = _candidate(
        "minimum_risk_tactic",
        cagr=13.0,
        excess=4.2,
        jensen=6.0,
        sharpe=0.90,
        drawdown=-12.0,
        trades=100,
    )
    balanced = _candidate(
        "balanced_tactic",
        cagr=15.8,
        excess=7.0,
        jensen=9.5,
        sharpe=0.95,
        drawdown=-19.0,
        trades=220,
    )

    winners = select_winners(
        [baseline, maximum_return, minimum_risk, balanced]
    )

    assert winners["maximum_return"]["winner"] == "maximum_return_tactic"
    assert winners["minimum_risk"]["winner"] == "minimum_risk_tactic"
    assert winners["balanced"]["winner"] == "balanced_tactic"


def _signal(symbol: str, long: float, medium: float) -> CandidateSignal:
    return CandidateSignal(
        symbol=symbol,
        as_of="2024-12-31",
        price=100.0,
        momentum_12_1_pct=long,
        momentum_6_1_pct=medium,
        annual_volatility_pct=20.0,
        median_dollar_volume_usd=100_000_000.0,
        above_sma200=True,
        sector="Technology",
        eligible=True,
    )


def _scan(*signals: CandidateSignal) -> UniverseScan:
    return UniverseScan(
        signals=tuple(signals),
        ranked=tuple(signals),
        evaluated_count=len(signals),
        liquid_count=len(signals),
        breadth_pct=100.0,
    )


def test_research_rankers_are_deterministic_and_do_not_mutate_signals():
    aaa = _signal("AAA", 30.0, -1.0)
    bbb = _signal("BBB", 20.0, 25.0)
    ccc = _signal("CCC", 10.0, 20.0)
    original = _scan(aaa, bbb, ccc)

    positive = _rerank(
        original,
        mode="positive_6_1",
        provider=object(),
        as_of="2024-12-31",
    )
    composite = _rerank(
        original,
        mode="composite_12_1_6_1",
        provider=object(),
        as_of="2024-12-31",
    )

    assert [signal.symbol for signal in positive.ranked] == ["BBB", "CCC"]
    assert [signal.symbol for signal in composite.ranked] == ["BBB", "AAA", "CCC"]
    assert original == replace(original)


def test_beat_spy_ranker_fails_closed_without_sufficient_spy_history():
    class Provider:
        @staticmethod
        def bars_up_to(symbol, as_of, lookback_days=None):
            return pd.DataFrame({"close": [100.0, 101.0]})

    ranked = _rerank(
        _scan(_signal("AAA", 30.0, 10.0)),
        mode="beat_spy_12_1",
        provider=Provider(),
        as_of="2024-12-31",
    )

    assert ranked.ranked == ()


def test_shared_scan_cache_reuses_only_signal_equivalent_configs(monkeypatch):
    calls: list[tuple[str, float]] = []

    def fake_scan(provider, candidates, as_of, **kwargs):
        config = kwargs["config"]
        calls.append((as_of, config.max_annual_volatility_pct))
        return _scan(
            replace(
                _signal("AAA", 30.0, 10.0),
                annual_volatility_pct=70.0,
            )
        )

    monkeypatch.setattr(adaptive_momentum, "scan_universe", fake_scan)
    provider = object()
    baseline = AdaptiveMomentumConfig()
    portfolio_only_change = replace(baseline, target_market_volatility_pct=10.0)
    signal_change = replace(baseline, max_annual_volatility_pct=50.0)

    with _shared_scan_cache() as stats:
        first = adaptive_momentum.scan_universe(
            provider, ["BBB", "AAA"], "2024-12-31", config=baseline
        )
        reused = adaptive_momentum.scan_universe(
            provider, ["AAA", "BBB"], "2024-12-31", config=portfolio_only_change
        )
        changed = adaptive_momentum.scan_universe(
            provider, ["AAA", "BBB"], "2024-12-31", config=signal_change
        )

    assert first == reused
    assert [signal.symbol for signal in first.ranked] == ["AAA"]
    assert changed.ranked == ()
    assert calls == [("2024-12-31", 80.0)]
    assert stats == {"hits": 2, "misses": 1}


def test_frozen_research_baseline_stays_unscaled_after_winner_promotion():
    tactics = {tactic.name: tactic for tactic in TACTICS}

    assert FROZEN_BASELINE_OVERRIDES["momentum_use_breadth_scaling"] is False
    assert tactics["baseline"].params == {}
    assert tactics["breadth_scaled"].params == {
        "momentum_use_breadth_scaling": True
    }
    assert _tactic_overrides(tactics["baseline"])["*"] == {
        "momentum_use_breadth_scaling": False
    }
    assert _tactic_overrides(tactics["breadth_scaled"])["*"] == {
        "momentum_use_breadth_scaling": True
    }
