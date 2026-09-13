"""Encrypt live state and capture live-step output before public artifact upload.

This module never prints decrypted state, broker responses, exception messages,
or child output. The command line deliberately accepts only fixed operations.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import resource
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

REPO_ROOT = Path(__file__).resolve().parents[1]
MAGIC = b"NATE-LIVE\x01"
NONCE_BYTES = 12
TAG_BYTES = 16
# Leave room for AES-GCM and the outer Actions ZIP inside its 20 MiB limit.
MAX_PLAINTEXT_BYTES = 19 * 1024 * 1024
MAX_RUNTIME_ENTRY_BYTES = 16 * 1024 * 1024
MAX_BLOB_BYTES = len(MAGIC) + NONCE_BYTES + MAX_PLAINTEXT_BYTES + TAG_BYTES
MAX_LOG_BYTES = 8 * 1024 * 1024
STEP_TIMEOUT_SECONDS = 45 * 60
SOURCE_FILES = ("performance.json", "positions.json", "production/last_run.json")
STEP_SCRIPTS = {
    "sanity": ("sanity_check.py",),
    "preflight": ("production_preflight.py",),
    "preview": ("execute_trades.py", "dry-run"),
    "execute": ("production_run.py",),
}
_COMMIT = re.compile(r"[0-9a-f]{40}\Z")
_KEY = re.compile(r"[0-9a-fA-F]{64}\Z")


class LiveRuntimeCryptoError(RuntimeError):
    """Only fixed reason codes, never data or caught exception messages."""


def _require(condition: object, reason: str) -> None:
    if not condition:
        raise LiveRuntimeCryptoError(reason)


def _key() -> bytes:
    value = os.environ.get("LIVE_RUNTIME_KEY", "")
    _require(_KEY.fullmatch(value), "invalid_runtime_key")
    return bytes.fromhex(value)


def _aad(release_sha: str, kind: str) -> bytes:
    _require(
        isinstance(release_sha, str) and _COMMIT.fullmatch(release_sha),
        "invalid_release",
    )
    _require(
        kind in {"runtime", "execution-receipt"}
        or kind in {"diagnostics/" + step for step in STEP_SCRIPTS},
        "invalid_kind",
    )
    return (
        b"nate-trader/live-artifact/v1\0"
        + kind.encode("ascii")
        + b"\0"
        + release_sha.encode("ascii")
    )


def _encrypt(raw: bytes, release_sha: str, kind: str) -> bytes:
    _require(
        isinstance(raw, bytes) and 0 < len(raw) <= MAX_PLAINTEXT_BYTES,
        "invalid_plaintext_size",
    )
    aad, key = _aad(release_sha, kind), _key()
    nonce = os.urandom(NONCE_BYTES)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, raw, aad)


def _decrypt(blob: bytes, release_sha: str, kind: str) -> bytes:
    _require(
        isinstance(blob, bytes)
        and len(MAGIC) + NONCE_BYTES + TAG_BYTES < len(blob) <= MAX_BLOB_BYTES,
        "invalid_ciphertext_size",
    )
    _require(blob.startswith(MAGIC), "invalid_ciphertext_version")
    aad, key = _aad(release_sha, kind), _key()
    nonce = blob[len(MAGIC) : len(MAGIC) + NONCE_BYTES]
    try:
        return AESGCM(key).decrypt(nonce, blob[len(MAGIC) + NONCE_BYTES :], aad)
    except InvalidTag:
        raise LiveRuntimeCryptoError("ciphertext_authentication_failed") from None


def encrypt_runtime_blob(zipbytes: bytes, release_sha: str) -> bytes:
    """Encrypt an in-memory live runtime ZIP with a release-bound AES-256 key."""
    return _encrypt(zipbytes, release_sha, "runtime")


def decrypt_runtime_blob(blob: bytes, release_sha: str) -> bytes:
    """Authenticate before returning any plaintext. No fallback or key guessing."""
    return _decrypt(blob, release_sha, "runtime")


def decrypt_step_diagnostics(blob: bytes, release_sha: str, step: str) -> bytes:
    """Explicit in-memory operator API; deliberately no plaintext CLI output."""
    _require(step in STEP_SCRIPTS, "invalid_step")
    return _decrypt(blob, release_sha, "diagnostics/" + step)


def _directory(root: Path, parts: tuple[str, ...], *, create: bool = False) -> int:
    """Walk using directory descriptors: neither parents nor leaves follow links."""
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts:
            _require(part not in {"", ".", ".."} and "/" not in part, "invalid_path")
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor
            )
            os.close(descriptor)
            descriptor = child
            if create:
                metadata = os.fstat(descriptor)
                _require(
                    metadata.st_uid == os.geteuid()
                    and stat.S_IMODE(metadata.st_mode) == 0o700,
                    "output_directory_not_private",
                )
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _read_regular(root: Path, relative: str) -> bytes:
    parts = tuple(relative.split("/"))
    parent = _directory(root, parts[:-1])
    try:
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent
        )
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            _require(
                stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                "input_not_regular",
            )
            _require(0 < before.st_size <= MAX_PLAINTEXT_BYTES, "input_size")
            raw = stream.read(MAX_PLAINTEXT_BYTES + 1)
            after = os.fstat(stream.fileno())
            fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
            _require(
                all(getattr(before, field) == getattr(after, field) for field in fields)
                and len(raw) == before.st_size,
                "input_changed",
            )
            return raw
    finally:
        os.close(parent)


def _output_directory(
    root: Path, step: str | None = None, *, receipt: bool = False
) -> tuple[int, str]:
    parts = ("live-private", "diagnostics") if step is not None else ("live-private",)
    parent = _directory(root, parts, create=True)
    name = (
        "execution-receipt.aesgcm"
        if receipt
        else step + ".aesgcm"
        if step is not None
        else "runtime.aesgcm"
    )
    try:
        try:
            os.stat(name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return parent, name
        raise LiveRuntimeCryptoError("output_already_exists")
    except BaseException:
        os.close(parent)
        raise


def _write_encrypted(parent: int, name: str, blob: bytes) -> None:
    temporary = ".encrypted-" + os.urandom(12).hex()
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=parent,
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        # Atomic publication without overwriting any prior artifact or symlink.
        os.link(
            temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False
        )
    finally:
        os.unlink(temporary, dir_fd=parent)


def _json_object(raw: bytes) -> dict:
    def pairs(items: list[tuple[str, object]]) -> dict:
        result: dict = {}
        for key, value in items:
            _require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    try:
        value = json.loads(
            raw,
            object_pairs_hook=pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
        )
    except (ValueError, UnicodeError, RecursionError):
        raise LiveRuntimeCryptoError("invalid_runtime_json") from None
    _require(isinstance(value, dict), "invalid_runtime_json")
    return value


def _validate_runtime(files: dict[str, bytes], release_sha: str) -> None:
    performance, positions, run = (_json_object(files[name]) for name in SOURCE_FILES)
    _require(
        isinstance(performance, dict) and isinstance(positions.get("positions"), list),
        "invalid_runtime_state",
    )
    _require(
        type(run.get("schema_version")) is int
        and run["schema_version"] == 1
        and run.get("kind") == "v11_live_production_run"
        and run.get("release_sha") == release_sha
        and run.get("paper_only") is False
        and run.get("broker_mode") == "live"
        and run.get("status") in {"PASS", "FAIL", "DEGRADED"},
        "invalid_runtime_lineage",
    )
    # The restore module owns the live account/capital binding contract. Its
    # verifier is also used here; a missing verifier fails before publication.
    from restore_live_runtime import Context, validate_runtime

    binding = _binding(performance, release_sha)
    validate_runtime(
        files,
        Context("local/runtime", release_sha, 1, "not-used"),
        binding["account_sha256"],
    )


def _timestamp(value: object) -> datetime:
    try:
        _require(isinstance(value, str), "invalid_timestamp")
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        _require(parsed.tzinfo is not None, "invalid_timestamp")
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise LiveRuntimeCryptoError("invalid_timestamp") from None


def _binding(performance: dict, release_sha: str) -> dict:
    value = performance.get("live_runtime_binding")
    _require(
        isinstance(value, dict)
        and set(value)
        == {
            "schema_version",
            "broker_mode",
            "account_sha256",
            "release_sha",
            "initialized_at",
        },
        "invalid_live_binding",
    )
    _require(
        type(value["schema_version"]) is int
        and value["schema_version"] == 1
        and value["broker_mode"] == "live"
        and value["release_sha"] == release_sha
        and isinstance(value["account_sha256"], str)
        and re.fullmatch(r"[0-9a-f]{64}", value["account_sha256"]),
        "invalid_live_binding",
    )
    _timestamp(value["initialized_at"])
    return value


def _current_run() -> tuple[int, int]:
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    _require(
        re.fullmatch(r"[1-9][0-9]{0,19}", run_id)
        and os.environ.get("GITHUB_RUN_ATTEMPT") == "1",
        "invalid_current_run",
    )
    return int(run_id), 1


def _require_live_transport() -> None:
    # Transport selection uses the same parser as the broker. Full credential,
    # spending and enablement checks belong to the actual child executor;
    # packing an already executed run needs only the encryption key.
    from broker_mode import LIVE, requested_mode

    _require(requested_mode() == LIVE, "live_mode_required")


def _runtime_files(root: Path) -> dict[str, bytes]:
    files = {name: _read_regular(root, "state/" + name) for name in SOURCE_FILES}
    _require(
        all(len(raw) <= MAX_RUNTIME_ENTRY_BYTES for raw in files.values())
        and sum(map(len, files.values())) <= MAX_PLAINTEXT_BYTES,
        "runtime_size",
    )
    return files


def _file_hashes(files: dict[str, bytes]) -> dict[str, str]:
    return {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}


def _execution_receipt(
    root: Path,
    release_sha: str,
    started: datetime,
    finished: datetime,
    prior_run: bytes | None,
    binding: dict,
) -> bytes:
    files = _runtime_files(root)
    _validate_runtime(files, release_sha)
    current = _json_object(files["production/last_run.json"])
    _require(
        files["production/last_run.json"] != prior_run
        and started <= _timestamp(current.get("completed_at")) <= finished,
        "current_execution_record_required",
    )
    _require(
        _binding(_json_object(files["performance.json"]), release_sha) == binding,
        "execution_binding_changed",
    )
    run_id, attempt = _current_run()
    receipt = {
        "schema_version": 1,
        "kind": "v11_live_execution_receipt",
        "release_sha": release_sha,
        "run_id": run_id,
        "run_attempt": attempt,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "files": _file_hashes(files),
    }
    return _encrypt(
        json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode(),
        release_sha,
        "execution-receipt",
    )


def _verify_execution_receipt(
    root: Path, release_sha: str, files: dict[str, bytes]
) -> None:
    raw = _read_regular(root, "live-private/execution-receipt.aesgcm")
    receipt = _json_object(_decrypt(raw, release_sha, "execution-receipt"))
    run_id, attempt = _current_run()
    _require(
        receipt.get("schema_version") == 1
        and receipt.get("kind") == "v11_live_execution_receipt"
        and receipt.get("release_sha") == release_sha
        and receipt.get("run_id") == run_id
        and receipt.get("run_attempt") == attempt
        and receipt.get("files") == _file_hashes(files),
        "execution_receipt_mismatch",
    )
    _require(
        _timestamp(receipt.get("started_at"))
        <= _timestamp(
            _json_object(files["production/last_run.json"]).get("completed_at")
        )
        <= _timestamp(receipt.get("finished_at")),
        "execution_receipt_timestamp",
    )


def pack_runtime(root: Path, release_sha: str) -> None:
    _aad(release_sha, "runtime")
    _key()
    _require_live_transport()
    parent, name = _output_directory(root)
    try:
        files = _runtime_files(root)
        _validate_runtime(files, release_sha)
        _verify_execution_receipt(root, release_sha, files)
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as zipped:
            for filename in SOURCE_FILES:
                entry = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | 0o600) << 16
                zipped.writestr(entry, files[filename])
        _write_encrypted(
            parent, name, encrypt_runtime_blob(archive.getvalue(), release_sha)
        )
    finally:
        os.close(parent)


class _Interrupted(BaseException):
    def __init__(self, signum: int):
        self.signum = signum


def _stop_child(child: subprocess.Popen) -> None:
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        except ProcessLookupError:
            child.wait(timeout=2)
    # Descendants can retain stdout after their direct parent exits. They share
    # this dedicated child session, never the workflow runner's process group.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _exit_code(code: int | None) -> int:
    return 1 if code is None else 128 - code if code < 0 else code


def run_step(root: Path, step: str, release_sha: str) -> int:
    _require(step in STEP_SCRIPTS, "invalid_step")
    _aad(release_sha, "diagnostics/" + step)
    _key()  # Refuse missing encryption before any potentially mutating child.
    _require_live_transport()
    script, *arguments = STEP_SCRIPTS[step]
    _read_regular(root, "scripts/" + script)
    parent, name = _output_directory(root, step)
    receipt_parent = None
    child: subprocess.Popen | None = None
    exit_code, capture_status = 1, "capture_failed"
    try:
        binding, prior_run = None, None
        if step == "execute":
            _current_run()
            binding = _binding(
                _json_object(_read_regular(root, "state/performance.json")), release_sha
            )
            try:
                prior_run = _read_regular(root, "state/production/last_run.json")
            except FileNotFoundError:
                pass
            receipt_parent, receipt_name = _output_directory(root, receipt=True)
        with tempfile.TemporaryDirectory(prefix=".live-capture-", dir=root) as scratch:
            log_path = Path(scratch) / "step.log"
            descriptor = os.open(
                log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
            with os.fdopen(descriptor, "wb") as log:
                env = {
                    key: value
                    for key, value in os.environ.items()
                    if key not in {"LIVE_RUNTIME_KEY", "PYTHONPATH", "PYTHONSTARTUP"}
                }
                env.update(
                    PYTHONDONTWRITEBYTECODE="1",
                    PYTHONUNBUFFERED="1",
                    PYTHON_DOTENV_DISABLED="1",
                )
                started = datetime.now(timezone.utc)
                child = subprocess.Popen(
                    [sys.executable, "-u", str(root / "scripts" / script), *arguments],
                    cwd=root,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                deadline = time.monotonic() + STEP_TIMEOUT_SECONDS
                size = 0
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(child.stdout, selectors.EVENT_READ)
                        while True:
                            _require(time.monotonic() < deadline, "step_timeout")
                            if not selector.select(timeout=0.2):
                                continue
                            chunk = os.read(child.stdout.fileno(), 65536)
                            if not chunk:
                                break
                            _require(
                                size + len(chunk) <= MAX_LOG_BYTES, "step_output_limit"
                            )
                            log.write(chunk)
                            size += len(chunk)
                    child.wait(timeout=max(0.1, deadline - time.monotonic()))
                    exit_code, capture_status = _exit_code(child.returncode), "complete"
                except _Interrupted as interrupted:
                    exit_code, capture_status = 128 + interrupted.signum, "interrupted"
                except (LiveRuntimeCryptoError, subprocess.TimeoutExpired):
                    capture_status = "bounded_capture_failed"
                finally:
                    _stop_child(child)
                    if capture_status != "complete" and child.returncode:
                        exit_code = _exit_code(child.returncode)
                    child.stdout.close()
            if step == "execute":
                try:
                    receipt = _execution_receipt(
                        root,
                        release_sha,
                        started,
                        datetime.now(timezone.utc),
                        prior_run,
                        binding,
                    )
                    _write_encrypted(receipt_parent, receipt_name, receipt)
                except Exception:  # noqa: BLE001 — private failure, preserve child exit
                    capture_status = "execution_receipt_failed"
                    exit_code = exit_code or 1
            diagnostic = json.dumps(
                {
                    "schema_version": 1,
                    "kind": "v11_live_step_diagnostics",
                    "release_sha": release_sha,
                    "step": step,
                    "exit_code": exit_code,
                    "capture_status": capture_status,
                    "output_base64": base64.b64encode(log_path.read_bytes()).decode(
                        "ascii"
                    ),
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            try:
                _write_encrypted(
                    parent,
                    name,
                    _encrypt(diagnostic, release_sha, "diagnostics/" + step),
                )
            except Exception:  # noqa: BLE001 — publication failure cannot expose logs
                exit_code = exit_code or 1
        return exit_code
    finally:
        if child is not None:
            _stop_child(child)
        if receipt_parent is not None:
            os.close(receipt_parent)
        os.close(parent)


def main(argv: list[str] | None = None) -> int:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    arguments = list(sys.argv[1:] if argv is None else argv)
    operation, step, code = "invalid", None, 1
    previous = {}

    def interrupted(signum: int, _frame: object) -> None:
        raise _Interrupted(signum)

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, interrupted)
        release_sha = os.environ.get("APPROVED_RELEASE_SHA", "")
        if arguments == ["pack-runtime"]:
            operation = "pack-runtime"
            pack_runtime(REPO_ROOT, release_sha)
            code = 0
        elif (
            len(arguments) == 2
            and arguments[0] == "run-step"
            and arguments[1] in STEP_SCRIPTS
        ):
            operation, step = "run-step", arguments[1]
            code = run_step(REPO_ROOT, step, release_sha)
    except _Interrupted as error:
        code = 128 + error.signum
    except BaseException:  # noqa: BLE001 — final public-output privacy boundary
        # Even OS/library errors may interpolate sensitive paths or buffers.
        # The private encrypted diagnostic is the only place child text goes.
        code = 1
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    summary = {
        "operation": operation,
        "status": "PASS" if code == 0 else "FAIL",
        "exit_code": code,
    }
    if step is not None:
        summary["step"] = step
    print(json.dumps(summary, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
