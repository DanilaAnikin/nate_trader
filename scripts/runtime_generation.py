"""Explicit cycle outcomes and a commit record for one runtime publication.

The last-run record commits hashes of both exact snapshot files. A crash between
file replacements leaves an unverifiable generation, never a mixed healthy one.
This proves publication integrity, not atomicity of separate broker HTTP reads.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import re
import resource
import sys
import tempfile
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

SNAPSHOT_FILES = ("performance.json", "positions.json")
LAST_RUN_FILE = "production/last_run.json"
GENERATION_FIELD = "runtime_generation_id"
CYCLE_REASONS = {
    "completed": frozenset({"rebalance_complete"}),
    "idle": frozenset({"no_rebalance_due"}),
    "pending": frozenset(
        {
            "orders_pending",
            "cancellation_pending",
            "short_reconciliation",
            "infrastructure_reconciliation",
            "convergence_pending",
        }
    ),
    "blocked": frozenset(
        {
            "exposure_gate_closed",
            "execution_incomplete",
            "execution_error",
        }
    ),
    "failed": frozenset(
        {
            "execution_exception",
            "snapshot_unavailable",
            "publication_failed",
        }
    ),
}
CYCLE_HEALTH = {
    "completed": "PASS",
    "idle": "PASS",
    "pending": "PASS",
    "blocked": "DEGRADED",
    "failed": "FAIL",
}


class RuntimeGenerationError(ValueError):
    """A fixed diagnostic code; never raw runtime values."""


def _require(condition: object, reason: str) -> None:
    if not condition:
        raise RuntimeGenerationError(reason)


def cycle_outcome(state: str, reason: str) -> dict[str, Any]:
    value = {"schema_version": 1, "state": state, "reason": reason}
    validate_cycle_outcome(value)
    return value


def validate_cycle_outcome(value: object) -> dict[str, Any]:
    _require(isinstance(value, dict), "cycle_outcome_object")
    _require(set(value) == {"schema_version", "state", "reason"}, "cycle_outcome_keys")
    _require(
        type(value["schema_version"]) is int and value["schema_version"] == 1,
        "cycle_outcome_version",
    )
    state, reason = value["state"], value["reason"]
    _require(
        isinstance(state, str)
        and state in CYCLE_REASONS
        and isinstance(reason, str)
        and reason in CYCLE_REASONS[state],
        "cycle_outcome_reason",
    )
    return dict(value)


def _json_object(raw: bytes) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            _require(key not in result, "runtime_duplicate_key")
            result[key] = value
        return result

    def finite(value):
        if isinstance(value, float):
            _require(math.isfinite(value), "runtime_nonfinite_number")
        elif isinstance(value, dict):
            for item in value.values():
                finite(item)
        elif isinstance(value, list):
            for item in value:
                finite(item)

    try:
        value = json.loads(raw, object_pairs_hook=pairs)
        _require(isinstance(value, dict), "runtime_object_required")
        finite(value)
        return value
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        if isinstance(error, RuntimeGenerationError):
            raise
        raise RuntimeGenerationError("runtime_invalid_json") from None


def validate_runtime_generation(
    files: dict[str, bytes],
    *,
    require_generation: bool = False,
    require_current_run: bool = False,
) -> dict[str, Any] | None:
    """Verify exact 3-file bytes (extra preserved handoff files are ignored).

    None explicitly means legacy without a coherence proof. Any new outcome,
    snapshot generation ID or commit marker requires the whole new contract.
    """
    try:
        performance, positions, last_run = (
            _json_object(files[name]) for name in (*SNAPSHOT_FILES, LAST_RUN_FILE)
        )
    except KeyError:
        raise RuntimeGenerationError("runtime_files_missing") from None
    marked = (
        "runtime_generation" in last_run
        or "cycle_outcome" in last_run
        or GENERATION_FIELD in performance
        or GENERATION_FIELD in positions
    )
    if not marked:
        _require(
            not require_generation and not require_current_run,
            "runtime_generation_required",
        )
        return None
    marker = last_run.get("runtime_generation")
    _require(
        isinstance(marker, dict)
        and set(marker)
        == {
            "schema_version",
            "id",
            "snapshot_status",
            "files",
            "release_sha",
            "github_run_id",
            "github_run_attempt",
        },
        "runtime_generation_keys",
    )
    _require(
        type(marker["schema_version"]) is int and marker["schema_version"] == 1,
        "runtime_generation_version",
    )
    identifier = marker["id"]
    try:
        _require(
            isinstance(identifier, str) and str(UUID(identifier)) == identifier,
            "runtime_generation_id",
        )
    except (ValueError, TypeError, AttributeError):
        raise RuntimeGenerationError("runtime_generation_id") from None
    _require(
        isinstance(marker["snapshot_status"], str)
        and marker["snapshot_status"] in {"fresh", "recovery"},
        "runtime_generation_snapshot_status",
    )
    release = marker["release_sha"]
    _require(
        isinstance(release, str)
        and (release == "local" or re.fullmatch(r"[0-9a-f]{40}", release))
        and release == last_run.get("release_sha"),
        "runtime_generation_release",
    )
    run_id, attempt = marker["github_run_id"], marker["github_run_attempt"]
    _require(
        (run_id is None and attempt is None)
        or (
            type(run_id) is int and run_id > 0 and type(attempt) is int and attempt > 0
        ),
        "runtime_generation_run",
    )
    if require_current_run:
        expected = capture_execution_context(os.environ.get("APPROVED_RELEASE_SHA", ""))
        _require(
            expected["github_run_id"] is not None
            and release != "local"
            and all(marker[key] == value for key, value in expected.items()),
            "runtime_generation_current_run",
        )
    hashes = marker["files"]
    _require(
        isinstance(hashes, dict) and set(hashes) == set(SNAPSHOT_FILES),
        "runtime_generation_files",
    )
    for name, snapshot in zip(SNAPSHOT_FILES, (performance, positions), strict=True):
        _require(
            snapshot.get(GENERATION_FIELD) == identifier, "runtime_generation_mismatch"
        )
        expected = hashes[name]
        _require(
            isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected),
            "runtime_generation_digest",
        )
        _require(
            hashlib.sha256(files[name]).hexdigest() == expected,
            "runtime_generation_digest_mismatch",
        )
    outcome = validate_cycle_outcome(last_run.get("cycle_outcome"))
    _require(
        last_run.get("status") == CYCLE_HEALTH[outcome["state"]],
        "runtime_generation_health_mismatch",
    )
    _require(isinstance(positions.get("positions"), list), "runtime_positions_shape")
    if marker["snapshot_status"] == "recovery":
        _require(last_run["status"] == "FAIL", "runtime_recovery_cannot_pass")
    else:
        _require(
            isinstance(performance.get("updated_at"), str)
            and performance["updated_at"] == positions.get("updated_at")
            and type(performance.get("num_positions")) is int
            and performance["num_positions"] == len(positions["positions"]),
            "runtime_snapshot_mismatch",
        )
    return copy.deepcopy(marker)


def prepare_runtime_generation(
    performance: dict,
    positions: dict,
    summary: dict,
    *,
    snapshot_status: str = "fresh",
    execution_context: dict | None = None,
) -> dict[str, bytes]:
    identifier = str(uuid4())
    snapshots = {
        name: {**copy.deepcopy(value), GENERATION_FIELD: identifier}
        for name, value in zip(SNAPSHOT_FILES, (performance, positions), strict=True)
    }
    files = {
        name: (
            json.dumps(value, indent=2, ensure_ascii=True, allow_nan=False) + "\n"
        ).encode()
        for name, value in snapshots.items()
    }
    record = copy.deepcopy(summary)
    context = (
        execution_context
        if execution_context is not None
        else capture_execution_context(summary.get("release_sha", ""))
    )
    record["runtime_generation"] = {
        "schema_version": 1,
        "id": identifier,
        "snapshot_status": snapshot_status,
        "files": {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()},
        **context,
    }
    files[LAST_RUN_FILE] = (
        json.dumps(record, indent=2, allow_nan=False) + "\n"
    ).encode()
    validate_runtime_generation(files, require_generation=True)
    return files


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish_runtime_generation(
    state_dir: Path,
    performance: dict,
    positions: dict,
    summary: dict,
    *,
    snapshot_status: str = "fresh",
    execution_context: dict | None = None,
) -> dict[str, Any]:
    """Stage all bytes, replace snapshots, then publish their commit record.

    An interrupted publication is detected by readers through IDs and hashes.
    The previous marker must never be treated as proof of replacement files.
    """
    files = prepare_runtime_generation(
        performance,
        positions,
        summary,
        snapshot_status=snapshot_status,
        execution_context=execution_context,
    )
    _require(not state_dir.is_symlink(), "runtime_state_symlink")
    state_dir.mkdir(parents=True, exist_ok=True)
    production = state_dir / "production"
    _require(not production.is_symlink(), "runtime_production_symlink")
    production.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".runtime-generation-", dir=state_dir
    ) as temporary:
        staging = Path(temporary)
        staging.chmod(0o700)
        for index, (name, raw) in enumerate(files.items()):
            destination = state_dir / name
            _require(not destination.is_symlink(), "runtime_file_symlink")
            path = staging / str(index)
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
        _fsync_directory(staging)
        for index, name in enumerate((*SNAPSHOT_FILES, LAST_RUN_FILE)):
            os.replace(staging / str(index), state_dir / name)
            _fsync_directory((state_dir / name).parent)
    return _json_object(files[LAST_RUN_FILE])


def load_recovery_snapshots(state_dir: Path) -> tuple[dict, dict]:
    """Preserve available intent/state after a failed broker refresh; no seed."""
    snapshots = []
    for name in SNAPSHOT_FILES:
        path = state_dir / name
        _require(not path.is_symlink(), "runtime_file_symlink")
        snapshots.append(_json_object(path.read_bytes()))
    return snapshots[0], snapshots[1]


def capture_execution_context(release_sha: str) -> dict:
    """Capture publication lineage before execution; no guessed GitHub run ID."""
    _require(
        isinstance(release_sha, str)
        and (release_sha == "local" or re.fullmatch(r"[0-9a-f]{40}", release_sha)),
        "runtime_generation_release",
    )
    run_id, attempt = (
        os.environ.get("GITHUB_RUN_ID"),
        os.environ.get("GITHUB_RUN_ATTEMPT"),
    )
    if run_id is None and attempt is None:
        return {
            "release_sha": release_sha,
            "github_run_id": None,
            "github_run_attempt": None,
        }
    _require(
        isinstance(run_id, str)
        and re.fullmatch(r"[1-9][0-9]{0,19}", run_id)
        and isinstance(attempt, str)
        and re.fullmatch(r"[1-9][0-9]{0,9}", attempt),
        "runtime_generation_run",
    )
    return {
        "release_sha": release_sha,
        "github_run_id": int(run_id),
        "github_run_attempt": int(attempt),
    }


def main(argv: list[str] | None = None) -> int:
    """Fixed-output publication check; never print account data or exceptions."""
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        args = list(sys.argv[1:] if argv is None else argv)
        _require(bool(args) and args.pop(0) == "verify", "runtime_verify_arguments")
        required = "--require-generation" in args
        current = "--require-current-run" in args
        for flag in ("--require-generation", "--require-current-run"):
            if flag in args:
                args.remove(flag)
        _require(
            len(args) == 2 and args[0] == "--state-dir", "runtime_verify_arguments"
        )
        state_dir = Path(args[1])
        _require(
            not state_dir.is_symlink() and not (state_dir / "production").is_symlink(),
            "runtime_state_symlink",
        )
        files = {}
        for name in (*SNAPSHOT_FILES, LAST_RUN_FILE):
            path = state_dir / name
            _require(
                not path.is_symlink() and path.stat().st_size <= 20 * 1024 * 1024,
                "runtime_file_invalid",
            )
            files[name] = path.read_bytes()
        marker = validate_runtime_generation(
            files, require_generation=required, require_current_run=current
        )
        print(
            json.dumps(
                {
                    "runtime_generation": "PASS",
                    "coherence": "verified" if marker else "legacy",
                }
            )
        )
        return 0
    except Exception:  # noqa: BLE001 - fixed public output boundary; no raw runtime data
        print(json.dumps({"runtime_generation": "FAIL"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
