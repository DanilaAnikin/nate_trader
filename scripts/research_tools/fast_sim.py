"""Fast vectorized research simulator for V11 adaptive momentum.

RESEARCH ONLY.  This module is not a strategy-identity source, is never
imported by production, validation, or paper-trading paths, and its output
must never be used to authorize a promotion.  ``scripts/backtest/engine.py``
remains the authoritative simulator; this file exists solely to make a broad
parameter search tractable, and every candidate it surfaces must be re-run on
the authoritative engine before it is believed.

Design
------
The authoritative engine spends nearly all of its time recomputing the same
point-in-time signal panel: ``analyze_symbol`` slices a pandas frame and runs
``Series.map`` validity checks for every one of ~535 symbols on every monthly
rebalance, and ``compute_market_state`` / ``_spy_regime`` re-slice SPY on every
one of ~1,425 sessions.  None of that depends on portfolio state.

So this module splits the problem in two:

1.  **Panel** (``build_panel`` / ``load_panel``) — computed once and cached to
    ``state/research/fast_sim_panel_<key>.npz``.  A ``(T, N)`` matrix indexed
    by (master trading date, symbol) holding open, close, 12-1 momentum, 6-1
    momentum, 63-session annualized volatility, 60-session median dollar
    volume, SMA200, the above-SMA200 flag, and a per-cell validity flag that
    reproduces every rejection ``analyze_symbol`` applies before scoring.
    Windows are positional on each *symbol's own* bar sequence, exactly as
    ``BarProvider.bars_up_to(...).iloc[-k:]`` is, so symbols with interior
    calendar holes are handled correctly.

2.  **Replay** (``_simulate``) — a scalar day loop that reproduces the engine's
    decision sequence exactly: completed-session risk tier, mark to today's
    open, market gate, monthly cadence, the frozen pending plan with its
    sell-first / buy-next-session boundary, integer share counts, per-side
    slippage, and the ``open()``/``close()`` marking conventions of
    ``SimulatedPortfolio``.

Everything V11 actually decides is reproduced.  What is *deliberately* not
reproduced is listed in ``KNOWN_DIVERGENCES`` at the bottom of this file.

Authoritative behaviour reproduced (file:line references are to the tree this
was written against):

* ``scripts/backtest/engine.py:1742-1754``  loop order, signal date = previous
  SPY session, immutable completed-session risk tier.
* ``scripts/backtest/engine.py:1756-1771``  today's OHLC snapshot, then
  ``mark_to_market`` at today's OPEN before any trade fires.
* ``scripts/backtest/engine.py:1811-1825``  stops/scale-outs/time-stops are
  skipped whenever ``adaptive_momentum`` is on.
* ``scripts/backtest/engine.py:1937-2005``  risk-off latch, one-shot risk-on
  re-entry, residual parking, then the adaptive rebalance.
* ``scripts/backtest/engine.py:1305-1538``  ``_execute_adaptive_momentum``.
* ``scripts/adaptive_momentum.py:262-352``  ``analyze_symbol``.
* ``scripts/adaptive_momentum.py:355-399``  ``scan_universe`` ranking/breadth.
* ``scripts/adaptive_momentum.py:560-603``  ``_target_gross_weight``.
* ``scripts/adaptive_momentum.py:697-749``  ``select_diversified``.
* ``scripts/adaptive_momentum.py:752-808``  ``allocate_equal_weight``.
* ``scripts/backtest/portfolio_sim.py``     open/close/partial_close/equity.

Import contract  (IMPORTANT — this package must NOT be named ``research``)
-------------------------------------------------------------------------
``scripts/research.py`` already exists, is a strategy-identity source, and is
imported by ``scripts/backtest/engine.py:45``
(``from research import compute_confidence_score, compute_technicals``) plus
``execute_trades``, ``trade``, ``screener``, ``options_executor`` and
``run_gap_scanner``.  A regular package beats a sibling module on the same
``sys.path`` entry, so ``scripts/research/__init__.py`` makes ``import
research`` resolve to the directory and breaks all of them with
``ImportError: cannot import name 'compute_confidence_score' from 'research'``.
That was verified in-session and is now pinned by
``tests/test_research_namespace_guard.py``.  Hence ``research_tools``:

    import sys
    sys.path.insert(0, "<repo>/scripts")          # engine deps
    from research_tools.fast_sim import simulate

  or, running the file directly:

    python3 scripts/research_tools/fast_sim.py --help

Usage
-----
    m = simulate({}, "2021-01-04", "2026-09-04", slippage_bps=15.0)
    m = simulate({"momentum_below_sma200_floor_pct": 90.0},
                 "2021-01-04", "2026-09-04", slippage_bps=15.0)

    python3 scripts/research/fast_sim.py            # validation table
    python3 scripts/research/fast_sim.py --rebuild  # force panel rebuild
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, get_symbol_info  # noqa: E402
from risk_policy import assess_portfolio_risk  # noqa: E402
from backtest.data_provider import BarProvider  # noqa: E402
from backtest.metrics import compute_metrics  # noqa: E402

PANEL_DIR = PROJECT_ROOT / "state" / "research"
PANEL_SCHEMA_VERSION = 3

# Infrastructure removed from the ranking universe by engine.py:1710.
_INFRASTRUCTURE = frozenset({"SPY", "SH", "SSO", "TQQQ", "UPRO", "BIL"})
_SPY = "SPY"

# adaptive_momentum.AdaptiveMomentumConfig defaults that config_from_params
# does NOT expose.  They fix the panel's window geometry; changing one changes
# the panel cache key.
DEFAULT_WINDOWS = {
    "lookback_days": 252,
    "skip_recent_days": 21,
    "medium_lookback_days": 126,
    "trend_days": 200,
    "volatility_days": 63,
    "liquidity_days": 60,
    "max_calendar_gap_days": 10,
}

_RISK_RANK = {"NORMAL": 0, "CAUTIOUS": 1, "HALT": 2}
_RISK_SCALER = {"NORMAL": 1.0, "CAUTIOUS": 0.5, "HALT": 0.0}


# ───────────────────────────── panel construction ──────────────────────────


@dataclass
class Panel:
    """Precomputed point-in-time signal panel, indexed by (date, symbol)."""

    dates: np.ndarray            # (T,)  '%Y-%m-%d', SPY's full calendar
    symbols: np.ndarray          # (N,)  ranking universe, alphabetical
    sectors: np.ndarray          # (N,)
    open_: np.ndarray            # (T,N) float64, NaN where no bar
    close: np.ndarray            # (T,N)
    mom12: np.ndarray            # (T,N) 12-1 momentum, percent
    mom6: np.ndarray             # (T,N) 6-1 momentum, percent
    vol63: np.ndarray            # (T,N) annualized volatility, percent
    dvol60: np.ndarray           # (T,N) 60-session median dollar volume
    sma200: np.ndarray           # (T,N)
    above200: np.ndarray         # (T,N) bool, close > sma200
    valid: np.ndarray            # (T,N) bool, analyze_symbol returns a signal
    has_bar: np.ndarray          # (T,N) bool
    spy_open: np.ndarray         # (T,)
    spy_close: np.ndarray        # (T,)
    spy_above200: np.ndarray     # (T,) bool
    spy_vol63: np.ndarray        # (T,)
    spy_valid: np.ndarray        # (T,) bool, compute_market_state != None
    spy_regime: np.ndarray       # (T,) 'BULL'/'NEUTRAL'/'BEAR' raw classifier
    windows: dict[str, int] = field(default_factory=dict)

    _index: dict[str, int] | None = None
    _sym_index: dict[str, int] | None = None

    def date_index(self, date: str) -> int:
        if self._index is None:
            self._index = {d: i for i, d in enumerate(self.dates.tolist())}
        return self._index[date]

    def symbol_index(self, symbol: str) -> int:
        if self._sym_index is None:
            self._sym_index = {s: i for i, s in enumerate(self.symbols.tolist())}
        return self._sym_index[symbol]


def default_universe(provider: BarProvider | None = None) -> list[str]:
    """The ranking universe the engine resolves (engine.py:1695-1711)."""

    from universe import load_universe_symbols  # local: keeps import cost off cold paths

    provider = provider or BarProvider()
    available = set(provider.available_symbols())
    universe = [s for s in load_universe_symbols(held_symbols=[]) if s in available]
    return [s for s in universe if s not in _INFRASTRUCTURE]


def _rolling(arr: np.ndarray, window: int) -> np.ndarray:
    """Sliding windows; row i holds arr[i-window+1 : i+1]."""

    return np.lib.stride_tricks.sliding_window_view(arr, window)


def _symbol_features(
    closes: np.ndarray,
    volumes: np.ndarray,
    day_numbers: np.ndarray,
    w: dict[str, int],
) -> dict[str, np.ndarray]:
    """Point-in-time features on ONE symbol's own bar sequence.

    Index ``i`` is the symbol's own i-th bar.  Every window is positional on
    that sequence, which is exactly what ``bars_up_to(...).iloc[-k:]`` slices.
    """

    n = closes.shape[0]
    lookback = w["lookback_days"]          # 252
    skip = w["skip_recent_days"]           # 21
    medium = w["medium_lookback_days"]     # 126
    trend = w["trend_days"]                # 200
    vol_days = w["volatility_days"]        # 63
    liq_days = w["liquidity_days"]         # 60
    required = max(lookback + 1, trend, vol_days + 1, liq_days)  # 253

    out = {k: np.full(n, np.nan) for k in ("mom12", "mom6", "vol63", "dvol60", "sma200")}
    out["valid"] = np.zeros(n, dtype=bool)
    if n == 0:
        return out

    # 12-1 and 6-1: _period_return_pct(closes, L, skip) reads window[-(L+1):],
    # start = window[0] (position i-L), end = window[-(skip+1)] (position i-skip).
    if n > lookback:
        out["mom12"][lookback:] = (
            closes[lookback - skip : n - skip] / closes[: n - lookback] - 1.0
        ) * 100.0
    if n > medium:
        out["mom6"][medium:] = (
            closes[medium - skip : n - skip] / closes[: n - medium] - 1.0
        ) * 100.0

    # 63-session annualized volatility from 63 simple returns (64 closes).
    if n > vol_days:
        rets = closes[1:] / closes[:-1] - 1.0                    # index j -> bar j+1
        win = _rolling(rets, vol_days)                            # row k -> rets[k:k+63]
        std = win.std(axis=-1, ddof=1)
        out["vol63"][vol_days:] = std * math.sqrt(252.0) * 100.0

    # SMA200 over the trailing `trend` closes.
    if n >= trend:
        out["sma200"][trend - 1 :] = _rolling(closes, trend).mean(axis=-1)

    # 60-session median dollar volume.
    if n >= liq_days:
        out["dvol60"][liq_days - 1 :] = np.median(
            _rolling(closes * volumes, liq_days), axis=-1
        )

    # analyze_symbol's own gates, in order (adaptive_momentum.py:277-321):
    #   len(bars) >= 253; last bar dated exactly as_of (implicit: this bar);
    #   last 253 closes finite and > 0; contiguous epoch over those 253 dates;
    #   last 60 volumes finite and >= 0; sma200 finite > 0;
    #   momentum_long / momentum_medium / annual_vol all computable.
    if n < required:
        return out
    ok = np.zeros(n, dtype=bool)
    ok[required - 1 :] = True

    close_bad = ~(np.isfinite(closes) & (closes > 0))
    if close_bad.any():
        bad_run = _rolling(close_bad.astype(np.int64), required).sum(axis=-1)
        ok[required - 1 :] &= bad_run == 0
    vol_bad = ~(np.isfinite(volumes) & (volumes >= 0))
    if vol_bad.any():
        bad_run = _rolling(vol_bad.astype(np.int64), liq_days).sum(axis=-1)
        ok[liq_days - 1 :] &= bad_run == 0

    # _has_contiguous_signal_epoch over the required-length date window.
    gaps = np.diff(day_numbers)
    if gaps.size:
        max_gap = _rolling(gaps, required - 1).max(axis=-1)
        ok[required - 1 :] &= max_gap <= w["max_calendar_gap_days"]

    ok &= np.isfinite(out["sma200"]) & (out["sma200"] > 0)
    ok &= np.isfinite(out["mom12"]) & np.isfinite(out["mom6"])
    ok &= np.isfinite(out["vol63"]) & (out["vol63"] > 0)
    out["valid"] = ok
    return out


def _panel_key(symbols: Sequence[str], bars_dir: Path, windows: dict[str, int]) -> str:
    files = sorted(bars_dir.glob("*.json"))
    stamp = hashlib.sha256()
    stamp.update(f"v{PANEL_SCHEMA_VERSION}|".encode())
    stamp.update(json.dumps(windows, sort_keys=True).encode())
    stamp.update("|".join(symbols).encode())
    for path in files:
        st = path.stat()
        stamp.update(f"{path.name}:{st.st_mtime_ns}:{st.st_size};".encode())
    return stamp.hexdigest()[:16]


def build_panel(
    symbols: Sequence[str] | None = None,
    *,
    provider: BarProvider | None = None,
    windows: dict[str, int] | None = None,
) -> Panel:
    provider = provider or BarProvider()
    w = {**DEFAULT_WINDOWS, **(windows or {})}
    symbols = sorted({s.upper().strip() for s in (symbols or default_universe(provider))})

    spy_df = provider.load(_SPY)
    if spy_df is None or spy_df.empty:
        raise RuntimeError("SPY bars are required to build the panel")
    dates = np.array([str(d) for d in spy_df.index], dtype=object)
    t_index = {d: i for i, d in enumerate(dates.tolist())}
    T = len(dates)
    N = len(symbols)

    shape = (T, N)
    open_ = np.full(shape, np.nan)
    close = np.full(shape, np.nan)
    mom12 = np.full(shape, np.nan)
    mom6 = np.full(shape, np.nan)
    vol63 = np.full(shape, np.nan)
    dvol60 = np.full(shape, np.nan)
    sma200 = np.full(shape, np.nan)
    valid = np.zeros(shape, dtype=bool)
    has_bar = np.zeros(shape, dtype=bool)

    epoch = np.datetime64("1970-01-01")

    def day_numbers(index) -> np.ndarray:
        return (np.array([np.datetime64(str(d)) for d in index]) - epoch).astype("int64")

    for j, sym in enumerate(symbols):
        df = provider.load(sym)
        if df is None or df.empty:
            continue
        idx = [str(d) for d in df.index]
        rows = np.array([t_index[d] for d in idx if d in t_index], dtype=np.int64)
        keep = np.array([d in t_index for d in idx], dtype=bool)
        if rows.size == 0:
            continue
        c = df["close"].to_numpy(dtype=float)[keep]
        o = df["open"].to_numpy(dtype=float)[keep]
        v = df["volume"].to_numpy(dtype=float)[keep]
        feats = _symbol_features(c, v, day_numbers([d for d in idx if d in t_index]), w)
        open_[rows, j] = o
        close[rows, j] = c
        mom12[rows, j] = feats["mom12"]
        mom6[rows, j] = feats["mom6"]
        vol63[rows, j] = feats["vol63"]
        dvol60[rows, j] = feats["dvol60"]
        sma200[rows, j] = feats["sma200"]
        valid[rows, j] = feats["valid"]
        has_bar[rows, j] = True

    with np.errstate(invalid="ignore"):
        above200 = close > sma200

    # ── SPY market state + raw regime classifier ──────────────────────────
    spy_close = spy_df["close"].to_numpy(dtype=float)
    spy_open = spy_df["open"].to_numpy(dtype=float)
    spy_feats = _symbol_features(
        spy_close, spy_df["volume"].to_numpy(dtype=float), day_numbers(spy_df.index), w
    )
    trend = w["trend_days"]
    vol_days = w["volatility_days"]
    spy_sma200 = spy_feats["sma200"]
    spy_vol63 = spy_feats["vol63"]
    # compute_market_state needs max(trend, vol_days+1) own bars, finite closes,
    # a contiguous epoch, and a finite positive price/sma200/vol.
    required_market = max(trend, vol_days + 1)
    spy_valid = np.zeros(T, dtype=bool)
    spy_valid[required_market - 1 :] = True
    gaps = np.diff(day_numbers(spy_df.index))
    if gaps.size >= required_market - 1:
        spy_valid[required_market - 1 :] &= (
            _rolling(gaps, required_market - 1).max(axis=-1)
            <= w["max_calendar_gap_days"]
        )
    spy_valid &= np.isfinite(spy_sma200) & (spy_sma200 > 0)
    spy_valid &= np.isfinite(spy_vol63) & (spy_vol63 > 0)
    spy_valid &= np.isfinite(spy_close) & (spy_close > 0)
    with np.errstate(invalid="ignore"):
        spy_above200 = spy_close > spy_sma200

    # engine._spy_regime: SMA20/SMA50 on the last completed close.
    regime = np.full(T, "NEUTRAL", dtype=object)
    if T >= 50:
        sma20 = np.full(T, np.nan)
        sma50 = np.full(T, np.nan)
        sma20[19:] = _rolling(spy_close, 20).mean(axis=-1)
        sma50[49:] = _rolling(spy_close, 50).mean(axis=-1)
        with np.errstate(invalid="ignore"):
            bull = (spy_close > sma20) & (sma20 > sma50)
            bear = (spy_close < sma20) & (sma20 < sma50)
        regime[bull] = "BULL"
        regime[bear] = "BEAR"
        regime[:49] = "NEUTRAL"  # len(bars) < 50 -> NEUTRAL

    # engine._sector_for_symbol -> static watchlist metadata.  The engine falls
    # back to adaptive_momentum.infer_sector_from_returns for "Unknown" names;
    # that path is not reproduced here, so refuse to build a panel that would
    # need it rather than silently allocating under the wrong sector cap.
    sector_list = [
        get_symbol_info(s).get("sector", "Unknown") or "Unknown" for s in symbols
    ]
    unknown = [s for s, sec in zip(symbols, sector_list) if sec == "Unknown"]
    if unknown:
        raise RuntimeError(
            "fast_sim does not reproduce infer_sector_from_returns; "
            f"{len(unknown)} ranking symbols lack a static sector "
            f"(e.g. {unknown[:8]}). Use the authoritative engine instead."
        )
    sectors = np.array(sector_list, dtype=object)

    return Panel(
        dates=dates, symbols=np.array(symbols, dtype=object), sectors=sectors,
        open_=open_, close=close, mom12=mom12, mom6=mom6, vol63=vol63,
        dvol60=dvol60, sma200=sma200, above200=above200, valid=valid,
        has_bar=has_bar, spy_open=spy_open, spy_close=spy_close,
        spy_above200=spy_above200, spy_vol63=spy_vol63, spy_valid=spy_valid,
        spy_regime=regime, windows=w,
    )


def load_panel(
    symbols: Sequence[str] | None = None,
    *,
    provider: BarProvider | None = None,
    windows: dict[str, int] | None = None,
    rebuild: bool = False,
    cache_dir: Path = PANEL_DIR,
) -> Panel:
    """Load the cached panel, rebuilding when bars/universe/windows change."""

    provider = provider or BarProvider()
    w = {**DEFAULT_WINDOWS, **(windows or {})}
    syms = sorted({s.upper().strip() for s in (symbols or default_universe(provider))})
    key = _panel_key(syms, provider.bars_dir, w)
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / f"fast_sim_panel_{key}.npz"

    if path.exists() and not rebuild:
        try:
            z = np.load(path, allow_pickle=True)
            return Panel(
                dates=z["dates"], symbols=z["symbols"], sectors=z["sectors"],
                open_=z["open_"], close=z["close"], mom12=z["mom12"],
                mom6=z["mom6"], vol63=z["vol63"], dvol60=z["dvol60"],
                sma200=z["sma200"], above200=z["above200"], valid=z["valid"],
                has_bar=z["has_bar"], spy_open=z["spy_open"],
                spy_close=z["spy_close"], spy_above200=z["spy_above200"],
                spy_vol63=z["spy_vol63"], spy_valid=z["spy_valid"],
                spy_regime=z["spy_regime"], windows=json.loads(str(z["windows"])),
            )
        except Exception:  # corrupt/partial cache: rebuild rather than guess
            pass

    panel = build_panel(syms, provider=provider, windows=w)
    # np.savez appends ".npz" unless given a file object, so write through a
    # handle and rename atomically.
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as fh:
        _savez(fh, panel)
    tmp.replace(path)
    return panel


def _savez(fh, panel: Panel) -> None:
    np.savez(
        fh,
        dates=panel.dates, symbols=panel.symbols, sectors=panel.sectors,
        open_=panel.open_, close=panel.close, mom12=panel.mom12, mom6=panel.mom6,
        vol63=panel.vol63, dvol60=panel.dvol60, sma200=panel.sma200,
        above200=panel.above200, valid=panel.valid, has_bar=panel.has_bar,
        spy_open=panel.spy_open, spy_close=panel.spy_close,
        spy_above200=panel.spy_above200, spy_vol63=panel.spy_vol63,
        spy_valid=panel.spy_valid, spy_regime=panel.spy_regime,
        windows=json.dumps(panel.windows),
    )


# ──────────────────────────── strategy configuration ───────────────────────


@dataclass(frozen=True)
class FastConfig:
    """Mirror of adaptive_momentum.config_from_params for the panel replay."""

    top_n: int = 10
    hold_rank_n: int = 10
    min_positions: int = 8
    min_price_usd: float = 10.0
    min_median_dollar_volume_usd: float = 25_000_000.0
    max_annual_volatility_pct: float = 80.0
    max_position_pct: float = 9.0
    max_sector_pct: float = 20.0
    max_gross_exposure_pct: float = 90.0
    target_market_volatility_pct: float = 15.0
    min_volatility_scaler: float = 0.25
    use_market_volatility_scaling: bool = False
    use_breadth_scaling: bool = True
    risk_on_reentry_confirmation_days: int = 1
    risk_off_confirmation_days: int = 0
    below_sma200_floor_pct: float = 0.0
    weighting_scheme: str = "equal"
    residual_parking: str = "cash"
    require_sector_classification: bool = True


# Overrides this simulator actually reads.
_CONSUMED_KEYS = frozenset({
    "momentum_top_n", "momentum_hold_rank_n", "momentum_min_positions",
    "momentum_min_price_usd", "momentum_min_dollar_volume_usd",
    "momentum_max_annual_vol_pct", "max_position_pct", "momentum_max_sector_pct",
    "min_cash_pct", "momentum_target_market_vol_pct",
    "momentum_use_market_volatility_scaling", "momentum_use_breadth_scaling",
    "momentum_risk_on_reentry_days", "momentum_below_sma200_floor_pct",
    "momentum_risk_off_confirm_days",
    "momentum_weighting_scheme", "momentum_residual_parking",
})

# Overrides the engine honours but this simulator does NOT implement.  Setting
# one of these would make the fast result silently disagree with the engine,
# so they are refused instead.
_UNSUPPORTED_KEYS = frozenset({
    "adaptive_momentum", "momentum_mode",
    "base_pct", "spy_base_pct", "base_instrument",
    "tqqq_pct", "upro_pct", "cash_sleeve_pct", "cash_sleeve_instrument",
    "sector_rotation_pct", "sector_rotation_top_n",
    "pead_sleeve_pct", "enable_pead", "enable_mean_reversion",
    "enable_options_hedge", "flatten_on_transition",
})

# Overrides that are provably inert while ``adaptive_momentum`` is True:
# engine.py:1811 skips the whole stop/scale-out/time-stop stack, engine.py:1936
# computes ``block_buys`` but never passes it to the adaptive branch, and the
# score-driven knobs belong to the legacy v3-v5 path only.
_INERT_KEYS = frozenset({
    "trailing_stop_pct", "tightened_stop_pct", "scale_out_at_gain",
    "final_target_gain", "time_stop_days", "block_new_buys", "max_positions",
    "score_threshold", "gate_score_min", "min_hold_days", "max_cash_pct",
    "cash_starve_bonus", "momentum_min_hold_days", "momentum_quality_filter",
    "momentum_min_abs_return", "strategy_version", "risk_per_trade_pct",
    "position_size_pct",
})


def _check_overrides(overrides: dict[str, Any] | None) -> None:
    bad = sorted(set(overrides or {}) & _UNSUPPORTED_KEYS)
    if bad:
        raise ValueError(
            "fast_sim does not implement these engine sleeves, so it cannot "
            f"answer for them: {bad}. Run scripts/backtest/engine.py instead."
        )
    unknown = sorted(
        set(overrides or {}) - _CONSUMED_KEYS - _UNSUPPORTED_KEYS - _INERT_KEYS
    )
    if unknown:
        raise ValueError(
            f"unrecognised override key(s) {unknown}. Check what engine.py does "
            "with them, then add each to _CONSUMED_KEYS, _INERT_KEYS or "
            "_UNSUPPORTED_KEYS. Refusing to guess."
        )


def config_from_overrides(overrides: dict[str, Any] | None) -> FastConfig:
    """Resolve _V11_POLICY + research overrides the way _resolve_params does.

    ``engine._resolve_params`` starts from ``get_strategy_params(regime, tier)``
    — which already applies ``_V11_POLICY`` — then patches with the ``"*"``
    override block.  Every knob ``config_from_params`` reads lives in
    ``_V11_POLICY``, so the result is regime- and tier-independent.
    """

    from strategy_config import get_strategy_params  # local: avoids import cycles

    _check_overrides(overrides)
    params = dict(get_strategy_params("NEUTRAL", "NORMAL"))
    params.update(overrides or {})
    top_n = int(params.get("momentum_top_n", 10))
    return FastConfig(
        top_n=top_n,
        hold_rank_n=max(top_n, int(params.get("momentum_hold_rank_n", top_n))),
        min_positions=int(params.get("momentum_min_positions", 8)),
        min_price_usd=float(params.get("momentum_min_price_usd", 10.0)),
        min_median_dollar_volume_usd=float(
            params.get("momentum_min_dollar_volume_usd", 25_000_000.0)
        ),
        max_annual_volatility_pct=float(params.get("momentum_max_annual_vol_pct", 80.0)),
        max_position_pct=float(params.get("max_position_pct", 9.0)),
        max_sector_pct=float(params.get("momentum_max_sector_pct", 20.0)),
        max_gross_exposure_pct=max(0.0, 100.0 - float(params.get("min_cash_pct", 10.0))),
        target_market_volatility_pct=float(
            params.get("momentum_target_market_vol_pct", 15.0)
        ),
        use_market_volatility_scaling=bool(
            params.get("momentum_use_market_volatility_scaling", False)
        ),
        use_breadth_scaling=bool(params.get("momentum_use_breadth_scaling", False)),
        risk_on_reentry_confirmation_days=max(
            0, int(params.get("momentum_risk_on_reentry_days", 0))
        ),
        risk_off_confirmation_days=max(
            0, int(params.get("momentum_risk_off_confirm_days", 0))
        ),
        below_sma200_floor_pct=max(
            0.0, float(params.get("momentum_below_sma200_floor_pct", 0.0))
        ),
        weighting_scheme=str(params.get("momentum_weighting_scheme", "equal")),
        residual_parking=str(params.get("momentum_residual_parking", "cash")).strip().lower(),
    )


# ──────────────────────── selection + allocation on the panel ──────────────


class _Scanner:
    """Per-date eligibility, ranking, breadth and selection over the panel."""

    def __init__(self, panel: Panel, cfg: FastConfig):
        self.p = panel
        self.cfg = cfg
        p, c = panel, cfg
        with np.errstate(invalid="ignore"):
            price_ok = p.close >= c.min_price_usd
            dv_ok = (
                np.isfinite(p.dvol60)
                & (p.dvol60 > 0)
                & (p.dvol60 >= c.min_median_dollar_volume_usd)
            )
            vol_ok = p.vol63 <= c.max_annual_volatility_pct
            mom_ok = p.mom12 > 0.0
        sector_ok = np.array(
            [
                (not c.require_sector_classification)
                or (bool(s) and s != "Unknown")
                for s in p.sectors.tolist()
            ],
            dtype=bool,
        )[None, :]
        self.liquid = p.valid & price_ok & dv_ok
        self.eligible = self.liquid & vol_ok & sector_ok & p.above200 & mom_ok
        self.n_eligible = self.eligible.sum(axis=1)
        liquid_n = self.liquid.sum(axis=1)
        above_n = (self.liquid & p.above200).sum(axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            self.breadth = np.where(liquid_n > 0, above_n / np.maximum(liquid_n, 1) * 100.0, np.nan)
        self.sector_key = self._sector_keys()
        self._sel_cache: dict[tuple[int, tuple[str, ...]], list[int]] = {}

    def _sector_keys(self) -> list[str]:
        """_sector_bucket: 'Unknown' names get a private per-symbol bucket."""

        out = []
        for sym, sec in zip(self.p.symbols.tolist(), self.p.sectors.tolist()):
            sec = (sec or "Unknown").strip()
            out.append(f"Unknown:{sym}" if sec == "Unknown" else sec)
        return out

    def ranked(self, t: int) -> np.ndarray:
        """Eligible symbol indices ordered by (-mom12, -mom6, symbol)."""

        idx = np.flatnonzero(self.eligible[t])
        if idx.size == 0:
            return idx
        order = np.lexsort((idx, -self.p.mom6[t, idx], -self.p.mom12[t, idx]))
        return idx[order]

    def selected(self, t: int, incumbents: Iterable[str] = ()) -> list[int]:
        """select_diversified() — greedy rank walk under the sector cap."""

        cfg = self.cfg
        retention_limit = max(cfg.top_n, cfg.hold_rank_n)
        inc: tuple[str, ...] = ()
        if retention_limit > cfg.top_n:
            inc = tuple(sorted({str(s).upper().strip() for s in incumbents if s}))
        key = (t, inc)
        hit = self._sel_cache.get(key)
        if hit is not None:
            return hit

        if cfg.top_n <= 0:
            self._sel_cache[key] = []
            return []
        ranked = self.ranked(t)
        priority: Sequence[int] = ranked
        if retention_limit > cfg.top_n and inc:
            inc_set = set(inc)
            head = [i for i in ranked[:retention_limit] if self.p.symbols[i] in inc_set]
            head_set = set(head)
            priority = head + [i for i in ranked if i not in head_set]

        slot = min(cfg.max_gross_exposure_pct / 100.0 / cfg.top_n, cfg.max_position_pct / 100.0)
        sector_cap = cfg.max_sector_pct / 100.0
        used: dict[str, float] = {}
        out: list[int] = []
        for i in priority:
            bucket = self.sector_key[i]
            if used.get(bucket, 0.0) + slot > sector_cap + 1e-12:
                continue
            out.append(int(i))
            used[bucket] = used.get(bucket, 0.0) + slot
            if len(out) >= cfg.top_n:
                break
        self._sel_cache[key] = out
        return out

    def target_gross(self, t: int, risk_tier: str) -> float:
        """_target_gross_weight()."""

        cfg = self.cfg
        p = self.p
        if not p.spy_valid[t]:
            return 0.0
        below = not bool(p.spy_above200[t])
        if below and cfg.below_sma200_floor_pct <= 0.0:
            return 0.0
        vol_scaler = 1.0
        if cfg.use_market_volatility_scaling:
            vol_scaler = min(
                1.0,
                max(
                    cfg.min_volatility_scaler,
                    cfg.target_market_volatility_pct / float(p.spy_vol63[t]),
                ),
            )
        breadth_scaler = 1.0
        if cfg.use_breadth_scaling:
            b = self.breadth[t]
            if not np.isfinite(b):
                breadth_scaler = 0.5
            elif b >= 60.0:
                breadth_scaler = 1.0
            elif b >= 45.0:
                breadth_scaler = 0.80
            elif b >= 30.0:
                breadth_scaler = 0.55
            else:
                breadth_scaler = 0.25
        div = min(1.0, int(self.n_eligible[t]) / max(1, cfg.min_positions))
        gross = (
            cfg.max_gross_exposure_pct / 100.0
            * vol_scaler * breadth_scaler * div
            * _RISK_SCALER.get(risk_tier.upper(), 0.0)
        )
        cap = cfg.max_gross_exposure_pct / 100.0
        if below:
            cap = min(cap, cfg.below_sma200_floor_pct / 100.0)
            gross = min(gross, cap)
        return max(0.0, min(cap, gross))

    def weights(self, t: int, risk_tier: str, incumbents: Iterable[str] = ()) -> dict[str, float]:
        """build_target_portfolio() -> target weight map."""

        gross = self.target_gross(t, risk_tier)
        chosen = self.selected(t, incumbents)
        if not chosen or gross <= 0:
            return {}
        syms = [str(self.p.symbols[i]) for i in chosen]
        buckets = [self.sector_key[i] for i in chosen]
        if self.cfg.weighting_scheme == "equal":
            raw = None
        elif self.cfg.weighting_scheme == "inverse_volatility":
            raw = [1.0 / max(float(self.p.vol63[t, i]) / 100.0, 1e-6) for i in chosen]
        else:
            raise ValueError(f"Unsupported weighting scheme: {self.cfg.weighting_scheme}")
        return _allocate(syms, buckets, gross, self.cfg.max_position_pct,
                         self.cfg.max_sector_pct, raw)


def _allocate(
    symbols: list[str],
    buckets: list[str],
    target_gross: float,
    max_position_pct: float,
    max_sector_pct: float,
    raw: list[float] | None,
) -> dict[str, float]:
    """Port of allocate_equal_weight / allocate_inverse_volatility.

    ``raw=None`` reproduces the equal-weight allocator (which differs from the
    inverse-vol one in its ``active`` predicate and in using an equal split
    rather than a raw-weight split).
    """

    if not symbols or target_gross <= 0:
        return {}
    max_position = max_position_pct / 100.0
    max_sector = max_sector_pct / 100.0
    weights = {s: 0.0 for s in symbols}
    bucket_of = dict(zip(symbols, buckets))
    raw_of = dict(zip(symbols, raw)) if raw is not None else None

    for _ in range(100):
        remaining = target_gross - sum(weights.values())
        if remaining <= 1e-10:
            break
        sector_used: dict[str, float] = {}
        for s, weight in weights.items():
            b = bucket_of[s]
            sector_used[b] = sector_used.get(b, 0.0) + weight
        if raw_of is None:
            active = [
                s for s in weights
                if weights[s] < max_position - 1e-10
                and sector_used.get(bucket_of[s], 0.0) < max_sector - 1e-10
            ]
        else:
            active = [
                s for s in weights
                if max_position - weights[s] > 1e-10
                and max_sector - sector_used.get(bucket_of[s], 0.0) > 1e-10
            ]
        if not active:
            break
        if raw_of is None:
            equal_add = remaining / len(active)
            proposed = {s: min(equal_add, max_position - weights[s]) for s in active}
        else:
            raw_total = sum(raw_of[s] for s in active)
            if raw_total <= 0:
                break
            proposed = {
                s: min(remaining * raw_of[s] / raw_total, max_position - weights[s])
                for s in active
            }
        sector_proposed: dict[str, float] = {}
        for s, amount in proposed.items():
            b = bucket_of[s]
            sector_proposed[b] = sector_proposed.get(b, 0.0) + amount
        added = 0.0
        for s in active:
            b = bucket_of[s]
            room = max_sector - sector_used.get(b, 0.0)
            total_for_sector = sector_proposed[b]
            scale = min(1.0, room / total_for_sector) if total_for_sector > 0 else 0.0
            amount = max(0.0, proposed[s] * scale)
            weights[s] += amount
            added += amount
        if added <= 1e-10:
            break
    return {s: v for s, v in weights.items() if v > 1e-8}


# ─────────────────────────────── portfolio replay ──────────────────────────


class _Position:
    __slots__ = ("symbol", "entry_date", "qty", "avg", "price", "is_base")

    def __init__(self, symbol, entry_date, qty, price, is_base=False):
        self.symbol = symbol
        self.entry_date = entry_date
        self.qty = qty
        self.avg = price
        self.price = price
        self.is_base = is_base

    @property
    def market_value(self) -> float:
        return self.qty * self.price


class _Book:
    """SimulatedPortfolio, minus the sleeves V11 never uses."""

    def __init__(self, starting_cash: float):
        self.starting_cash = starting_cash
        self.cash = starting_cash
        self.positions: dict[str, _Position] = {}
        self.trades: list[dict] = []
        self.history: list[dict] = []

    def equity(self) -> float:
        return self.cash + sum(p.market_value for p in self.positions.values())

    def open(self, symbol, qty, fill, date, is_base=False) -> bool:
        if qty <= 0 or fill <= 0:
            return False
        cost = qty * fill
        if cost > self.cash:
            return False
        p = self.positions.get(symbol)
        if p is not None:
            total = p.qty + qty
            p.avg = ((p.qty * p.avg) + (qty * fill)) / total
            p.qty = total
            p.price = fill          # portfolio_sim re-marks the WHOLE position
        else:
            self.positions[symbol] = _Position(symbol, date, qty, fill, is_base)
        self.cash -= cost
        return True

    def _record(self, p: _Position, qty, fill, date, reason):
        pnl = (fill - p.avg) * qty
        self.trades.append({
            "symbol": p.symbol, "entry_date": p.entry_date, "exit_date": date,
            "qty": qty, "entry_price": p.avg, "exit_price": fill, "pnl": pnl,
            "pnl_pct": (fill / p.avg - 1) * 100 if p.avg > 0 else 0.0,
            "reason": reason, "is_hedge": False, "is_base": p.is_base,
        })

    def close(self, symbol, fill, date, reason):
        p = self.positions.get(symbol)
        if p is None:
            return
        self.cash += p.qty * fill
        self._record(p, p.qty, fill, date, reason)
        del self.positions[symbol]

    def partial_close(self, symbol, qty, fill, date, reason):
        p = self.positions.get(symbol)
        if p is None or qty <= 0 or qty >= p.qty:
            return
        self.cash += qty * fill
        self._record(p, qty, fill, date, reason)
        p.qty -= qty

    def snapshot(self, date, regime, risk_tier):
        equity = self.equity()
        prev = self.history[-1]["equity"] if self.history else self.starting_cash
        pnl = equity - prev
        self.history.append({
            "date": date, "equity": equity, "cash": self.cash,
            "cash_pct": (self.cash / equity * 100) if equity > 0 else 0.0,
            "num_positions": sum(1 for p in self.positions.values() if not p.is_base),
            "pnl": pnl, "pnl_pct": (pnl / prev * 100) if prev > 0 else 0.0,
            "regime": regime, "risk_tier": risk_tier,
        })


def _completed_session_risk_tier(book: _Book) -> str:
    hist = book.history
    if not hist:
        return "NORMAL"
    current = hist[-1]["equity"]
    previous = hist[-2]["equity"] if len(hist) >= 2 else book.starting_cash
    prior = [book.starting_cash, *(h["equity"] for h in hist[:-1])]
    return assess_portfolio_risk(
        current, previous_equity=previous, prior_equities=prior
    ).tier


# ────────────────────────────────── the loop ───────────────────────────────


def _simulate(
    panel: Panel,
    cfg: FastConfig,
    *,
    start: str,
    end: str,
    starting_cash: float,
    slippage_bps: float,
) -> dict:
    dates = panel.dates.tolist()
    lo = next((i for i, d in enumerate(dates) if d >= start), len(dates))
    hi = next((i for i in range(len(dates) - 1, -1, -1) if dates[i] <= end), -1)
    if lo > hi:
        raise RuntimeError(f"No SPY bars available between {start} and {end}")

    scanner = _Scanner(panel, cfg)
    book = _Book(starting_cash)
    buy_mult = 1.0 + slippage_bps / 10_000.0
    sell_mult = 1.0 - slippage_bps / 10_000.0
    sym_list = panel.symbols.tolist()

    pending: dict | None = None
    latched = False
    regime_history: list[str] = []
    confirmed: str | None = None
    park = cfg.residual_parking if cfg.residual_parking in {"cash", "spy_always", "spy_risk_off"} else "cash"

    for t in range(lo, hi + 1):
        date = dates[t]
        if t == 0:
            book.snapshot(date, "NEUTRAL", "NORMAL")
            continue
        s = t - 1                                   # signal date index
        risk_tier = _completed_session_risk_tier(book)

        # Today's tradeable opens.  A symbol without a bar today is absent from
        # `opens`, exactly as bar_at() returns None (engine.py:1762-1768).
        open_row = panel.open_[t]
        bar_row = panel.has_bar[t]
        spy_open_today = float(panel.spy_open[t])

        # 1. mark to market at today's OPEN, only for symbols that trade today.
        for sym, pos in book.positions.items():
            if sym == _SPY:
                pos.price = spy_open_today
                continue
            j = scanner_index(panel, sym)
            if bar_row[j]:
                pos.price = float(open_row[j])

        # Regime label (engine.py:1773-1794).  Does not affect V11 decisions.
        raw = str(panel.spy_regime[s])
        regime_history.append(raw)
        if len(regime_history) > 3:
            regime_history.pop(0)
        if confirmed is None:
            confirmed = raw
        elif raw != confirmed:
            recent = regime_history[-3:]
            if len(recent) >= 3 and all(r == raw for r in recent):
                confirmed = raw
        regime = confirmed

        # 2. risk-off latch + one-shot risk-on re-entry (engine.py:1937-1975).
        gate_risk_off = _gate_risk_off(panel, s, cfg)
        risk_off_now = (risk_tier == "HALT") or gate_risk_off
        if risk_off_now:
            latched = True
        elif any(not p.is_base for p in book.positions.values()) and not (
            pending is not None and pending.get("risk_off") is True
        ):
            latched = False
        force_reentry = bool(
            latched and not risk_off_now
            and cfg.risk_on_reentry_confirmation_days > 0
            and _reentry_confirmed(panel, s, cfg.risk_on_reentry_confirmation_days)
            and pending is None
        )

        # 3. residual parking (engine.py:544-620), a no-op in the default mode.
        if park != "cash":
            _park_residual(book, panel, t, s, cfg, park, buy_mult, sell_mult, date)

        pending = _rebalance(
            book, scanner, panel, cfg, t, s, date, risk_tier, pending,
            force_reentry, buy_mult, sell_mult,
            prev_date=(dates[t - 1] if t > lo else None),
        )
        if force_reentry:
            latched = False

        book.snapshot(date, regime, risk_tier)

    return {
        "config": {
            "start_date": dates[lo], "end_date": dates[hi],
            "starting_cash": starting_cash, "slippage_bps": slippage_bps,
            "universe_size": len(sym_list),
            "strategy_version": "v11-adaptive-momentum",
            "signal_timing": "prior-close-to-next-open",
            "engine": "research.fast_sim",
        },
        "starting_cash": starting_cash,
        "final_equity": book.equity(),
        "final_cash": book.cash,
        "daily_history": book.history,
        "closed_trades": book.trades,
        "open_positions": [
            {"symbol": p.symbol, "qty": p.qty, "avg_entry_price": p.avg,
             "current_price": p.price, "is_base": p.is_base}
            for p in book.positions.values()
        ],
    }


def scanner_index(panel: Panel, symbol: str) -> int:
    """Column index of ``symbol`` in this panel.

    Delegates to ``Panel.symbol_index``, which memoizes on the instance. This
    function previously kept its OWN cache in a module-level dict keyed on
    ``id(panel)`` — a second copy of a lookup the panel already did correctly.
    CPython reissues a freed object's address, so a sweep that builds a
    535-symbol panel, drops it, and builds a 530-symbol panel could inherit the
    first panel's column map and mark every position to a DIFFERENT symbol's
    open. A universe sweep is exactly that access pattern, the in-range case
    yields plausible wrong numbers rather than an error, and universe sweeps are
    the measurements whose entire purpose is to be trusted.
    """
    return panel.symbol_index(symbol)


GATE_SEARCH_DEPTH = 120          # matches adaptive_momentum.market_gate_state


def _gate_risk_off(panel: Panel, s: int, cfg: FastConfig) -> bool:
    """Is the SPY-SMA200 market gate engaged at signal index ``s``?

    ``risk_off_confirmation_days <= 0`` is V11: ``market is None or not
    market.above_sma200``.

    Above that this ports ``adaptive_momentum.market_gate_state``, which is a
    stateless hysteresis: the state changes only when the last N completed
    closes agree, and when they disagree the answer is whichever state was last
    CONFIRMED — found by walking back for the most recent unanimous window.

    A previous version of this function ported an earlier draft of that
    function whose disagreement branch returned ``not above[-1]``, i.e. the
    newest observation. That collapsed all three branches to V11's answer and
    made the parameter do nothing, which is worse than not supporting it: the
    search would have swept a knob that silently had no effect and concluded it
    did not matter. The reviewing agent caught it by noticing the collapse.
    """

    days = cfg.risk_off_confirmation_days
    if days <= 0:
        return (not bool(panel.spy_valid[s])) or (not bool(panel.spy_above200[s]))
    days = max(1, days)
    required = panel.windows["trend_days"] + days - 1
    if s + 1 < required or not bool(panel.spy_valid[s]):
        return True                      # None -> callers treat as risk-off

    above = panel.spy_above200
    oldest = max(days, s + 1 - GATE_SEARCH_DEPTH - days)
    for end in range(s + 1, oldest - 1, -1):
        seg = above[end - days : end]
        if len(seg) < days:
            break
        if bool(seg.all()):
            return False
        if not bool(seg.any()):
            return True
    # Nothing unanimous in the searchable history: no confirmed state to hold,
    # so hold the safe one.
    return True


def _reentry_confirmed(panel: Panel, s: int, days: int) -> bool:
    """market_reentry_confirmed(): SPY above its SMA200 for `days` sessions."""

    if days <= 0 or s - days + 1 < 0:
        return False
    if not panel.spy_valid[s]:
        return False
    return bool(np.all(panel.spy_above200[s - days + 1 : s + 1]))


def _park_residual(book, panel, t, s, cfg, mode, buy_mult, sell_mult, date) -> None:
    equity = book.equity()
    if equity <= 0 or not np.isfinite(panel.spy_open[t]):
        return
    if not panel.spy_valid[s]:
        return
    below = not bool(panel.spy_above200[s])
    if below:
        intended = cfg.below_sma200_floor_pct / 100.0
    elif mode == "spy_always":
        intended = cfg.max_gross_exposure_pct / 100.0
    else:
        intended = 1.0
    target_value = max(0.0, equity * (1.0 - intended) - equity * 0.005)
    pos = book.positions.get(_SPY)
    current = pos.market_value if (pos is not None and pos.is_base) else 0.0
    delta = target_value - current
    if abs(delta) / equity * 100.0 < 2.0:
        return
    if delta > 0:
        fill = float(panel.spy_open[t]) * buy_mult
        qty = int(min(delta, book.cash) / fill)
        if qty >= 1:
            book.open(_SPY, qty, fill, date, is_base=True)
        return
    if pos is None:
        return
    fill = float(panel.spy_open[t]) * sell_mult
    qty = int(abs(delta) / fill)
    if qty >= pos.qty:
        book.close(_SPY, fill, date, "residual_unpark")
    elif qty >= 1:
        book.partial_close(_SPY, qty, fill, date, "residual_trim")


def _rebalance(
    book: _Book, scanner: _Scanner, panel: Panel, cfg: FastConfig,
    t: int, s: int, date: str, risk_tier: str, pending: dict | None,
    force_reentry: bool, buy_mult: float, sell_mult: float, prev_date: str | None,
) -> dict | None:
    """Port of engine._execute_adaptive_momentum (engine.py:1305-1538)."""

    open_row = panel.open_[t]
    bar_row = panel.has_bar[t]

    def has_open(sym: str) -> bool:
        return sym != _SPY and bool(bar_row[scanner_index(panel, sym)])

    def open_px(sym: str) -> float:
        return float(open_row[scanner_index(panel, sym)])

    # engine.py:1329-1343. Note `market is None` stays a separate term in
    # risk_off_now, and at confirmation_days == 0 `below_sma200` is False when
    # the market state is missing (the None case is caught by that term).
    market_ok = bool(panel.spy_valid[s])
    if cfg.risk_off_confirmation_days > 0:
        below = _gate_risk_off(panel, s, cfg)
    else:
        below = market_ok and not bool(panel.spy_above200[s])
    hard_gate = below and (cfg.below_sma200_floor_pct <= 0.0 or risk_tier == "HALT")
    risk_off_now = (risk_tier == "HALT") or (not market_ok) or hard_gate
    pending_risk_off = bool(pending is not None and pending.get("risk_off") is True)

    if risk_off_now or pending_risk_off:
        unresolved = []
        for sym in list(book.positions):
            if book.positions[sym].is_base:
                continue
            if not has_open(sym):
                unresolved.append(sym)
                continue
            book.close(sym, open_px(sym) * sell_mult, date, "adaptive_risk_off")
        if unresolved:
            return {
                "signal_date": (pending.get("signal_date") if pending_risk_off
                                else panel.dates[s]),
                "weights": {}, "construction_risk_tier": "HALT",
                "buy_after_date": None,
                "rebalance_month": (pending.get("rebalance_month", date[:7])
                                    if pending_risk_off else date[:7]),
                "risk_off": True,
            }
        return None

    rebalance_month = date[:7]
    stale = bool(
        pending is not None
        and pending.get("rebalance_month", rebalance_month) != rebalance_month
    )
    if stale:
        pending = None

    if pending is not None:
        target_weights = dict(pending.get("weights", {}))
        construction_tier = str(pending.get("construction_risk_tier", "HALT"))
        if _RISK_RANK.get(risk_tier, 2) > _RISK_RANK.get(construction_tier, 2):
            t_sig = panel.date_index(str(pending["signal_date"]))
            target_weights = scanner.weights(t_sig, risk_tier, incumbents=target_weights)
            pending = {**pending, "weights": target_weights,
                       "construction_risk_tier": risk_tier}
    else:
        is_month_start = prev_date is None or prev_date[:7] != date[:7]
        if not stale and not force_reentry and not is_month_start:
            return None
        incumbents = [sym for sym, p in book.positions.items() if not p.is_base]
        target_weights = scanner.weights(s, risk_tier, incumbents=incumbents)
        pending = {
            "signal_date": panel.dates[s], "weights": target_weights,
            "construction_risk_tier": risk_tier, "buy_after_date": None,
            "rebalance_month": rebalance_month,
        }

    equity = book.equity()
    if equity <= 0:
        return None
    drift_value = equity * 0.005

    # Sell leg: drop names outside the target, trim overweights.
    sell_required = False
    for sym in list(book.positions):
        pos = book.positions[sym]
        if pos.is_base:
            continue
        target_value = equity * target_weights.get(sym, 0.0)
        excess = pos.market_value - target_value
        if sym not in target_weights:
            sell_required = True
            if not has_open(sym):
                continue
            book.close(sym, open_px(sym) * sell_mult, date, "adaptive_rebalance_exit")
            continue
        if excess <= drift_value:
            continue
        if not has_open(sym):
            sell_required = True
            continue
        fill = open_px(sym) * sell_mult
        qty = min(pos.qty, int(excess / fill))
        if qty <= 0:
            continue
        sell_required = True
        if qty >= pos.qty:
            book.close(sym, fill, date, "adaptive_rebalance_trim")
        else:
            book.partial_close(sym, qty, fill, date, "adaptive_rebalance_trim")

    if sell_required:
        return {**pending, "buy_after_date": date}
    if pending.get("buy_after_date") == date:
        return pending

    # Buy leg.  NOTE: drift_value is deliberately NOT recomputed here — the
    # engine reuses the pre-sell value (engine.py:1464 vs 1512).
    equity = book.equity()
    for sym, weight in sorted(target_weights.items(), key=lambda kv: (-kv[1], kv[0])):
        if not has_open(sym):
            continue
        pos = book.positions.get(sym)
        current = pos.market_value if pos else 0.0
        shortfall = equity * weight - current
        if shortfall <= drift_value:
            continue
        fill = open_px(sym) * buy_mult
        qty = min(int(shortfall / fill), int(book.cash / fill))
        if qty > 0:
            book.open(sym, qty, fill, date)

    equity = book.equity()
    drift_value = equity * 0.005
    for sym, weight in target_weights.items():
        pos = book.positions.get(sym)
        current = pos.market_value if pos else 0.0
        if equity * weight - current > drift_value:
            return pending
    return None


# ────────────────────────────────── public API ─────────────────────────────

_PANEL_CACHE: dict[tuple, Panel] = {}


def simulate(
    config_dict: dict[str, Any] | None = None,
    start: str = "2021-01-04",
    end: str = "2026-09-04",
    slippage_bps: float = 15.0,
    universe: Sequence[str] | None = None,
    *,
    starting_cash: float = 1_000_000.0,
    provider: BarProvider | None = None,
    with_result: bool = False,
) -> dict:
    """Run one V11 variant on the cached panel and return metrics.

    ``config_dict`` uses the same keys as ``BacktestConfig.param_overrides``'s
    ``"*"`` block — e.g. ``{"momentum_below_sma200_floor_pct": 90.0}``.  The
    returned dict has the keys of ``backtest.metrics.compute_metrics`` plus
    ``fast_sim_seconds``; pass ``with_result=True`` to also get the raw
    ``result`` payload (daily_history / closed_trades) under ``"result"``.
    """

    t0 = time.time()
    provider = provider or _shared_provider()
    key = (tuple(universe) if universe is not None else None,)
    panel = _PANEL_CACHE.get(key)
    if panel is None:
        panel = load_panel(universe, provider=provider)
        _PANEL_CACHE[key] = panel
    cfg = config_from_overrides(config_dict)
    result = _simulate(
        panel, cfg, start=start, end=end,
        starting_cash=starting_cash, slippage_bps=slippage_bps,
    )
    metrics = compute_metrics(result, provider)
    metrics["fast_sim_seconds"] = round(time.time() - t0, 3)
    metrics["final_equity"] = result["final_equity"]
    if with_result:
        metrics["result"] = result
    return metrics


_PROVIDER: BarProvider | None = None


def _shared_provider() -> BarProvider:
    global _PROVIDER
    if _PROVIDER is None:
        _PROVIDER = BarProvider()
    return _PROVIDER


# ─────────────────────────────── validation table ──────────────────────────

VALIDATION_START = "2021-01-04"
VALIDATION_END = "2026-09-04"

# Authoritative scripts/backtest/engine.py results for the CURRENT _V11_POLICY.
#
# Re-recorded 2026-09-08 when the policy changed (below_sma200_floor 0 -> 75,
# max_sector_pct 20 -> 40). "Baseline" means the shipped policy, so these move
# whenever it does — and the table reported a 77% error against the previous
# policy's numbers until they were updated. Every row was measured by running
# scripts/backtest/engine.py, not by copying what this file produced.
REFERENCE = [
    {"name": "baseline 15bps", "overrides": {}, "slippage": 15.0,
     "annual_return_pct": 29.4587, "excess_cagr_pct": 14.3443,
     "max_drawdown_pct": -23.1348, "final_equity": 4_301_602},
    {"name": "baseline 7bps", "overrides": {}, "slippage": 7.0,
     "annual_return_pct": 30.3891, "excess_cagr_pct": 15.2747,
     "max_drawdown_pct": -23.0299, "final_equity": 4_479_239},
    # The floor saturates: at the shipped 75 the breadth and diversification
    # scalers already hold gross below 90, so raising the cap changes nothing.
    {"name": "floor 90 (saturated) 15bps",
     "overrides": {"momentum_below_sma200_floor_pct": 90.0}, "slippage": 15.0,
     "annual_return_pct": 29.4587, "excess_cagr_pct": 14.3443,
     "max_drawdown_pct": -23.1348, "final_equity": 4_301_602},
    {"name": "floor 50 15bps",
     "overrides": {"momentum_below_sma200_floor_pct": 50.0}, "slippage": 15.0,
     "annual_return_pct": 27.88, "excess_cagr_pct": 12.77,
     "max_drawdown_pct": -26.02, "final_equity": 4_014_139},
]

KNOWN_DIVERGENCES = [
    "Non-V11 engine sleeves are not implemented: SPY/SSO base, SH hedge, TQQQ, "
    "UPRO, SGOV cash sleeve, PEAD, sector rotation, trailing/tightened stops, "
    "scale-outs, time stops, catalyst flips, flatten-on-transition. Every one "
    "is zeroed or disabled by _V11_POLICY, so overriding any of them makes "
    "this simulator silently WRONG rather than slow.",
    "Dynamic sector inference (adaptive_momentum.infer_sector_from_returns) is "
    "not implemented. It is dead code on this universe -- all 535 ranking "
    "symbols carry a static watchlist sector -- and the panel asserts that.",
    "Window geometry (252/21/126/200/63/60) is baked into the cached panel. "
    "Changing a lookback needs a panel rebuild with new `windows`, not just a "
    "config override.",
    "The `regime` label is reproduced for metrics.regime_breakdown only; V11 "
    "decisions are regime-independent because _V11_POLICY overrides every "
    "regime cell.",
    "Rolling statistics are computed with numpy sliding windows rather than "
    "pandas per-slice reductions. Measured agreement against analyze_symbol on "
    "550 sampled (symbol, date) cells was EXACT (0.000e+00 relative error on "
    "12-1, 6-1, vol63, median dollar volume and price), but a future universe "
    "could still resolve an exact threshold tie (vol == 80.0, price == "
    "SMA200) differently.",
    "`momentum_risk_off_confirm_days` is a port of another agent's in-flight "
    "adaptive_momentum.market_gate_state, whose semantics already changed once "
    "mid-session. It is verified by `--check-gate` (0 mismatches over 921 "
    "sessions x 5 confirmation values at the time of writing); re-run that "
    "before trusting a search that varies it.",
    "Slippage is a single per-side bps figure applied to the official open, "
    "exactly as the engine does. Neither simulator models per-symbol spread, "
    "market impact, partial fills, or borrow -- so both share this optimism.",
]


def _fmt(value, width=12, spec=",.2f"):
    if value is None:
        return " " * width
    return f"{value:>{width}{spec}}"


def _validate(rebuild: bool = False, start: str = VALIDATION_START,
              end: str = VALIDATION_END) -> int:
    provider = _shared_provider()
    t0 = time.time()
    panel = load_panel(provider=provider, rebuild=rebuild)
    _PANEL_CACHE[(None,)] = panel
    print(f"panel: {panel.close.shape[0]} dates x {panel.close.shape[1]} symbols "
          f"loaded in {time.time() - t0:.2f}s")
    print(f"window: {start} -> {end}\n")

    header = (f"{'config':<28}{'CAGR%':>9}{'ref':>9}{'excess':>9}{'ref':>9}"
              f"{'maxDD%':>9}{'ref':>9}{'final $':>13}{'ref $':>13}{'err%':>8}{'sec':>7}")
    print(header)
    print("-" * len(header))
    worst = 0.0
    for ref in REFERENCE:
        m = simulate(ref["overrides"], start, end, ref["slippage"])
        fe = m["final_equity"]
        err = (fe / ref["final_equity"] - 1.0) * 100.0
        worst = max(worst, abs(err))
        print(
            f"{ref['name']:<28}"
            f"{m['annual_return_pct']:>9.2f}{ref['annual_return_pct']:>9.2f}"
            f"{m['excess_cagr_pct']:>9.2f}{ref['excess_cagr_pct']:>9.2f}"
            f"{m['max_drawdown_pct']:>9.2f}{ref['max_drawdown_pct']:>9.2f}"
            f"{fe:>13,.0f}{ref['final_equity']:>13,.0f}"
            f"{err:>+8.2f}{m['fast_sim_seconds']:>7.2f}"
        )
    print("-" * len(header))
    print(f"worst final-equity error: {worst:+.2f}%")
    print("\nKNOWN DIVERGENCES")
    for line in KNOWN_DIVERGENCES:
        print(f"  - {line}")
    return 0


def calendar_years(metrics: dict, provider: BarProvider | None = None) -> list[dict]:
    """Per-calendar-year portfolio return against SPY on BOTH benchmark clocks.

    Requires ``simulate(..., with_result=True)``.

    ``excess_pct`` uses the open-to-open, forward-filled SPY baseline that
    ``backtest.metrics._asset_baseline`` builds (metrics.py:60-90) — the same
    benchmark behind ``excess_cagr_pct``.  ``excess_close_pct`` uses plain
    close-to-close SPY.  They are NOT interchangeable: over 2021-2026 the two
    conventions disagree by 0.3-0.9pp per year, which is enough to flip the
    sign of a marginal year.  Report which one you used.
    """

    result = metrics["result"]
    history = result["daily_history"]
    spy_line = metrics["spy_baseline_equity"]
    start_cash = result["starting_cash"]

    provider = provider or _shared_provider()
    spy_df = provider.load(_SPY)
    closes = {str(d): float(c) for d, c in zip(spy_df.index, spy_df["close"])}
    spy_dates = [str(d) for d in spy_df.index]

    def prior_close(date: str) -> float:
        prior = [d for d in spy_dates if d < date]
        return closes[prior[-1]] if prior else closes[spy_dates[0]]

    bounds: list[tuple[str, int, int]] = []
    year = None
    start_i = 0
    for i, snap in enumerate(history):
        y = snap["date"][:4]
        if year is None:
            year, start_i = y, i
        elif y != year:
            bounds.append((year, start_i, i - 1))
            year, start_i = y, i
    if year is not None and history:
        bounds.append((year, start_i, len(history) - 1))

    rows: list[dict] = []
    prev_p, prev_s = start_cash, start_cash
    for y, first_i, last_i in bounds:
        p, s = history[last_i]["equity"], spy_line[last_i]
        c_end = closes[history[last_i]["date"]]
        c_start = prior_close(history[first_i]["date"])
        rows.append({
            "year": y,
            "portfolio_return_pct": (p / prev_p - 1) * 100,
            "spy_return_pct": (s / prev_s - 1) * 100,
            "excess_pct": (p / prev_p - s / prev_s) * 100,
            "spy_close_return_pct": (c_end / c_start - 1) * 100,
            "excess_close_pct": (p / prev_p - c_end / c_start) * 100,
        })
        prev_p, prev_s = p, s
    return rows


def compare_to_engine_run(ref_path: str | Path, overrides: dict | None = None) -> dict:
    """Day-by-day / trade-by-trade diff against a saved run_backtest() result.

    The reference JSON must be the dict ``engine.run_backtest`` returns (plus
    an optional ``metrics`` block).  This is the check that actually proves
    agreement; the summary table only proves the four headline numbers.
    """

    ref = json.loads(Path(ref_path).read_text())
    conf = ref["config"]
    fast = simulate(
        overrides or {}, conf["start_date"], conf["end_date"],
        conf["slippage_bps"], starting_cash=conf.get("starting_cash", 1_000_000.0),
        with_result=True,
    )
    res = fast["result"]
    ref_hist = {h["date"]: h["equity"] for h in ref["daily_history"]}
    fast_hist = {h["date"]: h["equity"] for h in res["daily_history"]}
    shared = sorted(set(ref_hist) & set(fast_hist))
    worst_rel, worst_date, first_div = 0.0, None, None
    for d in shared:
        a, b = ref_hist[d], fast_hist[d]
        rel = abs(b - a) / max(1.0, abs(a))
        if rel > 1e-9 and first_div is None:
            first_div = d
        if rel > worst_rel:
            worst_rel, worst_date = rel, d
    key = lambda t: (t["exit_date"], t["symbol"], t["qty"])  # noqa: E731
    ref_tr, fast_tr = sorted(ref["closed_trades"], key=key), sorted(res["closed_trades"], key=key)
    trade_diffs = sum(
        1 for a, b in zip(ref_tr, fast_tr)
        if key(a) != key(b)
        or abs(a["exit_price"] - b["exit_price"]) > 1e-9
        or abs(a["entry_price"] - b["entry_price"]) > 1e-6
    ) + abs(len(ref_tr) - len(fast_tr))
    return {
        "sessions_compared": len(shared),
        "dates_match": set(ref_hist) == set(fast_hist),
        "first_divergent_session": first_div,
        "worst_relative_equity_diff": worst_rel,
        "worst_relative_equity_date": worst_date,
        "ref_final_equity": ref["final_equity"],
        "fast_final_equity": res["final_equity"],
        "final_equity_error_pct": (res["final_equity"] / ref["final_equity"] - 1) * 100,
        "ref_trades": len(ref_tr),
        "fast_trades": len(fast_tr),
        "trade_diffs": trade_diffs,
    }


def check_gate_port(days_list: Sequence[int] = (2, 3, 5, 10, 20),
                   start: str = VALIDATION_START, end: str = VALIDATION_END) -> dict:
    """Re-verify ``_gate_risk_off`` against the live ``market_gate_state``.

    The confirmation knob is in-flight work whose semantics already changed
    once mid-session, and an earlier port of it silently collapsed to V11's
    answer. Run this before trusting any search that varies
    ``momentum_risk_off_confirm_days``.
    """

    from adaptive_momentum import (  # local: research-only dependency
        AdaptiveMomentumConfig, market_gate_state,
    )

    provider = _shared_provider()
    panel = _PANEL_CACHE.get((None,))
    if panel is None:
        panel = load_panel(provider=provider)
        _PANEL_CACHE[(None,)] = panel
    dates = panel.dates.tolist()
    window = [i for i, d in enumerate(dates) if start <= d <= end]
    report: dict = {}
    for days in days_list:
        am_cfg = AdaptiveMomentumConfig(risk_off_confirmation_days=int(days))
        fast_cfg = config_from_overrides({"momentum_risk_off_confirm_days": int(days)})
        mismatches: list[str] = []
        engaged = 0
        for s_idx in window:
            live = market_gate_state(
                provider, dates[s_idx], confirmation_days=int(days), config=am_cfg
            )
            live_off = True if live is None else bool(live)
            fast_off = _gate_risk_off(panel, s_idx, fast_cfg)
            engaged += int(live_off)
            if live_off != fast_off:
                mismatches.append(dates[s_idx])
        report[int(days)] = {
            "sessions": len(window),
            "risk_off_sessions": engaged,
            "mismatches": len(mismatches),
            "first_mismatches": mismatches[:5],
        }
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="V11 fast research simulator")
    ap.add_argument("--rebuild", action="store_true", help="force a panel rebuild")
    ap.add_argument("--start", default=VALIDATION_START)
    ap.add_argument("--end", default=VALIDATION_END)
    ap.add_argument("--compare", metavar="REF.json",
                    help="diff against a saved engine.run_backtest() result")
    ap.add_argument("--overrides", default="{}",
                    help="JSON override block to use with --compare")
    ap.add_argument("--check-gate", action="store_true",
                    help="verify the risk-off confirmation port against the "
                         "live adaptive_momentum.market_gate_state")
    args = ap.parse_args(argv)
    if args.check_gate:
        report = check_gate_port(start=args.start, end=args.end)
        bad = 0
        for days, row in report.items():
            print(f"confirm_days={days:>3}  sessions={row['sessions']}  "
                  f"risk_off={row['risk_off_sessions']:>4}  "
                  f"mismatches={row['mismatches']}  {row['first_mismatches']}")
            bad += row["mismatches"]
        print("GATE PORT OK" if bad == 0 else f"GATE PORT DIVERGES on {bad} sessions")
        return 0 if bad == 0 else 1
    if args.compare:
        report = compare_to_engine_run(args.compare, json.loads(args.overrides))
        for k, v in report.items():
            print(f"{k:<32} {v}")
        return 0 if report["trade_diffs"] == 0 and report["worst_relative_equity_diff"] < 1e-9 else 1
    return _validate(rebuild=args.rebuild, start=args.start, end=args.end)


if __name__ == "__main__":
    raise SystemExit(main())
