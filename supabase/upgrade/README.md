# Atomic legacy database upgrade

This tool upgrades the explicitly reviewed legacy Nate database to authored
migrations `0009`–`0023`. It does not assert that `0001`–`0008` ever ran in
production. The fresh `0008` reference is a comparison contract, not invented
migration history.

The inspected production baseline also lacked its authored Auth profile trigger
and two private artifact read policies. `baseline_reconciliation.sql` restores
exactly those three demonstrated omissions and backfills only missing profiles
using the original trigger mapping. This explicit 2026 repair has a separately
hashed review and `nate_migrations.baseline_reconciliations` execution record; it
does not replay historical migrations or manufacture default accounts.

`nate_migrations.baseline_attestations` records the reference, reviewed observed
catalog, recovery evidence, release source hashes and unknown historical
execution. `nate_migrations.applied_migrations` records only the 15 files executed
in the same successful transaction. No Supabase ledger is manufactured. This
bounded runner refuses either an existing Nate ledger or a Supabase ledger;
future upgrades need a separately reviewed plan.

## Boundaries and prerequisites

- PostgreSQL is pinned to `server_version_num = 170006`; the reference uses
  `supabase/postgres:17.6.1.136` at the digest recorded in `runner.py`.
- The operator must independently identify the production connection and stop
  application writers before deployment. The SQL additionally asserts the
  expected database name, current role, exact catalog and PostgreSQL version.
- Capture a fresh backup and verify an isolated restore, including actual Vault
  decryption controls, before supplying its evidence SHA-256. A synthetic fixture
  is not production recovery evidence.
- Rehearse on that restore clone first. Production bundles require its complete
  successfully rehearsed final catalog, and reject any different final result
  before commit.
- The migration role needs public/database `CREATE` and Vault `REFERENCES`, plus
  ownership needed by authored DDL. Rehearsal proves the complete capability set.
  Membership in `supabase_storage_admin` is not required by `0009`–`0023`; this was
  exercised with `postgres` after removing that membership on the reference.
  The actual three-object reconciliation additionally requires the explicitly
  authenticated `supabase_admin` session and `--session-role supabase_admin`.
  The runner asserts `session_user`, then uses `SET LOCAL ROLE postgres` for
  ordinary application DDL. Only the two Storage policies use a narrowly scoped
  `SET LOCAL ROLE supabase_admin`; no role memberships are granted.

`catalog.sql` compares definitions, owners, effective ACL entries, columns,
constraints, indexes, sequence definitions, triggers, policies, rules and custom
domain/enum/range metadata in the application schema. It also includes Auth
identity helpers, the application Auth trigger, Storage object policies, relevant
schema ACLs, role attributes and memberships, default ACLs, extension versions and
hashed database/role settings. It excludes table contents, sequence counters,
passwords and extension internals. This application upgrade contract complements
the broader recovery verifier; it does not replace platform restore validation.

## Private artifacts and explicit review

Full routine bodies and defaults can contain accidentally embedded credentials.
Keep snapshots and generated SQL in a private directory, preferably tmpfs, or
encrypt them for retention. Never commit them or print them in logs. The CLI
writes artifacts with mode `0600`, refuses symlink output targets and prints only
digests, counts and bounded status evidence. Connection argv files are private too.

A connection file is a JSON array of the command and its arguments, followed by
the tool's mandatory `psql -X -qAt -v ON_ERROR_STOP=1` flags. For example, an
isolated local container can use:

```json
["docker", "exec", "-i", "owned-disposable-clone", "psql", "-U", "postgres", "-d", "postgres"]
```

Use PostgreSQL's private password file or another established protected transport;
do not put production passwords into argv. `runner.py` never invokes a shell.

1. Build a fresh authored `0001`–`0008` reference on the pinned image. Record the
   build provenance; the existing catalogue-classify harness provides a content
   digest over its bootstrap, fixture and authored migration inputs. Its synthetic
   platform bootstrap can differ from production and is not automatically trusted
   as a matching production baseline.
2. Run `capture --stage reference-0008` and `capture --stage observed`, each with
   `--connection` and `--output`. A capture uses a read-only repeatable-read
   transaction. All 23 authored file hashes bind the snapshot to this release.
3. Run `compare --reference ... --observed ... --output ...`. It creates an
   **UNREVIEWED** manifest containing the identity and both payload hashes for
   every changed, missing or additional object, without publishing definitions.
4. Review the private full payloads. Fill in reviewer, concrete reference
   provenance, and a reason and disposition for **every exact delta**, then set
   `status` to `REVIEWED`. Supported dispositions are
   `replaced-by-authored-migrations`, `retained-platform-difference` and
   `repaired-by-baseline-reconciliation`. None
   permits additional changes or a wildcard. Do not approve an unexplained
   function body, ACL, role, default ACL or platform difference simply because
   the object name looks familiar. The source reference and observed digests must
   remain unchanged.
   Reconciliation is permitted only for the exact three missing object identities;
   the review must include `reconciliation.source_sha256` for that SQL file and
   the count-only observed `reconciliation.expected_missing_profiles`. The
   transaction rejects a different missing-profile count or public/missing
   artifact buckets.
5. Run `build` with the reviewed reference/observed/review paths, explicit
   `--database`, `--role`, `--session-role` when required, `--recovery-sha256`,
   `--purpose rehearsal`, and private
   `--output` and `--manifest` paths. A rehearsal bundle is not the production
   release input.
6. Run `apply --connection ... --bundle ... --expected-sha256 ... --evidence ...`
   on the isolated restore clone. Check successful evidence, the read-only
   inspector and synthetic lifecycle acceptance. Capture its final catalog with
   `--stage rehearsed-0023`.
7. Build with `--purpose production --final-snapshot ...`, preserving the reviewed
   original baseline and verified recovery evidence. Review the resulting manifest
   and exact bundle SHA-256 as the deployment input. Only the deployment owner
   applies this bundle to the independently verified production connection.

The SQL uses `ON_ERROR_STOP`, an advisory transaction lock, explicit application
table locks and exact baseline checks before and after acquiring those locks. It
embeds the unchanged authored migration bytes and verifies safety postconditions,
the rehearsed final catalog and the exact applied-version set. Ledger creation,
attestation and all 15 migrations commit together. Transactional
`NOTIFY pgrst, 'reload schema'` is delivered only on a successful commit.

A connection failure after commit can make the client outcome ambiguous.
`NOT_CONFIRMED` means inspect the ledger before deciding what happened; it does
not claim rollback and must not trigger an automatic retry. SQL diagnostics are
hashed, not emitted, because server errors can contain private values.

`supabase/production_inspection.sql` reports the legacy Supabase ledger and the
honest Nate baseline/applied ledger separately. Its aggregate hashes/shape checks
are an operational check, not a substitute for comparing release source hashes
and the exact private final catalog.

## Repeatable verification

```bash
.venv/bin/python -m pytest -q tests/test_database_upgrade.py
python3 supabase/tests/run_upgrade.py
```

The integration harness requires a local Docker socket and an existing verified
`0008` catalogue-classify reference image. It creates only uniquely named,
network-isolated disposable containers and removes only those containers. Tests
cover exact baseline drift, missing ledger evidence, rollback after all migration
statements, replay refusal, final-contract mismatch rollback and successful
production-contract application on a second identical fixture. The synthetic
legacy fixture includes all three omissions and one missing profile, and proves
that the separately recorded reconciliation rolls back too. All fixture data
and recovery hashes in that harness are explicitly synthetic.
