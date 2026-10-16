"""Read-only paper broker audit for handoff recovery decisions.

This command never submits, cancels, replaces, or modifies an order. Output is
sanitized so it can be uploaded as a short-lived diagnostic artifact without
including account IDs, order IDs, symbols, quantities, or credentials.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from broker_mode import resolve_broker_mode

_TERMINAL = frozenset({"filled", "canceled", "expired", "rejected"})


def _enum(value: Any) -> str:
    return str(getattr(value, "value", value)).lower()


def _digest_rows(rows: list[dict[str, Any]]) -> str:
    raw = json.dumps(
        rows, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()
    return hashlib.sha256(raw).hexdigest()


def _client():
    from trade import _get_client

    return _get_client()


def _position_rows(raw_positions: list[Any]) -> list[dict[str, Any]]:
    if len(raw_positions) > 500:
        raise RuntimeError("positions_snapshot_incomplete")
    rows = []
    for position in raw_positions:
        symbol = str(getattr(position, "symbol", ""))
        qty = float(getattr(position, "qty", 0.0))
        side = _enum(getattr(position, "side", ""))
        if not symbol or not math.isfinite(qty) or qty <= 0 or side != "long":
            raise RuntimeError("ambiguous_position")
        rows.append({"symbol": symbol, "qty": qty, "side": side})
    return sorted(rows, key=lambda row: row["symbol"])


def _open_order_rows(raw_orders: list[Any]) -> list[dict[str, Any]]:
    if len(raw_orders) > 500:
        raise RuntimeError("open_orders_snapshot_incomplete")
    rows = []
    for order in raw_orders:
        rows.append(
            {
                "id": str(getattr(order, "id", "")),
                "client_order_id": str(getattr(order, "client_order_id", "")),
                "symbol": str(getattr(order, "symbol", "")),
                "side": _enum(getattr(order, "side", "")),
                "status": _enum(getattr(order, "status", "")),
                "qty": str(getattr(order, "qty", "")),
            }
        )
    return sorted(rows, key=lambda row: (row["id"], row["client_order_id"]))


def _source_positions_hash(runtime_dir: Path | None) -> str | None:
    if runtime_dir is None:
        return None
    path = runtime_dir / "positions.json"
    if not path.is_file():
        raise RuntimeError("source_positions_missing")
    payload = json.loads(path.read_text())
    rows = []
    for position in payload.get("positions", []):
        rows.append(
            {
                "symbol": str(position["symbol"]),
                "qty": float(position["qty"]),
                "side": "long",
            }
        )
    return _digest_rows(sorted(rows, key=lambda row: row["symbol"]))


def _number_text(value: Any) -> str:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return "invalid"
    if not math.isfinite(parsed) or parsed < 0:
        return "invalid"
    return format(parsed, ".12g")


def _order_view(raw: Any) -> dict[str, Any]:
    return {
        "id": str(getattr(raw, "id", "")),
        "client_order_id": str(getattr(raw, "client_order_id", "")),
        "symbol": str(getattr(raw, "symbol", "")),
        "side": _enum(getattr(raw, "side", "")),
        "status": _enum(getattr(raw, "status", "")),
        "qty": _number_text(getattr(raw, "qty", "")),
        "filled_qty": _number_text(getattr(raw, "filled_qty", "")),
        "remaining_qty": _number_text(getattr(raw, "remaining_qty", "")),
    }


def _known_order_audit(client: Any, runtime_dir: Path | None) -> dict[str, Any]:
    if runtime_dir is None:
        return {
            "known_order_count": None,
            "known_order_status_counts": None,
            "known_order_snapshot_sha256": None,
            "known_order_snapshots_stable": None,
            "known_orders_all_terminal": None,
        }
    path = runtime_dir / "performance.json"
    if not path.is_file():
        raise RuntimeError("source_performance_missing")
    payload = json.loads(path.read_text())
    plan = payload.get("adaptive_rebalance_pending") or {}
    attempts = plan.get("order_attempts")
    if not isinstance(attempts, dict) or len(attempts) > 500:
        raise RuntimeError("source_attempts_invalid")

    rows = []
    stable = True
    for key, record in sorted(attempts.items()):
        client_id = str(record.get("client_order_id", ""))
        if not client_id:
            raise RuntimeError("source_client_order_id_missing")
        first = _order_view(client.get_order_by_client_id(client_id))
        second = _order_view(client.get_order_by_client_id(client_id))
        if first != second:
            stable = False
        if (
            first["client_order_id"] != client_id
            or first["symbol"] != str(record.get("symbol", ""))
            or first["side"] != str(record.get("side", "")).lower()
            or first["qty"] != _number_text(record.get("quantity", ""))
        ):
            raise RuntimeError("known_order_mismatch")
        rows.append(
            {
                "attempt_key": str(key),
                "status": first["status"],
                "side": first["side"],
                "qty": first["qty"],
                "filled_qty": first["filled_qty"],
                "remaining_qty": first["remaining_qty"],
            }
        )
    statuses = Counter(row["status"] for row in rows)
    return {
        "known_order_count": len(rows),
        "known_order_status_counts": dict(sorted(statuses.items())),
        "known_order_snapshot_sha256": _digest_rows(rows),
        "known_order_snapshots_stable": stable,
        "known_orders_all_terminal": all(row["status"] in _TERMINAL for row in rows),
    }


def audit(runtime_dir: Path | None = None) -> dict[str, Any]:
    mode = resolve_broker_mode()
    if mode.mode != "paper":
        raise RuntimeError("paper_mode_required")
    client = _client()
    endpoint = str(
        getattr(
            getattr(client, "_base_url", None),
            "value",
            getattr(client, "_base_url", ""),
        )
    ).rstrip("/")
    if endpoint != "https://paper-api.alpaca.markets":
        raise RuntimeError("paper_endpoint_required")

    account = client.get_account()
    clock = client.get_clock()
    position_rows = _position_rows(list(client.get_all_positions()))
    open_order_rows = _open_order_rows(list(client.get_orders()))
    source_hash = _source_positions_hash(runtime_dir)
    known = _known_order_audit(client, runtime_dir)
    broker_hash = _digest_rows(position_rows)
    blockers = []
    if source_hash is not None and source_hash != broker_hash:
        blockers.append("source_positions_mismatch")
    if known["known_order_snapshots_stable"] is False:
        blockers.append("known_order_snapshot_changed")
    if known["known_orders_all_terminal"] is False:
        blockers.append("known_order_not_terminal")
    if open_order_rows:
        blockers.append("open_orders_present")

    timestamp = getattr(clock, "timestamp", None)
    if isinstance(timestamp, datetime):
        timestamp = timestamp.astimezone(timezone.utc).isoformat()
    elif not isinstance(timestamp, str):
        raise RuntimeError("clock_timestamp_missing")

    return {
        "schema_version": 1,
        "check": "paper_broker_audit",
        "result": "PASS",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "broker_endpoint": endpoint,
        "account_status": _enum(getattr(account, "status", "")),
        "market_open": bool(getattr(clock, "is_open", False)),
        "clock_timestamp": timestamp,
        "position_count": len(position_rows),
        "open_order_count": len(open_order_rows),
        "position_snapshot_sha256": broker_hash,
        "source_position_snapshot_sha256": source_hash,
        "source_positions_match": None if source_hash is None else source_hash == broker_hash,
        "recovery_compatible": not blockers if runtime_dir is not None else None,
        "recovery_blockers": blockers,
        **known,
        "open_order_snapshot_sha256": _digest_rows(open_order_rows),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", type=Path)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(audit(args.runtime_dir), sort_keys=True))
        return 0
    except RuntimeError as exc:
        print(json.dumps({"check": "paper_broker_audit", "result": "FAIL", "reason": str(exc)}))
        return 1
    except Exception as exc:
        print(json.dumps({"check": "paper_broker_audit", "result": "FAIL", "reason": type(exc).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
