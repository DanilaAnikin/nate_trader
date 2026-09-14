"""Observe paper attempts and recover a missing weekday dispatch exactly once.

No broker credentials or endpoints. Recovery dispatches only the existing paper
workflow, whose concurrency lock and second check serialize late cron arrivals.
An execution attempt is never automatically retried. A demonstrably skipped
execution may be retried through all normal read-only preflight checks.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

REPOSITORY = "DanilaAnikin/nate_trader"
WORKFLOW = "paper-production.yml"
JOB = "Guarded paper forward-validation"
EXECUTE = "Execute one guarded paper cycle"
ACTIVE = {"queued", "in_progress", "waiting", "pending", "requested"}


class CadenceError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise CadenceError(code)


def stamp(value):
    require(isinstance(value, str), "timestamp_required")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise CadenceError("timestamp_invalid") from None
    require(result.tzinfo is not None, "timestamp_timezone")
    return result.astimezone(timezone.utc)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    def __init__(self, token):
        require(bool(token), "github_token_missing")
        self.token = token
        self.opener = build_opener(NoRedirect)

    def request(self, path, *, body=None):
        require(path == "" or (path.startswith("/") and not path.startswith("//")), "api_path")
        if body is not None:
            require(path == f"/actions/workflows/{WORKFLOW}/dispatches" and body == {
                "ref": "main", "inputs": {
                    "operation": "execute", "automated_recovery": True,
                },
            }, "paper_dispatch_only")
        req = Request("https://api.github.com/repos/" + REPOSITORY + path,
                      data=None if body is None else json.dumps(body).encode(),
                      headers={"Authorization": "Bearer " + self.token,
                               "Accept": "application/vnd.github+json",
                               "Content-Type": "application/json",
                               "X-GitHub-Api-Version": "2026-03-10"})
        with self.opener.open(req, timeout=30) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
            require(response.status == 200 and len(raw) <= 8 * 1024 * 1024,
                    "api_response")
            result = json.loads(raw)
            require(isinstance(result, dict), "api_object")
            return result


def listing(api, path, field):
    result, total = [], None
    for page in range(1, 11):
        body = api.request(path + ("&" if "?" in path else "?") +
                           urlencode({"per_page": 100, "page": page}))
        values, count = body.get(field), body.get("total_count")
        require(isinstance(values, list) and type(count) is int and
                0 <= count <= 1000 and all(isinstance(v, dict) for v in values),
                "listing_shape")
        require(total is None or total == count, "listing_changed")
        total = count
        result.extend(values)
        require(len(result) <= total, "listing_count")
        if len(result) == total:
            ids = [v.get("id") for v in result]
            require(all(type(v) is int and v > 0 for v in ids) and
                    len(ids) == len(set(ids)), "listing_ids")
            return result
        require(len(values) == 100, "listing_incomplete")
    raise CadenceError("listing_bound")


def assessment(api, now, *, current_run_id=0):
    """Presence of an execution attempt is not evidence of order fills."""
    now = now.astimezone(timezone.utc)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    repository = api.request("")
    repository_id = repository.get("id")
    require(type(repository_id) is int and repository_id > 0 and
            repository.get("full_name") == REPOSITORY and
            repository.get("default_branch") == "main", "repository_provenance")
    workflow = api.request(f"/actions/workflows/{WORKFLOW}")
    require(workflow.get("state") == "active" and
            workflow.get("path") == ".github/workflows/" + WORKFLOW and
            type(workflow.get("id")) is int, "paper_workflow_inactive")
    runs = listing(api, f"/actions/workflows/{WORKFLOW}/runs", "workflow_runs")
    active, attempts, failures, preflight_failures = [], [], [], []
    for run in runs:
        if run["id"] == current_run_id:
            continue
        require(run.get("workflow_id") == workflow["id"], "workflow_mismatch")
        status = run.get("status")
        if status in ACTIVE:
            active.append(run["id"])
            continue
        require(status == "completed", "run_status_unknown")
        # An old queued run that finished today remains relevant.
        if stamp(run.get("updated_at")) < day:
            continue
        require(stamp(run["updated_at"]) <= now + timedelta(minutes=5),
                "future_run_timestamp")
        require(run.get("run_attempt") == 1, "rerun_requires_review")
        require(run.get("repository", {}).get("id") == repository_id and
                run.get("head_repository", {}).get("id") == repository_id and
                run.get("head_branch") == "main" and
                run.get("event") in {"schedule", "workflow_dispatch"} and
                run.get("path", "").split("@", 1)[0] == ".github/workflows/" + WORKFLOW and
                re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", "")),
                "run_provenance")
        jobs = listing(api, f"/actions/runs/{run['id']}/jobs", "jobs")
        selected = [job for job in jobs if job.get("name") == JOB]
        require(len(selected) == 1, "paper_job_ambiguous")
        require(selected[0].get("run_id") == run["id"], "paper_job_run")
        steps = selected[0].get("steps")
        require(isinstance(steps, list), "steps_required")
        executions = [step for step in steps if step.get("name") == EXECUTE]
        require(len(executions) == 1, "execution_step_ambiguous")
        execution = executions[0]
        require(execution.get("status") == "completed" and
                execution.get("conclusion") in {
                    "success", "failure", "cancelled", "timed_out", "skipped",
                }, "execution_step_unreadable")
        started = execution.get("started_at")
        if execution["conclusion"] != "skipped":
            require(isinstance(started, str), "execution_start_required")
            begun = stamp(started)
            require(begun <= now + timedelta(minutes=5), "future_execution")
            if begun >= day:
                attempts.append(run["id"])
        if run.get("conclusion") != "success":
            if execution["conclusion"] == "skipped":
                preflight_failures.append(run["id"])
            else:
                failures.append(run["id"])
    state = "active" if active else "attempted" if attempts else "blocked" if failures else "missing"
    return {"schema_version": 1, "mode": "paper", "session_date": day.date().isoformat(),
            "checked_at": now.isoformat(), "state": state,
            "active_run_ids": sorted(active), "attempted_run_ids": sorted(attempts),
            "failed_run_ids": sorted(failures),
            "preflight_failed_run_ids": sorted(preflight_failures), "fills_verified": False}


def recovery_window(now):
    now = now.astimezone(timezone.utc)
    minute = now.hour * 60 + now.minute
    return now.weekday() < 5 and 15 * 60 + 35 <= minute < 19 * 60 + 45


def guarded_dispatch(api, now, expected_head, *, clock=None):
    require(recovery_window(now), "outside_recovery_window")
    require(re.fullmatch(r"[0-9a-f]{40}", expected_head or ""), "expected_head")
    first = assessment(api, now)
    if first["state"] != "missing":
        return first
    require(api.request("/git/ref/heads/main")["object"]["sha"] == expected_head,
            "default_branch_changed")
    # A second observation prevents dispatch based on an obsolete missing run.
    clock = clock or (lambda: datetime.now(timezone.utc))
    second = assessment(api, clock())
    if second["state"] != "missing":
        return second
    require(recovery_window(clock()), "outside_recovery_window")
    require(api.request("/git/ref/heads/main")["object"]["sha"] == expected_head,
            "default_branch_changed")
    require(recovery_window(clock()), "outside_recovery_window")
    result = api.request(f"/actions/workflows/{WORKFLOW}/dispatches", body={
        "ref": "main", "inputs": {"operation": "execute", "automated_recovery": True},
    })
    run_id = result.get("workflow_run_id")
    require(type(run_id) is int and run_id > 0, "dispatch_id_missing")
    require(result.get("run_url") ==
            f"https://api.github.com/repos/{REPOSITORY}/actions/runs/{run_id}",
            "dispatch_url_mismatch")
    run = api.request(f"/actions/runs/{run_id}")
    require(run.get("head_sha") == expected_head and run.get("head_branch") == "main" and
            run.get("event") == "workflow_dispatch" and run.get("run_attempt") == 1 and
            run.get("path") == ".github/workflows/" + WORKFLOW,
            "dispatch_provenance")
    return {**second, "state": "recovery_dispatched", "recovery_run_id": run_id}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("check", "guard", "recover"))
    args = parser.parse_args(argv)
    try:
        require(os.getenv("GITHUB_REPOSITORY") == REPOSITORY, "repository_binding")
        now = datetime.now(timezone.utc)
        api = GitHub(os.getenv("GH_TOKEN", ""))
        if args.operation == "guard":
            sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
            from broker_mode import resolve_broker_mode

            mode = resolve_broker_mode()
            require(mode.is_mutating and not mode.is_live, "paper_mode_required")
            require(os.getenv("GITHUB_RUN_ATTEMPT") == "1", "attempt_one_required")
            value = os.getenv("PAPER_AUTOMATED_CYCLE")
            require(value in {"true", "false"}, "automation_flag_required")
            run_id = int(os.environ["GITHUB_RUN_ID"])
            require(run_id > 0, "run_id_required")
            report = assessment(api, now, current_run_id=run_id) if value == "true" else {
                "schema_version": 1, "mode": "paper", "state": "intentional_manual_execution",
            }
            allow = report["state"] in {"missing", "intentional_manual_execution"}
            with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
                output.write("allow_execution=" + str(allow).lower() + "\n")
        elif args.operation == "recover":
            if not recovery_window(now):
                report = {"schema_version": 1, "mode": "paper", "state": "outside_window"}
            else:
                report = guarded_dispatch(api, now, os.getenv("GITHUB_SHA"))
        else:
            report = assessment(api, now)
        print(json.dumps(report, sort_keys=True))
        return 1 if report["state"] == "blocked" else 0
    except Exception:
        print(json.dumps({"paper_cadence": "FAIL", "reason": "verification_refused"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
