# runtime-canary — an executed proof that the frozen bridge never reaches the THREE INSTRUMENTED wrappers

*The title used to read "…never reaches the tombstoned wrappers". The derived tombstone set across
the migration series is **eight**; this harness instruments **three** of them. The body has always
said so within twenty lines, and the `tombstone-set` scope statement printed with every verdict says
it too — but a title is what gets quoted, so it now says what is actually proved.*

The containment argument for the pre-migration bridge image is that its mutating
handlers return a constant `503` and never touch `vault_create_secret`,
`vault_update_secret` or `vault_delete_secret` — the three tombstoned routines
the bridge's credentials path could reach (replaced by a `P0001` raise, with
`EXECUTE` revoked from `PUBLIC`, `anon`, `authenticated` **and**
`service_role`).

Migration `0022` tombstones **six** routines, not three, and it is not the only
migration that tombstones anything: `0017` turns `reconcile_cash_flow_mirror`
and `replace_equity_snapshots` into the same kind of hard failure, so the
derived set across the migration series is **eight**. Of 0022's six, section 5's
loop does five — the three Vault wrappers plus `record_account_verification` and
`create_account_atomic` — and **section 2 does a sixth inline**:
`resolve_create_operation(uuid, uuid)` is replaced by a `raise … using errcode =
'P0001'` and then `revoke all … from public, anon, authenticated, service_role`,
the same mechanism written out by hand instead of in the loop
(`0022_fingerprint_binding_and_token_generations.sql`, lines 150-167).

This harness instruments the three Vault wrappers because they are the ones the
frozen image's credentials helper could call. **Nothing in this directory covers
the other five.** They are the catalogue classifier's business, and an audit
found that classifier's "derived" set scoped to section 5 of `0022` — a subset
reporting itself whole, the same shape as the defect this directory has been
repaired for twice. That scoping has since been widened in
`.github/containment/`: the extractor there scans the whole migration set by
mechanism and reports eight targets across `0017` and `0022`, and each of them
now carries an expectation row, a verdict and at least one mutant. This README
is still not the place to certify that — read
`.github/containment/CATALOGUE-CLASSIFIER.md` for its current state, its
residual limits and its own audit history.

So: do not read the three wrappers here as the complete tombstone set.
`verdict.mjs` states that limit in `verdict-scope.json` on every run, so it
cannot be lost by a reader who only looks at the exit code.

**Neither is row-level security this directory's business, and it is not
"enabled = enforced" over there either.** Row-level security being ON is
necessary and not sufficient: a table's owner is exempt from its own policies
unless `FORCE ROW LEVEL SECURITY` is set, a role carrying the `BYPASSRLS`
attribute reads everything, an inheritance or partition parent is read with the
*parent's* policies, and a view runs in the *view owner's* row-security context
unless it is `security_invoker`. All four were measured as live cross-tenant
reads against the fixture schema while the catalogue classifier returned `PASS`,
and all four are now pinned there (`ADV-2`, mutants 66-69/71/72/75). What is
still *not* pinned — a view, inheritance edge or permissive policy on a table
outside `owns_account`'s closure; a `SECURITY DEFINER` routine **in a schema
other than `public`**; a trigger; an FDW; a plain `create table … as select`
copy of a guarded table; and a foreign key to a guarded table used as an
existence oracle — is enumerated in `pass_does_not_claim` in every classifier
report and in `.github/containment/CATALOGUE-CLASSIFIER.md`. Nothing in this
directory checks any of it.

An earlier version of this paragraph drew that boundary at "a `SECURITY
DEFINER` routine in another schema", which was wrong in a way worth recording
because it is the shape this whole programme keeps finding. The real line was
never `public` versus elsewhere; it was **new** versus **existing**, and it ran
straight through `public`. The classifier's counter-scan pinned each
client-executable routine's signature and grant list and not `prosecdef`, so a
brand-new routine was caught and an existing one rewritten as `SECURITY
DEFINER` was not — measured over there as a clean `PASS` with 21 of another
tenant's rows readable through `public.jwt_role()`. `prosecdef` and the owner
are now in that descriptor, so in `public` a new signature, a repurpose and a
reown are all findings; the schema-scoped half is still open and is labelled a
closable defect rather than an inherent limit. None of this is a claim about
this directory: it is here so the sentence a reader carries away from this page
is the one the classifier can actually support.

That argument is normally made statically: nothing imports the credentials
helper, so nothing can call it. It is a statement about names someone searched
for. This harness replaces it with a statement about a process that ran.

```
   the image under test                the disposable stack
   ────────────────────                ────────────────────
   POST/PUT/PATCH/DELETE   ───────►    nt-canary-app    (the image, unmodified,
   × 24 freeze-flag combos                               with an in-process
   × unauth + auth                                       instrument --require'd)
   × 2 migration generations
                                             │
                                             ▼
                                       nt-canary-sink   (records every Auth /
                                                         PostgREST / RPC request,
                                                         forwards the real ones)
                                             │
                                             ▼
                                    nt-canary-pg-0008   (supabase/postgres, by
                                    nt-canary-pg-0023    digest; CANARY installed
                                    one at a time        over all three wrappers)
```

The two generations' servers are named and aliased **per generation**, and the
gateway is pointed at a container name rather than at a shared alias. They used
to share the alias `nt-canary-pg` and the `0008` server was never torn down
before the `0023` server started, so for the whole of the second generation two
live databases answered to the one name the gateway was configured with and
docker's embedded DNS round-robined between them. Every `0023` cell — including
the generation witness below — could have been served by the pre-tombstone
database. `run.sh` now resolves the name from inside the network and refuses the
generation unless it maps to exactly one address, this generation's.

Everything runs on a `--internal` docker network whose isolation is asserted at
run time, so a broker call cannot leave the host even if the image tries one.

---

## What a PASS does not claim

Every round of this harness has been broken by a reader taking its PASS to mean
more than it did, so the limits are emitted as data — `verdict-scope.json`, in
the artefact directory, on **every exit path** — and printed with the banner.

That used to be true only of the paths that *reached the verdict stage*. The
twenty-three refusals before it — `PROVENANCE_CONTRADICTED`,
`PROVENANCE_MISSING`, `MANIFEST_MALFORMED`, `SCHEMA_AXIS_MALFORMED` and the
rest — wrote nothing, so over a directory that had already been verdicted the
**previous run's `{"status":"PASS"}` survived the refusal**: measured 6m46s
stale, exit 3 on the console and PASS in the file the scope statements tell
readers to prefer (audit finding ADV-4). Editing those twenty-three sites would
have closed twenty-three and said nothing about the twenty-fourth, so the fix
is structural instead: `verdict.mjs` **deletes** `verdict-scope.json` before it
does anything else, and a **process-exit hook** — which cannot be forgotten by
a later edit — writes the terminal record, carrying the stderr the run actually
produced. Three states are meaningful:

| the file says | it means |
|---|---|
| `status: PASS` / `PARTIAL` / … with no `verdictReached` field | a verdict was reached; this is that verdict |
| `verdictReached: false` | this run **refused**, and `reason` is why. A green here is never a leftover |
| **no file at all** | `verdict.mjs` rejected its own command line before it had an output directory to write to |

Items marked *inherent* cannot be closed by a better check; they are properties
of the mechanism, and the honest response to them is to say so, not to build a
gate that pretends otherwise.

| | it does not claim |
|---|---|
| *inherent* | **"no Vault write is reachable."** The canary instruments exactly `public.vault_create_secret`, `public.vault_update_secret` and `public.vault_delete_secret`. An audit wrote a new `SECURITY DEFINER` routine calling `vault.create_secret` directly, granted it to `service_role`, created a real secret — and these counters did not move. A signature-keyed sensor cannot enumerate names that do not exist yet. What a zero means is: *the image did not call those three routines.* |
| | **"every routine `0022` tombstones is contained."** `0022` tombstones at least six; three are instrumented here and the rest belong to the catalogue classifier, whose own derivation was found section-scoped (see the top of this file). |
| | **"every mutating surface was driven."** Server Actions are not enumerated and not driven; they are covered statically in the bridge checkout. |
| | **"the sensor is proven live end to end for all three wrappers."** Property B's hits reached `vault_delete_secret` only, and only on `0023`: `drive.mjs` deliberately sends a metadata-only `PATCH` body and `POST /api/accounts` is the broker positive control, so create/update are unreachable through the driven surface by design. For those two, liveness rests on the trusted runner's synthetic challenges. `verdict-scope.json` prints the per-wrapper matrix-attributed counts of the run in hand rather than a remembered claim. |
| *inherent* | **"these artefacts cannot be forged."** **They can.** Every cell identity, every generation witness, every request observation and every in-process claim is cross-checked against a file the driver did not write, which raises the cost of a forgery from *local* to *consistent* — and that is the whole of what it does. **Measured, by an auditor, against this exact code:** the C attack (one cell's request observations pasted into twenty-three others) is restored by **9 further lines**, and the B attack (one generation's 24 results filed under the other's names) by **14**, in both cases by importing this harness's own `driver/observation.mjs` and rewriting the *second* observer — the gateway's log — to agree. Nothing inside this harness can close that: the gateway's log is a file on the host and the harness has no authority over a host filesystem. Nor is a driver that lies while it runs defended against: it originates the observations it attests. **Those 9/14/15-line figures are the cost of RESTORING three specific attacks consistently once each was refused — they are not a floor for artefact edits in general, and the sentence that used to stand here ("what is closed is an artefact directory edited afterwards by someone who edits only part of it") read as if they were. It was false. MEASURED this round, four runs over one genuine 48-cell set: a `POST https://paper-api.alpaca.markets/v2/orders` appended to the *image's own log* inside a request window — the file this harness exists to read, nothing else touched — was refused (rc=3); flipping the single leading `{` of that line to `x` made it unparseable, every reader skipped it in silence, and the same directory certified `rc=0, PASS, hardFailures 0`. Hiding a recorded broker call cost one byte. That one is closed by the round-7 unparseable-line refusal (see below), and the same directory now refuses naming `instr/0008-m-off__s-off__b-probe.jsonl:14`.** So the boundary, stated honestly: a partial edit is DETECTED where the edited file is cross-checked against a file the driver did not write, whether the edit leaves the file parseable or not — both are refusals now. It is NOT detected when every observer of the same fact is edited to agree, and that is what the 9/14/15 lines bought. No list of partial edits here is a proof that the next one is covered; only a cross-check that fires is evidence, and they are enumerated one by one in `claimEvidence` and `controlEvidence`, not summarised as a property. |
| *inherent* | **"the trusted runner's report is authentic."** It is *sealed*, not signed. `verify-sensor.sh report` HMAC-SHA256s its report body with the 256-bit key it draws at `arm`, and the verdict re-verifies that seal, the run manifest's seal and every challenge-ledger line's MAC before believing any of them — which closes the measured attack of deleting every runner artefact and typing eight lines of plain text (audit finding ADV-3). But the key is written into the artefact directory, because a re-verification has to be able to check the seal, so an operator who holds the directory holds the key. **Measured:** turning a genuinely `UNTRUSTWORTHY` sealed run into a `TRUSTWORTHY` one — body, seal, readable file, manifest MAC and all twelve ledger line MACs, consistently — costs **15 executable lines of node** and produces a full certifying PASS. |
| | **"the in-process claims were checked against the driver."** They are decided *from the image's own log*, not from the driver's transcription of it, over request windows the recording gateway defined. That is the D repair below; before it, appending two lines to `instr/0023-…​.jsonl` produced `PASS` with `noBodyParse: 480 satisfied, 0 violated`. Those windows cover only about **11%** of a cell's gateway timeline — the rest is the driver's own `#witness` and `#idle` bookends — and an auditor moved the same events 742 ms past the last window and got the PASS back (ADV-1). So every line of `instr/<schema>-<cell>.jsonl` must now be **attributed**, to the boot snapshot the cell result declares or to exactly one bounded request window; an unattributed line is a refusal, and the counts are in `claimEvidence` for every generation. *Unattributed is not absent.* **That was true only of PARSEABLE lines until round 7.** Attribution ran over the rows `JSON.parse` returned, so a line that did not parse was in no bucket, in no denominator, and therefore *absent*: measured, one byte flipped in a recorded broker call hid it and the directory certified. Every physical line of every instrument log and of the gateway log must now parse; an unparseable line is refused by file, physical line number and the parser's own message, and the raw line count is published beside the parsed one so the two denominators can be compared by hand. Two inputs remain driver-only and cannot be observed from any other file: the V8 coverage markers (`markDelta`, which contribute to `noSupabaseClient` and `noBrokerCall` **alongside** the events) and `routeExec` (`handlerNotReached`). They are read over the instrument's control surface and never written to the bind mount. |
| | **"the `/__canary` control plane is the driver's."** It is the one class no claim reads, and until round 9 that exemption was granted to a *path prefix*: the gateway serves `/__canary/{cell,health,generation,observe}` unauthenticated to every container on its network, the image under test included. Measured — a real `GET /__canary/health` row produced by a container that was not the driver, spliced into a claimed request window, certified `rc=0` with `noDatabaseCall 480 satisfied`. Every `/__canary` row must now match the driver's protocol. **Residual:** an image calling `GET /__canary/health` while the *first* cell of a generation boots is indistinguishable from `run.sh`'s readiness poll and still certifies; closing that needs a per-run control credential at the gateway. |
| | **"every destination the image could reach is watched."** Until round 8 it was *two path prefixes*: `/rest/v1` and `/auth/v1`. `/storage/v1`, `/graphql/v1`, `/realtime/v1` and `/functions/v1` all classified as `"other"` on **both** observers, no claim read `"other"`, and `noUnexpectedNetworkCall` permits anything addressed to the gateway host — so a gateway row on any of them produced **16 of 16 claims SATISFIED** and certified, with the self-consistent label both observers would honestly write for it. The classification is now total over the Supabase surface and every class is read by a named claim (see the table in the round-8 section); an **unclassified** destination is a refusal, not a silence. What this still does not claim: the surface list is the Supabase surface *as this harness knows it* — a deployment that grows a new front door lands in `unclassified`, which refuses, but the harness will not know its name; and the gateway 404s everything except `/auth/v1`, `/rest/v1` and `/__canary`, so a row on another surface records an **attempt**, not a completed read. |
| | **"the verifier is independently attested."** This directory is untracked. `expected/trusted-digest.txt` pins its content, but the pin lives in the same working tree. |
| *inherent* | **anything about another image, a later commit, or a generation not driven.** |
| *inherent* | **that the `CASES_INTENDED` list in a suite is complete.** Every suite in `tests/` now reconciles a closed `CASES_INTENDED` set and fails when it exits before its own summary — but that set is a hand-written roster in the same file as the cases it counts, so deleting a case AND its roster entry is consistent and invisible. Only `run-all.sh`'s roster is duplicated in a second file (`k11`'s `EXPECTED_ROSTER`) and cross-checked against the filesystem. A roster can only be checked against something outside itself, and inside one file there is nothing outside it. |

### Residual limits of the suite-coverage repairs

Stated plainly rather than implied:

1. **All fourteen suites now reconcile a closed case set** (closed set + `seen`
   hook + EXIT trap). The eight that did not — `k1`, `k2-claim-completeness`,
   `k3`, `k5`, `k6`, `k8`, `k10`, `k12` — were given one on 2026-08-17, with
   `k12` also gaining an explicit case token as the first argument of every
   `pass`/`fail` rather than a word in its prose. Measured red-before and
   green-after on `k10`, whose N5 case block was deleted in a copy: **before**,
   `6 passed, 0 failed`, exit 0 — a silent omission; **after**, `FAIL COVERAGE
   these intended cases never reported: N5`, exit 1. The EXIT trap has its own
   control: a copy truncated mid-suite with `exit 0` after N3 exits **2** with
   "the suite exited (rc=0) WITHOUT reaching its summary; 4 of 7 cases had
   reported". What remains uncloseable is item 2 in the table above — the
   roster itself.
2. **`NON_CASE_SCRIPTS` in `run-all.sh` is an escape hatch.** A new file added
   to that list is exempt from the disk→plan check. It is three entries long
   and each carries a reason; nothing enforces that the reason is true.
   (The scan it exempts a file *from* is now recursive and extension-agnostic:
   it was `find -maxdepth 1 -type f -name '*.sh'`, so a suite added as `.py`,
   `.mjs` or under `tests/<subdir>/` was invisible to it. Measured: with
   `tests/k98-….py` and `tests/extra/k97-….test.sh` planted and no `.sh` plant,
   the old scan printed fifteen `RUN` lines and exited **0**; the new one exits
   2 naming both. `k11`'s N7 and N8 hold it.)
3. **No CI runs any of this.** `.github/workflows/dashboard-containment-gate.yml`
   runs `trusted-policy.sh`, the dashboard suites, the bundle scan and
   `dashboard/test/schema-compat/run.sh`. It does not run `runtime-canary/tests/run-all.sh`
   and it does not run `.github/containment/tests/` at all. Everything here is
   evidence produced by hand, on demand, and dated by the artefact directory it
   was produced from.

---

## The three properties

A sensor that has never been seen to fire is not a sensor, and a zero from an
untested detector is not evidence. The suite is therefore built around three
claims, and it will not report the first without the other two.

| | claim | how it is run |
|---|---|---|
| **A** | the frozen image produces **zero** canary hits across the entire matrix | `--mode frozen` |
| **B** | a deliberately **unfrozen mutant** of the same source **does** reach the canary through the same stack | `--mode mutant` |
| **C** | **deleting, muting or ignoring** the canary makes the suite **fail** | `--mode mutant --break-sensor drop \| mute \| verdict`, plus `tests/k1-sensor-negative-controls.sh` |

(C) has three `--break-sensor` sabotages because there are three coarse ways a
sensor gets quietly removed: someone drops it, someone leaves it in place and
guts what it records, or someone stops the checker consulting it.

**(B) was dead, and only running it found that out.** The freeze is deliberately
**two** layers — `lib/frozen.ts` says so: every mutating handler returns the
constant, *and* `proxy.ts` refuses before authentication, "either of which is
sufficient". `mutant/make-mutant.sh` undid only the first, by restoring
`app/api/accounts/[id]/route.ts` from a pre-freeze commit. The proxy was added
*after* that commit, so it survived into the mutant, refused every request at
the edge, and the mutant behaved exactly like the frozen image: a full 24-cell
`--mode mutant` run returned 503 on all 240 requests with `routeExec=0` and
**zero** canary hits. Every guard in `make-mutant.sh` passed, because every
guard was a statement about the text of one file rather than about behaviour.

The mutation is now defined over **both** layers (the proxy did not exist at the
pre-freeze ref, so restoring it means deleting it), and `make-mutant.sh`
**refuses** to emit a tree in which any surviving `proxy.ts`/`middleware.ts`
still imports the compile-time freeze constant — with the inverse assertion that
the frozen tree must contain such a layer, so the check cannot be vacuous. The
corrected mutant reaches `vault_delete_secret` and the verdict prints
`SENSOR PROVEN LIVE`.

Those three are **not sufficient**, and the harness has been caught by exactly
that. The arming check used to be `pg_proc.prosrc LIKE '%NT_CANARY_SENSOR_V1%'`
— a marker comment. A sabotage that kept the marker, kept the delegate, left
`nt_canary.log_call` completely intact and deleted the single
`perform nt_canary.log_call(...)` statement produced a provably dead sensor
that reported itself `armed`; two real calls to tombstoned wrappers then moved
no counter and the suite printed *"PASS … the canary never fired"* and exited
0.

So (C) is now carried by `sensor/verify-sensor.sh`, the **trusted runner**, and
by ten sabotages in `tests/k1-sensor-negative-controls.sh` that each have to
fail **for their own named reason**:

| sabotage | must be refused with |
|---|---|
| keep the marker and the delegate, delete the logging call | `CHALLENGE_MISSING` |
| delete the sensor after the pre-check | `SENSOR_DISAPPEARED` |
| simply do not run the post-check | `PHASE_MISSING` |
| record only for the predictable `arming-probe` tag | `CHALLENGE_MISSING` |
| write the event in the transaction the tombstone rolls back | `CHALLENGE_MISSING` |
| dead sensor plus a fabricated `nt_canary.hits()` | `COUNTER_FABRICATED` |
| record one call twice | `CHALLENGE_DUPLICATE` |
| tag events with a nonce from an earlier run | `CHALLENGE_NONCE_MISMATCH` |
| add an uninstrumented overload beside the watched signature | `DEFINITION_DRIFT` |
| edit the sealed run manifest / plant a forged expectation | `MANIFEST_HMAC_INVALID` |

### What the trusted runner actually does

* **it installs the instrumentation** — the install SQL is read only from this
  checkout and its digest verified against `sensor/expected/sql.sha256sums`
  before a byte of it is copied into the database;
* **the nonce is drawn after the artifact is fixed** — `arm` requires
  `--artifact-digest`, records it, and only then takes 128 bits from
  `/dev/urandom`;
* **a keyed run manifest** binds the expected definition digest, the nonce, the
  wrapper identities, overload counts, owners and privileges, HMAC'd with a key
  in a `0700` directory that is never mounted into any container;
* **complete normalised definitions**, not markers: every routine in
  `nt_canary` and every `public.vault_*` routine, in full, compared at every
  phase against the install-time record and against a digest pinned here;
* **a functional challenge per wrapper, per phase**, through a privileged path
  the image has no route to, requiring exactly one correlated event on three
  channels — the raw catalogue sequence, `nt_canary.hits()`, and the postgres
  server log read from *outside* the database (the one a rollback cannot
  retract);
* **before the matrix, at unpredictable points during it, and after it**;
* **the candidate cannot reach any of it** — `sensor/sql/52_tamper_control.sql`
  tries all six ways to disable the sensor as each of the four roles a request
  can arrive as, and requires all 24 attempts to be refused **with SQLSTATE
  42501**. Requiring only "refused" was not enough: renaming one target so the
  statement failed `42P01` (undefined object — the attack was never attempted)
  still yielded `refused=true` and `UNREACHABLE|attempts=24|succeeded=0`. Each
  attempt now carries the class it must fail with, the result line reports
  `wrong_class=N`, and the runner refuses to arm unless N is 0
  (`TAMPER_WRONG_FAILURE_CLASS`).

### Every request carries sixteen claims, and none of them may vanish

`driver/claims.mjs` is a closed schema. Each driven request produces exactly
one record for every claim, and each record names the sensors it was decided
from. A claim whose sensors were not all live is `indeterminate` — never
`satisfied`, never absent — and any indeterminate record fails the run before a
verdict is rendered.

The sixteenth is `refusalIdentity`, and it exists because a later audit noticed
that A3's lesson had not been applied here. `expectedResponseClass` and
`proxyRefusedBeforeAuth` asserted `status === 503` and nothing else, while the
driver was already recording `x-artifact-role`, `x-writes-enabled` and 600 bytes
of body and none of it was read. The frozen proxy has its **own** unrelated 503
branch — "Authentication service temporarily unavailable", same status, same
`Cache-Control: no-store` — which satisfied the claim identically to the freeze
refusal. The identity that must be present is committed in the manifest
(`refusalIdentity`), not written into the checker, and positive mutant 11
(`respond_503_unrelated`) answers with exactly that unrelated 503: case 11d
requires `expectedResponseClass` to stay **satisfied** while `refusalIdentity`
goes **violated**, so the new claim cannot be a second copy of the status check.

This closes a second demonstrated defect: `noBodyParse`, `noSupabaseClient` and
`noBrokerCall` used to be decided purely from instrument events, so when the
instrument was missing from a container they produced no violation and no
warning. A request that provably parsed a body and constructed a client simply
lost both claims and printed a green dash.

Cardinality is asserted against `expected/request-manifest.json`, a committed
statement of what the generated matrix must produce: 24 cells × 10 requests =
240 per generation, with an exact endpoint set. `tests/k2-claim-completeness.sh`
drives eleven positive mutants through the real image and requires each to turn
its claim red. Those eleven mutants cover **ten** of the sixteen claims (two of
them target `noPostgRESTCall`); `requestDriven`, `routeMatched`,
`responseStatus`, `proxyRefusedBeforeAuth`, `noUnexpectedNetworkCall` and
`canaryObservationComplete` have no positive mutant, and are covered only by the
C1–C3 cardinality/completeness cases and by the baseline. That is a real gap and
is stated rather than rounded up to "one per claim".

### And the identity of each cell, not just how many there were

An adversarial audit found that the paragraph above was, on its own, worthless.
The verdict established cardinality by **counting** the cell result files. It
never read *which* combination each file described. Three reproductions each
ended in exit 0 under `PASS all 24 environment combinations`, over an artefact
set in which exactly **one** combination had been driven:

* 23 of the 24 cell files overwritten with a copy of the 24th;
* a real `run.sh --cells 1 --schema 0023` whose single cell was copied to all 24
  manifest filenames;
* every cell's recorded `instrumentEnv.raw_freeze_flags` collapsed to one triple.

Worse, the surviving combination was `m-on__s-on__b-empty` — the *most* frozen
one. The cells that would actually catch a leak (maintenance off or absent) were
exactly the ones the check could not distinguish from having been driven.

So the manifest now pins the **24 cell identities** and, for each, the freeze
flags that identity means; and the verdict requires three independent statements
about every cell to agree:

| statement | written by | defeats |
|---|---|---|
| the result **filename** | the harness | nothing on its own |
| the in-file `cell` field and every request's `cellTag` | `drive.mjs`, inside the driver container | a plain file copy |
| `instrumentEnv.raw_freeze_flags` | the **instrument, inside the process under test**, reading its own environment at run time | a copy whose name *and* `cell` field were repaired |

The driven identity **set** must then equal the committed set exactly.

The same defect existed on the schema axis and is closed the same way: the claim
covers both migration generations, so the matrix is 24 × 2 = **48** combinations
and a `--schema 0023` run is `PARTIAL`, exit 4, however many cells it drove.

### And then the same defect was found one level up again

The paragraph above closed *which cell*. Nothing closed *which migration
generation*, and every one of those three statements is generation-independent:
the freeze flags, the cell name and the `cellTag`s are identical on `0008` and
on `0023`. An independent auditor copied one generation's twenty-four result
files onto the other generation's filenames and obtained

```
PASS all 24 environment combinations x 2 migration generations (48 combinations)
     ... each was observed running its own freeze-flag triple
```

with **exit 0**, one real container start, and the pre-tombstone `0008`
database — the half that shows the wrappers were reachable *before* `0022` —
never booted. Then the auditor went further: because all three "independent"
statements are three fields of **one file written by one process**, repairing
`instrumentEnv.raw_freeze_flags` alongside the name and the `cell` field
defeated the identity gate outright. The evidence that would have caught both
was already on disk, unread.

Four more witnesses close it, and three of them are files the driver did not
write:

| statement | written by | defeats |
|---|---|---|
| `dbWitness.fingerprint` — an md5 over every `public` relation's columns, every `public` routine's identity signature and every `public` constraint | the **recording gateway**, by querying the running database, on every cell | filing one generation's cells under the other's name: 0008 has 7 public routines and 0023 has 44, and each generation's fingerprint is pinned in the manifest |
| the same fingerprint in `sink-<schema>.jsonl` | the gateway container, into a host bind mount | editing the cell result alone |
| every `cellTag` present in `sink-<schema>.jsonl` | the same | 23 copies of a cell nobody drove — the gateway's log names only the cells it served |
| every boot event of the result present in `instr/<schema>-<cell>.jsonl`, matched on `seq`+`t`+`kind` | the **image under test**, in a third container | a cell whose container never started — *and* a result copied from another cell of the same genuine run, whose file, sink entries and tags all legitimately exist. Measured on a real 48-cell set: 14 of 14 for the right cell, 0 of 14 for any other |
| one `runNonce`, matching `provenance.json` | `run.sh`, before anything is driven | an artefact directory pooled from two run.sh invocations |

`run.sh` also refuses a non-empty `--out`, because
`run.sh --schema 0023 --out D` followed by `run.sh --schema 0008 --out D` left
`D` holding a complete 48-file set from two runs and nothing could tell.

`tests/k9-cell-identity.test.sh` runs all of it: the four cell-identity attacks,
the cross-generation copy (R5), the copy with filename, `cell`, `cellTag`s
**and** `raw_freeze_flags` all repaired (R6), a foreign run nonce (R7), the
schema-axis PARTIAL case, the fixture-manifest case, and two positive controls —
one per generation and one over the full 48.

Those three generation-axis cases were **written but never executed** for their
first three hours on disk: `verdict_both` was a call to a function that had been
renamed to `verdict_present`, the suite died `rc=127` under `set -Eeuo pipefail`
three cases from the end, printed no summary, and R5 — the attack the
48-combination claim rests on — simply never ran. A suite that quietly runs a
subset is the same defect as a verdict that certifies one, so the suite now
declares its intended cases, records the case token of every `ok`/`FAIL`, and
fails if the recorded set is not the intended one; an `EXIT` trap turns "died
before the summary" into a harness failure rather than a missing line. Both
halves were shown red before they were shown green: restoring the undefined
call gives `the suite exited (rc=127) WITHOUT reaching its summary; 6 of 10
cases had reported`, and disabling one case's block silently gives
`COVERAGE these intended cases never reported: R4` with `9 of 10`.

One more thing the same pass turned up: `k9` and `k4` ran their *positive
control* verdicts over the caller's artefact directory itself, and the verdict
writes `verdict-scope.json` into whatever directory it is pointed at. Reading a
real 48-cell PASS directory with either suite therefore replaced that run's own
machine-readable verdict with the suite's last case — a `PASS` directory came
back recording `"status": "PARTIAL"`. Both suites now run every case, controls
included, over a private copy, and a run's artefact directory is byte-identical
before and after the regression suites read it.

Each mechanism was also measured on its own, by ablating it in a disposable copy
of `verdict.mjs` and re-running the R5 forgery over a real 48-cell set: with the
generation witness ablated the boot-event binding still refuses it (24 hard
failures), with the boot-event binding ablated the generation witness still
refuses it (49), and with **both** ablated — the pre-B1 verdict — the forged
directory is `PASS ... (48 combinations) ... exit 0`. They are independent, and
that is measured rather than asserted.

**What this still does not defend against, stated plainly.** An operator who
rewrites the cell result, the gateway's log and the instrument's log
*consistently* defeats it. That is wholesale fabrication across three
containers' outputs, not the copy-shaped failure this closes, and no gate over
an artefact directory can do better: the harness has no authority outside its
own output. It is `inherent` in `verdict-scope.json` for exactly that reason.

> **This paragraph was, as written, false — and the next section is why.** Two
> later forgeries touched **only cell-result files**, using values the other two
> containers' logs handed them, and both got a certifying PASS. The claim that a
> forgery had to span three containers described what the author intended, not
> what the code checked. It is true again only because of the request-observation
> attestation described below; read the two sections together.
>
> **And "wholesale fabrication" is the wrong word for what it costs.** An
> auditor measured it against the repaired code: restoring the C attack needs
> **9 further lines**, restoring B needs **14**, both by importing this
> harness's own `driver/observation.mjs` and making the *second* observer — the
> gateway's log — agree. That is a short afternoon, not a fabrication
> programme. Nothing in this directory can raise it further, because the second
> observer's output is a file on the host. The honest statement is the one in
> the scope table: this makes a forgery have to be **consistent** rather than
> **local**, and an operator with write access to all three logs is not
> defended against.

---

## The observers were collected, shipped, and ignored (findings D, B, C)

Everything above binds **which cell** and **which generation**. Nothing bound
**what a request observed** — and the claims are decided from that.

### D. The harness, inverted

`verdict.mjs` read `instr/<schema>-<cell>.jsonl` for exactly two things: does it
exist, does it contain `instrument.loaded`, and are the cell's `bootEvents` in
it. Its own docblock said so. Every in-process claim — `noBodyParse`,
`noSupabaseClient`, `noBrokerCall`, `noDatabaseCall`,
`noUnexpectedNetworkCall`, `noAuthCall`, `noPostgRESTCall` — was decided from
`results[].events`, **the driver's transcription** of what the instrument
reported over its control surface.

An adversarial auditor appended two lines to
`instr/0023-m-off__s-off__b-probe.jsonl`, inside a request window:

```json
{"seq":14,"t":1786883970629,"kind":"body.parse","detail":{"method":"json"}}
{"seq":15,"t":1786883970630,"kind":"fetch","detail":{"hostClass":"broker","host":"paper-api.alpaca.markets"}}
```

Nothing else was touched. **No forgery was involved at all**: that file is
written by the image under test, and finding out what the image under test did
is the entire purpose of this harness. The verdict printed

```
PASS all 24 environment combinations x 2 migration generations (48 combinations) …
```

exit 0, `verdict-scope.json` `{"status":"PASS","hardFailures":0}`, and its own
tally read `noBodyParse: 480 satisfied, 0 violated` and
`noBrokerCall: 480 satisfied, 0 violated`.

The driver was the thing under test's own reporter, and the verdict believed the
reporter.

### B and C. A request observation belonged to no cell

Two forgeries followed from the same root, both assembled purely by **copying
values already present in the artefact directory**:

| | what was rewritten | result |
|---|---|---|
| **B** | `0008`'s 24 cell results filed under `0023`'s filenames, with `schema`, `dbWitness` and `bootEvents` pasted out of the real `0023` results in the same directory | PASS |
| **C** | one `0023` cell's `results` pasted into the other 23, with `cell`, every `cellTag`, `instrumentEnv.raw_freeze_flags` and `bootEvents` repaired from the manifest and from the instrument logs the check compares against | PASS, with **1** distinct request-observation record across the 24 certified cells (24 in the genuine set) |

Both work because a frozen image refuses every request identically, so a copied
observation is indistinguishable from the truth by inspection — and nothing
outside the cell result recorded what any request observed.

### What closes them

Three more readings, and every one of them is again a file the driver did not
write:

| statement | written by | defeats |
|---|---|---|
| the **request window** for a tag: the gateway's timestamp of the driver's `/__canary/cell` POST for that tag, to its timestamp of the next tag | the **recording gateway** | a window the driver could choose for itself; it is bounded by its own terminator |
| the **events inside it**, taken from `instr/<schema>-<cell>.jsonl` and used to decide every in-process claim. The driver's transcription is still read and any difference between the two copies is a hard failure. **Plus**: every line of that log, in or out of a window, must be *attributed* — see ADV-1 below | the **image under test** | D. Re-measured for this round over the four distinct genuine certifying runs still on this machine (run nonces `7da1ca7f…`, `21e6a343…`, `55c8d4d3…`, `3085a474…`), 480 request windows each: **1920 windows, 2385 log events, 0 diffs, 0 unattributed** — and every one of those 2385 attributed to the declared boot snapshot, so the *in-window* bucket on a frozen set is **empty** and an agreement assertion there is vacuous. It is made non-vacuous by the attack copies the suite runs each time: `k14`'s `D1` plants two events at a window midpoint and asserts they are selected and counted, `ADV1` plants three past the last window and asserts they are refused. **WHAT THOSE FOUR CORPORA ARE (disclosed R7-5):** re-measured for this round, all four predate the current request attestation. `7da1ca7f…`, `21e6a343…` and `55c8d4d3…` carry **observation version 1** and 1110 gateway rows each, 480 of them `/__canary/observe`; `3085a474…` carries **no request attestation at all** — 630 rows, **zero** observe rows, because it predates the attestation entirely. 3 x 1110 + 630 = 3960, so the 3960 total is right, but the per-run gloss "480 observe rows per pair of generations" holds for three of the four and not for the fourth. Version 1 is what `tests/run-all.sh` and `k14` now **refuse** as non-forward-portable, so **none of the four directories these aggregates were measured on could be re-verified by the harness as it stands.** They are historical measurements of an earlier attestation; reproducing them needs fresh version-2 matrices. **Superseded:** an earlier note published "720 windows / 2179 events" over four sets, three of which contributed 240 windows — *one generation each* — so the aggregate mixed whole- and half-matrix runs without saying so. Those three directories no longer exist, and no mutant image exists at this sha, so the real-mutant-timing part of that figure is historical and not re-derivable here |
| the **observation attestation**: the driver POSTs a canonical description of every request to `/__canary/observe` as it finishes — status, the six recorded headers, a body digest, both timestamps, the event and marker digests, `routeExec` — and the gateway writes it into its own log. `verdict.mjs` recomputes it from the cell result and requires equality, and requires the request's two timestamps to lie inside the window above | the **recording gateway** | B and C. A cell result rewritten after the run contradicts a file the rewriter did not write |

`tests/k14-observer-derived.test.sh` runs all of it against a real 48-cell set:
the two planted-event cases in both directions, the B and C forgeries, the E and
F cases below, and the eight ADV cases — plus a positive control that the
unmodified set still certifies, and a `MEASURED` case asserting that it did so
having read **480** gateway-defined windows, matched **480** attestations,
accounted for **every** instrument-log line against a count taken from the
directory itself, and verified the sealed sensor report, its manifest MAC and
every ledger line MAC. Without that second control every case in the suite is
rejection-shaped, and a verdict that refused everything would score a perfect
suite.

For D1 the assertion is not merely "refused": `verdict-scope.json` must record
`noBodyParse` and `noBrokerCall` as **violated**, which is the exact inversion of
the reproduction above.

### E and F. Two facts the command line was allowed to decide

| | the defect | the repair |
|---|---|---|
| **E** | `--pg-image-substituted` was argv-only. `run.sh` passes it only when it has just substituted the image, so **every re-verification path omits it by construction**. `provenance.json` had recorded `pgImage` and `pgImagePinned` since B3 and `verdict.mjs` read neither, so a run on `postgres:17-alpine` re-verdicted to a full certifying PASS. | The production digest is pinned in `expected/request-manifest.json` as `pinnedPgImage`, and pinned-ness is **recomputed** from `provenance.pgImage` against it. A run's own boolean about itself is not evidence: a `provenance.json` whose `pgImagePinned` disagrees with its own digest is a control failure (`PROVENANCE_CONTRADICTED`), and `--pg-image-substituted` is cross-checked rather than believed. |
| **F** | Delete every trusted-runner artefact — `sensor-*.txt`, the `sensor-state-*` trees, the ledger, the challenge dumps — and assert `--sensor-verdict 0008=TRUSTWORTHY --sensor-verdict 0023=TRUSTWORTHY`: PASS. `verdict-scope.json` did not record the sensor verdict at all. "An absence is only evidence from a detector known to work" was enforced inside `run.sh`'s own process and nowhere else. | The verdict is derived from the runner's report (`SENSOR_RESULT=`), argv is cross-checked against the derived value, `SENSOR_MANIFEST=verified` is required, the subtracted challenge-hit total is derived from the runner's own `SENSOR_PHASE` accounting rather than taken from `--sensor-hits`, and **both** the derived and the asserted verdict are written into `verdict-scope.json` under `sensorVerdict`. **This closure was itself defeated by retyping that report** — see ADV-3 below; the verdict now derives from the HMAC-sealed body in `sensor-state-<schema>/report-body.txt` and re-verifies the manifest and ledger MACs under the same key. |


## And then the complement of the window, and the authenticity of the report (ADV-1, ADV-3, ADV-4)

The round above closed D, B, C, E and F. An auditor broke three of them again,
all measured, and named a fourth thing that cannot be closed at all.

### ADV-1 — a window is not the whole timeline

D's repair decided the in-process claims from the image's own log **inside the
gateway's request windows**. Those windows are bounded by the driver's own tag
sequence — `#witness`, `#1`…`#10`, `#idle` — so they cover only the burst of
requests. **Measured on the certifying set: 597 of 597 instrument events fall
outside every request window, and the windows cover 10.8% of generation
`0008`'s gateway-observed cell time and 11.7% of `0023`'s.**

The auditor took the D attack and moved the timestamp about a second, past the
last window: full certifying PASS, exit 0, `noBrokerCall: 480 satisfied, 0
violated`. Then did it byte-faithfully — three events in exactly the
`{seq,t,kind,detail,stack}` shape `instrument.cjs`'s `emit()` writes
(`dns.lookup`, `socket.connect`, a `POST` fetch to `paper-api.alpaca.markets`),
742 ms after the cell's last window closed, with a `Timeout._onTimeout` stack.
PASS again. **No forgery is involved**: the instrument patches
`fetch`/`socket`/`tls`/`dns` process-wide at module load, so it records such a
call by construction, and `run.sh:961` already positively controls that it
classifies that host.

The repair existed and had not been carried in. A scratchpad measurement tool
written for the D round contained an `ORPHAN` branch that flagged all three of
the passing directories while reporting `cellsWithOrphans=0` on five genuine
sets; it was measured, reported green, and never moved into `observers.mjs`.
`observers.mjs` also *exported* a `REQUEST_TAG` regex, commented "`#witness`
and `#idle` are the driver's own bookends and are boundaries, never windows",
and never used it.

Both are now used. `attributeEvents` requires **every line** of
`instr/<schema>-<cell>.jsonl` to be accounted for by exactly one of:

- the **boot snapshot** the cell result declares, matched on the instrument's
  own `seq|t|kind` (`instrumentEvidence` already required the converse, so the
  boot prefix is now pinned in both directions — a line inserted among the boot
  events with a duplicated `seq` is caught, which a `seq > max(bootSeq)` test
  would have waved through);
- exactly one **bounded request window**, where `REQUEST_TAG` rejects
  `#witness` and `#idle` as windows even if a cell result names one as its tag.

Anything else is `UNATTRIBUTED` and refuses the run. It is deliberately **not**
filtered by event kind: a filter reopens the hole for whichever kind was
thought innocent. An instrument log for a cell no result claims is refused for
the same reason.

**And attributed is not innocent.** Accounting for an event says what explains
it, not that it was harmless — and *nothing in this harness decides a claim
from a boot event*, because the claims are per-request. So the boot bucket was
the next hiding place the repair itself opened: two edits (the instrument log
and the cell result's `bootEvents`) put an outbound broker call there fully
accounted for, and **none at all** if the image really makes one at container
start. A boot-attributed event that is an outbound `fetch`/`socket.connect`/
`tls.connect`/`dns.lookup` to anything but the harness's own gateway or
loopback, or a `body.parse`/`body.stream` before there is a body to read, is
now a refusal (`k14`'s `ADV1d`). That is an **inclusion** filter — it can only
add refusals, never excuse an event — which is why it is allowed here and not
in the unattributed set. The bucket is also published by kind in
`claimEvidence.bootEventKinds`, so a reader can see what the image did before
the first request rather than trusting that something looked. Measured across
the four genuine runs: 2385 boot events, all
`instrument.coverage`/`instrument.loaded`/`instrument.ready`/`env.read`, 0
refused.

*Unattributed is not the same as absent.* `verdict-scope.json` carries
`logEvents`, `eventsAttributedToBoot`, `eventsAttributedToWindow`,
`eventsInMoreThanOneWindow` and `eventsUnattributed` per generation, and `k14`
asserts the first two against a count taken from the directory itself, so the
zero is not a zero nobody has seen move.

Red-before / green-after, on the real certifying set with the three
byte-faithful events planted: with only the refusal disabled, `rc=0`,
`status=PASS`, `noBrokerCall {"satisfied":480,"violated":0}`; with it enabled,
`rc=3`, `INCOMPLETE_OBSERVATION`, and a message naming all three events and the
host.

**Three limits of the attribution itself**, stated because they are
refusal-shaped and a future red must not be mistaken for an attack:

1. **Unmeasured under `--mode mutant`.** No mutant image exists at this sha
   (see the Property-B note), so every set this was measured on is frozen —
   where the in-window bucket is empty. A mutant image that emits an
   instrument event outside every request window **will refuse**. That is the
   harness saying it cannot attribute the event, which is the right direction,
   but the false-positive rate on a real mutant run has not been observed.
2. **A small gap by construction.** `drive.mjs` snapshots the boot events,
   then reads `/env`, then POSTs the first cell tag. An event emitted in that
   gap is in neither bucket and refuses. Measured **0** across five real runs
   (four 48-cell, one 1-cell). Both the attribution pass and the
   transcription/observer diff refuse it, consistently.
3. **The unclaimed-log scan is name-scoped** to
   `instr/<schema>-<cell>.jsonl`. A log planted under any other name is not
   scanned — and also feeds no claim.

### ADV-3 — the report was derivable, and typeable

F's closure was defeated by **retyping the file**: delete every trusted-runner
artefact, write eight lines of plain text in the documented shape, and the
parse yields `TRUSTWORTHY` with `manifestVerified: true`. The counter
cross-check is real — wrong phase counts *are* refused — so the forger typed
the right ones. What was missing was any reason to believe the file.

`verify-sensor.sh report` now writes its body to
`sensor-state-<schema>/report-body.txt` and HMAC-SHA256s it into `report.hmac`
with the per-run key it already draws at `arm` (the same key that seals the run
manifest and MACs every ledger line). `verdict.mjs` derives the verdict **from
the sealed body**, requires the readable text file to agree with it, and
re-verifies `manifest.hmac` and every ledger line's MAC under the same key. An
`UNTRUSTWORTHY` run is sealed too, so flipping the readable file is refused.

**What it does not buy** is in the scope table above: the key lives in the
artefact directory because a re-verification must be able to check the seal, so
an operator who holds the directory holds the key — measured at 15 lines of
node to re-seal a whole untrustworthy run into a trustworthy one. This is
tamper-**evidence** against a partial edit, not a signature.

Artefact directories produced before this change carry the key but no seal, so
`tests/seal-legacy-report.mjs` writes what the runner would have written, from
that run's own report, under that run's own key. It **refuses when the key is
gone**, which is the ADV-3 attack itself, and `run-all.sh` says loudly when it
has had to use it.

### ADV-4 — a stale green outlived the refusal

See the table under *What a PASS does not claim*: the file is deleted first and
written from a process-exit hook, and "no file at all" is now a documented
state rather than an accident.

### ADV-2 — not chased, and why

B and C fall again if the forger edits the second observer consistently, at a
measured cost of 9 extra lines for C and 14 for B. That is not a defect anyone
can close from inside this harness — the gateway's log is a file on the host —
so this round states it, prominently, in three places (the scope table, the
`artefact-forgery` statement printed with every verdict, and
`verdict-scope.json`'s machine-readable `doesNotClaim`) and stops. Any wording
implying the artefact set is forgery-proof has been removed.

---

## And then the same shape three more times (round 5)

A fifth audit reproduced the four measurements above — the digest, the
`1920 windows / 2385 events` figure, the `10.8%` / `11.7%` coverage, the kind
census — by counting rather than by reading, and **all four hold**. It then
took ADV-1's repair apart. Every red below is a **full certifying PASS, exit 0,
banner printed**, over artefacts recording a real violation, and every one is
now closed with a measured green and a test.

The three are one shape: *a check narrower than the thing it checks, failing
open on the case nobody enumerated.* That is ADV-1's own shape, one level in.

**How to reproduce each red.** All three were first measured against the
pre-round-5 code; they are re-measurable today by **ablation** over the current
certifying corpus, which is stronger evidence because it isolates one check:

| ablate | in | then | red |
|---|---|---|---|
| `bootEventProblem` → the old 4-kind deny-list reading `detail.hostClass` | `driver/observers.mjs` | plant a boot `node:https.request`, or a `fetch` labelled `loopback`, to `paper-api.alpaca.markets` | `rc=0`, `PASS`, `noBrokerCall {satisfied:480, violated:0}` |
| `if (att.unaccounted.length)` → `if (false)` | `driver/verdict.mjs` | plant the two data-plane entries under `#idle` | `rc=0`, `PASS`, `noPostgRESTCall {satisfied:480, violated:0}`, with `gatewayRowsUnaccounted: 2` recorded and ignored |
| `eventIdentity` → `[seq, t, kind]` | `driver/observation.mjs` | simulate the honest broker call, then rewrite only its `detail` | ablated corpus still certifies (control); honest call `rc=1 FINDING` (control); laundered `rc=0 PASS` |

The third ablation is safe over a frozen corpus precisely because every stored
attestation has an **empty** event array, so the v1 and v2 digests coincide
there and only the planted event distinguishes them.

### R5-A — the boot judge was a deny-list, and it read a field the writer chose

ADV-1d added a judge for the boot bucket. It enumerated four network kinds and
consulted `detail.hostClass`.

| attack | artefacts touched | before |
|---|---|---|
| a `POST https://paper-api.alpaca.markets/v2/orders` recorded as **`node:https.request`** — the kind `instrument.cjs:213-234` emits for every `http`/`https` `request`/`get`, and one `claims.mjs` has always counted as egress | instrument log + `bootEvents` | `rc=0`, `PASS`, `noBrokerCall: 480 satisfied, 0 violated`, `bootEventsRefused: 0`, and the kind **published** in `claimEvidence.bootEventKinds` for a reader to not notice |
| the same call as a plain `fetch`, relabelled **`hostClass: "loopback"`**, its own `host` field still saying `paper-api.alpaca.markets` | instrument log + `bootEvents` | `rc=0`, `PASS` |

Positive control for both: the identical planter with `kind: fetch,
hostClass: broker` refused before the repair, so the planter and the detector
were known to work.

**Closed** by inverting the filter. `bootEventProblem` is now an **allow-list**
of the kinds a boot snapshot may contain — `instrument.loaded`,
`instrument.ready`, `instrument.coverage`, `instrument.error`, `env.read` — and
consults no self-reported classification at all. A kind nobody enumerated, in
the one bucket no claim reads, refuses. The egress list that names the kind in
the refusal message now lives **once**, in `claims.mjs`, exported and imported
rather than copied; `k14`'s `R5A` loops over that exported set instead of
picking a kind by hand.

### R5-B — the *second* observer had the same unread complement

ADV-1 accounted for every line of the **image's** log. Nothing accounted for
the **gateway's** — the observer that exists precisely because the instrument
runs inside the thing under test. It was read in exactly one way,
`sinkMap.get(<cell>#<n>)`, so entries under `#witness`, `#idle` or `(unset)`
were parsed, bucketed and judged by nothing.

> **Before:** a `GET /rest/v1/accounts` and a `GET /auth/v1/user`, in the shape
> `sink.mjs` writes, inserted in place under one cell's `#idle` tag — **no
> instrument event, no cell result touched** — `rc=0`, `PASS`,
> `noPostgRESTCall: 480 satisfied, 0 violated`. The `#witness` variant too.
> Under a *request* tag the identical pair is refused (`rc=1`, `FINDING`),
> which is the positive control that the reading path works and the complement
> was the hole.

**Closed** by `attributeGatewayRows`: every entry that is not the harness's own
`/__canary` traffic must fall under a request tag some cell result claims.
Counted in `claimEvidence.gatewayRowsUnaccounted` and printed with the verdict.
Measured on the four genuine runs: **3960 entries, 3960 of them `harness`, 0 of
any other kind**, so the exclusion removes nothing a frozen run produces. The
exemption is derived from the request path, not read off the row, so a
data-plane entry cannot claim it by relabelling itself `"kind":"harness"`.

> **That last sentence was true of the *exemption* and false of the *decision*
> until round 8.** `attributeGatewayRows` derived the class from the path;
> `claims.mjs` filtered the very same rows on `e.kind`. Deleting that one field
> from one row bought a certifying PASS over a recorded `GET /rest/v1/accounts`.
> See [round 8](#and-then-the-decision-read-the-label-the-derivation-had-already-corrected-round-8).

Like ADV-1's attribution, this is **unmeasured under `--mode mutant`** — no
mutant image exists at this sha. A mutant that talks to the sink at container
start will *refuse* rather than report a FINDING. That is the correct
direction, but the false-positive rate has not been observed.

### R5-C — both cross-checks hashed the label and not the evidence

`observers.mjs eventKey` (which decides whether the image's log and the
driver's transcription "agree") and `observation.mjs eventDigest_16` (which is
what the gateway attests) both keyed on `(seq, t, kind)`. The `detail` — the
host, the port, the path class, **the fields every claim is actually decided
from** — was in neither.

The auditor built the honest artefacts of a run in which the image *did* call
the broker: the event in the instrument log, in the driver's transcription, and
in the gateway's attestation recomputed with this harness's own
`driver/observation.mjs`. That refuses, correctly — `noBrokerCall=violated`,
`rc=1`. Then it rewrote **only the `detail`**, in the two instrument-side
copies, same `seq`, same `t`, same `kind`: `rc=0`, `PASS`. Two files edited;
the third observer could not see the difference because it never hashed that
field.

**Closed** by `eventIdentity`, a canonical (sorted-key) digest of the detail
folded into both the observer-side key and the attested digest, derived from
one function so the two cannot key on different things again.
`OBSERVATION_VERSION` is therefore **2**, and there is deliberately **no
compatibility shim**: an artefact directory produced before the bump does not
carry the evidence, and accepting it "because it is old" would make the check's
passing value identical to its did-not-run value. Such a directory refuses,
naming the version and saying to drive it again.

### …and the exclusion that closure left open was not `stack` (round 7: R7-2)

`eventIdentity` returns `[seq, t, kind, sha(canonicalJson(detail))]`. `stack` is
excluded from it deliberately, and the function says why: no claim reads it and
the driver is not guaranteed to transcribe it byte-for-byte, so including it
would buy nothing and risk a false disagreement. What nothing said, and nothing
enforced, is that the exclusion was really **"everything that is not one of four
fields"**.

**Measured** on the certifying corpus, with nothing else touched: appending

```
,"brokerCall":{"method":"POST","url":"https://paper-api.alpaca.markets/v2/orders", …}
```

to an **existing boot line** of `instr/0023-m-off__s-off__b-probe.jsonl` left
every published count identical — 13 raw lines in that file, `logEvents` 298,
`eventsAttributedToBoot` 298, `eventsUnattributed` 0 — and certified `rc=0`
with the PASS banner. It is invisible to the round-7 line accounting as well:
the line still parses, so the raw and parsed denominators agree and k14's
MEASURED comparison stays green over a directory recording a broker call.

**Closed** by the same argument `bootEventProblem` already makes for kinds — an
allow-list over an exhaustive partition rather than a deny-list.
`instrument.cjs`'s `emitWithStack` writes exactly `{seq, t, kind, detail,
stack}`, so `EVENT_TOP_LEVEL_KEYS` is exactly that set and a record carrying a
sixth key is refused, naming the file, the physical line and the key. Both
copies are checked: the image's own log **and** the driver's transcription
(`bootEvents`, `results[].events`), because a check applied to one of two copies
is a check the other copy walks past. The count is published as
`claimEvidence.eventsWithForeignKeys`. If a future `instrument.cjs` really gains
a field, it belongs in `EVENT_TOP_LEVEL_KEYS` **and** in `eventIdentity` in the
same change; digesting the whole record instead was rejected because it would
fold `stack` back in through the side door.

k14 covers it with `R7C` (the log copy), `R7Cb` (the transcription copy) and a
positive control planting a well-formed, allow-listed record that must still
refuse as UNATTRIBUTED — so the new refusal cannot pass by refusing everything.
Re-injecting `eventForeignKeys → []` into a scratch copy of the harness reds
`R7C` and `R7Cb` and nothing else (26 passed, 2 failed).

### What round 5 tried and could NOT break

Recorded because a list of successful attacks with no list of failed ones tells
a reader nothing about coverage.

| attempt | outcome |
|---|---|
| an event inside a window but attributed to the wrong cell | closed: a `cellTag` must start with its own cell id **and** match `<cell>#<digits>`, and the attribution windows are built from the cell's own results |
| **widening** a window by deleting the `#idle` gateway rows that bound it, then planting ADV-1's three events in the enlarged span | refused — the transcription/observer diff names all three |
| truncating the gateway log at the tail | refused — 18 `logged no window for tag` |
| an instrument log for a cell that was never driven | refused, naming the file and its line count |
| in-window `hostClass` laundering by an artefact editor | refused — the gateway's attestation carries `eventCount` and `eventDigest_16`, so the event cannot be added to either copy alone |
| an instrument log under a name outside `instr/<schema>-<cell>.jsonl` | **passes**, and is the already-documented limit (3) of the unclaimed-log scan: it is not scanned, and it feeds no claim |

### What round 5 found and did NOT close

`detail.hostClass` — the field `noBrokerCall` and `noUnexpectedNetworkCall` are
decided from — is computed **inside the image's own process**
(`instrument.cjs:116-123`). Nothing on the host side re-derives it from the
`detail.host` sitting beside it in the same record, so
`hostClass=loopback, host=paper-api.alpaca.markets` would be believed.

> **Round 8 closed the sibling of this and left the host half open.**
> `detail.pathClass` was self-computed in exactly the same way, and it *is*
> re-derived on the host side now, from the URL sitting beside it; a record
> that disagrees with itself is refused
> (`claimEvidence.imageEgressPathClassContradictions`). The host is still the
> image's own word. The paragraphs below are about the host and remain true.

R5-C closed the half of this that an artefact editor can reach: the
attestation now covers the detail, so relabelling a broker call after the run
contradicts a file the editor did not write. The half left open is the **image
lying in its own log while the driver and the gateway faithfully record the
lie**.

This is recorded as **a defect that was not closed, not as an inherent limit**,
because it is closable: pin the harness's two host constants in
`expected/request-manifest.json`, re-derive the class from `detail.host`, refuse
a record that disagrees with itself. It was not done because the check is
*weak* — an image willing to write the wrong class can equally write the wrong
host, or emit no event at all — and because it adds a new expectation surface
and another certifying run, which is a bad trade to make at the end of a round.
Whoever picks it up should know the value is catching an honest
`classifyHost` bug, not catching a determined image.

What does not depend on any of it: the canary is a database trigger, the
gateway's log is written by the gateway, and the container network is
`--internal`, so a broker call cannot leave the host whatever the instrument
says about it.

---

## And then the controls themselves were unread (round 7: R7-3, R7-4)

Audit finding **F** — *an absence is only evidence from a detector known to
work* — was closed for exactly **one** detector: the trusted runner's sensor
report. Four other controls were asserted inside `run.sh`'s own process and read
by nothing afterwards, and a fifth artefact was collected and never opened at
all.

**MEASURED against the code as shipped before this round, over a genuine 48-cell
certifying set:**

| what was done to the artefact directory | before |
|---|---|
| delete `instr/egress-control.jsonl` and `instr/egress-broker.txt` | `rc=0` **PASS** |
| delete those two **plus** `canary-arm-<gen>.txt`, `sql/arm-<gen>.{out,err}`, `sql/on-error-stop-<gen>.err`, `tombstone-<gen>.txt` | `rc=0` **PASS**, and a case-insensitive grep of the stripped transcript and of `verdict-scope.json` for all four names returned **0** |
| append two lines to `instr/0023-m-off__s-off__b-probe.applog` — `[broker] POST https://paper-api.alpaca.markets/v2/orders … -> 200 OK` and `[vault] rpc vault_create_secret(…) -> ok` | `rc=0` **PASS** |

§3c is the control that makes `noBrokerCall` **mean** anything: it is the proof
that the in-process classifier calls `paper-api.alpaca.markets` a broker and does
**not** call the recording gateway one. Its passing value — the
`noBrokerCall: 480 satisfied` row — is byte-identical to what the matrix prints
when the classifier was never shown to work at all.

### What each control now has to say for itself

`verdict.mjs` re-derives all five from their artefacts and publishes them in
`verdict-scope.json` as `controlEvidence`, beside `sensorVerdict`. Absent
evidence is a refusal, not a silence.

| control | re-derived requirement | red case, measured |
|---|---|---|
| **§3c** egress classifier | `instr/egress-control.jsonl` must parse; carry an `instrument.loaded` whose configured broker hosts and sink host **equal the ones pinned in `verdict.mjs`**; carry ≥1 event that both names a pinned broker host and is classified `broker`; ≥1 that both names the gateway and is classified `supabase-sink`; **none** that names the gateway and is classified `broker`; and `instr/egress-broker.txt` must be re-derivable from it line for line | deleted → refused; gateway relabelled `broker` → *"1 event(s) … name nt-canary-sink and are classified 'broker'"*; every `broker` relabelled `loopback` → *"holds no event that both names a pinned broker host and is classified 'broker'"*; one line dropped from `egress-broker.txt` → *"holds 3 line(s) but re-extracting … yields 4"* |
| **§8b/§8b2** arming + fidelity | `canary-arm-<gen>.txt` must say `CANARY_ARMED=yes` and be re-derivable from `sql/arm-<gen>.out`; `ARMING_OUTCOME` must equal `BASELINE_OUTCOME`; **and** the baseline must equal `sql/expected-baseline.<gen>.txt`, which `TRUSTED_DIGEST` covers | deleted → refused; `ARMING_OUTCOME` changed → *"the canary CHANGED what the wrappers do on 0023"*; **both** artefacts changed to agree with each other → still refused, against the checkout's pin |
| **§5b** `ON_ERROR_STOP` | `sql/on-error-stop-<gen>.err` must name the exact expected class, `division by zero` | deleted → refused; class replaced by `permission denied` → *"does not name the expected failure class"* |
| **§7c** tombstone classification | `tombstone-<gen>.txt` must classify **all three** instrumented wrappers, record `result=PASS`, and agree with `expected/tombstone-state.<gen>.txt` | deleted → refused; `INTENTIONALLY_TOMBSTONED` → `LIVE_EXPECTED` → refused naming both values |
| **image stdout** `instr/<gen>-<cell>.applog` | every driven cell must have one; an applog belonging to no cell result in this verdict is refused; **no line may name a pinned broker host or one of the three instrumented wrappers** | two planted lines → refused, naming file and line; a **one-line** plant of just `vault_create_secret` → refused |

### What this is worth, and what it is not

These controls still **run** in `run.sh`'s process, because that is where the
containers are. What changed is that their evidence must exist, be internally
consistent, and say what the control claims — which defeats deletion and partial
edits, and does **not** defeat an operator who rewrites the artefact and
everything it is cross-checked against together (see `artefact-forgery`).

**§5b is only half-closed and is disclosed as such.** `sql/on-error-stop-<gen>.err`
is psql's stderr: it settles that the applier failed *with the expected class*,
not that it **stopped**. The applier's **exit status** is not written into the
artefact, so "`ON_ERROR_STOP` was in effect" remains a `run.sh`-process-only
assertion. Recording the status, or capturing a stdout witness proving the third
statement never ran, would close it; it was not done.

**The applog scan is the weakest of the five** and exists because the
alternative was to keep collecting the file and never open it — the exact
"collected, shipped and ignored" shape that `observers.mjs` names as finding D.
It is a keyword scan over free text the image *chose* to print: a tripwire, not
a claim. An image that makes a broker call silently prints nothing, and **no
containment claim rests on it**. `filesScanned`, `linesScanned` and
`bytesScanned` are published as numbers because *zero hits* is also what a scan
that never ran produces. Measured on the certifying set: **48 files, 192 lines,
5424 bytes, 0 hits** — every applog the same 113-byte framework boot banner. A
future image whose banner legitimately named a broker host would refuse here and
have to be looked at.

---

## And then the decision read the label the derivation had already corrected (round 8)

Round 7 closed R7-1 … R7-5 and an independent auditor reproduced every one. It
then broke the harness three more ways, each with a firing positive control.
All three are the same shape as everything above: **a fact the harness had
already computed, and did not consult.**

### R8-1 — one field name, deleted from one line

`observers.mjs attributeGatewayRows` derives a gateway row's class **from its
path** and publishes the result. `claims.mjs` filtered the very same rows on
`e.kind` — the row's own account of itself.

> **Control:** `sink-0023.jsonl` line 217 rewritten *in place* (same 555
> non-empty lines) to record `GET /rest/v1/accounts?select=* -> 200` under the
> claimed request tag `m-off__s-off__b-probe#3`, carrying `"kind":"postgrest"`
> → `rc=1 FINDING`, `noPostgRESTCall` and `noDatabaseCall` violated.
>
> **Attack:** the identical row with the **`kind` field deleted** → `rc=0`,
> `PASS` banner, `hardFailures 0`, `noPostgRESTCall 480 satisfied / 0 violated`.
>
> And the verdict had already **published the truth in the same run**:
> `gatewayHarnessRows` 555 → 554 and `gatewayRowsInAClaimedRequest` 0 → 1 — a
> number that is **0 on every genuine frozen run**. It computed the truth and
> consulted the lie.

### R8-2 — "the data plane" was two path prefixes

`sink.mjs classify()`, `instrument.cjs classifyPath()` and `observers.mjs
classifyGatewayPath()` all returned `"other"` for `/storage/v1`, `/graphql/v1`,
`/realtime/v1` and `/functions/v1`. **No claim read `"other"` on either
observer**, and `noUnexpectedNetworkCall` permits anything addressed to the
gateway host, because the gateway host is in `ALLOWED_HOST_CLASSES`.

Measured by driving `buildClaims` directly, every sensor live:

| gateway row under a claimed request tag | before round 8 |
|---|---|
| `GET /rest/v1/accounts` *(control)* | `noPostgRESTCall`, `noDatabaseCall` **violated** |
| `GET /auth/v1/user` *(control)* | `proxyRefusedBeforeAuth`, `noAuthCall` **violated** |
| `GET /storage/v1/object/private/broker-keys.json` | **16 of 16 SATISFIED** |
| `POST /graphql/v1` | **16 of 16 SATISFIED** |
| `GET /realtime/v1/websocket` | **16 of 16 SATISFIED** |
| `POST /functions/v1/place-order` | **16 of 16 SATISFIED** |

This is **a coverage hole, not a forgery**: `"kind":"other"` is exactly what
both observers would honestly write for those paths, so an image really doing
it is recorded truthfully by everything and certifies. They are precisely the
surfaces the Stage 2 edge exists to deny.

### What closes R8-1 and R8-2 together

One classifier, in `driver/claims.mjs`, called by the attribution **and** by
every claim; `sink.mjs` and `instrument.cjs` run the same table so their records
are self-consistent, but **neither of their answers decides anything**. The
classification is total over the Supabase surface, and `GATEWAY_CLASS_READERS`
names the claim that reads each class — the buckets in `buildClaims` are built
by looking the derived class up in that table, so a class added to the
classifier and forgotten in the table makes `claims.mjs` **throw at import**
rather than becoming invisible.

| path | class | read by |
|---|---|---|
| `/auth/v1…` | `auth` | `proxyRefusedBeforeAuth`, `noAuthCall` |
| `/rest/v1/rpc/…` | `rpc` | `noPostgRESTCall`, `noDatabaseCall`, `noVaultCall` |
| `/rest/v1…` | `postgrest` | `noPostgRESTCall`, `noDatabaseCall` |
| `/graphql/v1…` | `graphql` | `noDatabaseCall` *(pg_graphql resolves in the database)* |
| `/pg`, `/pg/…` | `pg` | `noDatabaseCall` *(pg-meta is a database connection)* |
| `/storage/v1…` | `storage` | `noUnexpectedNetworkCall` |
| `/realtime/v1…` | `realtime` | `noUnexpectedNetworkCall` |
| `/functions/v1…` | `functions` | `noUnexpectedNetworkCall` |
| `"/"` | `kong` | `noUnexpectedNetworkCall` |
| `/__canary…` | `harness` | **no claim** — the driver's own control traffic, and the exemption is derived from the path |
| absent / `null` / `""` | `unclassified` | `noUnexpectedNetworkCall` — a record with no destination is not the root path; it does not say where it went |
| anything else | `unclassified` | `noUnexpectedNetworkCall` |

**An unclassified destination is a refusal, not a silence.** Unattributed is not
absent — the same rule ADV-1 established for the instrument log, applied to the
destination rather than to the timestamp. The per-surface counts are published
in `claimEvidence.gatewayRowsByClass` **including the zeroes**, so *"this run
found no `/storage/v1` row"* is distinguishable from *"this run has no notion of
`/storage/v1`"*, which is what the counter would have said before.

The image's own `detail.pathClass` is re-derived from the URL beside it and a
contradiction refuses (`claimEvidence.imageEgressPathClassContradictions`); the
per-request `sinkEntries` filter, which also read `e.kind !== "harness"`, is
derived now too.

### R8-3 — the canary's raw artefact was compared with nothing

`run.sh` runs

```bash
grep -E 'NT_CANARY_' "$OUT/sql/canary-dump-<gen>.out" > "$OUT/canary-<gen>.txt"
```

and `verdict.mjs loadCanary` reads **only** the grep.

> **Control:** an `NT_CANARY_ROW` naming `vault_create_secret` from cell
> `m-off__s-off__b-probe#3`, appended to `canary-0023.txt` → `rc=1 FINDING`,
> `noVaultCall=violated`.
>
> **Attack:** the identical line present **only** in
> `sql/canary-dump-0023.out` → `rc=0 PASS`, `noVaultCall 480 satisfied / 0
> violated`, while the directory still contains the row.

This is the comparison the harness already performs for `egress-broker.txt`
against `egress-control.jsonl`; the canary pair was left out of R7-4. The
extraction is re-run over the dump at verdict time and must agree **in both
directions and in order**, with the marker-line count published so an agreement
between two empty sets cannot pass for agreement
(`controlEvidence.perSchema.<gen>.canaryExtraction`). A disagreement **refuses**
— when two artefacts contradict each other neither can be believed from here —
while the honest case, the row in *both* files, is still a plain `rc=1 FINDING`.

### R8-5 — the preflight that exists so this is learned in the plan looped over one argument

`run-all.sh` refuses an artefact directory at observation version 1 *before*
anything expensive starts, "so the operator learns it in the plan rather than
forty minutes in". It looped over `--full-out` **only**. `--partial-out` feeds
exactly one case, K4, and K4 is the case that reads a partial directory's
attestations — so a v1 partial sailed through, twelve database-backed suites
ran, and K4 then reported 11 hard failures every one of which said *observation
version 1; this verdict derives version 2*. Both arguments are checked now, by
one loop, with a positive control that the loop actually opened a file.

### The suite that holds all of it

`tests/k16-surface-coverage.test.sh`, **25 cases**: a GREEN positive control
that the untouched 48-cell set still certifies, a MEASURED case that reads the
new counters as numbers, one case per surface (ten) asserting *which* claim goes
violated **and which three do not**, R8-1a/R8-1b (the
labelled and unlabelled rows must be judged identically), M1 (a self-contradicting
row is refused, naming the derived class), R8-3a…d, P1/P2 (the image's declared
`pathClass` vs its own URL, with the consistent record as the negative control),
SCOPE (the published scope names every class and its readers, checked against
`GATEWAY_PATH_CLASSES` itself), TABLE — the positive control on the coverage
assertion, since a throw-at-import check that passes is **silent**, and silence
is also what its deletion looks like — and TRIPLE, which holds the three copies
of the classifier to one decision list. Only `claims.mjs` decides anything, but a
producer that drifts does not merely mislabel: it makes every honest run refuse
as self-contradicting.

---

## And then the class the harness had reserved for itself (round 9)

Round 8 made the gateway's classification **total over the Supabase surface**
and gave every class a named reader. An independent auditor reproduced all of
it — R8-1, R8-2 (seven surfaces, each red under an ablated build and refused
under the shipped one), R8-3 in both directions, the mislabel refusal, the
`--partial-out` preflight — and then asked the one question the table invites:
*ten of the eleven classes are read by a claim; what about the eleventh?*

### R9-1 — `harness` is read by no claim, and the image can reach it too

`GATEWAY_CLASS_READERS.harness` is `[]`, deliberately: `/__canary` is the
driver's own control plane. The exemption is derived from the **path**, which
is what stops a `/rest/v1` row buying it with a word — but a path prefix is not
a caller, and the scope document called the class *"the driver's own `/__canary`
control traffic"*, which is a statement about **who** that nothing checked.

The recording gateway serves `/__canary/{cell,health,generation,observe}` to
anything that can open a socket to it, with **no credential of any kind**, and
`run.sh` puts the image under test on that network by construction
(`SUPABASE_SERVER_URL=http://nt-canary-sink:8000`).

> **Measured**, with a throwaway container on an `--internal` network against
> the real `sink.mjs` and a real Postgres:
>
> ```
> POST /__canary/cell       -> 200 {"cell":"IMAGE-CHOSE-THIS-TAG"}
> GET  /__canary/health     -> 200 {"ok":true,"cell":"IMAGE-CHOSE-THIS-TAG"}
> GET  /__canary/generation -> 200 {"observedBy":"sink","fingerprint":"…"}
> POST /__canary/observe    -> 200 {"recorded":true,"digest":"deadbeef"}
> GET  /rest/v1/accounts    -> 401 {"message":"no API key found in request"}
> ```
>
> The caller changed the tag the gateway attributes **every subsequent row and
> every canary hit** with; made the gateway run SQL twice on its behalf; and
> wrote a record into the log this harness treats as its *second observer*. The
> data plane demanded a token. The control plane demanded nothing.
>
> **Attack:** one of those real gateway rows spliced into the 48-cell
> certifying corpus inside a claimed request window → `rc=0`, `PASS` banner,
> `hardFailures 0`, `noUnexpectedNetworkCall 480 satisfied / 0 violated`,
> `noDatabaseCall 480 satisfied / 0 violated`.
>
> **Control:** the same client's `/rest/v1/accounts` row — a **401** that
> reached no data — spliced the same way → `rc=1 FINDING`. A refused data-plane
> attempt was a violation; an accepted control-plane call that ran SQL was not.

**The repair is the same move this programme has made five times: the last
unaccounted bucket must account for itself.** A `/__canary` row is no longer
exempt for being on that path; it must be traffic the driver's protocol
produces — the right path by the right method under the right tag class, under
a tag this run's own cell results account for, and once:

| tag class | permitted | |
|---|---|---|
| `(unset)` | `- /__canary/started`, `GET /__canary/health`, `GET /__canary/generation` | before the first cell tag; `started` and `generation` capped at one |
| `<cell>#witness` | `POST /__canary/cell`, `GET /__canary/generation` | |
| `<cell>#idle` | `POST /__canary/cell` | |
| `<cell>#<n>` | `POST /__canary/cell`, `POST /__canary/observe` | the tag announcement and the request attestation |
| anything else | nothing | a tag this protocol does not produce |

Measured: **555 of 555** rows per generation accounted on the 48-cell corpus,
**26 of 26** on the 1-cell one, `rc=0 PASS` unchanged; and twelve planted
shapes each `rc=3`, naming the row and the reason.

**What is not closed, precisely.** Before the driver announces the first cell
tag of a generation the gateway's tag is `(unset)`, and `run.sh`'s own
readiness probe is `GET /__canary/health` in that window, retried until the
gateway reaches the database. An image calling `/__canary/health` while the
**first** cell of a generation boots is indistinguishable from that probe, and
still certifies — K16 case **H6** asserts exactly that, so the residual is a
measurement and not a hedge. `/__canary/started` and `/__canary/generation` are
capped at one row there, so the boot row and the schema-fingerprint read are
refused. Closing the rest needs the gateway to demand a per-run control token
the image does not hold, which changes the recorded shape of every row and
therefore needs a fresh matrix.

### R9-2 — the image/source/commit binding was asserted and never re-derived

`run.sh` computes three digests before it drives anything — the content digest
of `--source`, the digest stamped on the image at build time, and the digest of
the tree `git` reports at `--target-sha` — requires all three equal and the
image's revision label to be `--target-sha`, then writes all five values into
`provenance.json`. **Nothing read them again.** A literal scan of `driver/` for
`sourceDigest`, `commitTreeDigest`, `imageSourceDigest`, `imageRevision` and
`targetSha` returned **zero** hits; `provenance.json` returned twelve.

> **Attack:** four separate one-field edits of `provenance.json` alone —
> `sourceDigest != commitTreeDigest`, `imageSourceDigest != sourceDigest`,
> `imageRevision != targetSha`, and all three at once → **`rc=0 PASS` every
> time**, `hardFailures 0`, with the scope statement *"A PASS is a statement
> about one image, built from one source tree, bound to one commit"* printed
> underneath.

The binding is now re-derived from `provenance.json`, published as
`controlEvidence.imageSourceBinding`, and a record that contradicts itself —
**or omits a field** — is a hard failure. What that is worth: `provenance.json`
is written by the driver, so this is tamper-evidence of the same kind as the
`pathClass` and gateway-`kind` cross-checks, not an independent attestation. An
operator who edits all five fields consistently is inside the artefact-forgery
limit, and it says so.

`tests/k16-surface-coverage.test.sh` carries all of it: **H1–H5** (five refused
shapes, each asserting the reason string), **H4b**, **H6** (the disclosed
residual, as a negative control), **HCOUNT** (the accounted count, the zero and
the eight protocol shapes read as numbers), **B7a–B7d** (four refused
provenance edits, each naming `control B7`) and **B7e** (the untouched record
must read back `satisfied`, because "no reason printed" is also what a control
that never ran produces). 37 cases, 37 passed.

### Round 9, verified independently of `k16` (2026-08-19)

`k16` is the harness's own suite for R9-1 and R9-2, so a green `k16` is the
harness agreeing with itself. Both repairs were therefore re-measured a second
way: by planting rows and edits directly into a **copy of a real certifying
48-cell corpus** (`--full-out` of run nonce `e2ac6c8b…`, `imageRevision
9eb893a08`) and running `driver/verdict.mjs` over the copy by hand. The
unmodified copy is the positive control and reads **`rc=0 PASS`**, so every red
below is a change of verdict and not a corpus that never certified.

| planted | rc | what the verdict said |
|---|---|---|
| second `POST /__canary/cell` under a claimed request tag | **3** | *"1 of 556 `/__canary` entries … are not traffic the driver's protocol produces"* |
| `GET /__canary/health` under a claimed request tag | **3** | same refusal |
| `GET /__canary/generation` under an `#idle` tag | **3** | same refusal |
| `POST /__canary/observe` under a `#witness` tag | **3** | same refusal |
| `GET /__canary/health` under `(unset)` | **0** | **PASS — the disclosed residual, reproduced.** 556 rows, all eight protocol shapes accounted, `gatewayHarnessUnaccounted 0` |
| `GET /rest/v1/accounts` inside a claimed request window | **1** | FINDING: `noDatabaseCall` and `noPostgRESTCall` violated, `gatewayRowsInAClaimedRequest 0→1` |
| the same row with the `kind` field **deleted** | **1** | FINDING, byte-identical outcome to the row above — deleting the label buys nothing |
| the same row labelled `"kind":"harness"` | **3** | refused as *"declare a kind that their own path contradicts"* |
| `GET /storage/v1/object/list` inside a claimed window | **1** | FINDING: `noUnexpectedNetworkCall` violated — the round-8 whole-surface classification really does give `/storage/v1` a reader |
| `provenance.json`: `sourceDigest ≠ commitTreeDigest` | **3** | `control B7 (image/source/commit binding)` |
| `provenance.json`: `imageSourceDigest ≠ sourceDigest` | **3** | `control B7` |
| `provenance.json`: `imageRevision ≠ targetSha` | **3** | `control B7` |
| `provenance.json`: `imageSourceDigest` **deleted** | **3** | `control B7` |
| `provenance.json`: **all five fields rewritten consistently** | **0** | **PASS — the disclosed forgery limit, reproduced.** |

Two of the fourteen are greens, and both are greens this document already
predicted in writing. That is the point of running them: a disclosure nobody
has executed is a claim, and these two are now measurements. The rest change
the verdict, each with a reason string naming the specific offence rather than
a generic refusal.

One thing the table does **not** establish: the corpus it was measured on was
produced at `9eb893a08`, not at the current head. It is evidence about
`verdict.mjs` as it stands, not about any image built from the current tree.

---

## Running it

```bash
cd .github/containment/runtime-canary

# The two checkouts. The bootstrap and seed are REUSED from the bridge
# checkout; the digests they must match live in this one. There is no fallback,
# and no way to pass a path for either. TARGET must be CLEAN and at TARGET_SHA:
# a disposable clone is the intended way to guarantee that.
TRUSTED=/path/to/this/checkout
TARGET=/tmp/scratch/bridge-clean       # git clone --shared <bridge>; git checkout <sha>
TARGET_SHA="$(git -C "$TARGET" rev-parse HEAD)"

# 0. build the frozen image and the mutant from scratch copies of the bridge
#    source (never from the worktree itself). The --sha becomes the image's
#    org.opencontainers.image.revision label, and run.sh REQUIRES it to match.
export CANARY_SUPABASE_URL=http://nt-canary-sink:8000
eval "$(node driver/keys.mjs --print-shell | sed 's/^/export /')"
cp -a "$TARGET/dashboard" /tmp/scratch/src-frozen && rm -rf /tmp/scratch/src-frozen/.git
./build-image.sh --source /tmp/scratch/src-frozen --tag nt-canary/dashboard:frozen \
                 --sha "$TARGET_SHA"
# --ref must be a PRE-FREEZE commit. `--ref HEAD` restores the file that is
# already there, and make-mutant.sh correctly refuses: "the restored file is
# identical to the frozen one; there is no mutant". Find one with
#   git -C "$TARGET" log --oneline -- 'dashboard/app/api/accounts/[id]/route.ts'
# and take the newest whose version still calls deleteAccount and does not
# return frozenResponse.
./mutant/make-mutant.sh --from /tmp/scratch/src-frozen --to /tmp/scratch/src-mutant \
                        --restore-from-git "$TARGET" --ref <pre-freeze-commit>
./build-image.sh --source /tmp/scratch/src-mutant --tag nt-canary/dashboard:mutant \
                 --sha "${TARGET_SHA}+mutant"

# A — the frozen image, BOTH generations, all 24 combinations = 48 cells.
#     Anything less is PARTIAL, exit 4. Budget ~25 minutes (~22s per cell plus
#     a postgres boot and a migration replay per generation).
./run.sh --image nt-canary/dashboard:frozen --source /tmp/scratch/src-frozen --schema both \
         --trusted-root "$TRUSTED" --trusted-sha "$(git -C "$TRUSTED" rev-parse HEAD)" \
         --target-root  "$TARGET"  --target-sha  "$TARGET_SHA"

# B — the sensor is live
./run.sh --image nt-canary/dashboard:mutant --source /tmp/scratch/src-mutant \
         --schema both --mode mutant --trusted-root "$TRUSTED" --target-root "$TARGET" ...

# C — the sensor cannot be removed quietly (each must FAIL, exit 3)
./run.sh ... --mode mutant --schema 0023 --break-sensor drop
./run.sh ... --break-sensor mute
./run.sh ... --break-sensor verdict

# and the ten finer sabotages, which need no dashboard image at all
./tests/build-schema-base.sh --generation 0023 --target-root "$TARGET"
./tests/k1-sensor-negative-controls.sh

# the deliberately partial artefact directory K4 needs
./run.sh --image nt-canary/dashboard:frozen --source /tmp/scratch/src-frozen \
         --target-root "$TARGET" --target-sha "$TARGET_SHA" \
         --schema 0023 --cells 1 --out /tmp/scratch/out-partial     # PARTIAL, exit 4

# The whole closure suite. --full-out must be a `--schema both` artefact
# directory: K9's cross-generation attacks cannot run on half of one, and a
# missing artefact directory is now a FAILURE rather than a skip.
./tests/run-all.sh --target-root "$TARGET" --full-out <the 48-cell out dir> \
                   --partial-out <a deliberately partial out dir>
```

### `run-all.sh` after round 8, measured 2026-08-18

* `--full-out` — the round-5 48-cell certifying set (run nonce `e2ac6c8b…`,
  exit 0, `PASS all 24 environment combinations x 2 migration generations`),
  copied before the suite touched it and bit-identical afterwards.
* `--partial-out` — **freshly driven for this round** by the repaired runner:
  `run.sh --schema 0023 --cells 1`, exit 4 `PARTIAL`, `hardFailures 0`, all 10
  request attestations at `OBSERVATION_VERSION 2`. The previous partial fixtures
  on this machine were **version 1**, which is what made K4 the single red of
  the round-7 suite — 11 hard failures, every one of them *"observation version
  1; this verdict derives version 2"*. That is a fixture age, not a regression,
  and R8-5 also fixed the preflight that should have said so in the plan.

```
build 0023 schema base   PASS      K2  claim completeness        PASS
build 0008 schema base   PASS      K2  sensor removal            PASS
K11 runner omission      PASS      K4  partial verdict           PASS  (4/4)
K12 verifier digest scope PASS     K9  cell+generation identity  PASS  (10/10)
K5  make-mutant delete guard PASS  K13 transcript integrity      PASS  (5/5)
K3  reuse guard          PASS      K14 observer-derived claims   PASS  (28/28)
K8  baseline expectation PASS      K15 run controls              PASS  (19/19)
K6  tombstone binding    PASS      K16 data-plane surface        PASS  (25/25)
K1  sensor negative controls PASS
K10 tamper role scope    PASS
(cases accounted for)    18 of 18 declared         rc=0
K7  Server Actions       NOT COVERED HERE
```

What the certifying `--full-out` verdict records for the round-8 counters, both
generations identical:

| | `0008` | `0023` |
|---|---|---|
| gateway rows by surface | `harness` 555, every other class **0** | `harness` 555, every other class **0** |
| gateway rows carrying no `kind` field | 0 | 0 |
| image egress records whose `pathClass` contradicts their own URL | 0 | 0 |
| `canaryExtraction`: NT_CANARY_ lines in the dump / in the extraction / agrees | 5 / 5 / **true** | 5 / 5 / **true** |

### `run-all.sh` after round 5, measured 2026-08-17 23:58

Both artefact directories are **freshly driven at the pinned digest**, not
forward-ported: the round-5 attestation bump (`OBSERVATION_VERSION = 2`)
deliberately invalidates every earlier corpus, and `run-all.sh` and `k14` both
refuse one in their preflight, naming the version, rather than letting 480
digest mismatches stand in for the diagnosis.

* `--full-out` — `run.sh --schema both`, 48 cells, run nonce `e2ac6c8b…`, exit
  0, `PASS all 24 environment combinations x 2 migration generations`.
* `--partial-out` — `run.sh --schema 0023 --cells 1`, exit 4 `PARTIAL`.
* `provenance.trustedDigest` of both equals the pin,
  `a941f3731a7083b3f5cdc0fe8e5c014b3414e1401e2cc350f7bf151ebf66d7e0`.

```
build 0023 schema base   PASS      K1  sensor negative controls  PASS
build 0008 schema base   PASS      K10 tamper role scope         PASS
K11 runner omission      PASS      K2  claim completeness        PASS
K12 verifier digest scope PASS     K2  sensor removal            PASS
K5  make-mutant delete guard PASS  K4  partial verdict           PASS
K3  reuse guard          PASS      K9  cell+generation identity  PASS
K8  baseline expectation PASS      K13 transcript integrity      PASS
K6  tombstone binding    PASS      K14 observer-derived claims   PASS  (23/23 cases)
(cases accounted for)    16 of 16 declared
K7  Server Actions       NOT COVERED HERE
```

What the certifying run's own `verdict-scope.json` records, each figure
reconciled against a count taken from the artefact directory:

| | `0008` | `0023` |
|---|---|---|
| gateway-defined request windows | 240 | 240 |
| request observations matched against the gateway's copy | 240 | 240 |
| instrument-log lines / attributed to boot / unattributed | 302 / 302 / **0** | 298 / 298 / **0** |
| boot-snapshot kinds | `coverage` 24, `loaded` 24, `ready` 24, `env.read` 230 | same, `env.read` 226 |
| boot events refused | 0 | 0 |
| gateway-log lines / harness control / unaccounted / mislabelled | 555 / 555 / **0** / **0** | 555 / 555 / **0** / **0** |
| attestation versions other than the current one | none | none |
| sensor report sealed / manifest MAC / ledger MACs | yes / yes / 12 of 12 | yes / yes / 12 of 12 |

The partial run's sensor report was sealed by the runner itself and verifies
9 of 9 ledger lines.

### `run-all.sh` after the ADV round, measured 2026-08-17 20:32

Re-run in full after ADV-1/ADV-3/ADV-4, over a `--schema both` 48-cell corpus
(run nonce `7da1ca7f…`, forward-ported by `tests/seal-legacy-report.mjs` under
its own run key — the note is printed) and a **freshly produced** 1-of-24
partial run of `nt-canary/dashboard:r3-frozen` against `bridge-9eb`
(`9eb893a08156…`). The partial run matters beyond K4: it is the first artefact
directory whose sensor report was **sealed by the modified runner itself**
rather than forward-ported, and `verdict-scope.json` records
`sealed: true, manifestHmacVerified: true, ledgerLines: 9, ledgerLinesVerified: 9`.

```
build 0023 schema base   PASS      K1  sensor negative controls  PASS
build 0008 schema base   PASS      K10 tamper role scope         PASS
K11 runner omission      PASS      K2  claim completeness        PASS
K12 verifier digest scope PASS     K2  sensor removal            PASS
K5  make-mutant delete guard PASS  K4  partial verdict           PASS
K3  reuse guard          PASS      K9  cell+generation identity  PASS
K8  baseline expectation PASS      K13 transcript integrity      PASS
K6  tombstone binding    PASS      K14 observer-derived claims   PASS  (18/18 cases)
(cases accounted for)    16 of 16 declared
K7  Server Actions       NOT COVERED HERE
```

Trusted digest at that run: `9d6635173f8a16161751b139d2565d17c9b973c86d7353ed8e79fbb00553244c` — SUPERSEDED by round 5, whose runs are recorded above at `a941f373…`. The suite is re-run whenever that number moves.

### The first green `run-all.sh`, measured 2026-08-17 17:33

Before this date there was no record of `tests/run-all.sh` completing. The only
recorded invocation, 2026-08-16 13:15, predated K11/K12/K13, had no "cases
accounted for" line and ended FAIL. It is green now, over the artefact
directories of a fresh 48-combination `--schema both` run of
`nt-canary/dashboard:frozen` (`sha256:e239df6d…`, `revision=ad2296431…`) and a
1-of-48 partial run:

```
build 0023 schema base   PASS      K1  sensor negative controls  PASS
build 0008 schema base   PASS      K10 tamper role scope         PASS
K11 runner omission      PASS      K2  claim completeness        PASS  (19/19 cases)
K12 verifier digest scope PASS     K2  sensor removal            PASS
K5  make-mutant delete guard PASS  K4  partial verdict           PASS
K3  reuse guard          PASS      K9  cell+generation identity  PASS
K8  baseline expectation PASS      K13 transcript integrity      PASS
K6  tombstone binding    PASS      K14 observer-derived claims   PASS
(cases accounted for)    16 of 16 declared
K7  Server Actions       NOT COVERED HERE
```

The `run.sh` run underneath it is itself a **PASS**: "all 24 environment
combinations x 2 migration generations (48 combinations) x 10 requests x 16
claims were observed complete, refused with 503, and the canary never fired",
sensor `TRUSTWORTHY` on both generations, image bound to `ad2296431…` by label
and to its source tree by content digest.

### CLOSED: `K2 claim completeness` case P was a STALE FIXTURE, not a bridge defect

*Measured red 2026-08-16 13:15 and 2026-08-17; diagnosed and closed 2026-08-17.*

`./tests/k2-claim-completeness.sh` was **16 passed, 1 failed, exit 1**. All ten
baseline refusals violated exactly `refusalIdentity`, answering

```
status 503
headers  x-artifact-role: null   x-writes-enabled: null   retry-after: 600
body     {"code":"MAINTENANCE_MODE","error":"The dashboard is in maintenance
          mode: writes are frozen while a schema migration or rollback is in
          progress."}
```

with the instrument reading back `DASHBOARD_MAINTENANCE_MODE=on
DASHBOARD_SIDECAR_ONLY=on`. The earlier note offered two resolutions and picked
neither: *(a)* the baseline expectation never moved when the `refusalIdentity`
claim landed, or *(b)* a real bridge defect, because a configuration flag
appeared to change the observable identity of the refusal while `lib/frozen.ts`
claims writes "cannot be enabled by configuration".

**It is (a), and the evidence is in the image, not in the argument.** The
question "which image did that cell run?" was answered from the image's own
content rather than from the tag it was invoked with:

| | `nt-canary/dashboard:frozen` as it stood (`sha256:58b1e09d…`, built 2026-08-15 11:20, label `revision=canary-frozen`, no source-digest) | a build from a post-`86654b552` tree (`nt-canary/dashboard:r3-frozen`, `revision=9eb893a0…`) |
|---|---|---|
| chunks naming `DASHBOARD_MAINTENANCE_MODE` | **1** | 0 |
| chunks naming `DASHBOARD_SIDECAR_ONLY` | **1** | 0 |
| chunks naming `DASHBOARD_FREEZE_BYPASS_USERS` | **1** | 0 |
| chunks naming `MAINTENANCE_MODE` (the body) | **1** | 0 |
| chunks naming `FROZEN_CONTAINMENT_BRIDGE` | 5 | 6 |

The same scanner produced both columns, and it still finds
`FROZEN_CONTAINMENT_BRIDGE` in the right-hand one — so the zeroes are readings
from a finder known to work, not an empty scan. The proxy chunk of the old
image contains, verbatim:

```js
if (o && ai.has(e.method)
    && void 0 !== (t = process.env.DASHBOARD_MAINTENANCE_MODE?.trim().toLowerCase()) && aa.has(t)
    && !(void 0 !== (r = process.env.DASHBOARD_SIDECAR_ONLY?.trim().toLowerCase()) && aa.has(r)
         && process.env.DASHBOARD_FREEZE_BYPASS_USERS?.trim()))
  return rv.NextResponse.json({code:"MAINTENANCE_MODE", error:"The dashboard is in maintenance mode: …"},
                              {status:503, headers:{"Cache-Control":"no-store","Retry-After":"600"}});
```

which is `maintenanceFrozen() && !bypassPossible()` — the branch bridge commit
`86654b552` ("freeze the edge too", 2026-08-15 14:45) **deleted**. The image
predates the commit by three and a half hours. The suite had been driving a
pre-freeze artifact and reporting the result as a property of the bridge.

Rebuilt from the bridge checkout at `ad2296431`, the same case is
`P baseline: 10 requests x 16 claims = 160 records, 0 violated, 0
indeterminate`. Resolution (b) is refuted, and so is the *implementation* the
old note proposed for (a): pinning the expected refusal identity per cell from
the observed freeze flags would have written the pre-freeze conditional
behaviour into the expectation and destroyed the claim's ability to notice a
proxy that had regained a flag-dependent refusal.

**What actually needed fixing was the harness's inability to say which image it
was driving.** `run.sh` binds its image to a commit by label and to a source
tree by content digest (finding B7); `k2-claim-completeness.sh` took whatever
`NT_CANARY_IMAGE` named and asked it nothing. Two guards now:

* **F1** — the image must carry a 40-hex `org.opencontainers.image.revision`
  and an `org.nt.canary.source-digest`; otherwise the suite exits 2 as a
  *harness failure*, naming the stale-fixture failure mode, rather than
  reporting a finding. F1 is the control on the checker itself: it is run
  against the stale image's **real** label pair (`canary-frozen`, no
  source-digest), which it must reject naming both reasons, and against the
  image under test, which it must accept.
* **F0** — executed, not asserted. The image is booted with
  `DASHBOARD_MAINTENANCE_MODE`, `DASHBOARD_SIDECAR_ONLY` and
  `DASHBOARD_FREEZE_BYPASS_USERS` **all absent** and the refusal must be
  unchanged: 10/10 requests carrying the frozen identity. That is
  `lib/frozen.ts`'s "cannot be enabled by configuration", measured. Its
  negative control is mutant 11, which answers 503 from the HTTP server before
  any freeze logic and violates the identity 10/10 in the same configuration.

Measured both ways, today:

| | pre-freeze image (`58b1e09d`) | rebuilt frozen bridge (`e239df6d`, `revision=ad2296431…`) |
|---|---|---|
| K2 case **P** | `refusalIdentity` violated **10/10**, exit 1 | 0 violated, 0 indeterminate, exit 0 |
| K2 case **F0** | "the freeze is CONFIGURATION-DEPENDENT: satisfied **5/10**, violated 5/10" | satisfied **10/10** |
| K2 preflight | exit 2, naming both missing labels | accepted |

F0's 5/10 on the old image is the same failure `86654b552` describes from the
other side: with the flags absent the proxy fell through to authentication on
the unauthenticated half of the cell.

`--out` must be **empty or absent**. Two runs into one directory leave a set no
verdict can distinguish from a single complete one.

After any deliberate edit to a `.sh`/`.mjs`/`.cjs`/`.sql`/`.json` file in this
directory, re-record the verifier pin as a separate, visible act:

```bash
./run.sh --print-trusted-digest > expected/trusted-digest.txt
```

`--image` and `--schema` are parameters on purpose: the harness knows nothing
about which image it is testing, and the same invocation serves the frozen
artifact, the candidate, and the mutant.

### Exit codes

| code | meaning |
|---|---|
| 0 | the expectation for this `--mode` / `--break-sensor` held, on the whole 48-combination matrix |
| 1 | a containment **finding**: the image violated a claim |
| 2 | the harness itself failed |
| 3 | a **control** misbehaved — nothing this run says can be trusted |
| 4 | `PARTIAL` (fewer than 24 cells, or fewer than both generations) or `NOT CERTIFYING` (dirty target worktree, substituted `--pg-image`, or a non-certifying fixture manifest). Real results, but not a certification. |

Whatever the code, the run writes `verdict-scope.json` into the artefact
directory and prints its contents under **WHAT THIS VERDICT DOES NOT SAY**. Read
that before quoting the exit status.

---

## The surface this harness actually drives — and the one it does not

`driver/enumerate-routes.mjs` walks `app/api` for Next `route.{ts,tsx,js,mjs}`
files and takes every exported `POST` / `PUT` / `PATCH` / `DELETE`. On the
bridge that is **five mutating handlers**, driven unauthenticated and
authenticated:

```
POST   /api/accounts            PATCH  /api/accounts/:id
POST   /api/accounts/:id/verify DELETE /api/accounts/:id
PATCH  /api/profile
```

5 × 2 auth × 24 freeze-flag combinations × 2 generations = 480 driven requests.

**Server Actions are not in that set.** The bridge has three files of them
(`app/actions.ts`, `app/auth/actions.ts`, `lib/account-actions.ts`); the
enumerator does not find them, `run.sh` does not POST the Next Server-Action
protocol at them, and nothing in this directory executes them. They are covered
**statically**, in the bridge checkout, by
`dashboard/test/containment/server-actions.test.ts`. That is a weaker kind of
evidence than the executed proof here, and the eight audited defects are
therefore closed by **seven** test files in `tests/` (K1–K6, K8) plus K9 and K10
from later audits — not eight. `tests/run-all.sh` says so at the top, and it now
**fails** rather than skips when the artefact directories K2/K4/K9 need are not
supplied: a skipped attack is not a passed attack, and a default suite run used
to report clean without ever exercising the A1/A2/B1 regression cases.

The eight-row table below is not a claim-per-row table either: it groups the
**sixteen** claims in `driver/claims.mjs` by observer. The claim list is the
authoritative one.

### What a second audit of the suites themselves found (K13, and three repairs)

The suites are evidence too, and four of them were not doing what they said:

* **The verdict's transcript was lossy.** Node writes to a pipe
  asynchronously and `process.exit()` discards whatever is still queued;
  `verdict.mjs` exits that way on every path, and every suite reads it through
  `$( … 2>&1 )`. Eight identical captures of one refusal came back as 330509,
  270514, 312498, 92082, 165554, 330509, 330509 and 161618 bytes — the short
  ones missing 177 of 280 matrix rows and the whole *WHAT THIS VERDICT DOES NOT
  SAY* block. That matters because several suites assert a string is **absent**
  from that transcript, and an absence assertion over output that can lose 81%
  of itself is satisfied by the loss. `console.log`/`console.error` now write
  with `fs.writeSync`, and `tests/k13-transcript-integrity.test.sh` executes
  the red-before deterministically (slow reader + the
  `NT_VERDICT_ASYNC_STDIO=1` seam) before asserting the repair.
* **`k2-sensor-removal` was asserting something that could not fail.** It
  checked that each removed sensor's dependent claims were "named" by grepping
  the whole transcript — and `verdict.mjs` prints every claim name in its
  header line on every run, so all sixteen always matched. It also walked
  `ALL_SENSORS` read out of `claims.mjs` with no emptiness check: renaming that
  export left the suite reporting "2 passed, 0 failed", exit 0, having tested
  no sensors at all. Both are closed, and the claim tally is now read from
  `verdict-scope.json` as data with set equality in both directions.
* **`run-all.sh` never looked at the disk.** It checked that every declared
  case has a script; nothing checked that every script is a declared case, so a
  new suite in `tests/` would simply never run. It now enumerates the directory
  and refuses by name, and `k11` case N6 plants a suite to prove it.
* **…and then the disk scan could only see one shape.** The enumeration was
  `find "$HERE" -maxdepth 1 -type f -name '*.sh'`, so N6's planted `.sh` was
  the only kind of suite it could ever have found. Measured: planting
  `tests/k98-a-suite-nobody-runs.py` and
  `tests/extra/k97-a-suite-nobody-runs.test.sh` in a copy left `--print-plan`
  printing fifteen `RUN` lines and exiting 0 — invisible to `CASE_LABELS` and
  invisible to the scan, which is the exact state the scan exists to prevent.
  The enumeration is now recursive and extension-agnostic (executable, or any
  of `.sh .bash .py .mjs .cjs .js .ts .pl .rb`), compares paths relative to
  `tests/`, and refuses if it finds no files at all. `k11` N7 and N8 plant the
  two shapes; C3 removes all three plants and requires the same copy to plan
  cleanly.
* **Suites could omit their own cases in silence.** `k11` — the suite whose
  subject is silent omission — printed `K11 GREEN` with one of its cases
  deleted. `k4`'s schema-axis case could vanish from a summary that still read
  "3 passed, 0 failed". **Every suite in `tests/` now** reconciles a closed
  `CASES_INTENDED` set and fails if it exits before its own summary; the last
  eight were done on 2026-08-17 with a measured red-before on `k10`. See the
  residual-limits section for what a roster still cannot check about itself.

## What is asserted, and who observes it

For every request in the matrix:

| claim | observer | why that observer |
|---|---|---|
| exact `503` | the driver's own response | — |
| the refusal is *the freeze refusal* — `X-Artifact-Role: frozen-containment-bridge`, `X-Writes-Enabled: false`, body `reason: FROZEN_CONTAINMENT_BRIDGE` | the driver's own response, against a committed identity in the manifest | the proxy has its own unrelated 503 branch, and so does every upstream; "it refused" is not "it refused for the reason containment depends on" |
| zero Auth calls | the recording gateway's request log | a call that left the image had to arrive there; unlike an in-process patch it does not depend on Next's edge sandbox sharing the main realm's globals |
| zero request-body parsing | patched `Request.prototype.{json,text,arrayBuffer,formData,blob,bytes}` and the `body` getter | a route handler's `req.json()` resolves through this prototype |
| zero Supabase client construction | V8 **precise coverage** against string-literal markers, plus a `process.env` read sensor | `next build` bundles `@supabase/*` into the server chunks, so a require-hook cannot fire — but "did the byte range containing `supabaseUrl is required` execute?" survives bundling *and* minification |
| zero PostgREST/RPC calls | the gateway's request log | ditto |
| zero DB calls | the gateway's log, plus any socket to port 5432 | the gateway is the only route to the clone |
| zero canary hits | the database's rollback-proof counter, its server log, and the committed detail rows | see below |
| no broker call | DNS / connect / fetch events classified against the broker hosts, plus the coverage marker inside `validateAlpacaKeys` | the base URLs are hard-coded in the image, so this cannot be redirected by configuration — only observed |

**Which FILE each of those readings is taken from matters as much as which
sensor produced it, and for most of a year it was the wrong one.** The
in-process sensors write `$OUT/instr/<schema>-<cell>.jsonl` directly, from
inside the image under test; the driver *also* reads them over the instrument's
control surface and copies them into the cell result. `verdict.mjs` decided
every in-process claim from the copy, and read the original only for a liveness
line — so two lines appended to the original produced a `PASS` that said those
claims were satisfied. It now decides them from the original, over request
windows the recording gateway defined, and treats any difference between the two
copies as a hard failure. See *The observers were collected, shipped, and
ignored* above.

Two readings in the table remain **driver-only**, because they exist nowhere
else: the V8 coverage markers (`markDelta`, which decide the marker half of
`noSupabaseClient` and `noBrokerCall`) and `routeExec` (`handlerNotReached`) are
served over the control surface and never written to a bind mount. Every other
in-process reading has an observer-written original.

Plus, per environment combination, a **before/after content commitment** over
`accounts`, `profiles`, `audit_log`, the financial mirrors (`equity_snapshots`,
`cash_flows`), `auth.users`, `vault.secrets`, the credential-assignment table, a
generic row-count sweep of every table in `public`, and every sequence's value —
because a row that was inserted and rolled back leaves no row and still burns a
sequence value.

---

## The canary, and the two things that nearly made it useless

`sql/20_canary_install.sql` re-creates each of the three wrapper signatures —
argument list and return type taken verbatim from `pg_get_function_arguments` /
`pg_get_function_result`, so they are the schema's own — around a body that
records the call and then does what the schema's version would have done. The
original body is cloned first into `nt_canary.real_<name>`, keeping its
volatility, `SECURITY DEFINER` flag and `search_path`, and the canary delegates
to it.

**1. The ACL would have hidden every call it exists to catch.** On `0001-0023`,
`0022` revokes `EXECUTE` from `service_role` as well, so a service-role call is
refused at `42501` *before any body runs*. A sensor inside the body would never
see it. The install therefore snapshots the real ACL, grants `EXECUTE` to
everyone so the body is always entered, and re-implements the refusal as the
first thing after the sensor — same SQLSTATE, one statement later. The call is
now observable **and** still unprivileged.

**2. A log table alone is not a sensor.** Every call on the latest schema ends in
`raise`, and a row inserted earlier in the same subtransaction is rolled back
with it. So the primary counter is a **sequence**: `nextval` is exempt from
rollback, which makes it the one write that survives the exception the call is
about to throw. The server log (`raise log`) is a second, independent,
non-transactional channel; the detail table is the third and carries the cell
attribution for calls that commit. `verdict.mjs` requires the counter delta and
the server-log line count to agree, and treats a disagreement as a control
failure rather than a result.

`sql/25_canary_arm.sql` then fires all three on that very database and requires
the counters to move by **exactly one** each — not "at least one", because the
matrix's verdict is an exact number and a double-counting sensor is as useless
for an absence proof as a blind one. Only after that does any zero get reported.

**And the canary must not have changed what the wrappers do.** That is the
load-bearing claim of the whole design, so `sql/18_prewrapper_baseline.sql`
calls all three on the untouched schema first and records what each one did —
returned, or raised with which SQLSTATE. The arming probe records the same
three outcomes after installation and `run.sh` requires them to match. The
control earns its place: on its first run it failed, and the cause was a defect
in the probe rather than in the canary (`text[] || 'literal'` resolves to
`anyarray || anyarray`, tries to read the literal as an array, and raises
22P02 *inside the exception block that was reporting on the wrapper* — so a
wrapper that had succeeded was recorded as raising). A control that never fails
has not been shown to work either.

---

## Reuse, and drift

The bootstrap that creates the `storage` tables storage-api owns is **the same
file** as `dashboard/test/schema-compat/sql/00_env_bootstrap.sql`, and the
fixture seed is the same `10_seed.sql`. They are read from the **target**
checkout and compared against a digest committed in the **trusted** one, which
must be a physically distinct root at the exact commit the caller asserted.

There is no vendored fallback and no `--bootstrap` / `--seed` argument. An
earlier resolver fell back to a vendored copy when the canonical path was absent
and then compared "chosen" against "vendored" — which, on `main`, where the
canonical path does not exist, compared one file **with itself**. Every run
printed "(reused, drift-checked)" having checked nothing. A missing canonical
file is now a hard failure (exit 3). `sql/00_env_bootstrap.vendored.sql` and
`sql/10_seed.vendored.sql` remain in the tree as an audit reference only;
nothing reads them.

The tombstone classifier under `.github/containment/` is outside this directory
and under its own development, so it is **snapshotted** into
`<out>/classifier-snapshot/` before either generation is classified, and
`tombstone-binding.sh` reads the copy. One run therefore uses one version of it,
the bytes it used are preserved beside the result, and the live tree moving on
mid-run becomes a note rather than a reason to discard 25 minutes of work.

The snapshot is verified against the live files it was taken from, and that
comparison must be over *(relative name, content)* pairs and nothing else: the
first version hashed `sha256sum "$ROOT/$f"`, whose output **includes the path it
was given**, so the live root and the snapshot root differed by construction.
Byte-identical trees compared unequal, `run.sh` exited 3 on every invocation, and
the harness could not be run at all until it was fixed.

## Binding the run to a commit, and to an image

Three things used to be tied together only by the operator's memory:

* **the image and `--target-sha`.** `build-image.sh` stamps
  `org.opencontainers.image.revision`; `run.sh` now *reads* it and requires it
  to equal `--target-sha` in `--mode frozen`, or `<target-sha>+mutant` in
  `--mode mutant`. A stale image from an earlier commit under a report headed
  with a newer sha is exit 3. (The audit found exactly that on the development
  machine.)
* **the image and its actual CONTENT.** The revision label is a string the
  operator typed at build time; it is not derived from the tree being built, so
  an image built from a tree *more frozen* than the target commit and tagged
  with the target sha would have certified the target commit. `build-image.sh`
  therefore also stamps `org.nt.canary.source-digest` — a digest over the build
  context computed by `lib-source-digest.sh`, the same function `run.sh`
  recomputes over `--source`. A mismatch is exit 3, and an image with no such
  label is refused: `--source` is what `enumerate-routes.mjs` reads to decide
  which endpoints the matrix drives, so an unbound `--source` means the matrix
  may be a statement about the wrong artifact.
* **`--source` and the commit.** `run.sh` extracts `git archive <target-sha>
  dashboard` into a scratch directory and digests it the same way. In
  `--mode frozen` the two must be equal; in `--mode mutant` they must **differ**
  — the inverse assertion, so the check cannot be vacuous — and the differing
  paths are written to `source-vs-commit.txt`.
* **the harness and its own pin.** `TRUSTED_DIGEST` used to be computed and
  *printed*. Nothing refused an edited verifier. It is now compared with
  `expected/trusted-digest.txt` and a mismatch is exit 3 — evaluated
  immediately after argument parsing, before any container starts; re-record it
  deliberately with `./run.sh --print-trusted-digest`. This is a consistency
  check, not an independent attestation — the pin lives in the same untracked
  working tree as the files it pins, and `verdict-scope.json` says so.

  **What it covers, exactly.** Every file under `runtime-canary/` the harness
  reads to decide an outcome — `*.sh`, `*.mjs`, `*.cjs`, `*.sql`, `*.json`,
  `*.sha256*` and `*.txt` — hashed by *content* with the *relative* path,
  excluding `expected/trusted-digest.txt` itself. Not `*.md`, deliberately:
  documentation cannot change what the harness accepts, and pinning it would
  train the reflex of re-recording the pin for a typo fix.

  The `.txt` half and the content-addressing are both repairs. The glob was
  `.sh/.mjs/.cjs/.sql/.json/.sha256*` while the comment above it said "every
  executable and **every expectation** in this directory" — and six expectation
  files were outside it: `expected/tombstone-state.{0008,0023}.txt`,
  `sensor/expected/sensor-objects.{0008,0023}.txt` and
  `sql/expected-baseline.{0008,0023}.txt`. Editing any of them changed what the
  harness would *accept* while the run still printed
  `verifier digest : matches expected/trusted-digest.txt`. Measured: under the
  old glob, appending a newline to `expected/tombstone-state.0008.txt` left the
  digest bit-for-bit identical. It also hashed *absolute* paths, so two
  byte-identical checkouts in different directories disagreed for no content
  reason. `tests/k12-verifier-digest.test.sh` now names each of those files and
  requires an edit to each one to move the digest, requires a copy at a
  different path to compute the same value, requires the two documented
  exclusions to stay excluded, and executes both refusals asserting their exact
  wording.
* **the external classifier toolchain.** `tombstone-binding.sh` runs
  `catalogue-classify.sql`, `extract-tombstone-template.py` and the classifier's
  fixture SQL, none of which live in this directory and all of which have their
  own development going on. Their combined digest is recorded at the start of a
  run and re-checked at the end, so two generations cannot be classified by two
  different versions behind one report. (This is not theoretical: a concurrent
  session changed the extractor's interface from "one migration file" to "the
  migration directory" mid-run, and the only symptom was a run that died four
  minutes in.)
* **`--target-sha` and the working tree.** The target checkout must be at that
  commit *and* clean. A dirty tree is exit 3, or — with
  `--allow-dirty-target` — is recorded in `target-worktree-status.txt`, printed
  in the provenance block, and makes the run **NOT CERTIFYING** (exit 4). A
  disposable clean clone of the bridge is the intended way to run it.
* **`--pg-image` and the pinned digest.** `run.sh` printed "confirmed running
  the pinned production image id" unconditionally, including when `--pg-image`
  had substituted a different database. It now says which of the two happened,
  and a substituted image makes the run NOT CERTIFYING.

The schema fixture the `tests/` suites reuse is content-keyed the same way: its
tag carries a digest over the postgres image, the generation, the exact set and
content of the migrations applied, the bootstrap and the seed, and the build
script — and the key is stamped into the image as a label and re-verified on a
cache hit. It used to be the constant `nt-canary-sensor-base:<gen>-v1`, so
editing a migration and re-running the suites silently reused the old fixture
and reported PASS. No caller may spell the tag: `tests/lib-schema-base.sh`
resolves it.

---

## Files

| path | what it is |
|---|---|
| `run.sh` | the orchestrator; takes the image and the schema as parameters |
| `build-image.sh` | the only supported way to turn a source tree into an image for this harness, so frozen and mutant are built identically; stamps the revision and the source digest |
| `lib-source-digest.sh` | the one content digest over a source tree, used by both the builder and the runner so the two cannot drift |
| `sensor/role-scope.sh` | derives the gateway-reachable role set from `sink.mjs` and requires the tamper control to attempt exactly it |
| `expected/trusted-digest.txt` | the pin this harness's own content must match |
| `tests/k11-runner-omission.test.sh` | `run-all.sh` must refuse, by name, to run a suite that would omit K2/K4/K9 — with `--print-plan` as the seam and a positive control on its own matcher |
| `tests/k12-verifier-digest.test.sh` | the verifier pin covers every input the harness decides an outcome from — each named file individually — is content- not path-addressed, excludes only what the docs say, and executes both refusals |
| `tests/k10-role-scope.test.sh` | positive, both mismatch directions, the comment-decoy control and the extraction-failure control for the above |
| `mutant/make-mutant.sh` | restores one file from the bridge branch's own history, and refuses to produce a tree that is not actually a mutant |
| `driver/enumerate-routes.mjs` | every mutating method, from `app/api` on disk, with a self-test for its own parser |
| `driver/drive.mjs` | issues one cell's requests, records what the image did while each was in flight, and attests each request to the recording gateway as it finishes |
| `driver/observers.mjs` | request windows from the gateway's log, events from the image's own log, the difference between the observer's copy and the driver's transcription, and `attributeEvents` — which requires every line of the image's log to be accounted for by the declared boot snapshot or by exactly one bounded request window |
| `driver/claims.mjs` | the CLOSED claim schema — every driven request must produce exactly one record for every claim — and, since round 8, the ONE definition of what "the data plane" is: `classifyGatewayPath` (path -> surface) and `GATEWAY_CLASS_READERS` (surface -> the claim(s) that read it), from which the buckets in `buildClaims` are built. `sink.mjs` and `instrument.cjs` run the same table in their own processes; neither of their answers decides anything |
| `driver/observation.mjs` | the ONE canonical description of a request observation, imported by both `drive.mjs` (inside the container) and `verdict.mjs` (on the host), so the attesting and the checking sides cannot drift |
| `driver/verdict.mjs` | the matrix, the claims (decided from the observer files), the cell-identity gate, the generation gate, the request-observation gate, the database-image gate, the sensor-integrity gate, and `verdict-scope.json` |
| `expected/request-manifest.json` | the committed matrix: 24 cell IDENTITIES, the freeze flags each one means, both generations AND the catalogue fingerprint each generation means, 10 requests, the endpoint set, the 16 claims, the refusal identity. `certifying: true`. |
| `expected/k2-fixture-manifest.json` | the same shape for K2's synthetic cells, `certifying: false` — the verdict can never print PASS for it |
| `tests/k9-cell-identity.test.sh` | the four copy/collapse attacks on the cell-identity gate, the cross-generation copy, the fully repaired copy, the foreign run nonce, and three positive controls |
| `tests/k13-transcript-integrity.test.sh` | the verdict's transcript must survive the pipe every suite reads it through — with the old asynchronous writer executed as the red-before, deterministically, against a slow reader |
| `tests/k2-sensor-removal.test.sh` | removing any one sensor must make EXACTLY that sensor's claims INDETERMINATE — read out of `verdict-scope.json` as data, in both directions, over a closed sensor set pinned in the test file |
| `tests/k14-observer-derived.test.sh` | 28 cases (the row said 23 until round 8; re-counted from the suite's own summary line). The in-process claims must be decided from the image's own log (both disagreement directions); every line of that log must be *attributed*, and the boot bucket judged rather than merely accounted for (`ADV1`, `ADV1b`, `ADV1c`, `ADV1d`); the two cell-result-only forgeries must be refused by the gateway's copy of each request observation; a substituted database image must not certify; a deleted trusted-runner report must not be replaceable by a command-line assertion or by a retyped file (`ADV3a`/`ADV3b`/`ADV3c`); and a pre-verdict refusal must not leave a stale green in `verdict-scope.json` (`ADV4`). Round 5 adds: a boot-snapshot broker call must be refused under **every** outbound kind `claims.mjs` exports, not the four an earlier deny-list named, and whatever host class the record gives itself (`R5A`, `R5Ab`); a Supabase data-plane call the **gateway** logged outside every request window must be refused, with the identical pair under a request tag as its own positive control (`R5B`, `R5Bb`); and rewriting only an event's `detail` must be refused, established over the honest artefacts of a real broker call (`R5C`) — with a positive control that the unmodified set still certifies and a `MEASURED` control that it did so having read 480 windows, matched 480 attestations, accounted for every instrument-log line AND every gateway-log line against counts taken from the directory, seen no pre-round-5 attestation version, and verified the sealed report, its manifest MAC and every ledger MAC |
| `tests/k15-run-controls.test.sh` | 19 cases, R7-3/R7-4. The run's own controls must be READ at verdict time, not merely run: §3c the egress classifier (deleted, gateway relabelled `broker`, every broker relabelled `loopback`, `egress-broker.txt` edited by one line, and the control container configured with hosts other than the pinned ones); §8b/§8b2 arming and fidelity (deleted, fidelity broken, and **both** artefacts rewritten to agree with each other — still refused, against `sql/expected-baseline.<gen>.txt`); §5b the `ON_ERROR_STOP` control (deleted, and failing with the wrong error class); §7c the tombstone classification (deleted, and reclassified); and the image's own stdout (a cell's applog deleted, an applog belonging to no cell, a planted broker line, a one-line wrapper-name plant). Plus `GREEN` — the unmodified set still certifies — and `MEASURED`, which asserts the control counters as NUMBERS with the applog expectation computed from the directory, because *satisfied* and *0 hits* are also what a check that never ran produces. **Red-before measured:** against the same code with the derivation removed, 1 passed / 18 failed, every one of the eighteen reporting `rc=0(want 3) PASS-banner-present` |
| `tests/k16-surface-coverage.test.sh` | 25 cases, R8-1/R8-2/R8-3. The data plane is a TOTAL classification of the request path and every class is read by a named claim. One case per surface — `/rest/v1`, `/auth/v1`, `/rest/v1/rpc/` + a Vault wrapper name, `/storage/v1`, `/realtime/v1`, `/functions/v1`, `/graphql/v1`, `/pg`, the Kong root and an unenumerated path — each asserting WHICH claim goes violated and which three do NOT; `N1`, the negative control, a `/__canary` row under the same tag still certifies; `R8-1a`/`R8-1b`, the row WITH `"kind":"postgrest"` and the row with the `kind` field DELETED must be judged identically, same rc, same claims, same counts; `M1`, a row whose declared kind contradicts its path is refused naming the derived class; `R8-3a`…`R8-3d`, an `NT_CANARY_ROW` in the read file (control), the same line present ONLY in `sql/canary-dump-<gen>.out` (the attack), the line in BOTH (still a plain FINDING) and the dump deleted; `P1`/`P2`, the image's declared `detail.pathClass` against its own URL with the consistent record as the negative control; `SCOPE`, the published scope names every class and its readers, checked against `GATEWAY_PATH_CLASSES` itself; and `TABLE`, the positive control on the coverage assertion — removing one class from `GATEWAY_CLASS_READERS` must make `claims.mjs` refuse to load, because a throw-at-import check that passes is silent and so is its deletion. Plus `TRIPLE`, the three copies of the classifier (`claims.mjs`, `sink.mjs`, `instrument.cjs`) must be ONE decision list, extracted and compared as text with a positive control on the extractor — an empty extraction compares equal to another empty one — and a negative control that a planted extra decision is seen; and `GREEN` / `MEASURED` (the per-surface counts and the canary marker-line count read as numbers) |
| `tests/seal-legacy-report.mjs` | **not a suite.** A fixture migration: it seals an artefact directory produced before the ADV-3 report seal, using *that run's own key*, so the certifying suites can read a corpus older than the check. It refuses when the key is absent — which is the ADV-3 attack itself — and `run-all.sh` declares it in `NON_CASE_SCRIPTS` and says loudly when it has used it |
| `tests/lib-schema-base.sh` | resolves the content-keyed schema fixture tag; no suite may spell it |
| `driver/keys.mjs` | the throwaway JWTs — none of it is a credential |
| `sink/sink.mjs` | the recording Supabase gateway (Auth + a faithful subset of PostgREST) |
| `instrument/instrument.cjs` | the in-process sensors, `--require`d into the unmodified image |
| `sql/05_sink_role.sql` | gives the gateway `authenticator`, the role PostgREST really uses |
| `sql/15_probe_identity.sql` | the disposable Auth identity, created inside our own clone |
| `sql/18_prewrapper_baseline.sql` | what the three wrappers do before the canary exists, for the behaviour-preservation control |
| `sql/16_reset_probe_account.sql` | mutant runs only: puts the deleted probe account back between cells |
| `sql/20_canary_install.sql` | the canary |
| `sql/22_canary_break.sql` | the property-(C) sabotages |
| `sql/25_canary_arm.sql` | the positive control |
| `sql/30_commitments.sql` | the before/after content commitment |
| `sql/40_canary_dump.sql` | what the sensor saw |

## What this harness does not touch

No `natetrader-*` container, no Traefik configuration, no broker, no workflow
dispatch, no `PRODUCTION_RELEASE_SHA`, no production Auth identity, and no file
inside any git worktree. Every container it creates is named `nt-canary-*` and
is destroyed at the end of the run unless `--keep` is given.
