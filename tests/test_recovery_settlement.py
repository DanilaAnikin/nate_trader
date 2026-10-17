"""Recovery settlement is a strict read-only boundary."""

import copy

import pytest

import recovery_settlement as settlement


def _report(**overrides):
    value = {
        "result": "PASS",
        "recovery_compatible": True,
        "source_positions_match": True,
        "known_order_snapshots_stable": True,
        "known_orders_all_terminal": True,
        "open_order_count": 0,
        "known_order_status_counts": {"filled": 9},
        "known_order_count": 9,
    }
    value.update(overrides)
    return value


def test_only_all_filled_stable_orders_can_settle():
    settlement._audit_is_settleable(_report())


@pytest.mark.parametrize(
    "change",
    [
        {"known_order_status_counts": {"canceled": 1, "filled": 8}},
        {"known_order_snapshots_stable": False},
        {"known_orders_all_terminal": False},
        {"source_positions_match": False},
        {"open_order_count": 1},
        {"known_order_count": 8},
    ],
)
def test_any_incomplete_broker_evidence_refuses_settlement(change):
    with pytest.raises(settlement.SettlementError):
        settlement._audit_is_settleable(_report(**change))


def test_settlement_report_cannot_be_mutated_by_the_caller():
    report = _report()
    snapshot = copy.deepcopy(report)
    settlement._audit_is_settleable(report)
    assert report == snapshot


def test_schema_two_source_without_nested_prior_manifest_is_refused(tmp_path):
    # A seven-file historical artifact cannot prove the prior handoff bytes.
    # The settlement path must not reconstruct or self-approve that evidence.
    files = {
        "performance.json": b"{}",
        "positions.json": b"{}",
        "production/last_run.json": b"{}",
        "production/handoff/manifest.json": b"{}",
        "production/handoff/source/performance.json": b"{}",
        "production/handoff/source/positions.json": b"{}",
        "production/handoff/source/production/last_run.json": b"{}",
    }
    with pytest.raises(settlement.SettlementError, match="source_archive_shape"):
        settlement._settlement_source(files, source_sha="a" * 40)


def test_settlement_marker_requires_clean_target_runtime(tmp_path):
    import json

    target_sha = "a" * 40
    identity = "b" * 64
    universe = "c" * 64
    marker = {
        "schema_version": 1,
        "kind": "v11_paper_recovery_settlement",
        "source_release_sha": "d" * 40,
        "source_run_id": 1,
        "source_artifact_id": 2,
        "source_archive_sha256": "e" * 64,
        "source_handoff_sha256": "f" * 64,
        "source_plan_id": "0123456789abcdef",
        "source_plan_immutable_sha256": "1" * 64,
        "source_ranking_universe_sha256": "2" * 64,
        "settled_plan_id": "fedcba9876543210",
        "settled_plan_immutable_sha256": "4" * 64,
        "settled_ranking_universe_sha256": "5" * 64,
        "target_strategy_identity_sha256": identity,
        "target_ranking_universe_sha256": universe,
        "known_order_count": 9,
        "known_order_status_counts": {"filled": 9},
        "source_order_count": 15,
        "source_order_status_counts": {"filled": 15},
        "source_position_snapshot_sha256": "3" * 64,
        "broker_position_snapshot_sha256": "3" * 64,
        "open_order_count": 0,
        "settled_at": "2026-10-17T12:00:00Z",
    }
    (tmp_path / "production").mkdir()
    (tmp_path / "performance.json").write_text(json.dumps({}))
    (tmp_path / "production/last_run.json").write_text(json.dumps({
        "kind": "v11_paper_production_run",
        "release_sha": target_sha,
        "status": "DEGRADED",
        "paper_only": True,
        "recovery_settlement": marker,
    }))
    import runtime_handoff

    assert runtime_handoff._recovery_settlement_authorized(
        tmp_path, target_sha=target_sha, target_identity=identity, universe_sha=universe
    )
