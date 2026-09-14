"""Explicit, paper-only adoption of one existing frozen execution plan.

The manifest's exact bytes are approved outside the runtime artifact. Original
state remains immutable evidence; a run-scoped authorization lets the executor
continue that exact plan with its original identity and idempotency keys. This
module does not construct targets, write runtime state, or mutate the broker.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

MANIFEST_ENV = "PAPER_RUNTIME_HANDOFF_SHA256"
HANDOFF_DIR = Path("production/handoff")
SOURCE_FILES = ("performance.json", "positions.json", "production/last_run.json")
MANIFEST_PATH = str(HANDOFF_DIR / "manifest.json")
FIRST_HANDOFF_FILES = (
    *SOURCE_FILES,
    MANIFEST_PATH,
    *(str(HANDOFF_DIR / "source" / name) for name in SOURCE_FILES),
)
# A Sunday approval can reach Monday's normal cycle without an order dispatch
# solely to activate the transfer. Source age/latestness are separate checks.
MAX_BOOTSTRAP_WINDOW_SECONDS = 48 * 60 * 60
MAX_SOURCE_AGE_SECONDS = 96 * 60 * 60
_SHA = re.compile(r"^[0-9a-f]{64}$")
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_ACTIVE = frozenset(
    {"new", "accepted", "pending_new", "partially_filled", "done_for_day"}
)
_TERMINAL = frozenset({"filled", "canceled", "expired", "rejected"})
_AUTHORIZATION: ContextVar[dict | None] = ContextVar(
    "paper_runtime_adoption", default=None
)


class HandoffError(RuntimeError):
    """Fixed reason codes only: never interpolate private state or API errors."""


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise HandoffError(f"paper runtime handoff refused: {reason}")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_digest(value: Any) -> str:
    return digest(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    )


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        _require(key not in result, "duplicate_json_key")
        result[key] = value
    return result


def read_object(raw: bytes) -> dict:
    try:
        value = json.loads(
            raw,
            object_pairs_hook=_object_pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
        )
        _require(isinstance(value, dict), "json_object_required")
        return value
    except HandoffError:
        raise
    except (ValueError, UnicodeError, TypeError):
        raise HandoffError("paper runtime handoff refused: invalid_json") from None


def _keys(value: Any, expected: set[str]) -> bool:
    return isinstance(value, dict) and set(value) == expected


def _sha(value: Any) -> bool:
    return isinstance(value, str) and bool(_SHA.fullmatch(value))


def _commit(value: Any) -> bool:
    return isinstance(value, str) and bool(_COMMIT.fullmatch(value))


def _timestamp(value: Any) -> datetime:
    try:
        _require(
            isinstance(value, str) and value.endswith("Z"), "utc_timestamp_required"
        )
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        raise HandoffError("paper runtime handoff refused: invalid_timestamp") from None


def immutable_plan_digest(plan: dict) -> str:
    """Attempts evolve after adoption; every other plan field stays frozen."""
    return canonical_digest(
        {key: value for key, value in plan.items() if key != "order_attempts"}
    )


def account_digest(account_id: Any) -> str:
    try:
        account_id = str(UUID(str(account_id)))
    except (ValueError, TypeError, AttributeError):
        raise HandoffError(
            "paper runtime handoff refused: invalid_account_identity"
        ) from None
    return canonical_digest(
        {"broker": "alpaca", "mode": "paper", "account_id": account_id}
    )


def validate_manifest(
    raw: bytes,
    pin: str,
    *,
    target_sha: str,
    target_identity: str,
    universe_sha: str,
    bootstrap: bool,
    now: datetime | None = None,
) -> dict:
    """Validate exact external approval, target release, and bootstrap deadline."""
    _require(_sha(pin) and digest(raw) == pin, "manifest_pin")
    manifest = read_object(raw)
    version = manifest.get("schema_version")
    extra = {"prior_handoff"} if version == 2 else set()
    _require(
        _keys(
            manifest,
            {
                "schema_version",
                "kind",
                "source",
                "target",
                "paper_account_sha256",
                "ranking_universe_sha256",
                "plan",
                "issued_at",
                "expires_at",
            }
            | extra,
        ),
        "manifest_fields",
    )
    _require(
        type(manifest["schema_version"]) is int
        and manifest["schema_version"] in (1, 2)
        and manifest["kind"] == "v11_paper_runtime_handoff",
        "manifest_kind",
    )
    source, target, plan = manifest["source"], manifest["target"], manifest["plan"]
    if version == 2:
        _require(
            _keys(manifest["prior_handoff"], {"manifest_sha256"})
            and _sha(manifest["prior_handoff"]["manifest_sha256"]),
            "prior_handoff_pin",
        )
    _require(
        _keys(
            source,
            {
                "release_sha",
                "strategy_identity",
                "run_id",
                "artifact_id",
                "artifact_sha256",
                "files",
            },
        ),
        "source_fields",
    )
    _require(_keys(target, {"release_sha", "strategy_identity"}), "target_fields")
    _require(
        _keys(
            plan,
            {
                "plan_id",
                "immutable_sha256",
                "initial_attempts_sha256",
                "rebalance_month",
            },
        ),
        "plan_fields",
    )
    _require(
        _commit(source["release_sha"])
        and _commit(target["release_sha"])
        and source["release_sha"] != target["release_sha"],
        "release_pair",
    )
    _require(
        target["release_sha"] == target_sha
        and target["strategy_identity"] == target_identity,
        "target_context",
    )
    _require(
        all(
            _sha(value)
            for value in (
                source["strategy_identity"],
                target_identity,
                source["artifact_sha256"],
                manifest["paper_account_sha256"],
                universe_sha,
                plan["immutable_sha256"],
                plan["initial_attempts_sha256"],
            )
        ),
        "digest_fields",
    )
    _require(manifest["ranking_universe_sha256"] == universe_sha, "ranking_universe")
    _require(
        all(
            type(source[key]) is int and source[key] > 0
            for key in ("run_id", "artifact_id")
        ),
        "source_ids",
    )
    _require(
        _keys(source["files"], set(source_file_names(manifest)))
        and all(_sha(value) for value in source["files"].values()),
        "source_file_digests",
    )
    _require(
        isinstance(plan["plan_id"], str)
        and bool(re.fullmatch(r"[0-9a-f]{16}", plan["plan_id"]))
        and isinstance(plan["rebalance_month"], str)
        and bool(_MONTH.fullmatch(plan["rebalance_month"])),
        "plan_reference",
    )
    issued, expires = (
        _timestamp(manifest["issued_at"]),
        _timestamp(manifest["expires_at"]),
    )
    _require(
        0 < (expires - issued).total_seconds() <= MAX_BOOTSTRAP_WINDOW_SECONDS,
        "bootstrap_window",
    )
    if bootstrap:
        current = now or datetime.now(timezone.utc)
        _require(issued <= current <= expires, "bootstrap_expired_or_future")
        _require(
            plan["rebalance_month"] == current.strftime("%Y-%m"), "bootstrap_plan_month"
        )
    return manifest


def source_file_names(manifest: dict) -> tuple[str, ...]:
    """Exactly one prior handoff may be retained; no recursive unbounded chain."""
    return FIRST_HANDOFF_FILES if manifest.get("schema_version") == 2 else SOURCE_FILES


def _attempt_continuity(original: dict, current: dict) -> None:
    _require(
        set(original["order_attempts"]) <= set(current["order_attempts"]),
        "original_attempt_missing",
    )
    for key, old in original["order_attempts"].items():
        new = current["order_attempts"][key]
        _require(new["attempt"] >= old["attempt"], "attempt_counter_regressed")
        _require(
            all(
                new[field] == old[field]
                for field in ("symbol", "side", "quantity", "target_weight")
            ),
            "changed_existing_intent",
        )
        if new["attempt"] == old["attempt"]:
            _require(
                new["client_order_id"] == old["client_order_id"]
                and (not old.get("order_id") or new.get("order_id") == old["order_id"]),
                "changed_existing_attempt",
            )


def prior_source(manifest: dict, files: dict[str, bytes]) -> tuple[dict, dict] | None:
    """Verify original first-hop evidence under the new externally bound pin."""
    if manifest["schema_version"] == 1:
        return None
    raw = files[MANIFEST_PATH]
    candidate = read_object(raw)
    _require(candidate.get("schema_version") == 1, "handoff_depth_exceeded")
    prior = validate_manifest(
        raw,
        manifest["prior_handoff"]["manifest_sha256"],
        target_sha=manifest["source"]["release_sha"],
        target_identity=candidate.get("target", {}).get("strategy_identity", ""),
        universe_sha=manifest["ranking_universe_sha256"],
        bootstrap=False,
    )
    _require(
        prior["paper_account_sha256"] == manifest["paper_account_sha256"],
        "prior_account_binding",
    )
    _require(
        prior["source"]["strategy_identity"] == manifest["source"]["strategy_identity"]
        and prior["plan"]["immutable_sha256"] == manifest["plan"]["immutable_sha256"]
        and prior["plan"]["plan_id"] == manifest["plan"]["plan_id"],
        "prior_plan_binding",
    )
    original = validate_source(
        prior,
        {name: files[str(HANDOFF_DIR / "source" / name)] for name in SOURCE_FILES},
    )
    return prior, original


def validate_source(
    manifest: dict,
    files: dict[str, bytes],
    *,
    bootstrap: bool = False,
    now: datetime | None = None,
) -> dict:
    """Check original file bytes and every original plan/intent/client-order ID."""
    from execute_trades import _adaptive_pending_plan_structure_valid
    from runtime_generation import RuntimeGenerationError, validate_runtime_generation

    names = source_file_names(manifest)
    _require(set(files) == set(names), "source_files")
    _require(
        all(digest(files[name]) == manifest["source"]["files"][name] for name in names),
        "source_file_integrity",
    )
    try:
        generation = validate_runtime_generation(files)
    except RuntimeGenerationError:
        raise HandoffError(
            "paper runtime handoff refused: source_runtime_generation"
        ) from None
    if generation is not None:
        _require(
            generation["github_run_id"] == manifest["source"]["run_id"]
            and generation["github_run_attempt"] == 1,
            "source_generation_run",
        )
    performance, positions, last_run = (
        read_object(files[name]) for name in SOURCE_FILES
    )
    _require(isinstance(positions.get("positions"), list), "source_positions")
    _require(
        last_run.get("schema_version") == 1
        and last_run.get("kind") == "v11_paper_production_run"
        and last_run.get("paper_only") is True
        and last_run.get("status") == "PASS"
        and last_run.get("release_sha") == manifest["source"]["release_sha"],
        "source_run_lineage",
    )
    if bootstrap:
        try:
            completed = datetime.fromisoformat(
                str(last_run.get("completed_at", "")).replace("Z", "+00:00")
            )
            age = ((now or datetime.now(timezone.utc)) - completed).total_seconds()
        except (ValueError, TypeError):
            raise HandoffError(
                "paper runtime handoff refused: source_run_timestamp"
            ) from None
        _require(0 <= age <= MAX_SOURCE_AGE_SECONDS, "source_run_stale_or_future")
    plan = performance.get("adaptive_rebalance_pending")
    _require(_adaptive_pending_plan_structure_valid(plan), "source_plan_integrity")
    _require(
        plan.get("risk_off") is False and bool(plan.get("target_weights")),
        "nonempty_frozen_plan_required",
    )
    _require(
        plan["plan_id"] == manifest["plan"]["plan_id"]
        and plan["strategy_identity_value"] == manifest["source"]["strategy_identity"]
        and plan["ranking_universe_sha256"] == manifest["ranking_universe_sha256"]
        and plan["rebalance_month"] == manifest["plan"]["rebalance_month"]
        and immutable_plan_digest(plan) == manifest["plan"]["immutable_sha256"]
        and canonical_digest(plan["order_attempts"])
        == manifest["plan"]["initial_attempts_sha256"],
        "source_plan_binding",
    )
    attempts = list(plan["order_attempts"].values())
    _require(
        bool(attempts)
        and all(
            isinstance(record.get("order_id"), str)
            and record["order_id"]
            and record.get("status") == "submitted"
            for record in attempts
        ),
        "ambiguous_source_attempt",
    )
    _require(
        len({record["order_id"] for record in attempts}) == len(attempts)
        and len({record["client_order_id"] for record in attempts}) == len(attempts),
        "duplicate_source_order",
    )
    prior = prior_source(manifest, files)
    if prior is not None:
        _attempt_continuity(prior[1], plan)
    return plan


def _load_state(state_dir: Path) -> dict:
    try:
        return read_object((state_dir / "performance.json").read_bytes())
    except OSError:
        raise HandoffError("paper runtime handoff refused: runtime_missing") from None


def load_handoff(
    state_dir: Path,
    *,
    target_sha: str,
    target_identity: str,
    universe_sha: str,
    pin: str,
) -> tuple[dict, dict, dict]:
    try:
        path = state_dir / HANDOFF_DIR
        raw = (path / "manifest.json").read_bytes()
        manifest = validate_manifest(
            raw,
            pin,
            target_sha=target_sha,
            target_identity=target_identity,
            universe_sha=universe_sha,
            bootstrap=False,
        )
        original = validate_source(
            manifest,
            {
                name: (path / "source" / name).read_bytes()
                for name in source_file_names(manifest)
            },
        )
        return manifest, original, _load_state(state_dir)
    except OSError:
        raise HandoffError(
            "paper runtime handoff refused: handoff_evidence_missing"
        ) from None


def _enum(value: Any) -> str:
    return str(getattr(value, "value", value)).lower()


def _broker_order(order: Any) -> dict:
    from trade import _order_lifecycle_view

    result = _order_lifecycle_view(order)
    _require(result["status"] in _ACTIVE | _TERMINAL, "ambiguous_order_status")
    _require(
        result["qty"] > 0 and result["side"] in {"buy", "sell"},
        "invalid_order_lifecycle",
    )
    _require(
        result["status"] != "filled"
        or math.isclose(result["qty"], result["filled_qty"], abs_tol=1e-9),
        "inconsistent_fill",
    )
    return result


def _open_snapshot(client: Any) -> dict[str, dict]:
    from alpaca.trading.enums import QueryOrderStatus
    from alpaca.trading.requests import GetOrdersRequest

    orders = client.get_orders(
        filter=GetOrdersRequest(status=QueryOrderStatus.OPEN, limit=500, nested=False)
    )
    _require(
        isinstance(orders, list) and len(orders) < 500, "incomplete_open_order_snapshot"
    )
    result = {}
    for raw in orders:
        order = _broker_order(raw)
        _require(
            order["status"] in _ACTIVE and order["remaining_qty"] > 0,
            "inconsistent_open_order",
        )
        _require(
            bool(order["id"]) and order["id"] not in result, "duplicate_open_order"
        )
        result[order["id"]] = order
    return result


def _positions_snapshot(client: Any) -> dict[str, float]:
    positions = client.get_all_positions()
    _require(isinstance(positions, list), "positions_unavailable")
    result = {}
    for position in positions:
        symbol, quantity = str(position.symbol), float(position.qty)
        _require(
            symbol
            and symbol not in result
            and math.isfinite(quantity)
            and quantity > 0
            and _enum(position.side) == "long",
            "ambiguous_position",
        )
        result[symbol] = quantity
    return result


def reconcile_broker(
    client: Any, manifest: dict, original: dict, current: dict | None
) -> None:
    """Fresh GETs only; refuse mismatches instead of canceling or replanning.

    Re-read the open book after resolving every known ID. A fill/cancel race
    causes a refusal that can safely be retried; no stale snapshot authorizes
    the first adopted run. Unknown and transitional statuses are ambiguous.
    """
    try:
        endpoint = str(
            getattr(
                getattr(client, "_base_url", None),
                "value",
                getattr(client, "_base_url", ""),
            )
        ).rstrip("/")
        _require(endpoint == "https://paper-api.alpaca.markets", "paper_endpoint")
        account = client.get_account()
        _require(
            account_digest(getattr(account, "id", None))
            == manifest["paper_account_sha256"],
            "paper_account_binding",
        )
        _require(
            _enum(account.status) == "active"
            and all(
                getattr(account, name, None) is False
                for name in (
                    "account_blocked",
                    "trading_blocked",
                    "trade_suspended_by_user",
                )
            ),
            "account_unavailable",
        )
        if current is None:
            return
        positions = _positions_snapshot(client)
        before = _open_snapshot(client)
        _require(
            set(original["order_attempts"]) <= set(current["order_attempts"]),
            "original_attempt_missing",
        )
        for key, record in original["order_attempts"].items():
            _require(
                current["order_attempts"][key]["attempt"] >= record["attempt"],
                "attempt_counter_regressed",
            )
        records: dict[str, dict] = {}
        for plan in (original, current):
            for record in plan["order_attempts"].values():
                key = record["client_order_id"]
                if key in records:
                    _require(
                        all(
                            records[key].get(field) == record.get(field)
                            for field in (
                                "order_id",
                                "symbol",
                                "side",
                                "quantity",
                                "target_weight",
                                "attempt",
                            )
                        ),
                        "changed_existing_attempt",
                    )
                records[key] = record
        known_active = {}
        observed = {}
        for record in records.values():
            reserved = record.get("status") == "reserved" and not record.get("order_id")
            _require(
                reserved
                or (
                    bool(record.get("order_id")) and record.get("status") == "submitted"
                ),
                "ambiguous_current_attempt",
            )
            try:
                raw = client.get_order_by_client_id(record["client_order_id"])
            except Exception as exc:
                # Only an actual HTTP 404 can prove that a NEW reservation was
                # never accepted. Original submitted IDs must always resolve.
                if reserved and getattr(exc, "status_code", None) == 404:
                    continue
                raise
            order = _broker_order(raw)
            _require(
                (reserved or order["id"] == record["order_id"])
                and order["client_order_id"] == record["client_order_id"]
                and order["symbol"] == record["symbol"]
                and order["side"] == record["side"]
                and math.isclose(
                    order["qty"], float(record["quantity"]), rel_tol=0, abs_tol=1e-9
                ),
                "broker_attempt_mismatch",
            )
            observed[order["client_order_id"]] = order
            if order["status"] in _ACTIVE:
                _require(order["id"] not in known_active, "duplicate_active_attempt")
                known_active[order["id"]] = order
        for key, record in original["order_attempts"].items():
            if current["order_attempts"][key]["attempt"] > record["attempt"]:
                _require(
                    observed[record["client_order_id"]]["status"]
                    in {"canceled", "expired", "rejected"},
                    "premature_attempt_advance",
                )
        _require(before == known_active, "open_order_mismatch")
        _require(_open_snapshot(client) == before, "open_order_snapshot_changed")
        _require(_positions_snapshot(client) == positions, "positions_snapshot_changed")
    except HandoffError:
        raise
    except Exception:  # noqa: BLE001 — broker exception bodies may contain private data
        raise HandoffError(
            "paper runtime handoff refused: broker_reconciliation_unavailable"
        ) from None


def adoption_matches(plan: dict, *, target_identity: str, universe_sha: str) -> bool:
    """Called at BOTH early BUY preflight and later frozen-plan validation."""
    authorization = _AUTHORIZATION.get()
    return bool(
        authorization
        and authorization["target"]["strategy_identity"] == target_identity
        and authorization["ranking_universe_sha256"] == universe_sha
        and plan.get("strategy_identity_value")
        == authorization["source"]["strategy_identity"]
        and plan.get("ranking_universe_sha256") == universe_sha
        and immutable_plan_digest(plan) == authorization["plan"]["immutable_sha256"]
    )


def _target_run_record(state_dir: Path, manifest: dict) -> None:
    try:
        last_run = read_object((state_dir / "production/last_run.json").read_bytes())
    except OSError:
        raise HandoffError(
            "paper runtime handoff refused: runtime_run_missing"
        ) from None
    _require(
        type(last_run.get("schema_version")) is int
        and last_run["schema_version"] == 1
        and last_run.get("kind") == "v11_paper_production_run"
        and last_run.get("release_sha") == manifest["target"]["release_sha"]
        and last_run.get("status") in {"PASS", "FAIL", "DEGRADED"}
        and last_run.get("paper_only") is True,
        "target_run_evidence_required",
    )


def _completion_record(performance: dict, original: dict) -> bool:
    completed_month = performance.get("last_momentum_rebal_ym")
    return bool(
        isinstance(completed_month, str)
        and _MONTH.fullmatch(completed_month)
        and original["rebalance_month"]
        <= completed_month
        <= datetime.now(timezone.utc).strftime("%Y-%m")
        and isinstance(performance.get("last_momentum_targets"), dict)
        and isinstance(performance.get("last_momentum_signal_date"), str)
    )


def _native_successor_allowed(plan: dict, original: dict, performance: dict) -> bool:
    """A code-current plan alone cannot prove that the old intent was honored.

    The existing executor can legitimately replace a pending plan to reduce
    risk, or after completion/month rollover. Adoption adds no new reason to
    rank again in the same month. Original evidence stays intact in all cases.
    """
    if _completion_record(performance, original):
        return True
    if (
        original["rebalance_month"]
        < plan["rebalance_month"]
        <= datetime.now(timezone.utc).strftime("%Y-%m")
    ):
        return True
    if plan["risk_off"] is True and plan["target_weights"] == {}:
        return performance.get("adaptive_risk_off_latched") is True
    return bool(
        plan["risk_off"] is False
        and original["construction_risk_tier"] == "NORMAL"
        and plan["construction_risk_tier"] == "CAUTIOUS"
        and all(
            plan[key] == original[key]
            for key in (
                "rebalance_month",
                "signal_date",
                "sector_by_symbol",
                "eligible_count",
                "ranking_universe_sha256",
            )
        )
        and set(plan["target_weights"]) == set(original["target_weights"])
        and all(
            math.isclose(
                plan["target_weights"][symbol], weight * 0.5, rel_tol=0.0, abs_tol=1e-12
            )
            for symbol, weight in original["target_weights"].items()
        )
    )


@contextmanager
def paper_handoff_context():
    """Authorize an exact carried plan before ANY mutating execution branch."""
    from utils import STATE_DIR

    token = _AUTHORIZATION.set(None)
    try:
        pin = os.getenv(MANIFEST_ENV, "")
        evidence_exists = (STATE_DIR / HANDOFF_DIR).exists()
        if not pin and not evidence_exists:
            # Removing both approval and evidence must not route a carried
            # plan through the ordinary stale-plan cancellation/replanning path.
            if (
                os.getenv("APPROVED_RELEASE_SHA")
                and os.getenv("TRADING_MODE") == "paper"
            ):
                from strategy_identity import build_strategy_identity

                plan = _load_state(STATE_DIR).get("adaptive_rebalance_pending")
                if isinstance(plan, dict):
                    _require(
                        plan.get("strategy_identity_value")
                        == build_strategy_identity()["value"],
                        "unapproved_carried_plan",
                    )
            yield
            return
        from broker_mode import resolve_broker_mode
        from execute_trades import _adaptive_pending_plan_structure_valid
        from strategy_identity import build_strategy_identity, hash_symbol_universe
        from trade import _get_client
        from universe import load_universe_symbols

        _require(resolve_broker_mode().mode == "paper", "paper_mode_required")
        identity = str(build_strategy_identity()["value"])
        universe = hash_symbol_universe(load_universe_symbols(held_symbols=[]))
        manifest, original, performance = load_handoff(
            STATE_DIR,
            target_sha=os.getenv("APPROVED_RELEASE_SHA", ""),
            target_identity=identity,
            universe_sha=universe,
            pin=pin,
        )
        plan = performance.get("adaptive_rebalance_pending")
        carried = None
        if plan is not None:
            _require(
                _adaptive_pending_plan_structure_valid(plan), "current_plan_integrity"
            )
            if (
                plan["strategy_identity_value"]
                == manifest["source"]["strategy_identity"]
            ):
                _require(
                    immutable_plan_digest(plan) == manifest["plan"]["immutable_sha256"],
                    "current_plan_binding",
                )
                carried = plan
            else:
                _require(
                    plan["strategy_identity_value"] == identity,
                    "unapproved_plan_identity",
                )
                _target_run_record(STATE_DIR, manifest)
                _require(
                    _native_successor_allowed(plan, original, performance),
                    "unapproved_native_successor",
                )
        else:
            # No silent disappearance of the initial transferred plan. Only an
            # actual target run may have legitimately completed it or exited.
            _target_run_record(STATE_DIR, manifest)
            _require(_completion_record(performance, original), "carried_plan_missing")
        client = _get_client()
        if manifest["schema_version"] == 2:
            sources = {
                name: (STATE_DIR / HANDOFF_DIR / "source" / name).read_bytes()
                for name in source_file_names(manifest)
            }
            prior = prior_source(manifest, sources)
            _require(prior is not None, "prior_handoff_required")
            reconcile_broker(client, prior[0], prior[1], carried)
        reconcile_broker(client, manifest, original, carried)
        if carried is not None:
            _AUTHORIZATION.set(manifest)
        yield
    finally:
        _AUTHORIZATION.reset(token)
