"""Point-in-time bar access for the backtest engine.

The engine asks for "bars for SYMBOL up to and including DATE" and the
provider returns only the slice that existed *as of that date*. This is
the single line of defence against look-ahead bias — if the engine never
sees future bars, it can't accidentally use them.

Bars are loaded once per symbol and kept in memory for the duration of
the backtest (~35 symbols × ~1500 days × ~100 bytes = a few MB, trivial).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, setup_logging  # noqa: E402

log = setup_logging("backtest_data")

BARS_DIR = PROJECT_ROOT / "state" / "backtest" / "bars"


class BarProvider:
    """In-memory cache of daily bars keyed by symbol.

    DataFrame schema: index=date (string YYYY-MM-DD), columns=[open, high, low, close, volume].
    Sorted ascending. Use slicing methods — never index by position with
    integer offsets relative to "today".
    """

    def __init__(self, bars_dir: Path = BARS_DIR):
        self.bars_dir = bars_dir
        self._cache: dict[str, pd.DataFrame] = {}
        self._day_cache: dict[
            str,
            dict[str, tuple[float, float, float, float, int]],
        ] = {}

    def available_symbols(self) -> list[str]:
        if not self.bars_dir.exists():
            return []
        return sorted(p.stem for p in self.bars_dir.glob("*.json"))

    def load(self, symbol: str) -> pd.DataFrame | None:
        """Load a symbol's bars (cached)."""
        if symbol in self._cache:
            return self._cache[symbol]

        path = self.bars_dir / f"{symbol}.json"
        if not path.exists():
            log.warning(f"{symbol}: no cached bars at {path}")
            self._cache[symbol] = None
            return None

        data = json.loads(path.read_text())
        bars = data.get("bars", [])
        if not bars:
            self._cache[symbol] = None
            return None

        df = pd.DataFrame(bars)
        df["date"] = df["date"].astype(str)
        df = df.set_index("date").sort_index()
        # Ensure numeric dtypes
        for col in ("open", "high", "low", "close", "volume"):
            if col in df.columns:
                df[col] = pd.to_numeric(df[col])

        self._cache[symbol] = df
        return df

    def bars_up_to(self, symbol: str, date: str, lookback_days: int | None = None) -> pd.DataFrame:
        """Return bars for `symbol` with date ≤ `date`. Slice from the right.

        `lookback_days` (optional) caps the slice — e.g., 80 for indicator
        warmup. None = entire history up to date.
        """
        df = self.load(symbol)
        if df is None or df.empty:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        sliced = df.loc[df.index <= date]
        if lookback_days is not None and len(sliced) > lookback_days:
            sliced = sliced.iloc[-lookback_days:]
        return sliced

    def bar_at(self, symbol: str, date: str) -> dict | None:
        """Return the bar at exactly `date`, or None if not a trading day."""
        if symbol not in self._day_cache:
            df = self.load(symbol)
            if df is None or df.empty:
                self._day_cache[symbol] = {}
            else:
                self._day_cache[symbol] = {
                    str(index): (
                        float(open_price),
                        float(high),
                        float(low),
                        float(close),
                        int(volume),
                    )
                    for index, open_price, high, low, close, volume in df[
                        ["open", "high", "low", "close", "volume"]
                    ].itertuples(index=True, name=None)
                }
        values = self._day_cache[symbol].get(date)
        if values is None:
            return None
        open_price, high, low, close, volume = values
        return {
            "date": date,
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }

    def next_trading_day(self, symbol: str, date: str) -> str | None:
        """The earliest trading day strictly after `date`, per `symbol`'s calendar.

        SPY is the safest reference since it trades every NYSE session.
        Returns None when `date` is at or past the last available bar.
        """
        df = self.load(symbol)
        if df is None or df.empty:
            return None
        after = df.loc[df.index > date]
        if after.empty:
            return None
        return str(after.index[0])

    def previous_trading_day(self, symbol: str, date: str) -> str | None:
        """The latest available session strictly before ``date``.

        Trading decisions formed for date D must never see D's close.  Keeping
        this calendar lookup in the provider makes that invariant explicit and
        avoids the old first-loop fallback that used the current session.
        """
        df = self.load(symbol)
        if df is None or df.empty:
            return None
        before = df.loc[df.index < date]
        if before.empty:
            return None
        return str(before.index[-1])

    def all_trading_days(self, reference_symbol: str = "SPY",
                         start: str | None = None, end: str | None = None) -> list[str]:
        """Trading-day calendar between dates, taken from reference symbol's index.

        We use SPY by default since it trades every NYSE session and has full
        coverage. Both bounds inclusive.
        """
        df = self.load(reference_symbol)
        if df is None or df.empty:
            return []
        idx = df.index
        if start is not None:
            idx = idx[idx >= start]
        if end is not None:
            idx = idx[idx <= end]
        return list(idx)
