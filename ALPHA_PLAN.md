# Alpha Improvement Plan — Path to +5–10%/yr OOS alpha

## Goal recalibration

| Old goal (CLAUDE.md) | New goal |
|---|---|
| Beat SPY by **+5% per month** (~+80%/yr) | Beat SPY by **+5–10% per year** (OOS, walk-forward measured) |

The old goal was off by ~70pp from any backtest evidence and would not be
achieved by any disciplined retail momentum strategy. The new goal is at the
high end of what a sophisticated multi-strategy retail system can sustain,
but it is achievable given the existing module library.

## Diagnosis (from existing backtests, 2026-05-19)

| Metric | Value | Implication |
|---|---|---|
| IS annual alpha (5-yr) | −2.42% | Strategy is closet-beta after costs |
| OOS WF mean alpha | −7.4% | 5pp overfitting gap — large |
| MC prob beat SPY | 6.5% | Edge is statistically marginal |
| Top contributor | SSO (leveraged SPY) | 100% of cumulative P&L from BULL regime |
| Documented ceiling | v7 | v8, v9 regressed despite added complexity |

**Root causes** (hypotheses to validate via ablation):
1. Modules (PEAD, ML, sentiment, mean-rev, multi-tf) may be net-negative —
   never measured individually since v7.
2. Sweep optimizes IS metrics → params overfit (5pp OOS gap).
3. RS measured vs SPY, not sector — picks beta exposure, not selection alpha.
4. Position sizing fixed-%, not vol-targeted — high-vol names dominate risk.
5. No monitoring → silent live-vs-backtest drift possible.

## Phase plan

Each phase is one commit, one backtest (or doc-only), one GH issue.

### Phase A — Module ablation flags
Add `ABLATE_*` environment-variable flags (and CLI args to backtest engine)
that disable each contributing module at runtime:
- `ABLATE_ML` — skip ML signal contribution
- `ABLATE_PEAD` — skip PEAD overlay
- `ABLATE_MEAN_REV` — skip mean-reversion overlay
- `ABLATE_SENTIMENT` — skip sentiment scoring
- `ABLATE_MULTI_TF` — skip multi-timeframe adjustment
- `ABLATE_EARNINGS_FILTER` — skip earnings-risk filter
- `ABLATE_SECTOR_ROT` — skip sector rotation overlay

Touches: `execute_trades.py`, `research.py`, `backtest/engine.py`.

**Exit criterion:** Each flag toggles the named module on/off without
otherwise changing behavior.

### Phase B — Walk-forward as primary sweep metric
Modify `scripts/backtest/sweep.py` to optimize **mean OOS WF alpha** instead
of single-run IS alpha. Add a `holdout_set` config that excludes 2025-01-01
through present from all tuning windows — used only for final verification.

Touches: `scripts/backtest/sweep.py`, `scripts/backtest/walk_forward.py`.

**Exit criterion:** `python3 scripts/backtest/sweep.py --metric wf_alpha`
returns best params by WF alpha and skips holdout window.

### Phase C — Sector-relative RS
Compute RS as `stock_20d_return − sector_etf_20d_return` instead of
`stock_20d_return − SPY_20d_return`. Sector ETF mapping table in
`strategy_config.py` (XLK for tech, XLF for financials, etc.). Falls back to
SPY if sector unknown.

Touches: `scripts/research.py` (RS computation), `scripts/strategy_config.py`
(sector map), `scripts/backtest/engine.py` (mirror change).

**Exit criterion:** RS values change for stocks in well-known sectors;
backtest re-runs without error.

### Phase D — Volatility-targeted position sizing
Replace fixed `max_position_pct` cap with a per-name vol budget. Each name's
weight = `(target_portfolio_vol_contribution) / (name_20d_vol)`, then clip to
absolute max. New `target_vol_per_position_pct` param in `strategy_config.py`
(default 0.5%, tunable per regime).

Touches: `scripts/execute_trades.py` (sizing function),
`scripts/backtest/engine.py` (sizing function), `scripts/strategy_config.py`.

**Exit criterion:** High-vol names (MSTR, SMCI) get smaller %, low-vol names
(MSFT, JNJ) get larger % within the same risk budget.

### Phase E — Wire gap_scanner as screener source
`scripts/gap_scanner.py` exists but is imported nowhere. Add it as a 4th
candidate source in `screener.py` and contribute a `gap_score` component to
the overall confidence score. Gaps of +3–8% on >2× volume = high-conviction
continuation setups.

Touches: `scripts/screener.py`, `scripts/research.py` (score component).

**Exit criterion:** `python3 scripts/screener.py full` includes gap-up names;
research.json has `gap_score` field.

### Phase F — Live-vs-backtest divergence monitor
New `scripts/monitor_drift.py`: compares rolling 30d realized alpha against
backtest expectation (mean ± σ from latest WF run). If realized < expected −
2σ for 5 consecutive days, opens a `[risk]` GH issue and sets `risk_tier =
CAUTIOUS` in `state/performance.json`.

Touches: new file `scripts/monitor_drift.py`, optional integration in midday
routine.

**Exit criterion:** Script runs daily, writes status to
`state/drift_status.json`, escalates risk tier on confirmed drift.

### Phase G — Routine heartbeat
Daily GitHub Action that checks `journal/YYYY-MM-DD.md` exists for each
expected trading day. If missing for >24h, opens an `[infra]` issue. Catches
silent routine failures (cron broken, secrets expired, etc.).

Touches: new `.github/workflows/heartbeat.yml`.

**Exit criterion:** Workflow runs at 5pm ET daily; opens issue if last journal
is >24h old on a trading day.

### Phase H — Tighter universe + liquidity filter
Add `universe_filter` step to screener: drop names with `<$10` close or
`<$5M` 30d average dollar volume. Tunable in `strategy_config.py`. Reduces
the screener-discovered universe by ~40% (low-quality tail).

Touches: `scripts/screener.py`, `scripts/strategy_config.py`.

**Exit criterion:** Penny stocks and thinly-traded names absent from screener
output.

### Phase I — Recalibrate goal in docs
Update `CLAUDE.md` (Identity & Goal section) and `strategy/sp500_benchmark.md`
to state the new +5–10%/yr alpha goal. Add a "How we measure" subsection
referencing walk-forward as the source of truth.

Touches: `CLAUDE.md`, `strategy/sp500_benchmark.md`.

**Exit criterion:** Documentation reflects new goal; no mention of "+5%/month"
remains.

### Phase J — Validation backtests
After Phases A–I:
1. Run baseline backtest (current v7, all modules on).
2. Run 7 ablation backtests (each module off in turn).
3. Identify net-negative modules (alpha *rises* when removed).
4. Run final WF backtest with the surviving config.
5. Document deltas in `journal/2026-05-19.md` and a closing GH issue
   comment.

**Exit criterion:** Either:
- WF mean OOS alpha ≥ +5%/yr → ship, lock params, set this as v10.
- WF still < 0% → escalate: edge is structurally insufficient on this
  universe; next iteration needs new edge source (e.g., earnings-driven
  PEAD as primary, not overlay).

## Risk register

| Risk | Mitigation |
|---|---|
| Ablation reveals every module is net-negative | Fall back to "raw v7 momentum top-N + SSO base only" — still beats nothing |
| Vol-targeting changes equity curve shape unfavorably | Phase D is one commit, easy revert |
| Sector-relative RS over-concentrates in one sector | Existing 25% sector cap still applies |
| Monitor false-alarms | 2σ + 5-day confirmation threshold conservative |
| One-shot implementation produces v10 that regresses | Each phase commits separately; bisect-friendly |

## Out of scope (deferred)

- Options-based hedge (SH replacement) — separate initiative, requires
  approved options trading on the Alpaca account
- Live ML retraining — current `ml_signals.py` is static; retrain workflow
  is its own project
- Multi-account / margin — paper trading only for now
