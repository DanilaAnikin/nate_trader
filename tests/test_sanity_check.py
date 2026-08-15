from __future__ import annotations

import json

import pytest

from sanity_check import check_validation_artifact
from backtest.validate_v11 import attach_report_contract
from tests.v11_report_factory import canonical_validation_report


def _report(*, status: str = "PASS", allowed_mode: str = "paper-validation-eligible"):
    return canonical_validation_report(
        metric_value=1.0 if status == "PASS" else -1.0,
        allowed_mode=allowed_mode,
    )


@pytest.fixture(autouse=True)
def _matching_local_bar_evidence(monkeypatch):
    import strategy_identity

    monkeypatch.setattr(
        strategy_identity,
        "build_bar_snapshot_identity",
        lambda *args, **kwargs: {"bar_snapshot_sha256": "a" * 64},
    )


def test_validation_artifact_accepts_nested_v11_schema_and_pass(tmp_path):
    path = tmp_path / "validation.json"
    path.write_text(json.dumps(_report()))

    assert check_validation_artifact(path) == []


def test_validation_artifact_rejects_failed_alpha_gate(tmp_path):
    path = tmp_path / "validation.json"
    path.write_text(
        json.dumps(
            _report(
                status="FAIL",
                allowed_mode="dry-run/shadow-research-only",
            )
        )
    )

    failures = check_validation_artifact(path)

    assert len(failures) == 1
    assert "promotion gate is FAIL" in failures[0]
    assert "dry-run/shadow-research-only" in failures[0]


def test_validation_artifact_fails_closed_when_assessment_is_missing(tmp_path):
    path = tmp_path / "validation.json"
    payload = _report()
    del payload["assessment"]
    payload = attach_report_contract(payload)
    path.write_text(json.dumps(payload))

    assert "promotion assessment missing" in check_validation_artifact(path)[0]


def test_validation_artifact_rejects_stale_strategy_identity(tmp_path):
    path = tmp_path / "validation.json"
    payload = _report()
    payload["strategy"]["identity"]["value"] = "0" * 64
    payload = attach_report_contract(payload)
    path.write_text(json.dumps(payload))

    assert "stale" in check_validation_artifact(path)[0]


def test_validation_artifact_rejects_non_object_json(tmp_path):
    path = tmp_path / "validation.json"
    path.write_text("[]")

    assert "JSON object" in check_validation_artifact(path)[0]


def test_validation_artifact_rejects_changed_ranking_universe(tmp_path):
    path = tmp_path / "validation.json"
    payload = _report()
    payload["evidence"]["ranking_universe_sha256"] = "0" * 64
    payload = attach_report_contract(payload)
    path.write_text(json.dumps(payload))

    assert "ranking universe" in check_validation_artifact(path)[0]


def test_validation_artifact_rejects_changed_historical_bar_prefix(tmp_path):
    path = tmp_path / "validation.json"
    payload = _report()
    payload["evidence"]["bar_snapshot_sha256"] = "b" * 64
    payload = attach_report_contract(payload)
    path.write_text(json.dumps(payload))

    assert "historical bars" in check_validation_artifact(path)[0]


def test_validation_artifact_rejects_manual_status_flip(tmp_path):
    path = tmp_path / "validation.json"
    payload = _report(
        status="FAIL", allowed_mode="dry-run/shadow-research-only"
    )
    payload["assessment"]["status"] = "PASS"
    payload["assessment"]["allowed_mode"] = "paper-validation-eligible"
    path.write_text(json.dumps(payload))

    assert "digest mismatch" in check_validation_artifact(path)[0]


def test_validation_artifact_expires_even_when_digest_is_valid(tmp_path):
    path = tmp_path / "validation.json"
    payload = _report()
    payload["generated_at"] = "2020-01-01T12:00:00+00:00"
    payload["evidence"]["bar_snapshot_through_date"] = "2020-01-01"
    payload = attach_report_contract(payload)
    path.write_text(json.dumps(payload))

    assert "expired" in check_validation_artifact(path)[0]
