# V11 underperformance diagnosis — 2025–2026 reused check

**Date:** 2026-08-23 · **Data:** full adjusted rebuild through 2026-08-21 (549-symbol
watchlist) · **Validator:** `scripts/backtest/validate_v11.py`, fixed parameters, no
optimizer.

## Verdict

`PROMOTION GATE: FAIL` — allowed mode dry-run/shadow-research-only. V11 is correctly
halted; this is a strategy result, not a bug. It must not be promoted, resumed, or
wired to real money on this evidence.

## The numbers (per segment, both cost scenarios)

| Segment | Cost | V11 CAGR | SPY CAGR | Excess | Jensen α | Beta | Sharpe | Max DD | Win% | Trades |
|---|---|---|---|---|---|---|---|---|---|---|
| Development 2021→2024 | 7 bps | 18.84% | 13.64% | **+5.20** | +9.29% | 0.71 | 0.72 | −33.5% | 57.4 | 338 |
| Development 2021→2024 | 15 bps | 17.82% | 13.64% | **+4.18** | +8.42% | 0.71 | 0.69 | −34.5% | 56.4 | 337 |
| Reused check 2025→2026 | 7 bps | 15.52% | 18.77% | **−3.24** | +5.14% | 0.54 | 0.58 | −15.8% | 62.9 | 132 |
| Reused check 2025→2026 | 15 bps | 13.80% | 18.77% | **−4.96** | +3.66% | 0.51 | 0.51 | −15.9% | 63.2 | 133 |

## Root cause: too defensive in a strong bull, not bad stock-picking

1. **SPY ran hard.** SPY returned **+18.8%/yr** in 2025–2026 vs +13.6%/yr in the
   development era — a strong, largely uninterrupted bull.
2. **V11 de-risked into it.** Beta fell from 0.71 to **0.54**. The SPY-SMA200 gate
   plus breadth scaling took the book to **100% cash twice** (2025-04-03 and
   2026-03-27, both BEAR classifications). With ~half the market exposure, a
   strategy structurally cannot keep pace with an 18.8% SPY.
3. **The picks were fine; the exposure wasn't.** Win rate actually *rose* to 63%
   and **Jensen alpha stayed positive** (+3.7% to +5.1%). Risk-adjusted, V11 was
   not bad — it simply didn't take enough market risk, so raw excess CAGR went
   negative.
4. **Cost drag is secondary but real.** Excess is −3.24% at 7 bps and −4.96% at
   15 bps → ~**1.7 pp** of the gap is turnover/slippage, not selection.
5. **The trade-off is genuine, not a defect.** The same machinery that capped the
   upside also **halved the drawdown** (−16% here vs −34% in development). V11 is
   built to lose less in bad markets; the price is lagging in a rip-roaring one.

## Data-quality note

The May-2026 watchlist carries 7 names now delisted/merged (EA, EQR, LBRDA, NSA,
SAIL, SOFI, WBS); 5 failed the data refresh outright. The validator flags this as a
coverage failure independent of the alpha result. Cleaning the watchlist would give
a cleaner FAIL but would not change the verdict — the alpha shortfall stands on its
own.

## Honest improvement hypotheses (to be tested FORWARD, never fitted here)

The 2025–2026 window has already been inspected; any change tuned to "pass" it is
overfitting, not evidence. The epoch-1 tournament already tested 10 challengers
(risk-adjusted, market-residual, sector-neutral, low-vol, etc.) and **none** beat
V11 on all gates. With that caveat, the diagnosis points at *exposure*, not picks:

- **Partial de-risk instead of all-or-nothing cash.** A floor on gross exposure
  (or a shallower breadth ladder) would raise beta and bull capture — at the cost
  of some drawdown protection. This is the highest-leverage lever and the most
  dangerous to overfit.
- **Faster, less latched re-entry.** The one-shot recovery re-entry can leave the
  book flat through a V-shaped rebound; a quicker re-entry rule may recover missed
  upside.
- **Lower turnover / cost.** ~1.7 pp of the gap is cost; a wider drift band or
  less frequent rebalancing could recover part of it with no signal change.
- **Universe maintenance.** Refresh the watchlist / stand up the dynamic
  common-stock universe so delisted names don't distort coverage.

**The only thing that can validate any of these is future frozen-rule forward paper
performance across several monthly rebalances, including at least one weak market.**
Backtest "improvements" on this reused window are not evidence and must not be
promoted or wired to real money.


## Empirical confirmation (2026-08-24/25)

Two follow-ups, on data refreshed through 2026-08-21:

1. **Universe hygiene helps, but does not fix it.** Removing 5 delisted names
   (EA, LBRDA, NSA, SAIL, SOFI) from the watchlist lifted the reused-period
   excess from -4.96% to **-2.81%** at 15 bps (-1.91% at 7 bps) -- the delisted
   names were a real drag -- but the gate still **FAILS**: V11 still trails SPY
   in the bull. (EQR/WBS remain flagged only because their last bar is one
   session behind SPY's -- a freshness artifact, not a delisting.)

2. **Tuning the exposure parameters does nothing.** A "less-defensive" variant
   (lower max_cash_pct/min_cash_pct in NEUTRAL and BEAR, via the engine's
   research override) came out **indistinguishable from baseline** over
   2025->2026: alpha -2.01%/yr vs -1.91%/yr, same Sharpe (0.63), same drawdown
   (-15.9% vs -15.8%). The cash knobs are not what drive the de-risking.

**Conclusion -- the defensiveness is structural, not a parameter.** The all-or-
nothing move to 100% cash comes from the hardcoded SPY-SMA200 gate, not any
tunable field, so no override recovers the bull-capture. A genuine improvement
(a gross-exposure floor, or a graduated gate instead of a hard exit) is a *code
change to the gate* -- a new strategy variant with its own identity and its own
validation -- and, because 2025-2026 is already inspected, it can only be
validated by FUTURE frozen forward paper performance. Nothing here may be
promoted, and it reinforces why V11 must not be wired to real money on this
evidence.


## Pre-registered experiment: a graduated gate (2026-08-25)

Hypothesis, fixed before running: the bull-lag is the all-or-nothing SPY-SMA200
exit to 100% cash. A graduated gate that keeps an exposure FLOOR below SMA200
(scaled by the usual breadth/vol/diversification scalers) instead of liquidating
should recover bull-capture. Implemented as a research param
`momentum_below_sma200_floor_pct` (default 0.0 = V11 unchanged, byte-for-byte);
tested at 30% and 50% on both segments, at the 7 bps research cost.

| Variant | Reused excess | Reused Sharpe / DD | Dev excess | Dev Sharpe / DD |
|---|---|---|---|---|
| baseline (hard exit) | -1.91 pp | 0.63 / -15.8% | +5.20 pp | 0.72 / -33.5% |
| floor 30% | -3.27 pp | 0.57 / -16.9% | +9.16 pp | 0.84 / -29.4% |
| floor 50% | +0.98 pp | 0.71 / -19.0% | +9.92 pp | 0.85 / -29.3% |

**What the data shows.** A 50% floor improves BOTH periods, and in the
development period it is a *Pareto* improvement — higher return AND lower
drawdown. That is the signature of a **whipsaw cost**: the hard exit sold into
dips, sat in cash through the rebound, and re-entered higher. A floor avoids the
worst of that. It even flips the reused excess marginally positive.

**What this is NOT.** It is not validation, and it must not be deployed or
promoted on this evidence:
- The reused 2025-2026 window is already inspected — a positive result there is
  not fresh out-of-sample evidence.
- The development period is in-sample by definition (the model was built on it).
- I tested two floor values and 50% won; picking the best of a small search is
  exactly the multiple-testing trap the gates exist to stop. "50%" is a round
  number, not a theoretically derived level.
- The results are at the optimistic 7 bps cost. At the realistic 15 bps the
  reused edge (+0.98 pp) is thin and likely negative; the dev improvement is more
  robust across costs but is in-sample.

**Honest conclusion.** The graduated gate is the most promising lead so far — the
whipsaw cost is real and visible — but it is a **hypothesis**, not a fix. The
only thing that can validate it is a PRE-REGISTERED forward paper experiment:
freeze one design (e.g. floor 50%) now, run it forward alongside V11 for several
monthly rebalances including a real down-market, and let FUTURE data decide.
Nothing here changes the production V11, and nothing here may be wired to real
money.

The experiment code (the graduated-gate param and the engine change) lives on
the `research/graduated-gate` branch. It is deliberately NOT merged to main:
editing scripts/adaptive_momentum.py or scripts/backtest/engine.py changes the
strategy-identity hash, so merging it would break the committed validation'''s
identity match. V11'''s identity on main is left untouched.

## Forward experiment — now running (2026-08-26)

The graduated-gate hypothesis is under a live, pre-registered forward paper test:

- **Protocol (frozen):** `strategy/experiments/graduated_gate_forward_protocol.md`
  (on `research/graduated-gate`) — floor-50 challenger vs V11 vs SPY, epoch
  2026-08-25, judged only after ≥6 monthly rebalances including a down-market
  month, against fixed success criteria set before any forward data existed.
- **Harness:** `scripts/experiments/graduated_gate_forward.py` — re-runs both
  arms from the frozen epoch on current data and appends a dated snapshot to
  `state/experiments/graduated_gate_forward.json`. Paper/shadow only; no broker.
- **Automation:** `.github/workflows/graduated-gate-shadow.yml` (on main) runs it
  weekly (and on demand), extending the record on `research/graduated-gate`. It
  never touches production, the release, the broker, or main's V11 identity.

The verdict is future work, settled by fresh market data — not by a backtest and
not by choice. Nothing here is promoted, and no live-money path exists.
