# schema-compat — does the bridge actually run on both schemas?

`./run.sh`

The bridge image has to serve a database that may still be at migration
**0008** (nothing after it applied) *or* already at **0023**. That claim was
previously supported by reading migrations 0009-0023 and grepping the ported
code for object names. The grep is exact about **names** and silent about
everything else: a name that still exists in `pg_proc` passes a grep even when
the function has been replaced by a tombstone and its EXECUTE grant revoked.
This harness replaces the grep with something that runs.

## What it does

| # | Step | Why it is done this way |
|---|------|-------------------------|
| 0 | Resolves `supabase/postgres:17.6.1.136` **locally** and refuses to run without it | The exact production image, never a tag that can drift |
| 1 | Enumerates migrations from disk and asserts `0001..0008` is contiguous | A missing file would silently shrink the reference schema |
| 2 | Starts two servers; waits for **5 consecutive** successful semantic queries **over TCP as `supabase_admin`** | `pg_isready`, and any socket probe, can succeed against the temporary init server that is about to be shut down and re-initialised |
| 3 | Applies `sql/00_env_bootstrap.sql`, then asserts `public` is still empty | See "the storage bootstrap" below |
| 3b | **Control:** feeds the applier `select 1/0` and requires a non-zero exit *whose stderr says `division by zero`* | Proves `ON_ERROR_STOP=1` is really in force. "Some non-zero exit" would not |
| 4-5 | Applies 0001-0008 to one server and 0001-0023 to the other, `ON_ERROR_STOP=1`, in order | The two reference schemas |
| 5b | Asserts the two schemas differ in object count | Otherwise "compatible with both" is vacuous |
| 6 | Seeds fixture data into both; the seed asserts its own row counts | A seed that silently seeded nothing makes every later query trivially succeed |
| 7 | Enumerates every route under `app/api` **from disk**, walks each one's transitive local import closure, and extracts every `.from("X")` / `.rpc("Y")` | Every real database call lives in `lib/`, not in the route file |
| 8 | **Control:** runs the catalogue query against two objects that must exist and two that cannot, and asserts the exact expected verdict string | A check that cannot fail is worse than no check |
| 9 | Looks up every extracted object in `pg_class` / `pg_proc` on both servers | Existence decided by the live catalogue, never by reading a migration |
| 9b | **Calls** each extracted function as `service_role` and records the SQLSTATE | The catalogue says the object exists; only a call says the bridge can use it |

## Three failure classes, reported separately

* **ABSENT** — the routes name an object that is not in the catalogue. This is
  the deploy blocker the exercise was originally about.
* **UNPRIVILEGED** — the object exists, but the role that call site actually
  connects as holds no usable privilege on it. The required role comes from the
  extractor's per-call-site attribution (`getSupabaseService()` →
  `service_role`, `getSupabaseServer()` → `authenticated`), not from assuming
  `service_role` everywhere.
* **RUNTIME DENIED** — the function was called for real and answered `42501`.

## The harness currently exits 1, and that is the finding

Against the 0001-0023 schema:

```
| function | vault_create_secret | PRESENT | ... SECURITY INVOKER | NO-EXECUTE |
| function | vault_delete_secret | PRESENT | ... SECURITY INVOKER | NO-EXECUTE |
| function | vault_update_secret | PRESENT | ... SECURITY INVOKER | NO-EXECUTE |

vault_create_secret | service_role | 42501 | DENIED | permission denied for function vault_create_secret
vault_update_secret | service_role | 42501 | DENIED | permission denied for function vault_update_secret
vault_delete_secret | service_role | 42501 | DENIED | permission denied for function vault_delete_secret
```

Migration `0022_fingerprint_binding_and_token_generations.sql` deliberately
tombstones those three wrappers — it rewrites each body to
`raise exception '… is superseded …'` and revokes EXECUTE from
`public, anon, authenticated, service_role`, then asserts in its own
post-conditions that nobody can execute them. `lib/accounts/credentials.ts`
calls all three directly, so on a post-0022 database the bridge's account
create / key rotate / credential purge paths fail.

They are all behind `maintenanceBlock`, so with `DASHBOARD_MAINTENANCE_MODE`
on they are unreachable. With the freeze off, against a 0023 database, they
are not. This also contradicts the reasoning written into `lib/maintenance.ts`
("those operations do **not** start failing after the migrations … every one
still succeeds") — after 0022 they do.

## Proving the check can fail

```
./run.sh --self-test
```

injects an extra route naming `nt_selftest_table_that_cannot_exist` and
`nt_selftest_function_that_cannot_exist`, and then requires *those two exact
names* to appear in the ABSENT list of *both* schemas. It is not satisfied by
"the run failed" — the run already fails for the real finding above.

The extractor fails closed in its own right:

* a file under `app/api` that is neither a Next.js route file nor a test → hard error;
* a local import that cannot be resolved → hard error;
* a `.from()` / `.rpc()` whose object is not a string literal → hard error
  ("the schema check cannot prove an object it cannot name");
* a count assertion that every `.from(`/`.rpc(` token in a file was classified,
  so a call form the regex does not understand cannot be silently dropped.

## The storage bootstrap

`supabase/migrations/0006_storage_policies.sql` writes to `storage.buckets` and
creates policies on `storage.objects`. Nothing in `supabase/migrations/`
creates those tables and neither does the postgres image — the storage-api
service creates them from its own migration set, as `supabase_storage_admin`,
when it first starts. Against a bare database 0006 therefore fails with
`relation "storage.buckets" does not exist`.

`sql/00_env_bootstrap.sql` reproduces exactly those two tables under their real
owner and grants `postgres` membership of that role the way a hosted project
does. It creates nothing in `public`, and run.sh asserts `public` is still
empty afterwards, so the bootstrap can never mask a missing public-schema
object.

## Scope

Default scope is the route surface under `dashboard/app/api`, which is what the
proof was asked for. `--include-pages` widens it to the server components,
server actions and the edge proxy; the only object that adds is `profiles` read
as **`authenticated`** from `lib/account-context.ts`, which still holds
`SELECT, UPDATE` at 0023.

The runtime probe (step 9b) calls functions as `service_role` only. Relations,
and objects required by `authenticated`, are covered by the catalogue privilege
check rather than by a live call.

Nothing here contacts a broker, Alpaca, or any production system. Every
credential-shaped value in the fixtures is a literal string saying it is not a
credential, and the e-mail address is on the reserved `.invalid` TLD.

## Files

```
run.sh                      orchestrator; the only thing you need to run
extract-route-objects.mjs   route discovery + import closure + object extraction
sql/00_env_bootstrap.sql    the storage tables storage-api owns
sql/05_controls.sql         the negative control for the catalogue query
sql/10_seed.sql             fixture data, with its own assertions
sql/20_check.sql            catalogue existence + per-role privilege
sql/30_runtime_probe.sql    call each named function as service_role
```

## Exit codes

| code | meaning |
|------|---------|
| 0 | every named object exists, with usable privileges, in both schemas |
| 1 | a deploy blocker (absent / unprivileged / denied), or a completed `--self-test` |
| 2 | the harness itself failed (docker, image, migration, seed, extractor) |
| 3 | a negative control misbehaved — nothing this run says can be trusted |
