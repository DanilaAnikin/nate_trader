# Nate Trader — Agent Operating Manual

## Mission and status

Maintain and evaluate `v11-adaptive-momentum`, a causal US-equity momentum
strategy for **Alpaca paper trading only**. The objective is to test whether it
can produce positive benchmark-relative returns with controlled drawdown. Do
not promise alpha, profit, or flawless operation.

There is one supported scheduled trader:
`.github/workflows/paper-production.yml`. It runs only the V11 Alpaca paper
path after release and broker preflight, with a private artifact for persistent
runtime state. `.github/workflows/v11-release.yml` is the non-trading release
gate. The paper workflow must check out the full SHA in the environment variable
`PRODUCTION_RELEASE_SHA` and find a successful release gate for that exact SHA.
A push triggers tests but never directly submits an order. Do not restore the
archived optimizer/research/multi-account workflows.

The authoritative strategy document is
`strategy/v11_adaptive_momentum.md`. Older v3-v10 documents and code paths are
archive/audit references. They are not current policy, and their behavior and
historical dependencies are not guaranteed to remain reproducible.

## V11 production invariants

Preserve these defaults unless a change is explicitly requested and validated:

- Production uses exactly Python 3.12.11 and `requirements.lock`. The lock,
  paper workflow, preflight, and production runner are strategy-identity
  sources; changing any of them requires canonical revalidation.
- Production invokes only `scripts/production_run.py`, which delegates to the
  guarded V11 executor. Never add options, Supabase live-account telemetry,
  legacy sleeves, universe refresh, or direct `trade.py` mutations to that
  workflow.
- Runtime `performance.json`, `positions.json`, and production health state are
  restored from and saved to a private artifact named for the approved release
  SHA. Its schema and release lineage must pass before restore. These files must
  not be committed by the scheduled workflow.

- Signal at completed close D; earliest simulated execution at D+1 open.
  An all-cash target may buy then. If D+1 requires a sell/trim, freeze the
  target and defer replacement buys until at least D+2 open in the simulator
  and until a later live reconciliation boundary at the broker.
- Rank 12-1 momentum over 252 sessions, excluding the latest 21 sessions; use
  6-1 momentum only as a tie-breaker.
- Require price >= $10, median 60-session dollar volume >= $25m, annualized
  63-session volatility <= 80%, positive 12-1 momentum, close above SMA200,
  and a usable sector classification.
- Select up to 10 names and equal weight them under a 9% single-name cap and a
  20% sector cap.
- Cap normal gross exposure at 90%, retaining at least 10% cash. Scale down if
  fewer than eight names qualify, and multiply the target by the frozen
  broad-market breadth tier (100% / 80% / 55% / 25% at breadth thresholds
  60% / 45% / 30%).
- Rebalance monthly. Check SPY against its SMA200 on every execution and exit
  directional exposure when the gate is off. Persist zero-target intent until
  the account is flat; after recovery, permit one D-close/D+1 fresh target on
  the first completed SPY close above SMA200, then resume monthly cadence.
- Classify risk from the highest equity observation in the trailing 22 sessions
  plus the current daily return. `CAUTIOUS` activates at a 10% rolling
  drawdown or 5% daily loss and halves the next monthly target; it does not
  force an immediate mid-month resize. `HALT` is reserved for an 8% daily loss
  and exits directional exposure on every execution cycle.
- Keep SPY/SSO base, TQQQ, UPRO, SH, options, mean reversion, PEAD, sector
  rotation, and legacy score-driven entry sleeves disabled by default.

The V11 policy is overlaid in `scripts/strategy_config.py`; do not infer the
live defaults from the archived v3-v10 parameter table above it.

## Data and universe rules

`scripts/universe.py` is the production universe boundary:

1. Request active US-equity assets from Alpaca.
2. Require an eligible exchange and `tradable=True`.
3. Admit ordinary common stocks and ADRs; exclude malformed symbols, warrants,
   rights, units, ETFs, ETNs, funds, leveraged/inverse products, and volatility
   products.
4. Write a versioned cache to `state/universe.json` only after a successful
   response with at least 100 unique eligible symbols.
5. Trust a cache only when its Alpaca provenance, schema/count, strict UTC
   timestamp, and seven-day freshness validate; otherwise use the filtered
   `watchlist.json` fallback. A partial discovery must not overwrite a usable
   cache.
6. Keep held names outside the ranking universe only so exits remain possible;
   never promote them back into momentum ranking merely because they are held.
7. Reject any required 253-session signal epoch containing a calendar gap over
   ten days. Live SPY/sector auxiliaries must share a completed date no more
   than seven calendar days old.

Imports and cache reads must remain local-only. Construct Alpaca clients lazily.
Use batch historical requests for broad scans. Missing or stale bars must fail
the candidate, not silently reuse a later observation.
The live batch response must include a non-empty frame for every requested
symbol. Synchronize SPY and requested sector auxiliaries to one completed date.
A stale non-held ranking name may become ineligible, but a stale held ranking
name must pause risk-on rebalancing so a data outage cannot force liquidation.
Require at least 253 completed bars for SPY, requested auxiliaries, and every
held ranking constituent; a current date on a truncated frame is not enough.

Static sector metadata may be supplemented by trailing return correlation to
sector ETFs. Do not bypass the sector cap by fabricating a classification.

## Safety rules

- The broker client must remain fixed to `paper=True`. There is no supported
  live-money mode.
- No-argument `python3 scripts/execute_trades.py` must remain a dry run.
- Dry run must have zero order and state mutations.
- Every mutating execution path must require `TRADING_MODE=paper`.
- Treat every short as a blocking reconciliation state. Cancel conflicting
  orders, cover it with a bounded idempotent BUY, and run no other V11 manager
  until a fresh broker snapshot is flat.
- New exposure requires a fresh, open broker clock. Closed/stale clock state
  may block buys but must not prevent risk-reducing exits.
- Submit deterministic client order IDs and reconcile pending/partial orders.
  Never treat order submission as proof of a fill.
- Cancel retired-infrastructure BUYs and every directional BUY not
  deterministically bound to the exact current frozen plan before depending on
  positions, prices, or target state. Cancel even a bound BUY when account,
  position, SPY, validation, or risk reconciliation fails. A remaining
  same-symbol BUY must block a SELL. Apply the infrastructure migration gate to
  both `run` and `midday`.
- Sell or trim first, wait for fill/cash reconciliation, then submit replacement
  buys. Validate each buy against cash, position, and sector limits.
- Permit a paper BUY only when `state/backtest/v11_validation.json` is a current
  fixed-strategy `PASS`, its strategy fingerprint matches the running code,
  and its ranking-universe hash exactly matches the current ranking universe.
  Recompute the recorded assessment and historical-bar prefix, require the
  exact canonical $1m / 7bps / 15bps profile, minimum 504/252-session segments,
  no parameter overrides, and limitation warnings. Bind each result config to
  its dates, cost, universe hash, strategy version, and D/D+1 timing; verify
  the whole-report digest and expire the report/bar boundary after 35 days.
  Custom validation dates, capital, or cost sets are shadow-only. The digest
  is tamper-evident, not a keyed signature. Any injected runner, metric
  function, or config factory is a test seam and must also be non-promotable.
- A closed validation gate must still permit cancellation of pending
  directional buys and risk-reducing trims/exits.
- Never commit `.env`, credentials, or API responses containing secrets.

The supported promotion and execution sequence is:

```bash
python3 scripts/backtest/download_history.py --start 2020-01-01
python3 scripts/backtest/validate_v11.py
python3 scripts/sanity_check.py
python3 scripts/execute_trades.py dry-run
TRADING_MODE=paper python3 scripts/execute_trades.py run
```

Historical download is a full adjusted rebuild by default. Without Alpaca
keys it uses adjusted yfinance data. `--incremental` is faster but explicitly
unsafe for validation because corporate-action adjustments can revise the
cached prefix.

`midday` is also mutating and requires `TRADING_MODE=paper`. Do not recommend
direct mutating `trade.py` commands as the normal V11 control path.

## Validation contract

For every change to timing, universe, signal, ranking, allocation, regime, or
execution:

1. Add focused tests for the changed invariant.
2. Run `python3 -m pytest -q`.
3. Check that every historical signal reads at most D and every fill occurs no
   earlier than D+1. Add a synthetic causality regression when practical.
4. Run the fixed-parameter validator and inspect excess CAGR, Jensen alpha,
   beta, information ratio, Sharpe, max drawdown, turnover, and concentration.
   Do not optimize on one headline metric.
5. Promotion must fail if any ranking symbol has no cached bars, lacks a bar at
   the validation end, contains invalid OHLCV, or if a required SPY/BIL/sector
   auxiliary is incomplete or misses a reference session.
6. Record the exact date range, universe source, costs, and parameter set with
   any reported result.
7. Rerun validation after any strategy-identity source or ranking-universe
   change, or after the latest local SPY session changes. A previous `PASS`
   must fail closed when any canonical boundary or identity changes.

Useful commands:

```bash
python3 scripts/universe.py show
python3 scripts/universe.py refresh
python3 scripts/backtest/download_history.py --start 2020-01-01
python3 scripts/backtest/validate_v11.py
python3 scripts/sanity_check.py
```

Do not recommend `run.py sweep`, `walk-forward`, or `compare`: they are
archived pre-V11 optimizers and the CLI intentionally rejects them because
their grids do not alter the adaptive V11 policy.

Sharpe and Jensen alpha use adjusted BIL as the risk-free proxy. Metrics must
retain the explicit starting-capital observation so initial fill friction is
included in both returns and drawdown. BIL is metric infrastructure only, not
an invested V11 cash sleeve.

Current-universe historical tests have survivorship/selection bias. The 2025
period was inspected during earlier development and is not an untouched
holdout. A positive reused temporal check is not fresh OOS evidence. Never
label a result from those data as proof of forward alpha. A validator `PASS`
only makes the unchanged code and exact ranking universe eligible for paper
validation.

At present `state/universe.json` is absent, so validation resolves the locally
maintained `watchlist.json` fallback and its available bars. Do not
claim that this validates the broad dynamic common-stock/ADR universe; it has
not yet been downloaded and historically validated as one frozen ranking set.
A newly refreshed dynamic cache changes the universe hash and requires a full
adjusted rebuild, fixed validation, and sanity check. The required next
evidence is frozen-rule forward paper performance across several monthly
rebalances; point-in-time universe and delisting data are required for stronger
historical claims.

## Code boundaries

| Concern | Source of truth |
|---|---|
| Strategy defaults | `scripts/strategy_config.py` (`_V11_POLICY`) |
| Signal and target weights | `scripts/adaptive_momentum.py` |
| Universe discovery/cache | `scripts/universe.py` |
| Live orchestration | `scripts/execute_trades.py` |
| Broker orders and validation | `scripts/trade.py` |
| Risk-tier state | `scripts/portfolio.py` |
| Shared rolling risk logic | `scripts/risk_policy.py` |
| Strategy/universe identity | `scripts/strategy_identity.py` |
| Historical simulation | `scripts/backtest/engine.py` |
| Benchmark-relative metrics | `scripts/backtest/metrics.py` |
| Fixed V11 validation | `scripts/backtest/validate_v11.py` |
| Strategy specification | `strategy/v11_adaptive_momentum.md` |

Keep signal construction broker-independent. The planner should return target
weights; execution should converge actual positions to those targets. Do not
move broker calls into `adaptive_momentum.py`.

## Historical context

V10's apparent performance was not a valid production baseline: the portfolio
was concentrated in TQQQ/UPRO, the simulator used same-session close
information for same-session-open trades, the live stock picker did not fetch
enough trading sessions for its lookback, and an infrastructure symbol was not
consistently marked to market. Preserve old code only as an explicit audit
reference; do not imply that every old strategy/result remains reproducible.

The separate `claude-trader` repository supplied useful conceptual patterns:
12-1 ranking, D/D+1 timing, and a strategy -> target planner -> execution
boundary. Its allocator and order lifecycle were not ported. Do not reintroduce
unverified risk-parity labels, misaligned correlation inputs, or
submission-equals-fill accounting.

## Completion checklist

- Confirm only intended files changed; preserve unrelated user work.
- Run focused and full tests relevant to the change.
- State what was validated and what remains uncertain.
- Keep README and the V11 specification aligned with executable defaults.
- Do not create schedules, place orders, push, or claim performance unless the
  user explicitly authorizes that action.
