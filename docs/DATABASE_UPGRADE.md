# Production database upgrade evidence and sequence

Observed on 2026-09-13 by read-only SSH and catalog queries. This is an upgrade
plan, not a migration runner or approval to change production.

## Current production boundary

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
  'docker exec -i natetrader-supabase-db-1 psql -X -w -qAt -U postgres -d postgres -v ON_ERROR_STOP=1' \
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
known blockers, while leaving baseline drift and recovery/upgrade rehearsal
unresolved. No production migration or credential helper was executed.

## Sequence before changing production

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
   Supabase route and cookie identity. Only then request approval for the
   concrete production change. Database rollback after migration is a verified
   recovery operation, not merely switching the dashboard image back.

The historical recovery tooling lives in the separate homelab worktree:
`/home/anakin/wt/hl-r0/scripts/nt-recovery-set.sh` and
`/home/anakin/wt/hl-r0/self-healing/nt-restore-drill.sh`. Their existence does
not prove that the deployed copies match them or that a current recovery set
has passed. Inspect current evidence and review their exact revisions before
running them; the recovery builder publishes encrypted backup components.

Read-only inspection found two local `/home/anakin/nt-r0/*/verdict.txt` files,
both dated **2026-08-12**, reporting 44 passes and zero failures. The
`nt-recovery-set-last-ok` marker also dates from August 12. These are historical
records, not a newly verified recovery of the September deployment; they do
not satisfy step 2 for the current state.

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
