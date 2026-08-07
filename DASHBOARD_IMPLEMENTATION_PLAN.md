# Nate Trader — Multi-Account Platform & Dashboard Implementation Plan

> ## ⚠️ HISTORICAL DOCUMENT — SUPERSEDED, DO NOT IMPLEMENT
>
> **Status: archived on 2026-08-07. This is planning material, not current
> policy or an authority for any implementation.**
>
> This document was written when the ambition was an agent that trades *every*
> Supabase paper **and live** account. That directly contradicts the system as
> it exists today: the only supported executor is the guarded
> `V11 Paper Production` GitHub Actions workflow, it is hard-wired to a single
> Alpaca **paper** endpoint, and it is driven by an explicitly approved
> `PRODUCTION_RELEASE_SHA` — not by whichever account a browser session has
> selected. The dashboard is a **read-only** observability layer that cannot
> place, cancel or approve anything.
>
> Its multi-account trading-control assumptions must not be revived. Its
> authentication, RLS, Vault and data-model ideas were retained and are
> described in their current form in `OVERVIEW.md` and the dashboard section of
> `README.md`.
>
> Authoritative current documents:
> `OVERVIEW.md`, `CLAUDE.md`, `strategy/v11_adaptive_momentum.md`,
> `strategy/PRODUCTION_RUNBOOK.md`.

> **Document type:** Engineering implementation plan
> **Status:** Draft v1.0 — for review
> **Owner:** Danila Anikin
> **Last updated:** 2026-05-21
> **Companion document:** `DASHBOARD_SPECIFICATION.md` (the *what* and *why*)
> **This document:** the *how*, *in what order*, and *how we know it works*

---

## Table of Contents

1. [How to Use This Plan](#1-how-to-use-this-plan)
2. [Guiding Principles](#2-guiding-principles)
3. [Tech Stack & Dependencies](#3-tech-stack--dependencies)
4. [Phase Overview & Sequencing](#4-phase-overview--sequencing)
5. [Phase 0 — Supabase Foundations](#5-phase-0--supabase-foundations)
6. [Phase 1 — Database Schema & Migrations](#6-phase-1--database-schema--migrations)
7. [Phase 2 — Credential Vault & Accounts Backend](#7-phase-2--credential-vault--accounts-backend)
8. [Phase 3 — Authentication & Dashboard Shell](#8-phase-3--authentication--dashboard-shell)
9. [Phase 4 — Accounts Management UI & Account Switcher](#9-phase-4--accounts-management-ui--account-switcher)
10. [Phase 5 — Equity Snapshots Pipeline (the chart fix)](#10-phase-5--equity-snapshots-pipeline-the-chart-fix)
11. [Phase 6 — Python Agent Multi-Account Refactor](#11-phase-6--python-agent-multi-account-refactor)
12. [Phase 7 — Dashboard Data Migration (all screens)](#12-phase-7--dashboard-data-migration-all-screens)
13. [Phase 8 — Backtest Screen Fix](#13-phase-8--backtest-screen-fix)
14. [Phase 9 — Cleanup, Hardening & Cutover](#14-phase-9--cleanup-hardening--cutover)
15. [Testing Strategy](#15-testing-strategy)
16. [Security Checklist](#16-security-checklist)
17. [Deployment & Rollout](#17-deployment--rollout)
18. [Cutover Runbook](#18-cutover-runbook)
19. [GitHub Issues Mapping](#19-github-issues-mapping)
20. [Effort Estimates & Critical Path](#20-effort-estimates--critical-path)
21. [Appendix A — Migration File Layout](#appendix-a--migration-file-layout)
22. [Appendix B — Code Templates](#appendix-b--code-templates)
23. [Appendix C — Rollback Playbook](#appendix-c--rollback-playbook)

---

## 1. How to Use This Plan

This plan is the execution counterpart to `DASHBOARD_SPECIFICATION.md`. Read the
specification first — it defines the target system, the data model, and every
defect (`DEF-xx`) and requirement (`FR-xx`, `NFR-xx`) referenced here.

- Work is divided into **10 phases (0–9)**. Phases are mostly sequential;
  §4 lists where parallel work is safe.
- Each phase has: **objective**, **prerequisites**, a numbered **task list**
  (`T<phase>.<n>`), **deliverables**, **acceptance criteria**, a **test plan**,
  and a **rollback** note.
- Tasks reference exact file paths. Code blocks are *sketches* — enough to be
  unambiguous, not necessarily complete.
- Every task that touches trading/strategy/risk code follows the repo's GitHub
  collaboration rules in `CLAUDE.md` (issue → labels → `Refs #N` → project
  board → closing comment).
- **Nothing destructive happens until §18 cutover.** Dual-write and feature
  flags keep the live agent safe throughout.

### 1.1 Branching note

The repo's `CLAUDE.md` mandates committing routine work directly to `main`.
This project is **not routine** — it is a large, multi-phase feature. The
implementer should confirm with the owner whether to (a) develop on the
designated feature branch and merge per phase, or (b) commit phase-by-phase to
`main` behind feature flags. This plan assumes **(a) a feature branch per
phase, merged when the phase's acceptance criteria pass**, because the agent
must keep trading safely on `main` during the months-long migration.

---

## 2. Guiding Principles

1. **The agent never stops trading.** Every phase is shippable; the live system
   keeps running. Dual-write before switch-over.
2. **One source of truth.** After migration, each datum lives in exactly one
   place. No constant is duplicated between `strategy_config.py` and TSX.
3. **Keys are sacred.** No phase ever puts a decrypted Alpaca key in a browser
   bundle, a log line, a git commit, or a client-readable table.
4. **Verify before delete.** Legacy code/data is removed only after the
   replacement is proven in production (§18).
5. **Small, reviewable steps.** Each task is independently testable. Prefer a
   working slice over a big-bang.
6. **Account isolation.** Multi-account means *independent* — risk, state, and
   failures never cross account boundaries.
7. **Fix the chart early.** Phase 5 makes the equity curve correct *before* the
   big agent refactor, so the user sees value fast.

---

## 3. Tech Stack & Dependencies

### 3.1 New dependencies — dashboard (`dashboard/package.json`)

```jsonc
{
  "dependencies": {
    "@supabase/supabase-js": "^2.x",   // Supabase client
    "@supabase/ssr": "^0.x"            // cookie-based auth for Next.js App Router
  }
}
```

Removed once migration completes: nothing from `package.json` (the GitHub
fetch used the built-in `fetch`); `recharts`, `next`, `react` stay.

### 3.2 New dependencies — agent (`requirements.txt`)

```
supabase>=2.4        # Supabase Python client (Postgres + Storage + RPC)
```

`python-dotenv` stays. `alpaca-py` stays. No removals.

### 3.3 Supabase project

- One Supabase project (free tier is sufficient — see NFR-COST-1).
- Postgres 15, Auth, Vault extension, Storage.
- A `dev` and a `prod` project are *recommended* but the owner may run a
  single project; this plan supports either (Appendix A).

### 3.4 Environment matrix

See `DASHBOARD_SPECIFICATION.md` Appendix A. Summary:

- **Vercel:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` (server only).
- **GitHub Actions:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `PERPLEXITY_API_KEY`, `CLICKUP_API_KEY`, `CLICKUP_LIST_ID`.

---

## 4. Phase Overview & Sequencing

| Phase | Name | Depends on | Can parallelize with | Outcome |
|-------|------|-----------|----------------------|---------|
| 0 | Supabase foundations | — | — | Project, Auth, Vault, Storage ready. |
| 1 | Schema & migrations | 0 | — | All tables, RLS, functions live. |
| 2 | Credential vault & accounts backend | 1 | 3 | Accounts can be created/validated server-side. |
| 3 | Auth & dashboard shell | 1 | 2 | Login works; all routes protected. |
| 4 | Accounts UI & switcher | 2, 3 | 5 | User can add/switch accounts in the UI. |
| 5 | Equity snapshots pipeline | 1, 2 | 4 | **Equity chart becomes correct.** |
| 6 | Python agent multi-account refactor | 1, 2 | 7 | Agent trades every account from Supabase. |
| 7 | Dashboard data migration | 4, 5 | 6, 8 | All screens read Supabase, account-scoped. |
| 8 | Backtest screen fix | 1 | 6, 7 | `/backtest` reliable for any payload size. |
| 9 | Cleanup, hardening & cutover | all | — | Legacy removed; keys off git/env; done. |

**Critical path:** 0 → 1 → 2 → 5 → 7 → 9. Phases 3, 6, 8 hang off it and can
run in parallel by a second contributor.

**Quick-win path:** 0 → 1 → 2 → 5 delivers the *correct equity chart* (the
user's #1 ask) for the existing account before the heavy agent refactor.

---

## 5. Phase 0 — Supabase Foundations

**Objective:** Stand up the Supabase project and its core services so later
phases have a place to build. No application behavior changes.

**Prerequisites:** A Supabase account/organization.

### Tasks

- **T0.1** Create the Supabase project (region close to Vercel's). Record the
  project ref, URL, anon key, and service-role key in a secure password store.
- **T0.2** Enable the **Vault** extension (Database → Extensions →
  `supabase_vault`). Confirm `vault.create_secret` / `vault.decrypted_secrets`
  are available.
- **T0.3** Create Storage buckets `backtest-results` and `research-snapshots`.
  Set both to **private** (no public access). Add a Storage policy: read for
  `authenticated`, write for `service_role` only.
- **T0.4** Configure **Auth**: enable Email provider; disable public sign-ups
  *after* the owner account is created (T3.x); set the site URL + redirect URLs
  to the Vercel domain and `localhost:3000`.
- **T0.5** Create the owner's user (via Auth dashboard or a one-off sign-up).
- **T0.6** Set up local tooling: install the Supabase CLI; `supabase init` and
  `supabase link` the repo's new `supabase/` directory so migrations are
  version-controlled.
- **T0.7** Add `SUPABASE_*` placeholders to `.env.example` and document them in
  `README.md`.

### Deliverables

- A reachable Supabase project; Vault + Storage + Auth configured;
  `supabase/` migration directory committed.

### Acceptance criteria

- `supabase db ping` succeeds; the Vault and both Storage buckets exist; the
  owner can sign in via the Supabase Auth UI.

### Test plan

- Manual: create a test secret with `vault.create_secret('x')`, read it back
  via `vault.decrypted_secrets`, delete it.
- Manual: upload and download a dummy object to each bucket.

### Rollback

- Phase 0 creates only external infrastructure; "rollback" = delete the
  Supabase project. No repo changes are load-bearing yet.

---

## 6. Phase 1 — Database Schema & Migrations

**Objective:** Create every table, enum, index, RLS policy, and function from
`DASHBOARD_SPECIFICATION.md` §13.

**Prerequisites:** Phase 0.

### Tasks

- **T1.1** Migration `0001_enums.sql` — all enums (§13.1) plus
  `trade_side_position as enum ('long','short')`.
- **T1.2** Migration `0002_profiles_accounts.sql` — `profiles`, `accounts`, the
  `profiles.default_account_id` FK, and their RLS policies (§13.2–13.3).
- **T1.3** Migration `0003_helpers.sql` — `owns_account(uuid)` (§13.15) and
  `get_account_credentials(uuid)` (§13.16). Verify `get_account_credentials`
  is **revoked** from `anon`/`authenticated`.
- **T1.4** Migration `0004_account_state.sql` — `equity_snapshots`,
  `performance`, `positions`, `trades`, `cash_flows`, `routine_runs` with
  indexes + RLS (§13.4–13.9).
- **T1.5** Migration `0005_shared.sql` — `strategy_params`, `market_history`,
  `research_snapshots`, `screener_snapshots`, `backtest_runs`, `audit_log`
  with RLS (§13.10–13.14).
- **T1.6** Migration `0006_storage_policies.sql` — Storage RLS for the two
  buckets (read: authenticated; write: service role).
- **T1.7** Generate TypeScript types: `supabase gen types typescript` →
  `dashboard/lib/database.types.ts`.
- **T1.8** Write an **RLS test script** (`supabase/tests/rls.test.sql` or a
  Python/TS harness) proving: (a) an authed user reads only their accounts'
  rows; (b) `anon` cannot read `accounts`; (c) `get_account_credentials` is
  not callable by `authenticated`.

### Deliverables

- `supabase/migrations/0001…0006_*.sql`, `database.types.ts`, RLS tests.

### Acceptance criteria

- `supabase db reset` applies all migrations cleanly from scratch.
- The RLS test script passes every assertion.
- `database.types.ts` compiles and exports every table type.

### Test plan

- `supabase db reset` in CI.
- RLS harness: create two test users, two accounts, assert isolation.
- Insert a sample `equity_snapshots` row and read it back under the owning
  user; confirm a different user gets zero rows.

### Rollback

- Migrations are additive and version-controlled; `supabase db reset` returns
  to any prior migration. No production data exists yet.

---

## 7. Phase 2 — Credential Vault & Accounts Backend

**Objective:** Server-side ability to create, validate, store, rotate, and
delete accounts and their encrypted Alpaca credentials. No UI yet.

**Prerequisites:** Phase 1.

### Tasks

- **T2.1** Add `@supabase/supabase-js` + `@supabase/ssr` to the dashboard.
- **T2.2** Create `dashboard/lib/supabase/server.ts` — a server-side client
  factory (anon key, cookie-bound) and `dashboard/lib/supabase/service.ts` — a
  **service-role** client factory (server-only; throws if imported client-side).
- **T2.3** Implement `dashboard/lib/accounts/credentials.ts`:
  - `validateAlpacaKeys(mode, key, secret)` — calls Alpaca `GET /v2/account`
    against the correct base URL; returns `{ ok, accountNumber }` or a typed
    error.
  - `storeCredentials(key, secret)` — writes both to Vault via
    `vault.create_secret`, returns the two secret UUIDs.
  - `purgeCredentials(keyId, secretId)` — deletes the Vault secrets.
- **T2.4** Implement the accounts service `dashboard/lib/accounts/service.ts`:
  `listAccounts(userId)`, `createAccount(...)`, `updateAccount(...)`,
  `rotateKeys(...)`, `deleteAccount(...)`. `createAccount` orchestrates
  validate → store in Vault → insert `accounts` row → write `audit_log`.
- **T2.5** Implement route handlers `app/api/accounts/route.ts` (GET, POST),
  `app/api/accounts/[id]/route.ts` (PATCH, DELETE),
  `app/api/accounts/[id]/verify/route.ts` (POST). All enforce session +
  ownership; **none** ever return key material.
- **T2.6** Implement `app/api/accounts/[id]/live/route.ts` — the multi-account
  replacement for `/api/live` (spec §15.2): decrypt via
  `get_account_credentials`, pick base URL from `mode`, call Alpaca, normalize,
  return. On 401/403 set `accounts.status='auth_failed'`.
- **T2.7** Unit-test the credential layer with a mocked Alpaca; assert keys are
  never present in any response body or log.

### Deliverables

- Supabase client factories, credential + accounts services, accounts API
  routes.

### Acceptance criteria

- A `POST /api/accounts` with valid keys creates an account, stores secrets in
  Vault, and the response contains **no key material**.
- A `POST` with invalid keys returns a 4xx and stores nothing.
- `GET /api/accounts/[id]/live` returns live Alpaca data for paper and live
  accounts using the correct base URL.
- `get_account_credentials` is callable only by the service role.

### Test plan

- Integration: create a paper account with the existing real paper keys →
  verify Vault holds two secrets and `/live` returns the ≈$973k equity.
- Negative: garbage keys → rejected, Vault untouched.
- Security: grep all responses + server logs for the key prefix → absent.

### Rollback

- Feature lives behind unreleased routes; delete the route files. Vault
  secrets created during testing are purged with `purgeCredentials`.

---

## 8. Phase 3 — Authentication & Dashboard Shell

**Objective:** Put the entire dashboard behind Supabase Auth. Build the login
screen, middleware, and the authenticated layout shell. (Parallelizable with
Phase 2.)

**Prerequisites:** Phase 1.

### Tasks

- **T3.1** `dashboard/lib/supabase/client.ts` — browser client factory.
- **T3.2** `dashboard/middleware.ts` — refresh the session on every request;
  redirect unauthenticated users to `/login`; allow `/login` + static assets
  only. Set security headers here or in `next.config.ts` (NFR-SEC-3): CSP,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  HSTS.
- **T3.3** `app/login/page.tsx` — email/password sign-in form; typed errors;
  no user enumeration; redirect on success.
- **T3.4** `app/auth/callback/route.ts` — handle the Supabase auth code
  exchange (for email confirm / future OAuth).
- **T3.5** Rework `app/layout.tsx` — read the session server-side; if absent
  redirect to `/login`; render the authenticated shell (sidebar + content).
- **T3.6** Add a logout server action and a logout control in the sidebar
  footer (replacing the static dot, finalized in Phase 4/7).
- **T3.7** Ensure a `profiles` row is created on first login (DB trigger on
  `auth.users` insert, or lazy upsert in the layout).
- **T3.8** Add `/settings` (`app/settings/page.tsx`) — display name, change
  password, default account (default account wired in Phase 4).

### Deliverables

- Auth middleware, login screen, protected layout, settings screen.

### Acceptance criteria (FR-AUTH-1…5)

- Visiting any route while logged out → `/login`.
- Valid credentials → authenticated; invalid → clear error, no enumeration.
- Logout ends the session and returns to `/login`.
- Security headers present on every response (verify with `curl -I`).

### Test plan

- Manual: logged-out access to `/`, `/positions`, `/backtest` → all redirect.
- Manual: login, refresh, deep-link — session persists across server
  components and route handlers.
- E2E (Playwright): login → land on dashboard → logout → blocked.

### Rollback

- Revert `layout.tsx` + delete `middleware.ts` to restore public access.
  Phases 2–3 are independent, so this does not affect the accounts backend.

---

## 9. Phase 4 — Accounts Management UI & Account Switcher

**Objective:** Let the user add, edit, pause, delete, and switch accounts from
the UI. (Parallelizable with Phase 5.)

**Prerequisites:** Phases 2 and 3.

### Tasks

- **T4.1** Account-context plumbing: `dashboard/lib/account-context.ts` —
  resolve the selected account from the `nt_account` httpOnly cookie (fallback:
  `profiles.default_account_id`, then the first account). A server helper
  `getSelectedAccount()` validates ownership on every request.
- **T4.2** `app/accounts/page.tsx` — list accounts (nickname, mode badge,
  status, equity, last-synced, `is_active` toggle). (FR-ACC-1)
- **T4.3** `components/AddAccountDialog.tsx` — form (nickname, mode, key,
  secret, color); calls `POST /api/accounts`; inline validation errors; the
  live-mode "real money" confirmation checkbox (FR-ACC-2/3/4).
- **T4.4** Edit/rotate/delete UI — `components/EditAccountDialog.tsx`:
  nickname/color edit, `is_active` toggle, key rotation (re-validates), delete
  with the keep-or-purge-history choice (FR-ACC-6/7).
- **T4.5** `components/AccountSwitcher.tsx` — sidebar-header dropdown: lists
  active accounts with mode badge + equity; "＋ Add account"; "Manage
  accounts". Switching writes the `nt_account` cookie and refreshes
  (FR-ACS-1…5).
- **T4.6** Rework `components/Sidebar.tsx` — embed the switcher; add a
  `/accounts` nav entry; logout in the footer.
- **T4.7** Empty states: zero accounts → every account-scoped screen points to
  the add flow (FR-ACS-4).
- **T4.8** Wire `/settings` default-account selection to `profiles`.
- **T4.9** "Test connection" action on each account → `POST
  /api/accounts/[id]/verify` (FR-ACC-9).
- **T4.10** Make `live` accounts visually unmistakable — badge color, icon,
  and a subtle top-border accent on the dashboard when a live account is
  selected.

### Deliverables

- `/accounts` screen, add/edit dialogs, sidebar account switcher, account
  context helper.

### Acceptance criteria (FR-ACC-*, FR-ACS-*)

- The user can add a paper and a live account; invalid keys are rejected
  inline; live-add requires the confirmation checkbox.
- Switching accounts in the sidebar re-scopes the whole dashboard.
- Keys are shown only masked; the secret never reappears after creation.
- Pausing an account (`is_active=false`) keeps it viewable but, per Phase 6,
  excludes it from agent trading.

### Test plan

- Manual: add the existing paper account; add a second (test) paper account;
  switch between them; confirm equity differs.
- Manual: rotate keys with a bad pair → rejected, old keys still work.
- Manual: delete a test account → Vault secrets purged (verify in DB),
  `audit_log` row written.
- E2E: full add → switch → edit → delete journey.

### Rollback

- UI-only; delete the new components/routes. The accounts backend (Phase 2)
  remains usable via API.

---

## 10. Phase 5 — Equity Snapshots Pipeline (the chart fix)

**Objective:** Make the equity curve **correct**. Build the backfill + daily
snapshot pipeline from Alpaca Portfolio History and the cash-flow-adjusted
return math. This is the user's #1 priority — schedule it early.
(Parallelizable with Phase 4.)

**Prerequisites:** Phases 1 and 2 (needs the schema and credential access).

### Tasks

- **T5.1** `scripts/equity_sync.py` — given an `AccountContext` (Phase 6
  introduces the full class; for Phase 5 a minimal account+keys struct
  suffices):
  - `backfill_equity(account)` — calls Alpaca
    `GET /v2/account/portfolio/history?period=all&timeframe=1D`, maps each
    `(timestamp, equity, profit_loss, profit_loss_pct)` to an `equity_snapshots`
    upsert.
  - `sync_today(account)` — pulls the latest `1D` point and upserts today's
    snapshot.
  - `sync_cash_flows(account)` — pulls Alpaca `GET /v2/account/activities`
    (`CSD`/`CSW` and transfer types) into `cash_flows`.
- **T5.2** Backfill on account creation: the `createAccount` flow (T2.4)
  enqueues/triggers `backfill_equity` for the new account (FR-ACC-5). For the
  dashboard side, this can be a `POST /api/accounts/[id]/backfill` route the
  Add flow calls, or a Supabase Edge Function. (Decision: a route handler that
  shells the same logic in TS, or marks the account for the next agent run to
  backfill. Recommended: a TS implementation in
  `lib/accounts/equity-backfill.ts` so the UI gets instant history.)
- **T5.3** `lib/returns.ts` (dashboard) + `scripts/returns.py` (agent) — the
  shared **TWR** math (spec §12.3): daily return, period TWR chaining,
  cash-flow exclusion, alpha vs. SPY over an identical window.
- **T5.4** `app/api/accounts/[id]/equity/route.ts` — returns the
  `equity_snapshots` slice for a `?range=` plus the live "today" point.
- **T5.5** `update_spy_history.py` rework — also write `market_history`
  (`symbol='SPY'`); `app/api/market/spy/route.ts` serves it.
- **T5.6** Rewrite `components/EquityChart.tsx` and
  `components/HistoricalComparisonChart.tsx` to consume `equity_snapshots` +
  `market_history` instead of `daily_history`. The rebasing/anchor logic in
  `HistoricalComparisonChart` is sound and is **kept** — only the data source
  and the by-date (not by-index) slicing change.
- **T5.7** Compute `performance.{weekly,monthly,ytd,all_time}_twr_pct` from
  snapshots and store them on the `performance` row.
- **T5.8** One-time: run `backfill_equity` for the **existing paper account**
  so the chart is correct retroactively from day one.

### Deliverables

- `equity_sync.py`, return-math modules, equity + SPY API routes, rewritten
  chart components, a populated `equity_snapshots` for the live account.

### Acceptance criteria (FR-DSH-3/4, DEF-01/16)

- The dashboard equity curve **matches Alpaca's Portfolio History** for the
  selected account (spot-check 5 dates).
- The curve is **not flat** — it reflects real daily equity, retroactively.
- Period returns are cash-flow-adjusted TWR; alpha vs. SPY is computed over the
  exact selected window.
- Range filters slice by date, not array index (DEF-10 gone).

### Test plan

- Cross-check: export Alpaca Portfolio History for the paper account; diff
  against `equity_snapshots` — equity values match to the cent.
- Synthetic: insert a deposit `cash_flow` and confirm the period return
  excludes it (a $10k deposit must not show as +10k profit).
- Visual: load the chart for 1W/1M/YTD/ALL — each range anchors correctly and
  the SPY overlay rebases to the portfolio anchor.

### Rollback

- The chart components can fall back to the old `daily_history` source behind a
  flag until `equity_snapshots` is verified. Once verified, remove the flag and
  the `daily_history` field (Phase 9).

---

## 11. Phase 6 — Python Agent Multi-Account Refactor

**Objective:** Make the autonomous agent trade **every active account** from
Supabase, with full per-account isolation. (Parallelizable with Phases 7–8.)

**Prerequisites:** Phases 1 and 2.

### 11.1 Strategy

Refactor in **dual-write mode**: the agent reads accounts from Supabase and
writes per-account snapshots to Supabase, while *optionally* still writing the
legacy `state/*.json` for the one original account behind a
`LEGACY_STATE_WRITE` flag — so a rollback is always one flag away until §18.

### Tasks

- **T6.1** `scripts/supabase_client.py` — a service-role Supabase client +
  typed helpers: `get_active_accounts()`, `get_account_credentials(id)` (calls
  the RPC), `upsert_equity_snapshot`, `upsert_performance`,
  `replace_positions`, `insert_trades`, `upsert_strategy_params`,
  `insert_routine_run`, `upsert_research_snapshot`, `upsert_screener_snapshot`,
  `upsert_market_history`.
- **T6.2** `scripts/accounts.py` — the `AccountContext` class (spec §16.1):
  holds `account_id`, `mode`, `nickname`, a constructed `TradingClient`
  (`paper=(mode=='paper')`) and the Alpaca data client. A factory
  `iter_account_contexts()` yields one per active account.
- **T6.3** Rework `scripts/utils.py` — remove the module-level
  `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` constants and the implicit single
  account. Add `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` config. Keep path
  helpers, logging, journal helpers.
- **T6.4** Rework `scripts/portfolio.py` — every function takes an
  `AccountContext`. `get_account`/`get_positions`/`get_open_orders` use
  `ctx.client`. `update_performance_state` becomes
  `write_performance(ctx)` → upserts the `performance` row and an
  `equity_snapshots` row (via the Phase 5 sync). **Drop `daily_history`.**
  Normalize `side` to lowercase `long`/`short` (DEF-09).
- **T6.5** Rework `scripts/trade.py` and `scripts/execute_trades.py` — accept
  an `AccountContext`; build limit orders against `ctx.client`; record every
  fill into the `trades` table; resolve risk tier from the account's
  `performance` row.
- **T6.6** Rework risk-tier logic — per account. `get_risk_tier(account_id)` /
  `set_risk_tier(account_id, tier)` read/write `performance`. The daily-loss
  halt and CAUTIOUS/HALT escalation are evaluated per account.
- **T6.7** Per-account `strategy_metadata` (per-symbol entry strategy/date) —
  move into a column/table keyed by `account_id`.
- **T6.8** Account-agnostic scripts (`research.py`, `screener.py`,
  `perplexity_research.py`, `update_spy_history.py`) — run **once per cycle**;
  write `research_snapshots`/`screener_snapshots` (+ Storage payload) and
  `market_history`. They do **not** loop over accounts.
- **T6.9** `strategy_config.py` — add `export_strategy_params()` that dumps the
  resolved regime/risk params; a small wrapper writes them to
  `strategy_params` after each research run (fixes DEF-08 at the source).
- **T6.10** Routine orchestration — introduce `scripts/run_routine.py` (or
  adapt each routine entry point): for trading routines,
  `for ctx in iter_account_contexts(): try: run(ctx) except: log+continue`;
  wrap each in a `routine_runs` record (kind, account, status, duration,
  summary, GitHub run URL).
- **T6.11** Per-account journals — `journal/<account_slug>/YYYY-MM-DD.md`;
  `write_journal.py` takes the account context.
- **T6.12** Rework `.github/workflows/*.yml` — swap Alpaca secrets for
  Supabase secrets; since account state now lives in Supabase, **simplify the
  commit step** to only commit `journal/**` (and code), dropping the
  `state/*.json` rebase dance. Keep the backtest workflow's git commit for the
  engine's own files (Phase 8 adds the Storage upload).
- **T6.13** Update `CLAUDE.md` — document the multi-account agent, the Supabase
  data layer, the new secrets, and the simplified git workflow.

### Deliverables

- `supabase_client.py`, `accounts.py`, reworked `portfolio.py`,
  `execute_trades.py`, `trade.py`, `utils.py`, account-agnostic scripts,
  reworked workflows, updated `CLAUDE.md`.

### Acceptance criteria (PY-1…16, NFR-REL-1/2)

- A trading routine, run with two active accounts, trades both independently
  and writes two sets of per-account snapshots.
- Forcing an exception for account A still lets account B complete; both
  outcomes appear in `routine_runs`.
- A `HALT` on account A does not change account B's behavior.
- The backtest still runs and produces identical numbers (engine untouched).
- No Alpaca key appears in any log line.

### Test plan

- Dry-run: `execute_trades.py dry-run` per account against Supabase-sourced
  keys — orders computed, none placed.
- Two-account integration on **paper only**: a real second paper account;
  confirm isolated positions, performance, risk tiers.
- Fault injection: revoke account A's keys mid-run → A logged `failed`, B
  `success`.
- Regression: run a `single` backtest before and after — byte-identical
  metrics.

### Rollback

- The `LEGACY_STATE_WRITE` flag restores single-account `state/*.json` writes.
- Workflows are version-controlled; revert the `.yml` changes to fall back to
  the Alpaca-secret path (keys remain in GitHub Secrets until §18).

---

## 12. Phase 7 — Dashboard Data Migration (all screens)

**Objective:** Switch every dashboard screen from the GitHub Contents API to
Supabase, scoped to the selected account. (Parallelizable with Phases 6, 8.)

**Prerequisites:** Phases 4 and 5.

### Tasks

- **T7.1** Rewrite `dashboard/lib/types.ts` around the Supabase schema (spec
  §15.5); re-export generated `database.types.ts` where useful.
- **T7.2** Data-access layer `dashboard/lib/data/*.ts` — typed Supabase
  queries: `getPerformance(accountId)`, `getEquitySeries(accountId, range)`,
  `getPositions(accountId)`, `getTrades(accountId, page)`,
  `getStrategyParams()`, `getLatestResearch()`, `getLatestScreener()`,
  `getSpyHistory(from,to)`.
- **T7.3** Rework `/` (`page.tsx` + `DashboardClient.tsx`):
  - Account-scoped data from Supabase; live upgrade via
    `/api/accounts/[id]/live`.
  - Equity chart from Phase 5 components.
  - Rules-compliance + allocation panels driven by `getStrategyParams()` —
    **delete the hard-coded `limitsByRegime` map** (DEF-08).
  - Add the recent-trades panel (FR-DSH-7) and the system-health indicator
    from `routine_runs` (FR-DSH-8).
- **T7.4** Rework `/positions` — Supabase + live upgrade; normalized `side`;
  rules from `strategy_params`; sector-exposure breakdown (FR-POS-*).
- **T7.5** New `/trades` screen (`app/trades/page.tsx` + components) — realized
  trade log + win-rate/profit-factor summary (FR-TRD-*).
- **T7.6** Rework `/research` — read `research_snapshots` + Storage payload
  (FR-RES-*); UI layout unchanged; fixes DEF-02.
- **T7.7** Rework `/screener` — read `screener_snapshots`; "Above Buy"
  threshold from `strategy_params.score_threshold` (DEF-08).
- **T7.8** Delete dead routes: `/api/data`, `/api/symbol-bars`,
  `/api/alpha-tracker`, `/api/spy-history`, the old `/api/live`. Delete
  `lib/github.ts` once nothing imports it.
- **T7.9** Rework `RefreshButton` — re-pull live data for the *selected*
  account; keep the `dashboard:live` event pattern but account-scoped.
- **T7.10** Empty/stale states everywhere — no account, no data yet, Alpaca
  unreachable (show last snapshot + "stale" marker, NFR-REL-3).

### Deliverables

- Supabase data layer, reworked `/`, `/positions`, `/research`, `/screener`,
  new `/trades`, dead routes removed.

### Acceptance criteria (FR-DSH-*, FR-POS-*, FR-RES-*, FR-SCR-*, FR-TRD-*)

- Every screen renders from Supabase, scoped to the selected account where
  applicable; switching accounts changes the data.
- `/research` loads reliably (DEF-02 gone).
- The rules panels match `strategy_config.py` exactly (DEF-08 gone).
- No screen calls `api.github.com`.

### Test plan

- Manual: every screen, for each of two accounts; switch and re-verify.
- Network audit: dev-tools → confirm zero requests to `api.github.com`.
- Compare: the dashboard's regime limits vs. a printed
  `get_strategy_params()` dump — identical.
- E2E: login → dashboard → positions → trades → research → screener.

### Rollback

- Screens migrate one at a time; each can revert to the GitHub-backed version
  independently until verified. `lib/github.ts` is deleted only after all
  screens are off it.

---

## 13. Phase 8 — Backtest Screen Fix

**Objective:** Make `/backtest` and run-detail pages reliable for payloads of
any size. (Parallelizable with Phases 6, 7.)

**Prerequisites:** Phase 1.

### Tasks

- **T8.1** `scripts/backtest/run.py` — after writing `state/backtest/*.json`,
  upload the full payload to Storage bucket `backtest-results` as
  `{run_id}.json` and upsert a `backtest_runs` row (`kind`, `generated_at`,
  dates, `summary`, `storage_path`). Reuse `manifest.py`'s summary extraction.
- **T8.2** Backfill — a one-off script uploads the **current** valid backtest
  files (`latest_result`, `walk_forward_result`, `sweep_result`,
  `monte_carlo_result`, `comparison_result`) and all `runs/*.json` from the
  manifest into Storage + `backtest_runs`.
- **T8.3** Rework `app/api/backtest/runs/route.ts` — read `backtest_runs` from
  Postgres (fast index; no size limit).
- **T8.4** Rework `app/api/backtest/runs/[id]/route.ts` and
  `app/api/backtest/route.ts` — fetch the payload from Storage by
  `storage_path`. Storage has **no 1 MB ceiling** (DEF-03 fixed).
- **T8.5** Rework `app/backtest/page.tsx` + `app/backtest/runs/[id]/page.tsx` —
  consume the new endpoints. The visual components (`BacktestEquityChart`,
  `BacktestComparisonChart`, `PerTradeChart`, `RunHistoryTable`) keep their
  current props — only the fetch source changes (`lib/backtest-types.ts`
  unchanged).
- **T8.6** `.github/workflows/backtest.yml` — add the Supabase upload step;
  keep the existing git commit of engine files for now.
- **T8.7** (Optional, FR-BKT-6) A "Run backtest" button → a route handler that
  triggers the GitHub `Backtest` workflow via
  `POST /repos/{repo}/actions/workflows/backtest.yml/dispatches`.

### Deliverables

- Supabase-backed backtest endpoints, Storage upload in the engine + workflow,
  reworked `/backtest` pages, backfilled history.

### Acceptance criteria (FR-BKT-1…5, DEF-03)

- `/backtest` loads reliably; the run list comes from Postgres.
- Run-detail pages open for **every** archived run, including the ≈1.45 MB
  ones that previously 404'd.
- A fresh backtest workflow run appears in the dashboard without any GitHub
  Contents API call.

### Test plan

- Open the 5 largest historical run files via `/backtest/runs/[id]` →
  all render.
- Trigger a `single` backtest → confirm the Storage object + `backtest_runs`
  row appear and the dashboard shows it.
- Confirm the run-detail page makes zero `api.github.com` calls.

### Rollback

- Keep the old GitHub-backed backtest routes behind a flag until the Supabase
  path is verified; the engine's git commit is unchanged so no data is lost.

---

## 14. Phase 9 — Cleanup, Hardening & Cutover

**Objective:** Remove legacy code/data, finalize security, and complete the
cutover. **This is the only phase with destructive steps** — gated on every
prior phase being verified in production.

**Prerequisites:** Phases 0–8, each verified in production for ≥ 1 full
trading week (NFR / spec §19.2).

### Tasks

- **T9.1** Remove the `daily_history` field from the performance model and any
  remaining reader (DEF-01 follow-through).
- **T9.2** Delete dead dashboard code: `lib/github.ts`, `/api/data`,
  `/api/symbol-bars`, `/api/alpha-tracker`, `/api/spy-history`, the old
  `/api/live` (DEF-12) — if not already deleted in Phase 7.
- **T9.3** Archive + delete legacy backtest files `state/backtest/v3_*.json`,
  `v4_*`, `v5_*` (DEF-11). Keep one tagged archive commit for provenance.
- **T9.4** Prune `state/backtest/runs/` — once payloads are in Storage, the
  repo copies can be thinned (keep the manifest + recent runs, or stop
  committing new ones).
- **T9.5** Turn off `LEGACY_STATE_WRITE` (Phase 6); stop committing
  `state/*.json` for account data (Decision D8 — revisit Q3 with the owner).
- **T9.6** **Remove Alpaca keys** from GitHub Actions Secrets and Vercel env
  (DEF-06) — they now live only in Vault. Remove `GITHUB_TOKEN`/`GITHUB_REPO`
  from Vercel (dashboard no longer reads GitHub).
- **T9.7** Security hardening pass: re-verify CSP/headers (NFR-SEC-3); run the
  RLS test suite against production; grep the built client bundle for any key
  prefix or the service-role key (must be absent).
- **T9.8** Disable public Auth sign-ups (Decision D2) once the owner account
  exists.
- **T9.9** Performance pass: verify the equity-curve and screen queries meet
  NFR-PERF-1/2; add missing indexes if any query is slow.
- **T9.10** Documentation: update `README.md` (architecture diagram, dashboard
  section, env vars), `CLAUDE.md` (already touched in Phase 6 — finalize), and
  mark this plan + the spec as "shipped v1.0".
- **T9.11** Final acceptance review against `DASHBOARD_SPECIFICATION.md` §21 —
  all 12 criteria checked off.

### Deliverables

- A clean repo, hardened security posture, keys only in Vault, updated docs,
  signed-off acceptance checklist.

### Acceptance criteria

- All 12 items of spec §21 are satisfied.
- No Alpaca key exists in git history additions, GitHub Secrets, Vercel env,
  the client bundle, or logs.
- The dashboard makes zero calls to `api.github.com`.
- The agent trades every active account from Supabase with no legacy fallback.

### Test plan

- Full regression of every screen + a live trading-routine run across ≥2
  accounts.
- Security: secret-scan the repo and the deployed bundle.
- DR drill: simulate a Supabase blip — agent caches the account list and
  retries; dashboard shows last snapshot.

### Rollback

- This phase removes safety nets; do **not** start it until everything else is
  proven. If a problem surfaces, the previous phase's flags
  (`LEGACY_STATE_WRITE`, the GitHub-backed routes) are the rollback — which is
  why T9.5/T9.6 are the *last* steps and are reversible up to the moment the
  keys are deleted from Secrets. Re-adding keys to Secrets is the ultimate
  fallback.

---

## 15. Testing Strategy

### 15.1 Levels

| Level | Scope | Tooling |
|-------|-------|---------|
| **Unit** | Return math (`returns.ts`/`returns.py`), credential layer, account service, normalizers. | `vitest` (TS), `pytest` (Python). |
| **DB / RLS** | Every RLS policy; `get_account_credentials` access control. | SQL test script / `pytest` against a test project. |
| **Integration** | Account create → Vault → Alpaca validate → live fetch; agent routine per account; backtest upload. | `pytest` + a dedicated **paper** test account. |
| **E2E** | Login, account add/switch, every screen, backtest detail. | Playwright. |
| **Regression** | Backtest numerics byte-identical before/after the agent refactor. | `run.py single` diff. |
| **Security** | Key absence in responses/logs/bundles; header presence; RLS isolation. | grep/secret-scan + manual. |

### 15.2 Mandatory test gates per phase

- **Phase 1:** `supabase db reset` clean + RLS suite green.
- **Phase 2:** credential layer unit tests + key-absence assertion.
- **Phase 5:** equity values diff-match Alpaca to the cent; deposit-exclusion
  test.
- **Phase 6:** two-account isolation + fault-injection + backtest regression.
- **Phase 7:** zero `api.github.com` calls; dashboard limits == backend dump.
- **Phase 8:** largest run files open successfully.
- **Phase 9:** full regression + secret-scan.

### 15.3 The return-math test set (critical — this is the chart)

1. No cash flows: `TWR == equity_end/equity_start − 1`.
2. Mid-period deposit: deposit is excluded; profit unaffected.
3. Mid-period withdrawal: symmetric.
4. Single day: daily return == Alpaca `profit_loss_pct`.
5. Alpha: portfolio TWR − SPY TWR over an identical window, both rebased.
6. Range slicing: 1W/1M/YTD/ALL select the right date span (never by index).

### 15.4 CI

Extend `.github/workflows/code-quality.yml` (or add one) to run the TS unit
tests, the Python unit tests, and `supabase db reset` + RLS suite on every PR
touching `dashboard/`, `scripts/`, or `supabase/`.

---

## 16. Security Checklist

Verified at Phase 2, re-verified at Phase 9.

- [ ] Alpaca keys stored only in Supabase Vault; `accounts` holds only Vault
      UUIDs.
- [ ] No API route/server action returns decrypted key material.
- [ ] `get_account_credentials` revoked from `anon` and `authenticated`.
- [ ] Service-role key only in server env (Vercel server scope, GitHub
      Secrets); never `NEXT_PUBLIC_*`; absent from the client bundle.
- [ ] RLS enabled on every account-scoped table; default-deny; isolation
      test green.
- [ ] All routes behind Supabase Auth; middleware verified.
- [ ] Security headers set (CSP, `X-Frame-Options`, `Referrer-Policy`, HSTS).
- [ ] No key material in server logs (grep the key prefix).
- [ ] Credential create/rotate/delete writes `audit_log`.
- [ ] Live-account add requires explicit confirmation.
- [ ] Alpaca keys removed from GitHub Secrets + Vercel env after cutover.
- [ ] Public Auth sign-ups disabled (single-user).
- [ ] No secrets added to git history (secret-scan the diff).

---

## 17. Deployment & Rollout

### 17.1 Environments

- **Local dev:** dashboard `next dev`; agent scripts against a Supabase dev
  project; a dedicated paper test account.
- **Production:** Vercel (dashboard) + GitHub Actions (agent) + the Supabase
  prod project.
- Migrations flow dev → prod via the Supabase CLI (`supabase db push`).

### 17.2 Order of deployment

1. Supabase prod: apply migrations 0001–0006 (Phase 1).
2. Vercel: add `SUPABASE_*` env vars; deploy the auth shell (Phase 3) — the
   dashboard is now login-gated but still GitHub-backed for data.
3. Deploy the accounts backend + UI (Phases 2, 4); seed the existing paper
   account; run the equity backfill (Phase 5).
4. Deploy the migrated screens (Phase 7) and the fixed backtest (Phase 8).
5. Roll the agent (Phase 6) in dual-write mode; observe for ≥1 trading week.
6. Cutover (Phase 9): drop legacy paths and keys.

### 17.3 Feature flags

| Flag | Controls | Default during migration |
|------|----------|--------------------------|
| `LEGACY_STATE_WRITE` (agent) | Also write `state/*.json` for account #1. | `on` until Phase 9. |
| `DATA_SOURCE` (dashboard, per screen) | `github` vs `supabase`. | Flip per screen as verified. |
| `BACKTEST_SOURCE` (dashboard) | `github` vs `supabase`. | `supabase` once Phase 8 verified. |

---

## 18. Cutover Runbook

Executed once Phases 0–8 are verified in production for ≥ 1 full trading week.

1. **Announce a maintenance window** (optional — most steps are zero-downtime).
2. Confirm `equity_snapshots`, `performance`, `positions`, `trades` for the
   live account are current and correct (spot-check vs. Alpaca).
3. Confirm the last 5 trading days of `routine_runs` are all `success` across
   all active accounts.
4. Flip every dashboard `DATA_SOURCE` flag to `supabase`; redeploy; verify zero
   `api.github.com` calls.
5. Turn off `LEGACY_STATE_WRITE`; the agent now writes only Supabase for
   account state.
6. Run one full trading routine; confirm per-account snapshots + `routine_runs`
   rows appear and no `state/*.json` account files change.
7. **Remove Alpaca keys** from GitHub Actions Secrets and Vercel env. Remove
   `GITHUB_TOKEN`/`GITHUB_REPO` from Vercel.
8. Trigger one routine and one dashboard load to confirm everything still works
   with keys gone from env.
9. Delete dead code/data (T9.2–T9.4); archive legacy backtest files.
10. Disable public Auth sign-ups.
11. Run the full regression + secret-scan.
12. Tag the release; update `README.md`, `CLAUDE.md`; mark the spec + this plan
    "shipped v1.0".

**Abort criteria:** if step 6 or 8 fails, re-enable `LEGACY_STATE_WRITE`,
re-add the keys to Secrets, flip `DATA_SOURCE` back, and diagnose before
retrying. Steps 1–6 are fully reversible; the point of no return is step 7
(key deletion) — only proceed past it once 1–6 are clean.

---

## 19. GitHub Issues Mapping

Per `CLAUDE.md`, bigger changes need an issue, labels, a project-board entry,
and `Refs #N`/`Closes #N` in commits. Suggested epic + issue breakdown:

| Epic / Issue | Labels | Phase |
|--------------|--------|-------|
| **EPIC: Multi-account platform & dashboard rebuild** | `infra`, `P1`, `claude-code` | all |
| Supabase project + Vault + Storage | `infra`, `P1` | 0 |
| Database schema & RLS migrations | `infra`, `security`, `P1` | 1 |
| Credential vault & accounts API | `infra`, `security`, `P0` | 2 |
| Auth & route protection | `security`, `P0` | 3 |
| Accounts management UI & switcher | `infra`, `P1` | 4 |
| Equity snapshots & chart fix | `bug`, `P0` | 5 |
| Agent multi-account refactor | `strategy`, `risk`, `infra`, `P0` | 6 |
| Dashboard Supabase migration | `infra`, `P1` | 7 |
| Backtest screen fix | `bug`, `backtest`, `P1` | 8 |
| Cleanup, hardening & cutover | `infra`, `security`, `P1` | 9 |

The agent refactor (Phase 6) touches `execute_trades.py`/`trade.py`/risk logic
→ it is a **strategy/risk** change and, per `CLAUDE.md`, must cite that the
**backtest numerics are unchanged** (the byte-identical regression test of
T6 acceptance is the evidence) in the closing comment.

---

## 20. Effort Estimates & Critical Path

Estimates in ideal engineering days for one experienced full-stack engineer
(or Claude Code with review). They are planning aids, not commitments.

| Phase | Estimate | Notes |
|-------|----------|-------|
| 0 — Supabase foundations | 0.5 d | Mostly configuration. |
| 1 — Schema & migrations | 2 d | DDL + RLS + tests + generated types. |
| 2 — Credential vault & accounts backend | 3 d | Security-critical; thorough tests. |
| 3 — Auth & shell | 2 d | Middleware + login + settings. |
| 4 — Accounts UI & switcher | 3 d | Dialogs, switcher, context plumbing. |
| 5 — Equity snapshots & chart fix | 3 d | Backfill, TWR math, chart rewrite. |
| 6 — Agent multi-account refactor | 6 d | Largest; touches trading code; careful. |
| 7 — Dashboard data migration | 5 d | Every screen + new `/trades`. |
| 8 — Backtest fix | 2 d | Storage upload + endpoint rework. |
| 9 — Cleanup & cutover | 2 d | Plus ≥1 week of production observation. |
| **Total** | **≈28.5 d** | + ~1 week soak before cutover. |

**Critical path:** 0 → 1 → 2 → 5 → 7 → 9 ≈ 15.5 d. Phases 3, 6, 8 overlap it.
**Quick win:** the correct equity chart for the existing account is reachable
at the end of Phase 5 — about 8.5 days of critical-path work (0+1+2+5).

---

## Appendix A — Migration File Layout

```
supabase/
  config.toml
  migrations/
    0001_enums.sql
    0002_profiles_accounts.sql
    0003_helpers.sql               -- owns_account, get_account_credentials
    0004_account_state.sql         -- equity_snapshots, performance, positions,
                                   --   trades, cash_flows, routine_runs
    0005_shared.sql                -- strategy_params, market_history,
                                   --   research/screener snapshots,
                                   --   backtest_runs, audit_log
    0006_storage_policies.sql
  tests/
    rls.test.sql
  seed.sql                         -- dev-only: a test user + paper account
```

The full DDL for each migration is in `DASHBOARD_SPECIFICATION.md` §13. Apply
with `supabase db push`; reset locally with `supabase db reset`.

---

## Appendix B — Code Templates

These are *sketches* to remove ambiguity, not finished code.

### B.1 Supabase server client (`dashboard/lib/supabase/server.ts`)

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function getSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (xs) => xs.forEach(({ name, value, options }) =>
          cookieStore.set(name, value, options)),
      },
    },
  );
}
```

### B.2 Service-role client (server-only, `dashboard/lib/supabase/service.ts`)

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

export function getSupabaseService() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,        // never NEXT_PUBLIC_*
    { auth: { persistSession: false } },
  );
}
```

### B.3 Account-scoped live route (`app/api/accounts/[id]/live/route.ts`)

```ts
export async function GET(_req: Request, { params }: { params: Promise<{id:string}> }) {
  const { id } = await params;
  const supa = await getSupabaseServer();
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const { data: account } = await supa
    .from("accounts").select("id,mode").eq("id", id).single();   // RLS scopes to owner
  if (!account) return Response.json({ error: "not found" }, { status: 404 });

  const svc = getSupabaseService();
  const { data: cred } = await svc.rpc("get_account_credentials", { acct: id });
  const base = account.mode === "live"
    ? "https://api.alpaca.markets/v2"
    : "https://paper-api.alpaca.markets/v2";

  const headers = { "APCA-API-KEY-ID": cred.api_key,
                    "APCA-API-SECRET-KEY": cred.api_secret };
  const [acc, pos] = await Promise.all([
    fetch(`${base}/account`,   { headers, cache: "no-store" }),
    fetch(`${base}/positions`, { headers, cache: "no-store" }),
  ]);
  if (acc.status === 401 || acc.status === 403) {
    await svc.from("accounts").update({ status: "auth_failed" }).eq("id", id);
    return Response.json({ error: "alpaca auth failed" }, { status: 502 });
  }
  // ... normalize and return; NEVER include cred in the response ...
}
```

### B.4 Agent account context (`scripts/accounts.py`)

```python
class AccountContext:
    def __init__(self, row: dict, api_key: str, api_secret: str):
        self.id       = row["id"]
        self.mode     = row["mode"]            # 'paper' | 'live'
        self.nickname = row["nickname"]
        self.client   = TradingClient(api_key, api_secret,
                                      paper=(self.mode == "paper"))

def iter_account_contexts():
    sb = get_service_client()
    for row in sb.table("accounts").select("*") \
                 .eq("is_active", True).is_("deleted_at", "null").execute().data:
        cred = sb.rpc("get_account_credentials", {"acct": row["id"]}).execute().data
        yield AccountContext(row, cred["api_key"], cred["api_secret"])
```

### B.5 Routine orchestration (`scripts/run_routine.py`)

```python
def run_trading_routine(name, fn):
    for ctx in iter_account_contexts():
        started = now()
        try:
            summary = fn(ctx)                       # the per-account work
            insert_routine_run(ctx.id, name, "success", started, now(), summary)
        except Exception as e:
            log.exception("account %s failed in %s", ctx.nickname, name)
            insert_routine_run(ctx.id, name, "failed", started, now(),
                               {"error": str(e)})
            continue                                # isolation: keep going
```

### B.6 TWR return math (`dashboard/lib/returns.ts`)

```ts
// Time-weighted return over an ordered snapshot slice, excluding cash flows.
export function twr(snaps: EquityPoint[], flows: Map<string, number>): number {
  let acc = 1;
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1].equity;
    const flow = flows.get(snaps[i].date) ?? 0;   // + deposit / − withdrawal
    if (prev <= 0) continue;
    const r = (snaps[i].equity - flow - prev) / prev;
    acc *= 1 + r;
  }
  return acc - 1;
}
```

---

## Appendix C — Rollback Playbook

| Scenario | Rollback |
|----------|----------|
| Migration breaks the DB (Phase 1) | `supabase db reset` to the prior migration; no prod data yet. |
| Accounts API leaks/erros (Phase 2) | Routes unreleased — delete the files; purge test Vault secrets. |
| Auth locks everyone out (Phase 3) | Revert `layout.tsx` + delete `middleware.ts` → public again. |
| Account switcher broken (Phase 4) | UI-only revert; backend API still fine. |
| Equity chart wrong (Phase 5) | Chart components fall back to `daily_history` behind a flag. |
| Agent misbehaves multi-account (Phase 6) | Re-enable `LEGACY_STATE_WRITE`; revert the `.yml` changes; keys still in Secrets. |
| A screen regresses (Phase 7) | Per-screen `DATA_SOURCE` flag back to `github`. |
| Backtest screen broken (Phase 8) | `BACKTEST_SOURCE` flag back to `github`. |
| Post-cutover failure (Phase 9) | Re-add Alpaca keys to Secrets/env; re-enable legacy flags; the point of no return is key deletion (step 7) — everything before it is reversible. |

The single rule: **never delete a safety net until its replacement has traded
real routines in production for at least one full week.**

---

*End of implementation plan. The target system it builds is defined in
`DASHBOARD_SPECIFICATION.md`.*
