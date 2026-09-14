"""Persist paper observations outside the trading process; never place orders.

Run as a protected host service, python -m ops.forward_observer --config PATH.
Its explicit source/account pins must be reviewed when production changes.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
from uuid import UUID
from zoneinfo import ZoneInfo

from .forward_observer_access import Binding, SOURCE_PATHS, host_guard, parse_json, require
from .forward_metrics import number, stamp, summarize_forward_observations


def read_private(path, *, maximum=16 * 1024 * 1024, expected_sha256=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1 and
                0 < info.st_size <= maximum, "private_file_required")
        with os.fdopen(fd, "rb", closefd=False) as source:
            raw = source.read(maximum + 1)
        require(len(raw) == info.st_size, "private_file_changed")
        require(expected_sha256 is None or hashlib.sha256(raw).hexdigest() == expected_sha256,
                "private_file_digest")
        return parse_json(raw)
    finally:
        os.close(fd)


def validate_config(config):
    require(isinstance(config, dict) and set(config) == {
        "schema_version", "app_container", "app_sha", "app_image", "approved_release_sha",
        "paper_handoff_sha256", "state_directory", "activities_since", "observed_since", "source_digests",
    } and config["schema_version"] == 1, "configuration_shape")
    require(bool(re.fullmatch(r"natetrader-dashboard-[a-z0-9-]+", config["app_container"])), "app_name")
    for field in ("app_sha", "approved_release_sha"):
        require(bool(re.fullmatch(r"[0-9a-f]{40}", config[field])), "release_sha")
    require(bool(re.fullmatch(r"sha256:[0-9a-f]{64}", config["app_image"])) and
            bool(re.fullmatch(r"[0-9a-f]{64}", config["paper_handoff_sha256"])), "config_digest")
    require(set(config["source_digests"]) == SOURCE_PATHS and
            all(re.fullmatch(r"[0-9a-f]{64}", v) for v in config["source_digests"].values()), "source_digests")
    require(config["state_directory"] == "/var/lib/homelab/nate-trader/forward-observation", "state_directory")
    require(stamp(config["activities_since"]) <= stamp(config["observed_since"]), "observation_window")
    return config


def atomic_json(path, value):
    raw = (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=".observer-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as destination:
            destination.write(raw)
            destination.flush()
            os.fsync(destination.fileno())
        require(not path.is_symlink(), "output_symlink")
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return hashlib.sha256(raw).hexdigest()


def collect_activities(paper, start, end):
    """Rewalk fixed creation-time history, including late-posted nontrade rows."""
    require(stamp(start) < stamp(end), "activity_window")
    rows, identifiers, token = [], set(), None
    for _ in range(100):
        params = {"after": start, "until": end, "direction": "asc", "page_size": "100"}
        if token is not None:
            params["page_token"] = token
        page = paper.get("/v2/account/activities", params)
        require(isinstance(page, list) and len(page) <= 100, "activity_page")
        for row in page:
            require(isinstance(row, dict) and isinstance(row.get("id"), str) and
                    0 < len(row["id"]) <= 256 and row["id"] not in identifiers, "activity_pagination_identity")
            identifiers.add(row["id"])
            rows.append(row)
        if len(page) < 100:
            return rows
        token = page[-1]["id"]
    require(False, "activity_listing_bound")


def collect_orders(paper, activities):
    ids = set()
    for row in activities:
        if row.get("activity_type") == "FILL":
            value = row.get("order_id")
            require(isinstance(value, str) and str(UUID(value)) == value, "fill_order_id")
            ids.add(value)
    require(len(ids) <= 1000, "order_lookup_bound")
    orders = {}
    for value in sorted(ids):
        order = paper.get("/v2/orders/" + value)
        require(isinstance(order, dict) and order.get("id") == value, "order_response_binding")
        orders[value] = order
    return orders


def equity_row(account, observed_at):
    equity = number(account.get("equity"))
    cash = number(account.get("cash"))
    require(equity >= 0, "negative_observed_equity")
    return {"date": stamp(observed_at).astimezone(ZoneInfo("America/New_York")).date().isoformat(),
            "observed_at": observed_at, "equity": str(equity), "cash": str(cash)}


def collect(config, state, *, clock=lambda: datetime.now(timezone.utc), binder=Binding):
    from .forward_cadence import observe

    binding = binder(config)
    existing = read_private(state / "ledger.json") if (state / "ledger.json").exists() else None
    if existing is not None:
        require(existing.get("schema_version") == 1 and existing.get("mode") == "paper" and
                existing.get("account_sha256") == binding.account_digest and
                existing.get("activities_since") == config["activities_since"] and
                existing.get("observed_since") == config["observed_since"], "historical_account_binding")
        equities = existing["equity_observations"]
        require(isinstance(equities, list) and len(equities) < 50000, "equity_history_bound")
    else:
        equities = []
    started = clock()
    require(started.tzinfo is not None and stamp(config["observed_since"]) <= started, "collection_clock")
    cadence = observe(binding.github, now=started, observed_since=stamp(config["observed_since"]),
                      approved_release_sha=config["approved_release_sha"], source_digests=config["source_digests"])
    account = binding.paper.get("/v2/account")
    binding.check_broker(account)
    observed = clock()
    require(started <= observed, "collection_clock_reversed")
    equities = [*equities, equity_row(account, observed.isoformat())]
    cutoff = clock()
    require(observed <= cutoff, "collection_clock_reversed")
    activities = collect_activities(binding.paper, config["activities_since"], cutoff.isoformat())
    orders = collect_orders(binding.paper, activities)
    binding.recheck()
    # Independently timestamped observations are not an atomic broker snapshot.
    # Intraday cashflow valuations needed for adjusted performance are absent.
    metrics = summarize_forward_observations(
        activities=activities, orders_by_id=orders, equity_observations=equities,
        window_start=config["observed_since"], window_end=cutoff.isoformat(),
        activities_complete=True, mode="paper")
    metrics["equity"]["flow_adjusted_drawdown_pct"] = None
    metrics["equity"]["flow_adjustment_status"] = "UNAVAILABLE"
    metrics["equity"]["reason"] = "intraday_cashflow_valuations_unavailable_nonatomic_observation"
    metrics["coverage"]["activity_creation_cutoff"] = cutoff.isoformat()
    metrics["coverage"]["collection_atomic"] = False
    ledger = {"schema_version": 1, "mode": "paper", "account_sha256": binding.account_digest,
              "activities_since": config["activities_since"], "observed_since": config["observed_since"],
              "equity_observations": equities,
              "activities": activities, "orders_by_id": orders, "collected_at": observed.isoformat()}
    ledger_hash = hashlib.sha256((json.dumps(ledger, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()).hexdigest()
    archived = state / "ledgers" / (ledger_hash + ".json")
    if archived.exists():
        require(read_private(archived, expected_sha256=ledger_hash) == ledger, "archived_ledger_changed")
    else:
        require(atomic_json(archived, ledger) == ledger_hash, "archived_ledger_digest")
    require(atomic_json(state / "ledger.json", ledger) == ledger_hash, "current_ledger_digest")
    finished = clock()
    require(cutoff <= finished, "collection_clock_reversed")
    report = {"schema_version": 1, "status": "COLLECTED", "mode": "paper",
              "checked_at": finished.isoformat(), "collection_started_at": started.isoformat(),
              "app_sha": config["app_sha"], "approved_paper_release_sha": config["approved_release_sha"],
              "ledger_sha256": ledger_hash, "cadence": cadence, "metrics": metrics,
              "broker_mutations": 0, "github_mutations": 0, "notifications_sent": 0,
              "funding_transfers": 0, "strategy_history_modified": False}
    name = finished.strftime("%Y%m%dT%H%M%S.%fZ") + ".json"
    atomic_json(state / "observations" / name, report)
    atomic_json(state / "latest-success.json", report)
    atomic_json(state / "latest.json", report)
    return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    state, stage = None, "host_guard"
    try:
        host_guard()
        stage = "configuration"
        config = validate_config(read_private(args.config, maximum=65536))
        state = Path(config["state_directory"])
        for directory in (state, state / "observations", state / "ledgers"):
            info = directory.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and
                    stat.S_IMODE(info.st_mode) == 0o700, "protected_state_directory")
        lock = os.open(state / "observer.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print(json.dumps({"forward_observer": "ALREADY_RUNNING"}))
                return 0
            stage = "collection"
            atomic_json(state / "latest.json", {
                "schema_version": 1, "status": "COLLECTING", "mode": "paper",
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "previous_success_is_not_current": True,
            })
            report = collect(config, state)
        finally:
            os.close(lock)
        print(json.dumps({"forward_observer": report["status"], "mode": "paper",
                          "report": str(state / "latest.json"), "broker_mutations": 0}))
        return 0
    except Exception:
        # Network/SDK exceptions can contain account data or signed URLs.
        result = {"schema_version": 1, "status": "FAILED", "stage": stage,
                  "checked_at": datetime.now(timezone.utc).isoformat(),
                  "reason": "observation_verification_failed", "previous_success_is_not_current": True}
        if state is not None and stage == "collection":
            try:
                atomic_json(state / "latest.json", result)
            except Exception:
                # Disk errors must not expose a preceding authenticated HTTP
                # exception through Python's chained traceback formatting.
                pass
        print(json.dumps({"forward_observer": "FAILED", "stage": stage}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
