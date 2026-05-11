"""One-shot migration — promote legacy *_result.json files into the new
run archive + manifest.

Before the manifest landed every backtest mode overwrote a single
"latest" file at state/backtest/{kind}_result.json. That meant running
the same mode twice silently lost the first result. The new run.py
writes BOTH the latest pointer AND an archived copy in runs/, and
appends to manifest.json.

This script promotes the legacy latest files into the new layout
exactly as the new code would have:
   1. Read the existing `generated_at` from each *_result.json
   2. Synthesise a run id from that timestamp (kind + YYYYMMDD_HHMMSS)
   3. Copy the file into runs/{run_id}.json (with run_id field added)
   4. Append an entry to manifest.json

Idempotent: if the manifest already contains an entry for the file's
generated_at + kind, the migration skips it. Safe to re-run.

Usage:
   python3 scripts/backtest/migrate_legacy.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, load_json, save_json, get_now_str  # noqa: E402
from backtest.manifest import _extract_summary  # noqa: E402

BACKTEST_DIR = PROJECT_ROOT / "state" / "backtest"
RUNS_DIR = BACKTEST_DIR / "runs"
MANIFEST_PATH = BACKTEST_DIR / "manifest.json"

LEGACY_FILES = {
    "single":        BACKTEST_DIR / "latest_result.json",
    "sweep":         BACKTEST_DIR / "sweep_result.json",
    "monte_carlo":   BACKTEST_DIR / "monte_carlo_result.json",
    "walk_forward":  BACKTEST_DIR / "walk_forward_result.json",
    "compare":       BACKTEST_DIR / "comparison_result.json",
}


def _parse_generated_at(s: str) -> datetime:
    """Accept the formats utils.get_now_str() / get_today_str() produce."""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError(f"Unrecognized timestamp format: {s!r}")


def _synthesise_run_id(kind: str, generated_at: str) -> str:
    dt = _parse_generated_at(generated_at)
    return f"{kind}_{dt.strftime('%Y%m%d_%H%M%S')}"


def main() -> None:
    if not BACKTEST_DIR.exists():
        print(f"No backtest directory at {BACKTEST_DIR}; nothing to migrate.")
        return

    manifest = load_json(MANIFEST_PATH) or {}
    runs = manifest.get("runs", [])
    known = {(r.get("kind"), r.get("generated_at")) for r in runs}

    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    migrated = 0
    skipped_missing = 0
    skipped_existing = 0

    for kind, path in LEGACY_FILES.items():
        if not path.exists():
            skipped_missing += 1
            continue

        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError as e:
            print(f"  {path.name}: malformed JSON ({e}) — skipping")
            continue

        # If it already has a run_id (was written by post-archive run.py)
        # AND the manifest already lists it, no work to do.
        existing_run_id = payload.get("run_id")
        generated_at = payload.get("generated_at")

        if existing_run_id:
            # Already in new format — but archive file might be missing
            archive_path = RUNS_DIR / f"{existing_run_id}.json"
            if archive_path.exists() and (kind, generated_at) in known:
                skipped_existing += 1
                continue
            run_id = existing_run_id
        else:
            if not generated_at:
                print(f"  {path.name}: no generated_at; cannot synthesise run_id — skipping")
                continue
            if (kind, generated_at) in known:
                skipped_existing += 1
                continue
            try:
                run_id = _synthesise_run_id(kind, generated_at)
            except ValueError as e:
                print(f"  {path.name}: {e} — skipping")
                continue

        # Write archive copy with run_id stamped in
        payload = {**payload, "run_id": run_id, "kind": kind}
        archive_path = RUNS_DIR / f"{run_id}.json"
        save_json(archive_path, payload)

        # Build manifest entry — match new record_run() shape exactly
        entry = {
            "id": run_id,
            "kind": kind,
            "generated_at": generated_at or get_now_str(),
            "start_date": (
                payload.get("config", {}).get("start_date")
                or payload.get("start_date")
            ),
            "end_date": (
                payload.get("config", {}).get("end_date")
                or payload.get("end_date")
            ),
            "filename": f"runs/{run_id}.json",
            "summary": _extract_summary(kind, payload),
        }
        runs.append(entry)
        known.add((kind, generated_at))
        migrated += 1
        print(f"  ✓ {kind:<14}  {run_id}  →  runs/{run_id}.json")

    if migrated == 0:
        print(f"\nNothing to migrate. "
              f"({skipped_existing} already in manifest, "
              f"{skipped_missing} legacy files not present)")
        return

    runs.sort(key=lambda r: r.get("generated_at", ""), reverse=True)
    manifest["runs"] = runs
    manifest["updated_at"] = get_now_str()
    save_json(MANIFEST_PATH, manifest)

    print(f"\nMigrated {migrated} legacy run(s) into the archive.")
    print(f"Manifest now lists {len(runs)} run(s) total.")


if __name__ == "__main__":
    main()
