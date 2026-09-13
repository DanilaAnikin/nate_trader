"""Restore verified, encrypted live state; never seed a real book from paper.

GitHub and broker access is GET-only. First initialization is explicit and
requires a twice-observed empty, bound live account with no earlier execution.
Runtime bytes stay private; CLI failures expose only local fixed reason codes.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import resource
import stat
import subprocess
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import ClassVar
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener
from uuid import UUID
from zoneinfo import ZoneInfo

from restore_paper_runtime import (
    EXECUTION_CONCLUSIONS,
    MAX_API,
    MAX_ARCHIVE,
    GitHub,
    NoRedirect,
    RestoreError,
    execution_lineage,
    install_state,
    listing,
    parse_runtime_zip,
    positive_id,
    require,
    timestamp,
)
from runtime_handoff import SOURCE_FILES, canonical_digest, digest, read_object

WORKFLOW = "live-production.yml"
JOB = "Guarded real-money cycle"
EXECUTE = "Execute one guarded real-money cycle"
UPLOAD = "Preserve private live runtime state"
OUTER_FILE = "runtime.aesgcm"
BOOTSTRAP = "empty-account"
BINDING_KEY = "live_runtime_binding"
PUBLIC_FAILURE_CODES = frozenset(
    {
        "live_mode_required",
        "live_configuration",
        "live_release",
        "checkout_release",
        "current_run_attempt",
        "live_bootstrap_flag",
        "live_runtime_key",
        "live_bootstrap_required",
        "live_bootstrap_prior_artifact",
        "live_bootstrap_prior_or_unknown_execution",
        "live_account_binding",
        "live_account_identity",
        "live_account_changed",
        "live_bootstrap_positions_present",
        "live_bootstrap_orders_present",
        "live_bootstrap_amount",
        "live_bootstrap_not_flat_funded_account",
        "live_bootstrap_capital_exceeds_budget",
        "live_bootstrap_snapshot_changed",
        "live_runtime_account_binding",
        "live_runtime_lineage",
        "live_kill_switch_changed",
        "newer_execution_or_unreadable_attempt",
        "newer_or_changed_runtime_artifact",
    }
)


@dataclass(frozen=True)
class Context:
    repository: str
    release_sha: str
    current_run_id: int
    account_number: str
    bootstrap: bool = False
    capital_budget_usd: float = 0.0


class LiveGitHub(GitHub):
    """The existing authenticated GitHub transport, with environment proxies off."""

    def __init__(self, repository: str, token: str):
        super().__init__(repository, token)
        self.opener = build_opener(ProxyHandler({}), NoRedirect)


class LiveBroker:
    """Only three fixed live GET routes; no SDK mutation methods or redirects."""

    ROUTES: ClassVar[dict[str, str]] = {
        "account": "/v2/account",
        "positions": "/v2/positions",
        "orders": "/v2/orders?status=open&limit=500&nested=false",
    }

    def __init__(self, api_key: str, api_secret: str):
        require(bool(api_key) and bool(api_secret), "live_credentials_missing")
        self.key, self.secret = api_key, api_secret
        self.opener = build_opener(ProxyHandler({}), NoRedirect)

    def get(self, resource_name: str):
        require(resource_name in self.ROUTES, "live_read_route")
        request = Request(
            "https://api.alpaca.markets" + self.ROUTES[resource_name],
            headers={"APCA-API-KEY-ID": self.key, "APCA-API-SECRET-KEY": self.secret},
            method="GET",
        )
        with self.opener.open(request, timeout=20) as response:
            require(response.status == 200, "live_read_status")
            raw = GitHub._read(response, MAX_API)
        # read_object rejects duplicate keys and non-finite JSON numbers. Wrap
        # arrays so those same checks apply to every nested broker record.
        return read_object(b'{"value":' + raw + b"}")["value"]


class Provenance:
    def __init__(self, api, context: Context, now: datetime):
        self.api, self.context = api, context
        self.now = now
        repo = api.get("")
        self.repository_id, self.branch = repo.get("id"), repo.get("default_branch")
        require(
            positive_id(self.repository_id)
            and repo.get("full_name") == context.repository
            and isinstance(self.branch, str)
            and bool(self.branch),
            "repository_provenance",
        )
        workflow = api.get("/actions/workflows/" + WORKFLOW)
        self.workflow_id = workflow.get("id")
        require(
            positive_id(self.workflow_id)
            and workflow.get("path") == ".github/workflows/" + WORKFLOW
            and workflow.get("state") == "active",
            "workflow_provenance",
        )

    def run(self, value: dict) -> dict:
        require(
            positive_id(value.get("id"))
            and value.get("workflow_id") == self.workflow_id
            and value.get("path", "").split("@", 1)[0]
            == ".github/workflows/" + WORKFLOW
            and value.get("repository", {}).get("id") == self.repository_id
            and value.get("head_repository", {}).get("id") == self.repository_id
            and value.get("head_branch") == self.branch
            and value.get("event") == "workflow_dispatch"
            and type(value.get("run_attempt")) is int
            and value["run_attempt"] >= 1
            and bool(re.fullmatch(r"[0-9a-f]{40}", str(value.get("head_sha", "")))),
            "run_provenance",
        )
        timestamp(value.get("created_at"))
        timestamp(value.get("updated_at"))
        timestamp(value.get("run_started_at") or value.get("created_at"))
        return value

    def steps(self, run: dict) -> tuple[dict, dict]:
        jobs = listing(
            self.api,
            f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs",
            "jobs",
        )
        selected = [job for job in jobs if job.get("name") == JOB]
        require(
            len(selected) == 1 and selected[0].get("run_id") == run["id"],
            "job_provenance",
        )
        values = selected[0].get("steps")
        require(
            isinstance(values, list) and all(isinstance(step, dict) for step in values),
            "steps_shape",
        )
        execute = [step for step in values if step.get("name") == EXECUTE]
        upload = [step for step in values if step.get("name") == UPLOAD]
        require(len(execute) == len(upload) == 1, "required_steps")
        return execute[0], upload[0]

    def artifacts(self, release_sha: str) -> list[dict]:
        name = "live-runtime-state-" + release_sha
        values = listing(
            self.api, "/actions/artifacts?" + urlencode({"name": name}), "artifacts"
        )
        require(all(item.get("name") == name for item in values), "artifact_namespace")
        for item in values:
            timestamp(item.get("created_at"))
        return sorted(
            values,
            key=lambda item: (timestamp(item["created_at"]), item["id"]),
            reverse=True,
        )

    def artifact(
        self, item: dict, release_sha: str, *, successful: bool
    ) -> tuple[dict, dict]:
        require(
            positive_id(item.get("id"))
            and item.get("name") == "live-runtime-state-" + release_sha
            and item.get("expired") is False
            and type(item.get("size_in_bytes")) is int
            and 0 < item["size_in_bytes"] <= MAX_ARCHIVE
            and bool(re.fullmatch(r"sha256:[0-9a-f]{64}", str(item.get("digest", "")))),
            "artifact_metadata",
        )
        owner = item.get("workflow_run", {})
        require(
            positive_id(owner.get("id"))
            and owner.get("repository_id") == self.repository_id
            and owner.get("head_repository_id") == self.repository_id
            and owner.get("head_branch") == self.branch,
            "artifact_repository",
        )
        run = self.run(self.api.get(f"/actions/runs/{owner['id']}"))
        require(
            run["id"] != self.context.current_run_id
            and run["run_attempt"] == 1
            and run.get("status") == "completed"
            and owner.get("head_sha") == run["head_sha"],
            "artifact_attempt",
        )
        execute, upload = self.steps(run)
        require(
            execute.get("status") == "completed"
            and execute.get("conclusion") in EXECUTION_CONCLUSIONS
            and upload.get("status") == "completed"
            and upload.get("conclusion") == "success",
            "artifact_steps",
        )
        if successful:
            require(
                execute.get("conclusion") == "success"
                and run.get("conclusion") == "success",
                "source_execution_failed",
            )
        start, end = (
            timestamp(upload.get("started_at")),
            timestamp(upload.get("completed_at")),
        )
        require(
            start <= end
            and start - timedelta(seconds=5)
            <= timestamp(item["created_at"])
            <= end + timedelta(seconds=5),
            "artifact_upload_window",
        )
        require(
            timestamp(execute.get("started_at"))
            <= timestamp(execute.get("completed_at"))
            <= end,
            "execution_window",
        )
        return run, execute

    def latest(
        self, candidate: dict, execute: dict, artifact: dict, namespace: str
    ) -> None:
        # Scan all bounded pages: an old run can be rerun today, so filtering by
        # creation date would hide a newer execution attempt under an older ID.
        runs = listing(
            self.api, "/actions/workflows/" + WORKFLOW + "/runs", "workflow_runs"
        )
        found = False
        candidate_end = timestamp(execute["completed_at"])
        candidate_start = timestamp(execute["started_at"])
        for entry in runs:
            run = self.run(entry)
            if run["id"] == self.context.current_run_id:
                continue
            if run["id"] == candidate["id"]:
                require(
                    run["run_attempt"] == candidate["run_attempt"]
                    and run.get("status") == "completed",
                    "candidate_attempt_changed",
                )
                found = True
                continue
            if (
                run.get("status") == "completed"
                and timestamp(run["updated_at"]) < candidate_start
            ):
                continue
            later, _ = self.steps(run)
            require(
                later.get("status") == "completed",
                "newer_execution_or_unreadable_attempt",
            )
            if later.get("conclusion") != "skipped":
                require(
                    later.get("conclusion") in EXECUTION_CONCLUSIONS
                    and timestamp(later.get("completed_at")) < candidate_start,
                    "newer_execution_or_unreadable_attempt",
                )
            # A skipped execution is a read-only preflight. Unknown/in-progress
            # steps and failed execution attempts must never disappear here.
        require(found, "candidate_run_missing")
        latest = self.artifacts(namespace)
        require(
            bool(latest) and latest[0] == artifact, "newer_or_changed_runtime_artifact"
        )
        require(candidate_end <= self.now + timedelta(minutes=1), "future_execution")

    def empty(self) -> None:
        """Missing target state never erases a prior real-money execution."""
        artifacts = listing(self.api, "/actions/artifacts", "artifacts")
        require(
            not any(
                str(item.get("name", "")).startswith("live-runtime-state-")
                for item in artifacts
            ),
            "live_bootstrap_prior_artifact",
        )
        runs = listing(
            self.api, "/actions/workflows/" + WORKFLOW + "/runs", "workflow_runs"
        )
        for entry in runs:
            run = self.run(entry)
            if run["id"] == self.context.current_run_id:
                continue
            execute, _ = self.steps(run)
            require(
                run.get("status") == "completed"
                and execute.get("status") == "completed"
                and execute.get("conclusion") == "skipped",
                "live_bootstrap_prior_or_unknown_execution",
            )


def bound_account(broker, context: Context) -> tuple[dict, str]:
    account = broker.get("account")
    require(
        isinstance(account, dict)
        and account.get("account_number") == context.account_number
        and bool(context.account_number)
        and account.get("status") == "ACTIVE"
        and account.get("currency") == "USD"
        and all(
            account.get(field) is False
            for field in (
                "account_blocked",
                "trading_blocked",
                "trade_suspended_by_user",
            )
        ),
        "live_account_binding",
    )
    try:
        identifier = str(UUID(str(account.get("id"))))
    except (ValueError, TypeError, AttributeError):
        raise RestoreError("live_account_identity") from None
    binding = canonical_digest(
        {"broker": "alpaca", "mode": "live", "account_id": identifier}
    )
    return account, binding


def outer_ciphertext(raw: bytes) -> bytes:
    """GitHub wraps one authenticated ciphertext; plaintext archives fail closed."""
    require(0 < len(raw) <= MAX_ARCHIVE, "outer_archive_size")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            require(len(members) == 1, "outer_archive_entries")
            member = members[0]
            require(
                member.orig_filename == member.filename == OUTER_FILE
                and not member.is_dir()
                and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFREG)
                and not member.flag_bits & 1
                and member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                and 0 < member.file_size <= MAX_ARCHIVE
                and member.file_size <= max(1, member.compress_size) * 1000,
                "outer_archive_entry",
            )
            ciphertext = archive.read(member)
            require(len(ciphertext) == member.file_size, "outer_archive_length")
            return ciphertext
    except RestoreError:
        raise
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError):
        raise RestoreError("outer_archive_invalid") from None


def checked_archive(api, artifact: dict, release_sha: str) -> dict[str, bytes]:
    from live_runtime_crypto import decrypt_runtime_blob

    raw = api.download(artifact["id"])
    require("sha256:" + digest(raw) == artifact["digest"], "archive_digest")
    clear = decrypt_runtime_blob(outer_ciphertext(raw), release_sha)
    files = parse_runtime_zip(clear)
    require(set(files) == set(SOURCE_FILES), "live_runtime_file_set")
    return files


def validate_runtime(
    files: dict[str, bytes], context: Context, account_sha: str
) -> dict:
    performance, positions, last_run = (
        read_object(files[name]) for name in SOURCE_FILES
    )
    require(isinstance(positions.get("positions"), list), "live_runtime_structure")
    binding = performance.get(BINDING_KEY)
    require(
        isinstance(binding, dict)
        and set(binding)
        == {
            "schema_version",
            "broker_mode",
            "account_sha256",
            "release_sha",
            "initialized_at",
        }
        and type(binding.get("schema_version")) is int
        and binding["schema_version"] == 1
        and binding.get("broker_mode") == "live"
        and binding.get("account_sha256") == account_sha
        and binding.get("release_sha") == context.release_sha,
        "live_runtime_account_binding",
    )
    timestamp(binding.get("initialized_at"))
    require(
        type(last_run.get("schema_version")) is int
        and last_run["schema_version"] == 1
        and last_run.get("kind") == "v11_live_production_run"
        and last_run.get("paper_only") is False
        and last_run.get("broker_mode") == "live"
        and last_run.get("release_sha") == context.release_sha
        and last_run.get("status") in {"PASS", "FAIL", "DEGRADED"},
        "live_runtime_lineage",
    )
    timestamp(last_run.get("completed_at"))
    return last_run


def empty_snapshot(broker, context: Context) -> dict:
    account, binding = bound_account(broker, context)
    require(broker.get("positions") == [], "live_bootstrap_positions_present")
    require(broker.get("orders") == [], "live_bootstrap_orders_present")
    values = {}
    for name in (
        "equity",
        "cash",
        "last_equity",
        "long_market_value",
        "short_market_value",
    ):
        try:
            require(not isinstance(account.get(name), bool), "live_bootstrap_amount")
            number = float(account[name])
        except (KeyError, ValueError, TypeError):
            raise RestoreError("live_bootstrap_amount") from None
        require(math.isfinite(number), "live_bootstrap_amount")
        values[name] = number
    require(
        values["equity"] > 0
        and values["cash"] > 0
        and values["last_equity"] >= 0
        and abs(values["equity"] - values["cash"]) <= 0.005
        and values["long_market_value"] == values["short_market_value"] == 0,
        "live_bootstrap_not_flat_funded_account",
    )
    require(
        math.isfinite(context.capital_budget_usd)
        and context.capital_budget_usd > 0
        and max(values["equity"], values["cash"]) <= context.capital_budget_usd,
        "live_bootstrap_capital_exceeds_budget",
    )
    return {"account_sha256": binding, **values}


def bootstrap_files(
    snapshot: dict, context: Context, now: datetime
) -> dict[str, bytes]:
    from risk_policy import assess_portfolio_risk

    equity, cash, previous = (
        snapshot[name] for name in ("equity", "cash", "last_equity")
    )
    local_now = now.astimezone(ZoneInfo("America/New_York"))
    observed = local_now.strftime("%Y-%m-%d %H:%M:%S")
    assessment = assess_portfolio_risk(
        equity, previous_equity=previous if previous > 0 else None
    )
    performance = {
        BINDING_KEY: {
            "schema_version": 1,
            "broker_mode": "live",
            "account_sha256": snapshot["account_sha256"],
            "release_sha": context.release_sha,
            "initialized_at": now.isoformat(),
        },
        "equity": equity,
        "cash": cash,
        "cash_pct": cash / equity * 100,
        # Funding a previously empty account is not measured strategy profit.
        # Preserve the broker observation without inventing prior history/PnL.
        "broker_last_equity": previous,
        "num_positions": 0,
        "updated_at": observed,
        "risk_tier": assessment.tier,
        "risk_lookback_sessions": assessment.lookback_sessions,
        "rolling_peak_equity": assessment.rolling_peak_equity,
        "rolling_drawdown_pct": assessment.rolling_drawdown_pct,
        "adaptive_rebalance_pending": None,
        "daily_history": [
            {
                "date": local_now.date().isoformat(),
                "equity": equity,
                "cash": cash,
                "num_positions": 0,
            }
        ],
    }
    # A snapshot is not an execution. production_run.py alone writes last_run.
    return {
        "performance.json": json.dumps(performance, allow_nan=False).encode(),
        "positions.json": json.dumps(
            {"updated_at": observed, "positions": []}
        ).encode(),
    }


def kill_switch_snapshot(state_dir: Path) -> dict[str, bytes]:
    paths = {state_dir / "production/LIVE_TRADING_DISABLED"}
    configured = os.environ.get("LIVE_TRADING_KILL_SWITCH_FILE")
    if configured:
        path = Path(configured).absolute()
        # External kill switches are never part of the swapped state tree.
        if path.is_relative_to(state_dir.absolute()):
            paths.add(path)
    result = {}
    for path in paths:
        require(not path.is_symlink(), "live_kill_switch_symlink")
        if path.exists():
            require(
                path.is_file() and path.stat().st_size <= 65536, "live_kill_switch_file"
            )
            name = str(path.absolute().relative_to(state_dir.absolute()))
            require(name not in SOURCE_FILES, "live_kill_switch_runtime_overlap")
            result[name] = path.read_bytes()
    return result


def restore(api, broker, context: Context, state_dir: Path, *, now=None) -> str:
    current = now or datetime.now(timezone.utc)
    require(bool(re.fullmatch(r"[0-9a-f]{40}", context.release_sha)), "live_release")
    require(positive_id(context.current_run_id), "current_run")
    provenance = Provenance(api, context, current)
    native = provenance.artifacts(context.release_sha)
    _, account_sha = bound_account(broker, context)
    markers = kill_switch_snapshot(state_dir)
    if native:
        artifact = native[0]
        run, execute = provenance.artifact(
            artifact, context.release_sha, successful=False
        )
        files = checked_archive(api, artifact, context.release_sha)
        execution_lineage(validate_runtime(files, context, account_sha), execute)

        def recheck():
            provenance.latest(run, execute, artifact, context.release_sha)
            require(
                bound_account(broker, context)[1] == account_sha, "live_account_changed"
            )
            require(
                kill_switch_snapshot(state_dir) == markers, "live_kill_switch_changed"
            )

        mode = "native"
    else:
        require(context.bootstrap, "live_bootstrap_required")
        provenance.empty()
        snapshot = empty_snapshot(broker, context)
        require(snapshot["account_sha256"] == account_sha, "live_account_changed")
        files = bootstrap_files(snapshot, context, current)

        def recheck():
            provenance.empty()
            require(
                empty_snapshot(broker, context) == snapshot,
                "live_bootstrap_snapshot_changed",
            )
            require(
                kill_switch_snapshot(state_dir) == markers, "live_kill_switch_changed"
            )

        mode = "bootstrap"
    recheck()
    install_state(state_dir, {**files, **markers}, recheck)
    return mode


def main() -> int:
    stage = "configuration"
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        os.environ["PYTHON_DOTENV_DISABLED"] = "1"
        from broker_mode import resolve_broker_mode

        root = Path(__file__).resolve().parent.parent
        resolved = resolve_broker_mode()
        require(resolved.is_live, "live_mode_required")
        require(
            resolved.is_live and bool(resolved.expected_account_number),
            "live_configuration",
        )
        release = os.environ.get("APPROVED_RELEASE_SHA", "")
        require(bool(re.fullmatch(r"[0-9a-f]{40}", release)), "live_release")
        checked_out = (
            subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, check=True
            )
            .stdout.decode()
            .strip()
        )
        require(checked_out == release, "checkout_release")
        require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "current_run_attempt")
        bootstrap = os.environ.get("LIVE_RUNTIME_BOOTSTRAP", "")
        require(bootstrap in ("", BOOTSTRAP), "live_bootstrap_flag")
        context = Context(
            os.environ["GITHUB_REPOSITORY"],
            release,
            int(os.environ["GITHUB_RUN_ID"]),
            resolved.expected_account_number,
            bootstrap == BOOTSTRAP,
            resolved.capital_budget_usd,
        )
        # Validate the ciphertext key before any broker credentials are used.
        require(
            bool(
                re.fullmatch(r"[0-9a-fA-F]{64}", os.environ.get("LIVE_RUNTIME_KEY", ""))
            ),
            "live_runtime_key",
        )
        stage = "restore"
        mode = restore(
            LiveGitHub(context.repository, os.environ["GH_TOKEN"]),
            LiveBroker(resolved.api_key, resolved.api_secret),
            context,
            root / "state",
        )
        print(json.dumps({"live_runtime_restore": "PASS", "mode": mode}))
        return 0
    except Exception as error:  # noqa: BLE001 - Never print broker/HTTP bodies or credentials.
        code = str(error) if isinstance(error, RestoreError) else "restore_refused"
        if code not in PUBLIC_FAILURE_CODES:
            code = "restore_refused"
        print(
            json.dumps({"live_runtime_restore": "FAIL", "stage": stage, "code": code})
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
