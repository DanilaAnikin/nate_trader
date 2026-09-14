"""GET-only evidence of natural paper scheduling and the existing watchdog.

The injected transport supplies get(repo_relative_path), job_log(job_id), and
source_digest(ref, path). It owns authentication and bounded, redirect-safe HTTP.
This module never downloads runtime artifacts, dispatches workflows, or calls a
broker. Successful execution/generation steps do not prove fills, actual runtime
release identity, or a portfolio outcome. Callers persist the returned sanitized
observation atomically; incomplete or changing API evidence raises a fixed code.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone

REPOSITORY = "DanilaAnikin/nate_trader"
REPOSITORY_ID = 1219694107
PAPER = "paper-production.yml"
WATCHDOG = "paper-watchdog.yml"
SOURCE_PATHS = (
    ".github/workflows/" + PAPER,
    ".github/workflows/" + WATCHDOG,
    "ops/paper_cadence.py",
)
PAPER_JOB = "Guarded paper forward-validation"
WATCHDOG_JOB = "paper-cadence"
EXECUTE = "Execute one guarded paper cycle"
GENERATION = "Verify this execution runtime generation"
UPLOAD = "Preserve private runtime state"
RECOVER = "Recover only a missing paper session"
ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}
CONCLUSIONS = {"success", "failure", "cancelled", "timed_out", "skipped",
               "neutral", "action_required", "stale", "startup_failure"}
ARRAY_FIELDS = ("active_run_ids", "attempted_run_ids", "failed_run_ids",
                "preflight_failed_run_ids")
MAX_LOG_BYTES = 4 * 1024 * 1024
LOG_LINE = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s+(\{.*\})$")


class CadenceObservationError(ValueError):
    """Only fixed, non-sensitive reason codes cross the collector boundary."""


def require(condition, code):
    if not condition:
        raise CadenceObservationError(code)


def timestamp(value):
    require(isinstance(value, str), "timestamp_required")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise CadenceObservationError("timestamp_invalid") from None
    require(result.tzinfo is not None, "timestamp_timezone")
    return result.astimezone(timezone.utc)


def _hex(value, length):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(length) + "}", value)


def _listing(api, path, field):
    result, total = [], None
    for page in range(1, 11):
        body = api.get(f"{path}?per_page=100&page={page}")
        require(isinstance(body, dict), "listing_shape")
        rows, count = body.get(field), body.get("total_count")
        require(isinstance(rows, list) and all(isinstance(row, dict) for row in rows)
                and type(count) is int and 0 <= count <= 1000, "listing_shape")
        require(total is None or total == count, "listing_changed")
        total = count
        result.extend(rows)
        require(len(result) <= total, "listing_count")
        if len(result) == total:
            ids = [row.get("id") for row in result]
            require(all(type(value) is int and value > 0 for value in ids)
                    and len(ids) == len(set(ids)), "listing_ids")
            return result
        require(len(rows) == 100, "listing_incomplete")
    raise CadenceObservationError("listing_bound")


def _run_key(run):
    return tuple(run.get(key) for key in (
        "id", "workflow_id", "head_sha", "head_branch", "path", "event",
        "run_attempt", "status", "conclusion", "created_at", "run_started_at", "updated_at",
    )) + (run.get("repository", {}).get("id"), run.get("head_repository", {}).get("id"))


def _catalog_key(runs):
    return sorted((_run_key(run) for run in runs), key=lambda row: row[0])


def _workflow(api, filename):
    row = api.get("/actions/workflows/" + filename)
    require(isinstance(row, dict) and row.get("state") == "active"
            and row.get("path") == ".github/workflows/" + filename
            and type(row.get("id")) is int and row["id"] > 0, "workflow_provenance")
    return {key: row[key] for key in ("id", "path", "state")}


def _run(run, workflow, now):
    require(isinstance(run, dict) and type(run.get("id")) is int and run["id"] > 0
            and run.get("workflow_id") == workflow["id"]
            and run.get("repository", {}).get("id") == REPOSITORY_ID
            and run.get("head_repository", {}).get("id") == REPOSITORY_ID
            and run.get("head_branch") == "main" and _hex(run.get("head_sha"), 40)
            and run.get("path") == workflow["path"]
            and run.get("event") in {"schedule", "workflow_dispatch"}, "run_provenance")
    require(type(run.get("run_attempt")) is int and run["run_attempt"] == 1,
            "rerun_requires_review")
    require(run.get("status") in ACTIVE | {"completed"}, "run_status")
    require((run["status"] == "completed" and run.get("conclusion") in CONCLUSIONS)
            or (run["status"] in ACTIVE and run.get("conclusion") is None), "run_conclusion")
    created, updated = timestamp(run.get("created_at")), timestamp(run.get("updated_at"))
    require(created <= updated <= now + timedelta(minutes=5), "run_time_bounds")
    if run.get("run_started_at") is not None:
        require(created <= timestamp(run["run_started_at"]) <= updated, "run_start_bounds")


def _steps(api, run, name):
    jobs = _listing(api, f"/actions/runs/{run['id']}/attempts/1/jobs", "jobs")
    selected = [job for job in jobs if job.get("name") == name]
    if not selected and run["status"] in ACTIVE:
        return None, {}
    require(len(selected) == 1, "job_ambiguous")
    job = selected[0]
    require(job.get("run_id") == run["id"] and job.get("head_sha") == run["head_sha"],
            "job_provenance")
    steps = job.get("steps")
    require(isinstance(steps, list) and all(isinstance(step, dict) for step in steps),
            "steps_shape")
    names = [step.get("name") for step in steps]
    require(all(isinstance(name, str) for name in names) and len(names) == len(set(names)),
            "steps_ambiguous")
    return job, {step["name"]: step for step in steps}


def _step(steps, name, run, now):
    row = steps.get(name)
    if row is None and run["status"] in ACTIVE:
        return {"status": "not_yet_present", "conclusion": None, "started_at": None,
                "completed_at": None}
    require(isinstance(row, dict) and row.get("status") in ACTIVE | {"completed"},
            "step_required")
    status, conclusion = row["status"], row.get("conclusion")
    require((status == "completed" and conclusion in CONCLUSIONS)
            or (status in ACTIVE and conclusion is None), "step_conclusion")
    start, end = row.get("started_at"), row.get("completed_at")
    upper = timestamp(run["updated_at"]) if run["status"] == "completed" else now
    if start is not None:
        require(timestamp(run["created_at"]) <= timestamp(start)
                <= upper + timedelta(seconds=1), "step_start_bounds")
    if status == "completed" and conclusion != "skipped":
        require(start is not None and end is not None, "step_times_required")
    if end is not None:
        require(start is not None and timestamp(start) <= timestamp(end)
                <= upper + timedelta(seconds=1), "step_end_bounds")
    return {"status": status, "conclusion": conclusion, "started_at": start, "completed_at": end}


def _json_unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "watchdog_duplicate_json_key")
        result[key] = value
    return result


def _decision(log, step):
    require(isinstance(log, str) and len(log.encode("utf-8")) <= MAX_LOG_BYTES,
            "watchdog_log_bound")
    start, end = timestamp(step["started_at"]), timestamp(step["completed_at"])
    candidates = []
    for line in log.splitlines():
        match = LOG_LINE.fullmatch(line)
        if not match or not start <= timestamp(match[1]) <= end + timedelta(seconds=1):
            continue
        try:
            row = json.loads(match[2], object_pairs_hook=_json_unique)
        except json.JSONDecodeError:
            raise CadenceObservationError("watchdog_json_invalid") from None
        if "schema_version" in row or "paper_cadence" in row:
            candidates.append((row, timestamp(match[1]), match[2]))
    require(len(candidates) == 1, "watchdog_decision_ambiguous")
    row, logged, raw = candidates[0]
    digest = hashlib.sha256(raw.encode()).hexdigest()
    if row == {"paper_cadence": "FAIL", "reason": "verification_refused"}:
        require(step["conclusion"] == "failure", "watchdog_exit_mismatch")
        return {"state": "verification_refused", "verified": False,
                "decision_sha256": digest, "logged_at": logged.isoformat()}
    require(type(row.get("schema_version")) is int and row["schema_version"] == 1
            and row.get("mode") == "paper", "watchdog_decision_schema")
    state = row.get("state")
    base = {"schema_version", "mode", "state"}
    if state == "outside_window":
        require(set(row) == base, "watchdog_decision_fields")
    else:
        require(state in {"active", "attempted", "blocked", "missing", "recovery_dispatched"},
                "watchdog_decision_state")
        required = base | set(ARRAY_FIELDS) | {"session_date", "checked_at", "fills_verified"}
        if state == "recovery_dispatched":
            required.add("recovery_run_id")
        require(set(row) == required and row["fills_verified"] is False,
                "watchdog_decision_fields")
        checked = timestamp(row["checked_at"])
        require(start <= checked <= logged and row["session_date"] == checked.date().isoformat(),
                "watchdog_decision_time")
        for field in ARRAY_FIELDS:
            ids = row[field]
            require(isinstance(ids, list) and len(ids) <= 1000
                    and all(type(value) is int and value > 0 for value in ids)
                    and ids == sorted(set(ids)), "watchdog_decision_ids")
        derived = ("active" if row["active_run_ids"] else "attempted" if row["attempted_run_ids"]
                   else "blocked" if row["failed_run_ids"] else "missing")
        require(derived == ("missing" if state == "recovery_dispatched" else state),
                "watchdog_decision_inconsistent")
    require(step["conclusion"] == ("failure" if state == "blocked" else "success"),
            "watchdog_exit_mismatch")
    return {**row, "verified": True, "decision_sha256": digest, "logged_at": logged.isoformat()}


def observe(api, *, now: datetime, observed_since: datetime, approved_release_sha: str,
            source_digests: dict[str, str]) -> dict:
    """Return complete, stable GET metadata evidence; never a trading verdict.

    source_digests must pin the exact three SOURCE_PATHS. All are checked at main,
    the approved checkout, and every observed orchestration head. Thus adding only
    observer files on main requires neither relabeling nor changing paper release.
    Missing natural runs are observations, never successful schedule tests.
    """
    try:
        return _observe(api, now=now, observed_since=observed_since,
                        approved_release_sha=approved_release_sha, source_digests=source_digests)
    except CadenceObservationError:
        raise
    except Exception:  # noqa: BLE001 -- privacy boundary for injected HTTP transports
        # Transport exceptions may contain URLs, credentials, or raw response bodies.
        raise CadenceObservationError("observation_unavailable") from None


def _observe(api, *, now, observed_since, approved_release_sha, source_digests):
    require(now.tzinfo is not None and observed_since.tzinfo is not None, "clock_timezone")
    now, observed_since = now.astimezone(timezone.utc), observed_since.astimezone(timezone.utc)
    require(observed_since <= now and _hex(approved_release_sha, 40), "observation_config")
    require(set(source_digests) == set(SOURCE_PATHS)
            and all(_hex(value, 64) for value in source_digests.values()), "source_pins")
    repository = api.get("")
    require(repository.get("id") == REPOSITORY_ID and repository.get("full_name") == REPOSITORY
            and repository.get("default_branch") == "main", "repository_provenance")
    main = api.get("/git/ref/heads/main").get("object", {}).get("sha")
    require(_hex(main, 40), "main_head")
    checked_heads = set()

    def verify_source(sha):
        if sha not in checked_heads:
            for path in SOURCE_PATHS:
                require(api.source_digest(sha, path) == source_digests[path], "source_pin_mismatch")
            checked_heads.add(sha)

    verify_source(main)
    verify_source(approved_release_sha)
    workflows = {name: _workflow(api, name) for name in (PAPER, WATCHDOG)}
    catalogs = {name: _listing(api, "/actions/workflows/" + name + "/runs", "workflow_runs")
                for name in workflows}
    paper, watchdog, consulted = [], [], {}
    for name, runs in catalogs.items():
        for listed in runs:
            if listed.get("status") == "completed" and timestamp(listed.get("updated_at")) < observed_since:
                continue
            run = api.get(f"/actions/runs/{listed['id']}")
            require(_run_key(run) == _run_key(listed), "run_changed")
            _run(run, workflows[name], now)
            verify_source(run["head_sha"])
            consulted[run["id"]] = run
            record = {key: run[key] for key in ("id", "head_sha", "event", "status", "conclusion",
                                                 "created_at", "updated_at")}
            record.update({"run_attempt": 1, "source_verified": True,
                           "natural_trigger_observed": run["event"] == "schedule"
                           and timestamp(run["created_at"]) >= observed_since})
            job, steps = _steps(api, run, PAPER_JOB if name == PAPER else WATCHDOG_JOB)
            record["job_id"] = job["id"] if job else None
            if name == PAPER:
                for key, label in (("execution", EXECUTE), ("generation", GENERATION), ("upload", UPLOAD)):
                    record[key] = _step(steps, label, run, now)
                execution = record["execution"]
                record["natural_execution_observed"] = bool(record["natural_trigger_observed"]
                    and execution["started_at"] and execution["conclusion"] != "skipped"
                    and timestamp(execution["started_at"]) >= observed_since)
                record["runtime_publication_steps_succeeded"] = all(
                    record[key]["conclusion"] == "success" for key in ("generation", "upload"))
                paper.append(record)
            else:
                step = _step(steps, RECOVER, run, now)
                record.update({"recover": step, "decision": None})
                if step["status"] == "completed" and step["conclusion"] in {"success", "failure"}:
                    decision = _decision(api.job_log(job["id"]), step)
                    if decision["state"] == "recovery_dispatched":
                        recovery_id = decision.get("recovery_run_id")
                        require(type(recovery_id) is int and recovery_id > 0, "recovery_id")
                        recovery = api.get(f"/actions/runs/{recovery_id}")
                        _run(recovery, workflows[PAPER], now)
                        require(recovery["id"] == recovery_id and recovery["event"] == "workflow_dispatch"
                                and recovery["head_sha"] == run["head_sha"]
                                and timestamp(step["started_at"]) <= timestamp(recovery["created_at"])
                                <= timestamp(decision["logged_at"]), "recovery_provenance")
                        verify_source(recovery["head_sha"])
                        consulted[recovery_id] = recovery
                    record["decision"] = decision
                watchdog.append(record)
    # Detect arrivals, status/attempt changes, reruns, and main/workflow replacement
    # during the multi-request read. Retry is the caller's next observation.
    for name, before in catalogs.items():
        after = _listing(api, "/actions/workflows/" + name + "/runs", "workflow_runs")
        require(_catalog_key(before) == _catalog_key(after), "catalog_changed")
        require(_workflow(api, name) == workflows[name], "workflow_changed")
    for run_id, before in consulted.items():
        require(_run_key(api.get(f"/actions/runs/{run_id}")) == _run_key(before), "run_changed")
    require(api.get("/git/ref/heads/main").get("object", {}).get("sha") == main, "main_changed")
    paper.sort(key=lambda row: (row["created_at"], row["id"]))
    watchdog.sort(key=lambda row: (row["created_at"], row["id"]))
    natural_paper = sorted((row for row in paper if row["natural_execution_observed"]),
                           key=lambda row: (timestamp(row["execution"]["started_at"]), row["id"]))
    natural_watchdog = sorted((row for row in watchdog if row["natural_trigger_observed"]
                              and row["decision"] and row["decision"]["verified"]),
                             key=lambda row: (timestamp(row["decision"]["logged_at"]), row["id"]))
    expected = observed_since.replace(hour=15, minute=5, second=0, microsecond=0)
    while expected <= observed_since or expected.weekday() >= 5:
        expected += timedelta(days=1)
    return {"schema_version": 1, "mode": "paper", "checked_at": now.isoformat(),
            "observed_since": observed_since.isoformat(), "observed_main_sha": main,
            "expected_approved_release_sha": approved_release_sha,
            "source_digests": dict(source_digests), "coverage_complete": True,
            "metadata_stable": True, "paper_runs": paper, "watchdog_runs": watchdog,
            "first_natural_paper_execution": natural_paper[0] if natural_paper else None,
            "first_natural_watchdog_decision": natural_watchdog[0] if natural_watchdog else None,
            "first_expected_session": {"date": expected.date().isoformat(),
                "paper_scheduled_for": expected.isoformat(),
                "watchdog_scheduled_for": (expected + timedelta(minutes=30)).isoformat()},
            "actual_release_verified": False, "portfolio_outcome_verified": False,
            "fills_verified": False}
