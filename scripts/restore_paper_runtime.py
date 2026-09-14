"""Read-only GitHub transport for an exact paper runtime or approved handoff.

No release seed is an execution state. An unreadable newest state/attempt stops
restoration instead of selecting an older successful run. API error bodies,
tokens, signed download URLs and private runtime bytes are never printed.
"""

from __future__ import annotations

import io
import json
import os
import re
import resource
import shutil
import stat
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from runtime_generation import RuntimeGenerationError, validate_runtime_generation
from runtime_handoff import (
    FIRST_HANDOFF_FILES,
    HANDOFF_DIR,
    SOURCE_FILES,
    digest,
    read_object,
    source_file_names,
    validate_manifest,
    validate_source,
)

WORKFLOW = "paper-production.yml"
JOB = "Guarded paper forward-validation"
EXECUTE = "Execute one guarded paper cycle"
UPLOAD = "Preserve private runtime state"
EXECUTION_CONCLUSIONS = {"success", "failure", "cancelled", "timed_out"}
MAX_ARCHIVE = 20 * 1024 * 1024
MAX_INFLATED = 32 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_API = 8 * 1024 * 1024
MAX_PAGES = 10
MANIFEST_PATH = str(HANDOFF_DIR / "manifest.json")
ORIGINAL_PATHS = {str(HANDOFF_DIR / "source" / name): name for name in SOURCE_FILES}
RUNTIME_FILES = set(SOURCE_FILES) | {MANIFEST_PATH} | set(ORIGINAL_PATHS)
CHAINED_RUNTIME_FILES = (
    set(SOURCE_FILES)
    | {MANIFEST_PATH}
    | {str(HANDOFF_DIR / "source" / name) for name in FIRST_HANDOFF_FILES}
)


class RestoreError(RuntimeError):
    """Only fixed local reason codes; the CLI emits a fixed FAIL result."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise RestoreError(code)


def timestamp(value) -> datetime:
    try:
        require(isinstance(value, str), "timestamp_type")
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(result.tzinfo is not None, "timestamp_timezone")
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise RestoreError("timestamp_invalid") from None


def positive_id(value) -> bool:
    return type(value) is int and value > 0


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    """HTTPS only; Authorization is sent exclusively to api.github.com."""

    def __init__(self, repository: str, token: str):
        require(
            bool(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)),
            "repository_name",
        )
        require(bool(token), "github_token_missing")
        self.root = "https://api.github.com/repos/" + repository
        self.token = token
        self.opener = build_opener(NoRedirect)

    @staticmethod
    def _read(response, maximum: int) -> bytes:
        data = response.read(maximum + 1)
        require(len(data) <= maximum, "response_too_large")
        return data

    def _request(self, path: str) -> Request:
        require(
            path == "" or (path.startswith("/") and not path.startswith("//")),
            "api_path",
        )
        return Request(
            self.root + path,
            headers={
                "Authorization": "Bearer " + self.token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "nate-paper-runtime-restore",
            },
        )

    def get(self, path: str) -> dict:
        with self.opener.open(self._request(path), timeout=30) as response:
            require(response.status == 200, "api_status")
            return read_object(self._read(response, MAX_API))

    def download(self, artifact_id: int) -> bytes:
        require(positive_id(artifact_id), "artifact_id")
        try:
            response = self.opener.open(
                self._request(f"/actions/artifacts/{artifact_id}/zip"), timeout=30
            )
        except HTTPError as error:
            require(error.code == 302, "archive_redirect_status")
            location = error.headers.get("Location", "")
            error.close()
        else:
            response.close()
            raise RestoreError("archive_redirect_required")
        parsed = urlsplit(location)
        require(
            parsed.scheme == "https"
            and parsed.username is None
            and parsed.password is None
            and parsed.port in (None, 443)
            and not parsed.fragment
            and bool(parsed.hostname)
            and (
                parsed.hostname.endswith(".blob.core.windows.net")
                or parsed.hostname.endswith(".actions.githubusercontent.com")
            ),
            "archive_redirect_host",
        )
        # A new unauthenticated request, with redirects still disabled. Never
        # forward the GitHub token to a signed blob URL or another redirect.
        with self.opener.open(
            Request(location, headers={"User-Agent": "nate-paper-runtime-restore"}),
            timeout=60,
        ) as response:
            require(response.status == 200, "archive_status")
            return self._read(response, MAX_ARCHIVE)


def listing(api, path: str, field: str) -> list[dict]:
    entries: list[dict] = []
    total = None
    for page in range(1, MAX_PAGES + 1):
        separator = "&" if "?" in path else "?"
        body = api.get(f"{path}{separator}per_page=100&page={page}")
        count, values = body.get("total_count"), body.get(field)
        require(
            type(count) is int
            and count >= 0
            and isinstance(values, list)
            and all(isinstance(item, dict) for item in values),
            "listing_shape",
        )
        require(total is None or total == count, "listing_changed")
        total = count
        entries.extend(values)
        require(len(entries) <= total, "listing_count")
        if len(entries) == total:
            ids = [item.get("id") for item in entries]
            require(
                all(positive_id(value) for value in ids) and len(set(ids)) == len(ids),
                "listing_ids",
            )
            return entries
        require(len(values) == 100, "listing_incomplete")
    raise RestoreError("listing_bound")


def parse_runtime_zip(raw: bytes) -> dict[str, bytes]:
    require(0 < len(raw) <= MAX_ARCHIVE, "archive_size")
    files = {}
    seen = set()
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            require(0 < len(members) <= 32, "archive_member_count")
            for member in members:
                name = member.orig_filename
                require(
                    name == member.filename
                    and "\\" not in name
                    and "\x00" not in name
                    and not name.startswith("/")
                    and ":" not in name,
                    "archive_path",
                )
                parts = name.rstrip("/").split("/")
                require(
                    all(part not in ("", ".", "..") for part in parts), "archive_path"
                )
                require(name not in seen, "archive_duplicate")
                seen.add(name)
                mode = stat.S_IFMT(member.external_attr >> 16)
                require(
                    mode in (0, stat.S_IFREG, stat.S_IFDIR)
                    and not member.flag_bits & 1,
                    "archive_special_file",
                )
                if member.is_dir():
                    require(
                        mode in (0, stat.S_IFDIR)
                        and any(
                            path.startswith(name) for path in CHAINED_RUNTIME_FILES
                        ),
                        "archive_directory",
                    )
                    continue
                require(
                    mode in (0, stat.S_IFREG) and name in CHAINED_RUNTIME_FILES,
                    "archive_unexpected_file",
                )
                total += member.file_size
                require(
                    0 <= member.file_size <= MAX_FILE
                    and total <= MAX_INFLATED
                    and member.file_size <= max(1, member.compress_size) * 1000,
                    "archive_inflation",
                )
                data = archive.read(member)
                require(len(data) == member.file_size, "archive_file_size")
                files[name] = data
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError):
        raise RestoreError("archive_invalid") from None
    require(
        set(files) in (set(SOURCE_FILES), RUNTIME_FILES, CHAINED_RUNTIME_FILES),
        "archive_file_set",
    )
    return files


@dataclass(frozen=True)
class Context:
    repository: str
    release_sha: str
    strategy_identity: str
    universe_sha: str
    current_run_id: int
    manifest_pin: str = ""
    manifest_raw: bytes = b""


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
            and value.get("event") in {"schedule", "workflow_dispatch"}
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
        name = "paper-runtime-state-" + release_sha
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
            and item.get("name") == "paper-runtime-state-" + release_sha
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


def checked_archive(
    api, artifact: dict, expected: str | None = None
) -> dict[str, bytes]:
    raw = api.download(artifact["id"])
    actual = digest(raw)
    require(
        "sha256:" + actual == artifact["digest"]
        and (expected is None or actual == expected),
        "archive_digest",
    )
    return parse_runtime_zip(raw)


def execution_lineage(last_run: dict, execution: dict) -> None:
    completed = timestamp(last_run["completed_at"])
    require(
        timestamp(execution["started_at"]) - timedelta(seconds=5)
        <= completed
        <= timestamp(execution["completed_at"]) + timedelta(seconds=5),
        "runtime_execution_window",
    )


def generation_run_lineage(files: dict[str, bytes], run: dict) -> None:
    try:
        marker = validate_runtime_generation(files)
    except RuntimeGenerationError:
        raise RestoreError("runtime_generation_invalid") from None
    if marker is not None:
        require(
            marker["github_run_id"] == run["id"]
            and marker["github_run_attempt"] == run["run_attempt"],
            "runtime_generation_run",
        )


def validate_runtime(files: dict[str, bytes], release_sha: str) -> dict:
    try:
        validate_runtime_generation(files)
    except RuntimeGenerationError:
        raise RestoreError("runtime_generation_invalid") from None
    performance, positions, last_run = (
        read_object(files[name]) for name in SOURCE_FILES
    )
    require(
        isinstance(performance, dict) and isinstance(positions.get("positions"), list),
        "runtime_structure",
    )
    require(
        type(last_run.get("schema_version")) is int
        and last_run["schema_version"] == 1
        and last_run.get("kind") == "v11_paper_production_run"
        and last_run.get("paper_only") is True
        and last_run.get("release_sha") == release_sha
        and last_run.get("status") in {"PASS", "FAIL", "DEGRADED"},
        "runtime_lineage",
    )
    timestamp(last_run.get("completed_at"))
    return last_run


def preserved_handoff(files: dict[str, bytes], context: Context, now: datetime) -> dict:
    require(
        set(files) in (RUNTIME_FILES, CHAINED_RUNTIME_FILES),
        "preserved_handoff_incomplete",
    )
    manifest = validate_manifest(
        files[MANIFEST_PATH],
        context.manifest_pin,
        target_sha=context.release_sha,
        target_identity=context.strategy_identity,
        universe_sha=context.universe_sha,
        bootstrap=False,
        now=now,
    )
    names = source_file_names(manifest)
    expected = (
        set(SOURCE_FILES)
        | {MANIFEST_PATH}
        | {str(HANDOFF_DIR / "source" / name) for name in names}
    )
    require(set(files) == expected, "preserved_handoff_file_set")
    original = {name: files[str(HANDOFF_DIR / "source" / name)] for name in names}
    validate_source(manifest, original)
    return manifest


def install_state(state_dir: Path, files: dict[str, bytes], recheck) -> None:
    """Prepare every byte before replacing the runtime; roll back a failed swap."""
    require(
        not state_dir.is_symlink() and (not state_dir.exists() or state_dir.is_dir()),
        "state_directory",
    )
    state_dir.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".paper-runtime-", dir=state_dir.parent))
    temporary.chmod(0o700)
    staging, backup = temporary / "next", temporary / "previous"
    try:
        if state_dir.exists():
            require(
                not any(path.is_symlink() for path in state_dir.rglob("*")),
                "state_symlink",
            )
            shutil.copytree(state_dir, staging)
            production = staging / "production"
            if production.exists():
                shutil.rmtree(production)
        else:
            staging.mkdir(mode=0o700)
        for name, data in files.items():
            path = staging / PurePosixPath(name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o600)
        recheck()
        if state_dir.exists():
            os.replace(state_dir, backup)
        try:
            os.replace(staging, state_dir)
        except OSError:
            if backup.exists():
                os.replace(backup, state_dir)
            raise
    finally:
        shutil.rmtree(temporary)


def restore(
    api, context: Context, state_dir: Path, *, now: datetime | None = None
) -> str:
    current = now or datetime.now(timezone.utc)
    provenance = Provenance(api, context, current)
    native = provenance.artifacts(context.release_sha)
    if native:
        artifact = native[0]
        run, execution = provenance.artifact(
            artifact, context.release_sha, successful=False
        )
        files = checked_archive(api, artifact)
        last_run = read_object(files["production/last_run.json"])
        if last_run.get("release_sha") == context.release_sha:
            validate_runtime(files, context.release_sha)
            generation_run_lineage(files, run)
            execution_lineage(last_run, execution)
            if MANIFEST_PATH in files:
                preserved_handoff(files, context, current)
        else:
            manifest = preserved_handoff(files, context, current)
            validate_runtime(files, manifest["source"]["release_sha"])
            require(
                all(
                    files[name] == files[str(HANDOFF_DIR / "source" / name)]
                    for name in SOURCE_FILES
                ),
                "uncommitted_target_runtime_changed",
            )
        namespace, mode = context.release_sha, "native"
    else:
        require(bool(context.manifest_raw), "native_runtime_missing")
        manifest = validate_manifest(
            context.manifest_raw,
            context.manifest_pin,
            target_sha=context.release_sha,
            target_identity=context.strategy_identity,
            universe_sha=context.universe_sha,
            bootstrap=True,
            now=current,
        )
        namespace = manifest["source"]["release_sha"]
        candidates = provenance.artifacts(namespace)
        require(
            bool(candidates)
            and candidates[0]["id"] == manifest["source"]["artifact_id"],
            "source_not_latest",
        )
        artifact = candidates[0]
        run, execution = provenance.artifact(artifact, namespace, successful=True)
        require(run["id"] == manifest["source"]["run_id"], "source_run_id")
        files = checked_archive(api, artifact, manifest["source"]["artifact_sha256"])
        require(set(files) == set(source_file_names(manifest)), "source_nested_handoff")
        validate_runtime(files, namespace)
        generation_run_lineage(files, run)
        validate_source(manifest, files, bootstrap=True, now=current)
        execution_lineage(read_object(files["production/last_run.json"]), execution)
        original = dict(files)
        files = {name: original[name] for name in SOURCE_FILES}
        files[MANIFEST_PATH] = context.manifest_raw
        files.update(
            {
                str(HANDOFF_DIR / "source" / name): data
                for name, data in original.items()
            }
        )
        mode = "handoff"

    def recheck() -> None:
        provenance.latest(run, execution, artifact, namespace)
        if mode == "handoff":
            require(
                not provenance.artifacts(context.release_sha),
                "native_runtime_appeared",
            )

    recheck()
    install_state(state_dir, files, recheck)
    return mode


def main() -> int:
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        import subprocess

        from strategy_identity import build_strategy_identity, hash_symbol_universe
        from universe import load_universe_symbols
        from utils import PROJECT_ROOT, STATE_DIR

        release = os.environ.get("APPROVED_RELEASE_SHA", "")
        require(
            os.environ.get("TRADING_MODE") == "paper"
            and bool(re.fullmatch(r"[0-9a-f]{40}", release)),
            "paper_release",
        )
        checked_out = (
            subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=PROJECT_ROOT,
                capture_output=True,
                check=True,
            )
            .stdout.decode()
            .strip()
        )
        require(checked_out == release, "checkout_release")
        current_run = int(os.environ["GITHUB_RUN_ID"])
        require(
            current_run > 0 and os.environ.get("GITHUB_RUN_ATTEMPT") == "1",
            "current_run",
        )
        context = Context(
            os.environ["GITHUB_REPOSITORY"],
            release,
            build_strategy_identity()["value"],
            hash_symbol_universe(load_universe_symbols(held_symbols=[])),
            current_run,
            os.environ.get("PAPER_RUNTIME_HANDOFF_SHA256", ""),
            os.environ.get("PAPER_RUNTIME_HANDOFF_MANIFEST", "").encode(),
        )
        mode = restore(
            GitHub(context.repository, os.environ["GH_TOKEN"]), context, STATE_DIR
        )
        print(json.dumps({"runtime_restore": "PASS", "mode": mode}))
        return 0
    except Exception:  # noqa: BLE001 - CLI boundary must not print private API errors.
        print(json.dumps({"runtime_restore": "FAIL"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
