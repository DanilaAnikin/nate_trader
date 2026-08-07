# Nate Trader — Multi-Account Platform & Dashboard Specification

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

> **Document type:** Functional & technical specification
> **Status:** Draft v1.0 — for review
> **Owner:** Danila Anikin
> **Last updated:** 2026-05-21
> **Companion document:** `DASHBOARD_IMPLEMENTATION_PLAN.md` (the step-by-step build plan)

---

## Table of Contents

1. [Document Control](#1-document-control)
2. [Executive Summary](#2-executive-summary)
3. [Glossary](#3-glossary)
4. [As-Is Architecture (current system)](#4-as-is-architecture-current-system)
5. [As-Is Data Dictionary](#5-as-is-data-dictionary)
6. [As-Is Dashboard — Screen by Screen](#6-as-is-dashboard--screen-by-screen)
7. [Defect & Gap Catalogue](#7-defect--gap-catalogue)
8. [Target Architecture (to-be)](#8-target-architecture-to-be)
9. [Multi-Account Model](#9-multi-account-model)
10. [Credential Security Model](#10-credential-security-model)
11. [Authentication & Authorization](#11-authentication--authorization)
12. [Equity & Return Computation Model (the chart fix)](#12-equity--return-computation-model-the-chart-fix)
13. [Supabase Data Model — Full Schema](#13-supabase-data-model--full-schema)
14. [Functional Requirements — Screen by Screen](#14-functional-requirements--screen-by-screen)
15. [API & Interface Contracts](#15-api--interface-contracts)
16. [Python Agent — Multi-Account Refactor Requirements](#16-python-agent--multi-account-refactor-requirements)
17. [Data Retention — What to Add, Keep, Remove](#17-data-retention--what-to-add-keep-remove)
18. [Non-Functional Requirements](#18-non-functional-requirements)
19. [Migration & Backward Compatibility](#19-migration--backward-compatibility)
20. [Risks, Assumptions & Open Questions](#20-risks-assumptions--open-questions)
21. [Acceptance Criteria — Definition of Done](#21-acceptance-criteria--definition-of-done)
22. [Appendix A — Environment Variables](#appendix-a--environment-variables)
23. [Appendix B — File & Route Inventory](#appendix-b--file--route-inventory)
24. [Appendix C — Decisions Log](#appendix-c--decisions-log)

---

## 1. Document Control

### 1.1 Purpose

This document specifies the **complete redesign of the Nate Trader dashboard and
its data platform**. The trading strategy and the autonomous agent's decision
logic are considered *stable and out of scope* — they are not being rewritten.
What changes is:

- **How** the dashboard obtains data (today: GitHub raw files; target: Supabase).
- **What** the dashboard shows (multi-account, accurate equity curve, working
  backtest screen).
- **Who** can see it (today: anyone with the URL; target: authenticated users).
- **How** the autonomous Python agent is wired (today: one hard-coded paper
  account; target: N accounts — paper and live — defined in Supabase).

### 1.2 Scope

**In scope:**

- A Supabase-backed data layer (Postgres + Auth + Storage).
- Multi-account support across the whole platform (agent + dashboard).
- In-app management of Alpaca API credentials (add / edit / delete accounts).
- Paper-trading vs. live-trading account distinction.
- A correct, accurate equity chart on the dashboard.
- A working `/backtest` screen.
- Authentication for the dashboard.
- A full audit of every dashboard screen and every state field for
  compatibility, removing what is obsolete and adding what is missing.

**Out of scope:**

- The trading strategy itself (scoring, regime logic, sizing, hedging).
- The backtest engine's numerical logic (only its *storage/serving* changes).
- Mobile-native apps. The dashboard remains a responsive web app.
- Broker integrations other than Alpaca.

### 1.3 Audience

The implementing engineer (human or Claude Code), the project owner, and any
future maintainer. The reader is assumed to know TypeScript, React/Next.js,
Python, SQL, and the basics of the Alpaca API.

### 1.4 Source material

This specification was produced from a full read of the repository at branch
`claude/review-project-structure-KCp79`, commit `3d09506`. Every defect listed
in §7 was observed directly in the code or data, not inferred.

---

## 2. Executive Summary

Nate Trader is an autonomous momentum swing-trading agent. The **backend** is
mature: a dozen GitHub Actions workflows run Python scripts on the US market
clock, screen the market, score candidates, place orders on Alpaca, manage
risk, and commit JSON state files back to the `main` branch. A backtest
framework validates the strategy walk-forward.

The **frontend** is a Next.js 16 dashboard that reads those same JSON files
straight from GitHub's REST API and renders them. It works as a "thin viewer"
but has reached the limits of that model:

1. **The equity chart is wrong.** `state/performance.json → daily_history`
   carries a *constant, back-filled* equity value for every historical day
   (every entry reads `975507.36` with `pnl: 0`). The chart therefore draws a
   flat line and the "Historical Performance vs S&P 500" comparison is
   meaningless.
2. **`/backtest` is unreliable.** The dashboard pulls backtest JSON through
   GitHub's *Contents API*, which silently fails for files larger than 1 MB.
   `state/research.json` (≈1.05 MB) and many archived backtest runs
   (up to ≈1.45 MB) exceed that ceiling. Run-detail pages 404 or crash.
3. **There is exactly one account.** Alpaca keys live only in environment
   variables (Vercel for the dashboard, GitHub Secrets for the agent). There
   is no way to add, switch, or distinguish paper vs. live accounts.
4. **There is no authentication.** Anyone with the URL sees the full portfolio.
   Once API keys are stored in the app, this becomes a credential-exposure
   risk.
5. **The dashboard's domain constants have drifted** from
   `scripts/strategy_config.py` (regime cash floors, max-position counts and
   sizes are all stale — see DEF-07).

The target system makes **Supabase the system of record**. Accounts and
encrypted Alpaca credentials live in Postgres. The autonomous agent reads its
account list from Supabase and trades **every active account** (paper and
live) independently. The dashboard authenticates with Supabase Auth, lets the
user **add accounts and switch between them from the sidebar**, and renders an
**accurate equity curve sourced from Alpaca's Portfolio History API** and
stored as daily snapshots. The `/backtest` screen is fixed by serving backtest
payloads from Supabase Storage instead of GitHub.

This document is the specification. The companion
`DASHBOARD_IMPLEMENTATION_PLAN.md` breaks the work into nine sequenced phases
with task lists, acceptance criteria, and rollback procedures.

---

## 3. Glossary

| Term | Meaning |
|------|---------|
| **Agent** | The autonomous Python trading system driven by GitHub Actions. |
| **Routine** | A scheduled agent job (pre-market research, execution, midday, EOD, weekly). |
| **Account** | A single Alpaca brokerage account (paper or live) with its own API key pair. |
| **Paper account** | Alpaca paper-trading account — simulated money, base URL `paper-api.alpaca.markets`. |
| **Live account** | Alpaca live brokerage account — real money, base URL `api.alpaca.markets`. |
| **State files** | The JSON files under `state/` the agent writes and commits to git. |
| **Equity** | Total account value = cash + market value of all positions. |
| **Equity snapshot** | One stored `(account, date, equity, cash, …)` row — the basis of the chart. |
| **Regime** | SPY-derived market state: `BULL` / `NEUTRAL` / `BEAR`. |
| **Risk tier** | Drawdown-driven safety state: `NORMAL` / `CAUTIOUS` / `HALT`. |
| **Walk-forward (WF)** | Out-of-sample backtest validation; the project's source-of-truth metric. |
| **Alpha** | Portfolio return minus SPY return over the same window. |
| **RLS** | Row-Level Security — Postgres policies that scope rows to the owning user. |
| **Service role** | Supabase key that bypasses RLS; used only by the trusted Python agent. |
| **Anon / authed client** | Browser-side Supabase client; subject to RLS. |
| **System of record** | The single authoritative store for a piece of data. |
| **Vault** | Supabase's encrypted secret store (`supabase_vault`, built on pgsodium/libsodium). |
| **DEF-xx** | A catalogued defect from §7. |
| **FR-xx** | A functional requirement from §14. |
| **NFR-xx** | A non-functional requirement from §18. |

---

## 4. As-Is Architecture (current system)

### 4.1 High-level picture

```
                       GitHub repo  (DanilaAnikin/nate_trader, branch: main)
                       ┌───────────────────────────────────────────────┐
                       │  scripts/*.py        — the agent               │
                       │  state/*.json        — committed state         │
                       │  journal/*.md        — daily narrative         │
                       │  .github/workflows/  — 12 scheduled workflows  │
                       └───────────────────────────────────────────────┘
                              ▲                              │
   GitHub Actions cron        │ commit state                 │ Contents API (read)
   (US market clock)          │                              ▼
   ┌──────────────────┐       │                   ┌────────────────────────┐
   │ premarket 09:45  │───────┘                   │  Next.js dashboard      │
   │ execution 10:00  │                           │  (Vercel)               │
   │ midday    13:00  │       Alpaca paper API     │  reads state/*.json     │
   │ EOD       16:15  │◀─────────────────────────▶ │  via api.github.com     │
   │ weekly    Fri    │   (keys: GitHub Secrets)   │  /api/live → Alpaca     │
   └──────────────────┘                           │  (keys: Vercel env)     │
                                                   └────────────────────────┘
```

### 4.2 The autonomous agent

- **Language / deps:** Python 3.12, `alpaca-py`, `pandas`, `ta`, `scikit-learn`,
  `yfinance` (see `requirements.txt`).
- **Entry points:** `scripts/*.py`, each with a small CLI. Key scripts:
  `screener.py`, `research.py`, `perplexity_research.py`, `execute_trades.py`,
  `trade.py`, `portfolio.py`, `write_journal.py`, plus the `scripts/backtest/`
  package.
- **Alpaca client construction:** module-level singletons. Example —
  `scripts/portfolio.py:16`:
  ```python
  client = TradingClient(ALPACA_API_KEY, ALPACA_SECRET_KEY, paper=True)
  ```
  `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` come from `scripts/utils.py:18-19`
  via `os.getenv` (loaded from `.env` locally or GitHub Secrets in CI).
  `paper=True` is **hard-coded** — the agent can only ever touch a paper
  account.
- **Scheduling:** `.github/workflows/` holds 12 workflows — five trading
  routines plus `auto-iteration`, `auto-sweep`, `backtest`, `gap-scanner`,
  `heartbeat`, `update-spy-history`, `code-quality`.
- **Persistence model:** every routine ends by writing `state/*.json` and
  `journal/YYYY-MM-DD.md`, then committing and pushing to `main`. State *is*
  the database; git history *is* the audit log.

### 4.3 The dashboard

- **Stack:** Next.js 16.2.6 (App Router), React 19.2.4, Tailwind CSS 4,
  Recharts 3.8.1. Located in `dashboard/`.
- **Data access:** `dashboard/lib/github.ts → fetchStateFile()` calls
  `https://api.github.com/repos/{repo}/contents/state/{file}`, base64-decodes
  the `content` field, and `JSON.parse`s it. `GITHUB_TOKEN` is optional;
  `GITHUB_REPO` defaults to `DanilaAnikin/nate_trader`. Responses are cached
  with `next: { revalidate: 60 }`.
- **Live data:** `dashboard/app/api/live/route.ts` calls Alpaca directly. The
  base URL is hard-coded to `https://paper-api.alpaca.markets/v2`. Credentials
  are read from `process.env.ALPACA_API_KEY` / `ALPACA_SECRET_KEY`. If absent
  the route returns HTTP 503 `{ configured: false }`.
- **Rendering model:** server components fetch the GitHub snapshot for the
  first paint; client components (`DashboardClient`, `PositionsClient`) then
  call `/api/live` on mount and *upgrade* the displayed numbers to live Alpaca
  values, broadcasting a `dashboard:live` `CustomEvent` so sibling components
  refresh together.

### 4.4 Data flow today

1. A GitHub Actions routine runs → calls Alpaca → computes state.
2. Routine writes `state/*.json`, commits, pushes to `main`.
3. A user opens the dashboard → server components `fetch` GitHub Contents API
   → base64-decode → render.
4. Client components call `/api/live` → Alpaca paper API → override numbers.

There is **no database, no user model, no per-account scoping** anywhere in
this flow.

---

## 5. As-Is Data Dictionary

Every file the dashboard depends on, its size today, and its role.

| File | Size | Written by | Read by dashboard | Notes |
|------|------|-----------|-------------------|-------|
| `state/performance.json` | 3.9 KB | `portfolio.py:update_performance_state` | `/`, `/positions` | Holds `daily_history[]` — **the broken equity series**. |
| `state/positions.json` | 0.6 KB | `portfolio.py:save_positions_state` | `/positions` | `side` stored as `"PositionSide.LONG"` (enum repr). |
| `state/research.json` | **1.05 MB** | `research.py` | `/`, `/research` | **Exceeds GitHub Contents API 1 MB limit.** 548 symbols. |
| `state/screener.json` | 27 KB | `screener.py` | `/screener` | OK. |
| `state/spy_history.json` | 92 KB | `update_spy_history.py` | `/` chart | Daily SPY closes from 2020-07-27. OK. |
| `state/alpha_tracker.json` | 4.6 KB | `auto_iteration.py` | `/api/alpha-tracker` | Route exists; no UI consumer found. |
| `state/backtest/latest_result.json` | 469 KB | `backtest/run.py` | `/backtest` | OK size; single-window result. |
| `state/backtest/walk_forward_result.json` | 109 KB | `backtest/run.py` | `/backtest` | OK. WF mean OOS alpha = +67.67 %. |
| `state/backtest/sweep_result.json` | 73 KB | `backtest/run.py` | `/backtest` | OK. |
| `state/backtest/monte_carlo_result.json` | 32 KB | `backtest/run.py` | `/backtest` | OK. |
| `state/backtest/comparison_result.json` | 320 KB | `backtest/run.py` | `/backtest` | OK size. |
| `state/backtest/manifest.json` | 28 KB | `backtest/manifest.py` | `/backtest` | Index of 61 runs. |
| `state/backtest/runs/*.json` | 32 KB–1.45 MB | `backtest/manifest.py` | `/backtest/runs/[id]` | **23 of 61 files exceed 1 MB** → detail pages break. |
| `state/backtest/v3_*.json`, `v4_*`, `v5_*` | 56 KB–1.05 MB | legacy | none | **Dead weight — 4.5 MB, not referenced.** |
| `state/strategy_metadata.json` | 0.2 KB | `execute_trades.py` | none | Per-symbol entry strategy/date. |
| `state/earnings_*.json`, `gap_signals.json`, `sector_strength.json`, `ml/*` | — | various | none | Agent-internal; never read by the dashboard. |

### 5.1 `performance.json` — anatomy of the chart bug

The file's top-level fields are correct (`equity: 973426.94`, `cash`,
`daily_pnl`, `risk_tier`, …). The problem is the **`daily_history[]` array**.
Every entry from `2026-04-24` through `2026-05-19` looks like this:

```json
{ "date": "2026-04-24", "pnl": 0.0, "pnl_pct": 0.0,
  "equity": 975507.36, "cash": 1000000.0, "num_positions": 0 }
```

`equity` is **identical (`975507.36`) on every single day**, and `pnl` is
always `0.0`. The `cash` and `num_positions` fields *do* vary, which proves the
array is being touched daily — but the `equity` value was **back-filled with a
single constant** during the v10f production cutover (commit `e09394b`,
"state: v10f production cutover state"; `performance.json → risk_tier_reason`
literally says *"daily_history rolled forward"*).

Consequences:

- `EquityChart.tsx` plots `dataKey="equity"` → a perfectly **flat line**.
- `HistoricalComparisonChart.tsx` rebases SPY against this flat portfolio
  series → the portfolio always looks like it returned 0 % while SPY moved →
  the "Alpha" readout is garbage.
- `DashboardClient.tsx` computes monthly P&L as
  `liveEquity − daily_history.slice(-22)[0].equity` → it subtracts a constant,
  so the number is an artifact of the back-fill, not a real return.

The `daily_history` array is fundamentally **not trustworthy as an equity
series** and must be replaced (see §12).

---

## 6. As-Is Dashboard — Screen by Screen

### 6.1 Layout (`app/layout.tsx`)

Fixed 224 px sidebar (`Sidebar.tsx`) + scrollable main area with a top-right
`RefreshButton`. The sidebar has a static brand block, five nav links, and a
hard-coded "System Active" footer dot. **No account context anywhere.**

### 6.2 `/` — Dashboard (`page.tsx` → `DashboardClient.tsx`)

- Four metric cards: Equity, Cash Reserve, Daily P&L, Monthly P&L.
- `EquityChart` (small) + `SpyComparison` (monthly return vs SPY).
- Three panels: Rules Compliance, Research Signals (BUY/HOLD/SELL counts),
  Portfolio Allocation bars.
- `HistoricalComparisonChart` (large, range-filtered SPY vs portfolio).
- On mount it calls `/api/live` and overrides the snapshot numbers.

### 6.3 `/positions` (`page.tsx` → `PositionsClient.tsx`)

Four metric cards + `PositionsTable` + a "Portfolio Rules" panel. Mirrors the
dashboard's live-upgrade pattern.

### 6.4 `/research` (`page.tsx` → `ResearchTable.tsx`)

SPY summary strip + per-symbol research table. Reads `research.json` —
**which is over the 1 MB GitHub limit, so this screen is already unreliable.**

### 6.5 `/screener` (`page.tsx` → `ScreenerTable.tsx`)

Summary tiles + screener table (most-active / movers / trending / scored).
The "Above Buy (65+)" tile hard-codes the threshold `65`.

### 6.6 `/backtest` (`page.tsx`) and `/backtest/runs/[id]`

Six parallel GitHub fetches; renders headline metrics, equity curve, trade
stats, regime breakdown, per-symbol P&L, sweep table, per-trade chart,
walk-forward, comparison, Monte Carlo. The run-detail page fetches one run
file by id. **Both depend on files that breach the 1 MB API limit.**

### 6.7 API routes

| Route | Purpose | Problem |
|-------|---------|---------|
| `/api/live` | Alpaca account + positions | Single hard-coded paper account. |
| `/api/data` | Generic state file proxy | GitHub-coupled; 1 MB limit on `research`. |
| `/api/backtest` | Backtest result by `kind` | 1 MB limit risk; GitHub-coupled. |
| `/api/backtest/runs` | Run manifest | OK today. |
| `/api/backtest/runs/[id]` | One run payload | **Breaks for >1 MB run files.** |
| `/api/spy-history` | SPY daily closes | OK today. |
| `/api/alpha-tracker` | Alpha iteration history | No UI consumer. |
| `/api/symbol-bars` | Cached per-symbol bars | No UI consumer found — likely dead. |

---

## 7. Defect & Gap Catalogue

Each defect has an ID, severity (P0 blocker / P1 major / P2 minor), and the
evidence that it is real.

### DEF-01 — Equity chart is flat (P0)

`performance.json → daily_history[].equity` is a back-filled constant
(`975507.36` for every day 04-24…05-19, `pnl: 0`). `EquityChart` and
`HistoricalComparisonChart` therefore render a meaningless flat line.
**Root cause:** the equity series is reconstructed by hand in
`portfolio.py:update_performance_state` and was overwritten during the v10f
cutover. **Fix:** §12 — source equity from Alpaca Portfolio History and store
real daily snapshots.

### DEF-02 — `research.json` exceeds the GitHub Contents API 1 MB limit (P0)

`state/research.json` is **1,056,983 bytes**. The GitHub Contents API only
returns inline `content` for files ≤ 1 MB; above that the `content` field is
empty and `encoding` is `"none"`. `fetchStateFile` then `JSON.parse("")`,
throws, and returns `null`. The `/research` page and the dashboard's "Research
Signals" counters silently degrade to empty. **Fix:** serve research from
Supabase.

### DEF-03 — `/backtest` run-detail pages break for large files (P0)

23 of 61 files in `state/backtest/runs/` exceed 1 MB (largest:
`single_20260514_070159.json` ≈ 1.45 MB). `/api/backtest/runs/[id]` and
`/backtest/runs/[id]` fetch them through the Contents API → empty content →
`null` → "Run not found". **Fix:** store backtest payloads in Supabase Storage.

### DEF-04 — GitHub API rate limiting (P1)

Unauthenticated GitHub API calls are limited to 60/hour/IP. The `/backtest`
page alone makes 6 calls per render and is `force-dynamic`. Without a
`GITHUB_TOKEN` set in Vercel, the dashboard becomes flaky under light use and
every screen can intermittently fall back to empty state. **Fix:** remove the
GitHub dependency for app reads (Supabase).

### DEF-05 — Single account, no multi-account model (P0 — primary feature gap)

The agent hard-codes one paper account (`paper=True`, keys from env). The
dashboard hard-codes `paper-api.alpaca.markets`. There is no concept of
multiple accounts, no account switcher, no paper/live distinction.

### DEF-06 — API keys can only be set via environment variables (P0)

Alpaca keys live in Vercel env (dashboard) and GitHub Secrets (agent). They
cannot be added or rotated from the application. The user explicitly wants
in-app credential management.

### DEF-07 — No authentication; dashboard is fully public (P0)

`app/layout.tsx` wraps every route with no auth gate. Anyone with the URL sees
the portfolio. Once API keys are stored server-side this is a serious
exposure: a public dashboard backed by a credential store.

### DEF-08 — Dashboard domain constants have drifted from `strategy_config.py` (P1)

The dashboard hard-codes regime limits that **no longer match the backend**:

| Constant | Dashboard value | `strategy_config.py` / `CLAUDE.md` | Verdict |
|----------|-----------------|-------------------------------------|---------|
| BULL max positions | `15` (`DashboardClient.tsx:183`) | `14` | **Wrong** |
| NEUTRAL min cash % | `20` | `10` | **Wrong** |
| BEAR min cash % | `40` | `30` | **Wrong** |
| BULL max position size % | `6` (`PositionsClient.tsx:91`) | `15` | **Wrong** |
| Screener "Above Buy" | `65` (`screener/page.tsx:15`) | `score_threshold` 45 BULL / 55 NEUTRAL / 70 BEAR | **Wrong & regime-blind** |

The dashboard's "Rules Compliance" panel is therefore showing pass/fail
against the wrong numbers. **Fix:** expose the live regime parameters from the
backend (a `strategy_params` snapshot) instead of duplicating them in TSX.

### DEF-09 — `positions.json` stores the side enum as a Python repr (P2)

`portfolio.py:48` does `"side": str(p.side)` → `"PositionSide.LONG"`, whereas
`/api/live` returns Alpaca's raw `"long"`. Consumers must handle both. **Fix:**
normalize to `"long"` / `"short"` at the source.

### DEF-10 — Monthly/weekly P&L computed by array index, not by date (P1)

`portfolio.py:159` (`history[-5:]`) and `:164` (`history[-22:]`) and
`DashboardClient.tsx:110` (`slice(-22)`) treat "5 entries" as a week and "22
entries" as a month. This is brittle (multiple writes per day, missing days)
and, combined with DEF-01, produces nonsense. **Fix:** compute returns from
date-indexed equity snapshots.

### DEF-11 — Legacy backtest files bloat the repo (P2)

`state/backtest/v3_baseline.json`, `v3_final.json`, `v3_merged_final.json`,
`v3_step135.json`, `v4_iter2_short.json`, `v5_iter1_mini.json` total ≈ 4.5 MB,
are not referenced by the dashboard, and are superseded. **Fix:** archive and
remove.

### DEF-12 — Dead / unused API surface (P2)

`/api/symbol-bars` and `/api/alpha-tracker` have no UI consumer. `/api/data`
duplicates the per-page fetches. **Fix:** delete or repurpose during the
Supabase migration.

### DEF-13 — No realized-P&L / trade history for the live account (P1 — gap)

The dashboard shows *backtest* closed trades but has **no view of the live
account's executed trades, realized P&L, or win rate**. For a trader to
"orient themselves" (the user's stated goal) this is a missing core feature.

### DEF-14 — `/api/live` `daily_pnl` is a single-snapshot delta (P2)

`daily_pnl = equity − last_equity` is correct only at a point in time and
ignores intraday deposits/withdrawals. Acceptable for paper, but for live
accounts cash flows must be excluded from return math (see §12).

### DEF-15 — No system-health / routine-status visibility (P2 — gap)

If a GitHub Actions routine fails, nothing surfaces in the dashboard. The
sidebar's "System Active" dot is a static decoration. **Fix:** a `routine_runs`
table + a health panel.

### DEF-16 — Equity chart cannot represent multiple accounts or true history (P1)

Even once DEF-01 is fixed, the current chart has no notion of "which account"
and no store of equity older than the agent's own back-fill. Alpaca's
Portfolio History API provides real history and must be the seed.

### DEF-17 — `next.config.ts` is effectively empty; no security headers (P2)

No CSP, no `X-Frame-Options`, no route protection config. For a credentialed
app this should be hardened.

---

## 8. Target Architecture (to-be)

### 8.1 Principle

**Supabase becomes the system of record for everything the dashboard reads and
everything that is account-scoped.** GitHub remains the home of *code*,
*journals* (human-readable narrative), and *backtest source* — but the
dashboard never calls the GitHub API again.

### 8.2 High-level picture

```
                         ┌──────────────────────────────────────────┐
                         │              SUPABASE                     │
                         │  Auth         — dashboard users           │
                         │  Postgres     — accounts, snapshots,      │
                         │                 positions, trades, …      │
                         │  Vault        — encrypted Alpaca keys     │
                         │  Storage      — backtest JSON payloads,   │
                         │                 research/screener blobs   │
                         └──────────────────────────────────────────┘
                            ▲           ▲                    ▲
        service role (R/W)  │           │ authed (RLS, R)    │ service role (R/W)
                            │           │                    │
   ┌────────────────────────┴──┐   ┌────┴───────────────┐   ┌┴───────────────────┐
   │  Python agent             │   │  Next.js dashboard │   │ Backtest workflow  │
   │  (GitHub Actions)         │   │  (Vercel)          │   │ (GitHub Actions)   │
   │                           │   │                    │   │                    │
   │  for account in accounts: │   │  login → pick acct │   │  run → upload      │
   │     client = Alpaca(acct) │   │  → read Supabase   │   │  payload+summary   │
   │     run routine           │   │  scoped by acct    │   │  to Supabase       │
   │     write snapshots       │   │                    │   │                    │
   └───────────┬───────────────┘   └─────────┬──────────┘   └────────────────────┘
               │                             │
               ▼ paper-api / api .alpaca      ▼ /api/live (server-side,
        ┌───────────────┐                       decrypts key per account)
        │   Alpaca      │◀──────────────────────┘
        │  (N accounts) │
        └───────────────┘
```

### 8.3 Component responsibilities

| Component | Responsibility |
|-----------|----------------|
| **Supabase Postgres** | Accounts, per-account snapshots (equity/positions/performance), trades, cash flows, routine runs, backtest run index, shared market/research data. |
| **Supabase Vault** | Encrypted Alpaca API key + secret per account. Decryptable only server-side. |
| **Supabase Auth** | Dashboard user identities; email/password (OAuth optional later). |
| **Supabase Storage** | Large JSON blobs — full backtest payloads, research/screener snapshots — keyed by id. Fixes the 1 MB problem. |
| **Python agent** | Reads active accounts from Supabase, builds one Alpaca client per account, runs each routine per account, writes snapshots back to Supabase. Still commits journals to git. |
| **Next.js dashboard** | Authenticates the user, lets them manage and switch accounts, reads account-scoped data from Supabase, renders. Server-side it can decrypt a key to call Alpaca live for the selected account. |
| **Backtest workflow** | Unchanged numerically; additionally uploads each result to Supabase Storage + inserts a row in `backtest_runs`. |
| **GitHub repo** | Code, `journal/`, backtest engine source. No longer the dashboard's data source. |

### 8.4 What stays in GitHub

- All Python and TypeScript **source code**.
- `journal/**` markdown — human narrative, naturally versioned, low value in a
  DB. (Optionally surfaced read-only in the dashboard later via the raw URL.)
- The backtest **engine code** (`scripts/backtest/`). Only its *outputs* move.
- `watchlist.json` — the strategy's static universe seed.

### 8.5 What moves to Supabase

- Everything account-scoped: equity history, positions, performance, risk
  tier, trades, cash flows.
- Account credentials and metadata.
- Shared research + screener snapshots (fixes DEF-02).
- Backtest run index + payloads (fixes DEF-03).
- SPY / benchmark history (`market_history` table).
- Routine execution log.

---

## 9. Multi-Account Model

### 9.1 Concept

An **account** is one Alpaca brokerage account. It has:

- A **mode**: `paper` or `live`. This selects the Alpaca base URL and is shown
  as a prominent badge everywhere in the UI.
- An **Alpaca key pair** (`api_key_id` + `api_secret`), stored encrypted.
- An **owner** — the Supabase Auth user who created it.
- Display metadata: `nickname`, `color`, `created_at`, `is_active`.
- A derived **status**: `connected` / `auth_failed` / `unverified`, from the
  last successful Alpaca call.

### 9.2 Account lifecycle

```
   [Add account form]
        │  user enters nickname, mode, key, secret
        ▼
   [Validate]  ── server calls Alpaca GET /v2/account with the keys
        │            ├─ 200 → status = connected
        │            └─ 401/403 → reject, show "invalid credentials"
        ▼
   [Encrypt + store]  key/secret → Supabase Vault; metadata → accounts table
        ▼
   [Backfill]  one-time pull of Alpaca Portfolio History → equity_snapshots
        ▼
   [Active]  agent now trades it; dashboard can select it
        │
        ├─ [Edit]   change nickname/color/is_active; rotate keys (re-validate)
        ├─ [Pause]  is_active = false → agent skips it, dashboard still views it
        └─ [Delete] soft-delete; keys purged from Vault; snapshots retained or purged per user choice
```

### 9.3 Account selection in the dashboard

- The **sidebar header** hosts an account switcher (dropdown / popover):
  - Lists the user's accounts, each with nickname, mode badge (PAPER/LIVE),
    and current equity.
  - A "＋ Add account" action opens the add flow.
  - "Manage accounts" links to `/accounts`.
- The selected account id is persisted in an **httpOnly cookie**
  (`nt_account`) and reflected in the URL where it aids deep-linking
  (`?account=<id>`). Server components read the cookie; the chosen account is
  validated against the user's accounts on every request.
- All account-scoped screens (`/`, `/positions`) and APIs take the account id
  from this context. Account-agnostic screens (`/research`, `/screener`,
  `/backtest`) ignore it.

### 9.4 Multi-account in the agent

The user has chosen the **full multi-account agent**. Each routine becomes:

```python
for account in get_active_accounts():        # from Supabase, service role
    ctx = AccountContext(account)            # decrypts keys, picks base URL
    run_routine(ctx)                         # all state writes scoped to account.id
```

Per-account isolation is mandatory: risk tier, daily-loss halt, positions, and
performance are **independent per account**. A `HALT` on account A must not
affect account B. See §16 for the refactor requirements.

### 9.5 Paper vs. live safeguards

- The UI must make `live` unmistakable: red/amber `LIVE` badge, a confirmation
  modal before adding a live account, and a one-time "you are about to connect
  a real-money account" acknowledgement.
- The agent must log, in `routine_runs`, the `mode` it traded under.
- A global kill-switch (`accounts.is_active`) lets the user instantly stop the
  agent from trading any account without deleting it.

---

## 10. Credential Security Model

### 10.1 Threat model

Assets to protect: Alpaca API key pairs (especially **live** ones — they can
move real money). Threats: public dashboard exposure (DEF-07), keys in the
browser bundle, keys in git, keys in logs, a compromised Supabase anon key.

### 10.2 Rules

1. **Keys never reach the browser.** No API route, server action, or component
   may return a decrypted key to the client. The browser only ever sees a
   masked form (`PKxxxx••••••••`).
2. **Keys are encrypted at rest** in Supabase Vault (libsodium-backed). The
   `accounts` table holds only Vault *secret references* (UUIDs), never
   plaintext.
3. **Decryption is server-only and minimal-scope.** Only two trusted contexts
   decrypt: (a) the Next.js server runtime when it must call Alpaca live for
   the selected account; (b) the Python agent via the service role. Both use
   the Supabase **service-role key**, which itself lives only in server env
   (Vercel server env + GitHub Secrets) and is never exposed to RLS clients.
4. **RLS everywhere.** Every account-scoped table has Row-Level Security so an
   authenticated user can read only rows for accounts they own. The Vault is
   not exposed to the anon/authed role at all.
5. **No keys in git.** `.gitignore` already excludes `.env`; the migration
   removes Alpaca keys from GitHub Secrets once Supabase holds them (only
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` remain).
6. **Validation before storage.** A key pair is tested against Alpaca
   `GET /v2/account` before it is ever written.
7. **Auditability.** Every credential create/rotate/delete writes a row to an
   `audit_log` table (who, what, when — never the key value).

### 10.3 Storage options compared

| Option | Encryption | Server-only access | Verdict |
|--------|-----------|--------------------|---------|
| **Supabase Vault** | libsodium, managed | Yes — via `vault.decrypted_secrets` view, service role only | **Chosen.** Purpose-built for this. |
| `pgcrypto` column + app master key | Symmetric, app-managed key | Yes | Workable fallback; more moving parts. |
| Plaintext column | None | — | Rejected. |
| GitHub encrypted file | App-managed | — | Rejected (DEF-11 lesson — keys near git). |

**Decision:** store the key pair in Supabase Vault. The `accounts` row carries
`alpaca_key_secret_id` and `alpaca_secret_secret_id` (Vault UUIDs). A
`SECURITY DEFINER` Postgres function `get_account_credentials(account_id)`,
callable only by the service role, returns the decrypted pair to trusted
server code.

---

## 11. Authentication & Authorization

### 11.1 Mechanism

**Supabase Auth**, email + password to start (magic-link / OAuth optional
later). The dashboard uses `@supabase/ssr` for cookie-based sessions that work
across Next.js server components, route handlers, and middleware.

### 11.2 Route protection

- `dashboard/middleware.ts` intercepts every request. Unauthenticated users
  are redirected to `/login`. `/login` and static assets are the only public
  routes.
- Server components obtain the session via the Supabase server client; if
  absent they redirect.
- API route handlers reject unauthenticated requests with HTTP 401.

### 11.3 Authorization

- A `profiles` table (1:1 with `auth.users`) holds display name and the
  `default_account_id`.
- RLS policy on `accounts`: `owner_id = auth.uid()`.
- RLS on every account-scoped table: the row's `account_id` must belong to an
  account the caller owns (enforced via a join or a helper function
  `owns_account(account_id)`).
- The service role bypasses RLS — it is the agent and trusted server code only.

### 11.4 Sessions & UX

- Session cookie is httpOnly, `Secure`, `SameSite=Lax`.
- A `/login` screen, a logout action in the sidebar footer, and a `/settings`
  screen for profile + default account.
- For a single-user deployment, sign-ups can be disabled in Supabase Auth
  after the owner's account is created (no public registration).

---

## 12. Equity & Return Computation Model (the chart fix)

This section specifies the **correct** way to compute and display the equity
curve — the user's top priority ("hlavně správné počítání dat do grafu").

### 12.1 Source of truth: Alpaca Portfolio History

Alpaca exposes `GET /v2/account/portfolio/history` which returns a real
time-series of account equity:

```
{ "timestamp": [ ... ], "equity": [ ... ], "profit_loss": [ ... ],
  "profit_loss_pct": [ ... ], "base_value": <number>, "timeframe": "1D" }
```

This is **the** correct equity history — it is Alpaca's own books, it spans the
account's whole life, and it already excludes the back-fill artifact of
DEF-01. The platform uses it two ways:

1. **One-time backfill.** When an account is added, pull the maximum-lookback
   `1D` portfolio history and insert one `equity_snapshots` row per day.
2. **Daily append.** The End-of-Day routine pulls the latest `1D` point per
   account and upserts today's snapshot.

### 12.2 The `equity_snapshots` table

One row per `(account_id, snapshot_date)`:

| Column | Meaning |
|--------|---------|
| `equity` | Total account value at close (cash + positions). |
| `cash` | Cash component. |
| `position_market_value` | `equity − cash`. |
| `num_positions` | Open positions count. |
| `profit_loss` | Alpaca's day P&L for that date. |
| `profit_loss_pct` | Alpaca's day P&L %. |
| `deposits` / `withdrawals` | Net external cash flow on that date (from Alpaca activities). |
| `regime` / `risk_tier` | Optional context tags for that day. |

### 12.3 Correct return math

Returns must be **cash-flow-adjusted** so that a deposit is not mistaken for
profit:

- **Daily return** = Alpaca's `profit_loss_pct` for the day (already correct),
  or `(equity_t − equity_{t-1} − net_flow_t) / equity_{t-1}`.
- **Period return** (week / month / YTD / all): a **time-weighted return
  (TWR)** — chain daily returns across the window:
  `TWR = Π(1 + r_day) − 1`. This is the only correct way when deposits occur
  mid-period and it is what makes a fair comparison to SPY.
- **Alpha** = portfolio TWR − SPY TWR over the identical date window.

For a paper account with no cash flows, TWR collapses to
`equity_end / equity_start − 1`, but the TWR path is kept so live accounts are
correct from day one.

### 12.4 Chart rendering

- The dashboard chart reads `equity_snapshots` for the **selected account**,
  ordered by date.
- The SPY overlay reads `market_history` for SPY over the same window and is
  **rebased** to the portfolio's value at the window's anchor date (the
  existing rebasing logic in `HistoricalComparisonChart` is sound — only its
  *data source* changes).
- The live "today" point is the current Alpaca equity for the selected
  account, appended to the snapshot series so the curve ends at the live value.
- Range filters (1W / 1M / 3M / 1Y / YTD / ALL) slice the snapshot series by
  date — never by array index (kills DEF-10).

### 12.5 Why not keep `daily_history`

`daily_history` is hand-maintained, single-account, back-fillable (and was
back-filled wrongly), and index-addressed. Alpaca Portfolio History is
authoritative, multi-account-native, and immune to the cutover bug. The
`daily_history` field is **removed** from the performance model.

---

## 13. Supabase Data Model — Full Schema

The following DDL is the target schema. It is written for PostgreSQL 15
(Supabase). Types, constraints, indexes, and RLS are all specified. The
implementation plan turns each block into a migration.

### 13.1 Enums

```sql
create type account_mode   as enum ('paper', 'live');
create type account_status as enum ('unverified', 'connected', 'auth_failed', 'paused');
create type routine_kind   as enum ('premarket','execution','midday','eod','weekly',
                                    'gap_scanner','backtest','auto_iteration','heartbeat');
create type routine_status as enum ('success','partial','failed','running');
create type trade_side     as enum ('buy','sell');
create type backtest_kind  as enum ('single','sweep','monte_carlo','walk_forward','compare');
```

### 13.2 `profiles` — dashboard users

```sql
create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  display_name       text,
  default_account_id uuid,                          -- FK added after accounts exists
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table profiles enable row level security;
create policy "own profile" on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());
```

### 13.3 `accounts` — Alpaca accounts

```sql
create table accounts (
  id                      uuid primary key default gen_random_uuid(),
  owner_id                uuid not null references auth.users(id) on delete cascade,
  nickname                text not null,
  mode                    account_mode   not null,
  status                  account_status not null default 'unverified',
  color                   text not null default '#007aff',
  -- Vault secret references — NEVER plaintext keys
  alpaca_key_secret_id    uuid,
  alpaca_secret_secret_id uuid,
  alpaca_account_number   text,                     -- Alpaca's own id, for display
  is_active               boolean not null default true,   -- agent trades it?
  last_verified_at        timestamptz,
  last_synced_at          timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz                       -- soft delete
);
create index accounts_owner_idx on accounts(owner_id) where deleted_at is null;
alter table accounts enable row level security;
create policy "own accounts" on accounts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table profiles
  add constraint profiles_default_account_fk
  foreign key (default_account_id) references accounts(id) on delete set null;
```

### 13.4 `equity_snapshots` — the equity curve (fixes DEF-01)

```sql
create table equity_snapshots (
  id                     bigint generated always as identity primary key,
  account_id             uuid not null references accounts(id) on delete cascade,
  snapshot_date          date not null,
  equity                 numeric(18,2) not null,
  cash                   numeric(18,2) not null,
  position_market_value  numeric(18,2) not null default 0,
  num_positions          int not null default 0,
  profit_loss            numeric(18,2),
  profit_loss_pct        numeric(10,4),
  deposits               numeric(18,2) not null default 0,
  withdrawals            numeric(18,2) not null default 0,
  regime                 text,
  risk_tier              text,
  source                 text not null default 'alpaca_portfolio_history',
  created_at             timestamptz not null default now(),
  unique (account_id, snapshot_date)
);
create index equity_snap_acct_date_idx on equity_snapshots(account_id, snapshot_date);
alter table equity_snapshots enable row level security;
create policy "read own equity" on equity_snapshots
  for select using (owns_account(account_id));
```

### 13.5 `performance` — current-state KPIs (one row per account)

```sql
create table performance (
  account_id        uuid primary key references accounts(id) on delete cascade,
  equity            numeric(18,2) not null,
  cash              numeric(18,2) not null,
  cash_pct          numeric(10,4) not null,
  position_value    numeric(18,2) not null default 0,
  num_positions     int not null default 0,
  daily_pnl         numeric(18,2) not null default 0,
  daily_pnl_pct     numeric(10,4) not null default 0,
  weekly_twr_pct    numeric(10,4),
  monthly_twr_pct   numeric(10,4),
  ytd_twr_pct       numeric(10,4),
  all_time_twr_pct  numeric(10,4),
  risk_tier         text not null default 'NORMAL',
  risk_tier_reason  text,
  updated_at        timestamptz not null default now()
);
alter table performance enable row level security;
create policy "read own performance" on performance
  for select using (owns_account(account_id));
```

### 13.6 `positions` — open positions per account

```sql
create table positions (
  id                bigint generated always as identity primary key,
  account_id        uuid not null references accounts(id) on delete cascade,
  symbol            text not null,
  qty               numeric(18,6) not null,
  side              trade_side_position not null default 'long',  -- 'long' | 'short'
  avg_entry_price   numeric(18,4) not null,
  current_price     numeric(18,4) not null,
  market_value      numeric(18,2) not null,
  cost_basis        numeric(18,2),
  unrealized_pl     numeric(18,2) not null,
  unrealized_pl_pct numeric(10,4) not null,           -- stored as PERCENT, e.g. -0.80
  strategy          text,                              -- base / momentum / hedge / …
  entry_date        date,
  updated_at        timestamptz not null default now(),
  unique (account_id, symbol)
);
create index positions_acct_idx on positions(account_id);
alter table positions enable row level security;
create policy "read own positions" on positions
  for select using (owns_account(account_id));
```

> Note: `side` is normalized to `long`/`short` lowercase — this fixes DEF-09 at
> the schema level. Use a dedicated enum `trade_side_position as enum
> ('long','short')`.

### 13.7 `trades` — realized trade log (fills DEF-13)

```sql
create table trades (
  id              bigint generated always as identity primary key,
  account_id      uuid not null references accounts(id) on delete cascade,
  alpaca_order_id text,
  symbol          text not null,
  side            trade_side not null,
  qty             numeric(18,6) not null,
  price           numeric(18,4) not null,
  notional        numeric(18,2) not null,
  filled_at       timestamptz not null,
  realized_pnl    numeric(18,2),          -- on closing trades
  realized_pnl_pct numeric(10,4),
  reason          text,                   -- entry / trail_stop / scale_out / time_stop …
  strategy        text,
  created_at      timestamptz not null default now(),
  unique (account_id, alpaca_order_id)
);
create index trades_acct_filled_idx on trades(account_id, filled_at desc);
alter table trades enable row level security;
create policy "read own trades" on trades
  for select using (owns_account(account_id));
```

### 13.8 `cash_flows` — deposits / withdrawals (for correct TWR)

```sql
create table cash_flows (
  id          bigint generated always as identity primary key,
  account_id  uuid not null references accounts(id) on delete cascade,
  flow_date   date not null,
  amount      numeric(18,2) not null,     -- + deposit, − withdrawal
  kind        text not null,             -- 'deposit' | 'withdrawal' | 'fee' | 'adjustment'
  source      text not null default 'alpaca_activities',
  created_at  timestamptz not null default now()
);
create index cash_flows_acct_date_idx on cash_flows(account_id, flow_date);
alter table cash_flows enable row level security;
create policy "read own cash flows" on cash_flows
  for select using (owns_account(account_id));
```

### 13.9 `routine_runs` — agent execution log (fills DEF-15)

```sql
create table routine_runs (
  id            bigint generated always as identity primary key,
  account_id    uuid references accounts(id) on delete cascade,  -- null = account-agnostic
  kind          routine_kind not null,
  status        routine_status not null,
  started_at    timestamptz not null,
  finished_at   timestamptz,
  duration_ms   int,
  summary       jsonb,                  -- counts, orders placed, errors
  github_run_url text,
  created_at    timestamptz not null default now()
);
create index routine_runs_acct_idx on routine_runs(account_id, started_at desc);
alter table routine_runs enable row level security;
create policy "read own routine runs" on routine_runs
  for select using (account_id is null or owns_account(account_id));
```

### 13.10 `strategy_params` — live regime parameters (fixes DEF-08)

A single-row (or small) table the agent writes after each research run, so the
dashboard reads the *real* regime limits instead of hard-coding them.

```sql
create table strategy_params (
  id            int primary key default 1,
  regime        text not null,
  risk_tier     text not null,
  score_threshold        numeric,
  gate_score_min         numeric,
  min_cash_pct           numeric,
  max_cash_pct           numeric,
  max_positions          int,
  max_position_pct       numeric,
  risk_per_trade_pct     numeric,
  trailing_stop_pct      numeric,
  raw                    jsonb,         -- full get_strategy_params() dump
  updated_at    timestamptz not null default now(),
  constraint singleton check (id = 1)
);
alter table strategy_params enable row level security;
create policy "read params" on strategy_params for select using (auth.uid() is not null);
```

### 13.11 `market_history` — SPY / benchmark closes

```sql
create table market_history (
  symbol     text not null,
  bar_date   date not null,
  close      numeric(18,4) not null,
  primary key (symbol, bar_date)
);
alter table market_history enable row level security;
create policy "read market" on market_history for select using (auth.uid() is not null);
```

### 13.12 `research_snapshots` & `screener_snapshots`

Account-agnostic. The large payload lives in Storage; the table row is the
index/metadata.

```sql
create table research_snapshots (
  id           bigint generated always as identity primary key,
  generated_at timestamptz not null,
  spy          jsonb,                  -- small SPY summary, inline
  symbol_count int,
  buy_count    int,
  hold_count   int,
  sell_count   int,
  storage_path text not null,          -- Storage object with the full per-symbol payload
  created_at   timestamptz not null default now()
);
-- screener_snapshots: same shape, storage_path → full screener payload.
```

### 13.13 `backtest_runs` — backtest index (fixes DEF-03)

```sql
create table backtest_runs (
  id            text primary key,            -- e.g. 'single_20260521_073748'
  kind          backtest_kind not null,
  generated_at  timestamptz not null,
  start_date    date,
  end_date      date,
  summary       jsonb not null,              -- headline metrics for the list view
  storage_path  text not null,               -- Storage object with the full payload
  created_at    timestamptz not null default now()
);
alter table backtest_runs enable row level security;
create policy "read backtests" on backtest_runs
  for select using (auth.uid() is not null);
```

### 13.14 `audit_log` — credential & account events

```sql
create table audit_log (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  account_id  uuid,
  action      text not null,        -- account.create / key.rotate / account.delete …
  detail      jsonb,                -- never contains key material
  created_at  timestamptz not null default now()
);
alter table audit_log enable row level security;
create policy "read own audit" on audit_log
  for select using (actor_id = auth.uid());
```

### 13.15 Helper function `owns_account`

```sql
create or replace function owns_account(acct uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from accounts
    where id = acct and owner_id = auth.uid() and deleted_at is null
  );
$$;
```

### 13.16 Credential accessor (service role only)

```sql
create or replace function get_account_credentials(acct uuid)
returns table (api_key text, api_secret text)
language plpgsql security definer as $$
declare k uuid; s uuid;
begin
  select alpaca_key_secret_id, alpaca_secret_secret_id into k, s
    from accounts where id = acct;
  return query
    select (select decrypted_secret from vault.decrypted_secrets where id = k),
           (select decrypted_secret from vault.decrypted_secrets where id = s);
end; $$;
revoke all on function get_account_credentials(uuid) from public, anon, authenticated;
-- callable by the service role only.
```

### 13.17 Storage buckets

| Bucket | Contents | Access |
|--------|----------|--------|
| `backtest-results` | Full backtest run JSON payloads (`{id}.json`). | Read: authenticated. Write: service role. |
| `research-snapshots` | Full research + screener payloads. | Same. |

### 13.18 Entity-relationship summary

```
auth.users 1───1 profiles
auth.users 1───N accounts
accounts   1───N equity_snapshots
accounts   1───1 performance
accounts   1───N positions
accounts   1───N trades
accounts   1───N cash_flows
accounts   1───N routine_runs        (routine_runs.account_id nullable)
(global)        strategy_params, market_history,
                research_snapshots, screener_snapshots, backtest_runs, audit_log
```

---

## 14. Functional Requirements — Screen by Screen

Requirements are numbered `FR-<area>-<n>`.

### 14.1 Login (`/login`) — NEW

- **FR-AUTH-1** Unauthenticated access to any route except `/login` redirects
  to `/login`.
- **FR-AUTH-2** Email + password sign-in via Supabase Auth.
- **FR-AUTH-3** Clear error messaging for bad credentials; no user enumeration.
- **FR-AUTH-4** On success, redirect to the user's `default_account_id`
  dashboard, or to `/accounts` if they have none.
- **FR-AUTH-5** A logout control in the sidebar footer ends the session.

### 14.2 Account switcher (sidebar) — NEW

- **FR-ACS-1** The sidebar header shows the currently selected account:
  nickname, mode badge (`PAPER`/`LIVE`), and live equity.
- **FR-ACS-2** Clicking it opens a list of all the user's active accounts;
  selecting one switches context (cookie + re-render) without a full reload
  where practical.
- **FR-ACS-3** The list includes "＋ Add account" and "Manage accounts".
- **FR-ACS-4** If the user has zero accounts, every account-scoped screen shows
  an empty state pointing to the add-account flow.
- **FR-ACS-5** `LIVE` accounts are visually distinct (color + icon) from
  `PAPER` everywhere the account appears.

### 14.3 Accounts management (`/accounts`) — NEW

- **FR-ACC-1** List every account the user owns: nickname, mode, status,
  equity, last-synced time, is-active toggle.
- **FR-ACC-2** "Add account" form: nickname, mode (paper/live), Alpaca key,
  Alpaca secret, color.
- **FR-ACC-3** On submit, the server validates the keys against Alpaca
  `GET /v2/account` **before** persisting. Failure → inline error, nothing
  stored.
- **FR-ACC-4** Adding a `live` account requires an explicit confirmation
  ("real money") checkbox.
- **FR-ACC-5** On successful add, trigger the one-time equity backfill (§12.1).
- **FR-ACC-6** Edit: change nickname/color, toggle `is_active`, rotate keys
  (re-validates).
- **FR-ACC-7** Delete: soft-delete; purge Vault secrets; ask whether to keep or
  drop historical snapshots.
- **FR-ACC-8** Keys are shown only masked; the secret is never re-displayed
  after creation.
- **FR-ACC-9** A "Test connection" button re-verifies an account on demand and
  updates `status`.

### 14.4 Dashboard (`/`) — REWORKED

- **FR-DSH-1** All figures are scoped to the selected account.
- **FR-DSH-2** KPI cards: Equity, Cash Reserve %, Daily P&L, Period return
  (selectable: Week/Month/YTD) with the SPY figure for the same window.
- **FR-DSH-3** **Equity curve** sourced from `equity_snapshots` for the
  selected account (never `daily_history`), with the live point appended.
  Range filters slice by date.
- **FR-DSH-4** SPY overlay rebased to the portfolio anchor over the chosen
  range; alpha shown for that exact window.
- **FR-DSH-5** Rules-compliance panel uses **live `strategy_params`** from the
  backend, not hard-coded constants (fixes DEF-08).
- **FR-DSH-6** Allocation panel: invested vs. cash vs. position count against
  the *real* regime max.
- **FR-DSH-7** A recent-activity panel: last N trades for the account (from
  `trades`) — gives the realized-P&L visibility DEF-13 calls for.
- **FR-DSH-8** A system-health indicator from `routine_runs` (last successful
  routine per kind; red if a routine failed) — replaces the fake "System
  Active" dot (DEF-15).
- **FR-DSH-9** Market regime + risk tier badges, sourced from `strategy_params`
  / `performance`.
- **FR-DSH-10** A manual Refresh re-pulls live Alpaca data for the selected
  account.

### 14.5 Positions (`/positions`) — REWORKED

- **FR-POS-1** Positions for the selected account, from `positions` + a live
  Alpaca refresh.
- **FR-POS-2** Per-position: symbol, qty, side, avg entry, current price,
  market value, unrealized P&L ($ and %), strategy tag, days held.
- **FR-POS-3** `side` rendered from the normalized `long`/`short` value
  (DEF-09).
- **FR-POS-4** Portfolio-rules panel driven by live `strategy_params`.
- **FR-POS-5** Sector-exposure breakdown vs. the 25 % cap.
- **FR-POS-6** Empty state when the account has no positions.

### 14.6 Trades / History (`/trades`) — NEW (optional but recommended)

- **FR-TRD-1** Paginated realized-trade log for the selected account from
  `trades`: date, symbol, side, qty, price, realized P&L, reason, strategy.
- **FR-TRD-2** Summary header: realized P&L, win rate, average win/loss,
  profit factor — the *live* analogues of the backtest stats.
- **FR-TRD-3** Filters by symbol, side, date range.

### 14.7 Research (`/research`) — REWORKED (data source only)

- **FR-RES-1** Reads the latest `research_snapshots` row + its Storage payload
  (fixes DEF-02). UI layout unchanged.
- **FR-RES-2** SPY summary strip from the snapshot's inline `spy` jsonb.
- **FR-RES-3** Optionally flag which researched symbols the selected account
  currently holds.

### 14.8 Screener (`/screener`) — REWORKED (data source only)

- **FR-SCR-1** Reads the latest `screener_snapshots` row + Storage payload.
- **FR-SCR-2** The "Above Buy" threshold uses the live regime `score_threshold`
  from `strategy_params`, not the hard-coded `65` (DEF-08).

### 14.9 Backtest (`/backtest`, `/backtest/runs/[id]`) — FIXED

- **FR-BKT-1** The run list reads `backtest_runs` (Postgres) — fast, no 1 MB
  limit.
- **FR-BKT-2** A run's full payload is fetched from Supabase Storage by
  `storage_path` (fixes DEF-03 for files of any size).
- **FR-BKT-3** All existing visualizations (equity curve, sweep, walk-forward,
  Monte Carlo, comparison, per-trade) keep working against the same payload
  shape.
- **FR-BKT-4** Account-agnostic — the backtest screen ignores the account
  switcher.
- **FR-BKT-5** Headline WF metric prominently shown against the +5–10 %/yr
  goal.
- **FR-BKT-6** (Optional) A "Run backtest" button that triggers the GitHub
  `Backtest` workflow via the GitHub API.

### 14.10 Settings (`/settings`) — NEW

- **FR-SET-1** Profile: display name, change password.
- **FR-SET-2** Default account selection.
- **FR-SET-3** Sign-out; (later) session management.

---

## 15. API & Interface Contracts

### 15.1 Dashboard route handlers (Next.js, server-side)

All handlers require an authenticated session and, where account-scoped,
verify the account belongs to the caller.

| Route | Method | Input | Output |
|-------|--------|-------|--------|
| `/api/accounts` | GET | — | `Account[]` (no secrets) |
| `/api/accounts` | POST | `{nickname,mode,apiKey,apiSecret,color}` | validates → `Account` |
| `/api/accounts/[id]` | PATCH | editable fields / key rotation | `Account` |
| `/api/accounts/[id]` | DELETE | `{purgeHistory?}` | `{ok}` |
| `/api/accounts/[id]/verify` | POST | — | `{status}` |
| `/api/accounts/[id]/live` | GET | — | live Alpaca account + positions for that account |
| `/api/accounts/[id]/equity` | GET | `?range=` | `equity_snapshots` slice + live point |
| `/api/accounts/[id]/trades` | GET | `?limit&offset` | `Trade[]` + summary |
| `/api/backtest/runs` | GET | — | `backtest_runs` index |
| `/api/backtest/runs/[id]` | GET | — | full payload from Storage |
| `/api/research/latest` | GET | — | latest research snapshot |
| `/api/screener/latest` | GET | — | latest screener snapshot |
| `/api/strategy-params` | GET | — | live `strategy_params` |
| `/api/market/spy` | GET | `?from&to` | SPY `market_history` slice |

The old `/api/data`, `/api/symbol-bars`, `/api/alpha-tracker`, `/api/spy-history`
and the GitHub-coupled `/api/live` are **removed or replaced** (see §17).

### 15.2 The live-data contract

`/api/accounts/[id]/live` replaces `/api/live`:

1. Verify session + ownership.
2. `get_account_credentials(id)` via the service-role server client.
3. Pick base URL from `accounts.mode` (`paper-api` vs `api`).
4. Call Alpaca `/v2/account` + `/v2/positions`.
5. Return normalized JSON. **Never** return the keys.
6. On Alpaca 401/403 → set `accounts.status = 'auth_failed'`, return a typed
   error the UI can show.

### 15.3 Python ↔ Supabase contract

The agent uses the Supabase Python client (`supabase-py`) with the service
role:

- `get_active_accounts() -> list[Account]` — `accounts` where `is_active` and
  not deleted.
- `get_account_credentials(account_id)` — via the RPC above.
- `upsert_equity_snapshot(account_id, row)`, `upsert_performance(...)`,
  `replace_positions(account_id, rows)`, `insert_trades(...)`,
  `upsert_strategy_params(...)`, `insert_routine_run(...)`.

### 15.4 Backtest workflow contract

After producing `state/backtest/*.json` the workflow additionally:

1. Uploads the full payload to Storage bucket `backtest-results` as
   `{run_id}.json`.
2. Inserts/updates a `backtest_runs` row with `summary` + `storage_path`.

### 15.5 TypeScript domain types (dashboard)

`dashboard/lib/types.ts` is rewritten around the Supabase schema. Indicative
shapes:

```ts
export interface Account {
  id: string; nickname: string; mode: 'paper' | 'live';
  status: 'unverified'|'connected'|'auth_failed'|'paused';
  color: string; isActive: boolean; equity?: number;
  lastSyncedAt: string | null;
}
export interface EquityPoint {
  date: string; equity: number; cash: number;
  positionValue: number; numPositions: number;
}
export interface PerformanceKPIs {
  equity: number; cash: number; cashPct: number;
  dailyPnl: number; dailyPnlPct: number;
  weeklyTwrPct: number|null; monthlyTwrPct: number|null;
  ytdTwrPct: number|null; allTimeTwrPct: number|null;
  riskTier: 'NORMAL'|'CAUTIOUS'|'HALT';
}
export interface TradeRow {
  id: number; symbol: string; side: 'buy'|'sell';
  qty: number; price: number; filledAt: string;
  realizedPnl: number|null; reason: string|null; strategy: string|null;
}
export interface StrategyParams {
  regime: string; riskTier: string;
  scoreThreshold: number; gateScoreMin: number;
  minCashPct: number; maxCashPct: number;
  maxPositions: number; maxPositionPct: number;
  riskPerTradePct: number; trailingStopPct: number;
}
```

Backtest types (`backtest-types.ts`) keep their current shape — only the
*transport* changes — so the existing chart components need minimal edits.

---

## 16. Python Agent — Multi-Account Refactor Requirements

The user chose the **full multi-account agent**. This section specifies what
the refactor must achieve (the *how* is in the implementation plan).

### 16.1 Account context

- **PY-1** Introduce `scripts/accounts.py` exposing `AccountContext` — holds
  `account_id`, `mode`, a constructed `TradingClient`, and a constructed data
  client. `paper=` is derived from `mode`, never hard-coded.
- **PY-2** `get_active_accounts()` reads `accounts` from Supabase (service
  role) and `get_account_credentials()` decrypts the keys via RPC.
- **PY-3** All Alpaca clients are **constructed per account**, not as module
  singletons. `portfolio.py`, `trade.py`, `execute_trades.py`,
  `research.py` (for account-specific calls) accept an `AccountContext`.

### 16.2 Per-account state

- **PY-4** `portfolio.py` writes `equity_snapshots`, `performance`, and
  `positions` rows to Supabase keyed by `account_id` instead of writing
  `state/performance.json` / `state/positions.json`.
- **PY-5** Risk tier is stored per account (`performance.risk_tier`) and
  resolved per account. A `HALT` on one account never affects another.
- **PY-6** `strategy_metadata` (per-symbol entry strategy/date) becomes
  per-account, stored alongside `positions` or in its own table/column.
- **PY-7** Trades executed by `execute_trades.py` are recorded in the `trades`
  table per account.
- **PY-8** Journals become per-account: `journal/<account_slug>/YYYY-MM-DD.md`
  (still committed to git for the human narrative).

### 16.3 Routine orchestration

- **PY-9** Each of the five trading routines iterates over active accounts and
  runs the full per-account pipeline; one account failing must not abort the
  others (catch, log to `routine_runs`, continue).
- **PY-10** Account-agnostic work (screener, research universe scan,
  Perplexity, SPY history, backtest) runs **once per cycle**, not per account —
  its output (`research_snapshots`, `screener_snapshots`, `market_history`,
  `strategy_params`) is shared.
- **PY-11** Every routine writes a `routine_runs` row (kind, account, status,
  duration, summary, GitHub run URL).

### 16.4 Secrets & config

- **PY-12** GitHub Secrets are reduced to `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` (plus `PERPLEXITY_API_KEY`, `CLICKUP_*` which are
  account-agnostic). Alpaca keys are **removed** from GitHub Secrets once
  Supabase holds them.
- **PY-13** Local dev: a `.env` may still hold a Supabase service key for
  running scripts against the dev project.

### 16.5 Backtest is unchanged numerically

- **PY-14** The backtest engine stays single, account-agnostic. Only
  `run.py` / the workflow gains the Supabase upload step (§15.4).

### 16.6 Concurrency & idempotency

- **PY-15** Snapshot writes are upserts keyed by `(account_id, date)` — safe to
  re-run a routine.
- **PY-16** With state in Supabase, the workflows no longer need the
  commit/rebase dance for `state/*.json`. Only journals (and code) are
  committed to git. This simplifies every workflow's "commit and push" step.

---

## 17. Data Retention — What to Add, Keep, Remove

### 17.1 Add

| Data | Where | Why |
|------|-------|-----|
| Per-account equity snapshots | `equity_snapshots` | Fixes the chart (DEF-01/16). |
| Realized trade log | `trades` | Live win-rate / P&L (DEF-13). |
| Cash flows | `cash_flows` | Correct TWR for funded accounts (DEF-14). |
| Routine run log | `routine_runs` | System health (DEF-15). |
| Live strategy params | `strategy_params` | Stops the dashboard drifting (DEF-08). |
| Accounts + Vault secrets | `accounts` + Vault | The whole multi-account feature. |
| Users / profiles | Supabase Auth + `profiles` | Authentication (DEF-07). |
| Audit log | `audit_log` | Credential-change traceability. |

### 17.2 Keep (migrated to Supabase, same content)

- Research per-symbol data → `research_snapshots` + Storage.
- Screener data → `screener_snapshots` + Storage.
- SPY history → `market_history`.
- Backtest results → `backtest_runs` + Storage.

### 17.3 Remove / deprecate

| Item | Action | Reason |
|------|--------|--------|
| `performance.json → daily_history` | Remove field | Replaced by `equity_snapshots` (DEF-01). |
| `state/backtest/v3_*.json`, `v4_*`, `v5_*` | Delete from repo (archive a copy) | 4.5 MB dead weight (DEF-11). |
| `/api/symbol-bars`, `/api/alpha-tracker` | Delete | No consumer (DEF-12). |
| `/api/data` | Delete | Superseded by typed Supabase endpoints. |
| `/api/live` (GitHub/env coupled) | Replace with `/api/accounts/[id]/live` | Multi-account. |
| `dashboard/lib/github.ts` | Delete after migration | Dashboard no longer reads GitHub. |
| Alpaca keys in GitHub Secrets / Vercel env | Remove after cutover | Now in Vault (DEF-06). |
| Static "System Active" dot | Replace with real health (DEF-15) | Misleading. |
| Hard-coded regime constants in TSX | Delete | Replaced by `strategy_params` (DEF-08). |

### 17.4 Keep in git unchanged

- All Python / TypeScript source.
- `journal/**` (now per-account subfolders).
- `watchlist.json`, `scripts/backtest/` engine code, strategy docs.
- The `state/*.json` files *may* remain as an agent-local working cache and
  audit copy, but they are no longer the dashboard's source. (Decision in
  Appendix C: keep them as a git-committed audit backup for one release, then
  re-evaluate.)

---

## 18. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| **NFR-SEC-1** | Alpaca keys encrypted at rest (Vault); never sent to the browser; never logged. |
| **NFR-SEC-2** | All dashboard routes behind Supabase Auth; RLS on every account-scoped table. |
| **NFR-SEC-3** | Security headers (CSP, `X-Frame-Options: DENY`, `Referrer-Policy`, HSTS) set in `next.config.ts` / middleware (DEF-17). |
| **NFR-SEC-4** | The Supabase service-role key exists only in server env (Vercel server, GitHub Secrets); never in client bundles. |
| **NFR-SEC-5** | Adding/rotating/deleting credentials is audit-logged. |
| **NFR-PERF-1** | Any dashboard screen first-paints in < 1.5 s on a warm cache; data queries are indexed (see §13 indexes). |
| **NFR-PERF-2** | Equity-curve query for ALL range returns in < 300 ms (indexed `(account_id, snapshot_date)`). |
| **NFR-PERF-3** | Backtest payloads served from Storage/CDN; the list view never loads full payloads. |
| **NFR-REL-1** | One account erroring in a routine does not abort the others (PY-9). |
| **NFR-REL-2** | Snapshot writes are idempotent upserts (PY-15). |
| **NFR-REL-3** | The dashboard degrades gracefully if Alpaca live is unreachable — it shows the last snapshot with a "stale" marker. |
| **NFR-OBS-1** | Every routine run is recorded in `routine_runs`; failures are visible in the dashboard. |
| **NFR-OBS-2** | Server errors in route handlers are logged with context (account id, never keys). |
| **NFR-COST-1** | Supabase free tier (500 MB DB, 1 GB Storage, 50k MAU) is sufficient; snapshot volume is ~1 row/account/day. The design must not require a paid tier for a single-user, few-accounts deployment. |
| **NFR-MNT-1** | Domain constants have exactly one source of truth (`strategy_config.py` → `strategy_params`); the dashboard never re-declares them. |
| **NFR-A11Y-1** | Color is never the only signal (paper/live, P&L sign) — pair with text/icon. |
| **NFR-RESP-1** | All screens usable from 360 px (mobile) to 1600 px. |

---

## 19. Migration & Backward Compatibility

### 19.1 Strategy

The migration runs **alongside** the live system; the agent must not stop
trading. Sequencing (detailed in the plan):

1. Stand up Supabase (schema, Auth, Vault, Storage) — no behavior change.
2. Seed the **existing paper account** as the first `accounts` row; store its
   current keys in Vault.
3. One-time **backfill** of `equity_snapshots` from Alpaca Portfolio History
   for that account → the chart becomes correct immediately, retroactively.
4. Migrate research/screener/backtest/SPY data into Supabase + Storage.
5. Refactor the agent to multi-account, reading from Supabase, **while still
   able to run the legacy single-account path** behind a flag until verified.
6. Switch the dashboard to Supabase, screen by screen, behind the new auth.
7. Cut over: remove Alpaca keys from GitHub Secrets / Vercel env; delete the
   GitHub-coupled code paths.

### 19.2 Backward compatibility

- During the transition the agent may **dual-write** (Supabase + the legacy
  `state/*.json`) so a rollback is always possible.
- The dashboard migration is screen-by-screen; each screen flips to Supabase
  only once its data is verified present and correct.
- No destructive deletion (`v3_*` files, GitHub Secrets) happens until the
  Supabase path is proven in production for at least one full trading week.

### 19.3 The "existing account" continuity

The current paper account (equity ≈ $973 k, positions TQQQ + UPRO) becomes
Account #1. Its history is reconstructed from Alpaca, so the user sees a
*correct* multi-year curve on day one — not just data from the cutover
forward.

---

## 20. Risks, Assumptions & Open Questions

### 20.1 Assumptions

- **A1** Alpaca's Portfolio History API returns sufficient lookback for the
  paper account's full life. If lookback is capped, the curve starts at the
  earliest available point — still vastly better than the flat line.
- **A2** Supabase free tier suffices for a single user with a handful of
  accounts. Row growth is ~1 equity snapshot/account/day.
- **A3** The trading strategy and backtest numerics are correct and frozen for
  this project; only data plumbing changes.
- **A4** GitHub Actions remains the agent's runtime (no move to a server).

### 20.2 Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Live keys mishandled | Real-money exposure | Vault, server-only decryption, RLS, audit log, confirmation gates (§10). |
| Agent multi-account refactor regresses trading | Missed/duplicate trades | Dual-write + flag; per-account isolation; staged rollout; backtest unaffected. |
| Supabase outage | Dashboard down; agent can't read accounts | Agent caches the account list for a short TTL; dashboard shows last snapshot. |
| Portfolio History lookback gaps | Partial curve | Accept earliest-available; document in UI. |
| Cost overrun if accounts/snapshots explode | Paid tier | Monitor; snapshots are tiny; prune intraday data. |
| RLS misconfiguration leaks data | Cross-user exposure | RLS test suite; default-deny; review every policy. |

### 20.3 Open questions (for the owner)

- **Q1** Should `journal/**` be surfaced read-only in the dashboard (e.g. a
  `/journal` screen)? — *Default: yes, low-cost, recommended.*
- **Q2** Should the agent trade paper and live accounts on the **same**
  schedule, or should live accounts have a stricter/opt-in cadence? —
  *Default: same schedule; `is_active` is the control.*
- **Q3** Keep `state/*.json` as a committed audit backup, or stop committing
  them entirely once Supabase is authoritative? — *Default: keep one release,
  then stop.*
- **Q4** Public sign-up disabled (single-user) or allow multi-user from the
  start? — *Default: single-user, sign-up disabled after the owner is created.*

---

## 21. Acceptance Criteria — Definition of Done

The project is **done** when all of the following are true:

1. **Auth** — every route is behind Supabase Auth; an unauthenticated visit to
   any URL lands on `/login`.
2. **Accounts** — the user can add, edit, pause, and delete accounts from
   `/accounts`; keys are validated against Alpaca before storage and are never
   visible to the browser.
3. **Switcher** — the sidebar switches the whole dashboard between accounts;
   paper vs. live is unmistakable.
4. **Equity chart** — the dashboard equity curve is **accurate**: it matches
   Alpaca's Portfolio History for the selected account, is correct
   retroactively (no flat line), and alpha vs. SPY is computed cash-flow-
   adjusted over the selected range.
5. **`/backtest`** — loads reliably, including run-detail pages for payloads of
   any size; no GitHub 1 MB failures.
6. **Research/Screener** — load reliably (no 1 MB failure on `research`).
7. **Multi-account agent** — a GitHub Actions routine trades every active
   account independently; one account failing does not abort the rest;
   per-account risk tiers are isolated; `routine_runs` records each run.
8. **Consistency** — the dashboard's regime limits match
   `strategy_config.py` exactly (sourced from `strategy_params`); no
   hard-coded constants remain.
9. **Trade history** — the live account's realized trades and win-rate are
   visible.
10. **Security** — no Alpaca keys in git, in GitHub Secrets, in Vercel env, in
    client bundles, or in logs; RLS verified by tests; security headers set.
11. **Cleanup** — dead routes/files (DEF-11/12) removed; `daily_history`
    retired.
12. **Docs** — this spec and the implementation plan reflect the shipped
    system; `CLAUDE.md` updated for the new data layer and multi-account agent.

---

## Appendix A — Environment Variables

### A.1 Dashboard (Vercel)

| Variable | Scope | Purpose |
|----------|-------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | RLS-scoped client key. |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Decrypt credentials, call Alpaca live. |
| *(removed)* `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | — | Now in Vault. |
| *(removed)* `GITHUB_TOKEN` / `GITHUB_REPO` | — | Dashboard no longer reads GitHub. |

### A.2 Agent (GitHub Actions Secrets)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Read accounts, decrypt keys, write snapshots. |
| `PERPLEXITY_API_KEY` | Account-agnostic research. |
| `CLICKUP_API_KEY` / `CLICKUP_LIST_ID` | Account-agnostic notifications. |
| *(removed)* `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | Now per-account in Vault. |

---

## Appendix B — File & Route Inventory

### B.1 Dashboard files — disposition

| File | Disposition |
|------|-------------|
| `app/layout.tsx` | Reworked — auth gate, account switcher. |
| `app/page.tsx`, `components/DashboardClient.tsx` | Reworked — Supabase, account-scoped, real chart. |
| `app/positions/*`, `components/Positions*` | Reworked — Supabase, account-scoped. |
| `app/research/*`, `components/ResearchTable.tsx` | Reworked — data source → Supabase. |
| `app/screener/*`, `components/ScreenerTable.tsx` | Reworked — data source → Supabase. |
| `app/backtest/**`, `components/Backtest*`, `PerTradeChart`, `RunHistoryTable` | Reworked — Storage/Postgres source. |
| `components/EquityChart.tsx`, `HistoricalComparisonChart.tsx` | Reworked — `equity_snapshots`. |
| `components/Sidebar.tsx` | Reworked — account switcher, logout, real health. |
| `lib/github.ts` | **Deleted.** |
| `lib/types.ts` | Rewritten around the Supabase schema. |
| `lib/backtest-types.ts` | Kept (payload shape unchanged). |
| `app/api/live`, `api/data`, `api/spy-history`, `api/symbol-bars`, `api/alpha-tracker` | **Deleted / replaced.** |
| `app/api/backtest/**` | Reworked — Supabase source. |
| `lib/supabase/*` | **New** — server/client/middleware Supabase helpers. |
| `app/login/*`, `app/accounts/*`, `app/settings/*`, `app/trades/*` | **New** screens. |
| `middleware.ts` | **New** — auth protection. |

### B.2 Agent files — disposition

| File | Disposition |
|------|-------------|
| `scripts/accounts.py` | **New** — account context + Supabase access. |
| `scripts/supabase_client.py` | **New** — service-role client + helpers. |
| `scripts/portfolio.py` | Reworked — per-account, writes Supabase. |
| `scripts/execute_trades.py`, `trade.py` | Reworked — per-account `AccountContext`. |
| `scripts/utils.py` | Reworked — remove module-level Alpaca keys; add Supabase config. |
| `scripts/research.py`, `screener.py`, `perplexity_research.py` | Reworked — write `*_snapshots` + Storage; stay account-agnostic. |
| `scripts/update_spy_history.py` | Reworked — write `market_history`. |
| `scripts/strategy_config.py` | Add a `strategy_params` exporter; logic unchanged. |
| `scripts/backtest/run.py` | Add the Supabase upload step. |
| `.github/workflows/*.yml` | Reworked — new secrets, simplified commit step. |

### B.3 Target route map

```
/login                         public
/                              dashboard  (account-scoped)
/positions                     account-scoped
/trades                        account-scoped   (new)
/research                      shared
/screener                      shared
/backtest                      shared
/backtest/runs/[id]            shared
/accounts                      account management (new)
/settings                      profile (new)
```

---

## Appendix C — Decisions Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Supabase as the system of record | Owner's choice; bundles Postgres + Auth + Vault + Storage; available in this environment. |
| D2 | Supabase Auth, email/password, single-user | Owner's choice; sign-up disabled after the owner account exists (Q4 default). |
| D3 | Full multi-account agent | Owner's choice; the agent trades every active account, not just a viewer feature. |
| D4 | Equity curve from Alpaca Portfolio History | The only authoritative, retroactively-correct, multi-account-native source. |
| D5 | Backtest payloads in Supabase Storage | Removes the GitHub Contents API 1 MB ceiling (DEF-03). |
| D6 | Keys in Supabase Vault, server-only decryption | Strongest at-rest + in-transit posture; purpose-built. |
| D7 | Journals stay in git, per-account subfolders | Human narrative; low value in a DB; naturally versioned. |
| D8 | `state/*.json` kept as a committed audit backup for one release | Safe rollback during migration; re-evaluated after (Q3). |
| D9 | One source of truth for regime constants (`strategy_params`) | Kills the dashboard/backend drift (DEF-08). |

---

*End of specification. The build sequence is in `DASHBOARD_IMPLEMENTATION_PLAN.md`.*
