"""Read-only settlement of a completed paper handoff.

This command closes the *runtime bookkeeping* for an old paper handoff after a
fresh broker observation proves that every carried order filled and the broker
portfolio is unchanged from the source artifact.  It does not submit,
cancel, replace, or amend an order.  The resulting state is a normal three
file native runtime generation for the target release; the old pending plan
is removed only after its audit evidence is recorded in ``last_run``.

The command is deliberately narrow.  It refuses a non-chained source,
changed universe/identity evidence, non-terminal or non-filled attempts,
unknown/open orders, a position mismatch, live mode, and every malformed
input.  It is intended for a manually dispatched, paper-only workflow.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from paper_broker_audit import _client, _order_view, audit
from restore_paper_runtime import CHAINED_RUNTIME_FILES
from runtime_generation import cycle_outcome, prepare_runtime_generation, validate_runtime_generation
from runtime_handoff import (
    HANDOFF_DIR,
    HandoffError,
    digest,
    immutable_plan_digest,
    prior_source,
    read_object,
    source_file_names,
    validate_manifest,
)

_SHA = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")


class SettlementError(RuntimeError):
    """Fixed local failure boundary; never expose broker/private data."""


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise SettlementError(reason)


def _settlement_source(files: dict[str, bytes], *, source_sha: str) -> tuple[dict, dict, dict]:
    """Validate the old chained artifact without applying current universe rules.

    The active snapshot in the old target may have a DEGRADED last-run record;
    that is exactly why recovery is needed.  The immutable first-hop source
    remains the authority for plan identity and is validated with its own
    universe hash.  The current active plan must still bind to that evidence.
    """
    _require(set(files) == CHAINED_RUNTIME_FILES, "source_archive_shape")
    manifest_raw = files[str(HANDOFF_DIR / "manifest.json")]
    manifest = read_object(manifest_raw)
    _require(manifest.get("schema_version") == 2, "source_handoff_schema")
    # The artifact is the latest target runtime.  Its schema-2 handoff
    # necessarily points from the previous release to this artifact release.
    _require(manifest.get("target", {}).get("release_sha") == source_sha, "source_release")
    target = manifest.get("target", {})
    _require(isinstance(target, dict), "source_target")
    validate_manifest(
        manifest_raw,
        digest(manifest_raw),
        target_sha=target.get("release_sha", ""),
        target_identity=target.get("strategy_identity", ""),
        universe_sha=manifest.get("ranking_universe_sha256", ""),
        bootstrap=False,
    )
    nested = {
        name: files[str(HANDOFF_DIR / "source" / name)]
        for name in source_file_names(manifest)
    }
    prior, original = prior_source(manifest, nested)
    _require(prior is not None, "source_prior_missing")

    performance = read_object(files["performance.json"])
    positions = read_object(files["positions.json"])
    last_run = read_object(files["production/last_run.json"])
    _require(last_run.get("release_sha") == source_sha, "source_active_release")
    _require(last_run.get("kind") == "v11_paper_production_run", "source_active_kind")
    _require(last_run.get("paper_only") is True, "source_active_mode")
    _require(last_run.get("status") in {"PASS", "DEGRADED", "FAIL"}, "source_active_status")
    plan = performance.get("adaptive_rebalance_pending")
    _require(isinstance(plan, dict), "source_active_plan_missing")
    _require(plan.get("strategy_identity_value") == manifest["target"]["strategy_identity"], "source_active_strategy_identity")
    _require(isinstance(plan.get("order_attempts"), dict), "source_attempts")
    _require(bool(plan["order_attempts"]), "source_attempts_empty")
    _require(isinstance(positions.get("positions"), list), "source_positions")
    return manifest, original, performance


def _audit_plan_orders(plan: dict) -> dict[str, Any]:
    """Reconcile every original carried order twice without broker writes."""
    client = _client()
    counts: dict[str, int] = {}
    for record in plan["order_attempts"].values():
        first = _order_view(client.get_order_by_client_id(record["client_order_id"]))
        second = _order_view(client.get_order_by_client_id(record["client_order_id"]))
        _require(first == second, "source_order_snapshot_unstable")
        _require(
            first["id"] == record["order_id"]
            and first["client_order_id"] == record["client_order_id"]
            and first["symbol"] == record["symbol"]
            and first["side"] == record["side"]
            and first["qty"] == format(float(record["quantity"]), ".12g")
            and first["status"] == "filled",
            "source_order_not_filled",
        )
        counts[first["status"]] = counts.get(first["status"], 0) + 1
    return {"count": len(plan["order_attempts"]), "status_counts": counts}


def _audit_is_settleable(report: dict[str, Any]) -> None:
    """Require a complete successful read-only observation, never a best effort."""
    _require(report.get("result") == "PASS", "broker_audit_failed")
    _require(report.get("recovery_compatible") is True, "broker_recovery_incompatible")
    _require(report.get("source_positions_match") is True, "broker_positions_mismatch")
    _require(report.get("known_order_snapshots_stable") is True, "known_order_snapshot_unstable")
    _require(report.get("known_orders_all_terminal") is True, "known_order_nonterminal")
    _require(report.get("open_order_count") == 0, "open_orders_present")
    statuses = report.get("known_order_status_counts")
    _require(isinstance(statuses, dict) and statuses and set(statuses) == {"filled"}, "known_order_not_all_filled")
    _require(report.get("known_order_count") == statuses["filled"], "known_order_count_mismatch")


def _current_identity_universe() -> tuple[str, str]:
    from strategy_identity import build_strategy_identity, hash_symbol_universe
    from universe import load_universe_symbols

    return str(build_strategy_identity()["value"]), hash_symbol_universe(load_universe_symbols(held_symbols=[]))


def _source_position_hash(files: dict[str, bytes]) -> str:
    payload = read_object(files["positions.json"])
    rows = []
    for position in payload.get("positions", []):
        rows.append({"symbol": str(position["symbol"]), "qty": float(position["qty"]), "side": "long"})
    raw = json.dumps(sorted(rows, key=lambda item: item["symbol"]), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def _execution_context(target_sha: str) -> dict[str, Any]:
    run_id = os.environ.get("GITHUB_RUN_ID")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT")
    _require(_COMMIT.fullmatch(target_sha), "target_release")
    _require(re.fullmatch(r"[1-9][0-9]{0,19}", str(run_id or "")), "current_run")
    _require(re.fullmatch(r"[1-9][0-9]{0,9}", str(attempt or "")), "current_attempt")
    return {"release_sha": target_sha, "github_run_id": int(run_id), "github_run_attempt": int(attempt)}


def settle(
    source_dir: Path,
    output_dir: Path,
    *,
    target_sha: str,
    source_sha: str,
    source_run_id: int,
    source_artifact_id: int,
    source_archive_sha256: str,
) -> dict[str, Any]:
    from broker_mode import resolve_broker_mode
    from portfolio import _portfolio_performance, build_performance_state, get_account, get_positions

    _require(resolve_broker_mode().mode == "paper", "paper_mode_required")
    _require(_COMMIT.fullmatch(target_sha), "target_release")
    _require(_COMMIT.fullmatch(source_sha), "source_release")
    _require(type(source_run_id) is int and source_run_id > 0, "source_run_id")
    _require(type(source_artifact_id) is int and source_artifact_id > 0, "source_artifact_id")
    _require(_SHA.fullmatch(source_archive_sha256), "source_archive_sha256")
    files = {str(path.relative_to(source_dir)): path.read_bytes() for path in source_dir.rglob("*.json")}
    manifest, original, source_performance = _settlement_source(files, source_sha=source_sha)
    # Audit reads only Alpaca's paper endpoint and performs two known-order GETs.
    report = audit(source_dir)
    _audit_is_settleable(report)
    source_orders = _audit_plan_orders(original)
    _require(source_orders["status_counts"] == {"filled": source_orders["count"]}, "source_orders_not_all_filled")
    identity, universe = _current_identity_universe()
    _require(identity != manifest["source"]["strategy_identity"], "target_strategy_unchanged")
    _require(universe != manifest["ranking_universe_sha256"], "target_universe_not_advanced")

    account = get_account()
    positions = get_positions()
    observed_rows = [{"symbol": str(item["symbol"]), "qty": float(item["qty"]), "side": "long"} for item in positions]
    observed_raw = json.dumps(sorted(observed_rows, key=lambda item: item["symbol"]), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    _require(hashlib.sha256(observed_raw).hexdigest() == report["position_snapshot_sha256"], "broker_snapshot_changed")
    _require(hashlib.sha256(observed_raw).hexdigest() == _source_position_hash(files), "source_position_snapshot_changed")

    # Build a fresh broker observation while preserving all historical metrics.
    # Removing only the fully settled pending plan prevents it from being
    # replayed under the current (different) universe.
    current = _portfolio_performance(account, positions)
    performance = build_performance_state(deepcopy(source_performance), current)
    performance.pop("adaptive_rebalance_pending", None)
    summary = {
        "schema_version": 1,
        "kind": "v11_paper_production_run",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "release_sha": target_sha,
        "strategy_version": "v11-adaptive-momentum",
        "status": "DEGRADED",
        "cycle_outcome": cycle_outcome("blocked", "execution_incomplete"),
        "paper_only": True,
        "broker_mode": "paper",
        "market_entry_allowed": False,
        "risk_tier": performance.get("risk_tier"),
        "action_counts": {},
        "blocking_actions": [],
        "recovery_settlement": {
            "schema_version": 1,
            "kind": "v11_paper_recovery_settlement",
            "source_release_sha": source_sha,
            "source_run_id": source_run_id,
            "source_artifact_id": source_artifact_id,
            "source_archive_sha256": source_archive_sha256,
            "source_handoff_sha256": digest(files[str(HANDOFF_DIR / "manifest.json")]),
            "source_plan_id": original["plan_id"],
            "source_plan_immutable_sha256": manifest["plan"]["immutable_sha256"],
            "source_ranking_universe_sha256": manifest["ranking_universe_sha256"],
            "settled_plan_id": source_performance["adaptive_rebalance_pending"]["plan_id"],
            "settled_plan_immutable_sha256": immutable_plan_digest(source_performance["adaptive_rebalance_pending"]),
            "settled_ranking_universe_sha256": source_performance["adaptive_rebalance_pending"]["ranking_universe_sha256"],
            "target_strategy_identity_sha256": identity,
            "target_ranking_universe_sha256": universe,
            "known_order_count": report["known_order_count"],
            "known_order_status_counts": report["known_order_status_counts"],
            "source_order_count": source_orders["count"],
            "source_order_status_counts": source_orders["status_counts"],
            "source_position_snapshot_sha256": report["source_position_snapshot_sha256"],
            "broker_position_snapshot_sha256": report["position_snapshot_sha256"],
            "open_order_count": report["open_order_count"],
            "settled_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    generated = prepare_runtime_generation(
        performance,
        {"updated_at": current["updated_at"], "positions": positions},
        summary,
        snapshot_status="fresh",
        execution_context=_execution_context(target_sha),
    )
    validate_runtime_generation(generated, require_generation=True, require_current_run=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, raw in generated.items():
        path = output_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        path.chmod(0o600)
    return {
        "check": "paper_recovery_settlement",
        "result": "PASS",
        "target_release_sha": target_sha,
        "known_order_count": report["known_order_count"],
        "native_runtime_files": 3,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--target-sha", required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--source-run-id", required=True, type=int)
    parser.add_argument("--source-artifact-id", required=True, type=int)
    parser.add_argument("--source-archive-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(settle(**vars(args)), sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({"check": "paper_recovery_settlement", "result": "FAIL"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
