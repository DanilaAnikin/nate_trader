"""Pure API fixtures: an observation never submits or asserts a trading outcome."""

import importlib.util
import json
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import pytest

SPEC = importlib.util.spec_from_file_location(
    "forward_cadence", Path(__file__).resolve().parents[1] / "ops/forward_cadence.py")
cadence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cadence)
NOW = datetime(2026, 9, 15, 17, tzinfo=timezone.utc)
SINCE = datetime(2026, 9, 14, 20, 33, 51, tzinfo=timezone.utc)
HEAD, APPROVED = "a" * 40, "b" * 40
PINS = {path: "c" * 64 for path in cadence.SOURCE_PATHS}


class API:
    def __init__(self):
        self.runs, self.jobs, self.logs, self.calls = {}, {}, {}, []
        self.hook = None

    def add(self, run_id=1, *, workflow=cadence.PAPER, event="schedule", execution="success"):
        watchdog = workflow == cadence.WATCHDOG
        self.runs[run_id] = {
            "id": run_id, "workflow_id": 23 if watchdog else 22, "status": "completed",
            "repository": {"id": cadence.REPOSITORY_ID}, "head_repository": {"id": cadence.REPOSITORY_ID},
            "head_branch": "main", "head_sha": HEAD, "event": event,
            "path": ".github/workflows/" + workflow, "conclusion": "success", "run_attempt": 1,
            "created_at": "2026-09-15T15:35:00Z", "run_started_at": "2026-09-15T15:35:00Z",
            "updated_at": "2026-09-15T15:36:30Z"}
        self.jobs[run_id] = [{"id": 100 + run_id, "run_id": run_id, "head_sha": HEAD,
            "name": cadence.WATCHDOG_JOB if watchdog else cadence.PAPER_JOB,
            "steps": [{"name": name, "status": "completed",
                       "conclusion": execution if name == cadence.EXECUTE else "success",
                       "started_at": "2026-09-15T15:35:01Z", "completed_at": "2026-09-15T15:36:00Z"}
                      for name in ([cadence.RECOVER] if watchdog else
                                   [cadence.EXECUTE, cadence.GENERATION, cadence.UPLOAD])]}]
        if watchdog:
            self.decision(run_id)

    def decision(self, run_id, state="attempted", **extra):
        row = {"schema_version": 1, "mode": "paper", "state": state,
               "session_date": "2026-09-15", "checked_at": "2026-09-15T15:35:02+00:00",
               "active_run_ids": [], "attempted_run_ids": [1] if state == "attempted" else [],
               "failed_run_ids": [], "preflight_failed_run_ids": [], "fills_verified": False, **extra}
        self.logs[100 + run_id] = "2026-09-15T15:35:05.1234567Z " + json.dumps(row) + "\n"

    def get(self, path):
        self.calls.append(path)
        if self.hook:
            self.hook(self, path)
        clean = urlsplit(path).path
        if clean == "":
            return {"id": cadence.REPOSITORY_ID, "full_name": cadence.REPOSITORY, "default_branch": "main"}
        if clean == "/git/ref/heads/main":
            return {"object": {"sha": HEAD}}
        if clean.startswith("/actions/workflows/"):
            name = clean.split("/")[3]
            if clean.endswith("/runs"):
                rows = [row for row in self.runs.values() if row["path"].endswith(name)]
                return {"workflow_runs": deepcopy(rows), "total_count": len(rows)}
            return {"id": 23 if name == cadence.WATCHDOG else 22,
                    "state": "active", "path": ".github/workflows/" + name}
        if clean.startswith("/actions/runs/"):
            run_id = int(clean.split("/")[3])
            if clean.endswith("/attempts/1/jobs"):
                return {"jobs": deepcopy(self.jobs[run_id]), "total_count": len(self.jobs[run_id])}
            return deepcopy(self.runs[run_id])
        raise AssertionError("unexpected_path")

    def source_digest(self, ref, path):
        self.calls.append((ref, path))
        return PINS[path]

    def job_log(self, job_id):
        return self.logs[job_id]


def observe(api, **kwargs):
    return cadence.observe(api, now=NOW, observed_since=SINCE, approved_release_sha=APPROVED,
                           source_digests=PINS, **kwargs)


def test_empty_observation_is_not_a_natural_schedule_pass():
    result = observe(API())
    assert result["first_natural_paper_execution"] is None
    assert result["first_natural_watchdog_decision"] is None
    assert result["first_expected_session"]["paper_scheduled_for"] == "2026-09-15T15:05:00+00:00"
    assert not any(result[key] for key in ("actual_release_verified", "portfolio_outcome_verified", "fills_verified"))


def test_changed_observer_only_head_and_natural_execution_with_decision():
    api = API()
    api.add()
    api.add(2, workflow=cadence.WATCHDOG)
    result = observe(api)
    assert result["first_natural_paper_execution"]["id"] == 1
    assert result["first_natural_watchdog_decision"]["decision"]["state"] == "attempted"
    assert result["paper_runs"][0]["runtime_publication_steps_succeeded"] is True
    assert result["observed_main_sha"] != result["expected_approved_release_sha"]
    assert (HEAD, "ops/paper_cadence.py") in api.calls
    assert (APPROVED, "ops/paper_cadence.py") in api.calls
    assert not any(isinstance(path, str) and ("dispatches" in path or "artifacts" in path) for path in api.calls)


@pytest.mark.parametrize("event,execution", [("workflow_dispatch", "success"), ("schedule", "skipped")])
def test_manual_and_skipped_do_not_prove_natural_execution(event, execution):
    api = API()
    api.add(event=event, execution=execution)
    assert observe(api)["first_natural_paper_execution"] is None


def test_failed_execution_is_an_attempt_but_not_success():
    api = API()
    api.add(execution="failure")
    api.runs[1]["conclusion"] = "failure"
    result = observe(api)
    assert result["first_natural_paper_execution"]["execution"]["conclusion"] == "failure"
    assert result["portfolio_outcome_verified"] is False


@pytest.mark.parametrize("field,value", [
    ("repository", {"id": 123}), ("head_repository", {"id": 123}),
    ("head_branch", "other"), ("event", "pull_request"), ("head_sha", "short"),
    ("run_attempt", 2), ("workflow_id", 99),
])
def test_invalid_run_provenance_refuses_observation(field, value):
    api = API()
    api.add()
    api.runs[1][field] = value
    with pytest.raises(cadence.CadenceObservationError):
        observe(api)


def test_source_drift_refuses_even_when_run_and_steps_succeed():
    api = API()
    api.source_digest = lambda ref, path: "d" * 64
    with pytest.raises(cadence.CadenceObservationError, match="source_pin_mismatch"):
        observe(api)


def test_active_run_without_jobs_is_recorded_without_false_attempt():
    api = API()
    api.add()
    api.runs[1].update(status="queued", conclusion=None)
    api.jobs[1] = []
    result = observe(api)
    assert result["paper_runs"][0]["execution"]["status"] == "not_yet_present"
    assert result["first_natural_paper_execution"] is None


@pytest.mark.parametrize("mutation", ["wrong_job", "duplicate_step", "missing_step"])
def test_job_evidence_is_bound_and_unambiguous(mutation):
    api = API()
    api.add()
    job = api.jobs[1][0]
    if mutation == "wrong_job":
        job["run_id"] = 99
    elif mutation == "duplicate_step":
        job["steps"].append(deepcopy(job["steps"][0]))
    else:
        job["steps"].pop()
    with pytest.raises(cadence.CadenceObservationError):
        observe(api)


def test_recovery_link_requires_actual_logged_id_and_exact_new_run():
    api = API()
    api.add(2, workflow=cadence.WATCHDOG)
    api.add(3, event="workflow_dispatch")
    api.runs[3].update(created_at="2026-09-15T15:35:03Z", run_started_at="2026-09-15T15:35:03Z")
    for step in api.jobs[3][0]["steps"]:
        step["started_at"] = "2026-09-15T15:35:04Z"
    api.decision(2, "recovery_dispatched", recovery_run_id=3)
    assert observe(api)["first_natural_watchdog_decision"]["decision"]["recovery_run_id"] == 3
    api.runs[3]["head_sha"] = "d" * 40
    api.jobs[3][0]["head_sha"] = "d" * 40
    with pytest.raises(cadence.CadenceObservationError, match="recovery_provenance"):
        observe(api)


@pytest.mark.parametrize("kind", ["missing", "duplicate", "old_step", "secret_field", "bad_state", "oversize"])
def test_watchdog_log_must_be_exact_bounded_current_decision(kind):
    api = API()
    api.add(2, workflow=cadence.WATCHDOG)
    log = api.logs[102]
    if kind == "missing":
        api.logs[102] = "2026-09-15T15:35:05Z echo 'not a decision'\n"
    elif kind == "duplicate":
        api.logs[102] = log + log
    elif kind == "old_step":
        api.logs[102] = log.replace("T15:35:05", "T15:34:05")
    elif kind == "secret_field":
        api.decision(2, secret="never_return_me")
    elif kind == "bad_state":
        api.decision(2, "arbitrary")
    else:
        api.logs[102] = "x" * (cadence.MAX_LOG_BYTES + 1)
    with pytest.raises(cadence.CadenceObservationError) as error:
        observe(api)
    assert "never_return_me" not in str(error.value)


def test_uncertain_dispatch_fail_log_never_infers_nearby_manual_run():
    api = API()
    api.add(2, workflow=cadence.WATCHDOG)
    api.add(3, event="workflow_dispatch")
    api.runs[2]["conclusion"] = "failure"
    api.jobs[2][0]["steps"][0]["conclusion"] = "failure"
    api.logs[102] = '2026-09-15T15:35:05Z {"paper_cadence":"FAIL","reason":"verification_refused"}\n'
    result = observe(api)
    assert result["first_natural_watchdog_decision"] is None
    assert result["watchdog_runs"][0]["decision"]["verified"] is False
    assert "recovery_run_id" not in result["watchdog_runs"][0]["decision"]


def test_new_arrival_during_read_refuses_stale_absence():
    api = API()
    def hook(api, path):
        if path.startswith("/actions/workflows/paper-production.yml/runs"):
            count = sum(value == path for value in api.calls)
            if count == 2:
                api.add()
    api.hook = hook
    with pytest.raises(cadence.CadenceObservationError, match="catalog_changed"):
        observe(api)


def test_incomplete_pagination_and_raw_transport_exception_are_refused_safely():
    api = API()
    original = api.get
    def incomplete(path):
        row = original(path)
        if "workflow_runs" in row:
            row["total_count"] = 101
        return row
    api.get = incomplete
    with pytest.raises(cadence.CadenceObservationError, match="listing_incomplete"):
        observe(api)
    def unsafe(path):
        raise RuntimeError("secret response payload")
    api.get = unsafe
    with pytest.raises(cadence.CadenceObservationError, match="^observation_unavailable$"):
        observe(api)


def test_old_queued_schedule_execution_remains_visible_but_is_not_new_natural_trigger():
    api = API()
    api.add()
    api.runs[1]["created_at"] = "2026-09-11T15:05:00Z"
    result = observe(api)
    assert result["paper_runs"][0]["execution"]["conclusion"] == "success"
    assert result["first_natural_paper_execution"] is None


def test_distinct_run_head_requires_its_own_source_bytes():
    api = API()
    api.add()
    api.runs[1]["head_sha"] = "e" * 40
    api.jobs[1][0]["head_sha"] = "e" * 40
    api.source_digest = lambda ref, path: "d" * 64 if ref == "e" * 40 else PINS[path]
    with pytest.raises(cadence.CadenceObservationError, match="source_pin_mismatch"):
        observe(api)


def test_duplicate_json_keys_cannot_shadow_watchdog_decision():
    api = API()
    api.add(2, workflow=cadence.WATCHDOG)
    api.logs[102] = api.logs[102].replace('"state": "attempted"', '"state": "active", "state": "attempted"')
    with pytest.raises(cadence.CadenceObservationError, match="watchdog_duplicate_json_key"):
        observe(api)


def test_completed_run_changed_after_logs_refuses_observation():
    api = API()
    api.add()
    def hook(api, path):
        if path == "/actions/runs/1" and api.calls.count(path) == 2:
            api.runs[1]["run_attempt"] = 2
    api.hook = hook
    with pytest.raises(cadence.CadenceObservationError, match="run_changed"):
        observe(api)
