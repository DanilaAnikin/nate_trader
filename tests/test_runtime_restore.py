"""Runtime transport cannot substitute stale PASS, release seed or fake lineage."""

import io
import stat
import zipfile
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest
import restore_paper_runtime as transport
import runtime_handoff as handoff

from tests.test_runtime_handoff import (
    SOURCE_SHA,
    TARGET_IDENTITY,
    TARGET_SHA,
    encoded,
)
from tests.test_runtime_handoff import (
    transfer as _transfer_fixture,
)

transfer = _transfer_fixture


def archive(files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for name, content in files.items():
            output.writestr(name, content)
    return buffer.getvalue()


class FakeGitHub:
    def __init__(self, fixture):
        self.runs = {}
        self.jobs = {}
        self.artifacts = {}
        self.archives = {}
        self.requests = []
        self.list_hook = None
        self.run_list_reads = 0
        self.now = fixture.now

    def add(
        self, release, files, *, run_id=123, artifact_id=456, failed=False, minutes=0
    ):
        if release == TARGET_SHA and artifact_id is not None and minutes == 0:
            minutes = 10
        now = self.now + timedelta(minutes=minutes)
        iso = lambda offset: (now + timedelta(seconds=offset)).isoformat()
        run = {
            "id": run_id,
            "workflow_id": 2,
            "path": ".github/workflows/paper-production.yml",
            "repository": {"id": 1},
            "head_repository": {"id": 1},
            "head_branch": "main",
            "head_sha": "f" * 40,
            "event": "workflow_dispatch",
            "run_attempt": 1,
            "status": "completed",
            "conclusion": "failure" if failed else "success",
            "created_at": iso(-300),
            "run_started_at": iso(-300),
            "updated_at": iso(5),
        }
        self.runs[run_id] = run
        steps = [
            {
                "name": transport.EXECUTE,
                "status": "completed",
                "conclusion": "failure" if failed else "success",
                "started_at": iso(-200),
                "completed_at": iso(1),
            },
            {
                "name": transport.UPLOAD,
                "status": "completed",
                "conclusion": "success",
                "started_at": iso(2),
                "completed_at": iso(4),
            },
        ]
        self.jobs[run_id] = [
            {
                "id": run_id + 1000,
                "run_id": run_id,
                "name": transport.JOB,
                "steps": steps,
            }
        ]
        if artifact_id is not None:
            raw = archive(files)
            artifact = {
                "id": artifact_id,
                "name": "paper-runtime-state-" + release,
                "expired": False,
                "size_in_bytes": len(raw),
                "digest": "sha256:" + handoff.digest(raw),
                "created_at": iso(3),
                "workflow_run": {
                    "id": run_id,
                    "repository_id": 1,
                    "head_repository_id": 1,
                    "head_branch": "main",
                    "head_sha": "f" * 40,
                },
            }
            self.artifacts[artifact_id] = artifact
            self.archives[artifact_id] = raw
        return run

    def get(self, path):
        self.requests.append(path)
        parsed = urlsplit(path)
        query = parse_qs(parsed.query)
        if path == "":
            return {
                "id": 1,
                "full_name": "owner/private",
                "private": False,
                "default_branch": "main",
            }
        if path == "/actions/workflows/paper-production.yml":
            return {
                "id": 2,
                "path": ".github/workflows/paper-production.yml",
                "state": "active",
            }
        if parsed.path == "/actions/artifacts":
            values = [
                value
                for value in self.artifacts.values()
                if value["name"] == query["name"][0]
            ]
            return {"total_count": len(values), "artifacts": deepcopy(values)}
        if parsed.path == "/actions/workflows/paper-production.yml/runs":
            self.run_list_reads += 1
            if self.list_hook:
                self.list_hook(self)
            return {
                "total_count": len(self.runs),
                "workflow_runs": deepcopy(list(self.runs.values())),
            }
        if parsed.path.startswith("/actions/runs/"):
            run_id = int(parsed.path.split("/")[3])
            if parsed.path.endswith("/jobs"):
                return {
                    "total_count": len(self.jobs[run_id]),
                    "jobs": deepcopy(self.jobs[run_id]),
                }
            return deepcopy(self.runs[run_id])
        raise AssertionError("Unexpected API path")

    def download(self, artifact_id):
        self.requests.append(("download", artifact_id))
        return self.archives[artifact_id]


@pytest.fixture
def source(transfer, tmp_path):
    api = FakeGitHub(transfer)
    api.add(SOURCE_SHA, transfer.files)
    manifest = deepcopy(transfer.manifest)
    manifest["source"]["artifact_sha256"] = handoff.digest(api.archives[456])
    raw = encoded(manifest)
    context = transport.Context(
        "owner/private",
        TARGET_SHA,
        TARGET_IDENTITY,
        transfer.universe_sha,
        999,
        handoff.digest(raw),
        raw,
    )
    state = tmp_path / "destination"
    state.mkdir()
    (state / "performance.json").write_bytes(b"release seed must never execute")
    (state / "universe.json").write_bytes(b"release input preserved")
    return SimpleNamespace(
        api=api,
        context=context,
        state=state,
        files=transfer.files,
        manifest=manifest,
        now=transfer.now + timedelta(minutes=20),
    )


def restore(fixture, context=None):
    return transport.restore(
        fixture.api, context or fixture.context, fixture.state, now=fixture.now
    )


def native_files(fixture, *, failed=False, carried=False):
    files = dict(fixture.files)
    last_run = handoff.read_object(files["production/last_run.json"])
    if not carried:
        last_run.update(
            release_sha=TARGET_SHA,
            status="FAIL" if failed else "PASS",
            completed_at=(fixture.api.now + timedelta(minutes=10)).isoformat(),
        )
        files["production/last_run.json"] = encoded(last_run)
    if carried:
        files[transport.MANIFEST_PATH] = fixture.context.manifest_raw
        files.update(
            {
                path: fixture.files[name]
                for path, name in transport.ORIGINAL_PATHS.items()
            }
        )
    return files


def test_bootstrap_installs_original_bytes_and_persistent_evidence(source):
    # Actions artifact authentication is independent of repository visibility.
    assert source.api.get("")["private"] is False
    assert restore(source) == "handoff"
    for name, content in source.files.items():
        assert (source.state / name).read_bytes() == content
        assert (
            source.state / handoff.HANDOFF_DIR / "source" / name
        ).read_bytes() == content
        assert (source.state / name).stat().st_mode & 0o777 == 0o600
    assert (
        source.state / transport.MANIFEST_PATH
    ).read_bytes() == source.context.manifest_raw
    assert (source.state / "universe.json").read_bytes() == b"release input preserved"
    assert source.api.run_list_reads == 2


def test_no_native_state_and_no_manifest_never_uses_release_seed(source):
    with pytest.raises(transport.RestoreError, match="native_runtime_missing"):
        restore(source, replace(source.context, manifest_raw=b"", manifest_pin=""))
    assert (
        source.state / "performance.json"
    ).read_bytes() == b"release seed must never execute"


@pytest.mark.parametrize(
    "tamper",
    [
        "expired",
        "digest",
        "lineage",
        "rerun",
        "missing_execute",
        "foreign_repo",
        "wrong_workflow",
    ],
)
def test_invalid_native_never_falls_back_to_valid_source(source, tamper):
    files = native_files(source)
    if tamper == "lineage":
        files["production/last_run.json"] = encoded({"release_sha": "0" * 40})
    source.api.add(TARGET_SHA, files, run_id=124, artifact_id=457)
    if tamper == "expired":
        source.api.artifacts[457]["expired"] = True
    elif tamper == "digest":
        source.api.archives[457] += b"corrupt"
    elif tamper == "rerun":
        source.api.runs[124]["run_attempt"] = 2
    elif tamper == "missing_execute":
        source.api.jobs[124][0]["steps"].pop(0)
    elif tamper == "foreign_repo":
        source.api.artifacts[457]["workflow_run"]["head_repository_id"] = 99
    elif tamper == "wrong_workflow":
        source.api.runs[124]["workflow_id"] = 99
    with pytest.raises((transport.RestoreError, handoff.HandoffError)):
        restore(source)
    assert ("download", 456) not in source.api.requests
    assert (
        source.state / "performance.json"
    ).read_bytes() == b"release seed must never execute"


@pytest.mark.parametrize(
    ("status", "outcome"),
    [("FAIL", "failure"), ("DEGRADED", "failure"), ("FAIL", "cancelled")],
)
def test_latest_failed_target_runtime_is_restored_instead_of_older_pass(
    source, status, outcome
):
    # The failed target may already have written broker orders: its exact state
    # must survive. Source PASS is present and must not be selected instead.
    files = native_files(source, failed=True)
    last_run = handoff.read_object(files["production/last_run.json"])
    last_run["status"] = status
    files["production/last_run.json"] = encoded(last_run)
    source.api.add(TARGET_SHA, files, run_id=124, artifact_id=457, failed=True)
    source.api.runs[124]["conclusion"] = outcome
    source.api.jobs[124][0]["steps"][0]["conclusion"] = outcome
    assert restore(source) == "native"
    assert (source.state / "production/last_run.json").read_bytes() == files[
        "production/last_run.json"
    ]
    assert handoff.read_object(files["production/last_run.json"])["status"] == status
    assert ("download", 456) not in source.api.requests


@pytest.mark.parametrize("has_native", [False, True])
@pytest.mark.parametrize("outcome", ["failure", "cancelled"])
def test_newer_failed_execution_without_artifact_blocks_all_older_state(
    source, has_native, outcome
):
    if has_native:
        source.api.add(TARGET_SHA, native_files(source), run_id=124, artifact_id=457)
    source.api.add(
        TARGET_SHA,
        native_files(source, failed=True),
        run_id=125,
        artifact_id=None,
        failed=True,
        minutes=11,
    )
    source.api.runs[125]["conclusion"] = outcome
    source.api.jobs[125][0]["steps"][0]["conclusion"] = outcome
    with pytest.raises(transport.RestoreError, match="newer_execution"):
        restore(source)
    assert (
        source.state / "performance.json"
    ).read_bytes() == b"release seed must never execute"


def test_later_read_only_preflight_is_not_an_execution(source):
    source.api.add(TARGET_SHA, source.files, run_id=125, artifact_id=None, minutes=1)
    source.api.jobs[125][0]["steps"][0]["conclusion"] = "skipped"
    assert restore(source) == "handoff"


@pytest.mark.parametrize("running", [False, True])
def test_old_started_run_with_later_or_pending_execution_cannot_disappear(
    source, running
):
    run = source.api.add(
        TARGET_SHA, source.files, run_id=125, artifact_id=None, failed=True, minutes=1
    )
    run["created_at"] = (source.api.now - timedelta(days=1)).isoformat()
    run["run_started_at"] = run["created_at"]
    if running:
        run["status"] = "in_progress"
        source.api.jobs[125][0]["steps"][0].update(
            status="in_progress", conclusion=None, completed_at=None
        )
    with pytest.raises(transport.RestoreError, match="newer_execution"):
        restore(source)


def test_current_run_is_excluded_without_hiding_a_newer_failed_attempt(source):
    source.api.add(TARGET_SHA, source.files, run_id=999, artifact_id=None, minutes=1)
    source.api.runs[999]["status"] = "in_progress"
    source.api.jobs[999][0]["steps"][0].update(status="queued", conclusion=None)
    assert restore(source) == "handoff"


def test_newer_attempt_appearing_during_download_or_staging_blocks_install(source):
    def race(api):
        if api.run_list_reads == 2:
            api.add(
                TARGET_SHA,
                source.files,
                run_id=125,
                artifact_id=None,
                failed=True,
                minutes=1,
            )

    source.api.list_hook = race
    with pytest.raises(transport.RestoreError, match="newer_execution"):
        restore(source)
    assert (
        source.state / "performance.json"
    ).read_bytes() == b"release seed must never execute"
    assert not list(source.state.parent.glob(".paper-runtime-*"))


def test_target_artifact_appearing_during_bootstrap_cannot_be_ignored(source):
    def race(api):
        if api.run_list_reads == 1:
            delayed = deepcopy(api.artifacts[456])
            delayed.update(
                id=900, name="paper-runtime-state-" + TARGET_SHA, expired=True
            )
            api.artifacts[900] = delayed

    source.api.list_hook = race
    with pytest.raises(transport.RestoreError, match="native_runtime_appeared"):
        restore(source)
    assert (
        source.state / "performance.json"
    ).read_bytes() == b"release seed must never execute"


def test_native_preserved_source_lineage_requires_exact_original_and_external_pin(
    source,
):
    files = native_files(source, carried=True)
    source.api.add(TARGET_SHA, files, run_id=124, artifact_id=457, failed=True)
    assert restore(source, replace(source.context, manifest_raw=b"")) == "native"
    assert (source.state / "production/last_run.json").read_bytes() == source.files[
        "production/last_run.json"
    ]
    with pytest.raises(handoff.HandoffError):
        restore(source, replace(source.context, manifest_pin="0" * 64))


def test_valid_native_handoff_does_not_expire_with_original_bootstrap_window(source):
    source.api.add(
        TARGET_SHA,
        native_files(source, carried=True),
        run_id=124,
        artifact_id=457,
        failed=True,
    )
    source.now += timedelta(days=3)
    assert restore(source) == "native"


def test_failed_state_swap_restores_previous_files(source, monkeypatch):
    original_replace = transport.os.replace

    def fail_install(source_path, target_path):
        if Path(source_path).name == "next":
            raise OSError("synthetic install failure")
        return original_replace(source_path, target_path)

    monkeypatch.setattr(transport.os, "replace", fail_install)
    with pytest.raises(OSError):
        restore(source)
    assert (
        source.state / "performance.json"
    ).read_bytes() == b"release seed must never execute"
    assert not list(source.state.parent.glob(".paper-runtime-*"))


def test_native_source_lineage_cannot_hide_a_changed_uncommitted_runtime(source):
    files = native_files(source, carried=True)
    files["performance.json"] += b"\n"
    source.api.add(TARGET_SHA, files, run_id=124, artifact_id=457, failed=True)
    with pytest.raises(
        transport.RestoreError, match="uncommitted_target_runtime_changed"
    ):
        restore(source)


@pytest.mark.parametrize(
    "member",
    [
        "../performance.json",
        "/performance.json",
        "production/../performance.json",
        "production\\last_run.json",
        "unknown.json",
    ],
)
def test_zip_rejects_traversal_and_unexpected_members(source, member):
    with pytest.raises(transport.RestoreError):
        transport.parse_runtime_zip(archive({**source.files, member: b"untrusted"}))


def test_zip_rejects_duplicates_and_symlinks(source):
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as output:
        for name, content in source.files.items():
            output.writestr(name, content)
        with pytest.warns(UserWarning):
            output.writestr("performance.json", b"replacement")
    with pytest.raises(transport.RestoreError):
        transport.parse_runtime_zip(raw.getvalue())
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as output:
        member = zipfile.ZipInfo("performance.json")
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        output.writestr(member, "private-target")
    with pytest.raises(transport.RestoreError):
        transport.parse_runtime_zip(raw.getvalue())


def test_zip_limits_and_incomplete_pagination_fail_closed(source, monkeypatch):
    monkeypatch.setattr(transport, "MAX_INFLATED", 10)
    with pytest.raises(transport.RestoreError):
        transport.parse_runtime_zip(archive(source.files))
    fake = SimpleNamespace(
        get=lambda path: {"total_count": 2, "artifacts": [{"id": 1}]}
    )
    with pytest.raises(transport.RestoreError, match="listing_incomplete"):
        transport.listing(fake, "/actions/artifacts", "artifacts")


def test_signed_download_never_forwards_authorization():
    client = transport.GitHub("owner/private", "canary-token-never-log")
    requests = []

    class Response(io.BytesIO):
        status = 200

    def open_request(request, timeout):
        requests.append(request)
        if len(requests) == 1:
            raise HTTPError(
                request.full_url,
                302,
                "redirect",
                {
                    "Location": "https://fixture.blob.core.windows.net/opaque?sig=private"
                },
                io.BytesIO(),
            )
        return Response(b"archive")

    client.opener = SimpleNamespace(open=open_request)
    assert client.download(456) == b"archive"
    assert requests[0].get_header("Authorization") == "Bearer canary-token-never-log"
    assert requests[1].get_header("Authorization") is None


@pytest.mark.parametrize(
    "location",
    [
        "http://fixture.blob.core.windows.net/x",
        "https://evil.invalid/x",
        "https://api.github.com/x",
        "https://user:pass@fixture.blob.core.windows.net/x",
    ],
)
def test_signed_download_rejects_untrusted_redirects(location):
    client = transport.GitHub("owner/private", "private-token")

    def redirect(request, timeout):
        raise HTTPError(
            request.full_url, 302, "private-error", {"Location": location}, io.BytesIO()
        )

    client.opener = SimpleNamespace(open=redirect)
    with pytest.raises(transport.RestoreError, match="archive_redirect_host"):
        client.download(456)


def test_cli_failure_never_prints_exception_body_or_token(monkeypatch, capsys):
    monkeypatch.setenv("TRADING_MODE", "paper")
    monkeypatch.setenv("APPROVED_RELEASE_SHA", "private-canary-error")
    assert transport.main() == 1
    assert capsys.readouterr().out.strip() == '{"runtime_restore": "FAIL"}'
