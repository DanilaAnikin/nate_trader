# Nate Trader

Nate Trader is a research and **Alpaca paper-trading** project for a causal,
diversified US-equity momentum strategy. The current default is
`v11-adaptive-momentum`.

> No trading strategy can guarantee positive alpha or profit. The historical
> tests in this repository are diagnostic, not evidence that the strategy will
> work with future capital. Do not enable real-money trading from this code.

## Current strategy

V11 replaces the old concentrated TQQQ/UPRO portfolio with a monthly target
portfolio of ordinary US equities:

| Rule | V11 default |
|---|---:|
| Ranking signal | 12-1 momentum: 252-session return excluding the latest 21 sessions |
| Tie-breaker | 6-1 momentum |
| Trend filter | Stock close above its 200-session SMA and positive 12-1 momentum |
| Liquidity filter | Price at least $10 and 60-session median dollar volume at least $25m |
| Volatility filter | Annualized 63-session volatility at most 80% |
| Portfolio | Top 10, equal weight |
| Single-name cap | 9% of equity |
| Sector cap | 20% of equity |
| Normal gross exposure | At most 90%, leaving at least 10% cash |
| Breadth scaler | 100% / 80% / 55% / 25% of target gross as breadth crosses 60% / 45% / 30% |
| Rebalance | First trading session of each month, with a 0.5% drift threshold |
| Market risk-off | Zero directional target when SPY is below its 200-session SMA |
| Recovery | One fresh target after the first completed SPY close back above SMA200 |

Signals use only completed data through session **D** and simulated fills occur
no earlier than the open of **D+1**. Live execution uses the same target planner
and submits paper limit orders after completed daily bars are available.

The risk tier scales the portfolio independently of the ranking:

- `NORMAL`: up to 90% gross exposure.
- `CAUTIOUS`: half-sized targets, normally up to 45% gross exposure. It is
  triggered by a 10% drawdown from the highest equity observation in the
  trailing 22 sessions, or by a 5% daily loss. A mid-month transition does not
  resize an existing risk-on portfolio; it affects the next monthly target.
- `HALT`: zero directional exposure and risk-reducing exits only. It is
  triggered by an 8% daily loss and is enforced on every execution cycle.

SPY below its 200-session SMA is also enforced daily. Unlike `CAUTIOUS`, either
`HALT` or the SPY risk-off condition sends the directional target to zero
without waiting for the next monthly rebalance.
After that zero target has converged, one persisted recovery latch permits a
single fresh off-cycle target when SPY first closes back above its SMA200. The
signal still uses completed close D and can trade no earlier than D+1; the
latch is consumed once, then ordinary monthly cadence resumes.

The default policy has no SPY/SSO base, TQQQ or UPRO leverage, SH hedge,
options hedge, mean-reversion sleeve, PEAD sleeve, sector-rotation sleeve, or
legacy score-driven buys. Those modules remain only so older experiments can
be inspected during audits; their old behavior and data dependencies are not
promised to remain fully reproducible.

See [the V11 strategy specification](strategy/v11_adaptive_momentum.md) for the
full signal, portfolio, execution, and validation contract.

## Universe and data flow

```text
Alpaca active/tradable US equities
              |
              v
   eligibility filter + cache ----------+
              |                          |
              v                          | cache unavailable
 completed daily OHLCV                   v
              |                 watchlist fallback
              v                          |
      D-close target planner <-----------+
              |
              v
 D+1 initial buy, or D+1 sells/trims
              |
              v
 earliest D+2 replacement paper buys
```

`scripts/universe.py` discovers active, tradable US equities from Alpaca and
stores the filtered symbols in `state/universe.json`. The ranking universe is
limited to ordinary common stocks and ADRs. It rejects unsupported exchanges,
malformed symbols, warrants/rights/units, ETFs, ETNs, funds, leveraged or
inverse products, and volatility products. A cache is trusted only when its
Alpaca provenance, US-equity class, schema/count, UTC timestamp, seven-day
freshness, and at least 100 unique symbols all validate; otherwise the filtered
static `watchlist.json` is used. A partial discovery below that breadth never
overwrites a good cache. Currently held symbols
outside that ranking universe are retained only so they can be inspected and
exited; they are not eligible momentum candidates.

The strategy then filters this broad universe by price history, liquidity,
trend, volatility, and sector. Static sector metadata is used where available;
otherwise sector is inferred from return correlation to sector ETFs. An
unclassified name is not eligible for a new V11 position.

Broad live history is fetched as one completeness contract: an omitted or
empty response for any requested symbol aborts planning. A stale non-held stock
is left in the snapshot but becomes ineligible at the signal layer. If that
stock is currently held and still belongs to the ranking universe, risk-on
rebalancing pauses instead of turning a one-symbol data outage into a sale.
SPY, every requested sector auxiliary, and each held ranking constituent must
also provide at least 253 valid completed sessions; current-but-truncated data
is not accepted. SPY and all requested sector auxiliaries must end on the same
completed session, that session must be no more than seven calendar days old,
and the required signal window may not bridge a long ticker/history gap.
`HALT` and SPY risk-off exits remain independent of this risk-on gate.

## Safety model

- The supported broker client is permanently configured with `paper=True`.
- Running `execute_trades.py` with no argument resolves to a dry run.
- A mutating `run` or `midday` command requires the explicit environment value
  `TRADING_MODE=paper`; no value enables live-money mode.
- Dry run previews the plan without submitting, cancelling, or replacing
  orders and without writing trading state.
- New exposure also requires a fresh Alpaca clock reporting that the market is
  open. Risk-reducing sells remain available when the entry gate is closed.
- Deterministic client order IDs and open-order reconciliation reduce duplicate
  submissions. Sells and their fills are reconciled before replacement buys.
  A frozen monthly target may buy at D+1 when the account starts in cash. If a
  sell or trim is required at D+1, replacement buys are deferred to at least
  the next broker invocation/session boundary; the backtest models the earliest
  such fill at D+2 open.
- Before relying on positions, prices, or a saved target, every mutating path
  classifies open BUYs. Retired-infrastructure orders and any BUY not bound to
  the exact current frozen V11 plan are cancelled; a bound BUY is retained only
  while its plan and gates remain valid. Account/position/SPY failures cancel
  BUY intent before returning. A remaining same-symbol BUY blocks a SELL, and
  both `run` and `midday` keep legacy SPY/SSO/TQQQ/UPRO/SH exposure behind the
  migration gate.
- The schema-v3 frozen plan ID binds weights, sectors, construction risk tier,
  eligible count, strategy identity, and universe identity. A zero-target
  risk-off plan and its recovery latch are persisted before BUY cancellation
  and survive retries, month boundaries, strategy upgrades, and market
  recovery until the broker snapshot has actually converged to cash.
- V11 never targets a short. If a broker snapshot contains one, a dedicated
  preflight cancels conflicting orders and submits or waits for an idempotent
  BUY-to-cover; full, midday, and direct adaptive execution stop there until a
  fresh snapshot is flat.
- A paper BUY additionally requires a current `PASS` artifact from the fixed
  V11 validator. Its strategy-code fingerprint and exact ranking-universe hash
  must match the running code and universe. The executor also recomputes the
  adjusted historical-bar hash through the recorded validation boundary, so
  any revised/missing historical prefix invalidates promotion. The only
  promotable profile uses $1,000,000 starting capital, exactly 7 bps and 15 bps
  costs, the canonical locally resolved periods, at least 504 development and
  252 temporal-check sessions, at least 100 ranking symbols, and no parameter
  overrides. Custom dates,
  capital, or cost sets are shadow research even when their metrics are
  positive. Every segment config is bound to the same dates, cost, universe
  hash, strategy version, and D/D+1 timing. Adding a later local SPY session
  moves the canonical boundary and requires a new report. The full report has
  a deterministic digest, all four scenarios share one frozen in-memory bar
  snapshot, and source/bar identities must remain unchanged from before to
  after the run. Its promotion assessment is recomputed, required
  limitation warnings must be present, and both the report and bar boundary
  expire after 35 days. Missing, failed, malformed, incomplete, inconsistent,
  or stale evidence keeps the strategy in dry-run/shadow mode. The digest is
  tamper-evident, not a signed security boundary.
- A failed validation gate does not block risk-reducing exits or cancellation
  of outstanding directional buys.

Production forward validation is run by the single guarded
`V11 Paper Production` GitHub Actions workflow. It executes at 15:05 UTC on
weekdays, serializes every invocation, verifies the exact release and paper
account before execution, and stores mutable reconciliation state in a private
Actions artifact rather than committing broker state to this public repository.
A push alone never submits an order: the scheduled/manual job must pass every
gate, and the only accepted mutating mode remains Alpaca paper trading.

See [the production runbook](strategy/PRODUCTION_RUNBOOK.md) for canary,
monitoring, emergency-stop, state-recovery, and rollback procedures.

## Quickstart

The production runtime is exactly Python 3.12.11 with the hashes in
`requirements.lock`. An Alpaca paper account is required. Node.js 20+ is used
only by the optional dashboard.

```bash
git clone https://github.com/DanilaAnikin/nate_trader.git
cd nate_trader
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install --require-hashes -r requirements.lock
```

Create a gitignored `.env` with paper credentials:

```dotenv
ALPACA_API_KEY=PK...
ALPACA_SECRET_KEY=...
```

Optional integrations such as Perplexity, ClickUp, Reddit, and Supabase are not
part of the V11 ranking signal.

### Prepare the universe and evidence

```bash
# Refresh with Alpaca credentials, or inspect the cache/watchlist fallback
python3 scripts/universe.py refresh
python3 scripts/universe.py show

# Correctness default: rebuild all split/dividend-adjusted cached bars
python3 scripts/backtest/download_history.py --start 2020-01-01

# Fixed checked-in policy only; writes state/backtest/v11_validation.json
python3 scripts/backtest/validate_v11.py
python3 scripts/sanity_check.py

# Frozen development-only 15-tactic leaderboard; never reads past 2024-12-31
python3 scripts/backtest/research_v11_tactics.py
```

The no-argument validator is the sole promotion command. Its canonical policy
uses the first SPY session after the 253-session signal warm-up, the last 2024
session as the development boundary when available, the following session as
the reused temporal-check start, and the latest cached SPY session as the end.
CLI date, capital, or slippage overrides are deliberately accepted only for
shadow diagnostics and must return a non-promotable `FAIL` artifact. The same
applies to the injectable runner, metric, and config seams used by unit tests.

The downloader uses fully adjusted Alpaca IEX bars when credentials are
available and an adjusted yfinance fallback when they are not. A full rebuild
is deliberate: a later split or dividend can revise the entire adjusted price
history. `--incremental` is an explicit faster option, but it can splice
different adjustment bases and is unsafe for validation evidence.

Refreshing the ranking universe or changing strategy, risk, backtest, metric,
or execution code invalidates the prior artifact. Rebuild data, rerun the fixed
validator, and rerun the sanity check before another paper BUY is eligible.

### Preview and paper execution

```bash
# Safe preview; both commands submit no orders and write no trading state
python3 scripts/execute_trades.py
python3 scripts/execute_trades.py dry-run

# Explicit paper-order opt-in; BUYs still require a current validation PASS
TRADING_MODE=paper python3 scripts/execute_trades.py run
```

Use `run` near the market open after inspecting the dry run. V11 rebalances
risk-on targets monthly, while every invocation can cancel pending buys and
reduce exposure under `HALT` or the SPY risk-off gate.

### Production paper deployment

The production workflow supports a read-only manual canary:

```bash
gh workflow run paper-production.yml \
  --repo DanilaAnikin/nate_trader \
  -f operation=preflight
```

The preflight checks the exact Python/dependency lock, strategy and historical
bar fingerprints, validated universe, paper endpoint/account, current broker
clock, positions, open orders, and rolling risk snapshot. It then runs the
ordinary mutation-free strategy preview. Only `operation=execute` or the
weekday schedule can call `scripts/production_run.py`; any `ABORT`/`ERROR`
action produces a failed workflow and operational incident.

The scheduler currently trades the exact validated 540-symbol fallback. A
dynamic Alpaca universe refresh intentionally invalidates promotion until its
full adjusted history and a new canonical validation both pass.

### Tests

```bash
python3 -m pytest -q
```

The old `run.py sweep`, `walk-forward`, and `compare` optimizers are archived
pre-V11 commands and deliberately refuse to run. Their parameter grids do not
control the adaptive target builder. Use `validate_v11.py`, which applies the
fixed checked-in parameters without selecting a best result.

Validation metrics include excess CAGR, information ratio, and SPY beta.
Sharpe and beta-adjusted Jensen alpha use adjusted BIL returns as the
risk-free proxy. The return and drawdown series include the initial capital
observation, so first-session fill costs cannot disappear from the statistics.
BIL is not an invested cash sleeve in V11.

### Dashboard

```bash
cd dashboard
npm install
npm run dev
```

The Next.js dashboard reads the repository state and backtest artifacts. It is
a view layer, not a trading control plane.

## Interpreting results honestly

The current historical bar set and universe cache are not point-in-time
constituent data. Replaying today's active symbols into earlier years creates
survivorship and selection bias. In addition, 2025 data was already inspected
during prior strategy work, so it is not an untouched holdout.

In the current checkout, `state/universe.json` is absent. The validator
therefore resolves the locally maintained `watchlist.json` fallback (including
known 2025–2026 delistings and the SQ→XYZ ticker migration), and any current
artifact validates only that fallback and its locally available bars. The broad
dynamically discovered common-stock/ADR universe has
not yet been historically validated. Creating that cache changes the ranking
universe hash and requires a full bar rebuild plus a new validation artifact.

The validator therefore labels its later segment a **reused temporal check**.
Even if every fixed-policy check is positive, that result is not fresh
out-of-sample evidence; a `PASS` permits forward paper validation only.

### Current validation snapshot

The canonical report generated on 2026-08-02 is **PASS**. It makes the fixed
policy eligible for forward Alpaca paper validation; it does not authorize
live-money trading or prove future alpha:

| Cost assumption | Segment | Strategy CAGR | SPY CAGR | Excess CAGR | Jensen alpha | Max drawdown |
|---:|---|---:|---:|---:|---:|---:|
| 7 bps/fill | Development (2022–2024) | 17.10% | 8.82% | +8.28 pp | +10.59% | -18.66% |
| 7 bps/fill | Reused temporal check (2025–2026) | 19.95% | 18.73% | +1.22 pp | +8.05% | -17.22% |
| 15 bps/fill | Development (2022–2024) | 15.89% | 8.82% | +7.07 pp | +9.55% | -19.71% |
| 15 bps/fill | Reused temporal check (2025–2026) | 19.00% | 18.73% | +0.27 pp | +7.26% | -17.38% |

All eight fixed alpha checks passed. The one-session recovery rule and breadth
scaler were selected using the development period, then frozen before this
canonical run. The later segment's 15 bps raw excess is only +0.27 pp and is
materially weaker than the prior baseline's reused result; its positive Jensen
alpha reflects the strategy's lower beta. The segment remains reused rather
than fresh OOS, and no parameter was changed after seeing it. See
`state/backtest/v11_validation.json` for the bound report and evidence hashes.

Consequently:

- use the PASS only for forward paper validation, never as permission for
  live-money trading;
- do not describe the current positive historical alpha as guaranteed or
  production-proven;
- do not tune V11 against 2025 and then call 2025 out-of-sample;
- add point-in-time universe membership and delisting data before treating a
  long historical test as investable evidence; and
- freeze the rules and complete forward Alpaca paper validation across several
  monthly rebalances, including a weak-market period, before considering any
  further deployment.

## Repository map

| Path | Purpose |
|---|---|
| `scripts/adaptive_momentum.py` | Broker-independent signal and target planner |
| `scripts/universe.py` | Dynamic Alpaca universe discovery, cache, and fallback |
| `scripts/execute_trades.py` | Guarded paper execution and target convergence |
| `scripts/trade.py` | Order validation, idempotency, and Alpaca paper client |
| `scripts/strategy_config.py` | V11 production policy plus archived parameters |
| `scripts/risk_policy.py` | Shared 22-session rolling risk classification |
| `scripts/strategy_identity.py` | Strategy fingerprint and ranking-universe hash |
| `scripts/backtest/validate_v11.py` | Fixed non-optimizing validation and PASS artifact |
| `scripts/backtest/` | Adjusted data, causal simulator, and BIL-aware metrics |
| `strategy/v11_adaptive_momentum.md` | Authoritative V11 specification |
| `state/` | Local runtime and research artifacts |
| `dashboard/` | Read-only Next.js dashboard |

Files under `strategy/` describing v3-v10 are retained as archive/audit notes;
they are not the current operating policy or a guarantee of reproducibility.

## Origin of selected design ideas

The sibling `claude-trader` project was reviewed. V11 adopts three useful
concepts: canonical 12-1 momentum, explicit D-close/D+1 execution timing, and
separation of signal generation from target planning and order execution. Its
allocator and order-state implementation were not copied; V11 uses its own
transparent capped allocator and reconciled paper-order path.

Nate Trader is an educational research system, not financial advice.
