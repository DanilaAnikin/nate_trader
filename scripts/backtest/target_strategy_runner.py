"""Research-only runner for causal target-weight strategies.

The production execution engine deliberately has no dependency on this
module.  It provides a small, strategy-agnostic harness for comparing target
weight policies with identical execution assumptions:

* a target is formed from session D's completed data;
* orders fill at session D+1's official open;
* every buy and sell pays the configured, constant basis-point friction;
* sells complete before replacement buys, with a one-session boundary; and
* a target remains frozen while missing bars or cash settlement leave it
  unconverged.

Strategies are ordinary duck-typed objects with ``name``,
``should_rebalance(context)`` and ``build_target(context)``.  They may also
provide ``risk_off(context) -> bool | None``.  A true result replaces any
pending risk-on target with a frozen zero-weight target; false/None does not
cancel an already-latched liquidation.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
import math
from types import MappingProxyType
from typing import Protocol, runtime_checkable

import pandas as pd

from backtest.data_provider import BarProvider
from backtest.metrics import compute_metrics
from backtest.portfolio_sim import SimulatedPortfolio
from risk_policy import assess_portfolio_risk


@dataclass(frozen=True, slots=True)
class TargetBacktestConfig:
    """Immutable execution settings for one research strategy run."""

    start_date: str
    end_date: str
    universe: tuple[str, ...]
    starting_cash: float = 1_000_000.0
    slippage_bps: float = 15.0
    reference_symbol: str = "SPY"
    convergence_tolerance_weight: float = 0.001
    execution_delay_sessions: int = 1

    def __post_init__(self) -> None:
        object.__setattr__(self, "universe", tuple(dict.fromkeys(self.universe)))
        if not self.universe:
            raise ValueError("universe must contain at least one symbol")
        if any(not isinstance(symbol, str) or not symbol for symbol in self.universe):
            raise ValueError("universe symbols must be non-empty strings")
        for field_name in ("starting_cash", "slippage_bps"):
            value = float(getattr(self, field_name))
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{field_name} must be finite and nonnegative")
            object.__setattr__(self, field_name, value)
        if self.starting_cash <= 0:
            raise ValueError("starting_cash must be positive")
        tolerance = float(self.convergence_tolerance_weight)
        if not math.isfinite(tolerance) or not 0 <= tolerance < 1:
            raise ValueError(
                "convergence_tolerance_weight must be finite and in [0, 1)"
            )
        object.__setattr__(self, "convergence_tolerance_weight", tolerance)
        if not isinstance(self.reference_symbol, str) or not self.reference_symbol:
            raise ValueError("reference_symbol must be a non-empty string")
        if (
            type(self.execution_delay_sessions) is not int
            or self.execution_delay_sessions < 1
        ):
            raise ValueError("execution_delay_sessions must be an integer >= 1")


@dataclass(frozen=True, slots=True)
class PositionSnapshot:
    """Read-only incumbent position state exposed to a strategy."""

    symbol: str
    entry_date: str
    qty: int
    avg_entry_price: float
    current_price: float
    market_value: float
    weight: float


class PointInTimeBarProvider:
    """Read-only ``BarProvider`` view that cannot reveal data after ``as_of``.

    Merely passing an ``as_of`` string to a strategy is not a sufficient
    look-ahead guard: a buggy candidate could ask the underlying provider for
    ``today`` or call ``load()``.  This facade caps every price-bearing method
    and returns copies of frames so candidate code cannot mutate the shared
    cache.
    """

    __slots__ = ("__provider", "__as_of")

    def __init__(self, provider: BarProvider, as_of: str):
        object.__setattr__(self, "_PointInTimeBarProvider__provider", provider)
        object.__setattr__(self, "_PointInTimeBarProvider__as_of", str(as_of))

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError(f"{type(self).__name__} is immutable")

    @property
    def as_of(self) -> str:
        return self.__as_of

    @property
    def cache_identity(self) -> int:
        """Opaque stable identity for safe cross-run research signal caches."""

        return id(self.__provider)

    def available_symbols(self) -> list[str]:
        return self.__provider.available_symbols()

    def load(self, symbol: str) -> pd.DataFrame | None:
        bars = self.bars_up_to(symbol, self.as_of)
        return None if bars.empty else bars

    def bars_up_to(
        self,
        symbol: str,
        date: str,
        lookback_days: int | None = None,
    ) -> pd.DataFrame:
        effective_date = min(str(date), self.as_of)
        return self.__provider.bars_up_to(
            symbol,
            effective_date,
            lookback_days=lookback_days,
        ).copy(deep=True)

    def bar_at(self, symbol: str, date: str) -> dict | None:
        if str(date) > self.as_of:
            return None
        bar = self.__provider.bar_at(symbol, str(date))
        return dict(bar) if bar is not None else None

    def previous_trading_day(self, symbol: str, date: str) -> str | None:
        bars = self.bars_up_to(symbol, min(str(date), self.as_of))
        before = bars.loc[bars.index < str(date)]
        if before.empty:
            return None
        return str(before.index[-1])

    def next_trading_day(self, symbol: str, date: str) -> str | None:
        bars = self.bars_up_to(symbol, self.as_of)
        after = bars.loc[bars.index > str(date)]
        if after.empty:
            return None
        return str(after.index[0])

    def all_trading_days(
        self,
        reference_symbol: str = "SPY",
        start: str | None = None,
        end: str | None = None,
    ) -> list[str]:
        effective_end = self.as_of if end is None else min(str(end), self.as_of)
        return self.__provider.all_trading_days(
            reference_symbol,
            start=start,
            end=effective_end,
        )


@dataclass(frozen=True, slots=True)
class StrategyContext:
    """Immutable information available when forming a prior-close target."""

    provider: PointInTimeBarProvider
    as_of: str
    today: str
    universe: tuple[str, ...]
    incumbent_symbols: frozenset[str]
    incumbent_positions: Mapping[str, PositionSnapshot]
    session_index: int
    risk_tier: str

    @property
    def signal_date(self) -> str:
        return self.as_of

    @property
    def fill_date(self) -> str:
        return self.today


@runtime_checkable
class TargetStrategy(Protocol):
    """Minimum duck interface implemented by tournament candidates."""

    name: str

    def should_rebalance(self, context: StrategyContext) -> bool:
        ...

    def build_target(self, context: StrategyContext) -> Mapping[str, float]:
        ...


class TargetValidationError(ValueError):
    """Raised before execution when a candidate emits an unsafe target."""


@dataclass(frozen=True, slots=True)
class _PendingTarget:
    weights: Mapping[str, float]
    signal_date: str
    created_session_index: int
    execute_not_before_session_index: int
    buy_not_before_session_index: int
    risk_off: bool = False


def _completed_session_risk_tier(portfolio: SimulatedPortfolio) -> str:
    """Return the shared risk tier without observing the current fill open."""

    history = portfolio.daily_history
    if not history:
        return "NORMAL"
    current = history[-1].equity
    previous = history[-2].equity if len(history) >= 2 else portfolio.starting_cash
    prior = [portfolio.starting_cash, *(row.equity for row in history[:-1])]
    return assess_portfolio_risk(
        current,
        previous_equity=previous,
        prior_equities=prior,
    ).tier


def _context(
    *,
    provider: BarProvider,
    portfolio: SimulatedPortfolio,
    universe: tuple[str, ...],
    signal_date: str,
    fill_date: str,
    session_index: int,
    risk_tier: str,
) -> StrategyContext:
    equity = portfolio.equity()
    snapshots = {
        symbol: PositionSnapshot(
            symbol=symbol,
            entry_date=position.entry_date,
            qty=position.qty,
            avg_entry_price=position.avg_entry_price,
            current_price=position.current_price,
            market_value=position.market_value,
            weight=(position.market_value / equity if equity > 0 else 0.0),
        )
        for symbol, position in sorted(portfolio.positions.items())
    }
    return StrategyContext(
        provider=PointInTimeBarProvider(provider, signal_date),
        as_of=signal_date,
        today=fill_date,
        universe=universe,
        incumbent_symbols=frozenset(snapshots),
        incumbent_positions=MappingProxyType(snapshots),
        session_index=session_index,
        risk_tier=risk_tier,
    )


def _validated_target(
    raw_target: Mapping[str, float],
    universe: tuple[str, ...],
) -> Mapping[str, float]:
    if not isinstance(raw_target, Mapping):
        raise TargetValidationError("build_target() must return a mapping")

    allowed = set(universe)
    weights: dict[str, float] = {}
    for symbol, raw_weight in raw_target.items():
        if not isinstance(symbol, str) or not symbol:
            raise TargetValidationError("target symbols must be non-empty strings")
        if symbol not in allowed:
            raise TargetValidationError(f"target symbol {symbol!r} is outside universe")
        if isinstance(raw_weight, bool):
            raise TargetValidationError(f"target weight for {symbol} must be numeric")
        try:
            weight = float(raw_weight)
        except (TypeError, ValueError) as exc:
            raise TargetValidationError(
                f"target weight for {symbol} must be numeric"
            ) from exc
        if not math.isfinite(weight):
            raise TargetValidationError(f"target weight for {symbol} must be finite")
        if weight < 0:
            raise TargetValidationError(
                f"target weight for {symbol} must be nonnegative"
            )
        if weight > 0:
            weights[symbol] = weight

    total = math.fsum(weights.values())
    if total > 1.0 + 1e-12:
        raise TargetValidationError(
            f"target gross weight must be <= 1.0 (received {total:.12g})"
        )
    return MappingProxyType(dict(sorted(weights.items())))


def _open_prices(
    provider: BarProvider,
    symbols: Sequence[str],
    date: str,
) -> dict[str, float]:
    prices: dict[str, float] = {}
    for symbol in dict.fromkeys(symbols):
        bar = provider.bar_at(symbol, date)
        if bar is None:
            continue
        try:
            price = float(bar["open"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(price) and price > 0:
            prices[symbol] = price
    return prices


def _buy_fill(open_price: float, slippage_bps: float) -> float:
    return open_price * (1.0 + slippage_bps / 10_000.0)


def _sell_fill(open_price: float, slippage_bps: float) -> float:
    return open_price * (1.0 - slippage_bps / 10_000.0)


def _material_value(equity: float, tolerance_weight: float) -> float:
    return max(0.01, equity * tolerance_weight)


def _execute_pending_target(
    *,
    portfolio: SimulatedPortfolio,
    pending: _PendingTarget,
    opens: Mapping[str, float],
    date: str,
    session_index: int,
    slippage_bps: float,
    tolerance_weight: float,
    order_log: list[dict[str, object]],
) -> _PendingTarget | None:
    """Move toward one frozen target, preserving sell/buy session ordering."""

    if session_index < pending.execute_not_before_session_index:
        return pending

    equity = portfolio.equity()
    if equity <= 0:
        return pending
    tolerance_value = _material_value(equity, tolerance_weight)
    sell_was_required = False

    # Raise cash first.  A missing open is an unresolved sell, never an
    # invitation to size replacement buys from stale proceeds.
    for symbol in sorted(tuple(portfolio.positions)):
        position = portfolio.positions[symbol]
        target_value = equity * pending.weights.get(symbol, 0.0)
        excess = position.market_value - target_value
        dropped = symbol not in pending.weights
        if not dropped and excess <= tolerance_value:
            continue
        open_price = opens.get(symbol)
        if dropped:
            sell_was_required = True
            if open_price is None:
                continue
            qty = position.qty
            fill = _sell_fill(open_price, slippage_bps)
            portfolio.close(symbol, fill, date, reason="target_rebalance_exit")
            order_log.append(
                {
                    "symbol": symbol,
                    "side": "sell",
                    "qty": qty,
                    "signal_date": pending.signal_date,
                    "fill_date": date,
                    "open_price": open_price,
                    "fill_price": fill,
                    "notional": qty * fill,
                    "reason": "target_rebalance_exit",
                }
            )
            continue
        if open_price is None:
            sell_was_required = True
            continue
        fill = _sell_fill(open_price, slippage_bps)
        qty = min(position.qty, int(excess / fill))
        if qty <= 0:
            # The excess is smaller than one whole share, so this is the
            # closest achievable target under the runner's integer-share
            # execution model.
            continue
        sell_was_required = True
        if qty >= position.qty:
            portfolio.close(symbol, fill, date, reason="target_rebalance_trim")
        else:
            portfolio.partial_close(
                symbol,
                qty,
                fill,
                date,
                reason="target_rebalance_trim",
            )
        order_log.append(
            {
                "symbol": symbol,
                "side": "sell",
                "qty": qty,
                "signal_date": pending.signal_date,
                "fill_date": date,
                "open_price": open_price,
                "fill_price": fill,
                "notional": qty * fill,
                "reason": "target_rebalance_trim",
            }
        )

    if sell_was_required:
        # Even a fully successful sell leg must cross a session boundary
        # before any replacement buys.  Repeated unresolved sells advance the
        # boundary while preserving the exact same frozen target.
        if pending.weights:
            return replace(
                pending,
                buy_not_before_session_index=max(
                    pending.buy_not_before_session_index,
                    session_index + 1,
                ),
            )
        # A zero target is complete only when every position was actually
        # priced and closed.  Otherwise keep the risk-off intent latched.
        return None if not portfolio.positions else pending

    if session_index < pending.buy_not_before_session_index:
        return pending

    # Fill underweights in a stable order.  Gross target <= 100% and buy
    # friction naturally leave a small residual handled by the convergence
    # tolerance rather than leverage or fractional-share assumptions.
    equity = portfolio.equity()
    tolerance_value = _material_value(equity, tolerance_weight)
    missing_or_unfilled = False
    for symbol, target_weight in sorted(
        pending.weights.items(),
        key=lambda item: (-item[1], item[0]),
    ):
        position = portfolio.get_position(symbol)
        current_value = position.market_value if position is not None else 0.0
        shortfall = equity * target_weight - current_value
        if shortfall <= tolerance_value:
            continue
        open_price = opens.get(symbol)
        if open_price is None:
            missing_or_unfilled = True
            continue
        fill = _buy_fill(open_price, slippage_bps)
        qty = min(int(shortfall / fill), int(portfolio.cash / fill))
        if qty <= 0:
            # An integer-share residual smaller than both one fill and the
            # available cash is the closest achievable target, not an endless
            # pending plan.
            if shortfall >= fill and portfolio.cash >= fill:
                missing_or_unfilled = True
            continue
        if portfolio.open(symbol, qty, fill, date):
            order_log.append(
                {
                    "symbol": symbol,
                    "side": "buy",
                    "qty": qty,
                    "signal_date": pending.signal_date,
                    "fill_date": date,
                    "open_price": open_price,
                    "fill_price": fill,
                    "notional": qty * fill,
                    "reason": "target_rebalance_buy",
                }
            )

    # Newly bought positions must be valued at the same official open.  This
    # recognizes buy-side friction in that session instead of hiding it until
    # tomorrow's mark.
    portfolio.mark_to_market(dict(opens))

    equity = portfolio.equity()
    tolerance_value = _material_value(equity, tolerance_weight)
    for symbol, target_weight in pending.weights.items():
        position = portfolio.get_position(symbol)
        current_value = position.market_value if position is not None else 0.0
        shortfall = equity * target_weight - current_value
        if shortfall <= tolerance_value:
            continue
        open_price = opens.get(symbol)
        if open_price is None:
            return pending
        fill = _buy_fill(open_price, slippage_bps)
        if shortfall >= fill and portfolio.cash >= fill:
            return pending
    return pending if missing_or_unfilled else None


def _risk_off_signal(strategy: object, context: StrategyContext) -> bool | None:
    callback = getattr(strategy, "risk_off", None)
    if callback is None:
        return None
    result = callback(context)
    if result is not None and type(result) is not bool:
        raise TypeError("risk_off(context) must return bool or None")
    return result


def run_target_strategy(
    strategy: TargetStrategy,
    config: TargetBacktestConfig,
    *,
    provider: BarProvider | None = None,
) -> dict:
    """Run one research target policy and return metrics-compatible output."""

    if not isinstance(getattr(strategy, "name", None), str) or not strategy.name:
        raise TypeError("strategy.name must be a non-empty string")
    if not callable(getattr(strategy, "should_rebalance", None)):
        raise TypeError("strategy must define should_rebalance(context)")
    if not callable(getattr(strategy, "build_target", None)):
        raise TypeError("strategy must define build_target(context)")

    provider = provider or BarProvider()
    universe = tuple(config.universe)
    calendar = provider.all_trading_days(
        config.reference_symbol,
        start=config.start_date,
        end=config.end_date,
    )
    if not calendar:
        raise RuntimeError(
            f"No {config.reference_symbol} bars between "
            f"{config.start_date} and {config.end_date}"
        )

    portfolio = SimulatedPortfolio(starting_cash=config.starting_cash)
    pending: _PendingTarget | None = None
    orders: list[dict[str, object]] = []

    for session_index, date in enumerate(calendar):
        signal_date = provider.previous_trading_day(config.reference_symbol, date)
        risk_tier = _completed_session_risk_tier(portfolio)

        context: StrategyContext | None = None
        risk_off_now = False
        if signal_date is not None:
            # Capture incumbent state and risk before today's open is marked.
            # Today's gap can affect tomorrow's decision, never today's fill.
            context = _context(
                provider=provider,
                portfolio=portfolio,
                universe=universe,
                signal_date=signal_date,
                fill_date=date,
                session_index=session_index,
                risk_tier=risk_tier,
            )
            risk_off_result = _risk_off_signal(strategy, context)
            risk_off_now = risk_off_result is True
            if risk_off_now:
                if pending is None or not pending.risk_off:
                    pending = _PendingTarget(
                        weights=MappingProxyType({}),
                        signal_date=signal_date,
                        created_session_index=session_index,
                        execute_not_before_session_index=(
                            session_index + config.execution_delay_sessions - 1
                        ),
                        buy_not_before_session_index=session_index,
                        risk_off=True,
                    )
            elif pending is None and bool(strategy.should_rebalance(context)):
                pending = _PendingTarget(
                    weights=_validated_target(
                        strategy.build_target(context),
                        universe,
                    ),
                    signal_date=signal_date,
                    created_session_index=session_index,
                    execute_not_before_session_index=(
                        session_index + config.execution_delay_sessions - 1
                    ),
                    buy_not_before_session_index=session_index,
                )

        # Only held names and the frozen target can affect today's portfolio.
        # Pricing the entire ranking universe on every session does millions of
        # irrelevant lookups in a broad-universe tournament without changing
        # either fills or marks.
        pending_symbols = tuple(pending.weights) if pending is not None else ()
        pricing_symbols = tuple(
            dict.fromkeys(
                (*portfolio.positions, *pending_symbols, config.reference_symbol)
            )
        )
        opens = _open_prices(provider, pricing_symbols, date)
        portfolio.mark_to_market(opens)

        if pending is not None:
            pending = _execute_pending_target(
                portfolio=portfolio,
                pending=pending,
                opens=opens,
                date=date,
                session_index=session_index,
                slippage_bps=config.slippage_bps,
                tolerance_weight=config.convergence_tolerance_weight,
                order_log=orders,
            )

        # Re-mark after both legs so newly opened positions carry the raw open
        # while their entry basis retains buy friction.
        portfolio.mark_to_market(opens)
        portfolio.record_snapshot(
            date,
            "RISK_OFF" if risk_off_now or (pending and pending.risk_off) else "RESEARCH",
            risk_tier,
        )

    result = {
        "config": {
            "start_date": config.start_date,
            "end_date": config.end_date,
            "starting_cash": config.starting_cash,
            "slippage_bps": config.slippage_bps,
            "universe_size": len(universe),
            "strategy_name": strategy.name,
            "strategy_version": "research-target-weight-v1",
            "signal_timing": (
                f"D-close-to-D+{config.execution_delay_sessions}-open"
            ),
            "execution_delay_sessions": config.execution_delay_sessions,
            "sell_before_buy": True,
        },
        **portfolio.to_dict(),
        "orders": orders,
        "execution_summary": {
            "order_count": len(orders),
            "buy_order_count": sum(order["side"] == "buy" for order in orders),
            "sell_order_count": sum(order["side"] == "sell" for order in orders),
            "gross_traded_notional": math.fsum(
                float(order["notional"]) for order in orders
            ),
            "gross_traded_notional_pct_starting_cash": (
                math.fsum(float(order["notional"]) for order in orders)
                / config.starting_cash
                * 100.0
            ),
            "maximum_order_notional": max(
                (float(order["notional"]) for order in orders),
                default=0.0,
            ),
        },
        "pending_target": (
            {
                "signal_date": pending.signal_date,
                "weights": dict(pending.weights),
                "risk_off": pending.risk_off,
                "execute_not_before_session_index": (
                    pending.execute_not_before_session_index
                ),
                "buy_not_before_session_index": (
                    pending.buy_not_before_session_index
                ),
            }
            if pending is not None
            else None
        ),
    }
    result["metrics"] = compute_metrics(result, provider)
    return result


# Descriptive alias for callers that prefer the longer name.
run_target_strategy_backtest = run_target_strategy


__all__ = [
    "PointInTimeBarProvider",
    "PositionSnapshot",
    "StrategyContext",
    "TargetBacktestConfig",
    "TargetStrategy",
    "TargetValidationError",
    "run_target_strategy",
    "run_target_strategy_backtest",
]
