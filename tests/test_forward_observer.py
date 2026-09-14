"""Pure transport doubles: paper observations never become execution commands."""

import fcntl
import hashlib
import json
import os
import stat
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import UUID

import pytest

from ops import forward_cadence
from ops import forward_observer as observer
from ops.forward_observer_access import ObservationError

ORDER = "11111111-1111-4111-8111-111111111111"
OLD_ORDER = "22222222-2222-4222-8222-222222222222"
ACCOUNT = "a" * 64
NOW = datetime(2026, 9, 15, 0, 0, tzinfo=timezone.utc)


def fill(identity="fill-1", order=ORDER, when="2026-09-14T23:00:00Z"):
    return {"id": identity, "activity_type": "FILL", "type": "partial_fill",
            "order_id": order, "transaction_time": when, "symbol": "AAA",
            "side": "buy", "qty": "1", "price": "99"}


def order(identity=ORDER):
    return {"id": identity, "symbol": "AAA", "side": "buy", "qty": "10",
            "filled_qty": "1", "status": "partially_filled", "type": "limit",
            "limit_price": "100"}


class FakePaper:
    def __init__(self, pages=None, orders=None):
        self.pages = [[]] if pages is None else deepcopy(pages)
        self.orders = {ORDER: order(), OLD_ORDER: order(OLD_ORDER)} if orders is None else orders
        self.account = {"equity": "1000", "cash": "800", "private": "PRIVATE_ACCOUNT_SENTINEL"}
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, deepcopy(params)))
        if path == "/v2/account":
            return deepcopy(self.account)
        if path == "/v2/account/activities":
            assert self.pages, "Unexpected extra page request"
            value = self.pages.pop(0)
            if isinstance(value, Exception):
                raise value
            return deepcopy(value)
        if path.startswith("/v2/orders/"):
            return deepcopy(self.orders[path.removeprefix("/v2/orders/")])
        raise AssertionError("Unexpected transport path")


class FakeGitHub:
    def get(self, *_args, **_kwargs):
        raise AssertionError("Cadence must be replaced with a pure fixture")


class FakeBinder:
    def __init__(self, paper=None, digest=ACCOUNT, fail_recheck=False):
        self.paper = FakePaper() if paper is None else paper
        self.github = FakeGitHub()
        self.account_digest = digest
        self.checked = self.rechecked = False
        self.fail_recheck = fail_recheck
        self.protected_approval_evidence = {
            "status": "VERIFIED", "verified": True, "reason": None,
            "variables": {"PRODUCTION_RELEASE_SHA": "VERIFIED", "PAPER_RUNTIME_HANDOFF_SHA256": "VERIFIED"},
        }

    def __call__(self, config):
        self.config = config
        return self

    def check_broker(self, account):
        assert account == self.paper.account
        self.checked = True

    def recheck(self):
        if self.fail_recheck:
            raise ValueError("PRIVATE_CREDENTIAL_SENTINEL")
        self.rechecked = True


def clock(now=NOW):
    ticks = iter(now + timedelta(seconds=index) for index in range(4))
    return lambda: next(ticks)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    state = tmp_path / "state"
    for directory in (state, state / "observations", state / "ledgers"):
        directory.mkdir(mode=0o700)
    config = {"schema_version": 1, "app_container": "natetrader-dashboard-test-active",
              "app_sha": "b" * 40, "app_image": "sha256:" + "c" * 64,
              "approved_release_sha": "d" * 40, "paper_handoff_sha256": "e" * 64,
              "state_directory": "/var/lib/homelab/nate-trader/forward-observation",
              "activities_since": "2026-08-11T00:00:00Z",
              "observed_since": "2026-09-14T21:00:00Z",
              "source_digests": {name: "f" * 64 for name in observer.SOURCE_PATHS}}
    cadence_calls = []

    def observe(github, **kwargs):
        assert isinstance(github, FakeGitHub)
        cadence_calls.append(kwargs)
        return {"status": "OBSERVED", "natural_execution_confirmed": False}

    monkeypatch.setattr(forward_cadence, "observe", observe)
    return config, state, cadence_calls


def test_complete_walk_keeps_fixed_start_cutoff_and_requires_final_short_page():
    first = [{"id": f"activity-{index}"} for index in range(100)]
    paper = FakePaper([first, []])
    rows = observer.collect_activities(paper, "2026-08-11T00:00:00Z", "2026-09-15T00:00:00Z")
    assert len(rows) == 100 and len(paper.calls) == 2
    for index, (path, params) in enumerate(paper.calls):
        assert path == "/v2/account/activities"
        assert params == {"after": "2026-08-11T00:00:00Z", "until": "2026-09-15T00:00:00Z",
                          "direction": "asc", "page_size": "100",
                          **({"page_token": "activity-99"} if index else {})}
        assert "activity_types" not in params and "category" not in params


@pytest.mark.parametrize("pages", [
    [[{"id": "same"}, {"id": "same"}]],
    [[{"id": str(index)} for index in range(100)], [{"id": "99"}]],
    [[{}]], [[{"id": ""}]], [[{"id": 1}]], [[{"id": "a"}] * 101],
])
def test_duplicate_malformed_or_oversized_page_is_not_complete(pages):
    with pytest.raises(ObservationError):
        observer.collect_activities(FakePaper(pages), "2026-08-11T00:00:00Z", "2026-09-15T00:00:00Z")


def test_page_limit_is_not_silent_truncation():
    pages = [[{"id": f"{page}-{index}"} for index in range(100)] for page in range(100)]
    with pytest.raises(ObservationError, match="activity_listing_bound"):
        observer.collect_activities(FakePaper(pages), "2026-08-11T00:00:00Z", "2026-09-15T00:00:00Z")


def test_order_lookup_deduplicates_only_fill_ids_and_binds_exact_returned_order():
    paper = FakePaper()
    result = observer.collect_orders(paper, [fill(), fill("fill-2"), {"activity_type": "FEE"}])
    assert result == {ORDER: order()}
    assert paper.calls == [(f"/v2/orders/{ORDER}", None)]
    paper.orders[ORDER]["id"] = OLD_ORDER
    with pytest.raises(ObservationError, match="order_response_binding"):
        observer.collect_orders(paper, [fill()])


@pytest.mark.parametrize("value", [None, 1, "not-a-uuid", "../account", ORDER.replace("-", ""),
                                   "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"])
def test_invalid_order_uuid_never_reaches_transport(value):
    paper = FakePaper()
    with pytest.raises((ObservationError, ValueError)):
        observer.collect_orders(paper, [fill(order=value)])
    assert paper.calls == []


def test_order_lookup_limit_is_enforced_before_any_request():
    rows = [fill(str(index), str(UUID(int=index + 1))) for index in range(1001)]
    paper = FakePaper()
    with pytest.raises(ObservationError, match="order_lookup_bound"):
        observer.collect_orders(paper, rows)
    assert paper.calls == []


def test_collect_uses_new_forward_window_but_rewalks_and_retains_old_activities(setup):
    config, state, cadence_calls = setup
    old = fill("old", OLD_ORDER, "2026-08-11T16:00:00Z")
    binder = FakeBinder(FakePaper([[old, fill()]]))
    report = observer.collect(config, state, clock=clock(), binder=binder)
    assert binder.checked and binder.rechecked
    assert report["status"] == "COLLECTED"
    assert report["protected_approval_evidence"] == binder.protected_approval_evidence
    assert report["metrics"]["window_start"] == "2026-09-14T21:00:00+00:00"
    assert report["metrics"]["fills"]["event_count"] == 1
    assert report["metrics"]["coverage"]["activities_complete"] is True
    assert report["metrics"]["coverage"]["activity_creation_cutoff"] == "2026-09-15T00:00:02+00:00"
    assert report["metrics"]["coverage"]["collection_atomic"] is False
    assert report["metrics"]["equity"]["flow_adjusted_drawdown_pct"] is None
    assert report["broker_mutations"] == report["github_mutations"] == report["notifications_sent"] == 0
    assert report["strategy_history_modified"] is False
    ledger = observer.read_private(state / "ledger.json")
    assert len(ledger["activities"]) == 2
    assert ledger["equity_observations"][0]["date"] == "2026-09-14"
    assert cadence_calls == [{"now": NOW, "observed_since": datetime(2026, 9, 14, 21, tzinfo=timezone.utc),
                              "approved_release_sha": config["approved_release_sha"],
                              "source_digests": config["source_digests"]}]


def test_forbidden_approval_read_collects_metrics_without_claiming_approval_verified(setup):
    config, state, _ = setup
    binder = FakeBinder(FakePaper([[fill()]]))
    binder.protected_approval_evidence = {
        "status": "UNAVAILABLE", "verified": False, "reason": "github_environment_read_forbidden",
        "variables": {"PRODUCTION_RELEASE_SHA": "HTTP_403", "PAPER_RUNTIME_HANDOFF_SHA256": "HTTP_403"},
    }
    report = observer.collect(config, state, clock=clock(), binder=binder)
    assert binder.checked and binder.rechecked
    assert report["status"] == "COLLECTED_WITH_LIMITED_APPROVAL_EVIDENCE"
    assert report["protected_approval_evidence"] == binder.protected_approval_evidence
    assert report["metrics"]["fills"]["event_count"] == 1
    assert report["broker_mutations"] == report["github_mutations"] == 0
    for name in ("latest.json", "latest-success.json"):
        assert observer.read_private(state / name) == report


def test_each_ledger_is_retained_by_exact_raw_digest_and_latest_pointers_match(setup):
    config, state, _ = setup
    first = observer.collect(config, state, clock=clock(), binder=FakeBinder())
    old_path = state / "ledgers" / (first["ledger_sha256"] + ".json")
    old_bytes = old_path.read_bytes()
    second = observer.collect(config, state, clock=clock(NOW + timedelta(days=1)), binder=FakeBinder())
    assert second["ledger_sha256"] != first["ledger_sha256"]
    assert old_path.read_bytes() == old_bytes
    for report in (first, second):
        archived = state / "ledgers" / (report["ledger_sha256"] + ".json")
        assert hashlib.sha256(archived.read_bytes()).hexdigest() == report["ledger_sha256"]
    assert len(observer.read_private(state / "ledger.json")["equity_observations"]) == 2
    assert len(list((state / "observations").glob("*.json"))) == 2
    assert observer.read_private(state / "latest-success.json") == second
    assert observer.read_private(state / "latest.json") == second
    for path in state.rglob("*.json"):
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_existing_archive_with_identical_json_but_different_bytes_is_refused(setup):
    config, state, _ = setup
    report = observer.collect(config, state, clock=clock(), binder=FakeBinder())
    archived = state / "ledgers" / (report["ledger_sha256"] + ".json")
    archived.write_bytes(archived.read_bytes() + b" \n")
    (state / "ledger.json").unlink()  # Reproduce exact same synthetic generation.
    with pytest.raises(ObservationError):
        observer.collect(config, state, clock=clock(), binder=FakeBinder())


@pytest.mark.parametrize("change", [{"account_sha256": "9" * 64}, {"mode": "live"},
                                   {"activities_since": "2026-08-12T00:00:00Z"},
                                   {"observed_since": "2026-09-14T22:00:00Z"},
                                   {"schema_version": 2}])
def test_old_ledger_from_another_binding_is_never_reused(setup, change):
    config, state, _ = setup
    observer.atomic_json(state / "ledger.json", {"schema_version": 1, "mode": "paper",
                         "account_sha256": ACCOUNT, "activities_since": config["activities_since"],
                         "observed_since": config["observed_since"],
                         "equity_observations": [], **change})
    before = (state / "ledger.json").read_bytes()
    binder = FakeBinder()
    with pytest.raises(ObservationError, match="historical_account_binding"):
        observer.collect(config, state, clock=clock(), binder=binder)
    assert binder.paper.calls == []
    assert (state / "ledger.json").read_bytes() == before


def test_failed_pagination_or_account_recheck_publishes_no_new_success(setup):
    config, state, _ = setup
    for binder in (FakeBinder(FakePaper([ValueError("PRIVATE_NETWORK_SENTINEL")])),
                   FakeBinder(fail_recheck=True)):
        with pytest.raises(ValueError):
            observer.collect(config, state, clock=clock(), binder=binder)
        assert not (state / "ledger.json").exists()
        assert not (state / "latest-success.json").exists()
        assert list((state / "ledgers").iterdir()) == []


def test_private_reader_refuses_public_mode_symlink_hardlink_and_empty_file(tmp_path):
    file = tmp_path / "input.json"
    observer.atomic_json(file, {"value": 1})
    assert observer.read_private(file) == {"value": 1}
    file.chmod(0o644)
    with pytest.raises(ObservationError, match="private_file_required"):
        observer.read_private(file)
    empty = tmp_path / "empty.json"
    empty.write_bytes(b"")
    empty.chmod(0o600)
    with pytest.raises(ObservationError, match="private_file_required"):
        observer.read_private(empty)
    file.chmod(0o600)
    link = tmp_path / "link"
    link.symlink_to(file)
    with pytest.raises(OSError):
        observer.read_private(link)
    os.link(file, tmp_path / "hardlink")
    with pytest.raises(ObservationError, match="private_file_required"):
        observer.read_private(file)


def test_atomic_publish_replaces_only_after_complete_fsynced_bytes_and_cleans_failure(tmp_path, monkeypatch):
    target = tmp_path / "latest.json"
    observer.atomic_json(target, {"generation": 1})
    before = target.read_bytes()
    replace = os.replace
    calls = []

    def publish(source, destination):
        calls.append("replace")
        assert target.read_bytes() == before
        assert json.loads(Path(source).read_bytes()) == {"generation": 2}
        assert stat.S_IMODE(Path(source).stat().st_mode) == 0o600
        replace(source, destination)

    monkeypatch.setattr(observer.os, "replace", publish)
    monkeypatch.setattr(observer.os, "fsync", lambda _fd: calls.append("fsync"))
    digest = observer.atomic_json(target, {"generation": 2})
    assert calls == ["fsync", "replace", "fsync"]
    assert hashlib.sha256(target.read_bytes()).hexdigest() == digest
    before = target.read_bytes()

    def fail(*_args):
        raise OSError("write_failed")

    monkeypatch.setattr(observer.os, "replace", fail)
    with pytest.raises(OSError):
        observer.atomic_json(target, {"generation": 3})
    assert target.read_bytes() == before
    assert list(tmp_path.glob(".observer-*")) == []


def main_setup(setup, monkeypatch, tmp_path):
    config, state, _ = setup
    config_path = tmp_path / "config.json"
    observer.atomic_json(config_path, config)
    validate = observer.validate_config
    monkeypatch.setattr(observer, "host_guard", lambda: None)
    monkeypatch.setattr(observer, "validate_config", lambda value: {**validate(value), "state_directory": str(state)})
    monkeypatch.setattr("sys.argv", ["forward-observer", "--config", str(config_path)])
    lstat = Path.lstat

    def root_directory(path):
        info = lstat(path)
        if path in (state, state / "observations", state / "ledgers"):
            fields = list(info)
            fields[4] = 0  # Unit tests do not require actual host-root directories.
            return os.stat_result(fields)
        return info

    monkeypatch.setattr(Path, "lstat", root_directory)
    return state


def test_main_failure_marks_current_failed_retains_historical_success_and_emits_no_private_data(setup, monkeypatch, tmp_path, capsys):
    state = main_setup(setup, monkeypatch, tmp_path)
    old = {"status": "COLLECTED", "checked_at": "2026-09-14T21:00:00Z"}
    observer.atomic_json(state / "latest-success.json", old)
    observer.atomic_json(state / "latest.json", old)

    def fail(*_args):
        raise ValueError("PRIVATE_CREDENTIAL_SENTINEL")

    monkeypatch.setattr(observer, "collect", fail)
    assert observer.main() == 1
    current = observer.read_private(state / "latest.json")
    assert current["status"] == "FAILED" and current["previous_success_is_not_current"] is True
    assert observer.read_private(state / "latest-success.json") == old
    output = capsys.readouterr()
    assert "PRIVATE" not in output.out + output.err
    assert json.loads(output.out) == {"forward_observer": "FAILED", "stage": "collection"}


def test_failure_to_publish_failure_receipt_still_has_fixed_output_not_chained_private_exception(setup, monkeypatch, tmp_path, capsys):
    main_setup(setup, monkeypatch, tmp_path)
    atomic_json = observer.atomic_json
    collected = []

    def fail_collect(*_args):
        collected.append(True)
        raise ValueError("PRIVATE_CREDENTIAL_SENTINEL")

    def fail_publish(path, value):
        if value.get("status") == "FAILED":
            raise OSError("PRIVATE_STORAGE_SENTINEL")
        return atomic_json(path, value)

    monkeypatch.setattr(observer, "collect", fail_collect)
    monkeypatch.setattr(observer, "atomic_json", fail_publish)
    assert observer.main() == 1
    assert collected == [True]
    output = capsys.readouterr()
    assert "PRIVATE" not in output.out + output.err
    assert json.loads(output.out)["forward_observer"] == "FAILED"


def test_interruption_keeps_collecting_marker_written_under_lock_not_old_current_success(setup, monkeypatch, tmp_path, capsys):
    state = main_setup(setup, monkeypatch, tmp_path)
    old = {"status": "COLLECTED", "checked_at": "2026-09-14T21:00:00Z"}
    observer.atomic_json(state / "latest-success.json", old)
    observer.atomic_json(state / "latest.json", old)
    retained = (state / "latest-success.json").read_bytes()
    seen = []

    def interrupted(*_args):
        marker = observer.read_private(state / "latest.json")
        assert marker["status"] == "COLLECTING"
        assert marker["previous_success_is_not_current"] is True
        assert marker["mode"] == "paper" and marker["checked_at"] != old["checked_at"]
        with (state / "observer.lock").open("r") as contender, pytest.raises(BlockingIOError):
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        seen.append(marker)
        raise SystemExit(143)  # Bypass Exception handling without real signals.

    monkeypatch.setattr(observer, "collect", interrupted)
    with pytest.raises(SystemExit) as caught:
        observer.main()
    assert caught.value.code == 143
    assert len(seen) == 1
    assert observer.read_private(state / "latest.json") == seen[0]
    assert (state / "latest-success.json").read_bytes() == retained
    with (state / "observer.lock").open("r") as contender:
        fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert capsys.readouterr().out == ""
