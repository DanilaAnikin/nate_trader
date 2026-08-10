# Nate Trader — current system, V11 strategy, production and dashboard

> Snapshot: 2026-08-10 (Europe/Prague)
>
> Newest dashboard tag: `v11-dashboard-prod-2026-08-10b` →
> `fc73acaae0b576318544d8afe87f5432906da261`, the code state this document
> describes. `main` may carry later documentation-only commits.
> The preceding tag `v11-dashboard-prod-2026-08-10` → `5e34ca7f1`.
>
> **Neither is deployed.** See section 13 for what deployment requires.
>
> Approved trading release (unchanged): `0cb02c0765ebf91e60e5efd7f51334e9b538fbcb`
>
> Audience: maintainers and coding agents operating this repository
>
> Scope: what the system does today. Not an aspirational design, not a plan,
> and not investment advice.

---

## 1. What this repository is

Nate Trader is a research system and a guarded **Alpaca paper-trading**
executor for one strategy, `v11-adaptive-momentum`, plus a **read-only**
Next.js dashboard that observes it.

Three planes, deliberately separated:

- **Research / release** — the canonical validator produces
  `state/backtest/v11_validation.json`; the `V11 Release Gate` workflow proves a
  commit is green; a human then approves one exact SHA for trading.
- **Execution** — one scheduled GitHub Actions workflow checks out that exact
  approved SHA, runs preflight, and calls the guarded executor against an
  Alpaca **paper** account. Runtime state lives in a private Actions artifact,
  never in git.
- **Observability** — the dashboard reads the broker, Supabase, the repository
  at an explicit ref, GitHub Actions metadata and (server-side only) the
  private runtime artifact, and renders each with its own provenance.

The dashboard cannot place, cancel or modify an order. It has no code path that
mutates strategy state, and it never becomes a trading control plane.

## 2. Non-negotiable claims

- V11 is in **paper forward validation**, not production-proven live trading.
- The supported executor is hard-wired to Alpaca paper (`paper=True`).
- A validation `PASS` permits new paper exposure only while every identity and
  freshness gate still matches. It expires.
- Historical results carry current-universe selection/survivorship bias.
- The 2025–2026 interval was seen during development. It is a **reused temporal
  check**, not a fresh holdout.
- Jensen alpha is a SPY/BIL CAPM statistic, not a promise of economic profit.
- Account equity before the V11 cutover contains legacy V10/TQQQ/UPRO history
  and is never labelled "V11 performance". Without a persisted V11 epoch
  baseline, forward performance is `UNAVAILABLE`.

The correct user-facing phrase is "historical diagnostic" or "paper
forward-validation result" — never "guaranteed alpha" or "production proven".

## 3. Three SHAs, three meanings

These are independent and must never be conflated. The UI shows all three
separately, and each has its own failure mode.

| Layer | Where it comes from | What it means |
|---|---|---|
| **Web build SHA** | `BUILD_SHA` baked into the dashboard image; reported by `GET /api/health` and `payload.web.dashboardBuildSha` | Which commit the running web application was built from. Changing it deploys UI only. |
| **Approved trading release SHA** | `PRODUCTION_RELEASE_SHA` in the `paper-production` GitHub environment (or, for a deployment whose token cannot read environment variables, the dashboard's own `PRODUCTION_RELEASE_SHA`) | The exact commit the paper workflow checks out and trades. **Only a human changes this.** |
| **Runtime artifact SHA** | The suffix of the private artifact `paper-runtime-state-<sha>` that produced the state on screen | Which release actually wrote the runtime state being displayed. |

Rules the read model enforces:

- The trigger SHA of a workflow run is **not** the trading release. A scheduled
  run is triggered from the newest `main` while checking out the older approved
  SHA.
- If the approved SHA cannot be read from an authoritative source, it may be
  *derived* from the runtime artifact name — but that value is flagged
  non-authoritative and can never satisfy the effective validation gate.
- If the runtime artifact is not named for the approved release, nothing from
  it is shown. An older artifact is never silently substituted.
- `dashboardMatchesApprovedRelease` is reported as a fact, not a warning: the
  web build and the trading release are *expected* to differ.

## 4. Architecture

```text
                          RESEARCH / RELEASE PLANE

  strategy code + adjusted bars + frozen ranking universe
                         |
                         v
  canonical V11 validator ------> state/backtest/v11_validation.json
                         |
                         v
  V11 Release Gate for an exact commit SHA  (3 jobs, section 11.1)
                         |
                         v
  human approval: paper-production PRODUCTION_RELEASE_SHA


                         EXECUTION PLANE

  weekday/manual GitHub Actions paper workflow
                         |
        check out exactly PRODUCTION_RELEASE_SHA
                         |
        require a green release gate for that exact SHA
                         |
        restore the private paper-runtime-state-<sha> artifact
                         |
        offline sanity + paper broker/deployment preflight
                         |
        scripts/production_run.py -> Alpaca PAPER account only
                         |
        save performance.json / positions.json /
        production/last_run.json back to the private artifact


                         OBSERVABILITY PLANE

  Browser -> Next.js dashboard (server) -> Supabase Auth / RLS / Vault
                                       |-> selected Alpaca account (read-only)
                                       |-> Supabase equity + cash-flow mirror
                                       |-> repository evidence at an explicit ref
                                       |-> GitHub Actions run and gate metadata
                                       |-> private V11 runtime artifact
                                           (server-only, lineage-validated,
                                            returned as a sanitized DTO)
```

## 5. Source-of-truth hierarchy

When sources disagree, use this order — and show the source explicitly in the
UI rather than picking a convenient value.

| Concern | Authoritative source | Notes |
|---|---|---|
| Current account, positions, orders and clock | A fresh Alpaca response for the explicitly bound account | The broker is authoritative for what is actually held and filled. |
| The decision one production cycle made | The captured preflight/result for that cycle | Includes time, approved release and account binding. |
| In-flight target and order intent | The schema-v3 `adaptive_rebalance_pending` plan in the private runtime artifact | Intent is not a fill. It must match strategy and universe identity. |
| Active strategy rules | Effective `_V11_POLICY` in `scripts/strategy_config.py`, plus `scripts/adaptive_momentum.py` and `scripts/risk_policy.py` | Never infer active policy from archived v3–v10 tables. |
| Execution behaviour | `scripts/execute_trades.py`, `scripts/trade.py`, `scripts/production_run.py` | The adaptive V11 dispatch disables the legacy trading stack. |
| Production approval | `paper-production` environment `PRODUCTION_RELEASE_SHA` plus a successful exact-SHA release gate | `main`, and a run's trigger SHA, are not the traded SHA. |
| Promotion evidence | `state/backtest/v11_validation.json`, recomputed and identity/freshness checked | `PASS` is paper-only and expires. |
| Cross-strategy research | The epoch-specific tournament spec, result Markdown and JSON artifact | Never merge tournament metrics with canonical-validator metrics. |
| Dashboard policy labels | `dashboard/lib/v11-policy.json` | A tested display mirror, not a trading source of truth. |
| v3–v10 documents and modules | Archive and audit reference only | Not current policy. |

Committed `state/performance.json`, `state/positions.json`,
`state/research*.json`, `state/screener.json` and `state/spy_history.json` are
legacy seed snapshots. The active dashboard does **not** read them: every
runtime number comes from the private artifact for the approved release, the
broker, or the account-scoped Supabase mirror. Earlier versions of this
document described a UI that fell back to those committed files; that fallback
was removed and must not return.

## 6. V11 Adaptive Momentum in detail

### 6.1 Instrument universe

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

### 6.2 Information clock

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

### 6.3 Ranking signal

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

### 6.4 Eligibility filters

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

### 6.5 Target construction

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
price move, or transitional legacy exposure. The portfolio screen describes the
delta and its lifecycle rather than calling every drift a strategy failure.

### 6.6 Breadth scaler

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

### 6.7 SPY market gate and recovery

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
gate and is not read by the dashboard. The UI shows `SPY RISK-ON` or
`SPY RISK-OFF` and the recovery-latch state; the numeric SPY close, its SMA200
and the breadth census are not persisted by the runner and are therefore
`UNAVAILABLE` (section 10.6).

### 6.8 Portfolio damage tiers

Risk classification uses current equity, the previous broker equity and the
highest observation inside a rolling 22-session window:

| Tier | Trigger | Behavior |
|---|---|---|
| `NORMAL` | No higher tier active | Up to 90% base gross before breadth scaling. |
| `CAUTIOUS` | Rolling drawdown <= -10% or daily return <= -5% | The next risk-on target is half-sized, normally up to 45% gross before breadth scaling. It does not force a daily mid-month resize. |
| `HALT` | Daily return <= -8% | Immediate zero directional target and risk-reducing exits on every cycle. |

The SPY gate and risk tier combine. A `CAUTIOUS` account can still take reduced
risk when SPY is above SMA200; SPY risk-off or `HALT` produces a zero target.

### 6.9 What V11 explicitly disables

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

## 7. Data completeness and fail-closed behaviour

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

## 8. Live order lifecycle and safety

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

## 9. Canonical validation and research evidence

### 9.1 Canonical validation result

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

### 9.2 Stored headline metrics

| Cost per fill | Segment | V11 CAGR | SPY CAGR | Excess CAGR | Jensen alpha | Sharpe | Max drawdown |
|---:|---|---:|---:|---:|---:|---:|---:|
| 7 bps | Development | 17.1022% | 8.8198% | +8.2824 pp | +10.5896% | 1.0226 | -18.6554% |
| 7 bps | Reused temporal | 19.9535% | 18.7328% | +1.2208 pp | +8.0530% | 0.7789 | -17.2217% |
| 15 bps | Development | 15.8933% | 8.8198% | +7.0735 pp | +9.5498% | 0.9385 | -19.7053% |
| 15 bps | Reused temporal | 19.0004% | 18.7328% | +0.2677 pp | +7.2580% | 0.7403 | -17.3795% |

The 15 bps reused raw excess is only +0.2677 percentage points. The positive
Jensen alpha partly reflects lower SPY beta. These facts must be visible
instead of collapsing the result into a single green “alpha” number.

### 9.3 Limitations that must accompany the metrics

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

### 9.4 Strategy tournament epoch 1

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

## 10. Dashboard: the status architecture

### 10.1 One server-side read model

Everything the strategy screens display comes from a single endpoint,
`GET /api/accounts/[id]/status`, assembled by `dashboard/lib/status/`. The
browser never talks to GitHub, never sees an artifact, and never receives a
credential, a Vault UUID, a broker order id or a full broker account number.

The payload (`StrategyStatusPayload`, schema-versioned) carries these sections,
each an independently-provenanced `Section<T>`:

| Section | Source |
|---|---|
| `web` | The dashboard's own build and data mode |
| `release` | GitHub environment variable + release-gate runs |
| `authorization` | The five-point production check (section 10.3) |
| `accountBinding` | The role this account plays, derived from that check |
| `broker` | A fresh read-only Alpaca `/v2/account` + positions snapshot |
| `strategy` | Frozen plan, risk tier and targets from the private artifact |
| `universe` | Preflight report + frozen plan |
| `validation` | `state/backtest/v11_validation.json` at the approved ref |
| `preflight` | `production-preflight.json` from `paper-diagnostics` |
| `execution` | `production/last_run.json` from the runtime artifact |
| `operations` | Workflow run and job metadata |
| `tournament` | Frozen epoch-1 research evidence |
| `convergence` | Frozen plan vs the fresh broker snapshot |
| `validationGate` | The one derived "may V11 buy right now" verdict |

Every section states its `source`, `scope`, absolute `asOf`, relative age and
freshness. There is no global "online" dot: `web`, `broker`, `runtime`,
`scheduler` and `validation` are five separate indicators with five separate
contracts.

### 10.2 State vocabulary

| State | Meaning |
|---|---|
| `CURRENT` | Read successfully and inside its freshness contract |
| `STALE` | Genuine, but older than its contract allows |
| `EXPIRED` | So old it must not inform a decision |
| `MISMATCH` | Two documents that must agree do not |
| `UNAVAILABLE` | Could not be read, or the evidence needed was never there |
| `NOT_APPLICABLE` | Meaningless for this viewer or account |
| `PENDING` / `PASS` / `WARN` / `FAIL` | Check outcomes |

A number is never shown without one of these. Missing data never becomes zero,
and never becomes a green check.

### 10.3 The five-point production binding

The frozen plan, pending order intents, preflight, executor results and
workflow operations all describe **one** central production account. Owning
some Supabase account is not enough to see them. All five conditions must hold
together — AND, never OR:

1. `PRODUCTION_OWNER_USER_ID` equals the signed-in Supabase user;
2. `PRODUCTION_ACCOUNT_ID` equals the selected account;
3. the account is in **paper** mode;
4. the account is owned by that owner (service-role read of `owner_id`,
   verified in code); and
5. `PRODUCTION_ALPACA_ACCOUNT_NUMBER` equals the account number read **fresh
   from Alpaca `/v2/account`** during this request.

Point 5 is mandatory and is the only broker-side proof. A number stored in
Supabase is never accepted, because the first four conditions establish only
*who is asking about which row* — they cannot show that the row's Vault
credentials point at the account the executor actually trades. An unreadable
broker fails the check closed.

Without all five, the account is observer-only: V11 compliance is
`NOT_APPLICABLE`, the private runtime is withheld, and **no GitHub Actions call
is made for that viewer at all**.

### 10.4 One shared lineage verdict

`dashboard/lib/status/lineage.ts` cross-checks the approved release, strategy
identity, strategy version and ranking-universe hash across the preflight, the
frozen plan and the executor record — once, so no two sections can disagree
about whether production is coherent.

- **Absent evidence is not agreement.** A document that is *present* must carry
  every lineage field it owns, in the exact expected format: a SHA-256 must be
  64 lower-case hex characters, a commit id 40, a signal date a real
  `YYYY-MM-DD` calendar day. Null, empty, whitespace, truncated, uppercase or
  prefixed values all fail.
- Only the frozen plan persists `signal_date`; neither the run record nor the
  preflight does. It is therefore **not** compared between documents. It is
  required to exist, to be a valid calendar date, and to be no later than the
  cycle that wrote it.
- The preflight carries no strategy-version string, so the version evidence
  used is the one it does persist: its `frozen_v11_policy` and
  `strategy_identity` checks must both be present and passing.
- Any conflict — including a selector-level refusal such as a wrongly named
  artifact — withholds **all** of `strategy`, `universe`, `preflight`,
  `execution` and `convergence`, and the effective validation gate cannot be
  `PASS`. Two documents that contradict each other give `MISMATCH`; evidence
  that was never there gives `UNAVAILABLE`. Neither is ever `CURRENT`.

### 10.5 Reading the private artifacts

`dashboard/lib/status/runtime.ts` selects the executor result and the preflight
**independently**, because a manual `operation=preflight` run produces
diagnostics but no runtime state and must not hide an older valid execution.
The scan walks successful runs newest-first across pages (100 per page, up to
10 pages) and stops at an explicit 45-day freshness boundary.

Before anything is parsed, the reader checks the artifact name, its advertised
size, and the exact expected entry list. The ZIP reader handles the streaming
layout GitHub actually produces — general-purpose bit `0x0008`, zeroed local
headers and signed `PK\x07\x08` data descriptors — and verifies each
descriptor against the central directory, along with CRC, duplicate entries and
header agreement.

### 10.6 Sections that are honestly `UNAVAILABLE`

These are not bugs and are not estimated. The backend does not persist the
fact, and recomputing it in the browser would create a second, unvalidated
strategy:

- **SPY close, SMA200 and the breadth census.** The runner records the
  resulting gate flag and eligible count, not the numeric SPY level, the
  breadth numerator/denominator or the breadth multiplier.
- **Per-filter eligibility and the 12-1 / 6-1 rank table.** The signals funnel
  therefore shows universe → eligible → selected, with each individual filter
  stage `UNAVAILABLE`.
- **Forward performance without a persisted epoch baseline.** The reader,
  schema, TWR maths and UI all exist, but until
  `state/v11_epoch_baseline.json` carries a release SHA, start time, starting
  equity and benchmark baseline, the panel stays `UNAVAILABLE`. It is never
  back-filled from pre-V11 account history.
- **Anything downstream of a lineage conflict** (section 10.4).

### 10.7 Forward performance accounting

`GET /api/accounts/[id]/performance` is fail-closed by construction. It returns
a named `UNAVAILABLE` reason rather than a number when any of these hold:

- the viewer is not the production viewer, or the approved release is unknown;
- no epoch baseline is persisted, or it is bound to a different release,
  strategy or account, or its recorded observations disagree with the data;
- the equity mirror or the cash-flow walk could not be refreshed or queried;
- the Alpaca activity walk could not be proven complete;
- **an external securities transfer (`ACATS`, `JNLS`, `FOPT`) settled after the
  baseline** — it moves positions with no cash leg, so no return or alpha is
  attributable (`NON_CASH_EXTERNAL_TRANSFER`);
- a session is dated after today's New York date beyond a five-minute
  clock-skew tolerance; or
- the two series do not genuinely share a window.

What it does when it *can* answer:

- Cash flows are mirrored from Alpaca activities with strict typing:
  `net_amount` is accepted only as a finite JSON number or a plain decimal
  string. Null, boolean, empty, whitespace, `NaN` and `Infinity` make the walk
  incomplete rather than silently reading as zero.
- The activity window starts ten days **before** the baseline, because Alpaca
  filters on the activity's own date, which a late settlement or correction can
  move. Rows are deduplicated by activity id and filtered on the real
  occurrence date, so the overlap can only add evidence.
- Both the equity curve and the cash-flow ledger are read **page by page**.
  Supabase caps a response at 1000 rows without an error, so an unpaged read
  would return a shorter — and wrong — history that still looks valid.
- The root `status` mirrors the provenance freshness exactly. A `STALE` or
  `EXPIRED` result is labelled as such at the top of the response *and* carries
  a banner in the UI. It is never presented as current.

### 10.8 Pages

| Route | Content |
|---|---|
| `/` | Overview: five system indicators, release lineage, plan summary |
| `/positions` | Portfolio: actual vs target, convergence, legacy holdings |
| `/screener` | Signals: universe → eligible → selected funnel |
| `/research` | Canonical validation and tournament evidence, with limitations |
| `/operations` | Workflow attempts, infrastructure vs strategy failures |
| `/accounts` | Account management, verification, key rotation |
| `/settings` | Profile and default account |
| `/login` | Supabase authentication |

`/operations` shows both "the latest attempt failed for infrastructure reasons"
and "the last successful executor snapshot is from *date*" — never one dot.

## 11. Workflows

There are exactly two supported workflows. The archived optimizer, research and
multi-account workflows must not be restored.

### 11.1 `V11 Release Gate` — `.github/workflows/v11-release.yml`

Non-trading. Runs on `main` pushes, pull requests and manual dispatch. Three
independent jobs:

| Job | What it proves |
|---|---|
| `dashboard-gate` | Node 22, `npm ci` from the lockfile, `npm audit --audit-level=high`, dashboard tests, ESLint, `tsc --noEmit`, production `next build` |
| `release-gate` | Python 3.12.11, `pip install --require-hashes -r requirements.lock`, `pip check`, the complete pytest suite, `compileall`, critical Ruff checks (E9,F63,F7,F82), and `scripts/sanity_check.py` |
| `supabase-schema-gate` | Applies **every** migration to a real `postgres:16-alpine` service and runs the SQL assertions against it — a database test, not a grep over SQL text |

A green gate makes a commit *approvable*. It does not place an order and it
does not deploy anything.

### 11.2 `V11 Paper Production` — `.github/workflows/paper-production.yml`

The only supported executor. It:

- requests a weekday run at 15:05 UTC (GitHub may start it later);
- serialises invocations with concurrency;
- checks out only the full SHA in `PRODUCTION_RELEASE_SHA`;
- requires a successful release gate for that **exact** SHA;
- installs Python 3.12.11 and `requirements.lock` with hashes;
- restores only a matching private runtime artifact, after schema and lineage
  validation;
- runs offline sanity and the paper broker/deployment preflight;
- optionally runs a read-only dry preview;
- calls `scripts/production_run.py` only for the schedule or an explicit
  `operation=execute`;
- keeps runtime state for 90 days and diagnostics for 30 days; and
- fails on blocking `ABORT`/`ERROR` records.

Mutable runtime state is deliberately **not** committed. The private artifact
`paper-runtime-state-<approved sha>` contains exactly three files:
`state/performance.json`, `state/positions.json` and
`state/production/last_run.json`.

The workflow uses repository Alpaca paper secrets. Supabase dashboard accounts
use a separate credential store; that is why the binding in section 10.3 must
be proven broker-side rather than assumed.

## 12. Database and security model

### 12.1 Migrations

| Migration | Purpose |
|---|---|
| `0001_enums.sql` | Shared enum types |
| `0002_profiles_accounts.sql` | `profiles`, `accounts`, base RLS |
| `0003_helpers.sql` | `owns_account()` and friends |
| `0004_account_state.sql` | `equity_snapshots`, `performance`, `positions`, `trades`, `cash_flows`, `routine_runs` |
| `0005_shared.sql` | Shared research/market tables and the audit log |
| `0006_storage_policies.sql` | Storage bucket policies |
| `0007_advisor_hardening.sql` | Pinned `search_path`, revoked `anon` execute |
| `0008_vault_wrappers.sql` | Vault credential wrappers |
| `0009_accounts_server_managed.sql` | Removed client **writes** to `accounts`; server-managed column guard |
| `0010_accounts_guard_authz_fix.sql` | Made that guard `SECURITY INVOKER` so a client role cannot be mistaken for its owner |
| `0011_revoke_client_reads.sql` | Removed client **reads** (below) |

0009 and 0010 are already applied in production and are never edited;
corrections go in a new migration.

### 12.2 What 0011 changed and why

0009/0010 stopped clients writing `accounts`, but a signed-in browser could
still `select *` the base table through Supabase REST and read
`alpaca_account_number`, both Vault secret UUIDs, `owner_id` and `deleted_at`.
The TypeScript `SafeAccount` allowlist never protected that path — PostgREST
answers the browser directly. The 0009 SELECT policy also did not exclude
soft-deleted rows.

After 0011:

- `accounts`, `trades` and `cash_flows` carry **no client privileges at all**,
  and their client SELECT policies are dropped, so a future stray `grant` still
  cannot re-open them;
- three sanitized, explicitly-columned views remain as defence in depth:
  `accounts_safe` (a four-character broker mask, never the number),
  `trades_safe` (no `alpaca_order_id`) and `cash_flows_safe` (no Alpaca
  activity `external_id`), all filtering `deleted_at is null`;
- `owns_account()` is restated with a pinned `search_path` and an explicit
  soft-delete exclusion, so every account-scoped table inherits it; and
- soft-deleting an account also clears `alpaca_account_number`, so a deleted
  row stops carrying the identifier the production binding compares against.

Every account read in the application now goes through
`dashboard/lib/accounts/session.ts`, which reads with the service role and
verifies the session and ownership **explicitly in code**, at each call site,
rather than relying on a policy that a single edit could widen everywhere.

`supabase/tests/client_read_exposure.test.sql` proves this against a real
PostgreSQL server: under `set local role authenticated`, with the same
privileges Supabase REST uses, it asserts that the base tables raise
`insufficient_privilege`, that each sensitive column is individually
unreadable, that a soft-deleted and a foreign account are invisible, and that
the views expose only their allowlisted columns. A DTO test cannot prove any of
that.

Reviewed and left with their owner-scoped policies: `equity_snapshots`,
`performance`, `positions` and `routine_runs` hold prices, quantities,
timestamps and a public GitHub run URL — no broker identifier and no credential
reference. Accepted and documented: `routine_runs` rows with
`account_id is null` are account-agnostic and readable by any signed-in user.

### 12.3 Application security invariants

- The application stays behind Supabase authentication; RLS account isolation
  and exact account scoping are preserved.
- Service-role keys, GitHub tokens and Alpaca credentials are server-only.
- No response contains a Vault UUID, a secret, a full broker account number, a
  broker order id or a raw artifact.
- Financial and account responses are `no-store`.
- Account switching cancels in-flight requests and re-checks account, mode and
  schema; a failed account-scoped request never falls back to public repo state.
- HSTS, clickjacking, MIME-sniffing and CSP headers are set.
- Deploying the UI never modifies `PRODUCTION_RELEASE_SHA`, triggers an execute
  workflow, or places a broker order.
- If a strategy-identity source changes, paper buys stop until a new canonical
  validation and release promotion complete.

## 13. Deployment

### 13.1 What "deployed" means here

The dashboard is a container built from `dashboard/Dockerfile` and served at
`https://nate-trader.anikin.cz`. **Building an image is not a deployment.** A
deployment has happened only when the origin host runs the new image and
`GET /api/health` reports the expected new build SHA.

### 13.2 Prerequisites — all of them, in order

1. Access to the origin host that actually serves the site.
2. Inspect the Supabase migration ledger and confirm which migrations are
   already applied.
3. Apply every pending migration **in order**. `0011` is required by this
   build: the routes read `accounts` with the service role and the sanitized
   views must exist.
4. Confirm Supabase signup is disabled.
5. Set `BUILD_SHA` to the commit being deployed, and confirm the five
   production-binding variables (section 10.3) are present.
6. Run a side-by-side authenticated smoke test against the new build before
   cutting traffic over: login, account switch, every strategy section, the
   `UNAVAILABLE` states, and `/api/health`.
7. Verify the rollback path works (section 13.3) before you need it.

Do not change `PRODUCTION_RELEASE_SHA` in order to deploy the UI. Do not run a
mutating paper cycle as a smoke test.

### 13.3 Rollback

The last known-good deployed dashboard is
`d11bbad8aad7ec98596b0d290cb938706982d069`
(`v11-dashboard-prod-2026-08-03`). Rolling the web image back to that commit
restores the previous UI without touching the trading release.

Note the ordering constraint: `0011` revokes client table reads that the
`d11bbad8a` build did not depend on either — that build already read accounts
through server routes — but it also drops the `update own account metadata`
grant. Verify account metadata editing in the smoke test after a rollback.

### 13.4 Release commands

```bash
cd dashboard
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
npm audit --audit-level=high
npx playwright test

cd ..
PYTHONPATH=scripts python3 -m pytest -q
python3 -m compileall -q scripts tests
python3 scripts/sanity_check.py
git diff --check

DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  supabase/tests/run_integration.sh
```

Use the pinned Python 3.12.11 environment for promotion checks. A local
interpreter mismatch is a dev-environment failure, not evidence that the
promoted release failed.

## 14. Return and benchmark correctness

Any performance comparison must satisfy all of these:

- the same bound account;
- an explicit V11 epoch start and release identity;
- the same start and end sessions for portfolio and benchmark;
- no forward-filling the benchmark beyond its last actual common session;
- cash-flow-adjusted TWR, or a clearly labelled unadjusted equity series;
- an exact source and time zone (America/New_York session dates);
- no reuse of V10 account history as a V11 result; and
- `UNAVAILABLE` when dates, cash flows or benchmark coverage cannot be aligned.

Historical backtest alpha and live paper account performance are different
products. They are never spliced into one continuous chart.

## 15. Known open gaps

Rendered as `UNAVAILABLE` rather than estimated, and not solvable by UI work:

- **No persisted V11 forward-validation epoch baseline.** Everything downstream
  exists; the baseline does not. See section 10.6.
- **SPY level, breadth census and per-filter eligibility are not persisted** by
  the runner. See section 10.6.
- **`paper-diagnostics` is not SHA-scoped.** The dashboard binds it to a
  specific successful run and cross-checks the strategy identity instead.
- **Branch and environment protection** hardening is a repository-administration
  task, separate from application code.
- **Stronger historical claims need point-in-time universe membership and
  delisting data**, plus a genuinely fresh forward period. The required next
  evidence is frozen-rule forward paper performance across several monthly
  rebalances.
- **`state/universe.json` is absent**, so validation resolves the maintained
  `watchlist.json` fallback. This has not been validated as the broad dynamic
  common-stock/ADR universe.

The correct answer to a missing backend fact is a small, sanitized, well-tested
observability contract — never frontend inference.

## 16. Repository map

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Agent operating and safety manual |
| `strategy/v11_adaptive_momentum.md` | Authoritative V11 specification |
| `strategy/PRODUCTION_RUNBOOK.md` | Paper release, monitoring and rollback runbook |
| `strategy/strategy_tournament_epoch_1.md` | Frozen tournament protocol |
| `scripts/strategy_config.py` | Effective `_V11_POLICY` overlay plus archived parameters |
| `scripts/adaptive_momentum.py` | Broker-independent signal and target planner |
| `scripts/universe.py` | Universe discovery, cache and fallback |
| `scripts/risk_policy.py` | Shared rolling portfolio risk classifier |
| `scripts/execute_trades.py` | Guarded target convergence |
| `scripts/trade.py` | Alpaca paper order validation and lifecycle |
| `scripts/production_preflight.py` | Exact-release and broker safety preflight |
| `scripts/production_run.py` | One guarded production paper cycle |
| `scripts/strategy_identity.py` | Strategy and universe identity hashes |
| `scripts/backtest/validate_v11.py` | Canonical fixed-policy validator |
| `state/backtest/v11_validation.json` | Bound canonical validation evidence |
| `.github/workflows/v11-release.yml` | Non-trading release gate (3 jobs) |
| `.github/workflows/paper-production.yml` | The only supported paper executor |
| `dashboard/lib/status/` | The unified server-side V11 read model |
| `dashboard/lib/status/lineage.ts` | The one shared, fail-closed lineage verdict |
| `dashboard/lib/status/authz.ts` | The five-point production authorization |
| `dashboard/lib/status/runtime.ts` | Lineage-validated private-artifact reader |
| `dashboard/lib/status/validation-gate.ts` | The one effective paper-buy gate |
| `dashboard/lib/accounts/session.ts` | The only way a route obtains an account row |
| `dashboard/lib/accounts/paged.ts` | Proven-complete Supabase paging |
| `supabase/migrations/` | The applied schema, in order |
| `supabase/tests/` | Real-PostgreSQL RLS and read-exposure assertions |

## 17. Historical note

Two older documents, `DASHBOARD_SPECIFICATION.md` and
`DASHBOARD_IMPLEMENTATION_PLAN.md`, describe an earlier ambition in which an
agent trades every Supabase paper and live account. That conflicts directly
with the current guarded, single approved paper-only executor. They are
historical planning material. Their authentication, RLS and data-model ideas
may be reused; their trading-control assumptions must not be revived.

V10's apparent performance was never a valid baseline: the portfolio was
concentrated in TQQQ/UPRO, the simulator used same-session close information
for same-session-open trades, the live picker did not fetch enough sessions for
its lookback, and an infrastructure symbol was not consistently marked to
market. v3–v10 code and documents are audit references only. Their behaviour
and historical dependencies are not guaranteed to remain reproducible.
