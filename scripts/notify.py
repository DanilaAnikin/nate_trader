"""Notifications via ClickUp API — trade alerts, daily recaps, weekly reports."""

import sys
import requests

from utils import (
    CLICKUP_API_KEY, CLICKUP_LIST_ID,
    setup_logging, get_now_str, get_today_str,
)

log = setup_logging("notify")

CLICKUP_BASE = "https://api.clickup.com/api/v2"


def send_clickup_task(name: str, description: str, priority: int = 3, tags: list[str] = None) -> dict:
    """Create a task in ClickUp.

    Priority: 1=urgent, 2=high, 3=normal, 4=low
    """
    if not CLICKUP_API_KEY or not CLICKUP_LIST_ID:
        log.warning("ClickUp API key or List ID not configured. Skipping notification.")
        return {"status": "skipped", "reason": "Missing ClickUp config"}

    url = f"{CLICKUP_BASE}/list/{CLICKUP_LIST_ID}/task"
    headers = {
        "Authorization": CLICKUP_API_KEY,
        "Content-Type": "application/json",
    }
    payload = {
        "name": name,
        "description": description,
        "priority": priority,
        "tags": tags or [],
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        task_id = data.get("id", "unknown")
        log.info(f"ClickUp task created: {name} (ID: {task_id})")
        return {"status": "created", "task_id": task_id, "name": name}
    except requests.exceptions.HTTPError as e:
        log.error(f"ClickUp API error: {e} — {e.response.text if e.response else ''}")
        return {"status": "error", "error": str(e)}
    except Exception as e:
        log.error(f"ClickUp notification failed: {e}")
        return {"status": "error", "error": str(e)}


def send_trade_alert(symbol: str, side: str, qty: int, price: float, reason: str) -> dict:
    """Send a trade execution alert."""
    name = f"{'BUY' if side.lower() == 'buy' else 'SELL'} {qty} {symbol} @ ${price:.2f}"
    description = (
        f"**Trade Alert** — {get_now_str()}\n\n"
        f"- **Symbol**: {symbol}\n"
        f"- **Side**: {side.upper()}\n"
        f"- **Quantity**: {qty}\n"
        f"- **Price**: ${price:.2f}\n"
        f"- **Value**: ${qty * price:,.2f}\n"
        f"- **Reason**: {reason}\n"
    )
    priority = 2  # high
    return send_clickup_task(name, description, priority, tags=["trade", side.lower()])


def send_daily_recap(summary: str) -> dict:
    """Send end-of-day recap."""
    name = f"Daily Recap — {get_today_str()}"
    description = f"**End-of-Day Summary**\n\n{summary}"
    return send_clickup_task(name, description, priority=3, tags=["daily-recap"])


def send_weekly_report(summary: str) -> dict:
    """Send weekly performance report."""
    name = f"Weekly Report — {get_today_str()}"
    description = f"**Weekly Performance Report**\n\n{summary}"
    return send_clickup_task(name, description, priority=3, tags=["weekly-report"])


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "test"

    if cmd == "test":
        result = send_clickup_task(
            name=f"Nate Trader Test — {get_now_str()}",
            description="This is a test notification from Nate Trader. If you see this, ClickUp integration is working!",
            priority=4,
            tags=["test"],
        )
        print(f"\nClickUp Test Result:")
        print(f"  Status: {result['status']}")
        if result['status'] == 'created':
            print(f"  Task ID: {result['task_id']}")
        elif result['status'] == 'error':
            print(f"  Error: {result['error']}")
        elif result['status'] == 'skipped':
            print(f"  Reason: {result['reason']}")

    else:
        print("Usage: python3 notify.py test")
