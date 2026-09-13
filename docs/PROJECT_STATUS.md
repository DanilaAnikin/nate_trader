# Nate Trader status — 2026-09-13

The authorized dashboard/database deployment is complete. Production serves
`d8288a31f884793197b6fa9f3ea8ac2b92b55a99` with writes enabled since
**2026-09-13 11:26:05 UTC**. Both the PR and exact merged-SHA release gates passed
all seven jobs ([PR gate](https://github.com/DanilaAnikin/nate_trader/actions/runs/34753945347),
[deployed source gate](https://github.com/DanilaAnikin/nate_trader/actions/runs/34754105214)).
The actual production database upgrade committed and all 549 final catalogue
objects match the rehearsed result. Public owner acceptance and containment
monitoring each passed 29 checks. [Deployment evidence](../ops/deployments/2026-09-13.json)
records the immutable image, database bundle, recovery and verification hashes.
The existing scheduled monitor also passed at 11:30:02 UTC with 29 checks,
zero failures/unknowns and no active dashboard restarts.

The paper executor remains approved at `115f11fd74591bb270e9529885ea19edf6eab923`
while an explicit handoff for its active monthly plan is being implemented.
Real-money trading is not enabled; the persisted forward epoch is unchanged.
The older `OVERVIEW.md` remains a dated architecture/recovery audit. Obsidian
history was reviewed across 71 previous session overviews, 340 prompts, 104
implementation summaries and 80 learning notes. Some summaries describe other
projects; repository and runtime evidence take precedence over those entries.

## Work recovered from the Claude sessions

- April–May: successive scoring, portfolio sizing, earnings and risk changes;
  the older V3–V10 plans remain historical references. Later review identified
  same-session timing and concentrated leverage as invalidating the old
  performance baseline.
- By August: V11 used causal D-close/D+1 targets, capped monthly equity
  momentum, fixed validation and a separate research tournament. No tournament
  challenger replaced V11.
- August 10–19: repeated dashboard and database audits concentrated on account
  ownership, Vault credentials, migration safety, artifact lineage and disaster
  recovery. The public deployment moved toward a frozen containment bridge;
  several development worktrees and release candidates remained separate.
- August 24–September 4: dashboard deployment, universe cleanup, shadow
  experiments, forward-epoch lookup and stale market-entry labels were updated.
- September 8–10: the user asked to finish unavailable panels and support a
  real Alpaca account. Commits added the live path, changed the sector cap and
  market-gate policy, repaired market-data download, refreshed canonical
  evidence, patched a Next.js vulnerability and corrected the preflight policy
  mirror. These changes had not all reached the public dashboard.

## Production baseline observed before deployment

| Boundary | Evidence observed on September 13 |
|---|---|
| Repository base | `115f11fd74591bb270e9529885ea19edf6eab923` on `main` |
| Approved paper release | The same full SHA, read from the GitHub `paper-production` environment |
| Release checks | [Successful exact-SHA release gate](https://github.com/DanilaAnikin/nate_trader/actions/runs/34491671781) |
| Latest scheduled paper cycle | [September 11 execution](https://github.com/DanilaAnikin/nate_trader/actions/runs/34632965595) succeeded, including broker preflight, execution and artifact upload |
| Public dashboard | `/api/health` reports build `ccde3a4bee25aed5d872194dddf593bd62e7369e`, `frozen-containment-bridge`, `writes_enabled=false`, `unfrozen_compatible=false`, `credential_mutation_compatible=false` |
| Production database | Read-only SSH confirms PostgreSQL 17.6, image `supabase/postgres:17.6.1.136`, Vault 0.3.1; project migration ledger is absent |
| Database compatibility | Legacy public schema lacks the new account lifecycle/refresh/verification objects; effective credential-helper grants also differ from checked-in 0003/0008 |
| Database ingress | Public Auth routes remain reachable; REST/GraphQL/Storage/Realtime/Functions are blocked with 403; relevant containers have no published Docker ports |
| Live GitHub environment | `live-production` is absent from the repository environments list |
| Canonical dataset | 532 ranking names; 544 symbols including auxiliaries; adjusted bars through 2026-09-04 |
| Forward epoch | Persisted baseline starts 2026-08-11 and binds the older `0cb02c0765ebf91e60e5efd7f51334e9b538fbcb` release |

A successful workflow is evidence of its recorded completion, not proof of
order fills or correct strategy behavior. The review found that this base
executor still liquidated below SMA200 while its backtest used the newer
graduated market gate. That discrepancy is repaired in the merged source; the running paper executor
will receive it only after the state handoff.
The initial workflow evidence came from Actions job/step status. Subsequent
runtime inspection found an active September plan with 10 targets and 15
broker-linked attempts, without complete month-convergence evidence. The
approved paper executor stays at `115f11fd74591bb270e9529885ea19edf6eab923`
until its state handoff is separately proved; dashboard deployment must not
silently promote that executor or replace its state with repository seeds.

## Merged repairs

- Align execution with the current monthly strategy: newly constructed targets
  below SPY SMA200 have at most 75% equity exposure; existing monthly plans
  stay frozen. Preserve HALT, sticky zero-target liquidation, cancellation,
  cash reconciliation and deferred replacement buys.
- Bind broker-mode selection to the strategy fingerprint. Reject non-finite
  spending limits; preserve exit access while the live entry kill switch is
  active, including a strictly verified short cover.
- Apply live spending checks to valid quantities and the actual rounded limit
  price sent to Alpaca. Invalid values must not poison the per-cycle budget.
- Fix the live workflow's missing offline-sanity configuration and treat typed
  confirmation as data instead of executable shell text.
- Emit mode-correct preflight records and structured runtime failures. Treat
  qualified `ABORT_*` and `ERROR_*` actions as failed production cycles.
- Select the dashboard's approval environment, workflow, steps, diagnostics and
  runtime artifacts together by broker mode. Reject paper/live mismatches;
  accept the two historical paper endpoint-check names without accepting
  duplicate evidence.
- Restrict authentication redirects to this application. Preserve refreshed
  session cookies through proxy redirects and authenticate every API path,
  including identifiers with image-like extensions.
- Use the internal Supabase URL for server traffic with the same browser/SSR
  cookie identity. Move profile preferences onto a session-bound API that
  validates ownership and respects maintenance mode.
- Show an unavailable backend when account discovery fails, rather than
  incorrectly reporting that the owner has no account selected.
- Correct current strategy and runbook documentation; retain older performance
  numbers as explicitly dated historical results.

## Verification

The final Python suite passes **800 tests** with Python 3.12.11 and the CI-pinned
pytest 9.1.1; the deployment lint passes with CI-pinned Ruff 0.16.1. Dependency
consistency also passes. The final dashboard unit/component
suite passes **1,227 tests in 54 files**; lint, TypeScript and the production
build pass. The dependency audit reports zero vulnerabilities. All **38
Playwright browser checks pass**. The separate Node owner-acceptance suite
passes **5 tests**. The release candidate also passed all seven CI jobs.

Canonical validation was rerun on September 13 after all strategy-identity
sources were stable: **PASS, 8/8 checks**. Every stored metric in all four
scenario/period combinations exactly reproduces the approved base report;
bar evidence is unchanged, and the code fingerprint and report digest were
regenerated. Starting capital is $1,000,000, development is 2021-01-04 through
2024-12-31 (1,005 sessions), and the reused temporal check is 2025-01-02 through
2026-09-04 (420 sessions). No parameter, date, universe or cost override was used.

| Per-fill cost | Development excess CAGR over SPY | Reused temporal excess CAGR over SPY |
|---|---:|---:|
| 7 bps | +20.1264 percentage points | +1.5258 percentage points |
| 15 bps | +19.1603 percentage points | +0.7705 percentage points |

These are historical comparisons on the same biased, previously inspected
dataset; they are not newly measured forward performance. The source is
`state/backtest/v11_validation.json`. The offline `sanity_check.py` passes on
the final tree, including strategy, universe, historical bars and report
identity; module imports remain free of broker calls.

Database verification uses disposable PostgreSQL 16 instances and the existing
test Vault scaffold. It checks real migrations, RLS, PostgREST, concurrent
transactions and Vault integrity; all four suites pass. It is not a rehearsal
against the production Supabase database or its real encryption keys.

After SSH access confirmed the actual platform, a separate isolated test on
`supabase/postgres:17.6.1.136` with real Vault 0.3.1 and a fresh test root key
applied all 23 unchanged migrations and passed all seven integration SQL
files. Real Vault encryption, decryption and rotation passed as well. This
revealed and repaired a test-only name collision: the account-deletion check
now qualifies its local `key_id` variable because real `vault.secrets` also
has a `key_id` column. Auth/Storage still use test scaffolding; this is not a
restore of the production database, roles, configuration or key.

The read-only production inspector completed with 29 JSON records on September
13 at 10:29:50 UTC. Checked credential/binding/Vault-reference and audit-shape
blocker counts were zero. Newer schema objects and the project migration ledger
were absent at that initial production observation. The inspector
was also checked on an empty database, a tracked database and 11 synthetic audit
shapes. Its successful execution is an inventory result; the completed recovery
and upgrade preparation below provides the subsequent evidence.

## Verified deployment preparation

- Fresh encrypted recovery set `nt-cutover-20260913T110048Z` passed 13 checks,
  including strict restore, all 63 table commitments, full security catalogue,
  actual Vault plaintext equivalence and negative controls. Both existing R2
  copies were downloaded and hash-verified; durable metadata and ciphertext
  remain under `/var/lib/homelab/nt-cutover-recovery/` on homelab.
- A second standalone restore passed 10 checks without contacting production.
  Secret scratch, data and configuration stay on private `noswap` tmpfs;
  restored containers have no network or broker access.
- Independent review accounted for every one of 24 catalogue differences:
  15 retained platform differences, six helper ACLs repaired by authored
  migrations and three missing objects repaired explicitly. Historical
  migration execution remains unknown; no 0001–0008 replay is allowed.
- The actual restored production database successfully committed the reviewed
  reconciliation and migrations 0009–0023. Its real-Vault lifecycle acceptance
  passed. Post-inspection confirmed the validated Vault FK, no missing profiles
  and no client credential-helper EXECUTE. Synthetic late-failure tests also
  prove the migration ledger and profile repair roll back together.
- The truthful ledger records the baseline attestation, actual three-object/
  one-profile repair and only the 15 migrations really executed. Production
  must match this successful rehearsal's exact final catalogue before commit.
- Operational sources now cover immutable dashboard staging/cutover, owner
  read acceptance and the containment monitor. They retain the Auth-only
  public gateway and do not dispatch trading or approve another executor SHA.

See [database evidence and sequence](DATABASE_UPGRADE.md),
[application deployment/rollback](../ops/DEPLOYMENT.md) and
[standalone recovery](../ops/recovery/README.md). Production subsequently passed
the same final catalogue contract and the public acceptance recorded above.

## Trading follow-up

The dashboard/database release, real owner/broker checks, internal Supabase
routing, cookie continuity and monitoring are complete. Remaining trading work:

1. Prove the runtime-state handoff and forward-epoch transition before approving
   a new trading release. Artifacts are SHA-scoped; a missing artifact falls back to
   repository seed state. Do not silently re-anchor the old baseline, copy a
   different account's history, or call pre-V11 equity V11 performance.
2. Configure and verify `live-production`, its required reviewer, protected
   deployment branches, exact approved release, separate live keys, account
   number and explicit dollar ceilings before any real-money dispatch.
3. Complete explicit producer cycle-outcome and coherent runtime generation
   work. This candidate fixes prefixed failures; it does not adopt the unsafe
   terminal-action-count heuristic from open PR #58. PR #63 duplicates work
   already merged through #64 and should be reviewed as repository housekeeping.
4. Continue frozen-rule forward paper observation. Historical data uses current
   universe membership and a reused temporal check; it cannot establish fresh
   forward alpha. Broader historical claims still need point-in-time membership
   and delisting evidence.

`UNAVAILABLE` remains correct when the approved epoch/account/release does not
match, private runtime evidence is missing, or the backend cannot provide a
fact. The repairs remove false unavailability and explain actual failures;
they do not fabricate missing portfolio observations.
