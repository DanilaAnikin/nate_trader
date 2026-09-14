"""A missing timer may be recovered; an actual paper attempt is not retried."""

from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
from urllib.parse import urlsplit

import pytest

SPEC = importlib.util.spec_from_file_location(
    "paper_cadence", Path(__file__).resolve().parents[1] / "ops/paper_cadence.py"
)
cadence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cadence)
NOW = datetime(2026, 9, 14, 17, tzinfo=timezone.utc)
HEAD = "a" * 40


class API:
    def __init__(self):
        self.runs, self.jobs, self.calls = [], {}, []
        self.hook = None

    def add(self, run_id=1, *, status="completed", conclusion="success",
            execution="success", started="2026-09-14T15:10:00Z",
            updated="2026-09-14T15:11:00Z", attempt=1):
        self.runs.append({"id": run_id, "workflow_id": 22, "status": status,
                          "repository": {"id": 11}, "head_repository": {"id": 11},
                          "head_branch": "main", "head_sha": HEAD,
                          "event": "schedule", "path": ".github/workflows/paper-production.yml",
                          "conclusion": conclusion, "run_attempt": attempt,
                          "updated_at": updated})
        self.jobs[run_id] = [{"id": 100 + run_id, "run_id": run_id, "name": cadence.JOB,
                              "steps": [{"name": cadence.EXECUTE,
                                         "status": "completed",
                                         "conclusion": execution,
                                         "started_at": started}]}]

    def request(self, path, *, body=None):
        self.calls.append((path, body))
        if self.hook:
            self.hook(self, path, body)
        path = urlsplit(path).path
        if path == "":
            return {"id": 11, "full_name": cadence.REPOSITORY, "default_branch": "main"}
        if path == "/actions/workflows/paper-production.yml":
            return {"id": 22, "state": "active", "path": ".github/workflows/paper-production.yml"}
        if path == "/actions/workflows/paper-production.yml/runs":
            return {"workflow_runs": deepcopy(self.runs), "total_count": len(self.runs)}
        if path.endswith("/jobs"):
            jobs = self.jobs[int(path.split("/")[-2])]
            return {"jobs": deepcopy(jobs), "total_count": len(jobs)}
        if path == "/git/ref/heads/main":
            return {"object": {"sha": HEAD}}
        if path == "/actions/workflows/paper-production.yml/dispatches":
            assert body == {"ref": "main", "inputs": {"operation": "execute", "automated_recovery": True}}
            return {"workflow_run_id": 500,
                    "run_url": f"https://api.github.com/repos/{cadence.REPOSITORY}/actions/runs/500"}
        if path == "/actions/runs/500":
            return {"head_sha": HEAD, "head_branch": "main", "event": "workflow_dispatch",
                    "run_attempt": 1, "path": ".github/workflows/paper-production.yml"}
        raise AssertionError(path)


def test_successful_preflight_does_not_claim_daily_execution():
    api = API()
    api.add(execution="skipped", started=None)
    result = cadence.assessment(api, NOW)
    assert result["state"] == "missing"
    assert result["fills_verified"] is False


@pytest.mark.parametrize("outcome", ["success", "failure", "cancelled", "timed_out"])
def test_never_retry_any_started_execution(outcome):
    api = API()
    api.add(conclusion=outcome, execution=outcome)
    result = cadence.guarded_dispatch(api, NOW, HEAD, clock=lambda: NOW)
    assert result["state"] == "attempted"
    assert result["attempted_run_ids"] == [1]
    assert not any(body for _, body in api.calls)


@pytest.mark.parametrize("status", sorted(cadence.ACTIVE))
def test_pending_run_prevents_recovery(status):
    api = API()
    api.add(status=status, conclusion=None, started=None)
    assert cadence.guarded_dispatch(api, NOW, HEAD)["state"] == "active"
    assert not any(body for _, body in api.calls)


def test_demonstrably_skipped_execution_can_repeat_read_only_checks():
    api = API()
    api.add(conclusion="failure", execution="skipped", started=None)
    result = cadence.assessment(api, NOW)
    assert result["state"] == "missing"
    assert result["preflight_failed_run_ids"] == [1]


@pytest.mark.parametrize("field,value", [
    ("repository", {"id": 12}), ("head_repository", {"id": 12}),
    ("head_branch", "other"), ("event", "pull_request"),
    ("path", ".github/workflows/other.yml"), ("head_sha", "short"),
])
def test_untrusted_skipped_execution_is_not_safe_retry_proof(field, value):
    api = API()
    api.add(conclusion="failure", execution="skipped", started=None)
    api.runs[0][field] = value
    with pytest.raises(cadence.CadenceError, match="run_provenance"):
        cadence.guarded_dispatch(api, NOW, HEAD, clock=lambda: NOW)
    assert not any(body for _, body in api.calls)


def test_skipped_step_from_other_run_is_not_safe_retry_proof():
    api = API()
    api.add(execution="skipped", started=None)
    api.jobs[1][0]["run_id"] = 2
    with pytest.raises(cadence.CadenceError, match="paper_job_run"):
        cadence.guarded_dispatch(api, NOW, HEAD, clock=lambda: NOW)
    assert not any(body for _, body in api.calls)


@pytest.mark.parametrize("change", [
    {"started_at": None}, {"status": "pending"}, {"conclusion": None},
    {"conclusion": "unknown"},
])
def test_incomplete_execution_metadata_is_never_proof_of_missing_attempt(change):
    api = API()
    api.add()
    api.jobs[1][0]["steps"][0].update(change)
    with pytest.raises(cadence.CadenceError):
        cadence.guarded_dispatch(api, NOW, HEAD, clock=lambda: NOW)
    assert not any(body for _, body in api.calls)


def test_prior_days_attempt_does_not_satisfy_today():
    api = API()
    api.add(started="2026-09-11T15:10:00Z", updated="2026-09-11T15:11:00Z")
    assert cadence.assessment(api, NOW)["state"] == "missing"


def test_late_old_queued_run_that_executes_today_counts():
    api = API()
    api.add()
    api.runs[0]["created_at"] = "2026-09-11T15:00:00Z"
    assert cadence.assessment(api, NOW)["state"] == "attempted"


def test_missing_day_dispatches_only_fixed_paper_recovery_and_verifies_run():
    api = API()
    result = cadence.guarded_dispatch(api, NOW, HEAD, clock=lambda: NOW)
    assert result["state"] == "recovery_dispatched"
    assert result["recovery_run_id"] == 500
    assert len([body for _, body in api.calls if body]) == 1


def test_cron_arrives_during_check_and_suppresses_recovery():
    api = API()
    def hook(api, path, body):
        if path == "/git/ref/heads/main":
            api.add(status="queued", conclusion=None, started=None)
    api.hook = hook
    assert cadence.guarded_dispatch(api, NOW, HEAD, clock=lambda: NOW)["state"] == "active"
    assert not any(body for _, body in api.calls)


def test_slow_listing_cannot_dispatch_after_recovery_window():
    api = API()
    times = iter([NOW, NOW.replace(hour=19, minute=45)])
    with pytest.raises(cadence.CadenceError, match="outside_recovery_window"):
        cadence.guarded_dispatch(api, NOW, HEAD, clock=lambda: next(times))
    assert not any(body for _, body in api.calls)


def test_late_cron_inside_concurrency_lock_sees_prior_recovery_attempt():
    api = API()
    api.add(1)
    api.add(2, status="in_progress", conclusion=None, started=None)
    result = cadence.assessment(api, NOW, current_run_id=2)
    assert result["state"] == "attempted"
    assert result["active_run_ids"] == []


@pytest.mark.parametrize("day,hour,minute,expected", [
    (14, 15, 34, False), (14, 15, 35, True), (14, 19, 44, True),
    (14, 19, 45, False), (13, 17, 0, False),
])
def test_recovery_window_is_weekday_and_bounded(day, hour, minute, expected):
    assert cadence.recovery_window(datetime(2026, 9, day, hour, minute,
                                           tzinfo=timezone.utc)) is expected


def test_partial_listing_is_not_evidence_of_missing_run():
    class Partial(API):
        def request(self, path, *, body=None):
            value = super().request(path, body=body)
            if "workflow_runs" in value:
                value["total_count"] = 101
            return value
    with pytest.raises(cadence.CadenceError, match="listing_incomplete"):
        cadence.assessment(Partial(), NOW)


def test_rerun_is_ambiguous_and_requires_review():
    api = API()
    api.add(attempt=2)
    with pytest.raises(cadence.CadenceError, match="rerun_requires_review"):
        cadence.assessment(api, NOW)


def test_wrong_dispatch_head_is_not_reported_as_verified():
    class Changed(API):
        def request(self, path, *, body=None):
            value = super().request(path, body=body)
            if path == "/actions/runs/500":
                value["head_sha"] = "b" * 40
            return value
    with pytest.raises(cadence.CadenceError, match="dispatch_provenance"):
        cadence.guarded_dispatch(Changed(), NOW, HEAD, clock=lambda: NOW)


def test_manual_guard_does_not_need_broker_keys_and_does_not_call_broker(monkeypatch, tmp_path):
    api = API()
    monkeypatch.setattr(cadence, "GitHub", lambda _: api)
    for name, value in {"GITHUB_REPOSITORY": cadence.REPOSITORY, "TRADING_MODE": "paper",
                        "GITHUB_RUN_ATTEMPT": "1", "PAPER_AUTOMATED_CYCLE": "false",
                        "GITHUB_RUN_ID": "100", "GITHUB_OUTPUT": str(tmp_path / "out")}.items():
        monkeypatch.setenv(name, value)
    assert cadence.main(["guard"]) == 0
    assert (tmp_path / "out").read_text() == "allow_execution=true\n"
    assert api.calls == []


def test_workflow_upload_requires_current_generation_and_automatic_guard():
    root = Path(__file__).resolve().parents[1]
    workflow = (root / ".github/workflows/paper-production.yml").read_text()
    assert "steps.cadence.outputs.allow_execution == 'true'" in workflow
    assert "--require-generation --require-current-run" in workflow
    assert "if: always() && steps.runtime_generation.outcome == 'success'" in workflow
    watchdog = (root / ".github/workflows/paper-watchdog.yml").read_text()
    assert "actions: write" in watchdog and "ops/paper_cadence.py recover" in watchdog
    assert "ALPACA" not in watchdog and "live-production" not in watchdog
