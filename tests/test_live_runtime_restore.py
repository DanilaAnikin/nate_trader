"""Synthetic live restore: provenance, account binding, bootstrap and races."""

import io
import json
import stat
import zipfile
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest
import restore_live_runtime as live
from runtime_handoff import canonical_digest, digest

RELEASE = "a" * 40
OTHER_RELEASE = "b" * 40
NOW = datetime(2026, 9, 13, 13, 0, tzinfo=timezone.utc)


def encoded(value):
    return json.dumps(value, allow_nan=False).encode()


def zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


class Broker:
    def __init__(self):
        self.account = {
            "id": "00000000-0000-4000-8000-000000000123",
            "account_number": "SYNTHETIC_LIVE_ACCOUNT",
            "status": "ACTIVE",
            "currency": "USD",
            "account_blocked": False,
            "trading_blocked": False,
            "trade_suspended_by_user": False,
            "equity": "1000.00",
            "cash": "1000.00",
            "last_equity": "1000.00",
            "long_market_value": "0",
            "short_market_value": "0",
        }
        self.positions, self.orders, self.calls = [], [], []
        self.hook = None

    def get(self, name):
        self.calls.append(name)
        if self.hook:
            self.hook(self, name)
        return deepcopy(getattr(self, name))


class GitHub:
    def __init__(self):
        self.runs, self.jobs, self.artifacts, self.archives = {}, {}, {}, {}
        self.calls = []
        self.hook = None

    def add(
        self,
        files=None,
        *,
        release=RELEASE,
        run_id=1,
        artifact_id=100,
        conclusion="success",
        minute=-10,
    ):
        moment = NOW + timedelta(minutes=minute)
        stamp = lambda offset: (moment + timedelta(seconds=offset)).isoformat()
        self.runs[run_id] = {
            "id": run_id,
            "workflow_id": 22,
            "path": ".github/workflows/live-production.yml",
            "repository": {"id": 11},
            "head_repository": {"id": 11},
            "head_branch": "main",
            "head_sha": "f" * 40,
            "event": "workflow_dispatch",
            "run_attempt": 1,
            "status": "completed",
            "conclusion": conclusion,
            "created_at": stamp(-60),
            "run_started_at": stamp(-60),
            "updated_at": stamp(6),
        }
        self.jobs[run_id] = [
            {
                "id": run_id + 200,
                "run_id": run_id,
                "name": live.JOB,
                "steps": [
                    {
                        "name": live.EXECUTE,
                        "status": "completed",
                        "conclusion": conclusion,
                        "started_at": stamp(-30),
                        "completed_at": stamp(1),
                    },
                    {
                        "name": live.UPLOAD,
                        "status": "completed",
                        "conclusion": "success",
                        "started_at": stamp(2),
                        "completed_at": stamp(4),
                    },
                ],
            }
        ]
        if files is not None:
            from live_runtime_crypto import encrypt_runtime_blob

            files = dict(files)
            record = json.loads(files["production/last_run.json"])
            record["completed_at"] = stamp(0)
            files["production/last_run.json"] = encoded(record)
            raw = zip_bytes(
                {live.OUTER_FILE: encrypt_runtime_blob(zip_bytes(files), release)}
            )
            self.artifacts[artifact_id] = {
                "id": artifact_id,
                "name": "live-runtime-state-" + release,
                "expired": False,
                "size_in_bytes": len(raw),
                "digest": "sha256:" + digest(raw),
                "created_at": stamp(3),
                "workflow_run": {
                    "id": run_id,
                    "repository_id": 11,
                    "head_repository_id": 11,
                    "head_branch": "main",
                    "head_sha": "f" * 40,
                },
            }
            self.archives[artifact_id] = raw
        return self.runs[run_id]

    def get(self, path):
        self.calls.append(path)
        if self.hook:
            self.hook(self, path)
        parsed, query = urlsplit(path), parse_qs(urlsplit(path).query)
        if path == "":
            return {
                "id": 11,
                "full_name": "owner/public-repository",
                "default_branch": "main",
                "private": False,
            }
        if path == "/actions/workflows/live-production.yml":
            return {
                "id": 22,
                "path": ".github/workflows/live-production.yml",
                "state": "active",
            }
        if parsed.path == "/actions/artifacts":
            values = [
                entry
                for entry in self.artifacts.values()
                if not query.get("name") or entry["name"] == query["name"][0]
            ]
            return {"total_count": len(values), "artifacts": deepcopy(values)}
        if parsed.path == "/actions/workflows/live-production.yml/runs":
            return {
                "total_count": len(self.runs),
                "workflow_runs": deepcopy(list(self.runs.values())),
            }
        if parsed.path.startswith("/actions/runs/"):
            identifier = int(parsed.path.split("/")[3])
            if parsed.path.endswith("/jobs"):
                return {
                    "total_count": len(self.jobs[identifier]),
                    "jobs": deepcopy(self.jobs[identifier]),
                }
            return deepcopy(self.runs[identifier])
        raise AssertionError("Unexpected API route")

    def download(self, identifier):
        self.calls.append(("download", identifier))
        return self.archives[identifier]


@pytest.fixture
def fixture(tmp_path, monkeypatch):
    monkeypatch.setenv("LIVE_RUNTIME_KEY", "1" * 64)
    broker, api = Broker(), GitHub()
    context = live.Context(
        "owner/public-repository",
        RELEASE,
        999,
        broker.account["account_number"],
        True,
        1000,
    )
    state = tmp_path / "state"
    state.mkdir()
    (state / "performance.json").write_bytes(b"PAPER_SEED_MUST_NOT_EXECUTE")
    (state / "positions.json").write_bytes(b"PAPER_POSITIONS")
    (state / "production").mkdir()
    (state / "production/last_run.json").write_bytes(b"PAPER_RUN")
    (state / "backtest").mkdir()
    (state / "backtest/v11_validation.json").write_bytes(b"PRESERVE_RELEASE_INPUT")
    snapshot = live.empty_snapshot(broker, context)
    files = live.bootstrap_files(snapshot, context, NOW - timedelta(days=1))
    files["production/last_run.json"] = encoded(
        {
            "schema_version": 1,
            "kind": "v11_live_production_run",
            "paper_only": False,
            "broker_mode": "live",
            "release_sha": RELEASE,
            "status": "PASS",
            "completed_at": NOW.isoformat(),
        }
    )
    broker.calls.clear()
    return SimpleNamespace(
        api=api, broker=broker, context=context, state=state, files=files
    )


def restore(value, context=None):
    return live.restore(
        value.api, value.broker, context or value.context, value.state, now=NOW
    )


def assert_seed_untouched(value):
    assert (
        value.state / "performance.json"
    ).read_bytes() == b"PAPER_SEED_MUST_NOT_EXECUTE"
    assert (value.state / "production/last_run.json").read_bytes() == b"PAPER_RUN"


@pytest.mark.parametrize("tamper", [False, True])
def test_live_restore_requires_complete_matching_new_generation(fixture, tamper):
    from runtime_generation import cycle_outcome, prepare_runtime_generation

    performance = json.loads(fixture.files["performance.json"])
    positions = json.loads(fixture.files["positions.json"])
    last_run = json.loads(fixture.files["production/last_run.json"])
    performance.update(updated_at=NOW.isoformat(), num_positions=len(positions["positions"]))
    positions["updated_at"] = NOW.isoformat()
    last_run["cycle_outcome"] = cycle_outcome("pending", "orders_pending")
    files = prepare_runtime_generation(performance, positions, last_run,
                                       execution_context={"release_sha": RELEASE,
                                                          "github_run_id": 1,
                                                          "github_run_attempt": 1})
    if tamper:
        files["positions.json"] += b" "
    account_sha = performance["live_runtime_binding"]["account_sha256"]
    if tamper:
        with pytest.raises(live.RestoreError, match="live_runtime_generation_invalid"):
            live.validate_runtime(files, fixture.context, account_sha)
    else:
        record = live.validate_runtime(files, fixture.context, account_sha)
        assert record["cycle_outcome"]["state"] == "pending"


def test_live_outcome_without_generation_cannot_be_relabelled_as_legacy(fixture):
    from runtime_generation import cycle_outcome

    files = deepcopy(fixture.files)
    run = json.loads(files["production/last_run.json"])
    run["cycle_outcome"] = cycle_outcome("completed", "rebalance_complete")
    files["production/last_run.json"] = encoded(run)
    performance = json.loads(files["performance.json"])
    with pytest.raises(live.RestoreError, match="live_runtime_generation_invalid"):
        live.validate_runtime(files, fixture.context,
                              performance["live_runtime_binding"]["account_sha256"])


@pytest.mark.parametrize("run_id,attempt,accepted", [(1, 1, True), (2, 1, False), (1, 2, False)])
def test_live_generation_must_belong_to_artifact_execution(fixture, run_id, attempt, accepted):
    from runtime_generation import cycle_outcome, prepare_runtime_generation

    observed = (NOW - timedelta(minutes=10)).isoformat()
    performance = json.loads(fixture.files["performance.json"])
    positions = json.loads(fixture.files["positions.json"])
    record = json.loads(fixture.files["production/last_run.json"])
    performance.update(updated_at=observed, num_positions=len(positions["positions"]))
    positions["updated_at"] = observed
    record.update(completed_at=observed, cycle_outcome=cycle_outcome("pending", "orders_pending"))
    files = prepare_runtime_generation(performance, positions, record,
                                       execution_context={"release_sha": RELEASE,
                                                          "github_run_id": run_id,
                                                          "github_run_attempt": attempt})
    fixture.api.add(files)
    if accepted:
        assert restore(fixture) == "native"
    else:
        with pytest.raises(live.RestoreError, match="runtime_generation_run"):
            restore(fixture)
        assert_seed_untouched(fixture)


def test_bootstrap_creates_genuine_live_snapshot_without_fake_execution(fixture):
    assert restore(fixture) == "bootstrap"
    performance = json.loads((fixture.state / "performance.json").read_bytes())
    assert performance["equity"] == performance["cash"] == 1000
    assert performance["daily_history"][0]["equity"] == 1000
    assert performance["adaptive_rebalance_pending"] is None
    assert performance[live.BINDING_KEY]["broker_mode"] == "live"
    assert not (fixture.state / "production/last_run.json").exists()
    assert (
        json.loads((fixture.state / "positions.json").read_bytes())["positions"] == []
    )
    assert (
        fixture.state / "backtest/v11_validation.json"
    ).read_bytes() == b"PRESERVE_RELEASE_INPUT"
    assert (fixture.state / "performance.json").stat().st_mode & 0o777 == 0o600
    assert (
        fixture.broker.calls.count("positions")
        == fixture.broker.calls.count("orders")
        == 3
    )


def test_bootstrap_rejects_larger_shared_account_capital(fixture):
    fixture.broker.account["equity"] = fixture.broker.account["cash"] = "1000.01"
    with pytest.raises(
        live.RestoreError, match="live_bootstrap_capital_exceeds_budget"
    ):
        restore(fixture)
    assert_seed_untouched(fixture)


def test_newly_funded_account_creates_observation_without_fictional_profit(fixture):
    fixture.broker.account["last_equity"] = "0"
    assert restore(fixture) == "bootstrap"
    performance = json.loads((fixture.state / "performance.json").read_bytes())
    assert performance["broker_last_equity"] == 0
    assert performance["equity"] == 1000
    assert "daily_pnl" not in performance
    assert "daily_pnl_pct" not in performance
    assert len(performance["daily_history"]) == 1
    assert "pnl" not in performance["daily_history"][0]
    assert "pnl_pct" not in performance["daily_history"][0]


def test_missing_state_never_implicitly_seeds_or_bootstraps(fixture):
    with pytest.raises(live.RestoreError, match="live_bootstrap_required"):
        restore(fixture, replace(fixture.context, bootstrap=False))
    assert_seed_untouched(fixture)


@pytest.mark.parametrize("resource", ["positions", "orders"])
def test_bootstrap_refuses_nonempty_account(fixture, resource):
    setattr(fixture.broker, resource, [{"synthetic": "existing"}])
    with pytest.raises(live.RestoreError, match="present"):
        restore(fixture)
    assert_seed_untouched(fixture)


@pytest.mark.parametrize(
    "field,value",
    [
        ("account_number", "ANOTHER_ACCOUNT"),
        ("status", "CLOSED"),
        ("account_blocked", True),
        ("trading_blocked", True),
        ("trade_suspended_by_user", True),
        ("currency", "EUR"),
        ("id", "not-a-uuid"),
        ("equity", "nan"),
        ("cash", "999"),
        ("long_market_value", "1"),
        ("short_market_value", "-1"),
        ("last_equity", "-1"),
        ("equity", True),
    ],
)
def test_bootstrap_refuses_wrong_binding_or_unusable_account(fixture, field, value):
    fixture.broker.account[field] = value
    with pytest.raises(live.RestoreError):
        restore(fixture)
    assert_seed_untouched(fixture)


def test_bootstrap_refuses_changed_snapshot(fixture):
    def hook(broker, name):
        if name == "account" and broker.calls.count("account") >= 3:
            broker.account["equity"] = broker.account["cash"] = "999"

    fixture.broker.hook = hook
    with pytest.raises(live.RestoreError, match="snapshot_changed"):
        restore(fixture)
    assert_seed_untouched(fixture)


@pytest.mark.parametrize(
    "conclusion", ["success", "failure", "cancelled", "timed_out", None]
)
def test_bootstrap_refuses_prior_or_unknown_execution_without_artifact(
    fixture, conclusion
):
    fixture.api.add(conclusion=conclusion)
    with pytest.raises(live.RestoreError, match="prior_or_unknown_execution"):
        restore(fixture)
    assert_seed_untouched(fixture)


def test_bootstrap_allows_explicit_prior_read_only_preflight(fixture):
    fixture.api.add(conclusion="skipped")
    assert restore(fixture) == "bootstrap"


def test_bootstrap_refuses_expired_artifacts_of_other_release(fixture):
    fixture.api.artifacts[100] = {
        "id": 100,
        "name": "live-runtime-state-" + OTHER_RELEASE,
        "expired": True,
    }
    with pytest.raises(live.RestoreError, match="prior_artifact"):
        restore(fixture)
    assert_seed_untouched(fixture)


def test_bootstrap_rechecks_absence_after_staging(fixture):
    def hook(api, path):
        if (
            path.startswith("/actions/workflows/live-production.yml/runs")
            and api.calls.count(path) >= 2
        ):
            api.artifacts[100] = {
                "id": 100,
                "name": "live-runtime-state-" + RELEASE,
                "expired": False,
            }

    fixture.api.hook = hook
    with pytest.raises(live.RestoreError, match="prior_artifact"):
        restore(fixture)
    assert_seed_untouched(fixture)


def test_restore_preserves_kill_switch_bytes(fixture):
    marker = fixture.state / "production/LIVE_TRADING_DISABLED"
    marker.write_bytes(b"operator disabled live trading")
    assert restore(fixture) == "bootstrap"
    assert marker.read_bytes() == b"operator disabled live trading"


def test_kill_switch_created_during_staging_blocks_swap(fixture):
    def hook(broker, name):
        if name == "account" and broker.calls.count("account") >= 3:
            (fixture.state / "production/LIVE_TRADING_DISABLED").write_bytes(
                b"disabled"
            )

    fixture.broker.hook = hook
    with pytest.raises(live.RestoreError, match="kill_switch_changed"):
        restore(fixture)
    assert_seed_untouched(fixture)


def test_latest_failed_encrypted_runtime_is_authoritative(fixture):
    fixture.api.add(fixture.files, run_id=1, artifact_id=100, minute=-20)
    changed = deepcopy(fixture.files)
    record = json.loads(changed["production/last_run.json"])
    record["status"] = "FAIL"
    changed["production/last_run.json"] = encoded(record)
    fixture.api.add(
        changed, run_id=2, artifact_id=101, conclusion="failure", minute=-10
    )
    assert restore(fixture) == "native"
    assert (
        json.loads((fixture.state / "production/last_run.json").read_bytes())["status"]
        == "FAIL"
    )
    assert ("download", 100) not in fixture.api.calls


def test_native_restore_accepts_gains_above_initial_budget(fixture):
    fixture.api.add(fixture.files)
    fixture.broker.account["equity"] = fixture.broker.account["cash"] = "1100"
    assert restore(fixture) == "native"


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "timed_out"])
def test_newer_execution_without_artifact_blocks_fallback(fixture, conclusion):
    fixture.api.add(fixture.files, minute=-20)
    fixture.api.add(run_id=2, conclusion=conclusion, minute=-10)
    with pytest.raises(live.RestoreError, match="newer_execution"):
        restore(fixture)
    assert_seed_untouched(fixture)


@pytest.mark.parametrize(
    "field,value",
    [
        ("workflow_id", 999),
        ("head_branch", "feature"),
        ("event", "pull_request"),
        ("run_attempt", 2),
        ("head_repository", {"id": 777}),
    ],
)
def test_provenance_refuses_fork_branch_workflow_event_or_rerun(fixture, field, value):
    fixture.api.add(fixture.files)[field] = value
    with pytest.raises(live.RestoreError):
        restore(fixture)
    assert_seed_untouched(fixture)


@pytest.mark.parametrize(
    "mutation", ["binding", "release", "paper", "digest", "expired", "plain"]
)
def test_native_runtime_refuses_wrong_lineage_or_tamper(fixture, mutation):
    files = deepcopy(fixture.files)
    if mutation == "binding":
        performance = json.loads(files["performance.json"])
        performance[live.BINDING_KEY]["account_sha256"] = "0" * 64
        files["performance.json"] = encoded(performance)
    if mutation in ("release", "paper"):
        record = json.loads(files["production/last_run.json"])
        record.update(
            {"release_sha": OTHER_RELEASE}
            if mutation == "release"
            else {"paper_only": True, "kind": "v11_paper_production_run"}
        )
        files["production/last_run.json"] = encoded(record)
    fixture.api.add(files)
    if mutation == "digest":
        fixture.api.artifacts[100]["digest"] = "sha256:" + "0" * 64
    if mutation == "expired":
        fixture.api.artifacts[100]["expired"] = True
    if mutation == "plain":
        raw = zip_bytes(files)
        fixture.api.archives[100] = raw
        fixture.api.artifacts[100]["digest"] = "sha256:" + digest(raw)
    with pytest.raises(live.RestoreError):
        restore(fixture)
    assert_seed_untouched(fixture)


def test_changed_artifact_before_swap_is_refused(fixture):
    fixture.api.add(fixture.files)

    def hook(api, path):
        if path.startswith("/actions/workflows/live-production.yml/runs"):
            api.artifacts[100]["digest"] = "sha256:" + "0" * 64

    fixture.api.hook = hook
    with pytest.raises(live.RestoreError, match="changed_runtime_artifact"):
        restore(fixture)
    assert_seed_untouched(fixture)


@pytest.mark.parametrize(
    "name",
    [
        "../runtime.aesgcm",
        "/runtime.aesgcm",
        "runtime.aesgcm/",
        "paper.json",
        "x\\runtime.aesgcm",
    ],
)
def test_outer_archive_refuses_wrong_paths_or_plaintext(name):
    with pytest.raises(live.RestoreError):
        live.outer_ciphertext(zip_bytes({name: b"synthetic-ciphertext"}))


def test_outer_archive_refuses_symlinks_and_extra_entries():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        member = zipfile.ZipInfo(live.OUTER_FILE)
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(member, b"elsewhere")
    with pytest.raises(live.RestoreError):
        live.outer_ciphertext(output.getvalue())
    with pytest.raises(live.RestoreError):
        live.outer_ciphertext(zip_bytes({live.OUTER_FILE: b"x", "extra": b"y"}))


def test_broker_transport_is_only_fixed_live_get():
    broker = live.LiveBroker("synthetic-key", "synthetic-secret")
    seen = []

    class Response(io.BytesIO):
        status = 200

    def opened(request, timeout):
        seen.append(request)
        return Response(b"[]")

    broker.opener = SimpleNamespace(open=opened)
    assert broker.get("positions") == []
    assert seen[0].get_method() == "GET"
    assert seen[0].full_url == "https://api.alpaca.markets/v2/positions"
    with pytest.raises(live.RestoreError, match="live_read_route"):
        broker.get("https://paper-api.alpaca.markets/v2/account")
    assert len(seen) == 1
    assert (
        live.NoRedirect().redirect_request(
            None, None, 302, "", {}, "https://other.invalid"
        )
        is None
    )


def test_cli_failure_never_prints_exception_or_credentials(monkeypatch, capsys):
    monkeypatch.setenv("TRADING_MODE", "paper-private-canary")
    assert live.main() == 1
    output = capsys.readouterr().out
    assert json.loads(output) == {
        "live_runtime_restore": "FAIL",
        "stage": "configuration",
        "code": "live_mode_required",
    }
    assert "private-canary" not in output


def test_http_failure_does_not_log_body_or_keys(capsys):
    broker = live.LiveBroker("canary-secret-key", "canary-secret-value")

    def opened(request, timeout):
        raise HTTPError(
            request.full_url,
            403,
            "canary-response-body",
            {},
            io.BytesIO(b"canary-payload"),
        )

    broker.opener = SimpleNamespace(open=opened)
    with pytest.raises(HTTPError):
        broker.get("account")
    assert capsys.readouterr().out == ""


def test_account_digest_has_no_account_number(fixture):
    _, value = live.bound_account(fixture.broker, fixture.context)
    assert value == canonical_digest(
        {"broker": "alpaca", "mode": "live", "account_id": fixture.broker.account["id"]}
    )
    assert fixture.broker.account["account_number"] not in value
