#!/usr/bin/env python3
"""Retain private upgrade evidence without persistent plaintext or DB access.

Run send under a user systemd scope with MemorySwapMax=0. Copy this source to
the authorized host first. Receive runs as root in its own no-swap scope and
uses only the existing backup key and remotes. Neither mode cleans up clones.
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import hashlib
import io
import json
import mmap
import os
import re
import resource
import shlex
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

KEY = Path("/srv/homelab/secrets/nt-v2-db-key.txt")
RCLONE = "/srv/homelab/secrets/rclone.conf"
REMOTES = ("r2:homelab-backups", "r2dr:homelab-backups-dr")
LIMIT = 64 * 1024 * 1024
BINDINGS = "_RETENTION_BINDINGS.json"
REQUIRED = {"production.sql", "production-manifest.json", "production-evidence.json",
            "production-final.json", "final-catalog.json", "production-inspection.jsonl",
            "rehearsal-evidence.json", "rehearsal-checks.json", "review.json"}


class Failure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Failure(code)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def locked_read(path, before):
    """Pin existing source pages while copying into the no-swap process.

    The source filesystem predates this operation and may permit swapping.
    This does not attest how those files were stored before capture.
    """
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        require(identity(os.fstat(fd)) == identity(before), "source_identity_changed")
        if not before.st_size:
            return b""
        with mmap.mmap(fd, 0, access=mmap.ACCESS_COPY) as mapped:
            address = ctypes.addressof(ctypes.c_char.from_buffer(mapped))
            libc = ctypes.CDLL(None, use_errno=True)
            libc.mlock.argtypes = libc.munlock.argtypes = (ctypes.c_void_p, ctypes.c_size_t)
            require(libc.mlock(address, len(mapped)) == 0, "source_memory_lock_failed")
            try:
                return bytes(mapped)
            finally:
                libc.munlock(address, len(mapped))
    finally:
        os.close(fd)


def no_swap():
    group = next((v.split(":", 2)[2] for v in Path("/proc/self/cgroup").read_text().splitlines()
                  if v.startswith("0::")), None)
    require(group is not None and (Path("/sys/fs/cgroup") / group.lstrip("/") /
                                  "memory.swap.max").read_text().strip() == "0",
            "process_swap_not_disabled")


def validate(files, expected):
    require(REQUIRED <= files.keys(), "required_evidence_missing")
    manifest = json.loads(files["production-manifest.json"])
    core = {k: v for k, v in manifest.items() if k not in ("manifest_sha256", "bundle_sha256")}
    require(sha(canonical(core)) == manifest["manifest_sha256"] == expected["manifest"],
            "production_manifest_binding_mismatch")
    require(sha(files["production.sql"]) == manifest["bundle_sha256"] == expected["bundle"],
            "production_bundle_binding_mismatch")
    event = json.loads(files["production-evidence.json"])
    require(event["status"] == "COMMITTED" and event["exit_code"] == 0 and
            event["bundle_sha256"] == expected["bundle"], "production_not_committed")
    catalogs = [json.loads(files[name]) for name in ("final-catalog.json", "production-final.json")]
    for value in catalogs:
        require(sha(canonical(value["catalog"])) == value["catalog_sha256"] == expected["catalog"],
                "final_catalog_binding_mismatch")
    require(catalogs[0]["catalog"] == catalogs[1]["catalog"], "production_rehearsal_catalog_mismatch")
    require(sha(canonical(catalogs[0]["catalog"]["objects"])) == manifest["final_objects_sha256"],
            "final_object_binding_mismatch")
    return {"status": "COMMITTED", "completed_at": event["completed_at"],
            "catalog_objects": len(catalogs[0]["catalog"]["objects"]), **expected}


def unpack(payload, expected):
    files = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
        total = 0
        for entry in archive:
            require(entry.isfile() and re.fullmatch(r"[A-Za-z0-9_.-]+", entry.name) and
                    entry.name not in files and entry.size >= 0, "unsafe_archive_entry")
            total += entry.size
            require(total <= LIMIT, "archive_expansion_limit")
            files[entry.name] = archive.extractfile(entry).read()
    require(BINDINGS in files, "archive_bindings_missing")
    binding = json.loads(files.pop(BINDINGS))
    require(binding["expected"] == expected, "archive_expectation_mismatch")
    actual = {name: {"sha256": sha(data), "bytes": len(data)} for name, data in files.items()}
    require(actual == binding["files"], "archive_file_binding_mismatch")
    return validate(files, expected), len(files)


def pack(directory, expected):
    require(directory.is_dir() and not directory.is_symlink() and
            directory.stat().st_mode & 0o077 == 0, "source_directory_not_private")
    entries = sorted(directory.iterdir())
    files, identities = {}, {}
    for path in entries:
        before = path.lstat()
        require(stat.S_ISREG(before.st_mode) and re.fullmatch(r"[A-Za-z0-9_.-]+", path.name) and
                path.name != BINDINGS and before.st_size <= LIMIT, "unsafe_source_entry")
        files[path.name] = locked_read(path, before)
        require(identity(before) == identity(path.lstat()), "source_changed_during_read")
        identities[path.name] = identity(before)
    require(sum(map(len, files.values())) < LIMIT - 1024 * 1024, "source_size_limit")
    validate(files, expected)
    require(entries == sorted(directory.iterdir()) and
            all(identity(path.lstat()) == identities[path.name] for path in entries), "source_changed_during_capture")
    files[BINDINGS] = canonical({"expected": expected, "files": {
        name: {"sha256": sha(data), "bytes": len(data)} for name, data in files.items()}})
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:") as archive:
        for name, data in sorted(files.items()):
            entry = tarfile.TarInfo(name)
            entry.size, entry.mode = len(data), 0o600
            archive.addfile(entry, io.BytesIO(data))
    payload = output.getvalue()
    unpack(payload, expected)
    return payload


class Receiver:
    def __init__(self, args):
        self.args = args
        self.work = Path("/run") / args.set_id
        self.durable = Path("/var/lib/homelab/nate-trader/deployment-evidence") / args.set_id
        self.env = dict(os.environ)
        self.seq = 0

    def run(self, label, args, *, output=None, allowed=(0,)):
        self.seq += 1
        with (self.work / f"diagnostic-{self.seq}.txt").open("wb") as err:
            if output is None:
                result = subprocess.run(args, stdout=subprocess.PIPE, stderr=err, env=self.env, timeout=180, check=False)
            else:
                with output.open("wb") as target:
                    result = subprocess.run(args, stdout=target, stderr=err, env=self.env, timeout=180, check=False)
        require(result.returncode in allowed, f"{label}_failed_{self.seq}")
        return result

    def gpg(self, source, destination, *, decrypt=False, allowed=(0,)):
        args = ["gpg", "--batch", "--yes", "--quiet", "--no-tty", "--pinentry-mode", "loopback",
                "--no-symkey-cache", "--passphrase-file", str(KEY), "-o", str(destination)]
        if decrypt:
            args += ["--decrypt", str(source)]
        else:
            args += ["--symmetric", "--cipher-algo", "AES256", "--force-ocb", "--s2k-mode", "3",
                     "--s2k-digest-algo", "SHA512", "--s2k-count", "65011712", str(source)]
        return self.run("gpg", args, allowed=allowed)

    def public_file(self, name, value):
        path = self.durable / name
        with path.open("xb") as target:
            target.write(canonical(value) + b"\n")
            target.flush()
            os.fsync(target.fileno())
        return path

    def execute(self):
        require(os.geteuid() == 0, "receiver_requires_root")
        require(KEY.is_file() and not KEY.is_symlink() and KEY.stat().st_mode & 0o777 == 0o600,
                "backup_key_not_private")
        require(sha(Path(__file__).read_bytes()) == self.args.source_sha, "receiver_source_mismatch")
        self.work.mkdir(mode=0o700)
        mounted = subprocess.run(["mount", "-t", "tmpfs", "-o",
                                  "size=128M,mode=0700,noswap,nosuid,nodev", "tmpfs", str(self.work)],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        require(mounted.returncode == 0, "noswap_mount_failed")
        mount = self.run("mount_check", ["findmnt", "-n", "-o", "FSTYPE,OPTIONS", "-T", str(self.work)]).stdout.decode().strip()
        require(mount.startswith("tmpfs ") and "noswap" in mount.split(","), "noswap_mount_not_verified")
        (self.work / "gnupg").mkdir(mode=0o700)
        self.env.update(GNUPGHOME=str(self.work / "gnupg"), TMPDIR=str(self.work))
        require(b"--force-ocb" in self.run("gpg_capability", ["gpg", "--dump-options"]).stdout,
                "gpg_ocb_unavailable")
        payload = sys.stdin.buffer.read(LIMIT + 1)
        require(0 < len(payload) <= LIMIT, "input_size_limit")
        bindings, count = unpack(payload, self.args.expected)
        source = self.work / "evidence.tar"
        source.write_bytes(payload)
        self.durable.mkdir(parents=True, mode=0o700)
        encrypted = self.durable / "evidence.tar.gpg"
        self.gpg(source, encrypted)
        with encrypted.open("rb") as cipher:
            header = cipher.read(2)
            require(len(header) == 2 and header[0] == 0x8C, "ocb_key_header_missing")
            cipher.seek(2 + header[1])
            require(cipher.read(1) == b"\xd4", "ocb_data_header_missing")
        decrypted = self.work / "authenticated.tar"
        self.gpg(encrypted, decrypted, decrypt=True)
        require(decrypted.read_bytes() == payload, "authenticated_roundtrip_mismatch")
        unpack(decrypted.read_bytes(), self.args.expected)
        corrupt = self.work / "corrupt.gpg"
        damaged = bytearray(encrypted.read_bytes())
        damaged[-8] ^= 1
        corrupt.write_bytes(damaged)
        negative = self.work / "unauthenticated.tar"
        result = self.gpg(corrupt, negative, decrypt=True, allowed=(0, 2))
        negative.unlink(missing_ok=True)
        require(result.returncode == 2, "corrupt_tag_not_rejected")
        with encrypted.open("rb") as target:
            os.fsync(target.fileno())
        source_copy = self.durable / Path(__file__).name
        source_copy.write_bytes(Path(__file__).read_bytes())
        with source_copy.open("rb") as target:
            os.fsync(target.fileno())
        prefix = "natetrader-deployment-evidence-v1/" + self.args.set_id
        manifest = self.public_file("MANIFEST.json", {
            "schema_version": 1, "set_id": self.args.set_id, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "cipher": "AES256-OCB", "key_file_role": "existing_nt_v2_db_backup_key",
            "ciphertext_sha256": sha(encrypted.read_bytes()), "ciphertext_bytes": encrypted.stat().st_size,
            "plaintext_archive_sha256": sha(payload), "plaintext_archive_bytes": len(payload),
            "source_sha256": self.args.source_sha, "private_file_count": count,
            "production": bindings, "remote_prefix": prefix,
            "runtime_metadata_provenance": "operator_asserted_release_and_image; not queried by this tool",
            "checks": {"authenticated_roundtrip": True, "corrupt_tag_rejected": True,
                       "private_file_bindings": True, "source_pages_locked_during_capture": True,
                       "receive_tmpfs_noswap": True, "process_swap_disabled": True, "core_dumps_disabled": True}})
        rc = ["rclone", "--config", RCLONE, "--retries", "2", "--low-level-retries", "3",
              "--contimeout", "15s", "--timeout", "60s"]
        files = (encrypted, source_copy, manifest)
        for index, remote in enumerate(REMOTES):
            for path in files:
                dest = remote + "/" + prefix + "/" + path.name
                self.run("upload", rc + ["copyto", str(path), dest + ".part", "-q"])
                downloaded = self.work / "remote-download"
                self.run("download_part", rc + ["cat", dest + ".part"], output=downloaded)
                require(downloaded.read_bytes() == path.read_bytes(), "remote_part_mismatch")
                self.run("promote", rc + ["moveto", dest + ".part", dest, "-q"])
                self.run("download_final", rc + ["cat", dest], output=downloaded)
                require(downloaded.read_bytes() == path.read_bytes(), "remote_final_mismatch")
            print(json.dumps({"event": "remote_verified", "remote_index": index}), flush=True)
        marker = self.public_file("COMPLETE", {"set_id": self.args.set_id,
            "manifest_sha256": sha(manifest.read_bytes()), "verified_remote_copies": len(REMOTES)})
        for remote in REMOTES:
            dest = remote + "/" + prefix + "/COMPLETE"
            self.run("complete_upload", rc + ["copyto", str(marker), dest, "-q"])
            downloaded = self.work / "remote-marker"
            self.run("complete_verify", rc + ["cat", dest], output=downloaded)
            require(downloaded.read_bytes() == marker.read_bytes(), "remote_complete_mismatch")
        directory_fd = os.open(self.durable, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        print(json.dumps({"event": "retention_complete", "set_id": self.args.set_id,
            "durable": str(self.durable), "private_tmpfs": str(self.work), "remote_prefix": prefix,
            "manifest_sha256": sha(manifest.read_bytes()), "ciphertext_sha256": sha(encrypted.read_bytes()),
            "complete_sha256": sha(marker.read_bytes()), "verified_remote_copies": len(REMOTES),
            "private_file_count": count}), flush=True)


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("send", "receive"))
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--remote-source", default="/run/nate-recovery-orchestrator-20260913/retain_deployment_evidence.py")
    parser.add_argument("--set-id", required=True)
    parser.add_argument("--source-sha")
    for name in ("bundle", "manifest", "catalog", "release", "image"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    require(re.fullmatch(r"nt-deployment-evidence-\d{8}T\d{6}Z", args.set_id), "unsafe_set_id")
    args.expected = {name: getattr(args, name) for name in ("bundle", "manifest", "catalog", "release", "image")}
    for name in ("bundle", "manifest", "catalog", "image"):
        require(re.fullmatch(r"[a-f0-9]{64}", args.expected[name]), "invalid_expected_digest")
    require(re.fullmatch(r"[a-f0-9]{40}", args.release), "invalid_release")
    no_swap()
    if args.mode == "receive":
        Receiver(args).execute()
        return
    require(args.directory is not None, "source_directory_required")
    payload = pack(args.directory, args.expected)
    command = ["sudo", "-n", "systemd-run", "--scope", "--quiet", "--property=MemorySwapMax=0",
               "python3", args.remote_source, "receive", "--set-id", args.set_id,
               "--source-sha", sha(Path(__file__).read_bytes())]
    for key, value in args.expected.items():
        command += ["--" + key, value]
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o",
                             "StrictHostKeyChecking=yes", "homelab", shlex.join(command)],
                            input=payload, capture_output=True, timeout=900, check=False)
    require(result.returncode == 0, "remote_retention_failed")
    events = [json.loads(line) for line in result.stdout.decode().splitlines()]
    require(events and events[-1].get("event") == "retention_complete", "completion_missing")
    for event in events:
        print(json.dumps(event))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - Do not emit private payloads from exceptions.
        code = str(exc) if isinstance(exc, Failure) else type(exc).__name__
        print(json.dumps({"event": "retention_failed", "code": code}), file=sys.stderr)
        raise SystemExit(1) from None
