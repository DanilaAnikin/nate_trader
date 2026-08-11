# Nate Trader — current system, V11 strategy, production and dashboard

> Snapshot: 2026-08-11 (Europe/Prague)
>
> This document describes the commit tagged
> **`v11-dashboard-prod-2026-08-11d`** — the tag and the documentation are
> published together, so `git show v11-dashboard-prod-2026-08-11d:OVERVIEW.md`
> is always the description of that exact code. The audit fix itself is
> `38493eb89`.
>
> Tags are **annotated, not signed**: no signing key is configured for this
> repository. Do not describe one as verified (section 16).
>
> Preceding tags: `v11-dashboard-prod-2026-08-11c` → `f8a170ca2`,
> `v11-dashboard-prod-2026-08-11b` → `57c40d23d`,
> `v11-dashboard-prod-2026-08-11` → `7f1b9d647`,
> `v11-dashboard-prod-2026-08-10d` → `17d0da20a`,
> `v11-dashboard-prod-2026-08-10c` → `ab7145b48`,
> `v11-dashboard-prod-2026-08-10b` → `fc73acaae` (**the bridge**, section 13.2),
> `v11-dashboard-prod-2026-08-10` → `5e34ca7f1`,
> `v11-dashboard-prod-2026-08-03` → `d11bbad8a` (**currently in production**).
>
> **Production currently runs `d11bbad8a`** (`v11-dashboard-prod-2026-08-03`).
> None of the later tags has been deployed.
>
> Which migrations the production database has applied is **not known to this
> document**. `d11bbad8a` reads `accounts` as `authenticated`, which `0011`
> revokes, so a working production implies `0011` is *not* applied — but that
> is an inference, not a reading of the ledger. Read the ledger before doing
> anything (section 13.3, step 1).
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
  V11 Release Gate for an exact commit SHA  (4 jobs, section 11.1)
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

Everything the strategy screens display comes from `GET /api/accounts/[id]/status`,
assembled by `dashboard/lib/status/`. The browser never talks to GitHub, never
sees an artifact, and never receives a credential, a Vault UUID, a broker order
id or a full broker account number.

Forward performance is **not** part of that payload. It is a separate request
to `GET /api/accounts/[id]/performance`, refreshed by the same shared status
provider in the same cycle — so one Refresh renews both — but it keeps its own
response, its own reason codes and its own freshness contract, because it ages
with the market rather than with the runtime artifact. Section 10.7 covers it.

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
| `validationGate` | The one derived "may V11 buy right now" verdict (section 10.8) |

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
- A present run record must carry a valid `completed_at`. Missing, unparseable
  or more than five minutes in the future is a conflict — it is the anchor for
  the execution section's freshness and the only thing the plan's signal date
  can be checked against.
- The **canonical validation report** is the authority for strategy identity
  and ranking universe, and it is compared against even when no frozen plan
  exists. Between monthly rebalances there is no plan, which used to leave the
  preflight's identity unchecked entirely — the ordinary state, not an edge
  case. The report is read before the preflight is selected, so it is also what
  the selector compares against.
- The preflight's `ranking_universe` check must be **present and passing** in
  its own right. Its hash is scraped out of the check's detail text, which
  stays syntactically valid when the check *fails* — precisely the case where
  the running universe does not match the validated one — so comparing hashes
  alone would agree and hide it.
- Any conflict — including a selector-level refusal such as a wrongly named
  artifact — withholds **all** of `strategy`, `universe`, `preflight`,
  `execution` and `convergence`, and the effective validation gate cannot be
  `PASS`. Two documents that contradict each other give `MISMATCH`; evidence
  that was never there gives `UNAVAILABLE`. Neither is ever `CURRENT`.

Freshness follows the same rule everywhere: `classifyAge` treats a timestamp
more than five minutes ahead of this server as `MISMATCH` rather than letting a
negative age fall through to `CURRENT`, and every non-`CURRENT` provenance
carries an explanatory `detail`. The validation report must also carry a
`generated_at` that is present and not in the future — without one its whole
35-day freshness calculation rests on nothing, so the section is `UNAVAILABLE`
rather than `CURRENT`.

**Timestamps from the runner are New York time.** `scripts/utils.py` writes
`performance.json`, `positions.json` and the frozen plan with
`datetime.now(ZoneInfo("America/New_York"))` and **no offset**. The dashboard
read those as UTC, which was wrong by four or five hours depending on the
season — enough to move a value across a session boundary and change which day
it belongs to. `normalizeInstant` now interprets a naive
`YYYY-MM-DD HH:MM:SS` in that zone, and returns null for the two wall times
that denote no single instant: the hour skipped at the spring transition, and
the hour repeated at the autumn one. Those surface as `UNAVAILABLE` rather than
as an instant that may be an hour wrong. `scripts/utils.py` itself is a
strategy-identity source and was not touched.

### 10.5 Reading the private artifacts

`dashboard/lib/status/runtime.ts` selects the executor result and the preflight
**independently**, and by different rules:

* the **executor result** comes from the newest run that actually *succeeded* —
  a failed run produced no trustworthy runtime state;
* the **preflight** comes from the newest **completed** run that carries a
  diagnostics artifact, whatever that run concluded.

The second is the important one. The preflight runs before the executor and
writes its report whatever happens next — indeed a run usually fails *because*
the preflight refused. Filtering it on `conclusion === "success"` therefore
skipped exactly the reports that matter and fell back to an older green one, so
the screen could show a passing preflight while production had just refused to
trade. A newer completed run with no diagnostics is **not** self-explanatory, and this
is where the rule is strictest. The step may have run and the upload failed, in
which case the newest report exists and is merely unreachable — showing an
older green one instead would be the exact substitution this module refuses. So
the selector asks GitHub what the run actually did: it reads the job's steps
and looks for `Verify paper broker and deployment health`.

  * the step reached a conclusion → a report was written, so its absence is a
    failure: `UNAVAILABLE`, and the walk stops;
  * the step was skipped, cancelled, or is absent from a job whose steps are
    listed → the run provably ended before it, so it supersedes nothing and the
    walk continues;
  * the jobs could not be listed, the run reports no jobs, or a job's step
    list is empty → not knowing is not knowing it did not run: `UNAVAILABLE`,
    and the walk stops. (Both empty shapes are real: paper-production run
    `31121554054` was cancelled and its single job carried no steps.)

An **expired** diagnostics artifact is treated the same way — it is a reason to
report `UNAVAILABLE`, never a reason to reach past it. So is one created
outside its own run's time window, which is not that run's output whatever the
API attached it to. A newest report that is corrupt, schema-invalid or
lineage-mismatched fails closed for the same reason.

Both scans walk newest-first across pages (100 per page, up to 10 pages) and
stop at an explicit 45-day freshness boundary.

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
  incomplete rather than silently reading as zero. A `CSD` booked negative or a
  `CSW` booked positive contradicts its own direction and is refused.
- The walk reads the account's **entire** activity history rather than a
  window. Alpaca's `after` filter applies to the activity record, not to the
  settlement date the ledger books against, and a correction can re-date or
  withdraw a record afterwards — so any finite lookback has an edge a late or
  amended activity can cross unseen. The baseline is applied afterwards, to
  each activity's real occurrence date. Exceeding the page budget is
  `UNAVAILABLE`, never a partial ledger.
- The mirror is **reconciled**, not just upserted. An activity Alpaca no longer
  reports — a reversal, a correction re-issued under a new id — has its
  mirrored row deleted; an amended activity keeps its id and is overwritten.
  Without this, a withdrawn deposit would keep subtracting from the return
  forever.
- A **real** activity timestamp is held to the clock: more than five minutes
  ahead of this server is a broken feed, not a scheduled transfer. A date-only
  activity has no time of day, so it is held to the calendar instead — it may
  not be dated after today's New York session — and its fabricated midday
  instant is never reported as an observation, because a caller would
  clock-check it and reject a perfectly ordinary same-day entry. A date the
  calendar does not contain (`2026-02-30` parses in JavaScript and silently
  becomes 2 March) is refused either way.
- The portfolio-history payload is validated as the column-oriented structure
  it is: an empty payload, mismatched column lengths or a non-numeric timestamp
  are errors, because positional arrays of different lengths pair one day's
  timestamp with another day's equity.
- Both the equity curve and the cash-flow ledger come from **one database
  snapshot**, via the `account_history_snapshot` RPC. A client-side page walk —
  even a careful one with a keyset cursor, an exact count and duplicate
  detection — cannot deliver this, because several HTTP requests are several
  MVCC snapshots. The change no client-side check can see is an **UPDATE to a
  row already read**: the count is unchanged, no key repeats, nothing is
  skipped, and the walk returns a value that no longer exists while reporting
  success.

  The RPC is `STABLE`, so every query in its body observes the snapshot of the
  calling statement. What that buys is **internal consistency**: the two
  datasets it returns describe one state of the database, and its own counts
  always match its payload. It does **not** detect or fail on a concurrent
  write — a writer committing during the call simply is not visible to it, and
  the next call sees the new state. There is nothing to retry and nothing to
  report; the guarantee is that no single answer is ever a mixture. Past an
  explicit 20 000-row ceiling it refuses rather than materialising an unbounded
  history. The real-PostgREST gate demonstrates the tear a page walk produces
  against a live server, and that this call does not.
- **A refresh never deletes.** A stored day or activity the incoming payload
  does not mention aborts the whole publish with `RECONCILIATION_CONFLICT` and
  leaves the mirror untouched, because a partial response and a genuine
  withdrawal are the same input (section 12.7). Withdrawing a row is a
  separate, audited, one-row command.
- **Refreshing is a command, not a side effect.** `GET /equity` and
  `GET /performance` used to republish both mirrors on every call, so a page
  that polled wrote four tables per poll and two open tabs raced each other.
  `POST /api/accounts/[id]/refresh` is the only path that writes them; the
  reads serve what is stored and say when it was published.
- The mirrors are reconciled **in the database** too, and both in the same
  call. Computing the set difference in the application needed an unpaged
  `select` of the mirrored ledger — truncated silently past the server's row
  cap, and reconciling against a truncated list is worse than not reconciling.
  `publish_broker_refresh` upserts and deletes both datasets in one
  transaction, so a withdrawn activity and a retracted Alpaca equity day
  disappear instead of outliving the authoritative history, and the two
  mirrors can never be published from different moments.
- The refresh carries a **reservation**, taken before the broker is read and
  recording the account, owner, mode, broker account number and credential
  version it is about to read *with*. Publishing re-checks all five and
  refuses any generation that is not newer than the one already published, so
  two overlapping refreshes cannot land out of order and a rotation landing
  mid-fetch cannot have its data published under the new binding.
- Nothing is written unless **both** datasets validated completely. A
  portfolio-history payload with a null, non-finite or non-positive equity, or
  an unreadable date, fails the whole refresh before the first mutation — the
  earlier version skipped bad days, which turned a corrupt payload into a
  shorter one. Two rows for one ET session, a repeated timestamp, or an
  unusable `profit_loss` entry reject the payload as well: a `Map` keyed by
  date used to resolve duplicates last-wins, which is a guess about which
  day's equity is real.
- **The activity walk ends on an explicit empty page, never a short one.**
  `page_size` is a maximum: a broker under load or a page boundary that falls
  short both produce fewer rows than requested while more data remains, and
  ending there is indistinguishable downstream from a complete ledger. The
  walk also proves it is progressing — the cursor must advance and each page
  must show something new — so a looping feed reports `PAGINATION_STALLED`
  rather than exhausting the page budget.
- **No allowlist of activity types.** A closed list cannot return a type it was
  never told to ask for, so the walk requests the whole non-trade feed and
  classifies every row as external cash, a non-cash transfer, or an internal
  P/L event. A type this build does not recognise is `UNAVAILABLE`: unknown is
  not the same as irrelevant.
- A cash movement dated **on the baseline session** is refused. The recorded
  starting equity may be the value before it or after it and nothing says
  which, so the safe contract is a flow-free baseline session; otherwise the
  epoch must be re-anchored.
- A cash movement **inside the measured window** is also refused, and this is
  the strictest rule here. Daily equity is the only valuation available, so
  `(E_t − flow) / E_{t−1}` books every movement at the close; a morning deposit
  would need `E_{t−1} + flow` instead, and the difference is real money.
  Without a valuation at the moment of the flow, an end-of-day approximation
  must not be published as exact time-weighted return. With no flow in the
  window, chaining daily returns *is* exact TWR, and the number is reported.
- The root `status` mirrors the provenance freshness exactly. A `STALE` or
  `EXPIRED` result is labelled as such at the top of the response *and* carries
  a banner in the UI. It is never presented as current.

### 10.8 The effective validation gate defers to Python

`scripts/execute_trades.py::_v11_validation_gate` is the real gate. It
recomputes things the dashboard structurally cannot: the whole-report SHA-256
over a canonical serialization, the adjusted-bar prefix digest for the recorded
boundary, the canonical period payload resolved from local history, and the
current ranking-universe hash. Re-deriving any of that in TypeScript would
produce a *second, weaker* gate that could show `PASS` while the executor
refuses to buy.

So the split is explicit. Effective `PASS` requires **all** of:

1. an **authoritative** approved release SHA (a value derived from an artifact
   name never counts);
2. the shared lineage verdict OK;
3. the canonical report's stored assessment `PASS`;
4. `allowed_mode === "paper-validation-eligible"` — a shadow-only run (custom
   dates, capital or cost set) is `PASS` too, and must not light this green;
5. a well-formed contract block (`schema_version` 1, `sha256`, a 64-hex
   report digest) and every mandatory evidence hash present and well-formed:
   strategy identity, ranking universe, adjusted-bar prefix;
6. non-zero evaluated checks, all of them passed;
7. current identity and universe bindings against the running runtime, and the
   report inside its 35-day freshness deadline; and
8. the preflight itself internally consistent — `status: PASS`, a non-zero
   check count that matches the checks actually recorded, `checksPassed`
   equal to the number that actually passed and to `checksEvaluated`, no
   repeated check name, each mandatory check present exactly once, and a
   `checked_at` that is valid, not more than five minutes ahead of this server,
   and inside the 36-hour freshness contract; and
9. the preflight's own **`canonical_validation_gate` check present exactly
   once, passing, and from the same runtime cycle** as the state on screen —
   the same workflow run id *and* the same attempt, since a re-run keeps the id
   and its preflight describes a different execution.

Condition 8 exists because a summary line is not evidence. `status: PASS` with
17 of 18 checks passing, a count that does not match the recorded checks, or
two contradictory `canonical_validation_gate` entries all describe a report
that cannot be reduced to one answer — so none of them produces one. The
preflight's own `allowed_mode` must also be `paper`: it is the runner's verdict
on whether this cycle may execute, and the status alone is not a substitute.

The parser is the first line of that. It refuses any document it cannot fully
read, because every leniency it used to have was a way for a broken report to
look healthy: a non-array `checks` left the list empty and the report still
parsed; `.slice(0, 64)` truncated silently, so a failing check past the cut
disappeared; a check with no name or a non-boolean `passed` was skipped with
`continue`, so the parsed report described fewer checks than the file; and
`checks_passed ?? 0` invented a count the document never stated. All of those
now return null, which the caller reports as an unreadable preflight rather
than a passing one — along with a `status`/`allowed_mode` pair that disagree.

Condition 8 is where everything TypeScript cannot recompute is answered: that
check *is* the Python gate's verdict, captured for a specific cycle. Requiring
the same cycle is deliberate — the read model lets a newer manual preflight sit
beside an older execution for *display*, but it must not silently authorize it.
A newer preflight therefore shows `PREFLIGHT_CYCLE_MISMATCH` rather than
`PASS`.

### 10.9 Pages

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

Non-trading. Runs on `main` pushes, pull requests and manual dispatch. Five
independent jobs:

| Job | What it proves |
|---|---|
| `dashboard-gate` | Node 22, `npm ci` from the lockfile, `npm audit --audit-level=high`, dashboard tests, ESLint, `tsc --noEmit`, production `next build`, and the Playwright end-to-end suite against that build |
| `release-gate` | Python 3.12.11, `pip install --require-hashes -r requirements.lock`, `pip check`, the complete pytest suite, `compileall`, critical Ruff checks (E9,F63,F7,F82), and `scripts/sanity_check.py` |
| `supabase-schema-gate` | Applies **every** migration to a real `postgres:16-alpine` service and runs the SQL assertions against it — a database test, not a grep over SQL text |
| `concurrency-gate` | Runs the two races as actual races — two `psql` processes, two overlapping transactions. Exactly one of two concurrent `create_account_atomic` calls with the same Vault ids may commit, and an older refresh reservation may not publish over a newer one |
| `postgrest-gate` | Starts a real PostgREST against that database with `db-max-rows=100` and asserts the API surface: which `/rpc/` functions are reachable, that the history snapshot returns everything past the cap, that a page walk demonstrably tears where the snapshot does not, and that a function created *after* the migrations is not anonymously callable |

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
`paper-runtime-state-<approved sha>` contains exactly three entries, named
relative to the archive root — not with the `state/` prefix they carry in the
repository:

| Entry | Content |
|---|---|
| `performance.json` | Equity, cash, risk tier, rolling history, frozen plan |
| `positions.json` | The executor's last saved position snapshot |
| `production/last_run.json` | The cycle record: release SHA, status, timings |

The `paper-diagnostics` artifact carries `production-preflight.json` and,
when a cycle executed, `production-execution.json`.

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
| `0012_view_and_write_acl.sql` | Closed the `accounts_safe` view and the remaining table-level write grants |
| `0013_account_lifecycle_rpc.sql` | `create_account_atomic` / `delete_account_atomic` / `update_account_metadata` — account lifecycle in one transaction |
| `0014_history_snapshot_rpc.sql` | `account_history_snapshot` — one `STABLE` call returns equity and flows from a single MVCC snapshot |
| `0015_sequence_and_function_acl.sql` | Revoked sequence privileges; first attempt at closing routine execute (superseded below) |
| `0016_global_function_acl.sql` | Global `ALTER DEFAULT PRIVILEGES`, event trigger removed, catalogue asserted by live probes inside the migration |
| `0017_refresh_generation_and_guards.sql` | `begin_broker_refresh` / `publish_broker_refresh`; NULL and shape guards on every destructive RPC |
| `0018_no_delete_reconciliation.sql` | A refresh may never delete; refresh tokens bound to `credential_version`; one Vault secret per account, enforced by a primary key |

**None of these is confirmed applied in production by this document.** The
migration ledger in the Supabase project is the only authority for that, and it
must be read before every deployment (section 13.2). What *is* fixed is the
rule: a migration that has been applied anywhere is never edited afterwards —
`0010` corrects `0009`, `0012` corrects `0011`, `0016` corrects `0015`, and so
on. Nothing above `0011` has been applied to production either.

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

No account read uses the cookie-bound (`authenticated`) client any more. There
are two server-side paths, and both check ownership explicitly in code rather
than relying on a policy that one edit could widen everywhere:

* **`dashboard/lib/accounts/session.ts`** — how a *route* obtains the selected
  account. `loadOwnedAccount` and `listOwnedAccounts` read with the service role
  and compare `owner_id` against the session user before returning anything.
* **`dashboard/lib/accounts/service.ts`** — the account-management operations
  (list, create, update, rotate, delete). These do their own service-role reads
  and writes, each scoped with an explicit `.eq("owner_id", userId)` and
  `.is("deleted_at", null)`, and the two lifecycle flows run inside the
  `rotate_account_credentials` and `delete_account_atomic` transactions from
  `0013`.

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

### 12.3 What 0012 changed and why

`0011` wrote `revoke all on accounts_safe from public` and then granted SELECT
to `authenticated`. On a real Supabase project that is not enough. Supabase's
initial schema sets

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
```

so every table and view created afterwards arrives with SELECT, INSERT, UPDATE,
DELETE and TRUNCATE granted **directly** to `anon` and `authenticated`.
Revoking from `public` does not touch a direct role grant, so all three
`*_safe` views shipped DML-capable.

That was exploitable, and it was verified against a real server before the fix.
`accounts_safe` selects from one table with no aggregate, so PostgreSQL makes
it automatically updatable, and a view executes with its **owner's**
privileges:

```sql
set local role authenticated;
update accounts_safe set nickname = 'pwned' where id = ...;   -- 1 row
```

Neither the base-table grant nor the RLS policy that `0011` removed applies to
the view owner. `DELETE` happened to be caught by the `0009`/`0010` guard
trigger and the two join views are not auto-updatable, but none of that was by
design.

`0012` therefore names every role explicitly, marks the three views as
security barriers, removes client write privileges from the remaining
account-scoped and shared tables (all of them are written by the service role;
the one exception is a user editing their own `profiles` row), narrows this
migration owner's default privileges so the next new object does not repeat it,
and then **verifies the resulting catalogue with `has_table_privilege` and
fails the migration if it is wrong**.

The test harness was wrong too, and was fixed alongside: `bootstrap_local.sql`
granted weaker defaults than Supabase does and gave `anon` nothing, so the
suite had been exercising a database more locked down than production.
`client_read_exposure.test.sql` now asserts the catalogue *and* runs real
`INSERT`/`UPDATE`/`DELETE` statements as `authenticated` against all three
views.

### 12.4 What 0013 changed and why

Key rotation and account deletion were each a sequence of independent round
trips from Node, and every gap between them was a place to fail into a state no
retry could repair:

* key rotated, secret not — Vault holds a new key beside the **old** secret,
  and the previous key value is gone, so the pair can never be made consistent
  again;
* both rotated, row update failed — the account still advertises the old broker
  account number that the production binding compares against;
* Vault purged, soft delete failed — a live row pointing at secrets that no
  longer exist;
* soft delete succeeded, Vault purge failed — and the purge result was
  discarded entirely, so live credentials stayed behind a "deleted" account
  with no error anywhere.

A PL/pgSQL body is one transaction, so `rotate_account_credentials` and
`delete_account_atomic` make each flow all-or-nothing: the Vault writes, the
row change and the audit entry commit together or not at all. Both are
service-role only, both verify ownership themselves, and both lock the row
`FOR UPDATE` so concurrent calls serialise. `supabase/tests/account_lifecycle.test.sql`
proves the rollback property against a real server — including that a failed
rotation leaves the previous key value intact.

### 12.5 What 0014 and 0015 changed and why

**0014 — one snapshot, and the last two write flows.** The history snapshot is
described in section 10.7. Alongside it, `create_account_atomic` and
`update_account_metadata` close the last gap in the claim that every account
write is audited: both flows previously wrote the row and then inserted the
audit entry as a separate round trip whose result was discarded, so either
could succeed with no record that it happened. An audit log that is sometimes
missing entries is worse than none, because its silence is read as evidence.

Creation keeps a two-phase shape by necessity — the Vault secrets must exist
before the row can reference them, and validating the key pair means calling
Alpaca, which cannot happen inside a transaction. The caller stores the secrets
first; if the transaction then fails, it purges them and reports it when that
purge also fails.

**0015 — sequences and functions.** 0012 fixed tables and views, but Supabase's
defaults cover three object classes. Two holes remained:

* every identity column's **sequence** arrived with USAGE, SELECT and UPDATE
  for `anon` and `authenticated` — that is `nextval()` and `setval()`, so a
  client could burn identifiers or rewind a sequence until the next server
  insert collides. RLS does not apply to sequences at all;
* **functions** are granted EXECUTE to `PUBLIC` by PostgreSQL itself, and to
  `anon`/`authenticated` by Supabase's defaults, so the next RPC added in
  `public` would be published on `/rpc/` to unauthenticated callers.

0015 sweeps both classes, restores an audited whitelist (only `owns_account`,
`is_service_role` and `jwt_role` stay client-executable, because RLS policies
and the guard trigger evaluate them in the caller's context), and narrows the
defaults.

0015 concluded that `ALTER DEFAULT PRIVILEGES` could not remove PUBLIC's
built-in EXECUTE and installed an event trigger instead. **That conclusion was
wrong, and the trigger was harmful.** 0016 replaces it. Four findings, each
reproduced against PostgreSQL 16 before the fix:

* **The trigger aborted `CREATE PROCEDURE`.** `REVOKE … ON FUNCTION` refuses a
  procedure (`public.pp() is not a function`), and because the trigger runs at
  `ddl_command_end` in the same transaction, its failure rolled the `CREATE`
  back. Any future migration adding a procedure would simply have failed.
* **The trigger never saw `CREATE AGGREGATE`.** An aggregate is a `pg_proc` row
  reachable through `/rpc/` like any other, and it kept the PUBLIC grant.
* **Only the *schema-scoped* form fails.** `ALTER DEFAULT PRIVILEGES IN SCHEMA
  public REVOKE …` stores no row when the resulting ACL would be empty, and a
  non-empty stored default is merged *over* the built-in so PUBLIC survives.
  The **global** form — no `IN SCHEMA` — stores the row and replaces the
  built-in, covering functions, procedures and aggregates in one statement.
* **`CREATE OR REPLACE` does not strip grants.** PostgreSQL preserves an
  existing ACL. The stripping previously observed came from the trigger itself,
  which fires on the `CREATE FUNCTION` tag that `CREATE OR REPLACE FUNCTION`
  also emits.

0016 therefore drops the trigger, applies the global default, re-sweeps every
routine with `ON ROUTINE` (the spelling that covers all three kinds), restores
the whitelist, and **fails** if the catalogue disagrees — including a live
probe that creates a function, a procedure and an aggregate inside the
migration and inspects them. Asserting the stored default alone is what 0015
did, and it shipped a control that did nothing.

Consequence for future migrations: a new routine in `public` arrives with no
client privileges, so every new RPC must grant explicitly.

### 12.6 What 0017 changed and why

Three ways to lose real data, all closed together.

**Two refreshes could interleave.** `/equity` and `/performance` each refreshed
both mirrors independently, writing as they went. Two overlapping requests
could publish in either order, so an older fetch could land on top of a newer
one — and the equity curve and the ledger could come from different moments
even though every number derived from them treats them as one observation.
`begin_broker_refresh` issues a monotonic generation *before* the broker is
read; `publish_broker_refresh` refuses any generation that is not newer than
the one already published. Both datasets go in one call, in one transaction.

**A partial payload was indistinguishable from a retraction.** The old
reconciliation deleted every stored day at or after the earliest incoming day,
which is wrong in both directions: a truncated response deletes real history,
and a payload whose *oldest* day was retracted never deletes it, because the
bound moves with the payload. 0017 replaced the bound with a size test — a
shrink beyond the smaller of five rows and a tenth of the history was refused.
**That was still wrong, and 0018 removed it entirely** (section 12.7): a
threshold cannot tell a withdrawal from an omission, it only changes how often
it guesses. Nothing deletes now.

**Destructive RPCs accepted anything.** Every argument is now checked for NULL
and shape before a row is touched. `create_account_atomic` additionally
requires a non-empty broker account number — the value the production binding
compares against — and two Vault secret ids that are non-null, distinct from
each other, actually present in the vault, and not already in use by another
live account. Sharing one id between the key and the secret would mean a
rotation overwrites the secret with the key's value; sharing across accounts
would mean rotating one silently breaks the other.

An empty activity walk is the subtlest case: an outage and "this account really
has no activities" produce the same payload. So the walk reports how many
activities it *examined*, and an empty payload against a non-empty ledger is
refused unless something was actually looked at.

`reconcile_cash_flow_mirror` and `replace_equity_snapshots` are superseded and
now raise. A shim that quietly did half the job would be worse than an error.

Everything in this section about *how much* a refresh may remove was superseded
by 0018, which removed the ability to remove.

### 12.7 What 0018 changed and why

Three independent ways to lose real data, all of them reproduced against
PostgreSQL 16 before being fixed.

**A partial HTTP 200 was indistinguishable from a retraction, and 0017 decided
between them by counting.** A refresh could delete stored days the incoming
payload no longer mentioned, bounded by `equity_retraction_allowance()` — the
smaller of five rows and a tenth of the history. The reproduction:

```
stored equity rows                    100
incoming payload, flagged complete     99   (one valid day omitted)
allowance                               5
100 - 99 = 1 <= 5                     -> accepted
result  {"equity_removed": 1}         -> the omitted day is gone
```

The bound was not the bug; the premise was. Nothing in a 200 response
distinguishes "the broker withdrew this day" from "the broker did not send it
this time", and no threshold can recover information the payload does not
contain — every threshold deletes real history at some frequency. A refresh
therefore has no code path that deletes. A stored row the payload omits aborts
the whole transaction with `RECONCILIATION_CONFLICT` and the mirror is left
byte-for-byte as it was. The same rule covers the ledger: `p_flows = []` with
`p_flows_scanned = 1` used to empty it, on the theory that having examined
*something* proved the absence was real. The absence of an activity is never
evidence that a mirrored one was withdrawn.

Withdrawing a row is now a deliberate act: `retract_equity_snapshot` and
`retract_cash_flow` take one row and a stated reason, and write an audit entry.

**`create_account_atomic` guarded credential reuse with `SELECT EXISTS`.** That
is a read, and two concurrent transactions both read "not in use" before
either writes. Reproduced with two `psql` processes holding overlapping
transactions: both committed, leaving two live accounts sharing one Vault
secret — rotating either would silently break the other. The guard is now
`account_credential_assignment`, whose primary key on `secret_id` is evaluated
at write time, so exactly one writer can succeed whatever the interleaving. It
covers cross-column reuse too, because the constraint is on the id alone.

**A refresh could publish data fetched with credentials that had since
changed.** A reservation now records the account, owner, mode, broker account
number and `credential_version` it was issued against, and publishing
re-checks all five. A rotation landing mid-fetch refuses the publish instead
of mixing two credentials' data into one mirror.

One implementation note worth keeping, because it cost an afternoon: that
refusal must not raise a class-40 SQLSTATE. `40001` (serialization_failure)
tells PostgREST the call may succeed on retry, and PostgREST retries it in a
loop — the request hung until the client gave up, while every other refusal
returned in 30 ms. The condition is permanent: the payload really was fetched
with the old credentials, and only re-fetching helps. It raises `P0001`.

### 12.8 Application security invariants

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

### 13.2 The three images and what each schema they run on

Deployment is a schema change and an image change together, and the two are not
independent. Three builds matter:

| Build | Runs on the **pre-0011** schema | Runs on the **0011–0017** schema |
|---|---|---|
| `d11bbad8a` — what production runs today | yes | **no** — reads `accounts` as `authenticated`, which `0011` revokes |
| `fc73acaae` — the **bridge** | yes | yes, reads and writes, but see 13.4 |
| the new candidate | **reads only** | yes |

`fc73acaae` is the pivot: it was the first build to move every account read to
the service role, so it is the only existing image that works on *both* sides
of the migration. That makes it both the safe intermediate step and the real
image rollback target.

**The candidate is not fully functional before the migrations.** Its read paths
work on the old schema — the account reads use the service role and it touches
none of the `*_safe` views — but every write path calls an RPC that does not
exist yet: `create_account_atomic` and `update_account_metadata` (0014),
`rotate_account_credentials` and `delete_account_atomic` (0013), and
`begin_broker_refresh` / `publish_broker_refresh` (0017). On the old schema all
of those return "function does not exist", and the equity and performance
screens depend on the refresh, so they report `UNAVAILABLE` rather than
rendering. That is safe — nothing is written — but it is not a working
deployment, which is why the candidate goes in *after* the migrations.

### 13.3 Order of operations

1. Access the origin host, and read the Supabase migration ledger to record
   exactly which migrations are applied **today**. Do not assume, and do not
   infer it from the fact that the site works: this document does not know
   either, and every step below depends on the answer.
2. Build the **bridge image** from `fc73acaae` with `DASHBOARD_MAINTENANCE_MODE`
   available in its environment (13.4). Deploy it against the current schema
   with the freeze **off** and smoke-test it authenticated: login, account
   switch, every strategy section, the `UNAVAILABLE` states, `/api/health`.
3. Turn the freeze **on** (`DASHBOARD_MAINTENANCE_MODE=on`) and confirm it: a
   `POST /api/accounts` must return `503` before the freeze is trusted.
4. Apply **every** pending migration in numeric order — `0011` through `0018`,
   or whatever subset the ledger from step 1 says is missing. A partial
   application leaves the RPC surface and the ACL in a state no test covers.
5. Verify the bridge again on the migrated schema. Reads must keep working
   throughout; if they do not, roll back (13.5) before going further.
6. Deploy the new candidate image, still frozen.
7. Verify the candidate's reads on the migrated schema.
8. Lift the freeze and run the full authenticated smoke test, including the
   paths the migrations change and one explicit
   `POST /api/accounts/[id]/refresh`.
9. Confirm Supabase signup is disabled.

Do not change `PRODUCTION_RELEASE_SHA` in order to deploy the UI. Do not run a
mutating paper cycle as a smoke test.

### 13.4 The freeze is enforced in the application, not announced

`fc73acaae` reads correctly on both schemas, but its **account lifecycle
operations are not atomic**: key rotation is a sequence of separate Vault and
row writes, and a failure between them leaves a new key beside the old secret
with the previous key value already overwritten — unrecoverable. Deletion has
the same shape, and a failed Vault purge is discarded silently.

And after the migrations those operations **do not fail**. `fc73acaae` never
calls `0013`/`0014`'s transactions — it performs the same sequence of
individual writes it always did, and every one still succeeds against the
migrated schema. The window is not self-protecting: it looks like it works,
and it is exactly as unsafe as before.

So the freeze is a control in the code. `DASHBOARD_MAINTENANCE_MODE=on` makes
every mutating handler return `503` before it touches Alpaca, the Vault or the
database:

| Frozen | Why it is in the list |
|---|---|
| `POST /api/accounts` | non-atomic creation |
| `PATCH` / `DELETE /api/accounts/[id]` | non-atomic update and deletion |
| `POST /api/accounts/[id]/verify` | writes the status and the broker binding |
| `POST /api/accounts/[id]/refresh` | writes `equity_snapshots`, `cash_flows`, `broker_refresh_state` and `broker_refresh_token` |

The last row is the one an edge-level block would have missed. A freeze that
stopped the lifecycle endpoints while the financial mirrors kept moving would
not be a freeze; it is included because refreshing is now an explicit endpoint
rather than a side effect of two GETs, which is also what makes it blockable.

It is an environment variable rather than a database flag on purpose: the
freeze has to hold while the database is being migrated, and a flag stored in
the thing being migrated cannot do that. **A rollback image that does not carry
this control is not a safe rollback target** — verify `503` before trusting it,
in both directions.

Reads are unaffected and stay served: they no longer write anything, so there
is nothing to freeze, and the dashboard stays legible while the work happens.

### 13.5 Rollback

Two independent axes, and they roll back separately.

**Image rollback.** `fc73acaae` reads correctly on either schema, which is what
makes it a bridge — but as tagged it carries no write freeze, so on its own it
is a rollback target for *reads* only. A rollback image must be built from
`fc73acaae` **plus** the maintenance control (13.4), or the moment it starts
serving, its non-atomic lifecycle writes are reachable again. Verify `503` on
`POST /api/accounts` before trusting either direction of the rollback.

If the candidate misbehaves after step 6, go back to that image without
touching the database.

`d11bbad8a` is a valid target only *before* the migrations. Afterwards it reads
`accounts` as `authenticated`, which no longer has that privilege, so it fails
on every account screen.

Re-granting `select` on `accounts` to make it work again is **not** a rollback.
It re-opens the exact exposure `0011` closed — the full broker account number,
both Vault secret UUIDs, `owner_id` and `deleted_at`, readable by any signed-in
browser through PostgREST — and it must not be done.

**Database rollback.** The migrations have no down-scripts, so reverting the
*schema* is a point-in-time restore (Supabase PITR) to before step 4. That is
the only supported database rollback, and it loses everything written since.
It is not the image rollback, and the two are not substitutes: an image
rollback needs no PITR, and a PITR does not change which image is serving.

Before deploying, confirm the PITR window covers the planned maintenance and
that a restore has actually been rehearsed. A rollback plan that has never been
executed is not a rollback plan.

### 13.6 Smoke tests never mutate the production account

The production-controlled account is bound to the paper executor by
`PRODUCTION_ALPACA_ACCOUNT_NUMBER`. Rotating its keys or deleting it during a
smoke test would break that binding, and deletion cascades its history.

Test the mutating paths — create, metadata update, key rotation, deletion — on
a **disposable observer account** created for the purpose: a second paper
account, owned by the same user, that is not the production account and holds
no history worth keeping. Delete it when finished.

On the production account, smoke-test reads only.

### 13.7 Runtime environment

Every value the running container needs. Nothing here is optional unless it
says so.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL; reaches the browser. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable anon key; reaches the browser. |
| `SUPABASE_SERVICE_ROLE_KEY` | Full-access key. **Server only** — it bypasses RLS and is how every account read and write is made. |
| `BUILD_SHA` | The commit this image was built from. `/api/health` and `payload.web` report it; without it the build SHA is honestly unknown. |
| `GITHUB_TOKEN` | Read-only. **`Actions: read` is always required** — it is the only way to list workflow runs and download the private `paper-runtime-state-*` and `paper-diagnostics` artifacts. Without it every strategy section is `UNAVAILABLE`. **`Environments: read`** is additionally needed to read the approved release from the `paper-production` environment; that one scope — and only that one — can instead be supplied by `PRODUCTION_RELEASE_SHA` below. |
| `GITHUB_REPO` | Repository the dashboard reads from (`DanilaAnikin/nate_trader`). |
| `GITHUB_STATE_REF` | Branch for repository-state reads (`main`). |
| `PRODUCTION_OWNER_USER_ID` | Binding condition 1: the Supabase user allowed to see the production runtime. |
| `PRODUCTION_ACCOUNT_ID` | Binding condition 2: the account the executor trades. |
| `PRODUCTION_ALPACA_ACCOUNT_NUMBER` | Binding condition 5: compared against a number read fresh from Alpaca. Mandatory — see section 10.3. |
| `PRODUCTION_RELEASE_SHA` | Optional. Substitutes for the token's `Environments: read` scope only; it does **not** replace `GITHUB_TOKEN`, and setting it changes nothing about what the executor trades. |
| `V11_EPOCH_BASELINE` | Optional inline epoch baseline JSON, when it is not committed to `state/v11_epoch_baseline.json`. |
| `ALLOW_LEGACY_DASHBOARD` | Optional, non-production only. Explicit opt-in to the repository-only legacy shell. |

### 13.8 Release commands

```bash
cd dashboard
npm ci
npm test
npm run lint
npx tsc --noEmit
npm run build
npm audit --audit-level=high
npx playwright test   # also runs in CI, in the release gate

cd ..
PYTHONPATH=scripts python3 -m pytest -q
python3 -m compileall -q scripts tests
python3 scripts/sanity_check.py
git diff --check

DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  supabase/tests/run_integration.sh

# Real PostgREST, with a 100-row server cap. Needs docker.
supabase/tests/run_postgrest.sh
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
- **Forward performance requires a flow-free window.** Any external cash
  movement inside the measured period makes the return `UNAVAILABLE`, because
  correcting for it exactly needs a portfolio valuation at the moment of the
  flow and only daily equity exists. Closing this needs intraday valuation
  around each flow, not a different formula. See section 10.7.
- **The migrations have no down-scripts.** Reverting the *schema* is a
  point-in-time restore, and it loses everything written since. Reverting the
  *image* is separate: `fc73acaae` reads on both schemas, but a rollback image
  must be built from it *plus* the maintenance control, because its lifecycle
  writes are non-atomic and do **not** start failing after the migrations
  (sections 13.4 and 13.5).
- **The production migration ledger has not been read.** Every statement here
  about which schema production is on is an inference from the running image,
  not a reading of the ledger.
- **Tags are unsigned.** No signing key is configured for this repository, so
  tags are annotated but not verifiable. Do not describe a tag as signed.
  Branch, tag and environment protection *are* now configured — section 16
  states exactly what, and what was deliberately left off.

The correct answer to a missing backend fact is a small, sanitized, well-tested
observability contract — never frontend inference.

## 16. Release-boundary protection, and what is still external

Configured on 2026-08-11, having previously been absent entirely:

| Control | State |
|---|---|
| `main` branch protection | **Active.** Five required status checks (`dashboard-gate`, `release-gate`, `Supabase schema and RLS integration`, `PostgREST API surface`, `Concurrency races`), strict up-to-date, force pushes and deletions blocked, `enforce_admins: true` |
| Tag protection for `v11-*` | **Active** (repository ruleset). Deletion, non-fast-forward and update are all blocked, with no bypass actor — a historical tag can no longer be moved even by the owner |
| `paper-production` environment | **Deployment branch policy: protected branches only.** A dispatch cannot come from an arbitrary ref |

`enforce_admins: true` is the point of the exercise: on a single-maintainer
repository, protection the maintainer can walk past is not protection. The
practical consequence is that a direct push to `main` now fails until the
five gate jobs are green on the pushed commit, and an emergency fix requires
deliberately lifting the rule first:

```bash
gh api -X DELETE repos/DanilaAnikin/nate_trader/branches/main/protection   # then restore it
```

### Deliberately not configured

**Required reviewers on `paper-production`.** An environment reviewer applies
to scheduled runs as well as manual ones, so adding one would leave every
weekday paper cycle waiting for a human approval that nobody is watching for —
it would silently stop the trader. The protection worth having here is the
release gate and the immutable `PRODUCTION_RELEASE_SHA`, both of which are in
place.

### Still external

| Blocker | What it needs | Why it is not done here |
|---|---|---|
| Tag signing | A signing key trusted by the repository | No key is configured. Tags are annotated, never signed; do not describe one as verified |
| Reading the production migration ledger | Access to the origin Supabase project | Everything in section 13 depends on it, and it has not been read |
| A rollback image carrying the write freeze | A build of `fc73acaae` plus `DASHBOARD_MAINTENANCE_MODE` | `fc73acaae` as tagged has no freeze, so it is a read-only rollback target (13.5) |

## 17. Repository map

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
| `.github/workflows/v11-release.yml` | Non-trading release gate (5 jobs) |
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

## 18. Historical note

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
