"""Read-only paper broker audit for handoff recovery decisions.

This command never submits, cancels, replaces, or modifies an order. Output is
sanitized so it can be uploaded as a short-lived diagnostic artifact without
including account IDs, order IDs, symbols, quantities, or credentials.
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any

from broker_mode import resolve_broker_mode


def _enum(value: Any) -> str:
    return str(getattr(value, "value", value)).lower()


def _digest_rows(rows: list[dict[str, Any]]) -> str:
    raw = json.dumps(rows, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    return hashlib.sha256(raw).hexdigest()


def audit() -> dict[str, Any]:
    mode = resolve_broker_mode()
    if not mode.is_paper:
        raise RuntimeError("paper_mode_required")
    from trade import _get_client

    client = _get_client()
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
    positions = list(client.get_all_positions())
    # The endpoint is read-only; the explicit limit also prevents an incomplete
    # audit from being mistaken for a complete snapshot.
    if len(positions) > 500:
        raise RuntimeError("positions_snapshot_incomplete")
    open_orders = list(client.get_orders())
    if len(open_orders) > 500:
        raise RuntimeError("open_orders_snapshot_incomplete")

    position_rows = []
    for position in positions:
        symbol = str(getattr(position, "symbol", ""))
        qty = float(getattr(position, "qty", 0.0))
        side = _enum(getattr(position, "side", ""))
        if not symbol or not math.isfinite(qty) or qty <= 0 or side != "long":
            raise RuntimeError("ambiguous_position")
        position_rows.append({"symbol": symbol, "qty": qty, "side": side})
    position_rows.sort(key=lambda row: row["symbol"])

    order_rows = []
    for order in open_orders:
        order_rows.append(
            {
                "id": str(getattr(order, "id", "")),
                "client_order_id": str(getattr(order, "client_order_id", "")),
                "symbol": str(getattr(order, "symbol", "")),
                "side": _enum(getattr(order, "side", "")),
                "status": _enum(getattr(order, "status", "")),
                "qty": str(getattr(order, "qty", "")),
            }
        )
    order_rows.sort(key=lambda row: (row["id"], row["client_order_id"]))

    timestamp = getattr(clock, "timestamp", None)
    if isinstance(timestamp, datetime):
        timestamp = timestamp.astimezone(timezone.utc).isoformat()
    elif isinstance(timestamp, str):
        timestamp = timestamp
    else:
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
        "open_order_count": len(order_rows),
        "position_snapshot_sha256": _digest_rows(position_rows),
        "open_order_snapshot_sha256": _digest_rows(order_rows),
    }


def main() -> int:
    try:
        print(json.dumps(audit(), sort_keys=True))
        return 0
    except Exception:
        print(json.dumps({"check": "paper_broker_audit", "result": "FAIL"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
