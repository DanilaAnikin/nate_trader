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

## The six conditions for a live run

All of them, together. Any one missing refuses the run and names what is
missing; nothing has a default and nothing falls back to the paper values.

| Variable | Why it exists |
|---|---|
| `TRADING_MODE=live` | The word, in full. Anything unrecognised — including a typo like `Live!` — is a dry run, never a fallback to paper. |
| `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY` | Separate names from the paper pair. A misfiled paper key fails to authenticate instead of quietly trading the wrong book, and a live key can never be picked up by a paper run. Refused if identical to `ALPACA_API_KEY`. |
| `LIVE_TRADING_ENABLED` | A second, independent switch. Two variables have to be wrong at once for real money to move by accident. |
| `LIVE_TRADING_ACCOUNT_NUMBER` | The account this run may trade, declared out of band and checked against a fresh `GET /v2/account` before the first order. Credentials prove *an* account; only this proves *the* account. |
| `LIVE_MAX_ORDER_NOTIONAL_USD` | An absolute per-order dollar ceiling. |
| `LIVE_MAX_CYCLE_NOTIONAL_USD` | An absolute ceiling on everything one cycle may buy. |

### Why the two dollar ceilings are not optional

Every other limit in this repository is a percentage of equity —
`max_position_pct: 9`, `momentum_max_sector_pct: 40`, `min_cash_pct: 10`. A
percentage limit scales a mistake with the account: if the equity read is wrong
or the target weights are wrong, the limit is wrong by the same factor and
enforces nothing. A flat dollar ceiling does not participate in that
computation, which is the entire reason it is there.

Both ceilings must be finite positive numbers; `NaN` and infinity are refused.
They are enforced in `trade.place_limit_order`, the single function every order
in this repository passes through, so no caller can forget them.

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

## Running one cycle

```bash
# First configure every required variable from the table above in the executor
# environment. These checks do not change the approved production release.
# 1. Recompute evidence for the exact code and check its current eligibility.
python3 scripts/backtest/validate_v11.py
python3 scripts/sanity_check.py

# 2. Dry run. No orders, no state mutations, regardless of TRADING_MODE.
python3 scripts/execute_trades.py dry-run

# 3. Preflight only — reads the live account, places nothing.
TRADING_MODE=live python3 scripts/production_preflight.py

# 4. One real-money cycle.
TRADING_MODE=live python3 scripts/production_run.py
```

`sanity_check.py` prints `*** LIVE REAL MONEY ***` with the account number when
live is configured. `production_run.py` prints the same before it can place
anything, and records `broker_mode` and `paper_only: false` in
`state/production/last_run.json`.

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

- **Secrets:** `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY`
- **Variables:** `PRODUCTION_RELEASE_SHA` (the approved full 40-character SHA),
  `LIVE_TRADING_ENABLED`, `LIVE_TRADING_ACCOUNT_NUMBER`,
  `LIVE_MAX_ORDER_NOTIONAL_USD`, `LIVE_MAX_CYCLE_NOTIONAL_USD`
- **Protection:** at least one required reviewer and protected deployment branches

The workflow file cannot create these protections. On 2026-09-13, a read of
the GitHub repository environments found **no `live-production` environment**.
Live setup therefore remains incomplete even when all local tests pass. Create
and verify that environment before dispatching a real-money cycle.

## In the dashboard

Set `PRODUCTION_ACCOUNT_MODE=live` alongside the existing `PRODUCTION_*`
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
report, rather than relying on a past PASS or FAIL in documentation. On
2026-09-13, the approved paper release was `115f11fd7` and its September 11
execution and release gate had succeeded. The live environment was absent,
and the public dashboard still ran a frozen containment bridge.

Release approval, the live account binding, finite spending ceilings and
environment protections must all be configured deliberately. Historical
validation and actual forward paper performance are separate evidence; a
passing test suite or backtest does not substitute for either release setup
or a measured forward period.
