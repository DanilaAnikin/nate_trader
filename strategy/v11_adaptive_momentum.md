# V11 Adaptive Momentum Strategy

Status: current default policy. Scope: research and Alpaca paper trading.

## Claim boundary

V11 is a testable portfolio process, not a promise of positive alpha. Its
design removes known sources of false confidence from V10, but that does not
establish that the replacement will outperform SPY. Promotion depends on
future evidence described in [Validation](#validation).

## Why V10 was retired

The previous default was not an acceptable production baseline:

- It concentrated nearly all directional exposure in TQQQ and UPRO.
- Its backtest formed regime and overlay signals from the current session's
  close and filled at that same session's open. That is look-ahead bias.
- The live momentum path requested too little calendar history to satisfy its
  trading-session lookback, so the broad stock sleeve could abort without
  selecting names.
- UPRO was absent from part of the daily mark-to-market path, invalidating
  portfolio and circuit-breaker results when it was held.
- Historical data after the last complete symbol cache were not comparable
  across all sleeves.

V11 removes the leveraged thesis from the default and makes one causal,
broker-independent target planner the source of directional exposure.

## Universe

The live ranking universe begins with Alpaca assets reported as active,
tradable US equities on supported US exchanges. `scripts/universe.py` narrows
that asset class to ordinary common stocks and ADRs. It removes malformed
symbols, warrants, rights, units, ETFs, ETNs, funds, leveraged/inverse products,
and volatility products. Successful discovery is cached in
`state/universe.json`.

A cache is usable only when it is a schema-v2 Alpaca US-equity snapshot with a
matching symbol count, a strict UTC timestamp no more than seven days old, and
at least 100 unique eligible symbols. Empty or narrower discovery responses do
not overwrite an existing cache. This prevents a transient partial API result
from silently collapsing the cross-sectional strategy to a handful of names.

Resolution order is:

1. valid, current-schema universe cache;
2. static `watchlist.json` fallback when no valid cache exists; and
3. currently held symbols added to the risk/exit set, not the ranking set.

The cache expands coverage beyond the two leveraged ETFs held by V10. It does
not mean every listed security is suitable: V11 deliberately excludes products
outside the common-stock/ADR risk model and rejects symbols without sufficient
data. A held asset that no longer belongs to the ranking universe remains
visible only so the system can cancel its pending buys or exit it; holding it
does not make it eligible for selection.

The current checkout has no `state/universe.json`, so current validation
resolves the locally maintained `watchlist.json` fallback, including known
2025–2026 delistings and the SQ→XYZ ticker migration.
That validates neither Alpaca's full current asset list nor a historical
point-in-time universe. A newly discovered dynamic universe is a different
ranking set and requires its own complete bar cache and validation artifact.

## Information timing

For a trading session D+1:

1. Load only bars completed on or before D.
2. Compute the market gate, eligibility filters, ranks, sectors, and target
   weights at D close.
3. Submit or simulate orders no earlier than D+1.

The backtest obtains D with `previous_trading_day("SPY", D+1)` and marks the
portfolio at the D+1 open before trading. Live daily frames exclude the current
calendar date, so a partial intraday daily bar cannot enter the signal.

The intended live order is a DAY limit order. Therefore "D+1 open" describes
the earliest legal decision/fill clock and the backtest assumption, not a
guarantee that a live limit order fills at the official opening print.
An initial or all-cash target may buy at D+1. If reaching the target first
requires a sale or trim at D+1, the target is frozen and replacement buys wait
for confirmed positions/cash; the backtest permits those replacement fills no
earlier than D+2 open. This avoids spending sale proceeds at an already-known
official opening price.

## Signal and eligibility

For stock i at completed session D:

```text
12-1 momentum_i = close_i[D-21] / close_i[D-252] - 1
6-1 momentum_i  = close_i[D-21] / close_i[D-126] - 1
```

The implementation uses the corresponding 253-bar indexing so both endpoints
are completed observations. Names are sorted by descending 12-1 momentum, then
descending 6-1 momentum, then ticker for deterministic ties.

A new candidate must satisfy all of the following:

| Filter | Default |
|---|---:|
| Last close | At least $10 |
| Median dollar volume | At least $25m over 60 sessions |
| Annualized volatility | At most 80% from 63 daily returns |
| Absolute momentum | 12-1 return greater than zero |
| Stock trend | Last close above 200-session SMA |
| History | Complete and fresh through signal date D |
| Sector | Known or inferable |

The entire required lookback must belong to one contiguous trading-history
epoch. A gap longer than ten calendar days resets eligibility until a complete
fresh lookback exists; this prevents a halted, delisted, or reused ticker from
joining pre-gap and post-gap prices into one momentum return. The same rule is
applied to the SPY market-state window.

The live batch request must return a non-empty frame for every requested
ranking and auxiliary symbol. A stale non-held ranking stock then fails the
freshness filter above without changing the definition of the requested cross
section. A stale currently held ranking stock pauses risk-on planning instead
of causing a data-outage liquidation. SPY and requested sector ETFs must all
end on the same completed session. SPY, every requested auxiliary, and every
held ranking constituent must contain at least 253 valid completed bars, so a
current but truncated response also fails closed. These safeguards do not
prevent emergency zero-target exits under `HALT` or the SPY trend gate.

### Sector inference

Static watchlist metadata is preferred. If it is unavailable, V11 compares the
stock's recent daily returns with sector ETF returns over roughly 63 sessions.
The strongest correlation above the minimum threshold determines the sector.
A weak or unavailable relationship remains `Unknown`, and the name is rejected
for a new position rather than bypassing diversification rules.

## Portfolio construction

The planner takes the ten highest-ranked eligible names subject to the sector
constraint. Default weights are transparent and equal:

- target gross exposure: 90% in `NORMAL`;
- target names: up to 10;
- equal target per name: normally 9%;
- maximum single name: 9%;
- maximum sector: 20%; and
- minimum cash target: 10%.

The production target is multiplied by a cross-sectional breadth tier. Breadth
is the percentage of liquid, price-eligible names whose completed close is
above SMA200: at least 60% keeps 100% of the target, 45–60% keeps 80%, 30–45%
keeps 55%, and below 30% keeps 25%. Missing breadth fails defensively to 50%.
This changes gross exposure only; it does not rerank stocks or bypass the SPY,
portfolio-damage, single-name, or sector gates.

With 9% slots, no more than two selected names can share a sector. Any
allocation that cannot be placed under the caps remains cash. If fewer than
eight names qualify, gross exposure scales down in proportion to the eligible
count instead of forcing weak candidates into the book.

Inverse-volatility allocation exists as an explicit experimental option, but
the production default is equal weight. It is not described as risk parity.

Target changes occur on the first trading session of a new month. A position is
trimmed or topped up only when its dollar drift exceeds 0.5% of portfolio
equity, reducing unnecessary turnover.

One exception is deliberately stateful: after a completed SPY/HALT risk-off
liquidation, a persisted latch allows one fresh target after the first
completed SPY close back above SMA200. This recovery target is still formed at
D close and filled no earlier than D+1. The latch is consumed once and normal
monthly cadence then resumes.

## Independent risk layers

### Broad-market gate

SPY must close above its 200-session SMA for directional targets to be nonzero.
The gate is checked on every execution, not only at monthly rebalance. A failed
gate closes directional positions at the next permitted execution opportunity.
Live SPY and sector-ETF auxiliaries must share a completed date no more than
seven calendar days old.

### Portfolio damage tier

The shared live/backtest policy compares current equity with the highest equity
observation in a rolling 22-session window and separately measures the current
daily return:

| Tier | Trigger | Target behavior |
|---|---|---|
| `NORMAL` | No higher tier active | Up to 90% gross |
| `CAUTIOUS` | 22-session rolling drawdown <= -10%, or daily P&L <= -5% | Next monthly target is half-sized, normally up to 45% gross |
| `HALT` | Catastrophic daily P&L <= -8% | Zero directional target; exits only |

`CAUTIOUS` does not cause an immediate mid-month resize. It is applied when the
next monthly risk-on target is constructed, avoiding daily churn in a slow
signal. `HALT` is an acute daily emergency and is checked on every execution;
it sends the target to zero immediately. The rolling window ensures an old
peak eventually ages out of the classifier.

The market gate and damage tier combine multiplicatively. For example, an
above-SMA200 market in `CAUTIOUS` can target 45%; a below-SMA200 market targets
zero regardless of the tier.

### Disabled default sleeves

The V11 policy sets every legacy infrastructure or alternative sleeve to zero
or disabled:

- SPY and SSO base exposure;
- TQQQ and UPRO leveraged exposure;
- SH inverse hedge;
- options hedge;
- mean reversion;
- post-earnings announcement drift (PEAD);
- sector rotation; and
- legacy catalyst/confidence-score buys.

Cash is the defensive asset. BIL appears only as the risk-free proxy used by
backtest metrics; V11 does not invest its cash target in BIL. Legacy modules
remain only as archive/audit references. Their original behavior and data
dependencies are not guaranteed to remain fully reproducible, and they must
not be counted as V11 expected return.

## Execution contract

`scripts/adaptive_momentum.py` has no broker dependency and returns target
weights. `scripts/execute_trades.py` owns convergence from current positions to
those weights:

1. reconcile existing positions and open orders;
2. cancel every outstanding directional or retired-infrastructure BUY before
   depending on positions, price data, or a saved plan;
3. block a same-symbol SELL until any remaining BUY is terminal, then exit
   dropped names and trim overweights first;
4. freeze the monthly target and cross an invocation/session boundary after
   any required sale; do not submit replacement buys while fills or cash are
   unresolved;
5. preserve the cash floor;
6. validate every buy against position and sector caps;
7. submit deterministic, purpose-scoped client order IDs; and
8. persist the monthly completion marker only when the rebalance is genuinely
   reconciled.

The schema-v3 frozen plan ID binds target weights, per-target sectors,
construction risk tier, eligible count, strategy fingerprint, and ranking
universe. Emergency zero-target intent is persisted before crossing a BUY
cancellation boundary and survives month/code transitions until the account is
flat. A legacy schema-v2 zero target is conservatively migrated and completed;
it is never converted back into a BUY authorization.

V11 is long-only. A short in the broker account invokes a higher-priority
preflight: conflicting orders are cancelled and confirmed first, an existing
safe BUY-to-cover is allowed to settle, or an idempotent cover is submitted.
No target, legacy sleeve, or other order manager runs again until a fresh
broker snapshot is flat.

New exposure requires Alpaca's fresh clock to report an open market. Exits may
continue when that entry gate is closed. The supported broker is permanently
paper-only and mutating execution additionally requires `TRADING_MODE=paper`.
No-argument execution is a non-mutating dry run.

### Validation promotion gate

A paper BUY also requires `state/backtest/v11_validation.json` to satisfy the
complete fixed-strategy contract:

- assessment status is `PASS` and mode is `paper-validation-eligible`;
- the recorded strategy fingerprint matches the running strategy, universe,
  risk, metric, backtest, and execution sources; and
- the recorded ranking-universe hash exactly matches the current ranking
  universe, excluding held-only exit symbols;
- every ranking symbol has local evidence through the validation end and every
  SPY/BIL/sector auxiliary covers the required range; and
- a recomputed adjusted-bar hash through the recorded boundary matches exactly.
  Revising the validated prefix requires a new report, and adding a later local
  SPY session moves the canonical end and also requires revalidation;
- the only promotable profile uses $1,000,000 starting capital, exactly the
  7 bps and 15 bps scenarios, at least 504 development sessions and 252 reused
  temporal-check sessions, at least 100 ranking symbols, and no parameter
  overrides;
- every recorded segment config matches its canonical dates, cost, capital,
  exact ranking-universe hash, strategy version, and D/D+1 timing;
- custom dates, capital, or cost sets remain shadow research regardless of
  headline metrics;
- strict coverage rejects missing/stale ranking bars, invalid OHLCV, and any
  missing SPY/BIL/sector reference session; and
- explicit
  survivorship/reused-OOS/no-guarantee warnings remain present; and
- all four runs use one cached bar snapshot, while source and freshly re-read
  on-disk bar identities must match before and after the experiment; and
- a deterministic whole-report digest matches, the promotion assessment
  recomputes exactly, and neither the report nor its bar boundary is older than
  35 days.

The whole-report SHA-256 is tamper-evident against accidental/manual field
edits; it is not a keyed signature and is not an authorization boundary on its
own. Paper safety also depends on the hard-coded broker mode, current strategy
identity, universe identity, bar evidence, and execution gates.

Missing, failed, malformed, or stale evidence leaves V11 in
dry-run/shadow-research mode. That fail-closed state blocks new adaptive
exposure but still permits cancellation of outstanding directional buys and
risk-reducing trims/exits. A `PASS` authorizes forward paper validation only;
it does not authorize live-money trading or an alpha claim.

The deployed forward-validation runtime is pinned to Python 3.12.11 and the
hash-locked `requirements.lock`. The production workflow, preflight, runner,
lock, and their selected runtime versions are part of the strategy identity.
The weekday workflow operates only against Alpaca's paper endpoint and keeps
mutable reconciliation state in a private Actions artifact. Deployment and
rollback are specified in `strategy/PRODUCTION_RUNBOOK.md`.

## What was adopted from `claude-trader`

The sibling project was reviewed for reusable ideas. V11 retained:

- the canonical 12-1 signal instead of short-horizon price chasing;
- explicit separation between D-close signal formation and D+1 execution; and
- the strategy -> target portfolio -> broker execution boundary.

Its implementation was not merged wholesale. In particular, V11 did not copy
an allocator whose risk-parity output was not actually used, correlation logic
with inconsistent return alignment, a static alphabetical universe subset, or
an order lifecycle that treated submission as a fill. The shared ideas were
reimplemented behind V11's tests and safety boundaries.

## Validation

### What current backtests can establish

The simulator can check mechanical properties: causal timing, allocation caps,
cash behavior, transaction-cost sensitivity, drawdown, beta, and internal
consistency between signals and fills. Reports include excess CAGR and
beta-adjusted Jensen alpha; "alpha" should always identify which measure is
being cited.

Sharpe and Jensen alpha subtract adjusted BIL returns as the risk-free proxy.
BIL is forward-filled on the same open-to-open clock and a missing proxy is
reported rather than silently estimated. Portfolio, SPY, and BIL return series
start from an explicit initial-capital observation, so first-session fill
friction is included in both returns and maximum drawdown.

### Current fixed-policy result

The canonical report generated on 2026-08-02 is `PASS` and permits forward
paper validation only. In development (2022-01-04 through 2024-12-31), CAGR
was 17.10% at 7 bps and 15.89% at 15 bps, versus 8.82% for SPY. Excess CAGR was
+8.28 and +7.07 percentage points; Jensen alpha was +10.59% and +9.55%.

In the reused temporal check (2025-01-02 through 2026-07-10), CAGR was 19.95%
at 7 bps and 19.00% at 15 bps, versus 18.73% for SPY. Excess CAGR was +1.22
and +0.27 percentage points; Jensen alpha was +8.05% and +7.26%. Maximum
drawdown ranged from -17.22% to -19.71% across the four runs. All eight strict
alpha checks passed, but the 15 bps raw excess is economically thin.

The one-session recovery rule and breadth scaler were selected on the
development segment and then frozen. The later dates had already been
inspected in earlier project work, so their positive result remains reused
evidence, not a fresh holdout. Breadth underperformed the prior baseline's raw
excess on that reused segment; no parameter was changed in response. The
checked-in policy must not be retuned against that period while continuing to
call it OOS.

### What current backtests cannot establish

The local historical universe is built from today's active cache or a static
watchlist, not point-in-time membership and delisting records. Earlier periods
therefore retain current-universe selection and survivorship bias. The bar feed
and fixed slippage scenarios also omit some spread, market-impact, queue, and
rejection behavior.

The broad dynamically discovered common-stock/ADR universe has not yet been
historically validated. Current local results cover the locally maintained
fallback and only the symbols with complete cached evidence; they must not be
generalized to the future dynamic universe.

The 2025 and later temporal period was already inspected while developing
earlier versions. The fixed validator labels it `REUSED TEMPORAL CHECK / not
fresh OOS`. Positive metrics there do not convert it into an untouched holdout.

No result from this setup supports language such as "guaranteed alpha",
"works perfectly", or "production proven".

### Required next evidence

1. Refresh the common-stock/ADR universe.
2. Perform a full adjusted historical-bar rebuild. Alpaca IEX is used when
   credentials exist; otherwise the downloader uses adjusted yfinance data.
   The faster `--incremental` path is explicitly unsafe for validation because
   later corporate actions can change the adjustment basis of old bars.
3. Run the fixed, non-optimizing V11 validator and the offline sanity check.
   Any code-fingerprint or ranking-universe change invalidates that artifact.
   Only the no-argument canonical profile can promote; CLI overrides are
   intentionally non-promotable shadow diagnostics.
4. Freeze the V11 signal, caps, and risk rules before observing the next paper
   period.
5. Run forward Alpaca paper trading across several monthly rebalances and at
   least one weak-market interval.
6. Compare with SPY using excess CAGR, Jensen alpha, beta, information ratio,
   max drawdown, turnover, fill rate, rejected orders, and concentration.
7. Add point-in-time universe membership and delisting returns before making a
   strong historical out-of-sample claim.
8. Review results before any strategy change; a rule tuned after seeing the
   period invalidates that period as a holdout.

The legacy `run.py sweep`, `walk-forward`, and `compare` optimizers are
archived and deliberately rejected by the CLI. Their parameter grids do not
control the adaptive V11 target builder. Only the fixed validator is a V11
promotion path.

There is no automatic path from a successful backtest or paper run to
real-money trading.

## Operator commands

```bash
# Broad-universe cache
python3 scripts/universe.py refresh
python3 scripts/universe.py show

# Correctness-first adjusted data and fixed validation
python3 scripts/backtest/download_history.py --start 2020-01-01
python3 scripts/backtest/validate_v11.py
python3 scripts/sanity_check.py

# Non-mutating preview
python3 scripts/execute_trades.py
python3 scripts/execute_trades.py dry-run

# Explicit paper execution; BUYs still require a current matching PASS
TRADING_MODE=paper python3 scripts/execute_trades.py run
```

There are currently no repository workflows scheduling these commands.
