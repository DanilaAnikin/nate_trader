# Pre-registration — graduated-gate forward paper experiment

**Registered:** 2026-08-25 (frozen before any forward data exists).
**Branch:** `research/graduated-gate` (never merged to main — editing the strategy
sources changes V11's identity hash; the production V11 is untouched).

This document is a **pre-registration**: the design, the start date, the
evaluation window, and the success criteria are fixed here, in writing, *before*
the forward data that will judge them exists. Nothing below may be changed once
forward data has accrued — that is the whole point. If the design turns out to
be wrong, the honest outcome is to record that it was wrong.

## Motivation

The fixed-parameter validator shows V11 trailing SPY in the 2025–2026 reused
check (excess −2.8 pp @15bps), and a backtest attributes it to the all-or-nothing
SPY-SMA200 exit to 100% cash: it sold into dips, sat in cash through the rebound,
and re-entered higher (a whipsaw cost). A backtest of a graduated gate (an
exposure floor below SMA200) improved both the development and reused periods —
but that is in-sample / already-inspected data and is **not** evidence. This
experiment exists to get **fresh** evidence.

## Frozen design (the only variant tested)

- **Challenger:** V11 with `momentum_below_sma200_floor_pct = 50`. Below SMA200
  the book keeps up to 50% gross (scaled by the ordinary breadth/vol/
  diversification scalers) instead of exiting to cash. Every other parameter is
  the fixed V11 policy, unchanged.
- **Incumbent:** V11 exactly as deployed (`floor = 0`, hard exit).
- **Benchmark:** SPY (adjusted close).
- **Cost scenarios:** 7 bps and 15 bps (15 bps is primary).
- **No other variants.** No re-tuning of the floor, no grid, no mid-experiment
  additions. Testing more values later would reintroduce the multiple-testing
  bias this experiment exists to avoid.

## Forward window

- **Epoch start:** 2026-08-25. Only sessions on or after this date count as
  forward evidence. All prior data is inspected and excluded from the verdict.
- The harness (`scripts/experiments/graduated_gate_forward.py`) re-runs both
  arms from the epoch start on the latest available data each time it runs, and
  appends a dated snapshot to `state/experiments/graduated_gate_forward.json`.

## Success criteria (evaluated only after the window closes)

Evaluate **once**, after BOTH of these hold:
1. at least **6 completed monthly rebalances** since the epoch start, AND
2. at least **one down-market month** in the window (SPY monthly return < −3%),
   so the gate is actually exercised.

On the **forward-only** window, at 15 bps, the challenger is judged **better**
only if ALL hold:
- challenger excess CAGR vs SPY > incumbent excess CAGR vs SPY, AND
- challenger max drawdown is not worse than incumbent by more than 3 pp, AND
- challenger information ratio ≥ incumbent.

Otherwise the verdict is **retain V11**. A single positive forward window is
still not a promotion: promotion additionally requires passing the canonical
fixed-parameter validator and a re-cut release. This experiment can only make
the challenger *eligible to be considered*, never authorize live money.

## Discipline

- The verdict is reported whatever it is — a negative result is a real result.
- The floor value (50%) is frozen; it will not be re-optimized to the forward
  data.
- Paper/shadow only. The harness runs the backtest engine on data; it places no
  orders and does not touch the production trader or any broker.
