# Nate Trader

[![Code Quality & Security](https://github.com/DanilaAnikin/nate_trader/actions/workflows/code-quality.yml/badge.svg)](https://github.com/DanilaAnikin/nate_trader/actions/workflows/code-quality.yml)
[![Premarket Research](https://github.com/DanilaAnikin/nate_trader/actions/workflows/premarket-research.yml/badge.svg)](https://github.com/DanilaAnikin/nate_trader/actions/workflows/premarket-research.yml)
[![Market-Open Execution](https://github.com/DanilaAnikin/nate_trader/actions/workflows/market-open-execution.yml/badge.svg)](https://github.com/DanilaAnikin/nate_trader/actions/workflows/market-open-execution.yml)

> **Nate Trader** is an autonomous, regime-adaptive **momentum swing-trading agent** for US equities. It runs entirely on scheduled GitHub Actions against Alpaca paper trading, with a single goal: **beat the S&P 500 (SPY) by +5% per month** through disciplined, catalyst-driven swing trades held 2–10 days.

The repository is the agent. Five GitHub Actions workflows wake up on the Eastern-Time market clock, run a chain of Python scripts that screen the market, score candidates against a 100-point confidence model, place limit orders with trailing stops on Alpaca, manage open positions, write a daily journal, and commit all state back to `main`. A Next.js dashboard reads the same state files for a human-readable view.

---

## Table of Contents

- [What it does](#what-it-does)
- [How it thinks — the strategy in one screen](#how-it-thinks--the-strategy-in-one-screen)
- [Architecture](#architecture)
- [Daily routine schedule](#daily-routine-schedule-eastern-time)
- [Repository layout](#repository-layout)
- [Quickstart](#quickstart)
- [Running locally](#running-locally)
- [GitHub Actions schedule](#github-actions-schedule)
- [Dashboard](#dashboard)
- [Backtesting](#backtesting)
- [Risk, safety, and operational guardrails](#risk-safety-and-operational-guardrails)
- [Further reading](#further-reading)

---

## What it does

Nate Trader is structured as a hedge-fund analyst pipeline expressed entirely as small, composable Python scripts:

1. **Discovers** candidates — a screener pulls Alpaca's most-active and top-mover lists and combines them with a "trending tickers" feed from Perplexity, on top of a curated `watchlist.json` core list.
2. **Researches** every candidate — pulls daily bars from Alpaca, computes a full technical stack (SMA-20/50, RSI-14, MACD, volume ratio, 20-day momentum, relative strength vs. SPY), classifies recent news headlines with a sentiment-keyword scan, and (for top candidates) runs a deep-dive Perplexity query for catalyst confirmation.
3. **Scores** each candidate on a **0–100 confidence scale** — Technical (≤37) + News (≤35) + Perplexity (≤30) — and maps it to **BUY / HOLD / SELL**.
4. **Detects market regime** from SPY's relationship to its 20-/50-day SMAs — **BULL**, **NEUTRAL**, or **BEAR** — and the active **risk tier** (NORMAL / CAUTIOUS / HALT) from drawdown. Every threshold, position size, stop width, and cash floor below is resolved from this `(regime, risk_tier)` pair via [`scripts/strategy_config.py`](scripts/strategy_config.py).
5. **Validates and trades** — `execute_trades.py` runs the 5-question entry checklist, sizes positions by the lesser of allocation cap and per-trade dollar risk, places **limit-only** orders on Alpaca paper, and immediately attaches a trailing stop.
6. **Manages open positions** — tightens stops once a trade is in profit, scales 50% off at the regime's profit target, takes a final exit, and force-closes any position that violates the time stop.
7. **Hedges** — when SPY regime weakens, the engine automatically takes a position in **SH** (1× inverse-SPY ETF) sized to a regime-dependent percentage of equity. The hedge bypasses sector caps and the HALT block.
8. **Journals and persists** — every routine writes a dated journal entry under `journal/`, refreshes `state/*.json`, and commits the changes back to `main` so the next routine resumes from a known-good checkpoint.

Everything is **paper-trading only** by default (`paper=True` in the Alpaca client). No real money is at risk in the default configuration, and there are no live account numbers or secrets in this repository.

---

## How it thinks — the strategy in one screen

### The 5-question entry checklist (all must be YES)

| # | Question | Gate |
|---|----------|------|
| 1 | **Trend** | Price > 20-SMA **and** > 50-SMA |
| 2 | **Catalyst** | `news_score > 5` **or** `perplexity_score > 10` |
| 3 | **Volume** | `volume_ratio ≥ volume_min_ratio` (1.0 / 1.2 / 1.5 by regime) |
| 4 | **Relative strength** | 20-day return − SPY 20-day return ≥ `rs_alpha_min` |
| 5 | **Confidence** | `score ≥ score_threshold` (55 BULL / 65 NEUTRAL / 80 BEAR) |

If cash > `max_cash_pct`, the confidence threshold is lowered by `cash_starve_bonus` to force capital deployment in strong markets (with a hard floor of 40).

### Regime-adaptive risk knobs

| Knob                 | BULL / NORMAL | NEUTRAL / NORMAL | BEAR / NORMAL |
|----------------------|--------------:|-----------------:|--------------:|
| Max position size    | 6%            | 5%               | 2%            |
| Min cash reserve     | 5%            | 20%              | 40%           |
| Risk per trade       | 1.0%          | 0.7%             | 0.3%          |
| Trailing stop        | 8%            | 8%               | 6%            |
| Scale-out gain       | +10%          | +10%             | +7%           |
| Final target         | +20%          | +15%             | +12%          |
| Time stop            | 12d / +4%     | 10d / +5%        | 7d / +3%      |
| Max open positions   | 15            | 12               | 8             |
| Sector cap           | 25%           | 25%              | 25%           |
| Bear hedge (SH)      | 0%            | 10%              | 25%           |

**CAUTIOUS** (triggered by weekly P&L ≤ −2%) halves position size, tightens stops, and lifts the confidence bar by ~10. **HALT** (monthly P&L ≤ −5%) blocks every new directional buy — only the SH hedge and position management still run.

A universal **−3% daily P&L halt** stops all new buys for the day; existing stops still trigger.

The full table — including RSI sweet spots, tightened stops, and recovery protocol — lives in [`strategy/rules.md`](strategy/rules.md) and [`strategy/risk_management.md`](strategy/risk_management.md).

---

## Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │              GitHub Actions cron            │
                  │   premarket → open → midday → EoD → weekly  │
                  └────────────┬────────────────────────────────┘
                               │
                  ┌────────────▼────────────┐
                  │     scripts/*.py        │   (Python pipeline)
                  │                         │
   ┌──────────────┤  screener.py            │
   │              │  research.py            │
   │              │  perplexity_research.py │
   │              │  strategy_config.py     │
   │              │  execute_trades.py      │
   │              │  trade.py / portfolio.py│
   │              │  write_journal.py       │
   │              └────────┬────────────────┘
   │                       │
   │       reads/writes    │     places orders
   │              ▼        ▼            ▼
   │     ┌────────────┐   ┌──────────────────────┐
   │     │  state/    │   │  Alpaca paper API    │
   │     │  journal/  │   │  (market data + exec)│
   │     │  memory/   │   └──────────────────────┘
   │     └────────────┘
   │              ▲                       ▲
   │              │                       │ optional
   │              │              ┌────────┴────────┐
   │              │              │ Perplexity API  │
   │              │              │ ClickUp (notify)│
   │              │              └─────────────────┘
   │              │
   │     ┌────────┴───────────────────────┐
   └────►│       dashboard/ (Next.js)     │  human-readable view
         └────────────────────────────────┘
```

State is **plain JSON in `state/`**, journals are **markdown in `journal/`**, and everything is committed back to `main` after each routine, so the entire history of the agent is reconstructible from `git log`.

---

## Daily routine schedule (Eastern Time)

| # | Routine                  | Time              | Workflow file                                             | Purpose                                                                 |
|---|--------------------------|-------------------|-----------------------------------------------------------|-------------------------------------------------------------------------|
| 1 | Pre-Market Research      | 9:45 AM Mon–Fri   | [`premarket-research.yml`](.github/workflows/premarket-research.yml) | Screener scan, technicals, news + Perplexity scoring                   |
| 2 | Market-Open Execution    | 10:00 AM Mon–Fri  | [`market-open-execution.yml`](.github/workflows/market-open-execution.yml) | Validate and place limit orders + trailing stops                       |
| 3 | Midday Scan              | 1:00 PM Mon–Fri   | [`midday-scan.yml`](.github/workflows/midday-scan.yml)    | Sync stops, fire stop-losses, refresh research                          |
| 4 | End-of-Day Summary       | 4:15 PM Mon–Fri   | [`end-of-day-summary.yml`](.github/workflows/end-of-day-summary.yml) | Final P&L, journal entry, ClickUp recap, benchmark vs. SPY              |
| 5 | Weekly Review            | 6:00 PM Friday    | [`weekly-review.yml`](.github/workflows/weekly-review.yml) | Performance grading, strategy review, watchlist refresh                 |
|   | Update SPY History       | 4:45 PM Mon–Fri   | [`update-spy-history.yml`](.github/workflows/update-spy-history.yml) | Append the day's SPY bar for benchmark tracking                         |
|   | Backtest (on demand)     | `workflow_dispatch` | [`backtest.yml`](.github/workflows/backtest.yml)        | Single / sweep / Monte-Carlo / walk-forward / compare runs              |
|   | Code Quality & Security  | on push to `main` | [`code-quality.yml`](.github/workflows/code-quality.yml)  | Ruff lint, `pip-audit`, secret scanning gate                            |

Each scheduled workflow checks out `main`, runs its scripts, saves state, commits, and pushes back to `main`. There are no feature branches and no PRs for routine work — every routine commit lands directly on `main` and is timestamped in the message.

---

## Repository layout

```
nate_trader/
├── scripts/                       Python pipeline
│   ├── execute_trades.py          Orchestrates buys, sells, hedge, profit-taking
│   ├── trade.py                   Order placement, stop management, validation
│   ├── portfolio.py               Account, positions, performance, risk-tier
│   ├── research.py                Bars, technicals, news, confidence scoring
│   ├── screener.py                Most-active, movers, trending discovery
│   ├── perplexity_research.py     Deep-dive catalyst & outlook scoring
│   ├── strategy_config.py         Regime × risk-tier parameter resolver
│   ├── write_journal.py           Daily markdown journal generator
│   ├── notify.py                  ClickUp notifications
│   ├── update_spy_history.py      Appends SPY bars for benchmark tracking
│   ├── backfill_daily_history.py  One-off historical state backfill
│   ├── ta/                        Technical-analysis helpers
│   └── backtest/                  Backtesting engine (engine, sweep, walk-forward, Monte-Carlo)
├── strategy/
│   ├── rules.md                   Entry / exit / scoring rules in full
│   ├── risk_management.md         Drawdown tiers, stops, hedge mechanics
│   └── sp500_benchmark.md         Alpha-tracking methodology and grading
├── state/                         JSON state — research, screener, positions, performance
├── journal/                       Daily markdown trading journal (YYYY-MM-DD.md)
├── memory/                        lessons_learned.md + watchlist_history.md
├── dashboard/                     Next.js 16 / React 19 UI reading state/*.json
├── watchlist.json                 Curated "always research" core list
├── .github/workflows/             Scheduled GitHub Actions (the agent's heartbeat)
├── CLAUDE.md                      Operating manual for the agent
├── SECURITY.md                    Secret handling & dependency policy
└── README.md                      You are here
```

---

## Quickstart

### Requirements

- **Python 3.11+**
- **Node.js 20+** (only if you want to run the dashboard)
- An **Alpaca paper-trading account** (free) — https://alpaca.markets
- *(Optional)* A **Perplexity API key** for catalyst research
- *(Optional)* A **ClickUp API key + list ID** for daily push notifications

### Install

```bash
git clone https://github.com/DanilaAnikin/nate_trader.git
cd nate_trader
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### Environment variables

The scripts read credentials from environment variables (or a local `.env` — `.env` is gitignored and **must never be committed**):

| Variable             | Required | Used by                                            |
|----------------------|:--------:|----------------------------------------------------|
| `ALPACA_API_KEY`     | ✅       | All trading, market data, screener calls           |
| `ALPACA_SECRET_KEY`  | ✅       | All trading, market data, screener calls           |
| `PERPLEXITY_API_KEY` | optional | `perplexity_research.py`, screener trending feed   |
| `CLICKUP_API_KEY`    | optional | `notify.py` end-of-day recap                       |
| `CLICKUP_LIST_ID`    | optional | Target list for `notify.py` (defaults to a stub)   |

Create a local `.env` like:

```dotenv
ALPACA_API_KEY=PK...
ALPACA_SECRET_KEY=...
PERPLEXITY_API_KEY=pplx-...
CLICKUP_API_KEY=pk_...
CLICKUP_LIST_ID=901217466513
```

In GitHub Actions, the same variables come from **repository Secrets** — they are never echoed into logs or committed to state.

---

## Running locally

All scripts live in `scripts/` and expose a CLI mode. The same commands the scheduled workflows run on GitHub Actions:

```bash
# Pre-market research (Routine 1)
python3 scripts/screener.py full
python3 scripts/research.py report
python3 scripts/perplexity_research.py enhance
python3 scripts/perplexity_research.py enhance-screener
python3 scripts/portfolio.py save

# Market-open execution (Routine 2)
python3 scripts/execute_trades.py dry-run       # preview only — no orders placed
python3 scripts/execute_trades.py run           # places real (paper) orders

# Midday scan (Routine 3)
python3 scripts/execute_trades.py midday
python3 scripts/research.py report

# Ad-hoc inspection
python3 scripts/portfolio.py account
python3 scripts/portfolio.py positions
python3 scripts/portfolio.py performance
python3 scripts/research.py symbol AAPL
python3 scripts/research.py spy
python3 scripts/trade.py market                 # is the market open?
python3 scripts/trade.py sync-stops             # attach missing trailing stops
```

Every command is **read-only or paper-trading**; nothing in this repo touches a live brokerage account.

---

## GitHub Actions schedule

The five trading workflows are cron-scheduled in UTC (with comments noting the corresponding ET time) and run only on weekdays. Each one:

1. Checks out `main`.
2. Installs `requirements.txt`.
3. Reads secrets from the repository's Actions Secrets store.
4. Runs its routine's scripts.
5. Commits any changes to `state/`, `journal/`, `memory/`, `watchlist.json` with a `routine: <name> YYYY-MM-DD` message.
6. Pushes back to `main`.

The `Code Quality & Security` workflow runs on every push that touches Python files or `requirements.txt` and gates merges with Ruff lint and a `pip-audit` dependency scan. Dependabot opens weekly PRs against `main` for pip and GitHub Actions updates.

Manual trigger is available on every workflow via the **Run workflow** button (`workflow_dispatch`), including the backtest matrix.

---

## Dashboard

A minimal Next.js 16 / React 19 + Tailwind 4 dashboard lives in [`dashboard/`](dashboard/). It reads the same JSON files the agent writes, so it is a pure view layer with no separate database:

```bash
cd dashboard
npm install
npm run dev          # http://localhost:3000
```

Pages: equity curve, positions table, screener candidates, research grid, backtest comparison, and run history.

---

## Backtesting

The backtest engine in [`scripts/backtest/`](scripts/backtest/) replays the exact same strategy code against historical bars. The `Backtest` workflow exposes five modes via `workflow_dispatch`:

| Mode            | Purpose                                                                  |
|-----------------|---------------------------------------------------------------------------|
| `single`        | One run over a date range with the current parameters                     |
| `sweep`         | Grid-search a parameter (e.g. `score_threshold`) and rank by Sharpe/alpha |
| `monte-carlo`   | Resample trades to estimate the distribution of outcomes                  |
| `walk-forward`  | Optimize in-sample, evaluate out-of-sample, roll forward                  |
| `compare`       | Diff two parameter sets head-to-head                                      |

Any change to scoring, thresholds, or regime rules **must cite a backtest** — see the GitHub Collaboration section of [`CLAUDE.md`](CLAUDE.md).

---

## Risk, safety, and operational guardrails

- **Paper only** — Alpaca clients are constructed with `paper=True`. There is no code path that enables live trading.
- **Limit orders only** — every order is a DAY limit; no market orders, ever. Unfilled orders are cancelled after 30 min and reassessed.
- **Layered halts** — daily −3% halt, weekly −2% → CAUTIOUS, monthly −5% → HALT. HALT blocks every new directional buy.
- **Sector cap** — 25% of equity per sector, enforced in `validate_order`.
- **Position cap** — 2–6% per position by regime; 8–15 max open positions by regime.
- **Trailing stops** — placed automatically after every fill and tightened once trades go into profit.
- **Hedge** — automatic SH allocation scales with regime to dampen drawdowns; exempt from sector cap, position-count cap, and the HALT block.
- **No secrets in the repo** — `.env`, `.env.local`, and any file with credentials are gitignored. All keys live in GitHub Actions Secrets or your local `.env`. See [`SECURITY.md`](SECURITY.md) for the secret-handling and dependency-vulnerability policy.

---

## Further reading

- [`CLAUDE.md`](CLAUDE.md) — operating manual for the autonomous agent: identity, routines, GitHub collaboration rules, git workflow.
- [`strategy/rules.md`](strategy/rules.md) — entry, exit, and scoring rules in full.
- [`strategy/risk_management.md`](strategy/risk_management.md) — drawdown tiers, stop mechanics, hedge sizing, recovery protocol.
- [`strategy/sp500_benchmark.md`](strategy/sp500_benchmark.md) — alpha-tracking methodology and weekly performance grading.
- [`SECURITY.md`](SECURITY.md) — secrets policy, dependency audits, and the `Code Quality & Security` gate.

---

*Nate Trader is a research and educational project running against an Alpaca paper account. Nothing in this repository is financial advice. Trade real capital at your own risk — and only after running the strategy through the backtest engine end-to-end.*
