"""Backtest run history manifest.

Every backtest run is stored two ways:

  • state/backtest/runs/{id}.json         — full result (archived)
  • state/backtest/{kind}_result.json     — legacy "latest" pointer
                                            (kept for dashboard backward compat)

The manifest at state/backtest/manifest.json is the index — small
metadata per run for the Run History list view in the dashboard.

ID format:   {kind}_{YYYYMMDD}_{HHMMSS}
Examples:    single_20260512_143000
             monte_carlo_20260513_080000
             walk_forward_20260514_023000
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from utils import PROJECT_ROOT, load_json, save_json, get_now_str  # noqa: E402

BACKTEST_DIR = PROJECT_ROOT / "state" / "backtest"
RUNS_DIR = BACKTEST_DIR / "runs"
MANIFEST_PATH = BACKTEST_DIR / "manifest.json"


def make_run_id(kind: str) -> str:
    """Build a unique run id: kind normalised + timestamp."""
    now = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = kind.replace("-", "_")
    return f"{safe}_{now}"


def _extract_summary(kind: str, payload: dict) -> dict:
    """Pull a tiny per-kind summary out of the full result for the manifest.

    Keeps the manifest light enough to load in a single round-trip even
    after dozens of runs — dashboard list view doesn't need the full daily
    history, just the headline numbers.
    """
    if kind == "single":
        m = payload.get("metrics", {})
        return {
            "total_return_pct": m.get("total_return_pct"),
            "annual_return_pct": m.get("annual_return_pct"),
            "alpha_annual_pct": m.get("alpha_annual_pct"),
            "sharpe_ratio": m.get("sharpe_ratio"),
            "max_drawdown_pct": m.get("max_drawdown_pct"),
            "n_trades": m.get("n_trades"),
        }
    if kind == "sweep":
        results = payload.get("results", [])
        valid = [r for r in results if r.get("metrics", {}).get("alpha_annual_pct") is not None]
        best = max(valid, key=lambda r: r["metrics"]["alpha_annual_pct"]) if valid else {}
        return {
            "n_combinations": len(results),
            "best_alpha_annual_pct": best.get("metrics", {}).get("alpha_annual_pct"),
            "best_params": best.get("params"),
        }
    if kind == "monte_carlo":
        return {
            "n_simulations": payload.get("n_simulations"),
            "median_alpha_pct": payload.get("median_alpha_pct"),
            "p5_alpha_pct": payload.get("p5_alpha_pct"),
            "p95_alpha_pct": payload.get("p95_alpha_pct"),
            "prob_beat_spy_pct": payload.get("prob_beat_spy_pct"),
            "median_max_dd_pct": payload.get("median_max_dd_pct"),
        }
    if kind == "walk_forward":
        agg = payload.get("aggregate", {})
        return {
            "n_windows": agg.get("n_windows"),
            "mean_oos_alpha_annual_pct": agg.get("mean_oos_alpha_annual_pct"),
            "mean_oos_sharpe": agg.get("mean_oos_sharpe"),
            "mean_oos_max_drawdown_pct": agg.get("mean_oos_max_drawdown_pct"),
        }
    if kind == "compare":
        delta = payload.get("delta", {})
        return {
            "alpha_annual_pp": delta.get("alpha_annual_pp"),
            "sharpe_delta": delta.get("sharpe"),
            "max_dd_pp": delta.get("max_dd_pp"),
            "challenger_params": payload.get("challenger", {}).get("params"),
        }
    return {}


def record_run(kind: str, payload: dict, latest_path: Path | None = None) -> str:
    """Save a backtest run to both runs/ and the legacy latest file, then
    update the manifest. Returns the run id."""
    BACKTEST_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)

    run_id = make_run_id(kind)
    payload = {**payload, "run_id": run_id}

    archive_path = RUNS_DIR / f"{run_id}.json"
    save_json(archive_path, payload)

    if latest_path is not None:
        save_json(latest_path, payload)

    # Update manifest
    manifest = load_json(MANIFEST_PATH) or {}
    runs = manifest.get("runs", [])
    entry = {
        "id": run_id,
        "kind": kind,
        "generated_at": payload.get("generated_at") or get_now_str(),
        "start_date": payload.get("config", {}).get("start_date")
                      or payload.get("start_date"),
        "end_date": payload.get("config", {}).get("end_date")
                    or payload.get("end_date"),
        "filename": f"runs/{run_id}.json",
        "summary": _extract_summary(kind, payload),
    }
    runs.append(entry)
    runs.sort(key=lambda r: r.get("generated_at", ""), reverse=True)

    manifest["runs"] = runs
    manifest["updated_at"] = get_now_str()
    save_json(MANIFEST_PATH, manifest)

    return run_id


def list_runs(kind: str | None = None) -> list[dict]:
    manifest = load_json(MANIFEST_PATH) or {}
    runs = manifest.get("runs", [])
    if kind is not None:
        runs = [r for r in runs if r.get("kind") == kind]
    return runs


def load_run(run_id: str) -> dict | None:
    path = RUNS_DIR / f"{run_id}.json"
    if not path.exists():
        return None
    return load_json(path)
