"""Publication faults cannot turn mixed/stale runtime bytes into a healthy cycle."""

from __future__ import annotations

import copy
import json
import os

import pytest
import runtime_generation as generation

RELEASE = "a" * 40
FILES = (*generation.SNAPSHOT_FILES, generation.LAST_RUN_FILE)


@pytest.fixture
def values(monkeypatch):
    monkeypatch.setenv("APPROVED_RELEASE_SHA", RELEASE)
    monkeypatch.setenv("GITHUB_RUN_ID", "101")
    monkeypatch.setenv("GITHUB_RUN_ATTEMPT", "1")
    performance = {
        "updated_at": "2026-09-14 10:00:00",
        "num_positions": 0,
        "equity": 1000.0,
        "cash": 1000.0,
        "adaptive_rebalance_pending": {
            "plan_id": "original",
            "order_attempts": {
                "intent": {"status": "reserved", "client_order_id": "unchanged"},
            },
        },
        "daily_history": [{"date": "2026-09-13", "equity": 990.0}],
    }
    positions = {"updated_at": performance["updated_at"], "positions": []}
    summary = {
        "schema_version": 1,
        "release_sha": RELEASE,
        "status": "PASS",
        "cycle_outcome": generation.cycle_outcome("pending", "orders_pending"),
    }
    return performance, positions, summary


def read(state):
    return {name: (state / name).read_bytes() for name in FILES}


def test_generation_binds_exact_bytes_preserving_frozen_plan_and_history(values):
    before = copy.deepcopy(values)
    files = generation.prepare_runtime_generation(*values)
    marker = generation.validate_runtime_generation(files, require_current_run=True)
    assert marker["github_run_id"] == 101
    assert marker["github_run_attempt"] == 1
    perf = json.loads(files["performance.json"])
    assert perf["adaptive_rebalance_pending"] == values[0]["adaptive_rebalance_pending"]
    assert perf["daily_history"] == values[0]["daily_history"]
    assert values == before


@pytest.mark.parametrize("name", FILES)
def test_mixed_generations_are_refused_even_with_unchanged_financial_values(
    values, name
):
    first = generation.prepare_runtime_generation(*values)
    second = generation.prepare_runtime_generation(*values)
    first[name] = second[name]
    with pytest.raises(generation.RuntimeGenerationError):
        generation.validate_runtime_generation(first)


@pytest.mark.parametrize("name", generation.SNAPSHOT_FILES)
def test_whitespace_tamper_breaks_raw_byte_commit(values, name):
    files = generation.prepare_runtime_generation(*values)
    files[name] += b"\n"
    with pytest.raises(generation.RuntimeGenerationError, match="digest_mismatch"):
        generation.validate_runtime_generation(files)


@pytest.mark.parametrize("field", ["runtime_generation", "cycle_outcome"])
def test_new_contract_cannot_be_downgraded_by_removing_one_field(values, field):
    files = generation.prepare_runtime_generation(*values)
    record = json.loads(files[generation.LAST_RUN_FILE])
    record.pop(field)
    files[generation.LAST_RUN_FILE] = json.dumps(record).encode()
    with pytest.raises(generation.RuntimeGenerationError):
        generation.validate_runtime_generation(files)


def test_legacy_remains_explicitly_unverified_and_cannot_be_current_publication(values):
    files = {
        name: json.dumps(value).encode()
        for name, value in zip(FILES, values, strict=True)
    }
    record = json.loads(files[generation.LAST_RUN_FILE])
    record.pop("cycle_outcome")
    files[generation.LAST_RUN_FILE] = json.dumps(record).encode()
    assert generation.validate_runtime_generation(files) is None
    with pytest.raises(generation.RuntimeGenerationError, match="required"):
        generation.validate_runtime_generation(files, require_generation=True)
    with pytest.raises(generation.RuntimeGenerationError, match="required"):
        generation.validate_runtime_generation(files, require_current_run=True)


@pytest.mark.parametrize(
    "key,value",
    [
        ("GITHUB_RUN_ID", "102"),
        ("GITHUB_RUN_ATTEMPT", "2"),
        ("APPROVED_RELEASE_SHA", "b" * 40),
    ],
)
def test_valid_prior_publication_cannot_be_relabelled_as_current(
    values, monkeypatch, key, value
):
    files = generation.prepare_runtime_generation(*values)
    monkeypatch.setenv(key, value)
    with pytest.raises(generation.RuntimeGenerationError, match="current_run"):
        generation.validate_runtime_generation(files, require_current_run=True)


def test_recovery_generation_preserves_state_but_cannot_claim_healthy(values):
    with pytest.raises(generation.RuntimeGenerationError, match="recovery_cannot_pass"):
        generation.prepare_runtime_generation(*values, snapshot_status="recovery")
    values[2]["status"] = "FAIL"
    values[2]["cycle_outcome"] = generation.cycle_outcome(
        "failed", "snapshot_unavailable"
    )
    values[1]["updated_at"] = "older broker observation"
    files = generation.prepare_runtime_generation(*values, snapshot_status="recovery")
    assert (
        generation.validate_runtime_generation(files)["snapshot_status"] == "recovery"
    )


@pytest.mark.parametrize("mutation", ["status", "position_count", "observation_time"])
def test_new_generation_rejects_incoherent_snapshot_or_outcome(values, mutation):
    if mutation == "status":
        values[2]["status"] = "FAIL"
    elif mutation == "position_count":
        values[0]["num_positions"] = 1
    else:
        values[1]["updated_at"] = "different observation"
    with pytest.raises(generation.RuntimeGenerationError):
        generation.prepare_runtime_generation(*values)


@pytest.mark.parametrize("fail_replace", [1, 2, 3])
def test_interrupted_publication_never_validates_as_current_pass(
    values, tmp_path, monkeypatch, fail_replace
):
    generation.publish_runtime_generation(tmp_path, *values)
    monkeypatch.setenv("GITHUB_RUN_ID", "102")
    original = os.replace
    calls = 0

    def interrupted(source, destination):
        nonlocal calls
        calls += 1
        if calls == fail_replace:
            raise OSError("synthetic interruption")
        original(source, destination)

    monkeypatch.setattr(generation.os, "replace", interrupted)
    with pytest.raises(OSError):
        generation.publish_runtime_generation(tmp_path, *values)
    with pytest.raises(generation.RuntimeGenerationError):
        generation.validate_runtime_generation(read(tmp_path), require_current_run=True)
    assert not list(tmp_path.glob(".runtime-generation-*"))


def test_marker_published_last_and_snapshot_files_are_private(
    values, tmp_path, monkeypatch
):
    generation.publish_runtime_generation(tmp_path, *values)
    original = os.replace
    stages = []

    def inspect(source, destination):
        original(source, destination)
        try:
            generation.validate_runtime_generation(
                read(tmp_path), require_generation=True
            )
            stages.append(True)
        except generation.RuntimeGenerationError:
            stages.append(False)

    monkeypatch.setattr(generation.os, "replace", inspect)
    generation.publish_runtime_generation(tmp_path, *values)
    assert stages == [False, False, True]
    assert all((tmp_path / name).stat().st_mode & 0o777 == 0o600 for name in FILES)


@pytest.mark.parametrize("raw", [b'{"x":NaN}', b'{"x":1e999}', b'{"x":1,"x":2}'])
def test_malformed_json_is_not_a_legacy_escape(values, raw):
    files = generation.prepare_runtime_generation(*values)
    files["performance.json"] = raw
    with pytest.raises(generation.RuntimeGenerationError):
        generation.validate_runtime_generation(files)


def test_cli_prints_only_fixed_verdict_and_refuses_stale_current_run(
    values, tmp_path, monkeypatch, capsys
):
    generation.publish_runtime_generation(tmp_path, *values)
    args = [
        "verify",
        "--require-generation",
        "--require-current-run",
        "--state-dir",
        str(tmp_path),
    ]
    assert generation.main(args) == 0
    assert json.loads(capsys.readouterr().out) == {
        "runtime_generation": "PASS",
        "coherence": "verified",
    }
    monkeypatch.setenv("GITHUB_RUN_ID", "102")
    assert generation.main(args) == 1
    assert json.loads(capsys.readouterr().out) == {"runtime_generation": "FAIL"}
