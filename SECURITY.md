# Security Policy

`nate_trader` is a personal autonomous trading agent. It holds credentials that
can place real orders (Alpaca paper or live), call paid APIs (Perplexity), and
post notifications (ClickUp). Treat these credentials like cash.

## Reporting a vulnerability

If you find a security problem (leaked credential, injection in a script,
unauthorized order path, etc.):

1. **Do not open a public issue.**
2. Use GitHub's private vulnerability reporting:
   https://github.com/DanilaAnikin/nate_trader/security/advisories/new
3. Or email the repo owner directly.

You should expect an acknowledgement within a few days.

## What's in scope

- Code under `scripts/` and `.github/workflows/`.
- Configuration files that get committed (`watchlist.json`, `strategy/`, etc.).
- Anything that could leak `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`,
  `PERPLEXITY_API_KEY`, `CLICKUP_API_TOKEN`, or any other secret.

## What's out of scope

- Trading-strategy performance ("strategy lost money") — that's a strategy
  issue, not a security issue. Open a normal issue with the `risk` or
  `strategy` label.
- Upstream issues in `alpaca-py`, `requests`, `pandas`, etc. — those go
  upstream. Dependabot tracks them here.

## Secret handling rules

- Secrets live **only** in GitHub Actions Secrets and the developer's local
  `.env`. They are never committed.
- The `.gitignore` excludes `.env*` and `*.key`.
- A new credential should be rotated immediately if it has ever been pasted
  into a non-Secrets location (logs, journal entries, chat).
- See the `## Secrets & API keys` section in `CLAUDE.md` for the canonical
  list of required environment variables.

## Push protection

GitHub's repo-level secret scanning is GHAS-only (paid) on private repos.
As a free alternative this repo relies on:

- **User-level push protection** (free): enable at
  https://github.com/settings/security_analysis — blocks pushes that contain
  recognized token formats from any repo you push to.
- `pip-audit` in the `Code Quality & Security` workflow — flags vulnerable
  dependencies on every push to `main`.
- `bandit` in the same workflow — static scan for unsafe Python patterns.
