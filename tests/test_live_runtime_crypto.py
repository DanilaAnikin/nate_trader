"""No network/broker calls: authenticated encryption and actual child isolation."""

import base64
import io
import json
import os
import stat
import subprocess
import sys
import zipfile
from pathlib import Path

import live_runtime_crypto as crypto
import pytest

SHA = "b" * 40
KEY = "ab" * 32
SECRET = "synthetic-private-account-output-canary"


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("LIVE_RUNTIME_KEY", KEY)
    monkeypatch.setenv("APPROVED_RELEASE_SHA", SHA)
    monkeypatch.setenv("TRADING_MODE", "live")
    monkeypatch.setenv("GITHUB_RUN_ID", "12345")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    monkeypatch.setattr(crypto, "REPO_ROOT", tmp_path)
    (tmp_path / "scripts").mkdir()
    (tmp_path / "state/production").mkdir(parents=True)
    performance = {
        "equity": 1000.0,
        "live_runtime_binding": {
            "schema_version": 1,
            "broker_mode": "live",
            "account_sha256": "a" * 64,
            "release_sha": SHA,
            "initialized_at": "2026-09-13T00:00:00Z",
        },
    }
    (tmp_path / "state/performance.json").write_text(json.dumps(performance))
    (tmp_path / "state/positions.json").write_text('{"positions":[]}')
    (tmp_path / "state/production/last_run.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "kind": "v11_live_production_run",
                "paper_only": False,
                "broker_mode": "live",
                "status": "PASS",
                "release_sha": SHA,
                "completed_at": "2026-09-13T00:00:00Z",
            }
        )
    )
    for step, (filename, *_) in crypto.STEP_SCRIPTS.items():
        body = (
            "import os,sys\nprint('"
            + SECRET
            + "')\nprint('stderr-canary',file=sys.stderr)\nprint('key_absent', 'LIVE_RUNTIME_KEY' not in os.environ)\n"
        )
        if step == "execute":
            body += (
                "import json\nfrom pathlib import Path\nfrom datetime import datetime,timezone\n"
                "path=Path('state/production/last_run.json')\n"
                "run=json.loads(path.read_text())\n"
                "run['completed_at']=datetime.now(timezone.utc).isoformat()\n"
                "path.write_text(json.dumps(run))\n"
            )
        (tmp_path / "scripts" / filename).write_text(body)
    return tmp_path


def diagnostic(root, step):
    blob = (root / "live-private/diagnostics" / (step + ".aesgcm")).read_bytes()
    return json.loads(crypto.decrypt_step_diagnostics(blob, SHA, step))


def test_encryption_random_nonce_roundtrip_and_no_cleartext(runtime):
    first = crypto.encrypt_runtime_blob(SECRET.encode(), SHA)
    second = crypto.encrypt_runtime_blob(SECRET.encode(), SHA)
    assert first != second
    assert first.startswith(crypto.MAGIC)
    assert SECRET.encode() not in first
    assert crypto.decrypt_runtime_blob(first, SHA) == SECRET.encode()
    assert crypto.decrypt_runtime_blob(second, SHA) == SECRET.encode()


@pytest.mark.parametrize("offset", [0, len(crypto.MAGIC), -1])
def test_tamper_is_authenticated_before_plaintext(runtime, offset):
    blob = bytearray(crypto.encrypt_runtime_blob(SECRET.encode(), SHA))
    blob[offset] ^= 1
    with pytest.raises(crypto.LiveRuntimeCryptoError) as error:
        crypto.decrypt_runtime_blob(bytes(blob), SHA)
    assert SECRET not in str(error.value)


def test_wrong_key_release_and_artifact_kind_refused(runtime, monkeypatch):
    blob = crypto.encrypt_runtime_blob(SECRET.encode(), SHA)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="authentication_failed"):
        crypto.decrypt_runtime_blob(blob, "c" * 40)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="authentication_failed"):
        crypto.decrypt_step_diagnostics(blob, SHA, "execute")
    monkeypatch.setenv("LIVE_RUNTIME_KEY", "cd" * 32)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="authentication_failed"):
        crypto.decrypt_runtime_blob(blob, SHA)


@pytest.mark.parametrize("key", ["", "a" * 63, "g" * 64, KEY + "\n", " " + KEY])
def test_key_requires_exact_256_bits(runtime, monkeypatch, key):
    monkeypatch.setenv("LIVE_RUNTIME_KEY", key)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="invalid_runtime_key"):
        crypto.encrypt_runtime_blob(b"zip", SHA)


def test_encryption_size_and_release_are_bounded(runtime, monkeypatch):
    monkeypatch.setattr(crypto, "MAX_PLAINTEXT_BYTES", 10)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="plaintext_size"):
        crypto.encrypt_runtime_blob(b"x" * 11, SHA)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="invalid_release"):
        crypto.encrypt_runtime_blob(b"zip", SECRET)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="ciphertext_size"):
        crypto.decrypt_runtime_blob(b"", SHA)
    monkeypatch.setattr(crypto, "MAX_BLOB_BYTES", 30)
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="ciphertext_size"):
        crypto.decrypt_runtime_blob(b"x" * 31, SHA)


@pytest.mark.parametrize("step", ["sanity", "preflight", "preview", "execute"])
def test_step_captures_all_output_and_only_publishes_ciphertext(runtime, capsys, step):
    assert crypto.main(["run-step", step]) == 0
    captured = capsys.readouterr()
    assert captured.err == ""
    assert json.loads(captured.out) == {
        "operation": "run-step",
        "step": step,
        "status": "PASS",
        "exit_code": 0,
    }
    assert SECRET not in captured.out
    result = diagnostic(runtime, step)
    text = base64.b64decode(result["output_base64"]).decode()
    assert SECRET in text and "stderr-canary" in text and "key_absent True" in text
    assert result["exit_code"] == 0 and result["capture_status"] == "complete"
    assert not list(runtime.glob(".live-capture-*"))
    for path in (runtime / "live-private").rglob("*"):
        assert stat.S_IMODE(path.stat().st_mode) == (0o700 if path.is_dir() else 0o600)
        if path.is_file():
            assert path.suffix == ".aesgcm" and SECRET.encode() not in path.read_bytes()


def test_nonzero_child_exit_preserved_and_private(runtime, capsys):
    with (runtime / "scripts/sanity_check.py").open("a") as stream:
        stream.write("raise SystemExit(37)\n")
    assert crypto.main(["run-step", "sanity"]) == 37
    result = diagnostic(runtime, "sanity")
    assert result["exit_code"] == 37
    assert SECRET not in capsys.readouterr().out


def test_pack_runtime_requires_actual_current_execution_and_preserves_three_files(
    runtime, capsys
):
    assert crypto.main(["run-step", "execute"]) == 0
    original = {
        name: (runtime / "state" / name).read_bytes() for name in crypto.SOURCE_FILES
    }
    assert crypto.main(["pack-runtime"]) == 0
    output = runtime / "live-private/runtime.aesgcm"
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    clear = crypto.decrypt_runtime_blob(output.read_bytes(), SHA)
    with zipfile.ZipFile(io.BytesIO(clear)) as zipped:
        assert zipped.namelist() == list(crypto.SOURCE_FILES)
        for member in zipped.infolist():
            assert zipped.read(member) == original[member.filename]
            assert stat.S_ISREG(member.external_attr >> 16)
    assert not list(runtime.rglob("*.zip"))
    assert SECRET not in capsys.readouterr().out


def test_pack_cannot_relabel_old_last_run_after_child_failure(runtime, capsys):
    (runtime / "scripts/production_run.py").write_text(
        "print('" + SECRET + "')\nraise SystemExit(42)\n"
    )
    assert crypto.main(["run-step", "execute"]) == 42
    assert not (runtime / "live-private/execution-receipt.aesgcm").exists()
    assert crypto.main(["pack-runtime"]) == 1
    assert not (runtime / "live-private/runtime.aesgcm").exists()
    assert SECRET not in capsys.readouterr().out


def test_missing_key_refuses_before_child_and_cannot_pack_seed(
    runtime, monkeypatch, capsys
):
    old = (runtime / "state/production/last_run.json").read_bytes()
    monkeypatch.delenv("LIVE_RUNTIME_KEY")
    assert crypto.main(["run-step", "execute"]) == 1
    assert (runtime / "state/production/last_run.json").read_bytes() == old
    monkeypatch.setenv("LIVE_RUNTIME_KEY", KEY)
    assert crypto.main(["pack-runtime"]) == 1
    assert not (runtime / "live-private/runtime.aesgcm").exists()
    assert SECRET not in capsys.readouterr().out


@pytest.mark.parametrize(
    "mutation", ["run_id", "attempt", "state", "binding", "mode", "record"]
)
def test_pack_refuses_changed_run_state_or_binding(runtime, monkeypatch, mutation):
    assert crypto.run_step(runtime, "execute", SHA) == 0
    if mutation == "run_id":
        monkeypatch.setenv("GITHUB_RUN_ID", "67890")
    elif mutation == "attempt":
        monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "2")
    elif mutation == "mode":
        monkeypatch.setenv("TRADING_MODE", "paper")
    elif mutation == "record":
        path = runtime / "state/production/last_run.json"
        data = json.loads(path.read_text())
        data.update(paper_only=True, broker_mode="paper")
        path.write_text(json.dumps(data))
    else:
        path = runtime / "state/performance.json"
        data = json.loads(path.read_text())
        if mutation == "state":
            data["equity"] += 1
        else:
            data["live_runtime_binding"]["account_sha256"] = "f" * 64
        path.write_text(json.dumps(data))
    with pytest.raises(crypto.LiveRuntimeCryptoError):
        crypto.pack_runtime(runtime, SHA)
    assert not (runtime / "live-private/runtime.aesgcm").exists()


@pytest.mark.parametrize(
    "path", ["state/performance.json", "state/production", "live-private"]
)
def test_path_guards_refuse_symlink_files_and_directories(runtime, tmp_path, path):
    selected = runtime / path
    target = tmp_path / "elsewhere"
    if selected.exists():
        selected.rename(target)
    else:
        target.mkdir()
    selected.symlink_to(target, target_is_directory=target.is_dir())
    assert crypto.main(["run-step", "execute"]) == 1
    assert not (runtime / "live-private/execution-receipt.aesgcm").exists()


def test_output_is_exclusive_and_cannot_rerun_execute(runtime):
    assert crypto.run_step(runtime, "execute", SHA) == 0
    last_run = (runtime / "state/production/last_run.json").read_bytes()
    with pytest.raises(crypto.LiveRuntimeCryptoError, match="output_already_exists"):
        crypto.run_step(runtime, "execute", SHA)
    assert (runtime / "state/production/last_run.json").read_bytes() == last_run


def test_oversize_child_output_fails_closed_and_cleans_plaintext(
    runtime, monkeypatch, capsys
):
    monkeypatch.setattr(crypto, "MAX_LOG_BYTES", 32)
    (runtime / "scripts/sanity_check.py").write_text("print('" + SECRET + "' * 100)\n")
    assert crypto.main(["run-step", "sanity"]) != 0
    result = diagnostic(runtime, "sanity")
    assert result["capture_status"] == "bounded_capture_failed"
    assert len(base64.b64decode(result["output_base64"])) <= 32
    assert not list(runtime.glob(".live-capture-*"))
    assert SECRET not in capsys.readouterr().out


def test_step_timeout_terminates_child_without_output_leak(
    runtime, monkeypatch, capsys
):
    monkeypatch.setattr(crypto, "STEP_TIMEOUT_SECONDS", 0.03)
    (runtime / "scripts/sanity_check.py").write_text("import time\ntime.sleep(10)\n")
    assert crypto.main(["run-step", "sanity"]) != 0
    assert diagnostic(runtime, "sanity")["capture_status"] == "bounded_capture_failed"
    assert not list(runtime.glob(".live-capture-*"))
    assert capsys.readouterr().err == ""


def test_invalid_arguments_and_os_errors_never_echo_private_values(
    runtime, monkeypatch, capsys
):
    assert crypto.main(["run-step", SECRET]) == 1
    monkeypatch.setattr(
        crypto, "pack_runtime", lambda *args: (_ for _ in ()).throw(OSError(SECRET))
    )
    assert crypto.main(["pack-runtime"]) == 1
    output = capsys.readouterr()
    assert output.err == "" and SECRET not in output.out
    assert all(json.loads(line)["status"] == "FAIL" for line in output.out.splitlines())


def test_diagnostic_write_failure_preserves_known_child_exit(runtime, monkeypatch):
    (runtime / "scripts/sanity_check.py").write_text("raise SystemExit(37)\n")
    monkeypatch.setattr(
        crypto, "_write_encrypted", lambda *args: (_ for _ in ()).throw(OSError(SECRET))
    )
    assert crypto.main(["run-step", "sanity"]) == 37
    assert not list(runtime.glob(".live-capture-*"))


def test_failed_actual_live_run_is_still_preserved(runtime):
    with (runtime / "scripts/production_run.py").open("a") as stream:
        stream.write(
            "run['status']='FAIL'\npath.write_text(json.dumps(run))\nraise SystemExit(17)\n"
        )
    assert crypto.run_step(runtime, "execute", SHA) == 17
    crypto.pack_runtime(runtime, SHA)
    clear = crypto.decrypt_runtime_blob(
        (runtime / "live-private/runtime.aesgcm").read_bytes(), SHA
    )
    with zipfile.ZipFile(io.BytesIO(clear)) as zipped:
        assert json.loads(zipped.read("production/last_run.json"))["status"] == "FAIL"


@pytest.mark.parametrize("timestamp", ["2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"])
def test_execute_cannot_claim_old_or_future_timestamp(runtime, timestamp):
    with (runtime / "scripts/production_run.py").open("a") as stream:
        stream.write(
            "run['completed_at']='"
            + timestamp
            + "'\npath.write_text(json.dumps(run))\n"
        )
    assert crypto.run_step(runtime, "execute", SHA) == 1
    assert not (runtime / "live-private/execution-receipt.aesgcm").exists()


def test_sigterm_cleans_capture_and_emits_only_fixed_failure(runtime):
    (runtime / "scripts/sanity_check.py").write_text(
        "import os,signal,time\nprint('" + SECRET + "',flush=True)\n"
        "os.kill(os.getppid(),signal.SIGTERM)\ntime.sleep(10)\n"
    )
    launcher = (
        "import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\n"
        "import live_runtime_crypto as c\nc.REPO_ROOT=Path(sys.argv[2])\n"
        "raise SystemExit(c.main(['run-step','sanity']))\n"
    )
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            launcher,
            str(Path(crypto.__file__).parent),
            str(runtime),
        ],
        capture_output=True,
        timeout=5,
        env=dict(os.environ),
        check=False,
    )
    assert result.returncode == 143
    assert result.stderr == b"" and SECRET.encode() not in result.stdout
    assert json.loads(result.stdout)["exit_code"] == 143
    assert diagnostic(runtime, "sanity")["capture_status"] == "interrupted"
    assert not list(runtime.glob(".live-capture-*"))


def test_hardlinked_state_and_public_output_directory_are_refused(runtime):
    os.link(runtime / "state/performance.json", runtime / "hardlink")
    assert crypto.main(["run-step", "execute"]) == 1
    (runtime / "hardlink").unlink()
    (runtime / "live-private").chmod(0o755)
    assert crypto.main(["run-step", "execute"]) == 1
