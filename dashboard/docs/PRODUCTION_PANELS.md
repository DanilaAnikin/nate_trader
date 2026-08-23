# Lighting up the production-runtime panels

Most panels on Overview, Signals & universe, Portfolio (frozen plan / targets) and
Operations show **NOT APPLICABLE** until the dashboard is told, server-side, that
the signed-in viewer is the production owner looking at the production executor
account. This is a deliberate security gate (`lib/status/authz.ts`): the frozen
plan, order intents, preflight, executor results and workflow operations describe
one central account and are never exposed on nickname or account-ownership alone.
Every condition is an AND — there is no OR path.

Nothing here changes the strategy. These are read-only viewer settings; the guarded
`V11 Paper Production` workflow remains the only thing that trades.

## 1. Data plumbing (required for any real data)

| Env var | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Public Supabase URL (inlined into the browser bundle at build). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Publishable anon key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only; service-role reads of `accounts` etc. **Secret.** |
| `GITHUB_TOKEN` | Reads the private Actions artifacts (runtime state, preflight, diagnostics). **Secret.** |
| `GITHUB_REPO` | `owner/repo` the paper workflow runs in. |
| `GITHUB_STATE_REF` | Ref the runtime artifacts/JSON are read at (usually `main`). |

## 2. Production-viewer gate (unlocks B/C, Signals, frozen plan, Operations)

All three must be set, and the signed-in user must match, viewing that account, in
paper mode, with the broker account number confirmed live from Alpaca:

| Env var | How to find it |
|---|---|
| `PRODUCTION_OWNER_USER_ID` | Supabase `auth.users.id` for the owner. `select id from auth.users where email = '<owner email>';` |
| `PRODUCTION_ACCOUNT_ID` | Supabase `accounts.id` of the account the executor trades. `select id, nickname, mode from accounts where owner_id = '<owner id>';` |
| `PRODUCTION_ALPACA_ACCOUNT_NUMBER` | The Alpaca **account number** (not the key) the executor trades — from Alpaca `GET /v2/account` (`account_number`). Read fresh from Alpaca and matched server-side; a value stored in Supabase is never trusted. |

`PRODUCTION_RELEASE_SHA` names the approved paper release the executor is pinned to.

Until these are set the dashboard shows the observer view: the broker account, the
account equity curve, holdings, backtest validation (V11 vs SPY) and the tournament
all still render, because those are account-scoped or repository facts — not the
central production runtime.

## 3. Forward performance vs SPY (panel E)

The live V11-versus-SPY equity comparison is measured only from a persisted,
auditable **epoch baseline**, so pre-V11 account history is never relabelled as V11
alpha. Provide it either as the `V11_EPOCH_BASELINE` env var (JSON) or as the repo
document read at `PRODUCTION_RELEASE_SHA`. The baseline must be genuine — it anchors
the official forward return — so establish it with real values, not placeholders:

```json
{
  "schemaVersion": 1,
  "strategyVersion": "v11-adaptive-momentum",
  "releaseSha": "<approved paper release SHA>",
  "accountId": "<PRODUCTION_ACCOUNT_ID>",
  "startedAt": "<ISO instant of the first V11 observation>",
  "startSessionDate": "<YYYY-MM-DD, America/New_York, same session>",
  "startingEquity": <equity at that session>,
  "benchmarkSymbol": "SPY",
  "benchmarkBaselineDate": "<YYYY-MM-DD, must equal startSessionDate>",
  "benchmarkBaselineClose": <SPY adjusted close that session>,
  "note": null
}
```

The parser (`lib/status/performance.ts` `parseEpochBaseline`) rejects anything whose
benchmark is not SPY or whose portfolio and benchmark anchors are not the same
session, so a malformed value fails closed rather than anchoring a wrong return.

## 4. Refreshing the validation evidence (F)

The canonical validator report expires after 35 days (bar-boundary bound). When it
reads **EXPIRED**, regenerate it with the documented promotion sequence
(`download_history.py` → `validate_v11.py` → `sanity_check.py`) and commit the
refreshed `state/backtest/v11_validation.json`. A PASS makes the unchanged code and
that exact ranking universe eligible for forward *paper* validation only — it is not
a claim of alpha and never authorizes live money.
