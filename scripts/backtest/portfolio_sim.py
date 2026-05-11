"""Simulated portfolio for the backtest — tracks cash, positions, equity.

Mirrors the live engine's state but with deterministic, in-memory updates:
  • open(symbol, qty, fill_price, date) — adds or augments a position
  • close(symbol, fill_price, date) — fully exits and records the trade
  • partial_close(symbol, qty, fill_price, date) — for scale-outs
  • mark_to_market(prices) — refreshes current_price for every position
  • apply_stop_check(date, lows) — closes positions hit by trailing stop
  • record_snapshot(date) — appends one row to daily_history

Slippage is applied at the engine level (entry/exit prices arrive
pre-adjusted). Fees are zero for Alpaca paper, matching live behavior.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Position:
    symbol: str
    entry_date: str
    qty: int
    avg_entry_price: float
    current_price: float
    high_since_entry: float  # for trailing stop
    scaled_out: bool = False
    tightened_stop: bool = False
    is_hedge: bool = False

    @property
    def market_value(self) -> float:
        return self.qty * self.current_price

    @property
    def unrealized_pl(self) -> float:
        return (self.current_price - self.avg_entry_price) * self.qty

    @property
    def unrealized_plpc(self) -> float:
        if self.avg_entry_price <= 0:
            return 0.0
        return (self.current_price / self.avg_entry_price - 1) * 100

    def update_price(self, price: float) -> None:
        self.current_price = price
        if price > self.high_since_entry:
            self.high_since_entry = price


@dataclass
class ClosedTrade:
    symbol: str
    entry_date: str
    exit_date: str
    qty: int
    entry_price: float
    exit_price: float
    pnl: float
    pnl_pct: float
    reason: str  # "stop" | "scale_out" | "final_target" | "time_stop" | "catalyst_flip" | "hedge_exit"
    is_hedge: bool = False


@dataclass
class DailySnapshot:
    date: str
    equity: float
    cash: float
    cash_pct: float
    num_positions: int
    pnl: float
    pnl_pct: float
    regime: str
    risk_tier: str


class SimulatedPortfolio:
    def __init__(self, starting_cash: float = 1_000_000.0):
        self.starting_cash = starting_cash
        self.cash = starting_cash
        self.positions: dict[str, Position] = {}
        self.closed_trades: list[ClosedTrade] = []
        self.daily_history: list[DailySnapshot] = []
        # Track which symbols have been scale-out'd already (idempotency)
        self._scaled_out_symbols: set[str] = set()

    # ────────────────────────── core operations ──────────────────────────

    def equity(self) -> float:
        return self.cash + sum(p.market_value for p in self.positions.values())

    def cash_pct(self) -> float:
        e = self.equity()
        return (self.cash / e * 100) if e > 0 else 0.0

    def open(self, symbol: str, qty: int, fill_price: float, date: str,
             is_hedge: bool = False) -> bool:
        """Open or augment a position. Returns True if filled."""
        if qty <= 0 or fill_price <= 0:
            return False
        cost = qty * fill_price
        if cost > self.cash:
            return False

        if symbol in self.positions:
            p = self.positions[symbol]
            total_qty = p.qty + qty
            new_avg = ((p.qty * p.avg_entry_price) + (qty * fill_price)) / total_qty
            p.qty = total_qty
            p.avg_entry_price = new_avg
            p.current_price = fill_price
            p.high_since_entry = max(p.high_since_entry, fill_price)
        else:
            self.positions[symbol] = Position(
                symbol=symbol,
                entry_date=date,
                qty=qty,
                avg_entry_price=fill_price,
                current_price=fill_price,
                high_since_entry=fill_price,
                is_hedge=is_hedge,
            )
        self.cash -= cost
        return True

    def partial_close(self, symbol: str, qty: int, fill_price: float, date: str, reason: str) -> Optional[ClosedTrade]:
        """Close part of a position. Used for scale-outs."""
        p = self.positions.get(symbol)
        if p is None or qty <= 0 or qty >= p.qty:
            return None
        proceeds = qty * fill_price
        pnl = (fill_price - p.avg_entry_price) * qty
        pnl_pct = (fill_price / p.avg_entry_price - 1) * 100 if p.avg_entry_price > 0 else 0.0
        trade = ClosedTrade(
            symbol=symbol,
            entry_date=p.entry_date,
            exit_date=date,
            qty=qty,
            entry_price=p.avg_entry_price,
            exit_price=fill_price,
            pnl=pnl,
            pnl_pct=pnl_pct,
            reason=reason,
            is_hedge=p.is_hedge,
        )
        p.qty -= qty
        self.cash += proceeds
        self.closed_trades.append(trade)
        if reason == "scale_out":
            self._scaled_out_symbols.add(symbol)
            p.scaled_out = True
        return trade

    def close(self, symbol: str, fill_price: float, date: str, reason: str) -> Optional[ClosedTrade]:
        """Fully exit a position."""
        p = self.positions.get(symbol)
        if p is None:
            return None
        proceeds = p.qty * fill_price
        pnl = (fill_price - p.avg_entry_price) * p.qty
        pnl_pct = (fill_price / p.avg_entry_price - 1) * 100 if p.avg_entry_price > 0 else 0.0
        trade = ClosedTrade(
            symbol=symbol,
            entry_date=p.entry_date,
            exit_date=date,
            qty=p.qty,
            entry_price=p.avg_entry_price,
            exit_price=fill_price,
            pnl=pnl,
            pnl_pct=pnl_pct,
            reason=reason,
            is_hedge=p.is_hedge,
        )
        self.cash += proceeds
        self.closed_trades.append(trade)
        del self.positions[symbol]
        self._scaled_out_symbols.discard(symbol)
        return trade

    def mark_to_market(self, prices: dict[str, float]) -> None:
        """Refresh current_price (and high-since-entry) for every position."""
        for symbol, p in self.positions.items():
            if symbol in prices:
                p.update_price(prices[symbol])

    def has_position(self, symbol: str) -> bool:
        return symbol in self.positions

    def get_position(self, symbol: str) -> Optional[Position]:
        return self.positions.get(symbol)

    def non_hedge_position_count(self) -> int:
        return sum(1 for p in self.positions.values() if not p.is_hedge)

    def hedge_value(self) -> float:
        return sum(p.market_value for p in self.positions.values() if p.is_hedge)

    def has_scaled_out(self, symbol: str) -> bool:
        return symbol in self._scaled_out_symbols

    # ──────────────────────────── snapshots ───────────────────────────────

    def record_snapshot(self, date: str, regime: str, risk_tier: str) -> DailySnapshot:
        equity = self.equity()
        prev_equity = (self.daily_history[-1].equity
                       if self.daily_history else self.starting_cash)
        pnl = equity - prev_equity
        pnl_pct = (pnl / prev_equity * 100) if prev_equity > 0 else 0.0
        snap = DailySnapshot(
            date=date,
            equity=equity,
            cash=self.cash,
            cash_pct=self.cash_pct(),
            num_positions=self.non_hedge_position_count(),
            pnl=pnl,
            pnl_pct=pnl_pct,
            regime=regime,
            risk_tier=risk_tier,
        )
        self.daily_history.append(snap)
        return snap

    # ────────────────────────── serialization ────────────────────────────

    def to_dict(self) -> dict:
        return {
            "starting_cash": self.starting_cash,
            "final_equity": self.equity(),
            "final_cash": self.cash,
            "daily_history": [
                {
                    "date": s.date, "equity": s.equity, "cash": s.cash,
                    "cash_pct": s.cash_pct, "num_positions": s.num_positions,
                    "pnl": s.pnl, "pnl_pct": s.pnl_pct,
                    "regime": s.regime, "risk_tier": s.risk_tier,
                }
                for s in self.daily_history
            ],
            "closed_trades": [
                {
                    "symbol": t.symbol, "entry_date": t.entry_date,
                    "exit_date": t.exit_date, "qty": t.qty,
                    "entry_price": t.entry_price, "exit_price": t.exit_price,
                    "pnl": t.pnl, "pnl_pct": t.pnl_pct,
                    "reason": t.reason, "is_hedge": t.is_hedge,
                }
                for t in self.closed_trades
            ],
            "open_positions": [
                {
                    "symbol": p.symbol, "entry_date": p.entry_date,
                    "qty": p.qty, "avg_entry_price": p.avg_entry_price,
                    "current_price": p.current_price, "market_value": p.market_value,
                    "unrealized_pl": p.unrealized_pl, "unrealized_plpc": p.unrealized_plpc,
                    "is_hedge": p.is_hedge,
                }
                for p in self.positions.values()
            ],
        }
