# The catalogue classifier

`42501 is never proof of an intentional tombstone.`
`And "none of these four roles can call it" is never proof that nobody can.`
`And a clean verdict on four objects says nothing about the fifth.`

## Why this exists

The schema-compat harness on `bridge/pre-migration-containment` calls each
routine the dashboard names as `service_role` and records the SQLSTATE. On the
latest schema `vault_create_secret`, `vault_update_secret` and
`vault_delete_secret` answer `42501`, and the harness reported a deploy blocker.

That reading is wrong, but the fix is not "treat 42501 as fine". Migration
`0022_fingerprint_binding_and_token_generations.sql` section 5 deliberately
tombstones those three wrappers: it rewrites each body to

```
raise exception '<name> is superseded and must not be called; see supabase/migrations/0022'
  using errcode = 'P0001';
```

and revokes `EXECUTE` from `public`, `anon`, `authenticated` **and**
`service_role`. The `42501` is the intended outcome — but exactly the same
`42501` is produced by an accidental `REVOKE`, by a routine somebody replaced
with a no-op and then locked down, and by a routine whose owner changed. A
classifier that reads the SQLSTATE and stops cannot tell those apart, and the
whole point of this directory is that it must.

Section 5 tombstones **five** routines, not three: `record_account_verification`
and `create_account_atomic` alongside the three Vault wrappers.

## Coverage is itself a control

The first version of this classifier carried four expectation rows against that
five-routine migration. `create_account_atomic` and
`record_account_verification` therefore received **no verdict row at all** —
their ACL, body, owner and executability were never examined — and the run
still reported `PASS`. Granting `EXECUTE` on either of them back to
`service_role` passed cleanly. So did dropping the tombstone entirely,
reinstalling migration 0021's live body, granting it to `service_role` and
having `service_role` call it and receive a real `accounts` row.

Nothing about that was visible in the output. The report showed four objects,
all green, and there is no way to notice a missing row by reading a list of
rows that are present. An omission from a hand-written list is invisible **by
nature**, so the repair is not a longer list:

* the name set is **read out of migration 0022** at run time, and 0022 states
  it twice — section 5 tombstones the routines, section 6 asserts none of them
  is executable. `extract-tombstone-template.py` extracts both lists
  independently and **refuses** when they disagree, so "these are all of them"
  is a checked claim rather than an assumption;
* control **`C20`** fails the run when any name in that set has no expectation
  row, in either generation. **`C21`** additionally requires the *states* to
  agree: on the latest chain the set expected `TOMBSTONED` must equal the set
  0022 tombstones, in both directions; on the 0001-0008 chain, where 0022 has
  not run, nothing may be expected `TOMBSTONED`;
* control **`C25`** asserts the other half — that a verdict was actually
  *reached* for each of them, so an expectation row dropped by a join one stage
  later fails just as loudly;
* control **`C23`** is the positive control on the comparator all three depend
  on. It must report a planted missing name and stay silent on a complete set,
  because "no name is uncovered" is an absence claim and an absence claim from
  an unproven scanner is worth nothing;
* the falsification suite requires every name **the migration set** tombstones —
  the extractor's union over both shim mechanisms and every file, which is
  eight, not five — to be the **key of at least one mutant**, and runs the
  coverage control's own red-before: it
  doctors the classifier so one expectation row is missing and requires the run
  to come back `CONTROL_FAILED` with `C20` naming that routine.

The two routines that were invisible now carry an expectation in both
generations. They were introduced by migrations 0014 and 0018, so on the
0001-0008 reference chain the honest expectation is that they are **not there**
— which is why there is an `ABSENT` / `EXPECTEDLY_ABSENT` pair, and why
back-porting one of them onto the reference schema is a finding (mutant 55)
rather than an unexamined blank.

### The coverage the report publishes, and the number that was true by construction

The JSON report used to publish `coverage.tombstoned_by_0022` — the narrow
migration-0022-section-5 list — beside `coverage.uncovered`, computed as *that
same list* minus the catalogue. It printed `[]` whatever the catalogue did or
did not cover, and a reader took the empty array for "nothing is missed". A
coverage number computed over the set whose completeness is the question is not
a check; it is a restatement.

Both keys are gone. What the report publishes now:

| key | what it is |
|---|---|
| `derived_tombstone_set` | the extractor's **union over both shim mechanisms across every migration file** — currently 8 names from `0017` and `0022` |
| `derived_from` | `mechanisms` (`inline=3,template=5`), `sources`, `names_by_source`, `migration_files_scanned` — the provenance travels with the set |
| `section5_loop_names`, `section6_restated_names` | the narrow lists, kept **as the narrow lists**, cross-checked against each other by `C20` |
| `expectation_covers`, `verdicts_reached_for` | what the hand-written catalogue names, and what a verdict was actually reached for |
| `uncovered_by_expectation` | `derived_tombstone_set` **minus** the catalogue |
| `uncovered_by_verdict` | `derived_tombstone_set` **minus** what was verdicted |

Both differences are now taken against the independently derived set, so a
catalogue that misses a name produces a non-empty array instead of a reassuring
zero. The mutation suite reads these keys, asserts each is present before
indexing it, recomputes both differences itself and fails if the report's own
subtraction disagrees, and requires `derived_tombstone_set` to be a **strict
superset** of `section5_loop_names` — the shape a derivation narrowing back to
one mechanism would break. Its success line prints the counts and the
provenance rather than a fixed sentence, because a green line that misstates
its own scope is how a narrowing goes unnoticed.

**The residual limit is inherent and is stated in `pass_does_not_claim`:**
`uncovered_by_*` and `C20` are both computed *from* the extractor's derivation,
so a **third** shim mechanism the extractor does not recognise would be missed
by all of them. Widening the reader does not close that; only a different kind
of evidence would.

## The states

| state | meaning | verdict |
|---|---|---|
| `MISSING` | the exact `regprocedure` signature is not there — nothing of that name, only a different overload, an ambiguous bare name, or the name now belongs to a procedure or a relation | always a blocker |
| `LIVE_EXPECTED` | the object matches the LIVE profile in full **and** LIVE is what this generation expects | pass |
| `INTENTIONALLY_TOMBSTONED` | the object matches the TOMBSTONE profile in full **and** a tombstone is what this generation expects | pass |
| `EXPECTEDLY_ABSENT` | the signature is not in the catalogue **and** this generation predates the routine — used for the two routines 0022 tombstones that migrations 0014/0018 introduced, so every name 0022 names carries a verdict row in *both* generations | pass |
| `UNEXPECTED_EXECUTABLE` | some routine reachable under this name — the exact signature, another overload, or a same-name routine in another schema — can be executed by a role that is not allowed to | blocker |
| `UNEXPECTED_PRESENT` | an unexpected routine is present under this name but nothing unexpected can execute it: an extra overload, an alternate-schema shadow, or the *other* profile than the one expected here | blocker |
| `DEFINITION_DRIFT` | owner, language, security mode, volatility, `search_path`, arguments, return type or body is not what the expected profile calls for, or a probe reached the body and it answered wrongly | blocker |
| `AUTHZ_CLOSURE_BROKEN` | **nothing about this object moved** — byte-identical body, right owner, right grants, every probe answering correctly — and the authorization it exists to provide is gone anyway, because something it *depends on* moved: the definition of a function its pinned body calls, the identity of a relation its pinned body reads, RLS switched off on a table its policy guards, or the set of policies routing through it | blocker |
| `ACL_DRIFT` | the definition is intact and nothing unexpected can execute it, but the privilege surface moved: a grant that should be there is gone, the default-privilege surface widened, the superuser set changed, or a call the profile expects to succeed was refused with 42501 | blocker |
| `UNPROVEN` | the probe that would have decided did not run | never a pass |

`AUTHZ_CLOSURE_BROKEN` is a state of its own rather than a flavour of
`DEFINITION_DRIFT` because naming it definition drift would name the wrong
object, naming it `ACL_DRIFT` would name the wrong mechanism, and folding it
into `UNPROVEN` — which is what happened before these codes were ranked at all
— would say the check did not run when in fact it ran and failed. It outranks
everything except a role that can execute something it should not.

`INTENTIONALLY_TOMBSTONED` is reached only when **all** of this holds:

* exact 0022 semantics — a normalised body equal to the tombstone the migration
  itself writes, the derived SQLSTATE and the derived message, proven by a
  *privileged* invocation with zero side effects;
* owner and administrative properties equal to the migration's result;
* **no** ordinary application role can execute it — by grant, by `PUBLIC`, by
  default privilege, by direct or inherited role membership, or by `SET ROLE`;
* **no** unexpected role of any kind can, `supabase_auth_admin` and roles
  created five minutes ago included;
* no unexpected overload, and no same-name routine in another schema that an
  unexpected role could call;
* the environment surface — default function privileges, the superuser set — is
  where the migration chain left it.

Observation is computed **without** consulting the expectation for the
generation under test; only then is it compared:

```
final = EXPECTEDLY_ABSENT        when ABSENT expected and the signature does not resolve
      = UNEXPECTED_PRESENT       when ABSENT expected and anything answers the signature
      = MISSING                  when the signature does not resolve
      = LIVE_EXPECTED            when observed LIVE and LIVE expected
      = INTENTIONALLY_TOMBSTONED when observed TOMBSTONED and a tombstone expected
      = UNEXPECTED_PRESENT       when observed is cleanly the OTHER profile
      = the drift state          otherwise
```

which is what makes *a live wrapper on the latest schema* and *a tombstoned
wrapper on 0001-0008* blockers rather than quiet passes.

The run is `PASS` only when every row's `final` is **exactly** the one outcome
its `expected_state` calls for — `LIVE → LIVE_EXPECTED`,
`TOMBSTONED → INTENTIONALLY_TOMBSTONED`, `ABSENT → EXPECTEDLY_ABSENT` — and the
number of verdict rows equals the number of expectation rows.

## The authorization predicate is probed negatively, and its body is pinned

`owns_account(uuid)` is the `SECURITY DEFINER` function behind RLS on
`positions`, `performance`, `equity_snapshots` and `routine_runs`, so it is the
one object here where "the function said yes when it should" is only half a
claim. The other half is who else it says yes to, and that needs negative
probes:

```
as A:  owns(A's account)  -> true     the predicate is not simply always false
as A:  owns(absent id)    -> false
as A:  owns(B's account)  -> false    ownership, not existence
as B:  owns(B's account)  -> true     it tracks the subject, not a constant
as B:  owns(A's account)  -> false
as C:  owns(A's account)  -> false    C is a subject that owns nothing (C22)
as C:  owns(B's account)  -> false
none:  owns(A's account)  -> false    no subject is not "every subject"
none:  owns(B's account)  -> false
```

The last two are what catch `owner_id = auth.uid() or auth.uid() is null` — a
body that authorises every account for any caller arriving without a JWT and
that answers the first three questions exactly as the real one does (mutant
50).

A backdoor of the form `or auth.uid() = '<a uuid the attacker holds>'` answers
all **nine** correctly, because no probe holds that uuid. No truth table over a
fixed set of subjects can catch it. So the normalised body is also pinned by
digest in `cc_expect.live_body_sha256`, exactly as the tombstone body is pinned
by the template derived from 0022, and `live:body_mismatch` is what fires
(mutant 51). The two checks are complementary and neither is sufficient alone.

The pin is a digest because two of the six bodies are ~2 kB of plpgsql and
embedding those would put a second copy of the migration in this directory. The
observed normalised body and its digest are both in the JSON report, so a
mismatch is diagnosable; and control **`C24`** binds the one digest that carries
an authorization decision to a plaintext written out in the classifier, so that
digest is reviewable by reading rather than by trust. A row may only skip the
pin by being `ABSENT`, and a table constraint enforces exactly that — a nullable
column with no constraint would be a silent opt-out of the strongest check in
the file.

### The pin and the probes together are still not enough

Those two were once described here as *jointly sufficient* for the claim "this
routine authorises exactly the owner". They are not, and the gap is not subtle.
Both are claims about the routine's **own text and own answers**, and that text
is

```sql
select exists (select 1 from accounts
                where id = acct and owner_id = auth.uid()
                  and deleted_at is null);
```

whose only non-trivial term is `auth.uid()` and whose only relation is
`public.accounts`. Neither was checked. Redefine `auth.uid()` so that a chosen
JWT claim returns an attacker-held uuid and `owns(A)` becomes true for that
caller — while the pinned digest stays **byte-identical** and all nine probes
answer correctly, because no probe sets that claim. The same applies one level
out: the predicate only guards anything because RLS is **enabled** on the tables
whose policies call it, and `alter table positions disable row level security`
is a total bypass touching neither the routine, nor its ACL, nor its body.

So the **dependency closure** is pinned as well (classifier section 2d), and a
break in it is its own final state, `AUTHZ_CLOSURE_BROKEN`:

| pinned | reason code on a break | mutant |
|---|---|---|
| every schema-qualified function the pinned body calls — body digest, owner, language, security mode, volatility, `proconfig`, overload count | `dep:function_drift` | 60 |
| every relation the pinned body reads — `relkind`, owner, `rowsecurity` | `dep:relation_drift` | 61 |
| RLS **enabled** on every table a policy routes through the predicate | `dep:rls_disabled` | 62 |
| the exact set of policies **that route through the predicate**, with their commands and `USING` expressions | `dep:policy_set_changed` | 63 |
| the **complete** policy set of every table in the closure — count, name, command, permissive/restrictive, role list, `USING` digest and `WITH CHECK` digest of each | `dep:guarded_policy_set_changed` | 64, 65 |
| a key declares a closure but none was observed | `dep:closure_missing` | none — unreachable by construction; see the justification in the mutant suite, and control `C29` |

Mutants 60–65 each leave `body_matches_pin` **true** and every probe answer
correct in the JSON report. That is the demonstration that the closure — and
nothing else — is what catches them.

### ADV-1: why the last row exists

Every check above the last row asks *"is the policy I know about still there
and still saying what it said"*. PostgreSQL **ORs permissive policies
together**, so that question has a `true` answer in a database where the
predicate decides nothing:

```sql
create policy "read_all" on public.positions for select using (true);
```

`read own positions` is byte-identical. RLS is still on. `auth.uid()` and
`public.accounts` are untouched, so `C27`/`C28`/`C34` are unchanged. All nine
`owns_account` probes still answer correctly, including the discriminating one:
`owns_account(another owner's account)` is still `false`. And the
`dep:policy_set_changed` row above does not see it either, because that row
aggregates only policies whose `USING` clause matches `%owns_account%`, and
`true` does not mention it.

**Measured before the fix:** the classifier returned `PASS` on the mutated
clone, and in that same clone `authenticated`, carrying the *other* fixture
owner's JWT subject, read the victim account's `positions` row while
`owns_account(victim)` answered `false` in the same session. Dropping the
planted policy took the same query back to zero rows, and the real owner still
read one — so the measurement distinguishes the bypass from the baseline.

The expectation *shape* was wrong, not the expectation: **"the policy I know
about is intact" instead of "the policy SET is exactly this"**. The last row
pins the set, with its cardinality carried inside the compared string, so an
**addition** is a finding and not only an edit. Mutant 64 is the case above;
mutant 65 is the same shape against an arm whose pinned value is the **empty
set** (`public.accounts` on the latest schema carries RLS and no policy at all,
i.e. deny-all to every client role) — an empty set being exactly what a scanner
that stopped scanning would also report.

**Which tables, measured rather than assumed.** On `latest`, exactly
`equity_snapshots`, `performance`, `positions` and `routine_runs` carry a policy
whose `USING` routes through `owns_account`; on `0008`, `cash_flows` and
`trades` do too. `public.accounts` is pinned as well — it is not guarded *by*
the predicate, it is the relation the predicate *reads*, and it is already in
this closure by `relkind`, owner and `rowsecurity`.

**Search-path independence.** `pg_get_expr` renders a call relative to the
caller's `search_path`, and the classifier connects as `supabase_admin`, whose
path is `"$user", public, auth, extensions` — so `auth.uid()` came back as
`uid()` and the first version of this pin was a pin on the connecting role's
settings. Every expression this arm compares is now rendered under a fixed
`search_path = pg_catalog`, which fully qualifies everything, and `C35` counts
how many routed policies render schema-qualified so a regression there is loud.

**Residual limit, stated plainly.** The closure is pinned for `owns_account`
only, it is one level deep, and its `function`/`relation` arms are checked for
completeness against the **union** of the pinned body text and the pinned
policy expressions by a parser (`C27`, controlled by `C28`). A function that `auth.uid()` itself calls is *not* pinned. The
`rls`/`policyset` arms cannot be derived from the body at all — which tables the
predicate guards is not visible in the predicate — so those lists are written
out per generation, and `C34`/`C35` are what stop them from being short: they
require every table carrying a policy whose `USING` clause routes through
`owns_account` to have an `rls` row *and* a `policyset` row, comparing the typed
lists against one the database produces. A routed table neither list names makes
the run **refuse** (`CONTROL_FAILED`), not merely report; the suite plants
exactly that (`--only C34n`) and requires `C34`, `C35` and `C37` — the ADV-2
arm's completeness control — to be the only three failing controls, all naming
the planted table.

What the policy-set pin does **not** close: a permissive policy on a `public`
table that is not in this closure — on generation `latest` there are **seven**
such tables, named in the last row of the client-read-surface table below — is
outside it, because this closure is `owns_account`'s and those tables do not
route through it. The names are typed in exactly one place in this document,
that row, and that row is the one the suite checks: the list is derived by
control `C39`,
published as `authz_closure.outside_closure_policy_bearing`, interpolated into
`pass_does_not_claim`, and the mutation suite refuses a run whose document and
report disagree about it. A whole-schema policy pin would be a
different control from a different premise and this file does not have one.

## ADV-2 — what makes a policy irrelevant without changing it

**RLS being ENABLED is necessary and not sufficient.** Of the guarded tables
themselves the classifier pinned exactly two things — `relrowsecurity`, and
(since ADV-1) the complete policy set — and nothing else: not the owner, not
`FORCE`, not `relkind`, not an inheritance edge, not a view. An audit obtained a
clean `PASS` while `authenticated` read every tenant's rows, two ways; measuring
the rest of the class found two more, and a fourth that is not hypothetical in
this schema. All four were
reproduced on a fresh clone of generation `latest` with the attacker as fixture
owner `4444…` and the victim account `2222…` (21 `equity_snapshots` rows), and
in every one of them `public.owns_account('2222…')` answered **false** in the
same session that read the rows.

| # | mechanism | measured effect | now pinned as |
|---|---|---|---|
| C | `alter table public.equity_snapshots owner to authenticated` | 21 rows. A table's **owner is exempt from its own RLS policies** unless `FORCE ROW LEVEL SECURITY` is set. Reverting the owner: 0 rows | `owner` + `forcerowsecurity`, per guarded table |
| D | `alter role authenticated bypassrls` | measured with a reversion control: `equity_snapshots` 0 &rarr; **21** &rarr; 0, `profiles` 1 &rarr; **2** (both tenants) &rarr; 1, `audit_log` 0 &rarr; **1** &rarr; 0. Every table in the database, not only the closure | `env:bypassrls_set_drift`, cluster-wide |
| E | `alter table public.equity_snapshots inherit <new parent>` | 21 rows through the parent. A query applies the policies **of the relation named in it**; the child's own policies are not consulted | `inheritance`, per guarded table |
| F | a **view** over a guarded table, or a widened existing one | 21 rows. A view runs in the **view owner's** row-security context unless it is `security_invoker` | `dependent_rels`, per guarded table |

**Why nothing already in the file saw them.** `relrowsecurity` was pinned;
`relforcerowsecurity` was not, anywhere. The **owner** was pinned for
`public.accounts` and for routines — never for the guarded tables. `rolsuper`
was pinned and `pg_auth_members` was pinned, but `rolbypassrls` appeared
**nowhere in the artefact**: it is a role *attribute*, so it is neither of the
other two, and granting it moved neither fingerprint. `pg_inherits` and
`pg_depend` were never read at all. And no mutant in the 71-entry suite targeted
a guarded-table owner or a role attribute — mutants 10 and 30 change a
*routine's* owner, 26 adds a *superuser*, 37/39/45/49 move *memberships*.

**F is the live one.** On generation `latest` the client's only read path to
`accounts`, `cash_flows` and `trades` is three views — `accounts_safe`,
`cash_flows_safe`, `trades_safe` — owned by `postgres`, which carries
`BYPASSRLS`, granted `SELECT` to `authenticated`, and scoping rows by a `WHERE`
clause **in the view body** rather than by any policy. Measured: dropping
`owner_id = auth.uid()` from `accounts_safe` handed the attacker every tenant's
account row while RLS stayed enabled on `public.accounts`, its pinned **empty**
policy set stayed empty, and the classifier returned `PASS`. The authorization
of the entire client read path was pinned nowhere. It is now pinned by relkind,
owner, `reloptions`, grant list and a digest of the definition, with the
definition itself published in plaintext in the report
(`authz_closure.dependent_view_pin_plaintext`) so the `WHERE` clause is
reviewable by reading rather than by hashing.

**The table set is the same one ADV-1 uses**, so the two arms cannot drift apart,
and `C37` requires the `guarded` arm to name exactly the tables `pg_policy`
routes through `owns_account` plus `public.accounts`, with all six properties
present on every one — a property deleted from the cross join, or a table
deleted from the list, makes the run **refuse**. `C38` is the positive control:
it builds a throwaway subject carrying every shape at once *and* a clean one
carrying none, and requires each observer to see its shape on the first and not
on the second. Its negative half is **planted, not borrowed** — an earlier draft
read `public.positions` for it, and mutant 67 (which sets FORCE on that table)
turned the control red, reporting "the classifier cannot be trusted" for what
the `guarded` rows had already reported correctly.

**Measured and deliberately NOT pinned, because they are not bypasses:**

* `alter role authenticated set row_security = off` — 0 rows. A non-exempt role
  still has the policy applied.
* `grant pg_read_all_data to authenticated` — 0 rows. That role grants `SELECT`
  everywhere but does **not** carry `BYPASSRLS`; the membership would move the
  role graph in any case.
* a table-level `GRANT` on a guarded table — measured twice. `grant select on
  public.accounts to authenticated` returns 0 rows, because RLS is on with no
  policy; `grant select on public.positions to anon` makes `anon` fail **closed**
  with `permission denied for function owns_account`. A `SELECT` privilege is
  not a row, so `relacl` on the guarded tables is not pinned.
* an `ON SELECT` rule on an existing table — PostgreSQL refuses outright
  (`relation "…" cannot have ON SELECT rules`). The only way one relation can
  read another is to *be* a view or a materialised view, and `pg_depend` records
  every one of those. Measured: the scan finds a **materialised** view and a
  view in **another schema**, and `C38` plants both.
* `pg_stats` on a guarded table — 0 rows for `authenticated`. PostgreSQL's own
  view definition suppresses statistics for a table whose RLS is active for the
  reader, so the histogram/MCV channel is closed by the platform, not by this
  file.

**Outside RLS entirely, and therefore outside this pin:** catalogue metadata.
Measured, and stated carefully because an earlier draft of this paragraph
reported a number taken from a clone the measuring session had already dirtied.
On a **pristine** clone `pg_class.reltuples` for `public.equity_snapshots` reads
back as **`-1`** with `relpages = 0` — the "never analysed" sentinel, because
nothing in the fixture runs `ANALYZE`. After an explicit
`analyze public.equity_snapshots` it reads **21**, `relpages = 1`, and
`authenticated` sees that 21 in the same session in which a direct
`select from public.equity_snapshots` returns **0 rows**. The column list is
visible to `authenticated` unconditionally, analysed or not. So the exact row
count is available to any client on a database that has been analysed — which
every real one has, by autovacuum — and the shape of the table is available
always. The conclusion is unchanged and is the one that matters: **RLS protects
rows, never the catalogue.** That is a property of PostgreSQL, not a gap in this
classifier, and no pin here changes it.

**And one boundary this whole section sits on top of:** every measurement above
sets `request.jwt.claim.sub` directly, which a real client cannot do — PostgREST
sets it from a token it has verified. The classifier certifies the *database's*
half of the tenant boundary. If the token verification in front of it is wrong,
every policy on this page is correct and irrelevant, and nothing in this
directory would notice. That is the `runtime behaviour` bullet in
`pass_does_not_claim`, and it is inherent to a static schema classifier.

**The client read surface of `latest`, measured, so "outside this closure" is a
named list and not a hand-wave.** `has_table_privilege` for `authenticated`,
with each table's RLS flag and policy count:

| relation | RLS | policies | `authenticated` may `SELECT` |
|---|---|---|---|
| `accounts`, `cash_flows`, `trades` | on | **0** | **no** — unreachable directly, which is why the three `_safe` views *are* the read path |
| `accounts_safe`, `cash_flows_safe`, `trades_safe` | n/a (views) | 0 | yes |
| `equity_snapshots`, `performance`, `positions`, `routine_runs` | on | 1 | yes — the closure, pinned |
| `audit_log`, `backtest_runs`, `market_history`, `profiles`, `research_snapshots`, `screener_snapshots`, `strategy_params` | on | 1 each | **yes — outside the closure, and their policies are pinned nowhere** |

**That last row is DERIVED, not counted here.** An earlier version of this table
said *"two tables, one policy each … a two-row scope"* while the closure section
of this same document and `pass_does_not_claim` bullet 3 both said **seven** —
the document contradicted itself and its own machine-readable output, and the
wrong half understated the gap by five tables. The row is now produced by the same
query the report publishes as
`authz_closure.outside_closure_policy_bearing` (classifier control `C39`), and
`tests/catalogue-classify.mutants.sh` refuses a run in which this table's names
and the pristine report's array differ, in either direction. The
count on generation `latest` is **seven tables, one policy each**; on `0008` the
closure covers `cash_flows` and `trades` as well, so the derived set is that
generation's own answer rather than this one repeated.

None of the seven route through `owns_account`, so `C34`/`C35`/`C37` neither
require nor permit them in this closure's arms; pinning them means a second
closure, or a whole-schema policy pin. Nobody has written either. It is a
closable defect with a **seven**-row scope, not an inherent limit.

**Not pinned, and each can still expose a guarded row under a `PASS`:** a view,
inheritance edge or permissive policy on a `public` table *outside* this closure
— including `cash_flows` and `trades` as base tables on generation `latest`; a
second-hop view reached only through such a table; a `SECURITY DEFINER` routine
**in another schema** that reads a guarded table (see the boundary below — in
`public` this is now caught); a trigger copying guarded rows into an unguarded
one; a foreign table, `dblink` or logical-replication slot reading the same data
out of band; value leakage through a non-leakproof function in a qual; **a plain
data copy**; and **a foreign key to a guarded table used as an existence
oracle**. The last two are the R5 additions and each was measured; they get
their own subsection below. Closing any of these needs a whole-schema exposure
model — a different control from a different premise, and this file does not
have one.

### Where the `SECURITY DEFINER` boundary actually runs

**Measured, not assumed**, and restated in R5 because the previous version of
this paragraph drew the line in the wrong place. It said the boundary was
`public` versus another schema. It is not: the real line was **new** versus
**existing**, and it ran straight through `public`.

A `SECURITY DEFINER` function that selects from a guarded table and is
executable by `authenticated`:

* **a NEW signature in `public`** — the run goes **FAIL** with
  `schema:client_executable_surface_drift`. The client-executable set equality
  sees it because it is a routine that was not in the pinned set (mutant `70`).
* **an EXISTING signature in `public`, repurposed** — this was the break. Before
  R5, `cc_client_surface()` pinned the signature and its grant list and *not*
  `prosecdef`, so `create or replace function public.jwt_role() … security
  definer`, with the body replaced by a read of `public.equity_snapshots`, left
  the pinned entry byte-identical. Measured on a pristine `latest` clone: rc 0,
  **PASS**, **41/41** controls ok, `schema_scan.findings []`, all 50
  `authz_closure` rows ok, `client_surface.added []` with the pinned 38 entries
  unchanged — while in the same clone `owns_account('2222…')` answered `false`,
  a direct `select from public.equity_snapshots` returned **0 rows**, and the
  repurposed routine returned all **21** of the victim's rows. **`41` is the
  control count of the file as it stood when the break was found**, and it is
  kept as the historical figure rather than silently restated; R5 added `C39`,
  so the same break REPRODUCED against today's file — by reverting the
  descriptor, the pin format, the two control clauses R5 added, `C32`'s two
  shape clauses **and `cc_surf_sig`'s ` secdef=` delimiter**, five items, which
  together are the pre-R5 classifier by construction — reads rc 0, **PASS**,
  **42/42** controls
  ok, `schema_scan.findings []`, 50/50 closure rows, and 38 pinned entries
  byte-identical, the entry for the repurposed routine among them, still reading
  `public.jwt_role() => anon+authenticated+service_role`; the same 21 rows came
  out on the wire in that clone. Both numbers are measurements of the same
  break against two states of this file; neither is the current verdict.
  The descriptor now carries `secdef=` and `owner=`, so this is
  `schema:client_executable_surface_drift` (mutants `73` and `74`), and the
  shipped classifier against the same mutation returns **FAIL** with that code,
  42/42 controls still ok, naming both entries:
  `1 entr(ies) not in the pinned set [public.jwt_role() secdef=t owner=postgres
  => anon+authenticated+service_role]; 1 pinned entr(ies) not observed
  [public.jwt_role() secdef=f owner=postgres => anon+authenticated+service_role]`.
  The classifier **detects** the repurpose; it does not prevent it — the 21 rows
  are still readable in the clone the run just failed. On
  generation `0008` the same mutation was already a FAIL, because `jwt_role`
  does not exist there and the mutation creates a new signature.
* **in another schema** (`cc_hidden`, `USAGE` granted to `authenticated`) — the
  run still returns **PASS**, and in the same clone the attacker read all 21 of
  the victim's rows through it while `owns_account(victim)` answered `false`.

  Five, not four: `cc_surf_sig` lives outside `C30`, so a four-item
  revert leaves it splitting on a delimiter the reverted descriptor no
  longer writes. Both variants were built and run. The four-item revert is
  rc 3 `CONTROL_FAILED` on exactly one control,
  `C30_client_surface_scanner_works` — *"38 entries before; planted=NULL;
  38 entries after the drop, identical to before=t"*, the scanner's own
  non-vacuity check firing because the planted row no longer parses. The
  five-item revert is the rc 0 PASS above.

So the boundary today, stated as precisely as it can be: **in `public`, a new
client-executable signature, an existing one repurposed into `SECURITY DEFINER`,
and an existing one reowned are all caught. In `public`, a `SECURITY INVOKER`
body rewrite is not caught — and cannot read past the caller's own RLS, measured
at 0 rows, which is why the pin stops there rather than digesting 38 bodies. In
any other schema, nothing is caught.** The one client-executable `SECURITY
DEFINER` routine a rewritten invoker routine could chain through is
`public.owns_account`, whose body digest, owner, language, volatility,
`search_path` and whole dependency closure are pinned by the catalogue and by
`C27`/`C29`/`C34`–`C38`.

**How wide is the invoker-rewrite residual, in routines?** Measured on pristine
clones of both generations, asking for every `public` routine `anon` or
`authenticated` can `EXECUTE`, split by `prosecdef` and by whether it can be
called from SQL at all:

| generation | client-reachable, `SECURITY INVOKER`, directly callable | client-reachable `SECURITY DEFINER` |
|---|---|---|
| `latest` | **2** — `public.is_service_role() -> boolean`, `public.jwt_role() -> text` | 1 — `public.owns_account(uuid)`, body and closure pinned |
| `0008` | **0** — the only client-reachable invoker routine is `public.touch_updated_at() -> trigger`, and a trigger function cannot be called directly (measured: `ERROR: trigger functions can only be called as triggers`) | 1 — `public.owns_account(uuid)`, as above |

So the uncovered shape on `latest` is a rewrite of one of exactly two routines,
each of which would run in the caller's own row-security context; on `0008`
there is no such routine at all, and the same `jwt_role` mutation is a FAIL
there because it creates a *new* signature. That is the residual's size — not a
reason to ignore it, but the reason the pin stops at `prosecdef` and the owner
rather than digesting 38 bodies.

The remaining schema-scoped half is **open**, and it is a **closable defect, not
an inherent limit** — the honest label matters, because the entries in
`pass_does_not_claim` marked INHERENT genuinely cannot be closed by a longer
list and this one can.

Its size is measured rather than guessed. On a pristine `latest` clone, the
routines at least one of `anon` / `authenticated` / `service_role` can `EXECUTE`
are: `pg_catalog` **3257**, `extensions` **54**, `public` **38** (already
pinned), `information_schema` **11**, `vault` **3**, `auth` **3**,
`graphql_public` **1**. Widening `cc_client_surface()` from `nspname = 'public'`
to *every schema except `pg_catalog` and `information_schema`* is therefore a
pin of about **61 further entries**, as a set equality over `pg_namespace` so
that a schema an attacker creates (`cc_hidden`, above) enlarges the observed set
and turns the run red rather than escaping the filter. The base image is pinned
by digest, so that pin is stable across runs. What it costs is a re-record on
any image bump and a full re-run of the mutation suite; what it buys is exactly
the bypass measured above. Nobody has done it, and this page does not pretend
otherwise.

### Three more mechanisms, measured — two of them expose rows under a `PASS`

The enumeration above listed the mechanisms an earlier round had thought of.
R5 measured three more. All three were run through the real driver on a fresh
`latest` clone; the verdicts below are what the classifier actually returned.

**(a) A plain data copy — exposes rows, and detecting it is inherently hard.**

```sql
create table public.cc_copy as select * from public.equity_snapshots;
grant select on public.cc_copy to authenticated;
```

Result: **PASS**, 42/42 controls ok, no schema findings, no closure row moved —
and the attacker (`authenticated`, subject `4444…`) read all **21** of victim
`2222…`'s rows out of `public.cc_copy` while a direct read of
`public.equity_snapshots` returned **0**. Measured: there is **no `pg_depend`
edge at all** between the copy and the source, in either direction, so no
dependency walk starting from a guarded table can reach it — which is why the
`dependent_rels` observer, `pg_depend`-based by construction, is structurally
incapable of seeing it. **INHERENT-HARD for a catalogue classifier**: what makes
those rows sensitive is their *content*, and the catalogue does not describe
content. Closing it needs a data-level control — content comparison, or an
allowlist of the tables permitted to exist at all — which is a different
instrument, not a longer list in this one.

**Do not look for it in any set this report publishes.** Re-measured through the
real driver: the planted `public.cc_copy` appears in **no** observed array of
the report. `schema_scan` enumerates routines, not relations. `authz_closure`
covers the five tables of `owns_account`'s closure. And
`authz_closure.outside_closure_policy_bearing` — the derived seven — is filtered
to relations that carry at least one `pg_policy` row, so a table created by
`create table … as select` is outside it *by construction*, because a `CTAS`
table has neither RLS nor a policy. (The string `cc_copy` does occur in the
report, in the `pass_does_not_claim` prose that names it as the example. That is
the disclosure, not an observation. Nothing observed it.) On the pristine
fixture the two sets happen to coincide — measured, every one of the **11**
client-readable base tables of `public` on `latest` carries exactly one policy,
four inside the closure and seven outside, plus the three `_safe` views — so the
table above is complete *today*. A twelfth, policy-free, client-readable table
would be complete news to every list in the report.

**(b) A foreign key to a guarded table, as an existence oracle — closable.**

PostgreSQL runs referential-integrity checks with the **referenced** table's
owner privileges, which [its documentation](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
states bypasses row security. With a client-writable table carrying
`snap bigint references public.equity_snapshots(id)`:

| attacker action | result |
|---|---|
| `select count(*) from public.equity_snapshots` | **0 rows** |
| `insert … values (1)` — a key that exists (victim's) | **accepted** |
| `insert … values (999999)` — a key that does not | refused: `Key is not present in table "equity_snapshots"` |

Classifier verdict on that schema: **PASS**, 42/42 controls ok, no schema
findings, no closure row moved. That is a working oracle over
another tenant's primary keys. Unlike (a) this one **is** recorded in
`pg_depend`, as a `pg_constraint` row, and `pg_constraint.confrelid` names the
guarded table directly — so it is closable by pinning inbound foreign keys the
way `dependent_rels` pins inbound views. This file does not: its dependent-
relation observer walks `pg_rewrite` only. Recorded here, not fixed here.

**(c) Column-level `GRANT`s — measured, and NOT a bypass.** A completeness note
only, listed because a table-level grant was measured and a column-level one is
a different catalogue column (`pg_attribute.attacl`, not `pg_class.relacl`), so
"we measured grants" would have been a claim about half of them.

```sql
grant select (equity, snapshot_date, account_id)
  on public.equity_snapshots to authenticated;
```

Three `attacl` entries appear; the attacker still reads **0 rows**, including
when selecting only the granted columns. RLS filters rows before column
privileges are consulted. Not a bypass, so deliberately not pinned.

The previous assertion asked four questions: does `PUBLIC`, `anon`,
`authenticated` or `service_role` hold `EXECUTE`? A grant to
`supabase_auth_admin` answered "no" to all four and the tombstone was reported
as correctly sealed. The cluster has 29 roles.

The classifier now enumerates every role in `pg_roles` at run time and asks
PostgreSQL itself who can execute the routine:

* `has_function_privilege(role, oid, 'EXECUTE')` — direct grants, `PUBLIC`,
  recursive **inherited** membership, and superuser, in PostgreSQL's own
  evaluation rather than a re-implementation of it;
* a second scan over `aclexplode(coalesce(proacl, acldefault('f', proowner)))`
  crossed with `pg_has_role(..., 'MEMBER')` — the roles that can reach it after
  `SET ROLE`, which is how a `NOINHERIT` role still gets there;
* `acldefault` rather than "`proacl` is null means no grants": a null `proacl`
  is PostgreSQL's **built-in default**, and that default grants `EXECUTE` to
  `PUBLIC`. A routine that has never been granted or revoked is therefore
  callable by everyone, and reading null as "no privileges" gets that exactly
  backwards. Control `C16` proves the classifier reads it correctly, on a
  freshly created routine whose `proacl` really is null; the suite asserts that
  control from the pristine report.

The ALLOWED set is computed the same way, from the object's owner and the
profile's exact declared grantees, and the two are compared in both directions:
extra is `acl_unexpected_executor`, missing is `acl_missing_executor`. A role
created by a mutation is unexpected by construction, because nothing enumerates
it — it simply is not in the allowed set.

Three things a per-routine ACL cannot see are checked separately, as
environment fingerprints pinned per generation:

* the complete `pg_default_acl` surface for functions — every schema, every
  grantee — because a widened default hands `EXECUTE` to everything created
  after it (mutants 25 and 47);
* the set of superuser roles, because a new superuser can execute everything
  that already exists and no per-routine ACL will ever mention it (mutant 26);
* the whole role-membership graph: who is a member of whom, with which
  `INHERIT` and `SET` options, granted by whom.

The last one closes the residual hole in the per-routine model. Treating the
owner's role family as entitled is correct — that is how PostgreSQL evaluates
the owner's ACL entry — but it means an ordinary role made a *member of the
owner* inherits `EXECUTE` and the comparison calls it expected. Mutant 49 does
exactly that, without a single `GRANT` on the routine, and the pinned graph is
the only check that fires.

### Prove the scanner before believing its silence

"No unexpected role can execute this" is an absence claim, and an absence claim
from an unproven scanner is worth nothing. Before any verdict depends on it the
classifier builds a throwaway routine in a throwaway schema and requires the
scanner to produce known answers (controls `C12`-`C16`):

| control | what it proves |
|---|---|
| `C04` | the resolver refuses a real name with the wrong argument list while still resolving it by name — on a synthetic signature, so that a mutation of a subject routine cannot disarm the control instead of being classified |
| `C12` | a locked-down routine has **no** unexpected executors — so `C13`'s hit is not "the scanner flags everything". The cluster-wide role-graph family (`cc_env_family`: superusers and members of the owner, minus the pinned entitled set) is subtracted, because `grant postgres to X` genuinely lets `X` execute this throwaway probe. Without that, a role-graph tamper turned the whole run into `CONTROL_FAILED` — "the classifier could not be trusted" — and buried the real blocker (`UNEXPECTED_EXECUTABLE` on the tombstone) behind an exit 3. The subtracted set is derived from `pg_roles`/`pg_has_role`, not from the scanner under test, so it cannot mask a scanner that names a role which cannot execute |
| `C13` | a grant to `supabase_auth_admin` — the exact escape the old assertion missed — **is** seen, by exact equality, with the same family subtracted for the same reason |
| `C14` | a grant reached only through group membership is seen, and a `NOINHERIT` member of that group is seen in the `SET ROLE` scan |
| `C15` | a grant to `PUBLIC` is seen, and drags every role in the cluster with it |
| `C16` | a null `proacl` is reported as PUBLIC-executable, because that is what PostgreSQL means by it |
| `C17` | the side-effect counter used by the tombstone probe really does notice a write |

The schema and the roles are dropped again before a single object is observed.

The coverage and predicate controls are proven the same way:

| control | what it proves |
|---|---|
| `C20` | every routine **the whole migration set** tombstones, by **either** shim mechanism, has an expectation row — and 0022's two independent statements of its own loop's set agree with each other. Not "every routine 0022 section 5 tombstones": that narrower claim is what let three tombstoned routines (`resolve_create_operation` inline in 0022, `reconcile_cash_flow_mirror` and `replace_equity_snapshots` in 0017) go uncatalogued while the run said PASS |
| `C21` | the *states* agree too: on `latest`, `{expected TOMBSTONED} = {0022 tombstones}` in both directions; on `0008`, nothing is expected `TOMBSTONED` |
| `C22` | the third probe subject really owns nothing — otherwise "a subject that owns nothing is refused" proves nothing |
| `C23` | POSITIVE control on the coverage comparator: it reports a planted missing name and stays silent on a complete set |
| `C24` | the `owns_account` body digest matches a plaintext written out in the classifier, so the pin is reviewable |
| `C25` | a verdict was actually *reached* for every one of those names, not merely expected |
| `C27` | the declared dependency closure **covers** every function and relation a parser finds in the pinned `owns_account` body — an undeclared dependency is an unpinned one |
| `C28` | POSITIVE/NEGATIVE control on that parser, run through the *same* two functions the real body goes through: it extracts a planted call and a planted relation from a synthetic body, and does not invent one in the real body |
| `C29` | the closure observer really read the catalogue: at least ten closure rows observed, none with a null observation, and a known-good row reading back the right value. This is also what makes `dep:closure_missing`'s unreachability a *checked* claim rather than an assumed one |
| `C34` | the closure's `rls` arm is **derived-complete**: every table carrying a policy whose `USING` clause routes through `owns_account` has an `rls` row. The arm cannot be derived from the body, so without this the typed-in list is short exactly when someone deletes a line from it — the same shape as the tombstone name list that reported itself whole while being short by three |
| `C35` | the closure's `policyset` arm is derived-complete the same way, *and* it really read `pg_policy`: every routed table and every `rls` table has a `policyset` row, every pinned table resolves, the `n=` cardinalities the observer wrote sum to the count `pg_policy` reports for the same tables, and every routed policy renders schema-qualified. That last pair is the read-back that keeps `public.accounts`' pinned **empty** set from being satisfiable by a scanner that stopped scanning |
| `C36` | POSITIVE/NEGATIVE control on the policy-set formatter, over synthetic input: an **addition** changes the descriptor, the cardinality is carried in it, an empty set encodes as `n=0;<no policy>`, and name / command / permissive-vs-restrictive / roles / `USING` / `WITH CHECK` are each distinguished — while catalogue order and a collapsed whitespace run are not findings. Written the first time with a whitespace claim `cc_norm` does not actually make; it failed, and the claim was narrowed to what the normaliser really does |

### The whole-schema counter-scan, and the wire that was missing

A signature-keyed catalogue cannot see a routine that is not in it. The
counter-scan (classifier section 2e) answers the complementary question — *what
else is there?* — as two **set equalities** over enumerations PostgreSQL itself
produces, against a per-generation pin:

| | |
|---|---|
| `S1` | every routine in `public` that `anon`, `authenticated` or `service_role` can `EXECUTE`, with the exact role list, **its `prosecdef` flag and its owner** |
| `S2` | every `SECURITY DEFINER` routine in `public` that can reach `vault.*` — by a schema-qualified reference in the **comment-stripped** body, or by `vault` on its own `search_path` |

`S1` carried the signature and the role list and nothing else until R5. That
version answered *"is the list of things a client can call still the list we
pinned"* and not *"do they still do what they did"* — and those are different
questions, because `create or replace function` keeps the signature, the ACL and
the owner while replacing the body and flipping `prosecdef`. The measurement is
in the boundary subsection above: a clean `PASS` with 21 of another tenant's
rows on the wire. `prosecdef` and the owner are the two catalogue columns that
decide *whose* row-security context a call runs in, so they are the two that
belong beside the role list. The body is deliberately **not** in the descriptor:
digesting 38 bodies would re-pin, badly and without a probe, what the per-object
catalogue already pins properly, and would make every unrelated migration a
counter-scan finding.

A hand-written pin is admissible here and was not admissible for the tombstone
catalogue, because the direction of failure is inverted: an omission from a
*watch-list* is silent, while an omission from a *set equality over a complete
enumeration* makes the run RED.

These are **run-level** findings. They have no catalogue key, so they are not in
the `CATALOGUE_CLASSIFY_OBJECT=` lines; they are echoed as
`CATALOGUE_CLASSIFY_SCHEMA_FINDING=` lines, published under `schema_scan` in the
JSON, printed by the driver next to the verdicts, and a non-empty set is `FAIL`.

| control | what it proves |
|---|---|
| `C30` | the client-surface scanner sees a routine planted in `public` and granted to `anon`, and goes back to its previous answer when it is dropped. **Since R5** it also performs the *repurpose*: the same planted routine is `create or replace`d into `SECURITY DEFINER` and then reowned, with the signature and grant list held still, and the control requires the descriptor to move both times **while the signature stays byte-identical** — which is the measurement behind "the signature-only pin could not have seen this" |
| `C31` | the vault-reacher scanner sees a real qualified reference and does **not** report a routine whose only mention of `vault` is in a comment |
| `C32` | the pin is non-vacuous — an empty pin would make both equalities trivially true on an empty schema. It also asserts the pin's **shape**: every client-surface entry must carry a security mode and an owner, and at least one must be `SECURITY DEFINER`, so a pin re-recorded in the pre-R5 signature-only format cannot go green by having the observer reverted to match it |
| `C39` | the **scope** statement is derived, not counted: the client-readable, policy-bearing tables of `public` that are *outside* this closure are computed from the catalogue, published as `authz_closure.outside_closure_policy_bearing`, proven disjoint from the closure, and interpolated into `pass_does_not_claim`. The mutation suite then requires this document's table to name exactly that list. It exists because the document said **two** and its own machine-readable output said **seven** |
| `C33` | **the result gate actually reads the findings.** A synthetic finding is planted, the same gate function the report publishes is re-evaluated, and the answer must stop being `PASS`; it is then removed and must come back |
| `C19b` | every schema finding code emitted is in the reason registry, so the suite's coverage assertion can require it |

`C33` exists because of what was found here: the scanners, `C30`-`C32`, and the
`insert into cc_schema_finding` were all written and merged, a source comment
said *"the RESULT gate reads them"* — and **nothing in the file ever selected
from that table**. A complete detector whose output reached no verdict, with a
green banner on top. A comment is not a wire, and the only thing that proves a
wire is a signal sent down it.

### A classifier must SAY whether it counter-scans

The driver enforces the counter-scan, and it once enforced it on *every*
classifier it ran — at least two scan kinds or exit 2. That is right for the
shipped classifier and fatal for `tests/naive-oracle.sql`, the name-only straw
man that models the **old** harness and performs no counter-scan on purpose:
every straw-man cell, both pristine runs included, became a harness error, and
the whole *"the strong classifier buys something"* demonstration stopped
happening. The mutation suite correctly refuses to score a driver refusal as
"the straw man is blind to this mutant", so the failure was loud — but the
demonstration was gone.

Letting the straw man emit an empty scan would have destroyed the rule: an
absent counter-scan reading as a clean counter-scan is exactly what the rule
prevents. So the classifier **declares**, in `counter_scan_declared`, and the
three answers have three different consequences:

| declaration | consequence |
|---|---|
| **absent** | harness error. Silence is refused, so a build that dropped its `schema_scan` block lands here and not in the exemption |
| `true`, `< 2` scan kinds | harness error — *claimed one and produced nothing* |
| `true`, `>= 2` scan kinds | certifying |
| `false` | the run happens, prints its verdicts, and is labelled **NOT A CERTIFICATION**; permitted only for a `--classifier` that is not the shipped default. The default declaring `false` is a harness error |

The last row is the point: the escape hatch must not be reachable by the thing
being certified. `tests/counter-scan-declaration.test.sh` asserts all four rows
by their exact reason strings, plus a control on its own matcher and a check
that both shipped classifiers really do declare — without a database, because
a contract test that needs a 25-minute clone is a contract test nobody runs.

**INHERENT — the declaration is a self-report.** The subject writes the report.
The driver refuses silence, refuses `true` with nothing behind it, and refuses
the shipped classifier claiming the exemption; it cannot detect a classifier
that declares `true` and fabricates two scan kinds. No stricter declaration
closes that — a self-describing artefact cannot vouch for itself — and it is
stated in `pass_does_not_claim` so the limit travels with the machine-readable
report and not only with this page. What bounds it is that the shipped
classifier is the artefact under review and its scanners carry `C30`-`C33`.

## The expected text is derived, never copied

`extract-tombstone-template.py` reads **the whole `supabase/migrations` set** —
it refuses a single file outright — and pulls out the
`format()` template migration 0022 executes, together with its language,
`search_path`, security mode, volatility, message literal, SQLSTATE literal, the
`REVOKE` role list and the routine-name list. Nothing about the tombstone is
retyped anywhere in this directory, so the classifier cannot drift away from the
migration it is checking. If the migration ever stops matching the shape the
extractor expects, the extractor **refuses** — it never falls back to a default.

The **name list** is derived twice. Migration 0022 states its tombstone set in
section 5 (the loop that installs the tombstones) and again in section 6 (the
post-condition asserting none of them is executable). The extractor locates and
parses both, and dies with

```
migration 0022 states its tombstone set twice and the two disagree:
  section 5 has …, the section 6 post-condition has …
```

when they differ, or with `… list(s) precede the post-condition marker` when
section 6 stops restating the set at all. Suite controls `0e` and `0f` plant
exactly those two doctorings and assert the exact refusal string; control `0g`
asserts, from the test side, that the derived set is the **whole union over
both mechanisms**, not just 0022 section 5's loop. Reading one list gives
nothing to compare it against, which is how a four-of-five list survives.

The cross-check between section 5 and section 6 is deliberately scoped to the
*loop's* names, and `C20`'s detail says so. Section 6 restates what section 5
installs; it knows nothing about 0022's own inline shim or about migration
0017's, and widening the comparison to make it match the union would break the
one place two independent statements of the same set can be compared — which is
the error that control exists to prevent.

## The base image is keyed on its inputs

The cached base image used to be named for the generation — `:g0008`,
`:glatest`. The name did not mention the migrations, so a genuine regression
added to `supabase/migrations/` did not change it: the cached image was reused,
the new migration never ran, and the driver reported `PASS`. That was
demonstrated by counterfactual before it was fixed.

The driver computes, **before** it consults the cache, a manifest naming
every input by path and content hash — every migration file that will actually
be applied for this generation, the bootstrap, and both fixtures — and hashes
it. That digest is the cache key:

```
nt-catalogue-classify-base:glatest-500a8c78c7c4c5a7
```

A changed migration set produces a different digest, so it cannot select the
entry at all; the image is rebuilt automatically. Two further locks cover the
case where the tag is reachable some other way: the committed image carries a
`nt.catalogue-classify.base-inputs-sha256` **label**, and the image itself
carries `/nt-catalogue-classify-base.inputs.sha256`, which the driver reads back
out of the running clone and compares. A clone that cannot show the stamp is a
harness error, never a pass. `--print-base-digest` prints the digest without
running anything.

### The migration set is selected with the appliers' own glob

That cache key is only worth what the input **list** is worth. The driver used
to select migrations with `find -name '[0-9][0-9][0-9][0-9]_*.sql'`, while
`supabase/tests/run_integration.sh`, `run_postgrest.sh`, `run_concurrency.sh`
and `run_vault_integrity.sh` all apply `"$MIGRATIONS"/*.sql`. A migration named
the way `supabase migration new` names them — a 14-digit timestamp prefix —
matched the appliers' glob and **not** this one, so it was dropped from the
applied set *and* from the digest. The digest was unchanged, the cached base
image was reused, and the classifier returned `PASS` over a schema the migration
had never touched: the same failure as above, keyed differently.

Selection now uses the appliers' glob and then **refuses** anything it cannot
order:

```
FAIL: migration file(s) the appliers would apply but this driver cannot order:
       20250814120000_planted_regression.sql
FAIL: every file in …/supabase/migrations must be NNNN_name.sql (four digits, contiguous).
FAIL: refusing to classify against a migration set that silently omits a file
```

Exit code 2, for both generations. A file this driver cannot place in the
sequence is a harness error, never a silent omission. Measured against the
current tree: with the file planted, the old driver printed the unchanged
digest `500a8c78c7c4c5a7…` and exited 0; the current one exits 2 with the
message above; with the file removed it prints the same digest as before, so
the check does not fire on a clean tree.

That measurement is the falsification suite's control **`0h`**, so it is a
standing guard rather than a one-off. It copies the migration tree into the
suite's work directory (`supabase/migrations` itself is never written to),
first checks that the copy keys on the **same digest as the real tree** — a
copy that did not would make any later refusal meaningless — then plants the
14-digit file and requires exit 2 naming that exact file on **both**
generations, then removes it and requires the real tree's digest back. It runs
before any container starts.

## Files

| file | what it is |
|---|---|
| `catalogue-classify.sql` | the classifier. Runs as `supabase_admin` inside a disposable clone. |
| `catalogue-classify.sh` | the driver: derives the contract from 0022, digests the input set, builds/caches a base image per input set, starts a fresh clone per run, applies an optional mutation, classifies, parses the verdict. |
| `extract-tombstone-template.py` | the derivation. Takes the **migrations directory** and refuses a single file. Emits the tombstone template and its properties, and the tombstoned-name set as the **union over both shim mechanisms across every migration** (`inline` and the 0022 `format()` loop) with `names_by_source` provenance; the section-5 loop list and the section-6 post-condition list are emitted separately and a disagreement between those two is a refusal. Plus `--emit-tombstone-do`, which slices 0022 section 5 out verbatim for mutant 20. |
| `sql/00_env_bootstrap.sql` | the storage tables `storage-api` owns and no migration creates. Vendored from `bridge/pre-migration-containment:dashboard/test/schema-compat/sql/`; the driver **diffs against the branch whenever it is present** and refuses to run on drift. |
| `sql/10_seed.sql` | the same harness's fixture. Same provenance and same drift check. |
| `sql/20_seed_probe_accounts.sql` | this directory's own fixture extension: a **second account under a different owner**, without which the ownership probe cannot tell "checks the owner" from "checks the row exists". The third probe subject owns nothing and needs no row — control `C22` asserts that it owns nothing. Not vendored, so the drift check above stays exact. |
| `tests/catalogue-classify.mutants.sh` | the falsification suite. |
| `tests/naive-oracle.sql` | the name-only / bare-42501 straw man. Never used by the gate; it exists only so the suite can prove the strong classifier is load-bearing. Declares `counter_scan_declared: false`, so every run of it is labelled **NOT A CERTIFICATION**. |
| `tests/counter-scan-declaration.test.sh` | the counter-scan declaration contract, asserted by exact reason string in all four states, with a control on its own matcher and a check that both shipped classifiers declare. Needs no docker and no database. |
| `trusted-policy.sh` | **the only script in this directory that CI executes** (`dashboard-containment-gate.yml`, job `identity-boundary`). Decides whether a candidate commit is provably confined to `dashboard/`. |
| `tests/trusted-policy.test.sh` | the identity boundary's falsification suite. Needs no docker and no database; every candidate it uses is a commit that already exists in this repository, so it writes no git objects. Read its RESIDUAL LIMIT header before quoting it. |
| `tests/run-all.sh` | the runner for this directory. Enumerates the filesystem and refuses to start when a test-shaped file exists that no declared case runs. |

### A suite on disk that nothing runs

`tests/counter-scan-declaration.test.sh` was invoked by **nothing** — not by the
mutant suite, not by any workflow, not by any script in the repository — while
the line below said the certifying invocation was
`catalogue-classify.mutants.sh --oracle both`, which does not run it. That is
the same defect `runtime-canary/tests/run-all.sh` closed twice, as B8(iii) ("a
skipped attack is not a passed attack") and N6 ("is every suite on disk
declared?"), sitting unclosed in this directory because this directory had no
runner at all.

`tests/run-all.sh` is that runner. It declares its cases once, derives the plan
and the execution from that one list, enumerates `tests/` **and** the
`.github/containment/` top level for test-shaped files, and exits 2 naming any
file that no declared case runs. Measured in both directions: planting
`tests/zz-planted-control.test.sh` makes `--print-plan` exit 2 naming it, and
removing it makes the same runner plan cleanly again.

`trusted-policy.sh` had no test **of any kind** until `tests/trusted-policy.test.sh`
was written, despite being the one file here that runs in CI. What that absence
was hiding is described under "What a PASS does not claim".

## Running it

```bash
# EVERYTHING in this directory, with a refusal if any suite would not run
.github/containment/tests/run-all.sh

# what would run, and what would be skipped, in milliseconds
.github/containment/tests/run-all.sh --print-plan

# one generation, pristine
.github/containment/catalogue-classify.sh --generation 0008
.github/containment/catalogue-classify.sh --generation latest

# what the base image would be keyed on right now
.github/containment/catalogue-classify.sh --generation latest --print-base-digest

# the counter-scan declaration contract — no docker, no database, milliseconds
.github/containment/tests/counter-scan-declaration.test.sh

# the identity boundary CI actually runs — no docker, no database
.github/containment/tests/trusted-policy.test.sh

# the whole falsification suite (real classifier + the straw-man demonstration)
.github/containment/tests/catalogue-classify.mutants.sh

# one mutant. An id that matches nothing is a HARNESS ERROR naming it, not a
# green suite over zero mutants.
.github/containment/tests/catalogue-classify.mutants.sh --oracle real --only 43
```

Exit codes: `0` pass, `1` blocker, `2` harness error, `3` control failure.

### Only a full run is a certification

`--only` and a single `--oracle` are developer conveniences. They are **not**
errors and they still exit `0` when everything they ran was green — but a green
partial run is not the claim the full run makes, and it must never be quoted as
one.

The suite says so itself. A run that skipped anything ends with

```
SUITE GREEN — NOT A CERTIFICATION
This run did not exercise the whole suite. It says nothing about:
  - --only 01: only the named mutants ran
  - 77 of the 78 declared mutants did not run against the real classifier
  - the tombstone-coverage assertion (C20/C23) and its red-before did not run
  ...
```

and a full run ends with `SUITE GREEN  (full run: certification)`. The mutant
counts in that banner are **measured from the results file the run actually
wrote**, not from the table that was supposed to drive it, so a loop that stops
early is visible in the count rather than hidden by it.

This existed because it did not: `--only 01` used to print, verbatim and
unqualified, *"RED on every mutant with the exact state and the exact reason
codes"* followed by `SUITE GREEN` at exit `0`, having run one of sixty-nine
mutants and skipped the coverage assertions, their red-before, schema mutant 70,
the C34 falsification and the straw man's frozen blind set. That is the same
defect `runtime-canary/tests/run-all.sh` closed as B8(iii) — *a skipped attack is
not a passed attack* — sitting unfixed in the sibling suite.

**The certifying invocation is:**

```bash
.github/containment/tests/run-all.sh
```

which runs the counter-scan declaration contract, the identity-boundary suite
and

```bash
.github/containment/tests/catalogue-classify.mutants.sh --oracle both
```

in that order, and refuses to start if a test-shaped file exists in this
directory that no declared case runs. The mutant suite alone was previously
named as the certifying invocation; it is only the third of three, and it never
ran the other two.

## Safety

* The production image is addressed **by digest**
  (`supabase/postgres@sha256:f371b5f3…`), pulled by digest if absent. The tag is
  recorded for humans and never resolved.
* Readiness is five **consecutive** successful `supabase_admin` queries over TCP
  about the schema layout. Never `pg_isready`: this image runs a socket-only
  temporary server during init and then restarts.
* No container this code touches is named `natetrader-*`. Nothing here reaches a
  broker, Traefik, a workflow, or `supabase/migrations` (read-only, copied into
  a throwaway container).
* Every value the probes write is the literal string
  `CC-PROBE-NOT-A-CREDENTIAL`. A real credential would be an error, not a
  shortcut.
* `--probe-mode` is a test seam and is non-promotable: any value other than
  `normal` forces the result away from `PASS`, because an unprobed tombstone has
  not been proven to be one.
* Some mutants create roles and one creates a superuser. They exist only inside
  a disposable clone that is destroyed at the end of the run.

## What the suite proves

Every mutant runs on its own fresh clone and must produce an **exact** final
state and **exact** reason codes.

**"Exact" now means exact.** Until ADV-1 it did not: the scorer asserted that
each named code was PRESENT in the object's decisive `reasons` array and never
that no other code was, so every row below was a *lower bound* while this
sentence and the suite's own verdict banner said "the exact reason codes".
Turning the comparison into set equality repinned **30 of the 71** mutants —
none of them a classifier defect, all of them codes the classifier had been
emitting all along that nobody was asserting. `check_reasons` is now itself
falsified before any mutant is scored (six synthetic cases, section `1c` of the
run), because its passing value is the empty string and so is the value a
broken reader produces.

**Reading these tables.** The `asserted reason` column is the decisive
`reasons` array, compared for **equality**. A code written `@array/code` — e.g.
`@live_misses/live:probe_undefined` — is instead required to be *present* in
that other array of the report: those are the raw per-profile miss lists, which
legitimately carry codes that are not decisive for the profile expected on the
object. **The `MUTANTS` array in `tests/catalogue-classify.mutants.sh` is
authoritative**; these tables are a transcription of it, and the suite refuses
to certify a run in which the two have diverged (section `1d`).

### Structure

| # | mutation | verdict | asserted reason |
|---|---|---|---|
| 01 | drop a wrapper | `MISSING` | `sig_absent` |
| 02 | leave only a different overload | `MISSING` | `sig_only_other_overload` |
| 21 | leave two overloads, so the bare name is ambiguous | `MISSING` | `sig_name_ambiguous` |
| 22 | the name is a `PROCEDURE` now | `MISSING` | `sig_wrong_object_kind` |
| 23 | the name is a `TABLE` now | `MISSING` | `sig_wrong_object_kind` |
| 16 | an **executable** overload appears | `UNEXPECTED_EXECUTABLE` | `overload_unexpected`, `tomb:acl_sibling_executable` |
| 16b | a **locked-down** overload appears | `UNEXPECTED_PRESENT` | `overload_unexpected` |
| 24 | alternate-schema spoof, locked down | `UNEXPECTED_PRESENT` | `alt_schema_shadow` |
| 24b | alternate-schema spoof, executable by `PUBLIC` | `UNEXPECTED_EXECUTABLE` | `alt_schema_shadow`, `tomb:acl_sibling_executable` |

### The tombstone's definition

| # | mutation | verdict | asserted reason |
|---|---|---|---|
| 03 | live no-op body, ACL still revoked | `DEFINITION_DRIFT` | `tomb:body_not_tombstone`, `tomb:probe_skipped_unsafe_body` |
| 08 | right message, wrong SQLSTATE | `DEFINITION_DRIFT` | `tomb:body_not_tombstone`, `tomb:probe_sqlstate_mismatch` |
| 09 | right SQLSTATE, wrong message | `DEFINITION_DRIFT` | `tomb:body_not_tombstone`, `tomb:probe_message_mismatch` |
| 10 | owner changed | `DEFINITION_DRIFT` | `tomb:owner_mismatch` |
| 11 | security mode flipped | `DEFINITION_DRIFT` | `tomb:secmode_mismatch` |
| 12 | `search_path` changed | `DEFINITION_DRIFT` | `tomb:proconfig_mismatch` |
| 13 | language changed | `DEFINITION_DRIFT` | `tomb:language_mismatch`, `tomb:body_not_tombstone`, `tomb:probe_skipped_unsafe_body` |
| 14 | volatility changed | `DEFINITION_DRIFT` | `tomb:volatility_mismatch` |
| 15 | return type changed | `DEFINITION_DRIFT` | `tomb:rettype_mismatch` |
| 29 | argument list changed | `DEFINITION_DRIFT` | `tomb:args_mismatch` |
| 46 | tombstone body dressed up as the live profile. The privileged probe **still runs** — it is no longer the `else` branch of the live probe, which is what lets 0017's two shims be probed at all — so the finding is narrowed to the two properties that actually moved, and `assert_mutant_46_evidence` requires the probe to have run | `DEFINITION_DRIFT` | `tomb:secmode_mismatch`, `tomb:proconfig_mismatch` |
| 48 | a live body that raises the tombstone's exact message and SQLSTATE on one input | `DEFINITION_DRIFT` | `tomb:secmode_mismatch`, `tomb:proconfig_mismatch`, `tomb:body_not_tombstone`, `tomb:probe_skipped_unsafe_body` |

### Who can execute it

| # | mutation | verdict | asserted reason |
|---|---|---|---|
| 04 | `GRANT EXECUTE` to `service_role` | `UNEXPECTED_EXECUTABLE` | `tomb:acl_service_role_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 05 | … to `anon` | `UNEXPECTED_EXECUTABLE` | `tomb:acl_anon_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 06 | … to `authenticated` | `UNEXPECTED_EXECUTABLE` | `tomb:acl_authenticated_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 07 | … to `PUBLIC` — every role in the cluster, named individually in the report | `UNEXPECTED_EXECUTABLE` | `tomb:acl_public_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 42 | … to `authenticator` | `UNEXPECTED_EXECUTABLE` | `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 43 | … to **`supabase_auth_admin`** — the escape the old assertion called `INTENTIONALLY_TOMBSTONED` | `UNEXPECTED_EXECUTABLE` | `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 44 | … to a role that did not exist a moment ago | `UNEXPECTED_EXECUTABLE` | `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 45 | … through a group, plus a `NOINHERIT` member that can `SET ROLE` into it | `UNEXPECTED_EXECUTABLE` | `env:role_membership_drift`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 47 | … through a **default privilege**: widen the default, then create an overload that picks it up | `UNEXPECTED_EXECUTABLE` | `env:default_acl_drift`, `overload_unexpected`, `tomb:acl_sibling_executable` |
| 52 | `GRANT EXECUTE` to `service_role` on **`create_account_atomic`** — a tombstone the catalogue used to be blind to | `UNEXPECTED_EXECUTABLE` | `tomb:acl_service_role_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 53 | … to `anon` on **`record_account_verification`**, the other one | `UNEXPECTED_EXECUTABLE` | `tomb:acl_anon_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 54 | `create_account_atomic` **fully revived** — 0021's own definition, sliced out of the migration, plus `EXECUTE` back to `service_role` | `UNEXPECTED_EXECUTABLE` | `tomb:secmode_mismatch`, `tomb:proconfig_mismatch`, `tomb:body_not_tombstone`, `tomb:acl_service_role_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor`, `tomb:probe_skipped_unsafe_body`, `@live_misses/live:probe_undefined` |
| 56 | `GRANT EXECUTE` to `service_role` **and** `anon` on **`resolve_create_operation(uuid,uuid)`** — the tombstone 0022 writes **inline**, sixty lines above its loop, with a different message. A section-scoped derivation never saw it, so this used to be a clean `PASS` | `UNEXPECTED_EXECUTABLE` | `tomb:acl_anon_execute`, `tomb:acl_service_role_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 57 | that same inline tombstone **fully revived** — migration 0021's `SECURITY DEFINER` body, sliced out of the migration, plus `EXECUTE` back to `service_role` | `UNEXPECTED_EXECUTABLE` | `tomb:secmode_mismatch`, `tomb:body_not_tombstone`, `tomb:acl_service_role_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor`, `tomb:probe_skipped_unsafe_body` |
| 58 | `GRANT EXECUTE` to `anon` on **`reconcile_cash_flow_mirror`** — a migration **0017** tombstone. 0017 does not revoke `service_role`, so the derived expectation is `{service_role}`, not `{}`, and `anon` is the escape | `UNEXPECTED_EXECUTABLE` | `tomb:acl_anon_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 59 | **`replace_equity_snapshots`**'s refusal replaced by a live no-op, with owner, language, security mode, `search_path`, arguments and return type left identical — 0017's shims differ from the live 0014 definitions in *nothing but the body* | `DEFINITION_DRIFT` | `tomb:body_not_tombstone`, `tomb:probe_skipped_unsafe_body` |
| 27 | `EXECUTE` revoked from the tombstone's own **owner** | `ACL_DRIFT` | `tomb:acl_missing_executor` |
| 25 | the default-privilege surface widened | `ACL_DRIFT` | `env:default_acl_drift` |
| 26 | a brand-new **superuser** role. It ranks `UNEXPECTED_EXECUTABLE`, not `ACL_DRIFT`: the entitled set is PINNED, so a role that joins the owner's family *can genuinely execute the tombstone* and is an unexpected executor by construction — the same precedence as mutant 49 | `UNEXPECTED_EXECUTABLE` | `env:superuser_set_drift`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |
| 49 | a new role made a **member of the owner**, inheriting `EXECUTE` with no grant on the routine at all — same precedence as 26, and for the same reason | `UNEXPECTED_EXECUTABLE` | `env:role_membership_drift`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor` |

### The live control object

| # | mutation | verdict | asserted reason |
|---|---|---|---|
| 17 | `EXECUTE` revoked from a **live, never-tombstoned** routine | `ACL_DRIFT` | `live:acl_explicit_mismatch`, `live:acl_effective_mismatch`, `live:acl_missing_executor`, `live:probe_failed`, `@tomb_misses/tomb:not_applicable` |
| 28 | `owns_account` rewritten to check **existence** instead of **ownership** | `DEFINITION_DRIFT` | `live:probe_effect_mismatch`, `live:body_mismatch` |
| 50 | `owns_account` authorises **every** account when `auth.uid()` is null — the original three-point truth table still passes | `DEFINITION_DRIFT` | `live:probe_effect_mismatch`, `live:body_mismatch` |
| 51 | `owns_account` with a **fixed-uuid backdoor subject** — every one of the nine probe answers stays correct, so the body pin is the only check that can see it | `DEFINITION_DRIFT` | `live:body_mismatch` |
| 60 | **`auth.uid()`** redefined with a backdoor claim. `owns_account`'s digest is byte-identical and all nine probes answer correctly, so the closure is the only check that can see it | `AUTHZ_CLOSURE_BROKEN` | `dep:function_drift` |
| 61 | RLS switched off on **`public.accounts`**, the one relation the pinned body reads. Reported **twice** since ADV-2: the `relation` arm sees it and so does the `guarded` arm, which pins `relrowsecurity` on the same table — the redundancy is deliberate, so the two arms cannot disagree about a table | `AUTHZ_CLOSURE_BROKEN` | `dep:relation_drift`, `dep:guarded_table_exposed` |
| 62 | `alter table public.positions disable row level security` — a total read bypass touching neither the routine, its ACL, nor its body. Reported **twice** since ADV-2, by the `rls` arm and by the `guarded` arm | `AUTHZ_CLOSURE_BROKEN` | `dep:rls_disabled`, `dep:guarded_table_exposed` |
| 63 | the `positions` read policy weakened to `using (true)`, so it no longer routes through the predicate at all | `AUTHZ_CLOSURE_BROKEN` | `dep:policy_set_changed`, `dep:guarded_policy_set_changed` |
| 64 | **ADV-1**: a *second* permissive policy `using (true)` beside `read own positions`. The pinned policy is byte-identical, RLS is on, `auth.uid()` and `accounts` are untouched, and all nine probes answer correctly — the table is simply no longer guarded | `AUTHZ_CLOSURE_BROKEN` | `dep:guarded_policy_set_changed` |
| 65 | the same shape against an arm whose pinned value is the **empty** set: `public.accounts`, deny-all on the latest schema, gains `for select using (true)` | `AUTHZ_CLOSURE_BROKEN` | `dep:guarded_policy_set_changed` |
| 66 | **ADV-2(C)**: `alter table public.equity_snapshots owner to authenticated`. A table's **owner is exempt from its own RLS policies** unless `FORCE ROW LEVEL SECURITY` is set, and FORCE is off on every table in this schema. RLS stays on, the policy set stays byte-identical, `owns_account` stays correct. Measured: the attacker read all 21 of the victim's rows while `owns_account(victim)` returned false | `AUTHZ_CLOSURE_BROKEN` | `dep:guarded_table_exposed` |
| 67 | **ADV-2(C)**, the other half: `force row level security` switched **on**. A hardening, and still drift from the measured baseline — the flag is falsified in the direction this schema can actually move, because FORCE is off everywhere and "somebody turned it off" cannot be planted | `AUTHZ_CLOSURE_BROKEN` | `dep:guarded_table_exposed` |
| 68 | **ADV-2(E)**: the guarded table gains an unguarded **inheritance parent**. A query against the parent applies the *parent's* policies to the child's rows; the child is untouched. Measured: 21 rows through the parent. `pg_inherits` carries partition attachment too, so one pin covers both | `AUTHZ_CLOSURE_BROKEN` | `dep:guarded_table_exposed` |
| 69 | **ADV-2(F)**: a new **view** over the guarded table. A view runs in the *view owner's* row-security context unless it is declared `security_invoker`. Measured: 21 rows through the view | `AUTHZ_CLOSURE_BROKEN` | `dep:guarded_table_exposed` |
| 71 | **ADV-2(D)**: `alter role authenticated bypassrls`. BYPASSRLS is a role **attribute** — not superuser, not a membership — so neither `env:superuser_set_drift` nor `env:role_membership_drift` moves. Measured: every guarded table plus `profiles` and `audit_log`; `nobypassrls` returns it to zero | `ACL_DRIFT` | `env:bypassrls_set_drift` |
| 72 | **ADV-2(F)**, the one that is not hypothetical: the tenant boundary removed from **`public.accounts_safe`**, which on generation `latest` is the client's *only* read path to `accounts` — a view owned by `postgres` (a BYPASSRLS role), granted `SELECT` to `authenticated`, whose `WHERE owner_id = auth.uid()` is the entire boundary. Measured: the attacker listed both fixture accounts while RLS stayed enabled on `public.accounts` and its pinned **empty** policy set stayed empty | `AUTHZ_CLOSURE_BROKEN` | `dep:guarded_table_exposed` |
| 75 | **R5-CTLPREC(2)**: a guarded **table** replaced in place by a **view** over an unguarded copy of itself — the policy is dropped first, because leaving it on the renamed table would make the derived routed set name a table the closure does not declare, which is `C34`'s refusal rather than a finding. The owner is restored to `postgres` so the owner row does not move. This is the only mutant that moves the guarded arm's **`relkind`** row. Measured: 21 of the victim's rows through the swapped-in view while `owns_account(victim)` returned false | `AUTHZ_CLOSURE_BROKEN` | `dep:rls_disabled`, `dep:policy_set_changed`, `dep:guarded_policy_set_changed`, `dep:guarded_table_exposed` |
| `70` | run-level (**AUD-4**): a brand-new `SECURITY DEFINER` vault wrapper in `public`, granted to `anon`, in no catalogue. Has no object key, so it is asserted against `schema_scan` rather than a verdict row | `FAIL` | `schema:secdef_vault_reacher_unlisted`, `schema:client_executable_surface_drift` |
| `73` | run-level (**R5-A1**, the break this round closed): `public.jwt_role()` — an **existing** routine `anon`, `authenticated` and `service_role` could already execute — `create or replace`d into `SECURITY DEFINER` with a body that reads `public.equity_snapshots`. Signature, ACL and owner all byte-identical; only `prosecdef` and the body move. Under the pre-R5 descriptor this was a clean `PASS` with 21 of the victim's rows readable | `FAIL` | `schema:client_executable_surface_drift` |
| `74` | run-level (**R5-A1**, the owner half): `alter function public.is_service_role() owner to authenticated`. Signature, grant list and `prosecdef` unchanged; only the owner moves. A real escalation, because the owner of a routine may `create or replace` it — this hands every client the ability to install mutant `73`'s body | `FAIL` | `schema:client_executable_surface_drift` |
| `C34n` | not a schema mutant but a **control falsification**: a table gains a policy routing through `owns_account` that none of the closure's `rls`, `policyset` or `guarded` arms names. Asserts a REFUSAL, so it carries no object state — the run must exit 3 with `C34`, `C35` and `C37` the **only** failing controls, all three naming the planted table | `CONTROL_FAILED` | — |
| 30 | owner changed | `DEFINITION_DRIFT` | `live:owner_mismatch`, `live:probe_skipped_structure` |
| 31 | [0008] return type changed | `DEFINITION_DRIFT` | `live:rettype_mismatch`, `live:body_mismatch`, `live:probe_skipped_structure` |
| 32 | [0008] argument list changed | `DEFINITION_DRIFT` | `live:args_mismatch`, `live:body_mismatch`, `live:probe_skipped_structure` |
| 33 | [0008] language changed | `DEFINITION_DRIFT` | `live:language_mismatch`, `live:body_mismatch`, `live:probe_skipped_structure` |
| 34 | `SECURITY INVOKER` | `DEFINITION_DRIFT` | `live:secmode_mismatch`, `live:probe_skipped_structure` |
| 35 | `VOLATILE` | `DEFINITION_DRIFT` | `live:volatility_mismatch`, `live:probe_skipped_structure` |
| 36 | `search_path` changed | `DEFINITION_DRIFT` | `live:proconfig_mismatch`, `live:probe_skipped_structure` |
| 37 | `anon` made a member of `authenticated` — no grant on the routine at all | `UNEXPECTED_EXECUTABLE` | `live:acl_effective_mismatch`, `live:acl_unexpected_executor`, `env:role_membership_drift` |
| 38 | `EXECUTE` to `supabase_auth_admin` | `UNEXPECTED_EXECUTABLE` | `live:acl_explicit_mismatch`, `live:acl_unexpected_executor`, `live:acl_assumable_executor` |
| 39 | `EXECUTE` through a group with a `NOINHERIT` member | `UNEXPECTED_EXECUTABLE` | `env:role_membership_drift`, `live:acl_explicit_mismatch`, `live:acl_unexpected_executor`, `live:acl_assumable_executor` |
| 40 | `EXECUTE` to `PUBLIC` | `UNEXPECTED_EXECUTABLE` | `live:acl_explicit_mismatch`, `live:acl_effective_mismatch`, `live:acl_unexpected_executor`, `live:acl_assumable_executor`, `live:acl_public_execute` |
| 41 | an executable overload beside it | `UNEXPECTED_EXECUTABLE` | `overload_unexpected`, `live:acl_sibling_executable` |

### The probe, and the expectation itself

| # | mutation | verdict | asserted reason |
|---|---|---|---|
| 18 | the privileged body probe is skipped | `UNPROVEN` | `tomb:probe_missing` |
| 18b | the privileged body probe is broken | `DEFINITION_DRIFT` | `tomb:probe_sqlstate_mismatch` |
| 18c | the live semantic probe is skipped | `UNPROVEN` | `live:probe_missing` |
| 19 | `vault_create_secret` LIVE on the latest schema | `UNEXPECTED_PRESENT` | `tomb:secmode_mismatch`, `tomb:proconfig_mismatch`, `tomb:body_not_tombstone`, `tomb:acl_service_role_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor`, `tomb:probe_skipped_unsafe_body`, `expected_state_mismatch` |
| 19b | `vault_delete_secret` LIVE on the latest schema (0020's body) | `UNEXPECTED_PRESENT` | `tomb:secmode_mismatch`, `tomb:proconfig_mismatch`, `tomb:body_not_tombstone`, `tomb:acl_service_role_execute`, `tomb:acl_effective_escape`, `tomb:acl_unexpected_executor`, `tomb:acl_assumable_executor`, `tomb:probe_skipped_unsafe_body`, `expected_state_mismatch` |
| 20 | [0008] `vault_create_secret` TOMBSTONED on 0001-0008 | `UNEXPECTED_PRESENT` | `live:secmode_mismatch`, `live:proconfig_mismatch`, `live:body_mismatch`, `live:probe_skipped_structure`, `live:acl_explicit_mismatch`, `live:acl_effective_mismatch`, `live:acl_missing_executor`, `expected_state_mismatch` |
| 20b | [0008] `vault_update_secret` TOMBSTONED on 0001-0008 | `UNEXPECTED_PRESENT` | `live:secmode_mismatch`, `live:proconfig_mismatch`, `live:body_mismatch`, `live:probe_skipped_structure`, `live:acl_explicit_mismatch`, `live:acl_effective_mismatch`, `live:acl_missing_executor`, `expected_state_mismatch` |
| 55 | [0008] a post-0008 routine back-ported onto the reference schema | `UNEXPECTED_PRESENT` | `absent:routine_exists`, `overload_unexpected` |

Mutant 17 is the headline. In one report, on one database:

```
key                          kind  sqlstate  final                     reasons
owns_account                 live  42501     ACL_DRIFT                 live:acl_explicit_mismatch,
                                                                       live:acl_effective_mismatch,
                                                                       live:acl_missing_executor,
                                                                       live:probe_failed
vault_create_secret          tomb  P0001     INTENTIONALLY_TOMBSTONED  {}   (service_role sees 42501)
vault_update_secret          tomb  P0001     INTENTIONALLY_TOMBSTONED  {}   (service_role sees 42501)
vault_delete_secret          tomb  P0001     INTENTIONALLY_TOMBSTONED  {}   (service_role sees 42501)
create_account_atomic        tomb  P0001     INTENTIONALLY_TOMBSTONED  {}   (service_role sees 42501)
record_account_verification  tomb  P0001     INTENTIONALLY_TOMBSTONED  {}   (service_role sees 42501)
```

Same SQLSTATE for `service_role`, opposite verdicts, because only the
tombstones also carry the derived body, the sealed role landscape and the
privileged `P0001`. `owns_account` gets `tomb_applicable: false` next to its
`42501`.

## Every check is pinned to a mutant

A falsification suite can be green while a check has been deleted, if no mutant
ever required that check's output. That was measured here: with an entire ACL
check removed from the classifier, the 23-mutant suite was still `SUITE GREEN`,
because 20 of the classifier's 41 reason codes were required by nothing.

The classifier now publishes a **reason-code registry** — every code it can
emit, declared once, with control `C19` failing the run if it ever emits a code
that is not registered. The suite parses that registry and requires, before it
starts a single container:

* every registered code is required by at least one mutant, **or** declared
  unreachable in the suite with a written justification;
* every code a mutant requires actually exists in the classifier (so deleting a
  check turns the suite red even before the mutant runs);
* every registered code appears in the classifier at least twice — once in the
  registry and at least once in a check. **The count is taken over the
  classifier with its SQL comments stripped.** It used to `grep` the raw file,
  so a code whose real check had been deleted, but which was still *named* in a
  comment — a section header, a justification, an `-- emits foo:bar` note —
  counted two and passed. Four guards in this programme have already fired on
  their own documentation; this one was one comment away from the opposite and
  worse failure, a guard that *passes* on documentation, which is silent.
  Measured before the change: all 62 codes already had two or more occurrences
  after stripping, so this closed a latent weakness rather than an active false
  green. The stripper carries a planted positive control in both directions —
  an occurrence planted in a line comment and a block comment must become
  invisible while one planted in real code stays visible, and a real code's
  count must be unchanged — so a stripper that silently returned its input
  cannot restore the old behaviour unnoticed;
* nothing is both required and declared unreachable;
* no code declared unreachable appears in **any** report the run produces;
* every routine **the migration set** tombstones — the extractor's union over
  both mechanisms and every file, not one section of one file — is the
  **key of at least one mutant**
  — the suite-level mirror of `C20`. Without it a sixth tombstone could gain an
  expectation row that nothing ever falsifies: an object the suite watches but
  never tests.

The registry parser has its own positive control (it must find at least 40
codes, including named ones — it currently finds 62) and negative control (it
must not invent one), so a parser that silently found nothing cannot make the
coverage claim trivially true.

**Three** codes are declared unreachable, each with a written justification the
suite verifies, and each with a named detector that is proven live some other
way — a declaration of unreachability is not permission to stop checking:

| code | why no mutant can reach it | detector proven live by |
|---|---|---|
| `tomb:probe_side_effect` | the privileged probe is invoked only when the body matches the shape derived from 0022 — `begin raise exception <literal> using errcode = <literal>; end;` and nothing else — and such a body cannot write | classifier control `C17`, which wraps the same counter around a statement that really does write |
| `dep:closure_missing` | `cc_dep_obs` is an unfiltered `create table … as select … from cc_dep_expect`, so it carries one row per declared dependency and cannot be empty while the expectation is not. It is kept as defence in depth against a later `where observed is not null` that would silently disable the closure check for exactly the dependency that stopped resolving | classifier control `C29`, which requires at least ten closure rows observed, none null, and a known-good row reading back the right value |
| `tomb:probe_not_invoked` | it needs `tomb_probe_safe` true and no tomb probe row, but `tomb_probe_safe` implies a derived-target row exists, which is `tomb_applicable`, and the only remaining ways to be unselected — unresolved, or the name is not a function — both make `tomb_probe_safe` false. Mutant 46 used to reach it, when the tombstone probe was the `else` branch of the live probe; that gate is gone, which is what lets 0017's two shims be probed at all | `assert_mutant_46_evidence` in the suite, which requires mutant 46's report to show the privileged probe actually running (`kind=tomb`, `P0001`, zero side effects) even though the live structure matched |

For all three the suite additionally requires the code never to appear in any
report the run produces, so a justification that becomes false fails loudly.

## The straw-man demonstration

The suite then re-runs everything against `tests/naive-oracle.sql` and requires
the suite to go **red** on a frozen set. The straw man is green on both pristine
schemas — it looks fine — and catches exactly **two** of the mutant checks it is
run against: `01`, where the function is dropped, and `23`, where a table takes
the name. Those are the only two where the *name itself* leaves `pg_proc`, which
is the entire reach of a name-only check. Everything else — the wrong signature,
the wrong owner, the wrong body, an executable overload, a grant to
`supabase_auth_admin`, a new superuser, a membership escape, a predicate that
authorises everything when there is no JWT — is invisible to it, and most of it
is reported as `INTENTIONALLY_TOMBSTONED` because the call answered `42501`.

Eight mutants — `52` through `59` — are **not run** against the straw man. They
are keyed on `create_account_atomic`, `record_account_verification`,
`resolve_create_operation`, `reconcile_cash_flow_mirror` and
`replace_equity_snapshots`, and the straw man does not enumerate any of those
names: it would emit no verdict line for them, and scoring it red for *silence*
would put a false detection claim into the demonstration. Teaching it those
names would also make it stronger than the harness it is supposed to model. The
exclusion is checked rather than asserted — the suite verifies that each
excluded mutant is keyed on an object `naive-oracle.sql` genuinely does not
mention, and fails if one ever is.

Mutants `60`–`63` are in the blind set for a sharper reason. The straw man **does**
enumerate `owns_account`, **does** call it, and **does** get a correct answer
back — and every one of those four mutations leaves that answer correct while
destroying the authorization. Being blind to them is not a matter of not knowing
the name.

A straw-man cell the driver **refuses to run** is not evidence of blindness, and
the suite no longer counts it as such. A harness error, or a red run on either
pristine schema, is separated from a genuine miss and is **fatal**: the
comparison for that cell did not happen, so the "this classifier's strength is
load-bearing" claim is not available that run and must not be reported as if it
were. Collapsing "did not answer" into "answered wrongly" always flatters the
conclusion, because the straw man is the arm the demonstration wants to fail.

If the straw man ever caught everything, the suite fails too — that would mean
the strong classifier buys nothing.

## What a PASS does not claim

Stated plainly, because a containment tool that implies more reach than it has
is worse than one that does not exist.

**Which of these travel in the machine-readable report, exactly.**
`pass_does_not_claim` in every JSON report carries **seven** entries: no new
privileged object; the tombstone set beyond two shim mechanisms; `owns_account`
beyond its pinned body and closure; RLS-enabled is not RLS-enforced (ADV-2); the
counter-scan declaration is a self-report; runtime behaviour of any kind; and
the other generation. This page carries those seven **plus four that live only
here** — the dashboard's own code, the `trusted-policy.sh` symlink/submodule/
rename gap, the control-count argument, and the sub-items under the closure
bullet. An earlier version of this paragraph said "every item below is also
emitted in machine-readable form", which was false by four bullets: prose
claiming more reach than the artefact, in the section whose whole job is not to
do that. A downstream reader that never opens this file gets the seven; the
other four need this page.

Two of these are *inherent limits of the mechanism*, not defects waiting for a
longer list. They are marked. An inherent limit dressed up as a fix is worse
than either — and the converse holds too: the schema-scoped counter-scan gap
measured in the ADV-2 section above is a **closable defect**, quantified there,
and is deliberately not marked INHERENT.

* **INHERENT — that no new privileged object exists.** A brand-new
  `public.vault_create_secret_v2` re-exposing `vault.create_secret` to `anon`
  used to pass cleanly, and an audit demonstrated `anon` creating a Vault
  secret through one while the classifier printed a green banner. It is now
  caught, by a **whole-schema counter-scan** (section 2e of the classifier)
  that is a *set equality* rather than a watch-list: an omission from the pin
  makes the run RED, not green, which is the opposite failure direction from
  the tombstone catalogue and the reason this shape was chosen.

  That scan is complete over `public` in exactly **two dimensions**:
  1. every routine any of `anon` / `authenticated` / `service_role` can
     `EXECUTE`, with the exact role list, evaluated by PostgreSQL itself
     (`has_function_privilege`, so PUBLIC, default privileges and inherited
     membership are all included), **plus its `prosecdef` flag and its owner**;
     and
  2. every `SECURITY DEFINER` routine in `public` that can reach `vault.*`,
     by a qualified reference in the comment-stripped body or by `vault` on
     its own `search_path`.

  Dimension 1 carried the signature and the role list only until R5, and that
  version caught a **new** client-executable signature while missing an
  **existing** one repurposed — measured as a clean `PASS` with 21 of another
  tenant's rows read through `public.jwt_role()` rewritten as `SECURITY
  DEFINER`. `prosecdef` and the owner are now in the descriptor, so in `public`
  the new signature (mutant `70`), the repurpose (mutant `73`) and the reown
  (mutant `74`) are all findings.

  It is complete in those two dimensions and **in no others**. Still invisible:
  a privileged routine in a schema other than `public`; one executable only by
  a role outside those three that is nevertheless reachable from a client; one
  that is privileged for a reason other than vault **and moves neither
  `prosecdef` nor the owner** — i.e. a `SECURITY INVOKER` body rewrite, which
  runs in the caller's own row-security context and was measured returning 0
  rows past the caller's RLS; and anything that
  is not a routine at all — a view with `security_invoker = off`, a trigger, an
  event trigger, an FDW, a default expression. Widening the pin further does
  not close the schema-scoped half. Only an authorization model the database
  can enumerate would, and there is none here.

* **INHERENT — that the tombstone set is complete beyond the two shim
  mechanisms the extractor recognises.** `extract-tombstone-template.py` scans
  the whole migration set for an inline `create or replace function` whose
  entire body is a `raise`, and for migration 0022's `format()` loop. A third
  mechanism would be derived by neither — and neither `C20` nor
  `coverage.uncovered_*` would notice, *because both are computed from that
  derivation*. The derivation is the floor of the whole coverage argument; it
  cannot also be the thing that audits itself.

* **Semantics beyond the probes, the body pin and the pinned closure.** Every
  non-`ABSENT` row pins its body by digest and a table constraint keeps it that
  way, and `owns_account` additionally pins the dependency closure its
  predicate relies on. The pin is a digest of *this* body, not a proof that the
  body is correct: if the pinned body were ever wrong, the classifier would
  faithfully certify it. A rewrite of something *outside* the pinned closure
  that still changes the answer is not modelled.

  The closure itself has three residual limits, stated so a PASS cannot be
  rounded up past them:

  1. **It is one level deep.** `auth.uid()`'s own body digest, owner, language,
     security mode, volatility, `proconfig` and overload count are pinned. What
     `auth.uid()` in turn calls is not.
  2. **It exists for `owns_account` only.** No other catalogued routine has a
     dependency closure at all; the other eight are pinned by their own
     definition, ACL and probe and nothing further.
  3. **Only its `function` and `relation` arms are derived.** Those are parsed
     out of the **union** of the pinned body text and the pinned policy
     expressions and checked for completeness by `C27`, whose
     parser is itself controlled by `C28`. Until R5 the source set was the body
     alone, which was one term short: the tenant boundary is the *policies* as
     much as the predicate they call, and a policy re-pinned to
     `owner_id = auth.jwt() ->> 'sub'` would have added a dependency nothing
     required to be declared. Measured on both generations, the union adds
     nothing **today** — `auth.uid` is already there, but only because
     `owns_account` happens to call it too, and on `0008` the `own accounts`
     policy calls it directly. That coincidence was load-bearing and
     undocumented; it is now a consequence. The `rls`, `policy` and `policyset`
     arms cannot be derived — which tables the predicate guards is not visible
     in the predicate — so the table list is written out per generation. `C34`
     and `C35` are what keep that list honest, by requiring it to cover every
     table `pg_policy` shows routing through `owns_account`; a routed table the
     list does not name makes the run **refuse**. That is a cross-check against
     the database, not a derivation from the routine, and the difference is the
     limit.
  4. **The policy-set pin is scoped to this closure.** It pins the complete
     policy set of the four guarded tables plus `public.accounts`, so an added
     permissive policy on any of them is a finding (ADV-1, mutants 64/65). A
     permissive policy on a `public` table that does *not* route through
     `owns_account` is outside it. That set is **derived** and published as
     `authz_closure.outside_closure_policy_bearing` (control `C39`): **seven**
     tables on `latest`. It is a different control from a different premise and
     this file does not have one.
  5. **The older `policy` arm's expected string is still rendered relative to
     the connecting role's `search_path`.** The ADV-1 `policyset` arm renders
     every expression under a fixed `search_path = pg_catalog` and `C35` counts
     how many routed policies come back schema-qualified; the `policy` arm
     predates that and pins the rendering `supabase_admin`'s path produces
     (`owns_account(account_id)`, unqualified). It fails **closed** — a changed
     path makes the pin mismatch, not match — so this is a maintenance hazard,
     not a hole, and it is left alone deliberately because changing it changes
     what mutant 63 asserts.
  6. **The `guarded` arm is scoped to the same table list.** It pins the owner,
     `relkind`, `relrowsecurity`, `relforcerowsecurity`, every `pg_inherits`
     edge and every dependent view of each table in the closure (ADV-2, mutants
     66-69, 72 and 75). A view, inheritance edge or ownership change on a
     `public` table *outside* the closure is not seen — including `cash_flows`
     and `trades` as base tables on generation `latest`, which left the client
     read surface in 0011/0012 and therefore carry no policy to route.

     All six of those properties report the **same** reason code,
     `dep:guarded_table_exposed`, so the suite's reason-code coverage assertion
     cannot see a property that no mutant moves — and one, `relkind`, was
     exactly that until R5. Two things closed it: mutant `75` swaps a guarded
     table for a view over an unguarded copy of itself, and
     `assert_guarded_property_coverage` in the mutation suite requires each of
     the six properties, derived from the pristine report's own closure rows, to
     be observed **not ok** by some mutant in the run. The second is the durable
     half: a seventh property added without a mutant is now red, not unmeasured.

* **That RLS being ENABLED means the policy decides anything.** Enabled is
  necessary and not sufficient, and for four rounds `relrowsecurity` was the
  only thing pinned. The full enumeration of what PostgreSQL offers, and which
  of it this file pins, is the ADV-2 section above; in summary — **pinned**: the
  table owner, `FORCE ROW LEVEL SECURITY`, `relkind`, inheritance and partition
  edges, dependent views (all per guarded table), plus `BYPASSRLS`, the
  superuser set, the role-membership graph and `relrowsecurity` itself.
  **Measured and not a bypass, so deliberately unpinned**: a per-role
  `row_security = off`, membership in `pg_read_all_data`, a table-level `GRANT`,
  and a **column-level** `GRANT` (three `attacl` entries, still 0 rows — RLS
  filters rows before column privileges are consulted). **Not pinned**: a
  view, inheritance edge or permissive policy on a table outside this closure, a
  `SECURITY DEFINER` routine reading a guarded table from another schema, a
  trigger, an FDW/`dblink`/replication slot, qual leakage through a
  non-leakproof function, **a plain data copy** (measured: `PASS`, 21 rows read
  from the copy, and **no `pg_depend` edge at all** between copy and source —
  inherently hard for a catalogue classifier, because the sensitivity is in the
  content), and **a foreign key to a guarded table used as an existence oracle**
  (measured: `PASS`, key 1 accepted, key 999999 refused by name, attacker reads
  0 rows — closable, because `pg_constraint.confrelid` names the guarded table,
  and not closed here because the dependent-relation observer walks `pg_rewrite`
  only).

  `FORCE ROW LEVEL SECURITY` is **off on every table in this schema** — measured
  on pristine clones of both generations — so the owner pin is the load-bearing
  half of that pair and the FORCE row is pinned at `f`. That is drift detection,
  not hardening: this directory does not write migrations, and turning FORCE on
  would be a schema change with its own revalidation.

* **Runtime behaviour, of any kind.** This is a static classification of one
  disposable clone of one schema generation, built from the migrations on disk.
  It is not evidence about the deployed database, and it is not the runtime
  canary in `runtime-canary/`.

* **The other generation.** A PASS on `0008` says nothing about `latest`, or
  the reverse. Each run classifies exactly the generation named in its report.

* **The dashboard's own code.** This directory classifies the database. What
  the application does with the answers is the reachability proof's problem.

* **That the identity boundary rejects a real symlink, submodule or rename.**
  `trusted-policy.sh` refuses all three, and its 120000/160000 matcher is now
  proved live on a planted row inside the policy — a control
  `tests/trusted-policy.test.sh` asserts is reported in every run, with a
  red-before that neuters the matcher in a copy and requires the control to
  notice. What is *not* executed anywhere is the end-to-end path: no test builds
  a candidate commit that really contains a symlink, a gitlink or a rename,
  because that means writing git objects and this harness writes none. The
  rename/copy arm (`R*|C*`) has no case at all. That is a gap in the test, not a
  claim about the policy, and it is closable by a harness allowed to create
  commits in a disposable clone.

  Until that suite existed, `trusted-policy.sh` had **no test of any kind**,
  and section 3 printed `ok  no symlinks or submodules under dashboard/`
  unconditionally — including on a candidate whose `dashboard/` tree has zero
  entries. Measured on this repository's root commit `d2bbd8a5`:
  `git ls-tree -r d2bbd8a5 -- dashboard/ | wc -l` is `0` and the line was
  printed anyway.

* **That every control the classifier defines actually ran.** `cc_result()`
  refuses on `exists (select 1 from cc_control where not ok)`. That is an
  absence claim over a table the controls populate *themselves*: a control whose
  `insert` never executes contributes no row, and the gate reads that as "no
  failed control" — the same shape as a coverage list nobody can see is short.
  Nothing in the classifier or the driver counts them. Measured: reports kept
  from 2026-08-16 carry **35** controls and report `failed: []`; reports from
  after `C34` landed carry **36** and report `failed: []`; reports from after
  `C35`/`C36` (ADV-1) landed carry **38**; after `C37`/`C38`/`C38b` (ADV-2),
  **41**. Four of the 35-control ones are the
  AUD-3 green-after evidence.

  The mutant suite now checks it, in two layers, because one is a counter
  compared with itself — measured, in the first draft of this very repair:
  excising `C22`'s whole `insert into cc_control` statement from a disposable
  copy left the derived-vs-report comparison reporting *"all 35 controls the
  classifier defines are present in every report"* and the run exit `0`.

  1. the **derived** roster (parsed line-anchored out of the classifier's own
     text, with a positive control on the parser) must equal the roster
     **pinned** in the suite. A control deleted from the classifier is red; so
     is a new one, which is deliberate.
  2. every real-classifier report the run produced must carry exactly the
     derived roster. A control whose insert is conditional and does not fire is
     red.

  Both arms are falsified by execution. With `C22`'s insert wrapped in
  `if false then … end if;` the classifier still returned **PASS** on both
  pristine generations and the driver still exited `0` — every pre-existing
  check in the system stayed green — and only this assertion turned the run red.

  It is not a claim that the file defines the *right* controls; only that the
  set is what it was pinned to be and that none of them silently stopped
  running.

## Housekeeping

Base images are ~1.3 GB each, and each distinct input set gets its own tag. The
driver prints a note when superseded tags for a generation are still on disk.
Remove them with

```bash
docker image ls nt-catalogue-classify-base
docker image rm nt-catalogue-classify-base:g0008-<digest> nt-catalogue-classify-base:glatest-<digest>
```

or force a rebuild of the current one with `--rebuild-base`. Clone containers
are named `nt-catclassify-run-*` / `nt-catclassify-build-*` and are removed on
exit unless `--keep` is passed.
