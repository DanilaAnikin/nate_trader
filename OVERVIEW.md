# Nate Trader — current system, V11 strategy, production and dashboard contract

> Audit snapshot: 2026-08-07 (Europe/Prague)
>
> Repository baseline: `49cd8bda494550f1b8b7b2232eb7af6fe92e9390` (`main`)
>
> Audience: maintainers and coding agents taking over the production dashboard
>
> Scope: current behavior, not an aspirational design and not investment advice

## 0. Implementation status (2026-08-07 dashboard rebuild)

Sections 11–17 of this document described the dashboard **as it was before the
rebuild** plus the contract it had to meet. That contract has since been
implemented. What changed:

- The unified server-side read model of section 12 exists as
  `dashboard/lib/status/` and is served by `GET /api/accounts/[id]/status`.
  Every section carries its own source, scope, absolute `asOf`, relative age and
  freshness state, using exactly the vocabulary of section 12.2.
- The missing arrow in the section 4 diagram is closed: a **server-only** reader
  now fetches the private `paper-runtime-state-<approved SHA>` and
  `paper-diagnostics` Actions artifacts, validating name, release lineage,
  schema, size and the exact expected entry list before returning a sanitized
  DTO. No Python, workflow or other strategy-identity source was modified, so
  the existing canonical validation and release approval remain valid.
- Access to that runtime is authorized server-side by
  `PRODUCTION_OWNER_USER_ID` **and** `PRODUCTION_ACCOUNT_ID` **and** paper mode
  **and** account ownership; `PRODUCTION_ALPACA_ACCOUNT_NUMBER` is an optional
  extra AND check against a freshly read Alpaca `/v2/account`. An unauthorized
  viewer receives none of it and triggers no GitHub Actions call. Unproven
  accounts are observer-only and their V11 compliance is `NOT_APPLICABLE`.
- `accounts` is SELECT-only for end users (migration
  `0009_accounts_server_managed.sql`); server-managed columns are not
  client-writable, and the client DTO is an explicit allowlist that exposes only
  a four-character broker mask.
- The legacy V10 screener/research/benchmark screens, the committed-state
  fallbacks, the static "Dashboard Online" dot and the stale-SPY alpha chart
  were removed. `/operations` was added.
- Forward performance uses cash-flow-adjusted TWR over a shared benchmark
  window and requires a persisted V11 epoch baseline.

An independent security audit of that first build (2026-08-09) found and
required fixes for: a cross-tenant leak of the central production runtime to any
signed-in user; a production binding that accepted a client-writable broker
account number as an OR proof; the full Alpaca account number reaching the
browser; a release gate that accepted pull-request and manual successes; a
runtime selection where a newer preflight-only run hid an older valid execution;
lineage mismatches that only warned; a validation gate that conflated the stored
report with the effective authorization; forward performance that could start at
the wrong session or report a number after a refresh error; and a ZIP reader
without CRC, duplicate-entry, header-agreement or streaming size checks. All are
fixed and covered by regression tests; see the dashboard section of `README.md`.

Gaps that the UI genuinely cannot close are tracked in section 18 and are
rendered as `UNAVAILABLE` rather than estimated.

## 1. Executive summary

Nate Trader is a research system and a guarded **Alpaca paper-trading**
forward-validation system. Its current directional strategy is
`v11-adaptive-momentum`: a causal, long-only, monthly US-equity momentum
portfolio. It does not trade live money, options, crypto, FX, futures, every
listed instrument, or the old leveraged TQQQ/UPRO strategy.

The current V11 process ranks a broad validated universe of ordinary US common
stocks and ADRs, applies liquidity/trend/volatility/sector filters, and targets
up to ten equal-weight positions. It normally keeps at least 10% cash, scales
exposure down with weak market breadth, exits directional exposure when SPY is
below SMA200, and has independent portfolio-damage circuit breakers.

The checked-in canonical validation is `PASS`, but that means only that the
exact frozen code, universe and historical evidence are eligible for forward
paper validation. It does **not** prove future alpha, does not authorize live
money, and does not make the historical 2025–2026 interval fresh out-of-sample
evidence.

An epoch-1 tournament compared eleven pre-registered strategies and retained
V11. No challenger passed all return, drawdown, cost, delay, capacity,
stability and multiple-testing gates. Production therefore did not change.

The production dashboard is currently only partially compatible with this
system:

- Dashboard and Positions can read a freshly selected Alpaca account.
- Authentication, account metadata, credentials and equity history use
  Supabase.
- Market regime, SPY comparison, Research and Screener still read stale,
  committed V10-era files from `state/`.
- The dashboard does not read the private V11 production artifact, so it does
  not know the approved trading release, frozen target, risk-off latch, true
  execution risk snapshot, pending convergence, last preflight or scheduler
  health.
- The UI therefore mixes facts with different sources, accounts, timestamps
  and meanings. A fresh broker request is not the same thing as a fresh V11
  run.

This document defines the source-of-truth hierarchy and the contract the UI
must follow. It deliberately separates **broker state**, **strategy intent**,
**operational health**, **validation evidence** and **historical research**.

## 2. Non-negotiable claim and safety boundary

No strategy can be made “perfect”, and positive historical alpha cannot be
guaranteed to continue. Every user-facing result must preserve these facts:

- V11 is in **paper forward validation**, not production-proven live trading.
- The supported executor is hard-wired to Alpaca paper trading.
- A validation `PASS` permits new paper exposure only when every identity and
  freshness gate still matches.
- Historical results have current-universe selection/survivorship bias.
- The 2025–2026 interval was seen during prior development and is explicitly a
  reused temporal check, not a fresh holdout.
- Jensen alpha is a SPY/BIL CAPM statistic, not a promise of economic profit.
- Account equity before the V11 cutover contains legacy V10/TQQQ/UPRO history
  and cannot be labeled “V11 performance” without a persisted V11 epoch
  baseline.
- The dashboard is a read-only observability layer. It must not become a
  trading control plane or reimplement strategy decisions in TypeScript.

The correct user-facing phrase is “historical diagnostic” or “paper
forward-validation result”, never “guaranteed alpha”, “works perfectly” or
“production proven”.

## 3. Source-of-truth hierarchy

When files disagree, use this order and show the source explicitly in the UI.

| Concern | Authoritative source | Notes |
|---|---|---|
| Current account, positions, orders and clock | Fresh Alpaca response for the explicitly bound account | Broker state is authoritative for what is actually held/filled. |
| Decision used by one production cycle | Captured production preflight/result for that cycle | Must include time, approved release and account binding. |
| In-flight target and order intent | Valid schema-v3 `adaptive_rebalance_pending` plan in the private runtime artifact | Intent is not a fill. It must match strategy and universe identity. |
| Active strategy rules | Effective `_V11_POLICY` in `scripts/strategy_config.py`, plus `scripts/adaptive_momentum.py` and `scripts/risk_policy.py` | Do not infer active policy from archived v3–v10 tables/functions. |
| Execution behavior | `scripts/execute_trades.py`, `scripts/trade.py`, `scripts/production_run.py` | Adaptive V11 dispatch disables the legacy trading stack. |
| Production approval | `paper-production` environment `PRODUCTION_RELEASE_SHA` plus a successful exact-SHA release gate | `main` or a trigger SHA is not automatically the traded SHA. |
| Promotion evidence | `state/backtest/v11_validation.json`, recomputed and identity/freshness checked | `PASS` is paper-only and expires. |
| Cross-strategy research | Epoch-specific tournament spec, result Markdown and JSON artifact | Never merge tournament metrics with canonical-validator metrics. |
| Dashboard policy labels | `dashboard/lib/v11-policy.json` | A tested display mirror, not the trading source of truth. |
| Committed `state/performance.json` and `state/positions.json` | Legacy/seed snapshot only | Never substitute them for account-scoped production data. |
| `state/research*.json`, `state/screener.json`, `state/spy_history.json` | Legacy research snapshots | Not current V11 runner state. |
| v3–v10 documents and modules | Archive/audit reference | Not current policy. |

Two older dashboard documents need special care:

- `DASHBOARD_SPECIFICATION.md`
- `DASHBOARD_IMPLEMENTATION_PLAN.md`

They describe an older ambition in which an agent trades every Supabase paper
and live account. That directly conflicts with the current guarded, single
approved **paper-only** executor. They are historical planning material, not an
authority for the new implementation. Any useful authentication, RLS or data
model ideas may be retained, but their trading-control assumptions must not be
revived.

## 4. Current high-level architecture

```text
                          RESEARCH / RELEASE PLANE

  strategy code + adjusted bars + frozen universe
                         |
                         v
  canonical V11 validator ------> v11_validation.json (PASS/FAIL evidence)
                         |
                         v
  V11 Release Gate for exact commit SHA
                         |
                         v
  explicit paper-production PRODUCTION_RELEASE_SHA approval


                         EXECUTION PLANE

  weekday/manual GitHub Actions paper workflow
                         |
        restore exact-SHA private runtime artifact
                         |
        verify release + validation + identity + bars
                         |
        paper broker preflight + dry/guarded execution
                         |
             Alpaca PAPER account only
                         |
        save performance.json / positions.json /
        production/last_run.json to a private artifact


                         OBSERVABILITY PLANE

  Browser -> Next.js dashboard -> Supabase Auth/RLS/Vault
                              |-> selected Alpaca account (read-only snapshot)
                              |-> Supabase equity history + cash flows
                              |-> repository evidence at an explicit git ref
                              |-> GitHub Actions run/gate metadata
                              |-> private V11 runtime artifact
                                  (server-only, lineage-validated, sanitized)
```

The last arrow was the core dashboard problem and is now closed. Broker
positions alone cannot reveal the target portfolio, signal date, breadth tier,
SPY gate, recovery latch, plan identity, pending order lifecycle or production
workflow status; those now come from the private runtime artifact, read only on
the server and returned to the browser as a sanitized DTO.

### 4.1 Three different deployed versions

As of this audit, three SHAs have different meanings:

| Layer | SHA / tag | Meaning |
|---|---|---|
| Repository `main` | `49cd8bda494550f1b8b7b2232eb7af6fe92e9390` | Latest source, including the strategy tournament. Its V11 Release Gate passed. |
| Approved paper executor | `0cb02c0765ebf91e60e5efd7f51334e9b538fbcb` / `v11-paper-prod-2026-08-02` | Exact release checked out by the guarded paper workflow. |
| Deployed dashboard | `d11bbad8aad7ec98596b0d290cb938706982d069` / `v11-dashboard-prod-2026-08-03` | Build reported by `https://nate-trader.anikin.cz/api/health`. |

The UI must never call the default-branch/trigger SHA the “trading release”. A
scheduled run may be triggered from a newer `main`, while the workflow itself
checks out the older explicitly approved SHA.

## 5. V11 Adaptive Momentum in detail

### 5.1 Instrument universe

The intended live discovery boundary is Alpaca assets that are active,
tradable US equities on supported exchanges. `scripts/universe.py` then keeps
ordinary common stocks and ADRs and excludes, among other things:

- ETFs and ETNs;
- mutual funds and other funds;
- warrants, rights and units;
- leveraged and inverse products;
- volatility products;
- malformed or unsupported tickers/exchanges; and
- non-tradable assets.

The cache `state/universe.json` is accepted only when its schema, Alpaca
provenance, US-equity class, symbol count, strict UTC timestamp, seven-day
freshness and minimum breadth all validate. A partial discovery result cannot
overwrite a good cache.

The current checkout has no `state/universe.json`. The promoted strategy and
last production preflight therefore use a filtered `watchlist.json` fallback:

- ranking symbols: 540;
- ranking-universe SHA-256:
  `c86dc489c62625cd380dae6c105e28ee3dbe9aa124363b4dcd1a9f932bafa074`;
- production label: `validated-watchlist-fallback`.

A dynamic Alpaca refresh changes the ranking set and its hash. It cannot be
silently traded with old evidence: the complete adjusted history must be
rebuilt and the canonical validator and sanity check must pass again.

A currently held symbol outside the ranking universe remains in the risk/exit
set so it can be reconciled or sold. Holding it never makes it rank-eligible.

V11 therefore covers many ordinary US stocks, not “every possible stock and
everything else”. Crypto, options, futures, FX and non-US asset classes are
outside the implemented and validated strategy.

### 5.2 Information clock

V11 is explicitly causal:

1. At completed session close **D**, load only bars completed on or before D.
2. Form SPY state, eligibility, ranks, sectors and target weights from that
   information.
3. Trade no earlier than **D+1**.
4. An all-cash account may start target buys at D+1.
5. If a D+1 rebalance first requires sells or trims, freeze the target, wait
   for broker fill/cash reconciliation and a new invocation/session boundary,
   then place replacement buys no earlier than D+2 in the simulator.

Live daily frames exclude the current calendar date so a partial intraday
daily bar cannot leak into the signal. Live DAY limit orders may fill later or
not at all; “D+1 open” is the earliest legal backtest/decision clock, not a
promise of the official opening print.

### 5.3 Ranking signal

For stock `i` at completed date D:

```text
12-1 momentum = close[D-21] / close[D-252] - 1
6-1 momentum  = close[D-21] / close[D-126] - 1
```

Ranking is deterministic:

1. descending 12-1 momentum;
2. descending 6-1 momentum as a tie-breaker; and
3. ticker symbol for an exact tie.

V11 does not use the legacy news/AI confidence score, a score threshold of 65,
RSI, MACD, most-active lists or short-term movers to authorize a trade.

### 5.4 Eligibility filters

A new candidate must pass all of these checks at the signal date:

| Filter | Production default |
|---|---:|
| Completed history | At least 253 valid sessions |
| Last close | At least $10 |
| Median dollar volume | At least $25m over 60 sessions |
| Annualized volatility | At most 80% over 63 daily returns |
| Absolute momentum | 12-1 return greater than zero |
| Stock trend | Close above SMA200 |
| Sector | Known statically or inferable from sector-ETF correlation |
| History continuity | No calendar gap longer than 10 days inside the required epoch |

Unknown or weakly inferred sectors are rejected rather than allowed to bypass
the sector cap.

### 5.5 Target construction

The production target is transparent:

- select up to ten highest-ranked eligible stocks;
- equal weighting;
- at most 9% of equity per name;
- at most 20% of equity per sector;
- normal gross target at most 90%;
- minimum target cash 10%;
- if fewer than eight names qualify, reduce gross exposure proportionally;
- leave any allocation that cannot fit the caps in cash; and
- trim/top up only when dollar drift exceeds 0.5% of account equity.

Top ten, 9% and 20% are **target-construction rules**. A live broker snapshot
may temporarily have nine of ten positions, a weight slightly above 9% after a
price move, or transitional legacy exposure. The UI must describe the delta
and lifecycle, not automatically call every drift a strategy failure.

### 5.6 Breadth scaler

Breadth is the share of liquid, price-eligible names above their SMA200:

| Breadth | Multiplier applied to base gross target |
|---:|---:|
| At least 60% | 100% |
| 45% to below 60% | 80% |
| 30% to below 45% | 55% |
| Below 30% | 25% |

An unavailable breadth calculation fails defensively to 50% exposure scaling;
it never authorizes more exposure. Breadth changes gross exposure, not ranks,
and it cannot bypass SPY, risk, position or sector rules.

### 5.7 SPY market gate and recovery

SPY must be above its 200-session SMA for a non-zero directional target. This
gate is checked on every executor invocation, not only at month start.

When SPY is below SMA200:

- the target is zero;
- outstanding directional buys are cancelled;
- directional holdings are converged toward cash; and
- zero-target intent is persisted until the broker account is actually flat.

After the completed SPY close returns above SMA200, a persisted recovery latch
permits one fresh off-cycle D-close/D+1 target. Once consumed, ordinary monthly
cadence resumes.

The legacy `BULL/BEAR/NEUTRAL` label in `research_summary.json` is not this
gate. The V11 UI should show `SPY RISK-ON` or `SPY RISK-OFF`, the completed
session, SPY close, SMA200 and recovery-latch state.

### 5.8 Portfolio damage tiers

Risk classification uses current equity, the previous broker equity and the
highest observation inside a rolling 22-session window:

| Tier | Trigger | Behavior |
|---|---|---|
| `NORMAL` | No higher tier active | Up to 90% base gross before breadth scaling. |
| `CAUTIOUS` | Rolling drawdown <= -10% or daily return <= -5% | The next risk-on target is half-sized, normally up to 45% gross before breadth scaling. It does not force a daily mid-month resize. |
| `HALT` | Daily return <= -8% | Immediate zero directional target and risk-reducing exits on every cycle. |

The SPY gate and risk tier combine. A `CAUTIOUS` account can still take reduced
risk when SPY is above SMA200; SPY risk-off or `HALT` produces a zero target.

### 5.9 What V11 explicitly disables

The effective policy sets these legacy/alternative sleeves to zero or off:

- SPY or SSO base exposure;
- TQQQ and UPRO leveraged exposure;
- SH/inverse hedge;
- options hedge;
- mean reversion;
- PEAD;
- sector rotation;
- legacy catalyst/confidence-score entries;
- fixed stop-loss, trailing-stop, scale-out, fixed take-profit and time-stop
  management for adaptive positions.

V11 has **no fixed per-position 8% stop**. Its exits come from target reranking,
monthly convergence, the SPY trend gate and `HALT`. BIL is only the risk-free
proxy used by metrics; V11 does not invest defensive cash in BIL.

Legacy functions and v3–v10 parameter tables remain in Python for audit and
migration. Active parameters are produced by applying `_V11_POLICY`, and the
adaptive dispatch skips the legacy order stack. UI code must not introspect an
old table, docstring or function name and present it as current strategy.

## 6. Data completeness and fail-closed behavior

Risk-on target creation is intentionally strict:

- a broad batch response must include a non-empty frame for every requested
  ranking and auxiliary symbol;
- SPY and all requested sector auxiliaries must end on one identical completed
  session;
- that SPY session may be no more than seven calendar days old;
- SPY, requested auxiliaries and every held ranking constituent need at least
  253 valid completed bars;
- at least 50% of the ranking universe, and never fewer than eight names, must
  be analyzable before a new risk-on target can be formed;
- a stale non-held stock may simply become ineligible;
- stale/truncated data for a held ranking stock pauses risk-on planning so a
  one-symbol outage cannot manufacture a sale; and
- missing/corrupt state cannot authorize new exposure.

`HALT` and SPY risk-off exits remain available when risk-on data or validation
fails. The system should fail toward cancelled buys, cash and explicit
`UNAVAILABLE`, not toward guessed targets.

Historical data are split/dividend adjusted. A full rebuild uses Alpaca IEX
when credentials are available and adjusted yfinance as a fallback.
`--incremental` is faster but is not safe promotion evidence because later
corporate actions can revise the historical adjustment basis.

## 7. Live order lifecycle and safety

The broker-independent planner returns target weights. The executor converges
actual positions to those targets:

1. Read and validate open orders and current positions.
2. Reconcile any short before all other V11 activity.
3. Cancel retired-infrastructure and unbound/stale directional buys.
4. Persist emergency zero intent before cancellation boundaries.
5. Exit dropped names and trim overweights first.
6. Wait for terminal fills and a new broker snapshot/session boundary.
7. Validate cash, position and sector caps again before every buy.
8. Submit purpose-scoped, deterministic DAY limit-order IDs.
9. Treat submission as intent, never as proof of fill.
10. Mark a rebalance complete only after observed broker positions converge.

The frozen schema-v3 plan binds:

- `plan_id`;
- rebalance month and signal date;
- target weights and sectors;
- risk-off flag;
- construction risk tier;
- eligible count;
- strategy identity;
- ranking-universe hash; and
- idempotent order-attempt records.

Mutating execution has multiple independent guards:

- no-argument `scripts/execute_trades.py` is dry-run;
- a mutating path requires exactly `TRADING_MODE=paper`;
- supported broker clients use `paper=True`;
- new exposure requires a fresh open Alpaca clock;
- a paper buy requires a current canonical `PASS` artifact whose strategy,
  universe and adjusted-bar evidence match the running release;
- malformed, missing, stale or mismatched evidence blocks buys;
- a closed entry gate does not block cancellations or risk-reducing exits.

The dashboard may connect to a real Alpaca account for **read-only monitoring**.
That does not make the V11 executor live-capable and must never display a
live observer account as “managed by V11”.

## 8. Canonical validation result

Artifact: `state/backtest/v11_validation.json`

| Property | Value |
|---|---|
| Generated | 2026-08-02 15:56:49 UTC |
| Allowed mode | `paper-validation-eligible` |
| Assessment | `PASS`, 8/8 required positive historical checks |
| Development | 2022-01-04 through 2024-12-31, 752 sessions |
| Reused temporal check | 2025-01-02 through 2026-07-10, 380 sessions |
| Starting capital | $1,000,000 |
| Ranking universe | 540 symbols, exact hash shown above |
| Adjusted-bar boundary | 2026-07-10 |
| Requested/observed bar symbols | 552 / 552 |
| Strategy identity | `0cedd11966adff49ecb32b8cd84947efacbe5be8eeb35c1182f4c2f0411982be` |
| Runtime | Python 3.12.11, alpaca-py 0.43.5, NumPy 2.5.1, pandas 3.0.5 |
| Freshness limit | 35 days for report and bar boundary; the stored 2026-07-10 bar boundary is the earlier constraint and reaches its limit on 2026-08-14 UTC |

### 8.1 Stored headline metrics

| Cost per fill | Segment | V11 CAGR | SPY CAGR | Excess CAGR | Jensen alpha | Sharpe | Max drawdown |
|---:|---|---:|---:|---:|---:|---:|---:|
| 7 bps | Development | 17.1022% | 8.8198% | +8.2824 pp | +10.5896% | 1.0226 | -18.6554% |
| 7 bps | Reused temporal | 19.9535% | 18.7328% | +1.2208 pp | +8.0530% | 0.7789 | -17.2217% |
| 15 bps | Development | 15.8933% | 8.8198% | +7.0735 pp | +9.5498% | 0.9385 | -19.7053% |
| 15 bps | Reused temporal | 19.0004% | 18.7328% | +0.2677 pp | +7.2580% | 0.7403 | -17.3795% |

The 15 bps reused raw excess is only +0.2677 percentage points. The positive
Jensen alpha partly reflects lower SPY beta. These facts must be visible
instead of collapsing the result into a single green “alpha” number.

### 8.2 Limitations that must accompany the metrics

- The ranking universe is based on a current/fallback list, not historical
  point-in-time membership with complete delisting returns.
- The later interval is reused and was not isolated from earlier inspection.
- Some symbols lack a complete requested historical range or full pre-start
  warm-up, although the strict promotion window passed its defined coverage
  checks.
- Fixed slippage scenarios do not model every spread, impact, queue, partial
  fill, rejection or outage.
- The report digest is tamper-evident, not a cryptographic authorization
  signature.
- A code, dependency, workflow, universe or validated historical-prefix change
  requires a new canonical validation.

## 9. Strategy tournament epoch 1

Authoritative artifacts:

- `strategy/strategy_tournament_epoch_1.md` — frozen protocol;
- `strategy/strategy_tournament_epoch_1_results.md` — compact result; and
- `state/backtest/strategy_tournament_epoch_1.json` — complete evidence.

The tournament compared V11 with:

- risk-adjusted momentum;
- market-residual momentum;
- FIP momentum;
- 52-week-high proximity;
- sector-neutral momentum;
- low-volatility trend;
- momentum/low-volatility ensemble;
- core-satellite;
- sector-ETF momentum;
- short-term reversal negative control.

The protocol included 7/15/25/50 bps costs, an extra reversal cost case, D+2
execution delay, 1% ADV capacity checks, six development folds, three reused
folds, 10,000-sample stationary bootstrap, White Reality Check, adjusted
Deflated Sharpe and a conservative multiple-testing floor.

Decision: **`RETAIN_V11`**.

- No challenger was statistically eligible.
- No shadow challenger was selected.
- Production did not change.
- V11 was the descriptive maximum-return and balanced-score leader.
- `low_vol_trend` was the descriptive minimum-bootstrap-drawdown leader, but
  its return and SPY-relative performance were too weak.

At the primary 15 bps assumption:

| Candidate | Dev CAGR | Dev excess | Dev Sharpe | Dev drawdown | Reused excess | Interpretation |
|---|---:|---:|---:|---:|---:|---|
| V11 incumbent | 15.87% | +7.06 pp | 0.94 | -19.71% | -0.10 pp | Retained baseline and return leader. |
| Risk-adjusted momentum | 12.27% | +3.46 pp | 0.67 | -15.43% | +8.02 pp | Interesting reused result, but failed development cost/delay/statistical gates. |
| Low-vol trend | 4.21% | -4.60 pp | 0.08 | -13.85% | -13.36 pp | Lower risk, insufficient return; not promotable. |

The tournament runner and canonical validator are different controlled
experiments, so their V11 reused-period numbers are slightly different. The UI
must keep their names, methodology and metrics separate.

## 10. Production deployment and operations

There are only two supported GitHub workflows:

### 10.1 `V11 Release Gate`

`.github/workflows/v11-release.yml` runs on `main` pushes and pull requests.
It verifies:

- locked dashboard install;
- high-severity dependency audit;
- dashboard unit tests, ESLint, TypeScript and production build;
- Python 3.12.11 and hash-locked production requirements;
- complete Python regression suite;
- compile checks and critical Ruff checks; and
- canonical promotion artifact through `scripts/sanity_check.py`.

A green release gate makes a commit reviewable/approvable. It does not place an
order.

### 10.2 `V11 Paper Production`

`.github/workflows/paper-production.yml`:

- requests a weekday run at 15:05 UTC; GitHub may start it later;
- serializes invocations with concurrency;
- checks out only the full SHA stored in `PRODUCTION_RELEASE_SHA`;
- requires a green release gate for that exact SHA;
- installs Python 3.12.11 and `requirements.lock` with hashes;
- restores only a matching private runtime artifact;
- runs offline sanity and paper broker/deployment preflight;
- optionally runs a read-only dry preview;
- calls `scripts/production_run.py` only for the schedule or explicit execute;
- preserves runtime state for 90 days and diagnostics for 30 days; and
- returns failure on blocking `ABORT`/`ERROR` records.

Mutable runtime state is intentionally not committed. The artifact includes:

- `state/performance.json`;
- `state/positions.json`; and
- `state/production/last_run.json`.

The workflow uses repository Alpaca paper secrets. Supabase dashboard accounts
use a separate credential store. Until an explicit, verifiable account binding
exists, the UI cannot assume the selected Supabase account is the production
executor account merely because it is paper or happens to hold similar names.

### 10.3 Operational snapshot at this audit

These values are time-sensitive evidence for the handoff and must not be
hard-coded into the application. They were already superseded on the day this
document was written; the live equivalents are on the dashboard's
`/operations` screen, read from the Actions run metadata and the private
runtime artifact:

- Last successful paper cycle: 2026-08-05 16:50 UTC.
- Preflight: 18/18 checks passed, paper endpoint, no shorts or pre-existing
  open orders.
- Captured execution risk snapshot: `NORMAL`; market entry was allowed.
- Last saved broker snapshot contained nine V11 equities: ASML, CASY, CAT,
  MPC, MRK, PANW, ROST, VLO and VRT.
- Frozen plan `29a8b1667bd3ac6c` used signal date 2026-08-03 and targeted ten
  names at 9%; UNH was the missing target and MPC needed a top-up.
- Two `ADAPTIVE_BUY` records meant orders were submitted, not proven filled.
- The next scheduled attempt on 2026-08-06 failed before the job started
  because GitHub could not acquire a hosted runner. No strategy, preflight or
  broker execution ran in that failed attempt.

The correct operations UI must show both “latest workflow attempt failed due
to infrastructure” and “last successful executor snapshot is from 5 August”.
It must not reduce both facts to a single green or red dot.

### 10.4 Runtime risk-state conflict discovered in the audit

The last run/preflight captured `NORMAL` from a fresh broker account and
rolling-history snapshot. The subsequently saved `performance.json` classified
`CAUTIOUS` from a mixed local daily history containing the older V10 period.

For the decision made by that cycle, the captured per-run broker risk snapshot
is authoritative. A future UI must retain source and time for both values and
surface the conflict. It must not silently choose a convenient green value or
merge the histories.

## 11. Current dashboard architecture

### 11.1 Technology

- Next.js 16 App Router;
- React 19 and strict TypeScript;
- Tailwind CSS 4;
- Recharts;
- Supabase Auth/SSR, Postgres, Vault and RLS;
- Vitest for data/policy contracts;
- standalone Docker build;
- production URL currently reports account-scoped mode.

Routes:

- `/` — account overview;
- `/accounts` — account and credential management;
- `/positions` — broker positions;
- `/research` — legacy V10 research diagnostics;
- `/screener` — legacy V10 screener;
- `/settings` — profile/default observer account/password;
- `/login` — Supabase authentication.

Important API routes:

- `/api/accounts/[id]/live` — authenticated, account-scoped Alpaca account and
  position snapshot, `no-store`;
- `/api/accounts/[id]/equity` — refreshes/mirrors Alpaca portfolio history into
  Supabase and returns equity snapshots/cash flows;
- `/api/accounts/*` — account CRUD and verification;
- `/api/health` — web configuration/build health only;
- `/api/live` — retired global endpoint, correctly returns 410;
- `/api/spy-history` — committed legacy benchmark history.

### 11.2 What already works correctly

- A delayed request for account A cannot paint over selected account B.
- Account/mode/schema/source are runtime-validated before live broker data are
  displayed.
- In account-scoped production mode, broker failure does not silently fall
  back to a global committed account snapshot.
- Supabase Auth gates the application; RLS isolates account rows.
- Alpaca credentials stay server-side in Vault.
- Live observer accounts are labeled read-only and the V11 executor remains
  paper-only.
- Current source already removed the screenshot-era “max 15” and fixed “STOP
  8%” columns and mirrors the basic V11 top-10/cash/name constraints.
- `tests/test_dashboard_policy_contract.py` prevents the static display mirror
  from silently drifting from important Python policy values.

### 11.3 Why the UI is still incompatible

The application mixes at least four independent scopes:

| UI datum | Current source | Problem |
|---|---|---|
| Equity, cash, daily P&L, current positions | Direct selected Alpaca account | Fresh broker state, but not necessarily the production-controlled account. |
| Equity curve | Alpaca history mirrored into Supabase | Cash flows are returned but currently ignored by the main UI. It can include legacy pre-V11 history. |
| SPY regime/monthly comparison | `state/research_summary.json` on `main` | Snapshot ends 2026-07-10 and its regime is not the V11 SPY/SMA200 gate. |
| Research | `state/research.json` on `main` | Archived V10 confidence/news/Perplexity process. |
| Screener | `state/screener.json` on `main` | Archived V10 movers/score-65 process, last updated 2026-06-02. |
| Strategy target/risk/lifecycle | Not loaded | Exists in the private runtime artifact. |
| Scheduler/release/preflight health | Not loaded | `/api/health` only reports web readiness. |

Consequences:

- `ALPACA FRESH` means only that an HTTP broker request just succeeded. It says
  nothing about the latest market-data session, V11 target, workflow,
  validation or fill.
- The sidebar’s green “Dashboard Online” dot is static web chrome, not system
  or strategy health.
- A V11 guardrail is evaluated against any selected observer account, even
  though the dashboard cannot prove that V11 controls it.
- Broker positions cannot reveal target weights, sector caps, pending fills or
  recovery state.
- Missing data are sometimes rendered as zero, which fabricates financial
  information.
- The monthly portfolio calculation and SPY snapshot can cover different
  windows.
- The chart can extend a stale SPY value flat across newer portfolio dates and
  still label the difference alpha.
- Returned deposits/withdrawals are ignored, so simple equity change can
  mistake cash flow for investment return.
- UTC is used for a synthesized “today” point while Alpaca history is bucketed
  in America/New_York, creating a possible date-boundary mismatch.
- All-time account history includes V10 and cannot be called V11 performance.

Checked-in legacy state explains old screenshots:

- `state/performance.json` and `state/positions.json` are from 2026-07-10;
- the committed position snapshot contains TQQQ and UPRO;
- production runtime moved to a private Actions artifact and is not committed;
- an account-scoped browser request may show the real broker state, while a
  fallback/old deployment can still display that stale seed.

## 12. Required unified dashboard read model

Create one server-side, runtime-validated DTO instead of letting components
join unrelated files. A suggested conceptual contract is:

```text
StrategyStatusPayload
  schemaVersion
  collectedAt
  freshness / warnings

  web
    dashboardBuildSha
    dataMode
    status

  release
    repositoryMainSha
    researchRefSha
    approvedPaperReleaseSha
    releaseGateStatus

  accountBinding
    selectedObserverAccountId
    productionAccountBound (true/false)
    bindingProof/source
    mode (paper/live)

  broker
    source + asOf
    equity / cash / positions / open-order summary / clock

  strategy
    version / identity / paperOnly
    universe source/count/hash
    signalDate / rebalanceMonth
    SPY close / SMA200 / riskOn
    breadth / breadthMultiplier
    riskTier / trigger / source
    recoveryLatch
    frozenPlanId / construction tier
    target weights + sectors
    convergence state + pending actions

  validation
    status / allowedMode
    generatedAt / boundary / expiresAt
    strategy/universe/bar identity match
    development and reused metrics
    required warnings

  operations
    latestWorkflowAttempt
    lastSuccessfulPreflight
    lastSuccessfulExecution
    approved release lineage
    action counts / blocking reason

  tournament
    epoch / status / decision / productionChanged
```

Every section must carry its own `source`, scope, absolute `asOf`, age and
freshness classification. One root timestamp is insufficient.

Raw credentials, Vault IDs, full account numbers, raw private artifacts,
broker order IDs and client-order IDs must never be returned to the browser.

### 12.1 Getting strategy runtime data safely

Use one of these safe approaches after reviewing operational trade-offs:

1. A server-only reader for the latest exact-release private Actions artifact,
   with strict name, release lineage and schema validation, followed by a
   minimal sanitized DTO; or
2. A sanitized read-only observability mirror written after production into an
   account-scoped Supabase table, with explicit release/account identity and
   RLS.

Do not expose a GitHub token to the client. Do not use committed V10 state as a
fallback when the runtime source is unavailable. Return `UNAVAILABLE`.

Changing `scripts/production_run.py`, the paper workflow or another strategy
identity source invalidates existing promotion evidence. If an exporter
touches those files, a new canonical validation and release gate are required
before another paper buy. A separate read-only adapter is preferable when it
can satisfy the contract without changing trading behavior.

### 12.2 Required state vocabulary

Use explicit states, not binary green/red guesses:

- `CURRENT` — source is available, scoped and within its defined freshness;
- `STALE` — valid but older than its contract;
- `EXPIRED` — evidence is past an authorization/freshness deadline;
- `MISMATCH` — identity, account, release, date or schema does not match;
- `UNAVAILABLE` — source could not be obtained safely;
- `NOT_APPLICABLE` — a rule does not apply to this observer/account/state;
- `PENDING` — submitted/reconciling, not filled/converged;
- `PASS`, `WARN`, `FAIL` — only when a defined check actually ran.

Never convert `null`, missing, stale or mismatched financial data to `$0`,
`0%`, a green check or “LIVE”.

## 13. Target page-by-page product contract

### 13.1 Global application shell

Always show:

- `V11 Adaptive Momentum`;
- `PAPER FORWARD VALIDATION`;
- selected observer account and its paper/live mode;
- whether that account is explicitly bound to the production executor;
- broker snapshot freshness;
- strategy runtime freshness;
- latest workflow outcome;
- validation state; and
- dashboard build SHA separately from the approved paper release SHA.

Replace the static “Dashboard Online” dot with separately named web, broker,
strategy and scheduler states. All timestamps should have a precise tooltip in
UTC and America/New_York (or the user locale) and a relative age.

### 13.2 `/` — Overview

Organize the page into distinct sections:

1. **Broker account** — equity, cash, daily P&L and actual exposure from one
   validated account snapshot.
2. **V11 market/risk state** — signal session, SPY vs SMA200, risk-on/off,
   breadth, multiplier, captured risk tier/reason and recovery latch.
3. **Target convergence** — frozen plan, target gross/cash, actual gross/cash,
   target count, observed count and the next pending action.
4. **Operations** — latest workflow attempt, last successful preflight, last
   successful executor cycle, approved SHA and any blocking failure.
5. **Forward validation performance** — only after a real V11 epoch baseline
   exists; use cash-flow-adjusted TWR and SPY over the same dates.
6. **Evidence** — canonical validation freshness and concise limitations.

Do not call unmatched simple returns alpha. If no V11 cutover baseline exists,
show “V11 forward performance unavailable — baseline not persisted” rather
than using all-time account history.

### 13.3 `/positions` → Portfolio

For each symbol, show:

- actual broker quantity/value/weight;
- V11 target weight;
- dollar and percentage-point delta;
- target sector;
- classification (`TARGET`, `LEGACY/EXCLUDED`, `HELD-ONLY`, `UNMANAGED`);
- lifecycle (`KEEP`, `BUY`, `TOP-UP`, `TRIM`, `EXIT`, `PENDING`, `CONVERGED`);
- signal date and plan ID context; and
- actual unrealized broker P&L, clearly separate from strategy performance.

TQQQ/UPRO or any other real holding must never be hidden. If held, display it
as actual legacy/excluded exposure with target 0 and its migration state.

Do not invent stop prices. V11 has no fixed 8% position stop.

### 13.4 `/screener` → Signals / Universe

Replace the active V10 score/movers presentation with V11 information:

- universe source, count, hash and cache/fallback freshness;
- completed signal date;
- eligibility funnel: data, price, liquidity, trend, positive 12-1,
  volatility and sector;
- 12-1 rank and 6-1 tie-break;
- breadth numerator/denominator and tier;
- selected target basket and weights.

Do not recompute V11 in the browser or duplicate it in TypeScript. The runner
must persist/export the needed sanitized ranking diagnostics. Until those
diagnostics exist, display `UNAVAILABLE`. Legacy score-65, most-active, movers
and AI confidence may live only in a clearly separated archive, never as an
active trading signal.

### 13.5 `/research` → Validation & strategy research

Primary content:

- canonical V11 `PASS/FAIL`, allowed mode, generated date, expiry and bar
  boundary;
- strategy, universe and bar identity match;
- 7/15 bps development vs reused-temporal metrics;
- survivorship, reused-period and no-guarantee warnings;
- epoch-1 tournament status, `RETAIN_V11`, no eligible challenger and
  `productionChanged=false`;
- clear separation of the canonical validator and tournament methodologies.

Move old V10 news/Perplexity/confidence research out of primary navigation or
put it under an explicit non-trading archive.

### 13.6 `/accounts`

Preserve secure account creation, verification, key rotation and removal.
Add an unambiguous distinction:

- **production-controlled paper account** — only when proven by an explicit
  server-side binding; and
- **observer-only account** — any other paper or live account.

A live account must always display “read-only monitoring; never traded by
V11”. Switching the observer account must not switch the GitHub Actions
executor.

### 13.7 New `/operations`

Add a read-only operations page containing:

- web build SHA;
- repository/research SHA;
- approved paper release SHA;
- release gate and validation gate;
- latest scheduled attempt and infrastructure outcome;
- last successful preflight/execution;
- paper-only and market-entry status;
- frozen plan/convergence summary;
- sanitized action counts/blocking reason; and
- safe link to the relevant Actions run when available.

No execute, cancel, sell, approve-release or emergency-trade buttons belong in
the web UI.

### 13.8 `/settings`

Keep profile, password, default observer account and credential management.
Add a read-only effective V11 policy summary. Do not add strategy tuning,
universe refresh or risk-limit controls.

## 14. Return and benchmark correctness

Any performance comparison must satisfy all of these conditions:

- same bound account;
- explicit V11 epoch start and release identity;
- same start/end sessions for portfolio and SPY;
- no forward-filling SPY beyond its last actual common session;
- cash-flow-adjusted TWR (or a clearly labeled unadjusted equity series);
- exact source and time zone;
- no reuse of V10 account history as V11 results; and
- `UNAVAILABLE` when dates, cash flows or benchmark coverage cannot be aligned.

The current `/api/accounts/[id]/equity` response already includes cash flows,
but the client ignores them. Fix that before presenting account return. A
deposit must not look like profit and a withdrawal must not look like a loss.

Historical backtest alpha and live paper account performance are different
products. Never splice them into one continuous chart.

## 15. Security requirements for any dashboard rebuild

- Keep the application behind Supabase authentication.
- Preserve RLS account isolation and exact account scoping.
- Keep service-role keys, GitHub tokens and Alpaca credentials server-only.
- Never return Vault UUIDs, secrets, full broker account numbers or raw private
  artifacts.
- Keep financial/account API responses `no-store`.
- Preserve request cancellation and exact account/mode/schema checks on account
  switching.
- Do not fall back from a failed account-scoped request to public repo state.
- Preserve HSTS, clickjacking, MIME-sniffing and CSP headers.
- Redact logs and error messages.
- Do not modify `PRODUCTION_RELEASE_SHA`, trigger an execute workflow or place
  broker orders as part of a UI deployment.
- If a required strategy-identity file changes, stop paper buys until a new
  canonical validation/release promotion is complete.

## 16. Required test matrix for the rebuild

### 16.1 Unit and contract tests

- Runtime DTO validation for every source and schema.
- Freshness/expiry/mismatch classifications.
- Exact separation of build, main/research and approved-trading SHAs.
- Tri-state/explicit guardrail evaluation.
- Target-vs-actual and legacy/held-only classification.
- TWR with deposits and withdrawals.
- Benchmark alignment with no forward-fill beyond common dates.
- New York session-date handling.
- Validation expiry and identity mismatch.
- Sanitization/no-secret serialization.

### 16.2 API and security tests

- unauthenticated access;
- RLS and account A/B isolation;
- selected account different from production binding;
- live observer account;
- Alpaca timeout/auth/schema failure;
- Supabase outage;
- GitHub/artifact outage or corrupt zip;
- stale exact-release artifact;
- trigger SHA different from approved release;
- raw artifact/order identifiers never reach the response.

### 16.3 Component states

Every page needs fixtures for:

- loading;
- empty but valid;
- current;
- stale;
- expired;
- mismatch;
- unavailable;
- broker fresh but runtime stale;
- latest workflow failure with an older successful executor run;
- SPY risk-off cash portfolio;
- `CAUTIOUS` and `HALT`;
- recovery latch;
- nine-of-ten pending convergence;
- real TQQQ/UPRO legacy holdings;
- short-position reconciliation;
- missing V11 epoch baseline; and
- zero positions due to risk-off versus zero positions due to missing data.

### 16.4 End-to-end, accessibility and visual checks

- login/logout and protected routes;
- switch accounts without cross-account bleed;
- all observer/production-bound mode labels;
- keyboard navigation, focus management, skip link and accessible dialogs;
- `aria-expanded`/status semantics and screen-reader-readable tables;
- reduced motion and adequate light/dark contrast;
- responsive layouts at approximately 390, 768 and 1440 px;
- visual regression for both themes.

### 16.5 Release commands

At minimum:

```bash
cd dashboard
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
npm audit --audit-level=high

cd ..
PYTHONPATH=scripts python3 -m pytest -q
python3 -m compileall -q scripts tests
python3 scripts/sanity_check.py
```

Use the repository’s pinned Python 3.12.11 environment for promotion checks.
A local interpreter/version mismatch is a dev-environment failure, not evidence
that the promoted release itself failed.

## 17. Production deployment acceptance criteria

A dashboard rebuild is complete only when all of these are true:

1. Active UI contains no max-15 rule, fixed 8% stop, TQQQ/UPRO target, V10
   score-65 authorization or AI/news trading signal.
2. Real legacy holdings remain visible as actual positions with V11 target 0.
3. No status says `LIVE`, `FRESH` or `ONLINE` without a named source, scope and
   freshness contract.
4. Selected observer account is never called the production V11 account without
   explicit binding proof.
5. Missing/stale/mismatched data never become zero or a green check.
6. Broker state, strategy intent, scheduler health and validation evidence are
   visually and semantically separate.
7. Positions show actual vs target and order/fill convergence correctly.
8. Research shows canonical validation and the tournament, with limitations.
9. Screener shows V11 universe/signal diagnostics or honest `UNAVAILABLE`.
10. Performance uses a persisted V11 baseline, cash-flow-adjusted returns and a
    common SPY interval; otherwise it is unavailable.
11. The browser bundle and responses contain no sensitive server values.
12. Unit, contract, component/E2E, accessibility, build and Python regression
    gates pass.
13. Only the dashboard is deployed; no paper execution or release-SHA mutation
    is performed as part of deployment.
14. After deployment, the actual production `/api/health` reports the expected
    new dashboard build SHA and account-scoped mode.
15. Login gating, security headers, account switching and fail-closed states
    pass production smoke tests.

## 18. Known open gaps that UI alone cannot solve

Still open after the 2026-08-07 rebuild; each is rendered as `UNAVAILABLE`
rather than estimated:

- **No persisted V11 forward-validation epoch baseline.** The reader, schema,
  TWR math and UI all exist, but until a baseline containing release SHA, start
  time, starting equity and the benchmark baseline is committed to
  `state/v11_epoch_baseline.json`, forward performance stays `UNAVAILABLE`. It
  must not be back-filled from pre-V11 account history.
- **SPY close, SMA200 and the breadth census are not persisted.** The runner
  records only the resulting gate flag and eligible count, so the numeric SPY
  level, breadth numerator/denominator and breadth multiplier are `UNAVAILABLE`.
  Recomputing them in the browser would create a second, unvalidated strategy.
- **Per-filter eligibility and the 12-1 / 6-1 rank table are not persisted.**
  The funnel therefore shows universe → eligible → selected, with each
  individual filter stage `UNAVAILABLE`.
- The `paper-diagnostics` artifact is not SHA-scoped; the dashboard binds it to
  a specific successful run instead and cross-checks the strategy identity.
- A branch/repository security hardening review (for example branch and
  environment protection) is separate from this UI work.
- Strong historical claims still require point-in-time universe membership and
  delisting data plus a genuinely fresh forward period.

Closed by the rebuild: the sanitized private-artifact read model, the explicit
Supabase-account binding, the infrastructure-versus-strategy workflow-failure
distinction, and the removal of stale committed research/screener/benchmark
snapshots from the active UI.

The correct solution to a missing backend fact is a small, sanitized,
well-tested observability contract — not frontend inference.

## 19. Repository map

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Current agent operating/safety manual. |
| `strategy/v11_adaptive_momentum.md` | Authoritative V11 strategy specification. |
| `strategy/PRODUCTION_RUNBOOK.md` | Paper release, monitoring and rollback runbook. |
| `strategy/strategy_tournament_epoch_1.md` | Frozen tournament protocol. |
| `strategy/strategy_tournament_epoch_1_results.md` | Tournament result summary. |
| `scripts/strategy_config.py` | Effective V11 overlay plus archived older parameters. |
| `scripts/adaptive_momentum.py` | Broker-independent signal and target planner. |
| `scripts/universe.py` | Dynamic universe discovery/cache/fallback. |
| `scripts/risk_policy.py` | Shared rolling portfolio risk classifier. |
| `scripts/execute_trades.py` | Guarded target convergence and legacy migration. |
| `scripts/trade.py` | Alpaca paper order validation and lifecycle. |
| `scripts/production_preflight.py` | Exact-release/broker safety preflight. |
| `scripts/production_run.py` | One guarded production paper cycle and compact status. |
| `scripts/strategy_identity.py` | Strategy and universe identity hashes. |
| `scripts/backtest/validate_v11.py` | Canonical fixed-policy promotion validator. |
| `scripts/backtest/run_strategy_tournament.py` | Research-only pre-registered tournament. |
| `state/backtest/v11_validation.json` | Bound canonical validation evidence. |
| `state/backtest/strategy_tournament_epoch_1.json` | Complete tournament evidence. |
| `.github/workflows/v11-release.yml` | Non-trading release gate. |
| `.github/workflows/paper-production.yml` | Only supported scheduled paper executor. |
| `dashboard/` | Read-only Next.js application. |
| `dashboard/lib/status/` | The unified server-side V11 read model. |
| `dashboard/lib/status/read-model.ts` | Assembles `StrategyStatusPayload`. |
| `dashboard/lib/status/runtime.ts` | Lineage-validated private-artifact reader. |
| `dashboard/lib/status/authz.ts` | Server-side production-runtime authorization. |
| `dashboard/lib/status/binding.ts` | Account role derived from that authorization. |
| `dashboard/lib/status/validation-gate.ts` | The one effective paper-buy gate. |
| `dashboard/lib/status/performance.ts` | Cash-flow-adjusted TWR and benchmark alignment. |
| `dashboard/lib/v11-policy.json` | Tested UI mirror of static V11 labels/limits. |
| `supabase/` | Auth/account/Vault/RLS and telemetry data model. |

## 20. Handoff checklist for the next coding agent

Before editing:

- read this document, `CLAUDE.md`, the V11 spec and production runbook;
- inspect the current production `/api/health` and GitHub workflow state;
- confirm all three SHA scopes independently;
- audit the private runtime artifact schema without leaking it;
- identify the production-account binding mechanism;
- treat older dashboard plans and v3–v10 material as archive.

While implementing:

- introduce a single typed, sanitized server read model;
- preserve the trading engine and paper-only gates;
- make missing data explicit;
- add tests before relying on a new status or metric;
- avoid frontend copies of trading logic;
- preserve account isolation and credentials secrecy.

Before deployment:

- run every relevant dashboard and Python gate;
- inspect the diff for any strategy-identity source change;
- never change `PRODUCTION_RELEASE_SHA` merely to deploy the UI;
- never trigger a mutating paper cycle as a smoke test;
- deploy the web build and verify its exact build SHA, auth, headers, data
  sources, error states and responsive layout in production.

The desired outcome is not a dashboard that merely looks modern. It is a
dashboard whose every number can answer: **which account, which source, which
release, which completed session, how fresh, and does this represent actual
broker state, strategy intent, operational health or historical evidence?**
