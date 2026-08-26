"""Forward paper experiment harness — graduated gate vs V11.

Pre-registered in strategy/experiments/graduated_gate_forward_protocol.md. This
re-runs both arms (V11 incumbent and the floor-50 challenger) from the FROZEN
epoch start on whatever data is currently cached, and appends a dated snapshot
to state/experiments/graduated_gate_forward.json.

Paper/shadow only: it runs the backtest engine on data and places no orders. The
design is frozen — this file must not change the floor value or add variants.

Usage:
    python3 scripts/experiments/graduated_gate_forward.py            # append a snapshot
    python3 scripts/experiments/graduated_gate_forward.py --stamp 2026-08-25T00:00:00Z
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backtest"))

from experiment import run_experiment  # noqa: E402

# FROZEN by the pre-registration. Do not edit.
EPOCH_START = "2026-08-25"
FLOOR_PCT = 50
MIN_FORWARD_SESSIONS = 10  # below this, a comparison is noise; snapshot but don't judge

RECORD = os.path.join(os.path.dirname(__file__), "..", "..",
                      "state", "experiments", "graduated_gate_forward.json")


def _spy_path() -> str:
    return os.path.join(os.path.dirname(__file__), "..", "..",
                        "state", "backtest", "bars", "SPY.json")


def _latest_data_date() -> str | None:
    try:
        with open(_spy_path()) as fh:
            return json.load(fh).get("to")
    except Exception:
        return None


def _forward_sessions(end: str) -> int:
    """SPY trading sessions strictly after the epoch start, up to `end`. The
    forward window only has evidence once at least a couple of sessions have
    actually completed past the epoch — before that, any backtest metric is a
    divide-by-nothing artifact and must not be recorded as if it meant anything.
    """
    try:
        with open(_spy_path()) as fh:
            bars = json.load(fh).get("bars", [])
        return sum(1 for b in bars if EPOCH_START < str(b.get("date", "")) <= end)
    except Exception:
        return 0


def _pick(metrics: dict) -> dict:
    keys = ("annual_return_pct", "spy_annual_return_pct", "excess_cagr_pct",
            "jensen_alpha_annual_pct", "beta_to_spy", "information_ratio",
            "sharpe_ratio", "max_drawdown_pct", "n_trades", "n_trading_days")
    return {k: metrics.get(k) for k in keys if k in metrics}


def main(argv: list[str]) -> int:
    stamp = None
    if "--stamp" in argv:
        stamp = argv[argv.index("--stamp") + 1]

    end = _latest_data_date()
    snapshot: dict = {
        "generated_at": stamp,          # supplied by the caller/scheduler
        "epoch_start": EPOCH_START,
        "floor_pct": FLOOR_PCT,
        "data_boundary": end,
        "protocol": "strategy/experiments/graduated_gate_forward_protocol.md",
    }

    fwd = _forward_sessions(end) if (end and end >= EPOCH_START) else 0
    snapshot["forward_sessions"] = fwd
    if fwd < 2:
        # Not enough completed sessions past the epoch to compute anything
        # meaningful — record the registration, not a divide-by-nothing metric.
        snapshot["status"] = "PENDING_FORWARD_DATA"
        snapshot["note"] = (
            f"Only {fwd} forward session(s) so far (data ends {end}, epoch "
            f"{EPOCH_START}). The experiment is registered; evidence accrues as "
            "time passes."
        )
        _append(snapshot)
        print(json.dumps(snapshot, indent=2))
        return 0

    incumbent = run_experiment("v11_incumbent", {}, EPOCH_START, end)
    challenger = run_experiment(
        f"floor{FLOOR_PCT}", {"*": {"momentum_below_sma200_floor_pct": FLOOR_PCT}},
        EPOCH_START, end,
    )
    inc_m = incumbent.get("metrics", incumbent)
    chl_m = challenger.get("metrics", challenger)

    snapshot["status"] = "ACCRUING" if fwd < MIN_FORWARD_SESSIONS else "COMPARABLE"
    snapshot["incumbent"] = _pick(inc_m)
    snapshot["challenger"] = _pick(chl_m)
    snapshot["note"] = (
        "Forward metrics are still noisy (below the minimum session count); the "
        "verdict is only evaluated once the protocol's window criteria are met."
        if fwd < MIN_FORWARD_SESSIONS
        else "Forward metrics; the verdict is only evaluated once the window closes."
    )
    _append(snapshot)
    print(json.dumps(snapshot, indent=2))
    return 0


def _append(snapshot: dict) -> None:
    history = []
    if os.path.exists(RECORD):
        try:
            with open(RECORD) as fh:
                history = json.load(fh).get("snapshots", [])
        except Exception:
            history = []
    history.append(snapshot)
    os.makedirs(os.path.dirname(RECORD), exist_ok=True)
    with open(RECORD, "w") as fh:
        json.dump({
            "experiment": "graduated_gate_forward",
            "epoch_start": EPOCH_START,
            "floor_pct": FLOOR_PCT,
            "protocol": "strategy/experiments/graduated_gate_forward_protocol.md",
            "snapshots": history,
        }, fh, indent=2)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
