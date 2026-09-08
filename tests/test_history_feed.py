"""Cached history must come from the consolidated tape.

V11 admits a candidate only when its 60-session median dollar volume clears
$25m, so the volume field is a strategy input. IEX is one exchange holding a low
single-digit share of volume: re-deriving that filter from IEX-only figures
takes the eligible universe from 523 of 563 symbols to somewhere between 149 and
64, depending on the haircut.

The failure mode is what makes this worth pinning. A feed swap arrives as a
routine data refresh, changes no code, produces no error, and silently rewrites
which stocks the strategy is allowed to hold.
"""

from __future__ import annotations

import inspect

from alpaca.data.enums import DataFeed

from backtest import download_history


def test_alpaca_history_uses_the_consolidated_tape():
    source = inspect.getsource(download_history.fetch_bars)
    assert "DataFeed.SIP" in source
    assert "DataFeed.IEX" not in source


def test_the_yfinance_fallback_is_only_reached_without_credentials():
    """The fallback returns consolidated figures too, so both paths agree.

    If this ever became a silent fallback on an API error instead of on absent
    credentials, a rebuild could mix two bases inside one cache.
    """
    source = inspect.getsource(download_history.fetch_bars)
    guard = source.split("return fetch_bars_yfinance")[0]
    assert "if not ALPACA_API_KEY or not ALPACA_SECRET_KEY:" in guard


def test_sip_is_a_real_feed_in_the_pinned_sdk():
    assert DataFeed.SIP.value == "sip"
