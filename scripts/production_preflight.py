"""Read-only production preflight for the V11 Alpaca paper deployment.

The command deliberately performs no broker or local-state mutation.  It
binds the checked-out release to the exact production runtime, verifies the
canonical validation evidence, and reads the paper account, clock, positions,
orders, and rolling risk snapshot.  Any failed check returns a non-zero exit.
"""

from __future__ import annotations

import json
import os
import platform
import re
import sys
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any, Mapping

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = PROJECT_ROOT / "scripts"
LOCK_PATH = PROJECT_ROOT / "requirements.lock"
VALIDATION_PATH = PROJECT_ROOT / "state" / "backtest" / "v11_validation.json"
EXPECTED_PYTHON = "3.12.11"
EXPECTED_PAPER_URL = "https://paper-api.alpaca.markets"
EXPECTED_LIVE_URL = "https://api.alpaca.markets"
IDENTITY_DISTRIBUTIONS = ("alpaca-py", "numpy", "pandas")
MAX_CLOCK_AGE_SECONDS = 120

if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

load_dotenv(PROJECT_ROOT / ".env")

from broker_mode import (  # noqa: E402
    LIVE,
    PAPER,
    BrokerModeError,
    requested_mode,
    resolve_broker_mode,
)


def _enum_value(value: Any) -> str:
    return str(getattr(value, "value", value)).strip()


def _record(
    checks: list[dict[str, Any]],
    name: str,
    passed: bool,
    detail: str,
) -> None:
    checks.append(
        {
            "name": name,
            "passed": bool(passed),
            "detail": detail,
        }
    )


def locked_distribution_versions(lock_path: Path = LOCK_PATH) -> dict[str, str]:
    """Extract the exact identity-bearing versions from the generated lock."""

    text = lock_path.read_text(encoding="utf-8")
    versions: dict[str, str] = {}
    for distribution in IDENTITY_DISTRIBUTIONS:
        match = re.search(
            rf"^{re.escape(distribution)}==([^\s\\]+)",
            text,
            flags=re.MULTILINE | re.IGNORECASE,
        )
        if match is None:
            raise ValueError(f"{distribution} is not pinned in {lock_path.name}")
        versions[distribution] = match.group(1)
    return versions


def check_environment(
    environ: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Require an explicitly configured broker mode and its credentials.

    Paper is unchanged: ``TRADING_MODE=paper`` plus the two paper keys. Live has
    to satisfy every condition in :func:`broker_mode.resolve_broker_mode`, and
    the reason it fails is reported rather than collapsed into "must equal
    paper" — an operator who mistyped one live variable needs to know which.
    """

    values = dict(os.environ if environ is None else environ)
    checks: list[dict[str, Any]] = []
    mode = requested_mode(values)

    _record(
        checks,
        "trading_mode",
        mode in {PAPER, LIVE},
        mode if mode in {PAPER, LIVE} else "must equal paper or live",
    )

    if mode == LIVE:
        try:
            resolved = resolve_broker_mode(values)
        except BrokerModeError as exc:
            _record(checks, "live_configuration", False, str(exc).replace("\n", " "))
            return checks
        _record(checks, "live_configuration", True, resolved.describe())
        for key in ("ALPACA_LIVE_API_KEY", "ALPACA_LIVE_SECRET_KEY"):
            present = bool(str(values.get(key, "")).strip())
            _record(
                checks,
                key.lower(),
                present,
                "configured" if present else "missing",
            )
        return checks

    for key in ("ALPACA_API_KEY", "ALPACA_SECRET_KEY"):
        present = bool(str(values.get(key, "")).strip())
        _record(
            checks,
            key.lower(),
            present,
            "configured" if present else "missing",
        )
    return checks


def check_runtime(
    *,
    python_version: str | None = None,
    installed_versions: Mapping[str, str] | None = None,
    lock_path: Path = LOCK_PATH,
) -> list[dict[str, Any]]:
    """Verify that runtime versions exactly match the promoted release."""

    checks: list[dict[str, Any]] = []
    actual_python = python_version or platform.python_version()
    _record(
        checks,
        "python_runtime",
        actual_python == EXPECTED_PYTHON,
        f"actual={actual_python}, expected={EXPECTED_PYTHON}",
    )
    try:
        locked = locked_distribution_versions(lock_path)
    except (OSError, ValueError) as exc:
        _record(checks, "dependency_lock", False, str(exc))
        return checks

    _record(checks, "dependency_lock", True, "identity packages are exactly pinned")
    actual = (
        dict(installed_versions)
        if installed_versions is not None
        else {name: metadata.version(name) for name in IDENTITY_DISTRIBUTIONS}
    )
    for name in IDENTITY_DISTRIBUTIONS:
        value = actual.get(name, "missing")
        expected = locked[name]
        _record(
            checks,
            f"runtime_{name}",
            value == expected,
            f"actual={value}, expected={expected}",
        )
    return checks


def check_release() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Verify frozen strategy, validation, universe, bars, and identity."""

    from execute_trades import _v11_validation_gate
    from strategy_config import get_strategy_params
    from strategy_identity import build_strategy_identity, hash_symbol_universe
    from universe import (
        UNIVERSE_STATE,
        load_universe_symbols,
        valid_cached_universe_symbols,
    )
    from utils import load_json

    checks: list[dict[str, Any]] = []
    details: dict[str, Any] = {}
    params = get_strategy_params("BULL", "NORMAL")
    # The fourth place the shipped policy is mirrored, after _V11_POLICY itself,
    # sanity_check.check_strategy_config and the dashboard's v11-policy.json.
    # Each mirror caught the 2026-09-08 change at a different stage — this one
    # only at the broker preflight, which is the last gate before an order.
    # `_record` carries a single detail string, so the mismatch is named
    # explicitly: "breadth-scaled top-10 policy" told a reader nothing about
    # WHICH field disagreed, and finding that cost a log dive.
    expected_policy = {
        "strategy_version": "v11-adaptive-momentum",
        "adaptive_momentum": True,
        "momentum_use_breadth_scaling": True,
        "momentum_top_n": 10,
        "max_position_pct": 9.0,
        "momentum_max_sector_pct": 40.0,
        # Below SPY's SMA200 the book de-risks to this share of normal gross
        # instead of exiting to cash. Asserted here because it decides how much
        # money is exposed in a downtrend.
        "momentum_below_sma200_floor_pct": 75.0,
        "min_cash_pct": 10.0,
    }
    mismatches = [
        f"{key}={params.get(key)!r} (expected {value!r})"
        for key, value in expected_policy.items()
        if params.get(key) != value
    ]
    _record(
        checks,
        "frozen_v11_policy",
        not mismatches,
        "breadth-scaled top-10 policy"
        if not mismatches
        else "policy drift: " + "; ".join(mismatches),
    )

    gate = _v11_validation_gate()
    _record(
        checks,
        "canonical_validation_gate",
        bool(gate.get("passed")),
        str(gate.get("reason", "validation result unavailable")),
    )
    details["validation_status"] = gate.get("status")
    details["allowed_mode"] = gate.get("allowed_mode")

    report = load_json(VALIDATION_PATH)
    identity = build_strategy_identity()
    recorded_identity = report.get("strategy", {}).get("identity", {})
    identity_ok = recorded_identity.get("value") == identity.get("value")
    _record(
        checks,
        "strategy_identity",
        identity_ok,
        identity.get("value", "missing"),
    )
    details["strategy_identity"] = identity.get("value")
    details["runtime_versions"] = identity.get("runtime_versions")

    universe = load_universe_symbols(held_symbols=[])
    universe_hash = hash_symbol_universe(universe)
    evidence = report.get("evidence", {})
    universe_ok = bool(
        len(universe) >= 100
        and evidence.get("ranking_universe_count") == len(universe)
        and evidence.get("ranking_universe_sha256") == universe_hash
    )
    _record(
        checks,
        "ranking_universe",
        universe_ok,
        f"{len(universe)} symbols; hash={universe_hash}",
    )
    cache_payload = load_json(UNIVERSE_STATE)
    details["universe_count"] = len(universe)
    details["universe_source"] = (
        "alpaca-cache"
        if valid_cached_universe_symbols(cache_payload)
        else "validated-watchlist-fallback"
    )
    details["bar_snapshot_through_date"] = evidence.get(
        "bar_snapshot_through_date"
    )
    return checks, details


def _clock_timestamp(clock: Any) -> datetime:
    value = getattr(clock, "timestamp", None)
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime):
        raise ValueError("broker clock has no timestamp")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def check_broker(
    *,
    broker: Any | None = None,
    risk_snapshot: Mapping[str, Any] | None = None,
    now: datetime | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Read the paper account and require a safe, current broker snapshot."""

    from alpaca.trading.enums import QueryOrderStatus
    from alpaca.trading.requests import GetOrdersRequest
    from execute_trades import _capture_execution_risk_snapshot
    from trade import _get_client

    checks: list[dict[str, Any]] = []
    details: dict[str, Any] = {}
    client = broker if broker is not None else _get_client()
    base_url = _enum_value(getattr(client, "_base_url", ""))
    # The endpoint must match the declared mode exactly. Checking only for the
    # paper URL would have passed a live client silently once live existed;
    # checking for "either" would have accepted a paper endpoint during a live
    # run, which is the more dangerous direction because it looks like it
    # worked.
    expected_url = EXPECTED_LIVE_URL if requested_mode() == LIVE else EXPECTED_PAPER_URL
    _record(
        checks,
        "broker_endpoint",
        base_url == expected_url,
        base_url or "broker endpoint unavailable",
    )

    account = client.get_account()
    status = _enum_value(getattr(account, "status", "")).upper()
    blocked_flags = {
        name: bool(getattr(account, name, False))
        for name in (
            "account_blocked",
            "trading_blocked",
            "trade_suspended_by_user",
        )
    }
    account_ok = status == "ACTIVE" and not any(blocked_flags.values())
    _record(
        checks,
        "paper_account",
        account_ok,
        f"status={status or 'missing'}, blocked={any(blocked_flags.values())}",
    )

    clock = client.get_clock()
    checked_at = now or datetime.now(timezone.utc)
    if checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=timezone.utc)
    clock_age = abs(
        (checked_at.astimezone(timezone.utc) - _clock_timestamp(clock)).total_seconds()
    )
    clock_fresh = clock_age <= MAX_CLOCK_AGE_SECONDS
    _record(
        checks,
        "broker_clock",
        clock_fresh,
        f"fresh={clock_fresh}, market_open={bool(getattr(clock, 'is_open', False))}",
    )

    positions = list(client.get_all_positions())
    shorts = []
    for position in positions:
        side = _enum_value(getattr(position, "side", "")).lower()
        try:
            quantity = float(getattr(position, "qty", 0.0))
        except (TypeError, ValueError):
            quantity = 0.0
        if side == "short" or quantity < 0:
            shorts.append(str(getattr(position, "symbol", "?")))
    _record(
        checks,
        "no_short_positions",
        not shorts,
        f"positions={len(positions)}, shorts={len(shorts)}",
    )

    orders = list(
        client.get_orders(
            filter=GetOrdersRequest(status=QueryOrderStatus.OPEN),
        )
    )
    open_buys = sum(
        _enum_value(getattr(order, "side", "")).lower() == "buy"
        for order in orders
    )
    _record(
        checks,
        "open_order_snapshot",
        True,
        f"open_orders={len(orders)}, open_buys={open_buys}",
    )

    snapshot = (
        dict(risk_snapshot)
        if risk_snapshot is not None
        else _capture_execution_risk_snapshot()
    )
    risk_reason = str(snapshot.get("reason", "unspecified"))[:300]
    risk_ok = bool(
        snapshot.get("available")
        and snapshot.get("tier") in {"NORMAL", "CAUTIOUS", "HALT"}
    )
    _record(
        checks,
        "fresh_risk_snapshot",
        risk_ok,
        (
            f"available={bool(snapshot.get('available'))}, "
            f"tier={snapshot.get('tier')}, reason={risk_reason}"
        ),
    )

    details.update(
        {
            "account_status": status,
            "market_open": bool(getattr(clock, "is_open", False)),
            "position_count": len(positions),
            "short_count": len(shorts),
            "open_order_count": len(orders),
            "open_buy_count": int(open_buys),
            "risk_tier": snapshot.get("tier"),
            "risk_snapshot_reason": risk_reason,
        }
    )
    return checks, details


def run_preflight(
    *,
    environ: Mapping[str, str] | None = None,
    broker: Any | None = None,
    risk_snapshot: Mapping[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run all production checks and return a secret-free JSON report."""

    checks = check_environment(environ)
    checks.extend(check_runtime())
    details: dict[str, Any] = {}
    try:
        release_checks, release_details = check_release()
        checks.extend(release_checks)
        details.update(release_details)
    except Exception as exc:  # a preflight must turn every uncertainty into NO-GO
        _record(checks, "release_inspection", False, f"{type(exc).__name__}: {exc}")
    try:
        broker_checks, broker_details = check_broker(
            broker=broker,
            risk_snapshot=risk_snapshot,
            now=now,
        )
        checks.extend(broker_checks)
        details.update(broker_details)
    except Exception as exc:  # credentials/network/schema errors must fail closed
        _record(checks, "broker_inspection", False, f"{type(exc).__name__}: {exc}")

    passed = bool(checks) and all(check["passed"] for check in checks)
    return {
        "schema_version": 1,
        "kind": "v11_paper_production_preflight",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "status": "PASS" if passed else "FAIL",
        "allowed_mode": "paper" if passed else "no-execution",
        "checks_passed": sum(check["passed"] for check in checks),
        "checks_evaluated": len(checks),
        "checks": checks,
        "details": details,
    }


def main() -> int:
    report = run_preflight()
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
