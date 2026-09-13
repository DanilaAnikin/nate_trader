"""Live-money configuration is refused unless every condition is met.

These tests exist because the old design was safe by having no seam at all:
four literal ``paper=True`` constructions and one string comparison. Adding
real money adds the seam, so each condition that replaced a literal gets a test
that proves it still refuses when it should. A guard nobody proved is a guard
nobody has.
"""

from __future__ import annotations

import pytest
from broker_mode import (
    DRY_RUN,
    LIVE,
    PAPER,
    BrokerModeError,
    kill_switch_engaged,
    requested_mode,
    resolve_broker_mode,
    strategy_capital_equity,
    verify_live_account_binding,
)


def _live_env(**overrides: str) -> dict[str, str]:
    """A complete, valid live configuration; tests remove one piece at a time."""
    env = {
        "TRADING_MODE": "live",
        "LIVE_TRADING_ENABLED": "yes",
        "ALPACA_LIVE_API_KEY": "live-key",
        "ALPACA_LIVE_SECRET_KEY": "live-secret",
        "ALPACA_API_KEY": "paper-key",
        "ALPACA_SECRET_KEY": "paper-secret",
        "LIVE_TRADING_ACCOUNT_NUMBER": "123456789",
        "LIVE_MAX_ORDER_NOTIONAL_USD": "5000",
        "LIVE_MAX_CYCLE_NOTIONAL_USD": "25000",
        "LIVE_CAPITAL_BUDGET_USD": "25000",
        "LIVE_TRADING_KILL_SWITCH_FILE": "/nonexistent/kill-switch",
    }
    env.update(overrides)
    return env


# ── the requested mode ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value, expected",
    [
        ("paper", PAPER),
        ("PAPER", PAPER),
        ("  paper  ", PAPER),
        ("live", LIVE),
        ("LIVE", LIVE),
        ("", DRY_RUN),
        ("yes", DRY_RUN),
        ("true", DRY_RUN),
        ("1", DRY_RUN),
        ("live!", DRY_RUN),
        ("livee", DRY_RUN),
        ("real", DRY_RUN),
    ],
)
def test_only_the_two_exact_words_select_a_broker(value, expected):
    """Anything unrecognised is a dry run, never a fallback to the other mode.

    A typo must not silently trade the book the operator did not name.
    """
    assert requested_mode({"TRADING_MODE": value}) == expected


def test_unset_mode_is_a_dry_run_and_needs_no_credentials():
    resolved = resolve_broker_mode({})
    assert resolved.mode == DRY_RUN
    assert resolved.is_mutating is False
    assert resolved.paper is True


def test_paper_is_unchanged_by_the_live_machinery():
    """The paper path must keep its single-variable opt-in."""
    resolved = resolve_broker_mode(
        {"TRADING_MODE": "paper", "ALPACA_API_KEY": "k", "ALPACA_SECRET_KEY": "s"}
    )
    assert resolved.mode == PAPER
    assert resolved.paper is True
    assert resolved.is_live is False
    assert resolved.is_mutating is True
    assert resolved.expected_account_number is None


def test_paper_never_picks_up_live_credentials():
    resolved = resolve_broker_mode(
        {
            "TRADING_MODE": "paper",
            "ALPACA_API_KEY": "paper-key",
            "ALPACA_SECRET_KEY": "paper-secret",
            "ALPACA_LIVE_API_KEY": "live-key",
            "ALPACA_LIVE_SECRET_KEY": "live-secret",
        }
    )
    assert resolved.api_key == "paper-key"
    assert resolved.api_secret == "paper-secret"


# ── each live precondition, removed one at a time ───────────────────────────


def test_fully_configured_live_resolves():
    resolved = resolve_broker_mode(_live_env())
    assert resolved.capital_budget_usd == 25_000
    assert resolved.mode == LIVE
    assert resolved.paper is False
    assert resolved.is_live is True
    assert resolved.api_key == "live-key"
    assert resolved.expected_account_number == "123456789"
    assert resolved.max_order_notional_usd == 5000.0
    assert resolved.max_cycle_notional_usd == 25000.0


@pytest.mark.parametrize(
    "missing, fragment",
    [
        ("LIVE_TRADING_ENABLED", "LIVE_TRADING_ENABLED"),
        ("ALPACA_LIVE_API_KEY", "never falls back"),
        ("ALPACA_LIVE_SECRET_KEY", "never falls back"),
        ("LIVE_TRADING_ACCOUNT_NUMBER", "LIVE_TRADING_ACCOUNT_NUMBER"),
        ("LIVE_MAX_ORDER_NOTIONAL_USD", "LIVE_MAX_ORDER_NOTIONAL_USD"),
        ("LIVE_MAX_CYCLE_NOTIONAL_USD", "LIVE_MAX_CYCLE_NOTIONAL_USD"),
        ("LIVE_CAPITAL_BUDGET_USD", "LIVE_CAPITAL_BUDGET_USD"),
    ],
)
def test_live_refuses_when_any_single_condition_is_missing(missing, fragment):
    env = _live_env()
    del env[missing]
    with pytest.raises(BrokerModeError) as excinfo:
        resolve_broker_mode(env)
    assert fragment in str(excinfo.value)


@pytest.mark.parametrize("value", ["no", "false", "0", "off", "", "maybe", "y"])
def test_live_enable_flag_must_be_an_explicit_affirmative(value):
    with pytest.raises(BrokerModeError, match="LIVE_TRADING_ENABLED"):
        resolve_broker_mode(_live_env(LIVE_TRADING_ENABLED=value))


@pytest.mark.parametrize("value", ["yes", "YES", "true", "1", "on", "enabled"])
def test_recognised_affirmatives_are_accepted(value):
    assert resolve_broker_mode(_live_env(LIVE_TRADING_ENABLED=value)).is_live


def test_live_refuses_when_the_live_key_is_the_paper_key():
    """One credential cannot be two accounts.

    This is the shape a copy-paste mistake actually takes: the operator fills
    the new ALPACA_LIVE_* variables from the values already on the clipboard.
    """
    with pytest.raises(BrokerModeError, match="same value"):
        resolve_broker_mode(_live_env(ALPACA_LIVE_API_KEY="paper-key"))


def test_live_refuses_a_per_order_cap_above_the_cycle_cap():
    with pytest.raises(BrokerModeError, match="exceeds"):
        resolve_broker_mode(
            _live_env(
                LIVE_MAX_ORDER_NOTIONAL_USD="90000",
                LIVE_MAX_CYCLE_NOTIONAL_USD="25000",
            )
        )


@pytest.mark.parametrize("value", ["0", "-1", "-0.01"])
def test_live_refuses_a_non_positive_cap(value):
    with pytest.raises(BrokerModeError, match="greater than zero"):
        resolve_broker_mode(_live_env(LIVE_MAX_ORDER_NOTIONAL_USD=value))


def test_live_refuses_an_unparseable_cap():
    with pytest.raises(BrokerModeError, match="not a number"):
        resolve_broker_mode(_live_env(LIVE_MAX_ORDER_NOTIONAL_USD="5,000"))


@pytest.mark.parametrize("name", ["LIVE_MAX_ORDER_NOTIONAL_USD", "LIVE_MAX_CYCLE_NOTIONAL_USD", "LIVE_CAPITAL_BUDGET_USD"])
@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "1e309"])
def test_live_refuses_non_finite_caps(name, value):
    with pytest.raises(BrokerModeError, match="finite"):
        resolve_broker_mode(_live_env(**{name: value}))


# ── the kill switch ─────────────────────────────────────────────────────────


def test_kill_switch_keeps_live_account_available_for_exits(tmp_path):
    switch = tmp_path / "LIVE_TRADING_DISABLED"
    switch.write_text("parked")
    env = _live_env(LIVE_TRADING_KILL_SWITCH_FILE=str(switch))
    assert kill_switch_engaged(env) is True
    assert resolve_broker_mode(env).is_live


def test_kill_switch_absent_allows_live(tmp_path):
    switch = tmp_path / "LIVE_TRADING_DISABLED"
    env = _live_env(LIVE_TRADING_KILL_SWITCH_FILE=str(switch))
    assert kill_switch_engaged(env) is False
    assert resolve_broker_mode(env).is_live


def test_kill_switch_does_not_affect_paper(tmp_path):
    """Parking live trading must not stop the paper forward validation."""
    switch = tmp_path / "LIVE_TRADING_DISABLED"
    switch.write_text("parked")
    resolved = resolve_broker_mode(
        {
            "TRADING_MODE": "paper",
            "ALPACA_API_KEY": "k",
            "ALPACA_SECRET_KEY": "s",
            "LIVE_TRADING_KILL_SWITCH_FILE": str(switch),
        }
    )
    assert resolved.mode == PAPER


# ── credential-to-account binding ───────────────────────────────────────────


def test_binding_accepts_the_declared_account():
    verify_live_account_binding(resolve_broker_mode(_live_env()), "123456789")


def test_binding_rejects_a_different_account():
    """Credentials prove *an* account; only this proves *the* account."""
    with pytest.raises(BrokerModeError, match="different Alpaca account"):
        verify_live_account_binding(resolve_broker_mode(_live_env()), "987654321")


@pytest.mark.parametrize("observed", [None, "", "   "])
def test_binding_rejects_an_unreadable_account_number(observed):
    with pytest.raises(BrokerModeError, match="cannot be proven"):
        verify_live_account_binding(resolve_broker_mode(_live_env()), observed)


def test_binding_is_a_noop_for_paper():
    resolved = resolve_broker_mode({"TRADING_MODE": "paper"})
    verify_live_account_binding(resolved, None)


# ── the description is safe to log ──────────────────────────────────────────


def test_describe_never_leaks_a_credential():
    resolved = resolve_broker_mode(_live_env())
    described = resolved.describe()
    assert "live-key" not in described
    assert "live-secret" not in described
    assert "123456789" in described


@pytest.mark.parametrize("budget", ["0", "-1", "not-a-number"])
def test_total_live_capital_requires_a_positive_numeric_budget(budget):
    with pytest.raises(BrokerModeError, match="LIVE_CAPITAL_BUDGET_USD"):
        resolve_broker_mode(_live_env(LIVE_CAPITAL_BUDGET_USD=budget))


@pytest.mark.parametrize("equity,expected", [(100_000, 1000), (500, 500)])
def test_live_strategy_equity_is_bounded_without_altering_actual_equity(monkeypatch, equity, expected):
    for name, value in _live_env(LIVE_CAPITAL_BUDGET_USD="1000").items():
        monkeypatch.setenv(name, value)
    assert strategy_capital_equity(equity) == expected


def test_paper_sizing_ignores_live_capital_configuration(monkeypatch):
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setenv("LIVE_CAPITAL_BUDGET_USD", "invalid")
    assert strategy_capital_equity(100_000) == 100_000
