"""Prepare a reviewable manifest locally; GET-only broker access, no approval.

Input ZIP and output manifest must be in private tmpfs (or stream the ZIP via
stdin). The output is created exclusively with mode 0600. No credentials,
account identifiers, targets, order identifiers, or API bodies reach stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from runtime_handoff import (
    MAX_BOOTSTRAP_WINDOW_SECONDS,
    SOURCE_FILES,
    HandoffError,
    account_digest,
    canonical_digest,
    digest,
    immutable_plan_digest,
    read_object,
    reconcile_broker,
    validate_manifest,
    validate_source,
)


def build_manifest(
    files: dict[str, bytes],
    *,
    archive_sha256: str,
    source_sha: str,
    source_run_id: int,
    source_artifact_id: int,
    target_sha: str,
    target_identity: str,
    universe_sha: str,
    account_sha256: str,
    now: datetime | None = None,
) -> dict:
    """Derive every frozen-plan field from source bytes, never operator edits."""
    now = now or datetime.now(timezone.utc)
    plan = read_object(files["performance.json"])["adaptive_rebalance_pending"]
    manifest = {
        "schema_version": 1,
        "kind": "v11_paper_runtime_handoff",
        "source": {
            "release_sha": source_sha,
            "strategy_identity": plan["strategy_identity_value"],
            "run_id": source_run_id,
            "artifact_id": source_artifact_id,
            "artifact_sha256": archive_sha256,
            "files": {name: digest(files[name]) for name in SOURCE_FILES},
        },
        "target": {"release_sha": target_sha, "strategy_identity": target_identity},
        "paper_account_sha256": account_sha256,
        "ranking_universe_sha256": universe_sha,
        "plan": {
            "plan_id": plan["plan_id"],
            "immutable_sha256": immutable_plan_digest(plan),
            "initial_attempts_sha256": canonical_digest(plan["order_attempts"]),
            "rebalance_month": plan["rebalance_month"],
        },
        "issued_at": now.isoformat().replace("+00:00", "Z"),
        "expires_at": (now + timedelta(seconds=MAX_BOOTSTRAP_WINDOW_SECONDS))
        .isoformat()
        .replace("+00:00", "Z"),
    }
    raw = serialize_manifest(manifest)
    validate_manifest(
        raw,
        digest(raw),
        target_sha=target_sha,
        target_identity=target_identity,
        universe_sha=universe_sha,
        bootstrap=True,
        now=now,
    )
    validate_source(manifest, files, bootstrap=True, now=now)
    return manifest


def serialize_manifest(manifest: dict) -> bytes:
    # No final newline: exact bytes survive an environment-variable roundtrip.
    return json.dumps(
        manifest, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _private_tmpfs(path: Path, *, directory: bool = False) -> None:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise HandoffError("private tmpfs path required")
    if (directory and not stat.S_ISDIR(info.st_mode)) or (
        not directory and not stat.S_ISREG(info.st_mode)
    ):
        raise HandoffError("private tmpfs path required")
    result = subprocess.run(
        ["stat", "-f", "-c", "%T", "--", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    if result.stdout.strip() != "tmpfs":
        raise HandoffError("private tmpfs path required")


def prepare(args, *, stdin=None) -> dict:
    from broker_mode import resolve_broker_mode
    from execute_trades import _v11_validation_gate
    from restore_paper_runtime import parse_runtime_zip
    from strategy_identity import (
        STRATEGY_SOURCE_PATHS,
        build_strategy_identity,
        hash_symbol_universe,
    )
    from trade import _get_client
    from universe import load_universe_symbols
    from utils import PROJECT_ROOT

    if resolve_broker_mode().mode != "paper":
        raise HandoffError("explicit paper mode required")
    actual_sha = subprocess.check_output(
        ["git", "rev-parse", "HEAD"],
        cwd=PROJECT_ROOT,
        stderr=subprocess.PIPE,
        text=True,
    ).strip()
    if actual_sha != args.target_sha:
        raise HandoffError("target checkout mismatch")
    subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", *STRATEGY_SOURCE_PATHS],
        cwd=PROJECT_ROOT,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "diff", "--exit-code", "HEAD", "--", *STRATEGY_SOURCE_PATHS],
        cwd=PROJECT_ROOT,
        capture_output=True,
        check=True,
    )
    if not _v11_validation_gate().get("passed"):
        raise HandoffError("target canonical gate required")
    _private_tmpfs(args.output.parent, directory=True)
    if args.source_zip == "-":
        archive = (stdin or sys.stdin.buffer).read(20 * 1024 * 1024 + 1)
    else:
        path = Path(args.source_zip)
        _private_tmpfs(path)
        with path.open("rb") as stream:
            archive = stream.read(20 * 1024 * 1024 + 1)
    files = parse_runtime_zip(archive)
    if set(files) != set(SOURCE_FILES):
        raise HandoffError("one original runtime without prior handoff required")
    identity = str(build_strategy_identity()["value"])
    universe = hash_symbol_universe(load_universe_symbols(held_symbols=[]))
    client = _get_client()
    manifest = build_manifest(
        files,
        archive_sha256=digest(archive),
        source_sha=args.source_sha,
        source_run_id=args.source_run_id,
        source_artifact_id=args.source_artifact_id,
        target_sha=args.target_sha,
        target_identity=identity,
        universe_sha=universe,
        account_sha256=account_digest(client.get_account().id),
    )
    original = validate_source(manifest, files)
    reconcile_broker(client, manifest, original, original)
    raw = serialize_manifest(manifest)
    descriptor = os.open(
        args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600
    )
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        args.output.unlink(missing_ok=True)
        raise
    return {
        "check": "prepare_paper_runtime_handoff",
        "result": "PASS",
        "manifest_sha256": digest(raw),
        "attempt_count": len(original["order_attempts"]),
        "target_count": len(original["target_weights"]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-zip", required=True, help="private tmpfs ZIP path, or - for stdin"
    )
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-run-id", required=True, type=int)
    parser.add_argument("--source-artifact-id", required=True, type=int)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = prepare(args)
    except Exception:  # noqa: BLE001 — never print private inputs or SDK exceptions
        print(json.dumps({"check": "prepare_paper_runtime_handoff", "result": "FAIL"}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    # The operating system must not spill a process memory snapshot to disk.
    import resource

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    raise SystemExit(main())
