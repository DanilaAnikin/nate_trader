# Production database upgrade evidence and sequence

The authorized production upgrade **committed on 2026-09-13 at 11:21:35 UTC**.
All 15 migrations 0009–0023, the three-object reconciliation and one missing
profile are recorded in the Nate ledger. The 549-object production catalogue
exactly matches the successful rehearsal, SHA-256
`46bb15185a56f43857db277317f0394efc2005c8a7fe9bc4f45ee811f9fdce58`.
The read-only production inspector returned 32 records with consistent ledger
hashes and postconditions. No historical migration execution was invented.

Dashboard `d8288a31f884793197b6fa9f3ea8ac2b92b55a99` became active with writes
enabled at 11:26:05 UTC. Public owner/account/broker acceptance passed all 29
checks; containment monitoring passed 29 checks with zero failures or unknowns.
Public Supabase data-plane routes remain denied; Auth remains available.
See [the immutable deployment evidence](../ops/deployments/2026-09-13.json)
and [application rollback procedure](../ops/DEPLOYMENT.md).

The legacy apply command below is retained as the exact historical input.
**Do not rerun it on production:** its existing ledger correctly causes refusal.

## Completed recovery and migration preparation

- Fresh recovery set: `nt-cutover-20260913T110048Z`, verified at 11:01:23 UTC.
  Its durable homelab directory is
  `/var/lib/homelab/nt-cutover-recovery/nt-cutover-20260913T110048Z/`.
  Manifest SHA-256:
  `ec752f0a0fbd1e7d744f198133fe0e1e78eeeb58e4834e9b0ac5a29fea91fef1`.
- All 13 recovery checks passed: strict restore, all 63 table commitments,
  complete security catalogue, Vault plaintext commitment and rejection of
  damaged ciphertext, wrong passphrase, truncated archive and wrong Vault
  root key. Both existing R2 copies were downloaded and hash-verified before
  completion markers were published.
- Recovery includes globals, actual `/etc/postgresql` and custom configuration,
  the separately encrypted root key, and platform metadata omitted by pg_dump.
  Plaintext and clone data stay on private `noswap` tmpfs; process/container
  swapping is disabled. Clones have no network, published ports or broker access.
- A second standalone restore, `nt-cutover-20260913T110308Z-db`, passed 10
  checks at 11:03:41 UTC without contacting production. The first clone,
  `nt-cutover-20260913T110048Z-db`, was handed to migration rehearsal.
  Failed disposable clones and their scratch mounts were removed.
- Exact baseline review found 24 differences: 15 retained platform differences,
  six excess helper EXECUTE grants replaced by authored migrations, and three
  missing objects repaired explicitly. Full definitions remain private.
- The real restored-clone upgrade committed and its real-Vault lifecycle
  acceptance passed. Rehearsal bundle SHA-256:
  `d71a2d9c6aa8b7a3d0d69de6f5043acea300aaa2c9c8ef713409398cd416eac0`.
  Post-inspection confirms 15 executed migrations, three repaired objects,
  one repaired profile, a validated Vault FK, zero missing profiles and no
  client credential-helper EXECUTE. This is clone evidence, not production.

The reviewed reconciliation restores exactly the missing Auth profile trigger
and two private artifact SELECT policies, and backfills one missing profile
using the original display-name/email mapping. Existing profiles, accounts,
broker bindings, deleted accounts and Vault secrets are not modified by that
repair. It fails if omissions, missing-profile count or private buckets differ.
The Storage policies restore the original authenticated bucket-read contract;
the public Storage/data-plane denial remains in place.

The authenticated session is `supabase_admin`, with ordinary DDL executed as
`postgres`. Only the two Storage policies use a narrow admin-role window.
No role memberships are granted. Reconciliation source SHA-256:
`2f54095ea8384dd31643131094c264b7a7328922b5d8df573b7556e13fd32ac8`.
Reviewed delta manifest SHA-256:
`25352b9cb9c798f009343272284bb2f11f216c04317eed8543a48b66cc9b6b63`.

The [atomic runner](../supabase/upgrade/README.md) records unknown historical
execution in `nate_migrations.baseline_attestations`, the actual repair in
`baseline_reconciliations`, and only the 15 executed files 0009–0023 in
`applied_migrations`. It does not manufacture a Supabase ledger or replay
0001–0008. Reconciliation, migrations, postconditions and ledger share one
transaction; the production bundle must match the successful rehearsal's final
catalogue. Existing migration history causes this bounded legacy runner to
refuse replay.

Private working evidence is under `/dev/shm/nt-upgrade-20260913T110048Z/`:
`review.json`, `rehearsal-manifest.json`, `rehearsal-evidence.json` and
`post-inspection.jsonl`. Keep full catalogues and generated SQL private or
encrypted; never commit them. See [recovery operations](../ops/recovery/README.md)
and [application deployment operations](../ops/DEPLOYMENT.md).

## Production starting boundary, observed before upgrade

| Item | Observed state |
|---|---|
| Database | `natetrader-supabase-db-1`, PostgreSQL **17.6** (`170006`), image `supabase/postgres:17.6.1.136` |
| Vault | `supabase_vault` 0.3.1; `vault.secrets` owned by `supabase_admin` |
| Project migration ledger | `supabase_migrations.schema_migrations` **absent**; platform Auth/Storage/Realtime ledgers are separate |
| Application schema | 14 public base tables; no safe views, lifecycle/refresh/verification RPCs, token/operation tables or `accounts.credential_version` |
| Credential helpers | Legacy public Vault wrappers exist, but `anon` and `authenticated` can execute them and `get_account_credentials`; these are `SECURITY DEFINER` |
| Client table permissions | Both client roles have broad effective table/column privileges on `accounts`, `trades`, `cash_flows`; RLS remains enabled |
| Public database ingress | Auth routes alone are permitted; REST, GraphQL, Storage, Realtime, Functions and catchall requests return **403** |
| Direct container ingress | DB, Kong, REST and dashboard containers have no published Docker ports |
| Dashboard | Frozen bridge `ccde3a4bee25aed5d872194dddf593bd62e7369e`; write and credential mutation compatibility remain false |

This is **not a verified 0001–0008 baseline**. In particular, the effective
credential-helper grants contradict the explicit revocations in migrations
0003 and 0008. Object names alone cannot establish an applied migration or
its body, grants, trigger state or ownership. Do not invent a ledger entry
claiming those files ran, or run the entire migration directory over this
database as though it were empty.

The public deny boundary currently contains the legacy database API. Direct
Vault table denial does not make a callable `SECURITY DEFINER` helper safe.
Preserve the Auth-only gateway and the dashboard freeze throughout preparation;
opening REST would expose a different security boundary from the one inspected.
These observations establish reachability and privileges, not evidence of abuse.

The deployed dashboard already has nonempty internal/public Supabase settings,
cookie identity, service-role configuration, GitHub settings and production
viewer bindings. Presence was checked without printing their values; it does
not validate the credentials or bind them to a future image. The runtime uses
a compiled freeze, so absence of the maintenance environment variable does
not indicate that writes are enabled.

## Repeatable inspection

From the repository root:

```bash
ssh -T -o BatchMode=yes homelab \
  'sudo -n docker exec -i natetrader-supabase-db-1 psql -X -w -qAt -U postgres -d postgres -v ON_ERROR_STOP=1' \
  < supabase/production_inspection.sql
```

The inspector uses one repeatable-read, read-only transaction with statement
and lock timeouts, then rolls back. It emits JSON lines containing server and
ledger metadata, required-object presence, effective client privileges and
aggregate migration blockers. It does not call credential helpers, decrypt
Vault values, emit account identifiers or create a migration ledger. A query
error exits nonzero; a missing table is reported as unavailable where its
absence can be inspected safely. A successful exit means the inventory ran,
**not** that the database is ready for an upgrade.

The aggregate checks cover ambiguous credential assignments, missing Vault
references, missing/duplicate broker bindings, deleted accounts retaining
credentials and existing audit shapes that can stop migration 0022. A zero
count is a useful prerequisite, not proof of all migration postconditions.
The audit counts do not reproduce the full 0023 predicate: broker-number
matching, UUIDs in object keys and traversal budgets require separate checks
in the migration rehearsal.

The production run at **2026-09-13 10:29:50 UTC** completed successfully with
29 JSON records and `transaction_read_only=on`. Its credential/binding and
Vault-reference blocker counts were all zero; the audit-shape checks also
found no blockers. That removes these particular data issues from the current
known blockers. Baseline review, fresh recovery and actual restored-clone
rehearsal subsequently completed as recorded above. The inventory itself
executed no production migration or credential helper.

## Executed deployment sequence

1. **Capture and reconcile the baseline.** Bind a complete catalog comparison
   to a database snapshot: owners, roles/memberships, RLS/policies, table and
   column ACLs, routine bodies and grants, default privileges, constraints,
   indexes and triggers. Compare with a clean reference on the exact Supabase
   image. Record the existing drift separately from historical migration
   evidence. A reviewed baseline/reconciliation procedure must establish the
   starting contract and future migration tracking; absent historical evidence
   must remain explicit.
2. **Prove recovery using the matching platform.** Use a complete verified
   recovery set containing the database, globals/role memberships, database
   configuration and the matching Vault/pgsodium root key. Restore to an
   isolated network and disposable volumes with no broker access. Require a
   strict, successful restore and compare data/catalog evidence from the same
   snapshot. Verify Vault decryptability inside the clone using the reviewed
   protocol that emits only verification results. Never print secrets or
   substitute a fresh key for the production recovery key.
3. **Rehearse the complete migration path on that clone.** Once the legacy
   baseline is established, the intended newer contract is 0009 through 0023
   in numeric order, followed by explicit checks of final RPC behavior, RLS,
   ACLs and the mandatory validated Vault foreign key. Use stop-on-error and
   transactional application; never continue after a failed file or serve
   traffic from a partly migrated schema. Keep migration files immutable.
4. **Resolve actual data blockers explicitly.** Migrations 0019/0020 refuse
   ambiguous credentials or broker bindings; 0022 refuses duplicate bindings
   and scans existing audit details. In 0022, even an otherwise harmless array
   can hit the recursive guard bug before 0023 gets a chance to fix it.
   Do not delete audit history, guess a credential owner, disable the guards,
   or skip directly to 0023. Any necessary historical-data treatment or
   transition procedure needs its own reviewed evidence and clone rehearsal.
5. **Test the new dashboard against the migrated clone.** Check login/session
   cookie continuity, owner isolation, account discovery, profile updates,
   history reads and the account lifecycle with synthetic broker fixtures.
   The old frozen bridge is a read-only fallback; its legacy Vault write
   wrappers are deliberately disabled by 0022 and cannot be restored by
   simply removing the freeze.
6. **Prepare one reviewable release and rollback.** Bind the candidate image,
   source SHA, passing release checks, migration procedure, verified recovery
   set, runtime settings and acceptance probes. Preserve the existing internal
   Supabase route and cookie identity. Deployment is already authorized; apply
   only the reviewed production bundle and selected immutable image. Database
   rollback after migration is a verified recovery operation, not merely
   switching the dashboard image back.

The first five stages were exercised against the actual restored database,
then the authorized production step completed. Its bundle was built with `--purpose production`, the
successful `--final-snapshot`, `--database postgres --role postgres
--session-role supabase_admin`, the original reviewed baseline and the fresh
recovery manifest hash. Apply through the independently verified private
production connection with an explicit `--expected-sha256`. The runner checks
the target/session identity, exact baseline before and after table locks,
immutable migration/reconciliation bytes, final catalogue and honest ledger.
PostgREST receives schema reload only after commit.

The following exact command committed successfully at 11:21:35 UTC. It is
historical evidence, not an instruction to reapply the upgrade:

```bash
python3 supabase/upgrade/runner.py apply \
  --connection /dev/shm/nt-upgrade-20260913T110048Z/connection-production.json \
  --bundle /dev/shm/nt-upgrade-20260913T110048Z/production.sql \
  --expected-sha256 8f5126445f97a38dc364c13d158180f15255d4f9b50d1b4b9b32118eb639b74b \
  --evidence /dev/shm/nt-upgrade-20260913T110048Z/production-evidence.json
```

Its manifest SHA-256 is
`15694810619a0f65a3877bd8a0a33b8f8b8d1df0e90dd63a260136a443dcd265`.
The successful actual-clone final catalogue contains 549 objects, SHA-256
`46bb15185a56f43857db277317f0394efc2005c8a7fe9bc4f45ee811f9fdce58`.
The deployment owner must retain private SQL/catalogue evidence encrypted
before removing its temporary workspace; none belongs in Git.

`NOT_CONFIRMED` can mean a connection failed after commit: inspect the actual
ledger before deciding what happened, and never automatically retry. A
pre-commit SQL failure rolls back the entire upgrade. After commit, switching
dashboard routes leaves the database upgraded. Full database recovery would
discard subsequent database changes and requires a distinct controlled restore.

The historical recovery tooling lives in the separate homelab worktree:
`/home/anakin/wt/hl-r0/scripts/nt-recovery-set.sh` and
`/home/anakin/wt/hl-r0/self-healing/nt-restore-drill.sh`. Their existence does
not prove that the deployed copies match them or that a current recovery set
has passed. Inspect current evidence and review their exact revisions before
running them; the recovery builder publishes encrypted backup components.

Read-only inspection found two local `/home/anakin/nt-r0/*/verdict.txt` files,
both dated **2026-08-12**, reporting 44 passes and zero failures. The
`nt-recovery-set-last-ok` marker also dates from August 12. These are historical
records. They were not used to satisfy recovery acceptance; the fresh September
13 set and independent offline restore above provide that evidence.

## Local compatibility evidence

A fresh, isolated container using
`supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00`
(the observed production image tag) passed all 23 unchanged migrations and all
seven integration SQL files on September 13. Vault 0.3.1 performed real
encryption, decryption and rotation using a new test key. The only repair was
in `supabase/tests/account_lifecycle.test.sql`: qualify the local credential
IDs to avoid a name collision with real Vault's `key_id` column.

The container had no published port, production mount or broker access.
Auth/Storage were test scaffolds, and the database used fresh test data and
roles. This establishes a useful platform compatibility check; it does not
replace recovery and upgrade rehearsal against the actual production state.
The inspector also passed missing-schema and readable-ledger checks, 11 audit
shape fixtures, and a negative control that replaced the expected Vault foreign
key with a validated RESTRICT foreign key on the wrong source column. The
final inspector correctly rejected that misleading constraint.

Database/dashboard release is separate from approving a new paper trading
release, transferring its runtime state, or configuring a real-money account.
None of those operations follows automatically from a successful schema check.
