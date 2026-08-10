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
A push alone never submits an order: the workflow checks out only the full
commit SHA approved in the `paper-production` environment, requires a green
release gate for that SHA, and validates the SHA-bound runtime artifact before
restore. The scheduled/manual job must pass every gate, and the only accepted
mutating mode remains Alpaca paper trading.

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

# Pre-registered cross-strategy tournament; research-only, never deploys a winner
python3 scripts/backtest/run_strategy_tournament.py
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

Before the canary, `PRODUCTION_RELEASE_SHA` in the `paper-production` GitHub
environment must contain the full commit SHA whose release gate passed.

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
npm ci
npm run dev
```

The Next.js dashboard is a **read-only observability layer** for the V11 paper
forward validation. It cannot place, replace, cancel or approve anything: there
is no execute, cancel, buy, sell, release-approval or emergency control in the
UI, and no server route that can reach a mutating broker endpoint.

Routes: `/` overview, `/positions` portfolio (actual vs V11 target),
`/screener` signals and universe, `/research` validation and research,
`/operations` release/scheduler/gates, `/accounts`, `/settings`, `/login`.

#### One server-side read model

Every screen consumes a single account-scoped, runtime-validated payload from
`GET /api/accounts/[id]/status` (`dashboard/lib/status/`). Components never join
unrelated JSON sources themselves. The payload keeps these facts strictly
separate, each with its own `source`, `scope`, absolute `asOf`, relative age and
freshness state:

| Section | Source |
|---|---|
| `web` | this deployment's build SHA and data mode |
| `release` | approved paper release SHA, repository/research SHA, release gate |
| `accountBinding` | explicit server-side production-account binding |
| `broker` | fresh Alpaca REST snapshot for the selected account |
| `strategy` | private `paper-runtime-state-<approved SHA>` Actions artifact |
| `universe` | production preflight report + frozen plan |
| `validation` | `state/backtest/v11_validation.json` read at the approved SHA |
| `preflight` / `execution` | last successful production cycle |
| `operations` | GitHub Actions workflow runs for `paper-production.yml` |
| `tournament` | frozen epoch-1 research evidence |
| `convergence` | frozen plan vs the bound account's actual holdings |

States are explicit — `CURRENT`, `STALE`, `EXPIRED`, `MISMATCH`, `UNAVAILABLE`,
`NOT_APPLICABLE`, `PENDING`, `PASS`, `WARN`, `FAIL`. Missing, stale, expired or
mismatched data is never rendered as `0`, a green check, `LIVE` or `ONLINE`, and
the committed V10-era `state/performance.json` / `state/positions.json`
snapshots are never used as a fallback.

Three contracts inside the model are worth calling out:

- **Independent, paged source selection.** The latest workflow attempt, the
  latest valid preflight and the latest valid executor cycle are chosen
  separately, scanning *pages* of runs up to an explicit 45-day freshness
  boundary. An arbitrarily long series of manual `operation=preflight` runs
  updates only the preflight and never hides an older, still-valid execution;
  each section carries its own run URL, source and `asOf`.
- **One shared lineage verdict.** `lib/status/lineage.ts` cross-checks the
  approved release, strategy identity, strategy version and ranking-universe
  hash across the preflight, the frozen plan and the executor record. Only the
  frozen plan persists `signal_date`, so it is not compared between documents;
  it is required to be a valid `YYYY-MM-DD` calendar date and to be no later
  than the cycle that wrote it. Evidence that is absent, empty or malformed
  fails exactly like a disagreement: a document that is present must carry
  every lineage field it owns, in the exact expected format. Any conflict — or
  any selector-level refusal — withholds *all* of strategy, universe,
  preflight, execution and convergence as `null`, with state `MISMATCH` when
  two documents disagree and `UNAVAILABLE` when the evidence was never there,
  and the effective validation gate cannot be `PASS`. An older artifact is
  never silently substituted.
- **One effective validation gate.** `validationGate` separates the historical
  `reportAssessment` from the currently `effective` gate. Effective `PASS`
  requires all of: report PASS, present and non-future generation and bar
  boundary dates, an unexpired deadline, a matching strategy identity, a
  matching ranking universe, and an authoritatively known approved release.
  Overview, Operations and Research all render this one value, so an expired or
  mismatched report can never look like a green "Validation gate PASS".

#### Reading the private V11 runtime safely

The strategy sections come from the private Actions artifacts, read **server
side only** with a `GITHUB_TOKEN` that never reaches the browser. The reader
selects the artifact by the *approved release SHA* (not the trigger SHA),
validates the artifact name, release lineage, schema, size and exact expected
entry list, and returns a sanitized DTO. Broker order IDs, client order IDs,
Vault identifiers, full broker account numbers and raw artifacts never leave the
server. Any failure returns `UNAVAILABLE`.

`actions/upload-artifact` streams, so every real artifact entry sets
general-purpose bit 3 and leaves the local header's CRC and sizes zero, with the
true values in a trailing data descriptor and the central directory. The reader
supports that layout — with and without the optional `PK\x07\x08` signature —
and verifies the descriptor against the central directory. Refusing the flag,
as an earlier build did, made the production runtime artifact unreadable.

Everything else stays hardened: the advertised size is checked before any
download, the body is streamed and abandoned the moment it exceeds the cap (so
a chunked response with no `Content-Length` cannot be buffered to exhaustion),
and the archive must pass duplicate-name, path-traversal, encryption flag,
compression method, declared-versus-actual size, local/central/descriptor
agreement and CRC-32 checks. The runtime artifact must contain exactly its three
expected entries; the diagnostics artifact has an explicit
required/optional/ignored allowlist and rejects anything else.

A release gate counts as `PASS` only when a **push**-triggered `v11-release`
run for the exact approved SHA completed successfully. A pull-request or
`workflow_dispatch` success never authorizes a release.

Nothing in this path touches a strategy-identity source, so the existing
canonical validation and release approval remain valid.

#### Production authorization and account binding

The frozen plan, pending order intents, preflight, executor results and workflow
operations describe **one central production account**. They are not per-tenant
data, so owning some Supabase account is never enough to read them.
Authorization requires all of the following together — an AND, never an OR:

1. `PRODUCTION_OWNER_USER_ID` equals the signed-in Supabase user;
2. `PRODUCTION_ACCOUNT_ID` equals the selected account;
3. that account is in **paper** mode; and
4. that account is owned by the production owner (read service-side from
   `accounts.owner_id`, never from anything the browser sent).

`PRODUCTION_ALPACA_ACCOUNT_NUMBER` is **required**, as a fifth AND condition.
Owner, account id and paper mode establish *who is asking about which row*;
they cannot establish that the row's Vault credentials point at the broker
account the executor actually trades. The number read fresh from Alpaca
`/v2/account` must therefore match it. A value stored in Supabase is never
accepted as proof, an unreadable broker fails the check closed, and an
unconfigured binding leaves every account observer-only.

An unauthorized viewer receives no plan, pending actions, preflight, executor
record or production operations, gets `NOT_APPLICABLE` for all of them, and
**causes no GitHub Actions API call at all**. Their own broker snapshot and the
public repository research evidence are still shown. A live account is always
read-only monitoring and is never presented as traded by V11.

Supporting database lockdown: migration `0009_accounts_server_managed.sql`
reduces `accounts` to a SELECT-only policy for end users, revokes their
INSERT/UPDATE/DELETE grants, and adds a trigger that rejects any client write to
`owner_id`, `mode`, `status`, `alpaca_account_number`, the Vault secret UUIDs,
`last_verified_at`, `last_synced_at`, `created_at` or `deleted_at`.

`0010_accounts_guard_authz_fix.sql` corrects that guard. 0009 authorized it with
a helper that fell back to `current_user`, which inside a `SECURITY DEFINER`
function is the function *owner*, not the caller — so a session without JWT
claims was authorized. The guard is now `SECURITY INVOKER` (it needs no
privileges of its own, and being a definer cost it the only reliable identity
signal), refuses a client role outright, prefers the request's JWT role claim,
and pins an explicit `search_path`. 0010 also names the three cosmetic columns
a client may change directly — `nickname`, `color`, `is_active` — so "what may
a client write?" is stated rather than implied.

`supabase/tests/run_integration.sh` applies **every real migration to a real
PostgreSQL server** and then runs the assertions against it; the release gate
runs it as the `supabase-schema-gate` job with a `postgres:16-alpine` service.
`tests/test_supabase_account_lockdown.py` additionally keeps the migration text
honest where no database is available.

#### Registration and the client account DTO

There is no public sign-up: the login screen is sign-in only. That is a UI
change, not an authorization boundary, so **public sign-ups must also be
disabled in the Supabase project** (Authentication → Providers → Email →
disable "Enable sign ups"). Even a registered user is refused the production
runtime by the server-side authorization above.

`SafeAccount` is an explicit allowlist, not `Omit<Row, …>`, so a new sensitive
column cannot become client-visible by default. The browser only ever receives
`id`, `nickname`, `mode`, `status`, `color`, `is_active`, `last_verified_at`,
`created_at` and a four-character `brokerAccountMask`. The full broker account
number, the Vault UUIDs, `owner_id` and `deleted_at` never leave the server —
in an API body, in Server Component props, or in the RSC Flight payload.

#### Forward performance

`GET /api/accounts/[id]/performance` reports cash-flow-adjusted time-weighted
return against the benchmark over exactly the sessions both series share, dated
in America/New_York, with no forward-fill past the last real benchmark bar.

It is strictly fail-closed: every one of these returns `UNAVAILABLE` with a
named reason code rather than a number — a non-production viewer, an approved
release that is unknown or only derived, a baseline bound to a different
release, strategy version or account, a baseline whose recorded start session,
starting equity or benchmark close is absent or disagrees
(`BASELINE_OBSERVATION_MISSING` / `BASELINE_OBSERVATION_MISMATCH`), an equity or
cash-flow refresh or query error, an incomplete Alpaca activity walk, or a
window the two series do not genuinely share. The calculation never silently
re-anchors to the first later common day, and Alpaca activities are paginated
past the 100-item page cap back to the epoch boundary with completeness
recorded.

The baseline is parsed with nothing defaulted: it must *state* strategy version
`v11-adaptive-momentum` and benchmark `SPY`, both anchors must name the same
session, `startedAt` must fall on that session in exchange time, and no date may
be in the future. Cash flows include ACAT transfers (`ACATC`) and any activity
that is not fully understood — missing id, type or timestamp, an invalid amount,
an unrequested type, or a full page with no usable pagination id — makes the
walk incomplete and the whole result `UNAVAILABLE`. Freshness is the market age
of the last shared session (`STALE` after 5 days, `EXPIRED` after 21), and a
future-dated activity is `MISMATCH`, never `CURRENT`.

It requires a persisted, auditable V11 epoch baseline
(`state/v11_epoch_baseline.json`, or the `V11_EPOCH_BASELINE` server variable)
carrying the release SHA, start time, starting equity and benchmark baseline.
**No baseline is currently persisted, so this panel reports `UNAVAILABLE`** —
all-time account history contains pre-V11 (V10 / TQQQ / UPRO) results and must
never be relabelled as V11 alpha.

#### Server environment

Documented without values in `.env.example`: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `BUILD_SHA`,
`GITHUB_TOKEN`, `GITHUB_REPO`,
`GITHUB_STATE_REF`, **`PRODUCTION_OWNER_USER_ID`**, `PRODUCTION_ACCOUNT_ID`,
`PRODUCTION_ALPACA_ACCOUNT_NUMBER`, `PRODUCTION_RELEASE_SHA`,
`V11_EPOCH_BASELINE`, `ALLOW_LEGACY_DASHBOARD`.

`GITHUB_TOKEN` is **always required**: `Actions: read` is the only way to list
workflow runs and download the private artifacts, and nothing substitutes for
it. `Environments: read` is additionally needed to read the approved release
from the `paper-production` environment — and *that scope alone* may instead be
replaced by an explicit server-only `PRODUCTION_RELEASE_SHA`. Setting
`PRODUCTION_RELEASE_SHA` does not remove the need for the token.

The dashboard container must **not** receive the executor's `ALPACA_API_KEY`,
`ALPACA_SECRET_KEY` or `TRADING_MODE`. It reads broker data only through
per-account Supabase Vault credentials and has no mutating broker path.

#### Dashboard testing

```bash
cd dashboard
npm ci
npm test                 # vitest: parsers, freshness, binding, convergence,
                         # TWR, scoping, read model, component states
npm run lint
npx tsc --noEmit
npm run build
npm audit --audit-level=high

npm run test:e2e:install # once, downloads Chromium
npm run test:e2e         # Playwright: routes, a11y, responsive, fail-closed,
                         # security headers, no secrets in the bundle
```

The Playwright suite runs the production build twice with different runtime
configuration — an explicit-legacy shell and a fully unconfigured, fail-closed
server — so both halves of the contract are covered without ever adding a
test-only authentication bypass. Authenticated flows against real broker data
require a Supabase test project and are not part of the default run.

#### Recovering from an unavailable runtime

1. Check `/operations`: is the failure the latest workflow attempt, the artifact
   read, or the token?
2. An **infrastructure failure** (no job step ran) leaves the last successful
   executor snapshot valid — nothing needs fixing in the dashboard.
3. `UNAVAILABLE` with a token message → the deployment is missing `GITHUB_TOKEN`
   or its `actions: read` scope.
4. `MISMATCH` → the artifact belongs to a different release than the approved
   `PRODUCTION_RELEASE_SHA`. Do **not** change the approval to make the UI
   green; investigate the workflow.
5. `EXPIRED` validation → regenerate the canonical report per
   `strategy/PRODUCTION_RUNBOOK.md`. Paper buys are already blocked by the
   Python gate; the UI is only reporting it.

Deployment of the dashboard never changes `PRODUCTION_RELEASE_SHA`, never
triggers a paper cycle and never places an order.

Older `DASHBOARD_SPECIFICATION.md` and `DASHBOARD_IMPLEMENTATION_PLAN.md` are
archived planning documents; their multi-account trading-control assumptions
contradict the current paper-only executor and must not be implemented.

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

### Current strategy-tournament snapshot

The pre-registered epoch-1 tournament completed on 2026-08-03 with the fixed
decision **RETAIN_V11**. It compared eleven distinct long-only approaches at
7/15/25/50 bps per fill, added a 30 bps reversal check, delayed every strategy
by one extra session, and applied paired stationary bootstrap, White Reality
Check, Deflated Sharpe, fold-stability, and capacity gates. No challenger
cleared every gate, so no production strategy or live state changed.

At the primary 15 bps cost, V11 remained the development return leader with
15.87% CAGR, +7.06 percentage points over SPY, and a -19.71% maximum drawdown.
Risk-adjusted momentum was the most interesting challenger: its reused-period
excess was +8.02 points, but its development CAGR was lower at 12.27%, it lost
development excess at 50 bps and under D+2 execution, and its bootstrap and
multiple-testing gates failed. Low-volatility trend was the descriptive
minimum-risk leader (23.27% adverse q95 bootstrap drawdown at 25 bps versus
27.14% for V11), but its primary development CAGR was only 4.21% and it lagged
SPY in both aggregate periods.

See
[`strategy/strategy_tournament_epoch_1_results.md`](strategy/strategy_tournament_epoch_1_results.md)
for the compact table and
[`state/backtest/strategy_tournament_epoch_1.json`](state/backtest/strategy_tournament_epoch_1.json)
for the complete reproducible evidence. The later interval remains reused and
the current-universe history remains survivorship-biased; these results do not
establish future alpha.

A separate clean diagnostic under the locked Python 3.12.11, NumPy 2.5.1, and
Pandas 3.0.5 runtime reproduced every stored V11 and risk-adjusted-momentum
development/reused metric to four decimal places. The complete artifact keeps
the runtime of its original full run recorded explicitly.

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
| `scripts/backtest/run_strategy_tournament.py` | Frozen research-only multi-strategy tournament |
| `scripts/backtest/strategy_candidates.py` | Point-in-time candidate factors and target portfolios |
| `scripts/backtest/target_strategy_runner.py` | Common causal D+1/D+2 target-weight simulator |
| `scripts/backtest/tournament_statistics.py` | Bootstrap, Reality Check, DSR, and fold evidence |
| `scripts/backtest/` | Adjusted data, causal simulator, and BIL-aware metrics |
| `strategy/v11_adaptive_momentum.md` | Authoritative V11 specification |
| `strategy/strategy_tournament_epoch_1.md` | Pre-registered tournament contract |
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
