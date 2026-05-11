"""One-time backfill — fill missing cash + num_positions in daily_history.

The earlier schema only stored equity per day. After adding cash and
num_positions to each entry (so the dashboard can render three curves)
the existing 12 historical entries remained incomplete.

This script walks every git commit that touched state/performance.json,
extracts (date → cash, num_positions) from the top-level snapshot in
each commit, and fills the gaps in daily_history. Idempotent — entries
that already have cash and num_positions are left untouched.

Run once:
    python3 scripts/backfill_daily_history.py
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PERFORMANCE_PATH = PROJECT_ROOT / "state" / "performance.json"


def get_commits_touching_performance() -> list[str]:
    """Return commit SHAs (oldest first) that modified state/performance.json."""
    result = subprocess.run(
        ["git", "log", "--reverse", "--pretty=format:%H", "--", "state/performance.json"],
        cwd=PROJECT_ROOT,
        capture_output=True, text=True, check=True,
    )
    return [line for line in result.stdout.strip().split("\n") if line]


def get_performance_at_commit(sha: str) -> dict | None:
    try:
        result = subprocess.run(
            ["git", "show", f"{sha}:state/performance.json"],
            cwd=PROJECT_ROOT,
            capture_output=True, text=True, check=True,
        )
        return json.loads(result.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        return None


def build_date_map() -> dict[str, dict]:
    """For each commit's snapshot, record cash + num_positions keyed by date.

    Last commit per day wins (so end-of-day numbers are preferred over
    intraday snapshots).
    """
    date_map: dict[str, dict] = {}
    for sha in get_commits_touching_performance():
        perf = get_performance_at_commit(sha)
        if not perf:
            continue
        updated = perf.get("updated_at", "")
        if not updated:
            continue
        day = updated.split()[0]
        cash = perf.get("cash")
        num_pos = perf.get("num_positions")
        if cash is None and num_pos is None:
            continue
        date_map[day] = {"cash": cash, "num_positions": num_pos}
    return date_map


def main() -> None:
    date_map = build_date_map()
    print(f"Built date map: {len(date_map)} unique dates with cash/positions data")

    with open(PERFORMANCE_PATH) as f:
        perf = json.load(f)

    history = perf.get("daily_history", [])
    filled = 0
    skipped_complete = 0
    skipped_no_data = 0

    for entry in history:
        day = entry.get("date")
        if not day:
            continue
        if entry.get("cash") is not None and entry.get("num_positions") is not None:
            skipped_complete += 1
            continue
        if day not in date_map:
            skipped_no_data += 1
            continue
        entry["cash"] = date_map[day]["cash"]
        entry["num_positions"] = date_map[day]["num_positions"]
        filled += 1
        print(f"  {day}: cash=${date_map[day]['cash']:>12,.2f}  positions={date_map[day]['num_positions']}")

    perf["daily_history"] = history
    with open(PERFORMANCE_PATH, "w") as f:
        json.dump(perf, f, indent=2, default=str)

    print(f"\nFilled {filled} entries, {skipped_complete} already complete, {skipped_no_data} had no git data")


if __name__ == "__main__":
    main()
