"""Single source of truth for which broker account the executor may touch.

Before this module the answer was spread across four literal
``TradingClient(..., paper=True)`` constructions and one string comparison
against ``"paper"``. That was a safe arrangement precisely because it had no
seam: there was nothing to misconfigure. Adding real money means adding the
seam, so everything that used to be implied by the literal now has to be
stated, checked, and refused when it does not line up.

The rules, in order of how much damage getting them wrong would do:

1.  **Live is never a default and never inferred.** ``TRADING_MODE`` has to say
    ``live`` in as many words. An unset or unrecognised value is a dry run; the
    old ``paper`` value keeps meaning exactly what it did.

2.  **Live credentials have their own names.** Paper keys live in
    ``ALPACA_API_KEY``/``ALPACA_SECRET_KEY``; live keys live in
    ``ALPACA_LIVE_API_KEY``/``ALPACA_LIVE_SECRET_KEY``. Nothing falls back to
    the other set. A misfiled paper key therefore fails to authenticate rather
    than quietly trading the wrong book, and a live key can never be picked up
    by a run that only asked for paper.

3.  **The operator has to name the account.** ``LIVE_TRADING_ACCOUNT_NUMBER``
    must hold the Alpaca account number the run is allowed to trade, and the
    caller is expected to compare it against a freshly read ``/v2/account``
    before submitting anything (see :func:`verify_live_account_binding`).
    Credentials alone only prove *an* account; they do not prove *the* account.

4.  **Live requires a second, separate switch.** ``LIVE_TRADING_ENABLED`` must
    be an explicit affirmative. Two independent variables have to be wrong at
    the same time for real money to move by accident.

5.  **Absolute money caps exist outside the strategy.** Every strategy limit in
    this repository is a percentage of equity, so a bug in equity or in the
    target weights scales the mistake with the account. ``LIVE_MAX_ORDER_``
    ``NOTIONAL_USD`` and ``LIVE_MAX_CYCLE_NOTIONAL_USD`` are flat dollar
    ceilings that no strategy computation can talk its way past.

6.  **There is an off switch that does not need a deploy.** If the file named
    by ``LIVE_TRADING_KILL_SWITCH_FILE`` exists, live entries are refused. It is
    checked at call time, so creating the file stops the next cycle.

Nothing here decides *whether* the strategy should trade — the validation gate
in :mod:`execute_trades` still does that, and it is applied to live at least as
strictly as to paper. This module only decides *which* broker a permitted order
reaches, and refuses to answer at all when the configuration is ambiguous.
"""

from __future__ import annotations

import os
import math
from dataclasses import dataclass
from pathlib import Path

DRY_RUN = "dry-run"
PAPER = "paper"
LIVE = "live"

_AFFIRMATIVE = frozenset({"yes", "true", "1", "on", "enabled"})

#: Live entries are refused when this file exists. Deleting it re-arms them.
DEFAULT_KILL_SWITCH_FILE = "state/production/LIVE_TRADING_DISABLED"


class BrokerModeError(RuntimeError):
    """Raised when a mutating run is asked for but the configuration is unsafe.

    Always fail closed: every construction path in this module either returns a
    fully verified configuration or raises.
    """


@dataclass(frozen=True)
class BrokerMode:
    """A resolved decision about which broker account may be reached."""

    mode: str
    api_key: str
    api_secret: str
    #: Passed straight to ``TradingClient(paper=...)``.
    paper: bool
    #: Alpaca account number the operator declared, live only.
    expected_account_number: str | None
    max_order_notional_usd: float | None
    max_cycle_notional_usd: float | None
    #: Total live strategy capital, including positions and outstanding BUYs.
    capital_budget_usd: float | None

    @property
    def is_live(self) -> bool:
        return self.mode == LIVE

    @property
    def is_mutating(self) -> bool:
        """True when this mode may submit orders at all."""
        return self.mode in {PAPER, LIVE}

    def describe(self) -> str:
        """A short, secret-free description safe to log or persist."""
        if self.mode == LIVE:
            caps = []
            if self.max_order_notional_usd is not None:
                caps.append(f"order<=${self.max_order_notional_usd:,.0f}")
            if self.max_cycle_notional_usd is not None:
                caps.append(f"cycle<=${self.max_cycle_notional_usd:,.0f}")
            if self.capital_budget_usd is not None:
                caps.append(f"capital<=${self.capital_budget_usd:,.0f}")
            suffix = f" [{', '.join(caps)}]" if caps else ""
            return f"live real-money account {self.expected_account_number}{suffix}"
        if self.mode == PAPER:
            return "alpaca paper account"
        return "dry run (no broker mutations)"


def _value(env: dict[str, str] | None, name: str) -> str:
    source = os.environ if env is None else env
    return str(source.get(name, "") or "").strip()


def _flag(env: dict[str, str] | None, name: str) -> bool:
    return _value(env, name).lower() in _AFFIRMATIVE


def _positive_float(env: dict[str, str] | None, name: str) -> float | None:
    raw = _value(env, name)
    if not raw:
        return None
    try:
        parsed = float(raw)
    except ValueError as exc:
        raise BrokerModeError(f"{name} is not a number: {raw!r}") from exc
    if not math.isfinite(parsed):
        raise BrokerModeError(f"{name} must be finite")
    if parsed <= 0:
        raise BrokerModeError(f"{name} must be greater than zero, got {parsed}")
    return parsed


def requested_mode(env: dict[str, str] | None = None) -> str:
    """The mode the operator asked for, without validating that it is usable.

    Anything other than the two recognised words is a dry run. In particular a
    typo such as ``TRADING_MODE=Live!`` degrades to dry run rather than to
    paper, so a mistake never silently trades a different book than intended.
    """
    raw = _value(env, "TRADING_MODE").lower()
    if raw == LIVE:
        return LIVE
    if raw == PAPER:
        return PAPER
    return DRY_RUN


def kill_switch_path(env: dict[str, str] | None = None) -> Path:
    configured = _value(env, "LIVE_TRADING_KILL_SWITCH_FILE")
    if configured:
        return Path(configured)
    from utils import PROJECT_ROOT

    return PROJECT_ROOT / DEFAULT_KILL_SWITCH_FILE


def kill_switch_engaged(env: dict[str, str] | None = None) -> bool:
    """True when the operator has parked live trading via the filesystem."""
    try:
        return kill_switch_path(env).exists()
    except OSError:
        # An unreadable path is not proof that trading is safe.
        return True


def resolve_broker_mode(env: dict[str, str] | None = None) -> BrokerMode:
    """Resolve the broker configuration, or raise if it is not coherent.

    A dry run resolves without credentials so that imports, sanity checks and
    unit tests keep working on a machine with no keys at all.
    """
    mode = requested_mode(env)

    if mode == DRY_RUN:
        return BrokerMode(
            mode=DRY_RUN,
            api_key=_value(env, "ALPACA_API_KEY"),
            api_secret=_value(env, "ALPACA_SECRET_KEY"),
            paper=True,
            expected_account_number=None,
            max_order_notional_usd=None,
            max_cycle_notional_usd=None,
            capital_budget_usd=None,
        )

    if mode == PAPER:
        return BrokerMode(
            mode=PAPER,
            api_key=_value(env, "ALPACA_API_KEY"),
            api_secret=_value(env, "ALPACA_SECRET_KEY"),
            paper=True,
            expected_account_number=None,
            max_order_notional_usd=None,
            max_cycle_notional_usd=None,
            capital_budget_usd=None,
        )

    # ── live ────────────────────────────────────────────────────────────────
    problems: list[str] = []

    if not _flag(env, "LIVE_TRADING_ENABLED"):
        problems.append(
            "LIVE_TRADING_ENABLED is not an explicit affirmative "
            "(yes/true/1/on/enabled)"
        )

    api_key = _value(env, "ALPACA_LIVE_API_KEY")
    api_secret = _value(env, "ALPACA_LIVE_SECRET_KEY")
    if not api_key or not api_secret:
        problems.append(
            "ALPACA_LIVE_API_KEY and ALPACA_LIVE_SECRET_KEY must both be set; "
            "live never falls back to the paper credentials"
        )

    paper_key = _value(env, "ALPACA_API_KEY")
    if api_key and paper_key and api_key == paper_key:
        problems.append(
            "ALPACA_LIVE_API_KEY is the same value as ALPACA_API_KEY; refusing "
            "to treat one credential as two different accounts"
        )

    account_number = _value(env, "LIVE_TRADING_ACCOUNT_NUMBER")
    if not account_number:
        problems.append(
            "LIVE_TRADING_ACCOUNT_NUMBER must name the Alpaca account this run "
            "is allowed to trade, so the credentials can be proven to point at it"
        )

    # The switch blocks entries at the order boundary, not access to the
    # account: mode resolution must still permit reconciliation and exits.
    max_order = _positive_float(env, "LIVE_MAX_ORDER_NOTIONAL_USD")
    max_cycle = _positive_float(env, "LIVE_MAX_CYCLE_NOTIONAL_USD")
    capital_budget = _positive_float(env, "LIVE_CAPITAL_BUDGET_USD")
    if capital_budget is None:
        problems.append(
            "LIVE_CAPITAL_BUDGET_USD must set the total capital allocated to "
            "live positions and outstanding BUY commitments across runs"
        )
    if max_order is None:
        problems.append(
            "LIVE_MAX_ORDER_NOTIONAL_USD must set an absolute per-order dollar "
            "ceiling; percentage-of-equity limits alone scale a bug with the account"
        )
    if max_cycle is None:
        problems.append(
            "LIVE_MAX_CYCLE_NOTIONAL_USD must set an absolute per-cycle dollar "
            "ceiling on everything one run may buy"
        )
    if max_order is not None and max_cycle is not None and max_order > max_cycle:
        problems.append(
            "LIVE_MAX_ORDER_NOTIONAL_USD exceeds LIVE_MAX_CYCLE_NOTIONAL_USD"
        )

    if problems:
        raise BrokerModeError(
            "Live trading is not configured safely:\n  - " + "\n  - ".join(problems)
        )

    return BrokerMode(
        mode=LIVE,
        api_key=api_key,
        api_secret=api_secret,
        paper=False,
        expected_account_number=account_number,
        max_order_notional_usd=max_order,
        max_cycle_notional_usd=max_cycle,
        capital_budget_usd=capital_budget,
    )


def strategy_capital_equity(equity: float) -> float:
    """Size live targets from allocated capital without rewriting real equity.

    Risk/history still use actual broker equity. Paper keeps its existing
    sizing; live cannot scale targets with unrelated cash or margin capacity.
    """
    if requested_mode() != LIVE:
        return equity
    actual = float(equity)
    if not math.isfinite(actual) or actual <= 0:
        raise BrokerModeError("Live sizing requires finite positive account equity")
    resolved = resolve_broker_mode()
    return min(actual, resolved.capital_budget_usd)


def verify_live_account_binding(
    resolved: BrokerMode, observed_account_number: object
) -> None:
    """Prove the credentials reach the account the operator named.

    Credentials prove *an* account. This compares that against the number the
    operator declared out of band, which is the only way a copy-pasted key for
    the wrong Alpaca account gets caught before an order is submitted.
    """
    if not resolved.is_live:
        return
    observed = str(observed_account_number or "").strip()
    if not observed:
        raise BrokerModeError(
            "Live run could not read an account number from Alpaca, so the "
            "credential-to-account binding cannot be proven."
        )
    if observed != (resolved.expected_account_number or ""):
        raise BrokerModeError(
            "Live credentials reach a different Alpaca account than "
            "LIVE_TRADING_ACCOUNT_NUMBER declares. Refusing to trade."
        )
