"""Rebuild state/backtest/manifest.json from whatever is on disk under runs/.

The manifest is just an index — every entry's source of truth lives in
the corresponding state/backtest/runs/{id}.json file. So whenever a
workflow encounters a merge conflict on manifest.json (e.g. another
backtest committed between this one's git pull and git push), we can
sidestep the conflict entirely by:

  1. Discarding the local manifest
  2. Pulling latest (gets every concurrent runs/X.json)
  3. Regenerating manifest from the merged-on-disk runs/ contents

That's exactly what this script does — invoked from the workflow's
push step to make manifest commits collision-proof.

Idempotent: re-running on identical disk state produces identical output.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, save_json, get_now_str  # noqa: E402
from backtest.manifest import _extract_summary  # noqa: E402

RUNS_DIR = PROJECT_ROOT / "state" / "backtest" / "runs"
MANIFEST_PATH = PROJECT_ROOT / "state" / "backtest" / "manifest.json"


def main() -> None:
    if not RUNS_DIR.exists():
        print(f"No runs directory at {RUNS_DIR} — writing empty manifest")
        save_json(MANIFEST_PATH, {"updated_at": get_now_str(), "runs": []})
        return

    runs: list[dict] = []
    for f in sorted(RUNS_DIR.glob("*.json")):
        try:
            payload = json.loads(f.read_text())
        except json.JSONDecodeError as e:
            print(f"  skipping {f.name}: malformed JSON ({e})")
            continue
        kind = payload.get("kind", "unknown")
        runs.append({
            "id": payload.get("run_id") or f.stem,
            "kind": kind,
            "generated_at": payload.get("generated_at"),
            "start_date": (
                payload.get("config", {}).get("start_date")
                or payload.get("start_date")
            ),
            "end_date": (
                payload.get("config", {}).get("end_date")
                or payload.get("end_date")
            ),
            "filename": f"runs/{f.name}",
            "summary": _extract_summary(kind, payload),
        })

    runs.sort(key=lambda r: r.get("generated_at") or "", reverse=True)

    save_json(MANIFEST_PATH, {
        "updated_at": get_now_str(),
        "runs": runs,
    })
    print(f"Rebuilt manifest from {len(runs)} archived runs")


if __name__ == "__main__":
    main()
