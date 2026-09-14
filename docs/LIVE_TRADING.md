# Real-money trading

This document describes a capability that exists and is tested. It does not
recommend using it. Whether V11 *should* trade real money is a separate
question from whether it *can*, and the answer to the first one is settled by
the validator and by forward paper evidence, not by this page.

## What changed, and what deliberately did not

Before, the system was paper-only by having no seam at all: four literal
`TradingClient(..., paper=True)` constructions and one comparison against the
string `"paper"`. That is a strong design, and it was strong precisely because
there was nothing to misconfigure.

Adding real money adds the seam. Everything that used to be implied by a
literal now has to be stated, checked, and refused when it does not line up.
The paper path is unchanged: `TRADING_MODE=paper` plus the two paper keys, and
nothing else, exactly as before.

The decision now lives in one module, `scripts/broker_mode.py`. Nothing else in
the repository decides which broker it reaches.

## Required live configuration

All of them, together. Any one missing refuses the run and names what is
missing; nothing has a default and nothing falls back to the paper values.

| Variable | Why it exists |
|---|---|
| `TRADING_MODE=live` | The word, in full. Anything unrecognised — including a typo like `Live!` — is a dry run, never a fallback to paper. |
| `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY` | Separate names from the paper pair. A misfiled paper key fails to authenticate instead of quietly trading the wrong book, and a live key can never be picked up by a paper run. Refused if identical to `ALPACA_API_KEY`. |
| `LIVE_TRADING_ENABLED` | A second, independent switch. Two variables have to be wrong at once for real money to move by accident. |
| `LIVE_TRADING_ACCOUNT_NUMBER` | The account this run may trade, declared out of band and checked against a fresh `GET /v2/account` before the first order. Credentials prove *an* account; only this proves *the* account. |
| `LIVE_CAPITAL_BUDGET_USD` | Total capital the live strategy may use across runs; caps sizing equity and checks holdings plus pending buys before new exposure. |
| `LIVE_MAX_ORDER_NOTIONAL_USD` | An absolute per-order dollar ceiling. |
| `LIVE_MAX_CYCLE_NOTIONAL_USD` | An absolute ceiling on everything one cycle may buy. |

### Why the two dollar ceilings are not optional

The existing strategy allocation limits are percentages of equity —
`max_position_pct: 9`, `momentum_max_sector_pct: 40`, `min_cash_pct: 10`. A
percentage limit scales a mistake with the account: if the equity read is wrong
or the target weights are wrong, the limit is wrong by the same factor and
enforces nothing. A flat dollar ceiling does not participate in that
computation, which is the entire reason it is there.

The capital budget and both ceilings must be finite positive numbers; `NaN`
and infinity are refused.
They are enforced in `trade.place_limit_order`, the single function every order
in this repository passes through, so no caller can forget them.

Live sizing uses the smaller of actual account equity and the configured capital
budget. Before a new BUY, the executor checks fresh positions and open BUY
commitments against that budget and actual cash; margin buying power cannot
expand it. Repeated cycles do not receive a new capital allocation. Price moves
can change the value of existing holdings; the budget blocks additional entries
rather than promising a fixed market value or triggering an extra liquidation.
Broker equity and risk history remain truthful account observations.

**Sells are never capped.** A notional ceiling that could block an exit would
convert a spending guard into an inability to reduce risk, which is worse than
the risk it prevents. The same applies to the kill switch: it stops entries, not
exits.

## The kill switch

While the file named by `LIVE_TRADING_KILL_SWITCH_FILE` exists (default
`state/production/LIVE_TRADING_DISABLED`), live entries are refused. It is
checked at call time, so creating the file stops the next cycle with no deploy
and no credential change:

```bash
touch state/production/LIVE_TRADING_DISABLED   # stop live entries
rm    state/production/LIVE_TRADING_DISABLED   # re-arm
```

Risk-reducing exits continue to work while it is engaged.

## What is unchanged from the paper path

Live is the paper path plus more refusals, never fewer. Every existing gate
still applies, in full:

- the `state/backtest/v11_validation.json` promotion gate, its strategy
  fingerprint, its ranking-universe hash and its 35-day expiry;
- the fresh broker clock gate for new exposure;
- short reconciliation as a blocking state;
- deterministic client order IDs and pending/partial order reconciliation;
- cancel-before-depend, and sell-then-buy sequencing;
- the SPY/SMA200 regime gate and the CAUTIOUS/HALT risk tiers.

A closed validation gate refuses live buys exactly as it refuses paper buys.

## Preparing a live cycle

Use the guarded `live-production.yml` workflow for production. It checks out the
approved release, restores or explicitly initializes the live book, verifies
its contract, and encrypts its records. Running the underlying executor directly
from a normal repository checkout does not perform that state preparation.

1. Connect the separate live account through the authenticated dashboard form,
   and configure its verified account number, live credentials and spending
   limits in `live-production`.
2. Validate the exact source, approve its full release SHA and configure the
   protected runtime encryption key. For the first dedicated empty account,
   explicitly configure `LIVE_RUNTIME_BOOTSTRAP=empty-account`.
3. Select `operation=preflight` and approve the environment review. This reads
   the actual live account and previews the strategy without placing orders or
   publishing an execution runtime.
4. An intentional later `operation=execute` requires the existing typed phrase
   and environment review. It runs exactly one guarded real-money cycle.

The public workflow reports fixed step outcomes. Detailed account/strategy
output and runtime state are available only as authenticated encrypted artifacts.
A failed preflight is not evidence that an execution occurred.

## In CI

`.github/workflows/live-production.yml` exists and is **manual-dispatch only**.

There is no `schedule:` block. Nothing fires on its own. It runs in a
`live-production` GitHub environment, so required reviewers gate the run, and it
asks the operator to type `TRADE REAL MONEY` before an execution step will
proceed. Adding a cron to that file is a decision to take knowingly.

Live runtime state uses its own artifact namespace,
`live-runtime-state-<sha>`. The paper workflow refuses to restore any artifact
not flagged `paper_only`; the live workflow refuses any artifact that is. The
two books can never restore each other's positions.

### Required repository configuration

In the `live-production` environment:

- **Secrets:** `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY`,
  `LIVE_TRADING_ACCOUNT_NUMBER`, `LIVE_RUNTIME_KEY`
- **Variables:** `PRODUCTION_RELEASE_SHA` (the approved full 40-character SHA),
  `LIVE_TRADING_ENABLED`,
  `LIVE_CAPITAL_BUDGET_USD`, `LIVE_MAX_ORDER_NOTIONAL_USD`,
  `LIVE_MAX_CYCLE_NOTIONAL_USD`
- **Protection:** at least one required reviewer and protected deployment branches

Store the account number as an environment secret so GitHub masks it before
printing each step's environment. A regular variable would expose the number
in the public runner log before the encrypted Python output capture starts.

On 2026-09-13 the `live-production` environment was created and verified with
DanilaAnikin as required reviewer and protected deployment branches only.
The live capability switch and explicit spending limits are configured.
The live account was subsequently connected through the authenticated dashboard.
That connection does not provision the separate workflow credentials or approve
an immutable live release. Verify those bindings again before any live preflight.
No real-money cycle has been dispatched by this setup. The capital budget is an
upper limit, not a required deposit; paper validation can continue without funding.

### First live state and private records

`LIVE_RUNTIME_BOOTSTRAP=empty-account` explicitly permits the first initialization
only when there is no earlier live execution/artifact and two fresh broker reads
confirm the bound live account has no positions or open orders and its initial
cash/equity does not exceed the configured capital budget. The initial
performance observation comes from that account; no historical paper seed is
reused and preflight does not create an execution record. An existing account
with positions requires a separately reviewed transition rather than this
bootstrap. This supports a dedicated trading account, not a separate portfolio
ledger inside a larger shared account. User-initiated deposits are separate
funding changes. Existing whole-share sizing is unchanged, so a small budget
can leave targets in cash when even one share exceeds the position allowance;
the canonical historical report is not a return forecast for that budget.

Subsequent restoration uses the latest authoritative live execution, including
failed or degraded attempts. Its exact release, account binding, archive members
and GitHub provenance must validate; missing or ambiguous evidence stops the
run. An existing live kill-switch marker survives runtime restoration.

This repository is public. Live runtime and diagnostic artifacts are encrypted
with AES-256-GCM using the separate `LIVE_RUNTIME_KEY` secret (64 hexadecimal
characters), with their purpose and approved release authenticated. GitHub login
alone is not a confidentiality boundary. Workflow console output contains only
fixed step status; raw strategy/account output goes into encrypted diagnostics.
Keep a protected copy of the encryption key for recovery; changing or losing it
makes earlier encrypted runtime unreadable. Preflight never uploads an execution
runtime or creates an execution incident.

## In the dashboard

The deployed dashboard already supports **Accounts → Add account → Live**.
Credentials are submitted through the authenticated account form, validated
against the live broker endpoint and stored in Vault. This adds an observer
account alongside paper; selecting it does not change the executor's account.

The current server has one production binding. Switching it to live would remove
the paper account's production panels. Simultaneous paper/live production panels
and decoding the encrypted live execution archive require a separate reader
integration; live account balances and positions already use the broker reader.

For a separately integrated live production view, set `PRODUCTION_ACCOUNT_MODE=live` alongside the existing `PRODUCTION_*`
variables, and point `PRODUCTION_ACCOUNT_ID` and
`PRODUCTION_ALPACA_ACCOUNT_NUMBER` at the live account.

The mode selects the GitHub environment, workflow, diagnostics name and runtime
artifact prefix together. The reader verifies the mode of the preflight and
execution records as well as their release identity. A live view cannot use
paper runtime state merely because both releases have the same SHA.

The mode is matched in **both** directions: a live account under a paper
declaration is refused, and so is a paper account under a live declaration. The
second direction matters as much as the first — showing a paper account under a
live executor would tell the reader real money is moving when it is not.

A bound live account is labelled `REAL-MONEY PRODUCTION ACCOUNT` in red, the
header badge reads `LIVE REAL MONEY` instead of `PAPER FORWARD VALIDATION`, and
the Operations execution-mode row reads from the runtime record rather than
asserting a constant.

## Before you use any of this

Check [the dated project status](PROJECT_STATUS.md) and the current canonical
report, rather than relying on a past PASS or FAIL in documentation. The
September 13 deployment serves dashboard `46b59b32` and approves paper executor
`4a90512a`; its paper plan and forward epoch remain unchanged. Preparing the
separate live environment does not promote or rebind that paper executor.

Release approval, the live account binding, finite spending ceilings and
environment protections must all be configured deliberately. Historical
validation and actual forward paper performance are separate evidence; a
passing test suite or backtest does not substitute for either release setup
or a measured forward period.
